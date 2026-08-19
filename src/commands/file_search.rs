use super::{CommandErrorKind, CommandResult, FileSearchEntry, FileSearchResponse};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};
use std::{
    collections::HashSet,
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::watch,
};

/// Bounds both response size and memory retained while traversing a large tree.
const RESULT_LIMIT: usize = 100;

/// Separates fuzzy terms from path fragments that must be skipped during traversal.
struct SearchExpression {
    include_patterns: Vec<Pattern>,
    exclude_terms: Vec<String>,
}

impl SearchExpression {
    /// Parses whitespace-separated Google-style terms while retaining spaces inside double quotes.
    fn parse(query: &str) -> Self {
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
                exclude_terms.push(term[1..].to_lowercase());
            } else {
                include_patterns.push(Pattern::new(
                    &term,
                    CaseMatching::Smart,
                    Normalization::Smart,
                    AtomKind::Fuzzy,
                ));
            }
        }
        Self {
            include_patterns,
            exclude_terms,
        }
    }
}

/// Retains the matcher score internally so the agent can rank a bounded result set.
#[derive(Debug)]
struct RankedEntry {
    entry: FileSearchEntry,
    score: u32,
}

/// Identifies directory targets so following user-navigable symlinks cannot create traversal cycles.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct DirectoryIdentity {
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
fn directory_identity(metadata: &std::fs::Metadata) -> DirectoryIdentity {
    DirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

/// Traverses incrementally so timeout returns useful partial results without retaining the tree.
pub(super) async fn execute(
    path: String,
    query: String,
    timeout_seconds: u64,
    include_hidden: bool,
    respect_gitignore: bool,
) -> CommandResult {
    let (_cancel_sender, cancel_receiver) = watch::channel(false);
    execute_with_cancellation(
        path,
        query,
        timeout_seconds,
        include_hidden,
        respect_gitignore,
        cancel_receiver,
    )
    .await
}

/// Preserves partial matches when a newer search supersedes this traversal.
pub(super) async fn execute_with_cancellation(
    path: String,
    query: String,
    timeout_seconds: u64,
    include_hidden: bool,
    respect_gitignore: bool,
    mut cancel_receiver: watch::Receiver<bool>,
) -> CommandResult {
    if query.trim().is_empty() {
        return CommandResult::error(
            CommandErrorKind::InvalidInput,
            "File search query must not be empty",
        );
    }

    let started_at = Instant::now();
    let expression = SearchExpression::parse(&query);
    let mut matches = Vec::with_capacity(RESULT_LIMIT);
    let result = {
        let traversal = collect_matches(
            Path::new(&path),
            &expression,
            include_hidden,
            respect_gitignore,
            &mut matches,
        );
        tokio::pin!(traversal);
        let timeout = tokio::time::sleep(Duration::from_secs(timeout_seconds));
        tokio::pin!(timeout);
        tokio::select! {
            biased;
            _ = cancel_receiver.changed() => None,
            result = &mut traversal => Some(result),
            _ = &mut timeout => None,
        }
    };

    let timed_out = match result {
        Some(Ok(())) => false,
        Some(Err(error)) => {
            return CommandResult::io_error("Failed to search directory", error);
        }
        None => true,
    };

    matches.sort_unstable_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.entry.path.cmp(&right.entry.path))
    });

    CommandResult::FileSearch(FileSearchResponse {
        results: matches.into_iter().map(|entry| entry.entry).collect(),
        timed_out,
        duration_ms: u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[cfg(not(target_os = "macos"))]
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    /// Creates an isolated path without requiring a shared fixture or an additional test dependency.
    fn test_root(suffix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "redoor-file-search-{}-{suffix}",
            uuid::Uuid::new_v4()
        ))
    }

    /// Verifies superseded searches still return a terminal response to their original caller.
    #[tokio::test]
    async fn canceled_search_returns_empty_partial_response() {
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        // Pre-canceling makes this deterministic without sleeping or constructing a large tree.
        cancel_sender.send(true).expect("receiver remains active");

        let result = execute_with_cancellation(
            "/path-that-does-not-need-to-exist".to_string(),
            "query".to_string(),
            5,
            false,
            true,
            cancel_receiver,
        )
        .await;

        let CommandResult::FileSearch(response) = result else {
            panic!("cancellation should return a file search response");
        };
        // No traversal work should occur after the cancellation signal is already visible.
        assert!(response.results.is_empty());
        // Existing response schema marks every incomplete traversal with the timeout flag.
        assert!(response.timed_out);
        // Even immediately cancelled searches report their agent-side execution duration.
        assert!(response.duration_ms < 5_000);
    }

    /// Verifies one inaccessible subtree does not prevent traversal of its readable siblings.
    #[tokio::test]
    async fn unreadable_directory_is_skipped() {
        let root = test_root("unreadable-directory");
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

        let result = execute(
            root.to_string_lossy().into_owned(),
            "visibletarget".to_string(),
            5,
            false,
            true,
        )
        .await;

        tokio::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700))
            .await
            .expect("test directory permissions should be restored");
        crate::safe_fs::safe_rm_all(&root)
            .await
            .expect("test tree should be removed");
        let CommandResult::FileSearch(response) = result else {
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
        let root = test_root("non-utf8-path");
        let unusual_directory = root.join(OsString::from_vec(b"unusual-\xff-directory".to_vec()));
        let target = unusual_directory.join("searchable-target.txt");
        tokio::fs::create_dir_all(&unusual_directory)
            .await
            .expect("non-UTF-8 test directory should be created");
        tokio::fs::write(&target, b"target")
            .await
            .expect("target should be created");

        let result = execute(
            root.to_string_lossy().into_owned(),
            "searchabletarget".to_string(),
            5,
            false,
            true,
        )
        .await;

        crate::safe_fs::safe_rm_all(&root)
            .await
            .expect("test tree should be removed");
        let CommandResult::FileSearch(response) = result else {
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
        let root = test_root("symlink-root");
        let external = test_root("symlink-target");
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

        let result = execute(
            root.to_string_lossy().into_owned(),
            "termuxvisibletarget".to_string(),
            5,
            false,
            true,
        )
        .await;

        crate::safe_fs::safe_rm_all(&root)
            .await
            .expect("search root should be removed");
        crate::safe_fs::safe_rm_all(&external)
            .await
            .expect("external target should be removed");
        let CommandResult::FileSearch(response) = result else {
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
        let root = test_root("excluded-paths");
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

        let excluded_result = execute(
            root.to_string_lossy().into_owned(),
            "-node_modules testtarget".to_string(),
            5,
            false,
            true,
        )
        .await;
        let quoted_result = execute(
            root.to_string_lossy().into_owned(),
            "\"-node_modules\"".to_string(),
            5,
            false,
            true,
        )
        .await;

        crate::safe_fs::safe_rm_all(&root)
            .await
            .expect("test tree should be removed");
        let CommandResult::FileSearch(excluded_response) = excluded_result else {
            panic!("an exclusion search should succeed");
        };
        // The matching file outside the excluded directory must remain discoverable.
        assert_eq!(excluded_response.results.len(), 1);
        // Pruning the excluded directory prevents its matching descendant from being returned.
        assert_eq!(
            excluded_response.results[0].path,
            included.to_string_lossy()
        );
        let CommandResult::FileSearch(quoted_response) = quoted_result else {
            panic!("a quoted leading-minus search should succeed");
        };
        // Quotes override exclusion syntax and make the leading minus part of the fuzzy term.
        assert_eq!(quoted_response.results.len(), 1);
        assert_eq!(quoted_response.results[0].path, quoted.to_string_lossy());
    }

    /// Verifies hidden directories are opt-in without hiding dotfiles in visible directories.
    #[tokio::test]
    async fn hidden_directories_are_skipped_by_default() {
        let root = test_root("hidden-directories");
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

        let default_result = execute(
            root.to_string_lossy().into_owned(),
            "hiddentarget".to_string(),
            5,
            false,
            true,
        )
        .await;
        let included_result = execute(
            root.to_string_lossy().into_owned(),
            "hiddentarget".to_string(),
            5,
            true,
            true,
        )
        .await;

        crate::safe_fs::safe_rm_all(&root)
            .await
            .expect("test tree should be removed");
        let CommandResult::FileSearch(default_response) = default_result else {
            panic!("a default hidden-directory search should succeed");
        };
        // Dotfiles remain searchable because only traversal into hidden directories is disabled.
        assert_eq!(default_response.results.len(), 1);
        assert_eq!(default_response.results[0].path, dotfile.to_string_lossy());
        let CommandResult::FileSearch(included_response) = included_result else {
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
        let root = test_root("nested-gitignore");
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

        let respected = execute(
            root.to_string_lossy().into_owned(),
            "target".to_string(),
            5,
            false,
            true,
        )
        .await;
        let disabled = execute(
            root.to_string_lossy().into_owned(),
            "target".to_string(),
            5,
            false,
            false,
        )
        .await;

        crate::safe_fs::safe_rm_all(&root)
            .await
            .expect("test tree should be removed");
        let CommandResult::FileSearch(respected_response) = respected else {
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
        let CommandResult::FileSearch(disabled_response) = disabled else {
            panic!("a search with gitignore disabled should succeed");
        };
        // Disabling ignore checks exposes every otherwise matching path.
        assert_eq!(disabled_response.results.len(), 3);
    }
}

/// Walks depth-first with one open directory per depth so broad trees do not become an in-memory plan.
async fn collect_matches(
    root: &Path,
    expression: &SearchExpression,
    include_hidden: bool,
    respect_gitignore: bool,
    matches: &mut Vec<RankedEntry>,
) -> std::io::Result<()> {
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut utf32_buffer = Vec::new();
    let root_entries = tokio::fs::read_dir(root).await?;
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
        let is_hidden = entry_name.to_string_lossy().starts_with('.');
        let relative_path = entry_path
            .strip_prefix(root)
            .map(|path| path.to_string_lossy())
            .unwrap_or_default();
        let normalized_relative_path = relative_path.to_lowercase();
        if expression
            .exclude_terms
            .iter()
            .any(|term| normalized_relative_path.contains(term))
        {
            // Rejecting before metadata and read_dir ensures excluded directories are never opened.
            continue;
        }
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if is_hidden && !include_hidden && file_type.is_dir() {
            // Rejecting direct hidden directories here ensures metadata and read_dir are never called.
            continue;
        }
        let followed_metadata = if file_type.is_dir() || file_type.is_symlink() {
            tokio::fs::metadata(&entry_path).await.ok()
        } else {
            None
        };
        let is_directory = file_type.is_dir()
            || followed_metadata
                .as_ref()
                .is_some_and(std::fs::Metadata::is_dir);
        if respect_gitignore && is_ignored(&directories, &entry_path, is_directory) {
            // Ignored directories are pruned before opening them, matching Git traversal semantics.
            continue;
        }
        if is_hidden && !include_hidden && is_directory {
            // Hidden symlink directories require metadata to identify, but are still never opened.
            continue;
        }

        if !relative_path.is_empty() {
            let score = expression
                .include_patterns
                .iter()
                .try_fold(0_u32, |score, pattern| {
                    let haystack = Utf32Str::new(&relative_path, &mut utf32_buffer);
                    pattern
                        .score(haystack, &mut matcher)
                        .map(|term_score| score.saturating_add(term_score))
                });
            if let Some(score) = score {
                retain_match(
                    matches,
                    RankedEntry {
                        entry: FileSearchEntry {
                            name: entry_name.to_string_lossy().into_owned(),
                            path: entry_path.to_string_lossy().into_owned(),
                            file_type: if is_directory {
                                "directory".to_string()
                            } else {
                                "file".to_string()
                            },
                        },
                        score,
                    },
                );
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

    Ok(())
}

/// Loads one directory's rules asynchronously while tolerating missing or partially invalid files.
async fn load_gitignore(directory: &Path, enabled: bool) -> Option<Gitignore> {
    if !enabled {
        return None;
    }
    let ignore_path = directory.join(".gitignore");
    let file = tokio::fs::File::open(&ignore_path).await.ok()?;
    let mut lines = BufReader::new(file).lines();
    let mut builder = GitignoreBuilder::new(directory);
    let mut first_line = true;
    while let Ok(Some(mut line)) = lines.next_line().await {
        if first_line {
            line = line.trim_start_matches('\u{feff}').to_string();
            first_line = false;
        }
        // Git accepts the valid rules in a file even when another line is malformed.
        let _ = builder.add_line(Some(ignore_path.clone()), &line);
    }
    builder.build().ok()
}

/// Applies the nearest matching rule first because deeper `.gitignore` files override ancestors.
fn is_ignored(directories: &[TraversedDirectory], path: &Path, is_directory: bool) -> bool {
    for gitignore in directories
        .iter()
        .rev()
        .filter_map(|directory| directory.gitignore.as_ref())
    {
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

/// Keeps only the globally strongest matches while traversal continues through arbitrary trees.
fn retain_match(matches: &mut Vec<RankedEntry>, candidate: RankedEntry) {
    if matches.len() < RESULT_LIMIT {
        matches.push(candidate);
        return;
    }

    let weakest_index = matches
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            left.score
                .cmp(&right.score)
                .then_with(|| right.entry.path.cmp(&left.entry.path))
        })
        .map(|(index, _)| index);
    if let Some(weakest_index) = weakest_index {
        let weakest = &matches[weakest_index];
        if candidate.score > weakest.score
            || (candidate.score == weakest.score && candidate.entry.path < weakest.entry.path)
        {
            matches[weakest_index] = candidate;
        }
    }
}
