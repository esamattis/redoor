//! Bounded fuzzy path search over a directory tree, honoring gitignore and hidden-file
//! settings.

use super::search_stream::{MatchSink, SearchStream};
use crate::transfers::stream::StreamWriter;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};
use redoor_core::log;
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::request::CommandError;
use redoor_protocol::{
    api::search::{CaseSensitivity, FileSearchEntry, FileSearchEvent, FileSearchRanking},
    wire::command::CommandErrorKind,
};
use std::{
    collections::HashSet,
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

/// Prevents repository-controlled ignore rules from allocating an unbounded physical line.
const MAX_GITIGNORE_LINE_BYTES: usize = 64 * 1024;

/// Bundles path-search controls so cancellation coordination does not grow a positional API.
pub(crate) struct FileSearchRequest {
    pub(crate) path: String,
    pub(crate) query: String,
    pub(crate) timeout_seconds: u64,
    pub(crate) include_hidden: bool,
    pub(crate) respect_gitignore: bool,
    pub(crate) case_sensitivity: CaseSensitivity,
    pub(crate) directories_only: bool,
}

/// Separates fuzzy terms from path fragments that must be skipped during traversal.
struct SearchExpression {
    include_patterns: Vec<Pattern>,
    exclude_terms: Vec<String>,
    case_sensitivity: CaseSensitivity,
}

impl SearchExpression {
    /// Parses whitespace-separated Google-style terms while retaining spaces inside double quotes.
    fn parse(query: &str, case_sensitivity: CaseSensitivity) -> Self {
        let mut terms = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        let mut term_was_quoted = false;
        for character in query.chars() {
            match character {
                '"' => {
                    in_quotes = !in_quotes;
                    term_was_quoted = true;
                }
                character if character.is_whitespace() && !in_quotes => {
                    if !current.is_empty() {
                        terms.push((std::mem::take(&mut current), term_was_quoted));
                        term_was_quoted = false;
                    }
                }
                _ => current.push(character),
            }
        }
        if !current.is_empty() {
            terms.push((current, term_was_quoted));
        }

        let mut include_patterns = Vec::new();
        let mut exclude_terms = Vec::new();
        for (term, was_quoted) in terms {
            if !was_quoted && term.starts_with('-') && term.len() > 1 {
                exclude_terms.push(term[1..].to_string());
            } else {
                include_patterns.push(Pattern::new(
                    &term,
                    match case_sensitivity {
                        CaseSensitivity::Smart => CaseMatching::Smart,
                        CaseSensitivity::Sensitive => CaseMatching::Respect,
                        CaseSensitivity::Insensitive => CaseMatching::Ignore,
                    },
                    Normalization::Smart,
                    AtomKind::Fuzzy,
                ));
            }
        }
        Self {
            include_patterns,
            exclude_terms,
            case_sensitivity,
        }
    }

    /// Applies the selected case policy to exclusion substrings as well as positive fuzzy terms.
    fn excludes(&self, relative_path: &str) -> bool {
        self.exclude_terms
            .iter()
            .any(|term| match self.case_sensitivity {
                CaseSensitivity::Sensitive => relative_path.contains(term),
                CaseSensitivity::Insensitive => {
                    relative_path.to_lowercase().contains(&term.to_lowercase())
                }
                CaseSensitivity::Smart if term.chars().any(char::is_uppercase) => {
                    relative_path.contains(term)
                }
                CaseSensitivity::Smart => {
                    relative_path.to_lowercase().contains(&term.to_lowercase())
                }
            })
    }
}

/// Identifies directory targets so following user-navigable symlinks cannot create traversal cycles.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

/// Keeps the identity with each open iterator so only active traversal cycles are suppressed.
struct TraversedDirectory {
    entries: tokio::fs::ReadDir,
    identity: Option<DirectoryIdentity>,
    gitignore: Option<Gitignore>,
}

/// Uses filesystem identity rather than path spelling because multiple symlinks can reach one directory.
pub(super) fn directory_identity(metadata: &std::fs::Metadata) -> DirectoryIdentity {
    DirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

/// Runs one path search and streams its matches on `stream`, returning the stream so the
/// result can follow the data.
///
/// The result is an error only for input that fails validation, a root that cannot be read,
/// a cancel or a lost connection; a walk that reaches its deadline ends normally with
/// `done { timed_out: true }`.
pub(crate) async fn execute(
    request: FileSearchRequest,
    stream: StreamWriter,
    cancel: &CancellationToken,
) -> (StreamWriter, Result<(), CommandError>) {
    let started_at = Instant::now();
    let mut output = SearchStream::new(stream, cancel, "File search");
    let result = search(&request, &mut output, started_at).await;
    if let Err(CommandError {
        kind: CommandErrorKind::Canceled,
        ..
    }) = &result
    {
        log_canceled_search("File search", &request.path, &request.query, started_at);
    }
    (output.into_writer(), result.map(|_| ()))
}

/// Validates, opens the root, then walks it while matches stream. Returns the agent's own
/// final top list, which the streamed matches must reduce to.
async fn search(
    request: &FileSearchRequest,
    output: &mut SearchStream<'_>,
    started_at: Instant,
) -> Result<Vec<FileSearchEntry>, CommandError> {
    if request.query.trim().is_empty() {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            "File search query must not be empty",
        ));
    }
    let root = Path::new(&request.path);
    let root_entries = tokio::fs::read_dir(root)
        .await
        .map_err(|error| CommandError::io("Failed to search directory", error))?;
    output.ready().await?;

    let expression = SearchExpression::parse(&request.query, request.case_sensitivity);
    let deadline = started_at + Duration::from_secs(request.timeout_seconds);
    let mut ranking = FileSearchRanking::default();
    // The walk borrows the ranking, so it is still here after a deadline dropped the walk.
    let kept = &mut ranking;
    output
        .run(|sink| async move {
            let walk = collect_matches(root, root_entries, &expression, request, kept, &sink);
            let timed_out = tokio::select! {
                biased;
                () = walk => false,
                () = tokio::time::sleep_until(deadline.into()) => true,
            };
            Ok(FileSearchEvent::Done {
                timed_out,
                duration_ms: u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            })
        })
        .await?;
    Ok(ranking.into_entries())
}

/// Walks depth-first with one open directory per depth so broad trees do not become an in-memory plan.
///
/// A match is streamed only when it enters the current top list, so the stream stays small
/// on huge trees while the matches it carries still reduce to the final list. The walk stops
/// early when the writer is gone.
async fn collect_matches(
    root: &Path,
    root_entries: tokio::fs::ReadDir,
    expression: &SearchExpression,
    request: &FileSearchRequest,
    ranking: &mut FileSearchRanking,
    sink: &MatchSink<FileSearchEvent>,
) {
    let FileSearchRequest {
        include_hidden,
        respect_gitignore,
        directories_only,
        ..
    } = *request;
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut utf32_buffer = Vec::new();
    let root_identity = tokio::fs::metadata(root)
        .await
        .ok()
        .as_ref()
        .map(directory_identity);
    let mut active_directories = HashSet::new();
    if let Some(identity) = root_identity {
        active_directories.insert(identity);
    }
    let mut directories = vec![TraversedDirectory {
        entries: root_entries,
        identity: root_identity,
        gitignore: load_gitignore(root, respect_gitignore).await,
    }];

    while let Some(directory) = directories.last_mut() {
        let entry = match directory.entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => {
                if let Some(identity) = directory.identity {
                    active_directories.remove(&identity);
                }
                directories.pop();
                continue;
            }
            // Directory iterators can report errors for one entry and still yield later entries.
            Err(_) => continue,
        };
        let entry_path = entry.path();
        let entry_name = entry.file_name();
        if entry_name == ".git" {
            // Repository internals are never useful browser results and can make searches enormous.
            continue;
        }
        if !include_hidden && entry_name.to_string_lossy().starts_with('.') {
            // The hidden filter covers dotfiles too, like `rg` and `fd`, and rejecting before
            // metadata ensures hidden directories, including symlinked ones, are never opened.
            continue;
        }
        let relative_path = entry_path
            .strip_prefix(root)
            .map(|path| path.to_string_lossy())
            .unwrap_or_default();
        if expression.excludes(&relative_path) {
            // Rejecting before metadata and read_dir ensures excluded directories are never opened.
            continue;
        }
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        let followed_metadata = if file_type.is_dir() || file_type.is_symlink() {
            tokio::fs::metadata(&entry_path).await.ok()
        } else {
            None
        };
        let is_directory = file_type.is_dir()
            || followed_metadata
                .as_ref()
                .is_some_and(std::fs::Metadata::is_dir);
        if respect_gitignore
            && is_ignored(
                directories
                    .iter()
                    .rev()
                    .filter_map(|directory| directory.gitignore.as_ref()),
                &entry_path,
                is_directory,
            )
        {
            // Ignored directories are pruned before opening them, matching Git traversal semantics.
            continue;
        }

        // Files are still traversed past, never ranked, so they cannot crowd out directories.
        if !relative_path.is_empty() && (is_directory || !directories_only) {
            let score = expression
                .include_patterns
                .iter()
                .try_fold(0_u32, |score, pattern| {
                    let haystack = Utf32Str::new(&relative_path, &mut utf32_buffer);
                    pattern
                        .score(haystack, &mut matcher)
                        .map(|term_score| score.saturating_add(term_score))
                });
            if let Some(score) = score
                && let Some(kept) = ranking.offer(FileSearchEntry {
                    name: entry_name.to_string_lossy().into_owned(),
                    path: entry_path.to_string_lossy().into_owned(),
                    file_type: if is_directory {
                        "directory".to_string()
                    } else {
                        "file".to_string()
                    },
                    score,
                })
                && !sink
                    .send(FileSearchEvent::Match {
                        entry: kept.clone(),
                    })
                    .await
            {
                return;
            }
        }

        let child_identity = followed_metadata.as_ref().map(directory_identity);
        let creates_cycle = child_identity
            .as_ref()
            .is_some_and(|identity| active_directories.contains(identity));
        if is_directory
            && !creates_cycle
            && let Ok(child_directory) = tokio::fs::read_dir(&entry_path).await
        {
            if let Some(identity) = child_identity {
                active_directories.insert(identity);
            }
            directories.push(TraversedDirectory {
                entries: child_directory,
                identity: child_identity,
                gitignore: load_gitignore(&entry_path, respect_gitignore).await,
            });
        }
    }
}

/// Loads one directory's rules asynchronously while tolerating missing or partially invalid files.
pub(super) async fn load_gitignore(directory: &Path, enabled: bool) -> Option<Gitignore> {
    if !enabled {
        return None;
    }
    let ignore_path = directory.join(".gitignore");
    let file = tokio::fs::File::open(&ignore_path).await.ok()?;
    let mut reader = BufReader::new(file);
    let mut builder = GitignoreBuilder::new(directory);
    let mut line = Vec::with_capacity(1024);
    let mut first_line = true;
    let mut oversized = false;
    loop {
        let Ok(byte) = reader.read_u8().await else {
            if !oversized && !line.is_empty() {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let rule = String::from_utf8_lossy(&line);
                let rule = if first_line {
                    rule.trim_start_matches('\u{feff}')
                } else {
                    &rule
                };
                let _ = builder.add_line(Some(ignore_path.clone()), rule);
            }
            break;
        };
        if byte == b'\n' {
            if !oversized {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let rule = String::from_utf8_lossy(&line);
                let rule = if first_line {
                    rule.trim_start_matches('\u{feff}')
                } else {
                    &rule
                };
                // Git accepts valid rules even when another physical line cannot be represented.
                let _ = builder.add_line(Some(ignore_path.clone()), rule);
            }
            line.clear();
            oversized = false;
            first_line = false;
        } else if !oversized {
            if line.len() < MAX_GITIGNORE_LINE_BYTES {
                line.push(byte);
            } else {
                line.clear();
                oversized = true;
            }
        }
    }
    builder.build().ok()
}

/// Applies the nearest matching rule first because deeper `.gitignore` files override ancestors.
///
/// Takes the rules nearest first rather than a traversal stack, so path search's depth-first
/// stack and content grep's breadth-first ancestor chain share one precedence rule.
pub(super) fn is_ignored<'a>(
    nearest_first: impl IntoIterator<Item = &'a Gitignore>,
    path: &Path,
    is_directory: bool,
) -> bool {
    for gitignore in nearest_first {
        let matched = gitignore.matched(path, is_directory);
        if matched.is_ignore() {
            return true;
        }
        if matched.is_whitelist() {
            return false;
        }
    }
    false
}

/// Records a search stopped because its caller gave up, so an operator can confirm that
/// abandoned UI searches free the agent instead of running until their timeout.
pub(crate) fn log_canceled_search(kind: &str, path: &str, query: &str, started_at: Instant) {
    log!(
        Level::Debug,
        "{kind} canceled: path={path} query={query} elapsed_ms={}",
        started_at.elapsed().as_millis()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
    use std::os::unix::fs::PermissionsExt;

    use super::super::search_stream::test_support::{events, recording_writer, symlink_maze};
    use redoor_protocol::api::search::{FILE_SEARCH_RESULT_LIMIT, FileSearchResponse};
    use redoor_protocol::wire::stream::StreamChunk;

    /// Runs a search against a recording stream and returns its result with the frames sent.
    async fn run(
        request: FileSearchRequest,
        cancel: &CancellationToken,
    ) -> (Result<(), CommandError>, Vec<StreamChunk>) {
        let (writer, recorder) = recording_writer();
        let (writer, result) = execute(request, writer, cancel).await;
        drop(writer);
        (result, recorder.await.expect("the recorder finishes"))
    }

    /// Rebuilds the response a client gets from the streamed events, like the server does.
    fn reduce(frames: &[StreamChunk]) -> FileSearchResponse {
        let mut ranking = FileSearchRanking::default();
        let mut done = None;
        for event in events::<FileSearchEvent>(frames) {
            // Nothing may follow the `done` line.
            assert!(done.is_none(), "an event followed done");
            match event {
                FileSearchEvent::Match { entry } => {
                    ranking.offer(entry);
                }
                FileSearchEvent::Done {
                    timed_out,
                    duration_ms,
                } => done = Some((timed_out, duration_ms)),
            }
        }
        let (timed_out, duration_ms) = done.expect("a finished search ends with done");
        FileSearchResponse {
            results: ranking.into_entries(),
            timed_out,
            duration_ms,
        }
    }

    /// Runs an uncancelled search with positional options to keep the cases readable.
    async fn search(
        path: String,
        query: String,
        timeout_seconds: u64,
        include_hidden: bool,
        respect_gitignore: bool,
        case_sensitivity: CaseSensitivity,
    ) -> Result<FileSearchResponse, CommandError> {
        let (result, frames) = run(
            FileSearchRequest {
                path,
                query,
                timeout_seconds,
                include_hidden,
                respect_gitignore,
                case_sensitivity,
                directories_only: false,
            },
            &CancellationToken::new(),
        )
        .await;
        result.map(|()| reduce(&frames))
    }
    #[cfg(not(target_os = "macos"))]
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    /// Builds a request for `path` with the default filters.
    fn request(path: &Path, query: &str, timeout_seconds: u64) -> FileSearchRequest {
        FileSearchRequest {
            path: path.to_string_lossy().into_owned(),
            query: query.to_string(),
            timeout_seconds,
            include_hidden: false,
            respect_gitignore: true,
            case_sensitivity: CaseSensitivity::Smart,
            directories_only: false,
        }
    }

    /// Verifies a canceled search reports the cancel and never ends like a finished one.
    #[tokio::test]
    async fn canceled_search_ends_without_done() {
        let temp = TempDir::create();
        let cancel = CancellationToken::new();
        // Pre-canceling makes this deterministic without sleeping or constructing a large tree.
        cancel.cancel();

        let (result, frames) = run(request(temp.path(), "query", 5), &cancel).await;

        // The caller learns the search was canceled, not that it found nothing.
        assert!(matches!(
            result,
            Err(CommandError {
                kind: CommandErrorKind::Canceled,
                ..
            })
        ));
        // No frame claims the stream is complete.
        assert!(frames.iter().all(|frame| !frame.is_last));
    }

    /// Verifies validation and root errors are the result alone, with no data, so the server
    /// can still answer them with an HTTP error status.
    #[tokio::test]
    async fn early_errors_send_no_data() {
        let temp = TempDir::create();
        for (path, query, kind) in [
            (
                temp.path().to_path_buf(),
                " ",
                CommandErrorKind::InvalidInput,
            ),
            (
                temp.path().join("missing"),
                "query",
                CommandErrorKind::NotFound,
            ),
        ] {
            let (result, frames) = run(request(&path, query, 5), &CancellationToken::new()).await;
            // The failure keeps its kind, which decides the HTTP status.
            assert_eq!(result.map_err(|error| error.kind), Err(kind));
            // Not even the ready frame went out.
            assert!(frames.is_empty());
        }
    }

    /// Verifies the matches streamed on entering the top list reduce to exactly the agent's
    /// own final list, so clients can rank streamed matches without the agent's help.
    #[tokio::test]
    async fn streamed_matches_reduce_to_the_agent_ranking() {
        let temp = TempDir::create();
        let root = temp.path().join("ranked");
        for index in 0..300 {
            // Varied lengths and depths give the matches different scores.
            let directory = root
                .join(format!("d{}", index % 7))
                .join("x".repeat(index % 5));
            tokio::fs::create_dir_all(&directory).await.unwrap();
            tokio::fs::write(
                directory.join(format!("{}rank-target-{index}.txt", "y".repeat(index % 11))),
                b"",
            )
            .await
            .unwrap();
        }
        let (writer, recorder) = recording_writer();
        let cancel = CancellationToken::new();
        let mut output = SearchStream::new(writer, &cancel, "File search");
        let agent_list = super::search(
            &request(&root, "ranktarget", 30),
            &mut output,
            Instant::now(),
        )
        .await
        .expect("the search finishes");
        drop(output.into_writer());
        let frames = recorder.await.unwrap();

        let streamed = reduce(&frames);
        // The list is full, so ranking decided which matches were kept.
        assert_eq!(agent_list.len(), FILE_SEARCH_RESULT_LIMIT);
        // Reducing the stream gives the agent's list, in the same order.
        assert_eq!(streamed.results, agent_list);
        // Matches that never entered the top list were not streamed.
        assert!(events::<FileSearchEvent>(&frames).len() < 300);
    }

    /// Verifies a walk that runs into its deadline still ends with `done`, marked timed out.
    #[tokio::test]
    async fn timeout_still_ends_with_done() {
        let temp = TempDir::create();
        // The maze has more paths than any walk can visit, so only the deadline ends it.
        let root = symlink_maze(temp.path(), "maze-target.txt", b"").await;

        let (result, frames) =
            run(request(&root, "mazetarget", 1), &CancellationToken::new()).await;

        // Reaching the deadline is a normal end of a search.
        assert!(result.is_ok());
        // The stream is complete and its summary says it stopped at the deadline.
        assert!(frames.last().is_some_and(|frame| frame.is_last));
        let response = reduce(&frames);
        assert!(response.timed_out);
        // Matches found before the deadline were streamed.
        assert!(!response.results.is_empty());
    }

    /// Verifies a directories-only search skips matching files but still finds directories
    /// nested below them, so the filter does not stop traversal.
    #[tokio::test]
    async fn directories_only_search_skips_files() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let parent = root.join("match-parent");
        let nested = parent.join("match-nested");
        tokio::fs::create_dir_all(&nested)
            .await
            .expect("nested test directory should be created");
        tokio::fs::write(parent.join("match-file.txt"), b"file")
            .await
            .expect("matching file should be created");

        let mut directories = request(&root, "match", 5);
        directories.directories_only = true;
        let (result, frames) = run(directories, &CancellationToken::new()).await;
        let result = result.map(|()| reduce(&frames));

        let Ok(response) = result else {
            panic!("a directories-only search should succeed");
        };
        let mut paths: Vec<&str> = response
            .results
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        paths.sort_unstable();
        // The matching file is left out while both matching directories, nested too, are found.
        assert_eq!(
            paths,
            vec![parent.to_string_lossy(), nested.to_string_lossy()]
        );
        // Every result is reported as a directory.
        assert!(
            response
                .results
                .iter()
                .all(|entry| entry.file_type == "directory")
        );
    }

    /// Verifies one inaccessible subtree does not prevent traversal of its readable siblings.
    #[tokio::test]
    async fn unreadable_directory_is_skipped() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let unreadable = root.join("unreadable");
        let target = root.join("readable").join("visible-target.txt");
        tokio::fs::create_dir_all(&unreadable)
            .await
            .expect("unreadable test directory should be created");
        tokio::fs::create_dir_all(target.parent().expect("target has a parent"))
            .await
            .expect("readable test directory should be created");
        tokio::fs::write(&target, b"target")
            .await
            .expect("target should be created");
        tokio::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000))
            .await
            .expect("test directory permissions should be restricted");

        let result = search(
            root.to_string_lossy().into_owned(),
            "visibletarget".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;

        tokio::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700))
            .await
            .expect("test directory permissions should be restored");
        let Ok(response) = result else {
            panic!("an unreadable child should not fail the search");
        };
        // A failure opening one child must not discard entries from the parent directory.
        assert_eq!(response.results.len(), 1);
        // The readable sibling proves traversal continued after the inaccessible subtree.
        assert_eq!(response.results[0].path, target.to_string_lossy());
        // Skipping an inaccessible child still completes traversal of all accessible entries.
        assert!(!response.timed_out);
    }

    /// Verifies Unix paths with arbitrary bytes remain searchable through their lossy API form.
    /// macOS filesystems reject invalid UTF-8 path components before traversal can exercise this behavior.
    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn non_utf8_path_is_searchable() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let unusual_directory = root.join(OsString::from_vec(b"unusual-\xff-directory".to_vec()));
        let target = unusual_directory.join("searchable-target.txt");
        tokio::fs::create_dir_all(&unusual_directory)
            .await
            .expect("non-UTF-8 test directory should be created");
        tokio::fs::write(&target, b"target")
            .await
            .expect("target should be created");

        let result = search(
            root.to_string_lossy().into_owned(),
            "searchabletarget".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;

        let Ok(response) = result else {
            panic!("a non-UTF-8 child path should not fail the search");
        };
        // Lossy conversion keeps arbitrary Unix paths representable by the string-based API.
        assert_eq!(response.results.len(), 1);
        // Matching the descendant proves an unusual parent no longer hides its whole subtree.
        assert_eq!(response.results[0].path, target.to_string_lossy());
        // The small local tree should complete rather than relying on partial timeout results.
        assert!(!response.timed_out);
    }

    /// Verifies Termux-style storage links are traversed without looping through backlinks.
    #[tokio::test]
    async fn symlinked_directory_is_searchable_without_cycles() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let external = temp.path().join("symlink-target");
        let storage = root.join("storage");
        let linked_storage = storage.join("shared");
        let alternate_storage = storage.join("alternate");
        let target_name = "termux-visible-target.txt";
        tokio::fs::create_dir_all(&storage)
            .await
            .expect("storage link parent should be created");
        tokio::fs::create_dir_all(&external)
            .await
            .expect("storage target should be created");
        tokio::fs::write(external.join(target_name), b"target")
            .await
            .expect("storage target file should be created");
        tokio::fs::symlink(&external, &linked_storage)
            .await
            .expect("Termux-style storage link should be created");
        tokio::fs::symlink(&external, &alternate_storage)
            .await
            .expect("alternate storage link should be created");
        tokio::fs::symlink(&root, external.join("back-to-root"))
            .await
            .expect("cycle link should be created");

        let result = search(
            root.to_string_lossy().into_owned(),
            "termuxvisibletarget".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;

        let Ok(response) = result else {
            panic!("a linked storage directory should not fail the search");
        };
        // Both aliases remain searchable even though they resolve to one filesystem directory.
        assert_eq!(response.results.len(), 2);
        let result_paths = response
            .results
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<HashSet<_>>();
        // The result paths retain each navigable symlink spelling presented to the caller.
        assert!(result_paths.contains(linked_storage.join(target_name).to_string_lossy().as_ref()));
        // A second alias proves cycle detection is limited to ancestors rather than all visited paths.
        assert!(
            result_paths.contains(
                alternate_storage
                    .join(target_name)
                    .to_string_lossy()
                    .as_ref()
            )
        );
        // Completing promptly proves the backlink was detected rather than traversed recursively.
        assert!(!response.timed_out);
    }

    /// Verifies unquoted minus terms exclude paths while quoted minus terms remain searchable.
    #[tokio::test]
    async fn exclusion_terms_prune_directories_and_quoted_terms_match() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let included = root.join("src").join("test-target.txt");
        let excluded = root.join("node_modules").join("test-target.txt");
        let quoted = root.join("contains-node_modules.txt");
        tokio::fs::create_dir_all(included.parent().expect("included target has a parent"))
            .await
            .expect("included directory should be created");
        tokio::fs::create_dir_all(excluded.parent().expect("excluded target has a parent"))
            .await
            .expect("excluded directory should be created");
        tokio::fs::write(&included, b"included")
            .await
            .expect("included target should be created");
        tokio::fs::write(&excluded, b"excluded")
            .await
            .expect("excluded target should be created");
        tokio::fs::write(&quoted, b"quoted")
            .await
            .expect("quoted target should be created");

        let excluded_result = search(
            root.to_string_lossy().into_owned(),
            "-node_modules testtarget".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;
        let quoted_result = search(
            root.to_string_lossy().into_owned(),
            "\"-node_modules\"".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;

        let Ok(excluded_response) = excluded_result else {
            panic!("an exclusion search should succeed");
        };
        // The matching file outside the excluded directory must remain discoverable.
        assert_eq!(excluded_response.results.len(), 1);
        // Pruning the excluded directory prevents its matching descendant from being returned.
        assert_eq!(
            excluded_response.results[0].path,
            included.to_string_lossy()
        );
        let Ok(quoted_response) = quoted_result else {
            panic!("a quoted leading-minus search should succeed");
        };
        // Quotes override exclusion syntax and make the leading minus part of the fuzzy term.
        assert_eq!(quoted_response.results.len(), 1);
        assert_eq!(quoted_response.results[0].path, quoted.to_string_lossy());
    }

    /// Verifies hidden files and directories are both opt-in, so the filter matches its label.
    #[tokio::test]
    async fn hidden_entries_are_skipped_by_default() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let hidden_target = root.join(".cache").join("hidden-target.txt");
        let dotfile = root.join(".hidden-target.txt");
        tokio::fs::create_dir_all(hidden_target.parent().expect("hidden target has a parent"))
            .await
            .expect("hidden directory should be created");
        tokio::fs::write(&hidden_target, b"hidden")
            .await
            .expect("hidden target should be created");
        tokio::fs::write(&dotfile, b"dotfile")
            .await
            .expect("dotfile should be created");

        let default_result = search(
            root.to_string_lossy().into_owned(),
            "hiddentarget".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;
        let included_result = search(
            root.to_string_lossy().into_owned(),
            "hiddentarget".to_string(),
            5,
            true,
            true,
            CaseSensitivity::Smart,
        )
        .await;

        let Ok(default_response) = default_result else {
            panic!("a default hidden-directory search should succeed");
        };
        // Dotfiles in visible directories are hidden too, not only the contents of hidden directories.
        assert!(default_response.results.is_empty());
        let Ok(included_response) = included_result else {
            panic!("an opted-in hidden-directory search should succeed");
        };
        // Opting in exposes both the dotfile and the descendant of the hidden directory.
        assert_eq!(included_response.results.len(), 2);
        assert!(
            included_response
                .results
                .iter()
                .any(|entry| entry.path == hidden_target.to_string_lossy())
        );
    }

    /// Verifies rules are loaded at every depth and can be disabled explicitly.
    #[tokio::test]
    async fn nested_gitignore_rules_are_respected_by_default() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        let nested = root.join("nested");
        let root_ignored = root.join("root-target.log");
        let nested_ignored = nested.join("ignored-target.txt");
        let nested_reincluded = nested.join("kept-target.log");
        tokio::fs::create_dir_all(&nested)
            .await
            .expect("nested directory should be created");
        tokio::fs::write(root.join(".gitignore"), b"*.log\n")
            .await
            .expect("root ignore file should be created");
        tokio::fs::write(
            nested.join(".gitignore"),
            b"ignored-target.txt\n!kept-target.log\n",
        )
        .await
        .expect("nested ignore file should be created");
        for target in [&root_ignored, &nested_ignored, &nested_reincluded] {
            tokio::fs::write(target, b"target")
                .await
                .expect("search target should be created");
        }

        let respected = search(
            root.to_string_lossy().into_owned(),
            "target".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;
        let disabled = search(
            root.to_string_lossy().into_owned(),
            "target".to_string(),
            5,
            false,
            false,
            CaseSensitivity::Smart,
        )
        .await;

        let Ok(respected_response) = respected else {
            panic!("a gitignore-aware search should succeed");
        };
        // The nested negation takes precedence over the matching root rule.
        assert_eq!(
            respected_response
                .results
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec![nested_reincluded.to_string_lossy().as_ref()]
        );
        let Ok(disabled_response) = disabled else {
            panic!("a search with gitignore disabled should succeed");
        };
        // Disabling ignore checks exposes every otherwise matching path.
        assert_eq!(disabled_response.results.len(), 3);
    }

    /// Ensures one hostile ignore rule cannot grow memory or hide valid rules that follow it.
    #[tokio::test]
    async fn oversized_gitignore_lines_are_skipped() {
        let temp = TempDir::create();
        let root = temp.path().join("search-root");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        let mut rules = vec![b'x'; MAX_GITIGNORE_LINE_BYTES + 1];
        rules.extend_from_slice(b"\nignored-target.txt\n");
        tokio::fs::write(root.join(".gitignore"), rules)
            .await
            .expect("bounded ignore fixture should be written");
        tokio::fs::write(root.join("ignored-target.txt"), b"target")
            .await
            .expect("ignored target should be written");
        tokio::fs::write(root.join("visible-target.txt"), b"target")
            .await
            .expect("visible target should be written");

        let result = search(
            root.to_string_lossy().into_owned(),
            "target".to_string(),
            5,
            false,
            true,
            CaseSensitivity::Smart,
        )
        .await;
        let Ok(response) = result else {
            panic!("a search after an oversized ignore rule should succeed");
        };
        // The valid rule after the skipped physical line still excludes its target.
        assert_eq!(response.results.len(), 1);
        // The unrelated target proves the oversized rule did not abort ignore parsing or traversal.
        assert_eq!(response.results[0].name, "visible-target.txt");
    }
}
