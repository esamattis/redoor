//! Bounded content search (grep) over a directory tree for the file browser.

use super::{
    file_search::{DirectoryIdentity, directory_identity, is_ignored, load_gitignore},
    metadata::has_common_binary_magic,
    search_stream::{MatchSink, SearchStream},
};
use crate::transfers::stream::StreamWriter;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use ignore::gitignore::Gitignore;
use redoor_protocol::wire::request::CommandError;
use redoor_protocol::{
    api::search::{
        CaseSensitivity, ContentGrepContextLine, ContentGrepEvent, ContentGrepMatch,
        MAX_GREP_CONTEXT_LINES,
    },
    wire::command::CommandErrorKind,
};
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    fs::{DirEntry, ReadDir},
    io::{AsyncBufReadExt, BufReader},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

/// Bounds the matches one search streams and all retained matching-line state.
const RESULT_LIMIT: usize = 100;
/// Prevents one pathological physical line from growing an agent task without bound.
const MAX_PHYSICAL_LINE_BYTES: usize = 1024 * 1024;
/// Keeps each returned result useful while bounding serialization and transport work.
const MAX_RETURNED_LINE_BYTES: usize = 500;
/// Bounds synchronous regex compilation before the matcher can yield back to Tokio.
const MAX_QUERY_BYTES: usize = 4096;
/// Avoids opening files whose scan cost is disproportionate to interactive grep.
const MAX_SCANNED_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// What the walk streamed so far. It lives outside the walk, so the summary is still there
/// when a deadline drops the walk.
#[derive(Default)]
struct GrepOutput {
    sent: usize,
    truncated: bool,
    omitted_long_lines: u64,
}

/// Bundles grep controls so dispatch stays under clippy's argument cap as options grow.
pub struct ContentGrepRequest {
    pub path: String,
    pub query: String,
    pub timeout_seconds: u64,
    pub include_hidden: bool,
    pub respect_gitignore: bool,
    pub fixed_string: bool,
    pub case_sensitivity: CaseSensitivity,
    pub before_context: u64,
    pub after_context: u64,
}

/// Runs one content search and streams its matches on `stream`, returning the stream so the
/// result can follow the data.
///
/// Waiting for a grep slot counts against the deadline, so a queued search still ends on
/// time; it waits after the ready frame, because a full slot set is not an input error.
pub(crate) async fn execute(
    request: ContentGrepRequest,
    stream: StreamWriter,
    cancel: &CancellationToken,
    permit: Arc<Semaphore>,
) -> (StreamWriter, Result<(), CommandError>) {
    let started_at = Instant::now();
    let mut output = SearchStream::new(stream, cancel, "Content grep");
    let result = search(&request, &mut output, permit, started_at).await;
    if let Err(CommandError {
        kind: CommandErrorKind::Canceled,
        ..
    }) = &result
    {
        super::file_search::log_canceled_search(
            "Content grep",
            &request.path,
            &request.query,
            started_at,
        );
    }
    (output.into_writer(), result)
}

/// Validates, builds the matcher and opens the root before it streams, so those failures
/// are the result alone; then scans while matches stream.
async fn search(
    request: &ContentGrepRequest,
    output: &mut SearchStream<'_>,
    permit: Arc<Semaphore>,
    started_at: Instant,
) -> Result<(), CommandError> {
    if request.query.trim().is_empty() || request.query.len() > MAX_QUERY_BYTES {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            format!("Content grep query must be between 1 and {MAX_QUERY_BYTES} bytes"),
        ));
    }
    if request.before_context > MAX_GREP_CONTEXT_LINES
        || request.after_context > MAX_GREP_CONTEXT_LINES
    {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            format!(
                "Content grep context must be between 0 and {MAX_GREP_CONTEXT_LINES} lines per direction"
            ),
        ));
    }
    let context = ContextSize {
        before: usize::try_from(request.before_context).unwrap_or(0),
        after: usize::try_from(request.after_context).unwrap_or(0),
    };
    let matcher = RegexMatcherBuilder::new()
        .unicode(false)
        .case_insensitive(matches!(
            request.case_sensitivity,
            CaseSensitivity::Insensitive
        ))
        .case_smart(matches!(request.case_sensitivity, CaseSensitivity::Smart))
        .fixed_strings(request.fixed_string)
        .build(&request.query)
        .map_err(|error| {
            CommandError::new(
                CommandErrorKind::InvalidInput,
                format!("Invalid content grep regular expression: {error}"),
            )
        })?;
    let root = Path::new(&request.path);
    let root_entries = tokio::fs::read_dir(root)
        .await
        .map_err(|error| CommandError::io("Failed to grep directory", error))?;
    output.ready().await?;

    let deadline = started_at + Duration::from_secs(request.timeout_seconds);
    output
        .run(|sink| async move {
            let mut counts = GrepOutput::default();
            let walk = async {
                let _permit = permit.acquire_owned().await.map_err(|_| {
                    CommandError::new(
                        CommandErrorKind::Internal,
                        "Content grep coordinator is unavailable",
                    )
                })?;
                #[cfg(not(test))]
                redoor_core::log!(
                    redoor_protocol::wire::log::Level::Info,
                    "Content grep scan started: path={}",
                    request.path
                );
                GrepWalk::new(&matcher, request, context, &mut counts, &sink)
                    .run(root, root_entries)
                    .await;
                Ok::<(), CommandError>(())
            };
            let timed_out = tokio::select! {
                biased;
                result = walk => {
                    result?;
                    false
                }
                () = tokio::time::sleep_until(deadline.into()) => true,
            };
            Ok(ContentGrepEvent::Done {
                timed_out,
                // A canceled search ends without `done`; the flag stays so the summary keeps
                // the shape of the JSON response.
                cancelled: false,
                truncated: counts.truncated,
                omitted_long_lines: counts.omitted_long_lines,
                duration_ms: u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            })
        })
        .await
}

/// Physical lines kept before and after each match.
#[derive(Clone, Copy)]
struct ContextSize {
    before: usize,
    after: usize,
}

/// One directory's `.gitignore`, linked to the nearest ancestor that had one.
///
/// A breadth-first walk leaves a directory long before it reaches that directory's children,
/// so each queued directory carries its ancestors' rules instead of reading them off a stack
/// of open directories. Children share their parent's chain, so it costs one node per
/// `.gitignore` found, not one per queued directory.
struct IgnoreRules {
    gitignore: Gitignore,
    parent: Option<Arc<IgnoreRules>>,
}

impl IgnoreRules {
    /// Puts a directory's own rules in front of the inherited chain, or keeps the inherited
    /// chain when the directory has none, so directories without rules add no nodes.
    fn extend(
        parent: Option<Arc<IgnoreRules>>,
        gitignore: Option<Gitignore>,
    ) -> Option<Arc<IgnoreRules>> {
        match gitignore {
            Some(gitignore) => Some(Arc::new(IgnoreRules { gitignore, parent })),
            None => parent,
        }
    }

    /// Lists the rules nearest first, because deeper `.gitignore` files override ancestors.
    fn nearest_first(&self) -> impl Iterator<Item = &Gitignore> {
        std::iter::successors(Some(self), |rules| rules.parent.as_deref())
            .map(|rules| &rules.gitignore)
    }
}

/// A directory waiting for the walk to reach its depth. It holds a path rather than an open
/// handle, so a wide tree queues paths instead of file descriptors.
struct PendingDirectory {
    path: PathBuf,
    ignore_rules: Option<Arc<IgnoreRules>>,
}

/// Walks the tree breadth-first and each directory in name order, with the same hidden and
/// ignore policy as filename search.
///
/// Grep stops at its match cap, so the walk order decides which matches the user sees.
/// Depth-first in raw `readdir` order let one deep subtree that happened to come first, such
/// as vendored code, fill the cap before the files beside the search root were read, and the
/// result changed between filesystems. Shallow files first and a stable order make the capped
/// list predictable without scanning the whole tree to rank it.
struct GrepWalk<'a, M> {
    matcher: &'a M,
    context: ContextSize,
    include_hidden: bool,
    respect_gitignore: bool,
    output: &'a mut GrepOutput,
    sink: &'a MatchSink<ContentGrepEvent>,
    /// Every directory queued so far. A symlink maze offers exponentially many paths to the
    /// same few directories, and a breadth-first queue would hold every one of them, so each
    /// real directory is walked once, at the first path the walk meets it on. This also keeps
    /// a directory reachable through a symlink from repeating its matches.
    visited: HashSet<DirectoryIdentity>,
    queue: VecDeque<PendingDirectory>,
}

impl<'a, M: Matcher> GrepWalk<'a, M> {
    /// Prepares a walk that has visited nothing yet.
    fn new(
        matcher: &'a M,
        request: &ContentGrepRequest,
        context: ContextSize,
        output: &'a mut GrepOutput,
        sink: &'a MatchSink<ContentGrepEvent>,
    ) -> Self {
        Self {
            matcher,
            context,
            include_hidden: request.include_hidden,
            respect_gitignore: request.respect_gitignore,
            output,
            sink,
            visited: HashSet::new(),
            queue: VecDeque::new(),
        }
    }

    /// Scans the root, then every queued directory in the order queued, until the tree is done,
    /// the match cap is reached or the writer is gone.
    ///
    /// The root arrives already open, because opening it is validated before streaming starts.
    async fn run(mut self, root: &Path, root_entries: ReadDir) {
        if let Ok(metadata) = tokio::fs::metadata(root).await {
            self.visited.insert(directory_identity(&metadata));
        }
        if !self.scan_directory(root, root_entries, None).await {
            return;
        }
        while let Some(pending) = self.queue.pop_front() {
            // An unreadable directory must not discard the matches of the rest of the tree.
            let Ok(entries) = tokio::fs::read_dir(&pending.path).await else {
                continue;
            };
            if !self
                .scan_directory(&pending.path, entries, pending.ignore_rules)
                .await
            {
                return;
            }
        }
    }

    /// Scans one directory's files in name order and queues its subdirectories behind every
    /// directory already waiting, so they are only entered once the shallower level is done.
    ///
    /// Returns `false` when the walk should stop: the match cap was reached or the writer is
    /// gone.
    async fn scan_directory(
        &mut self,
        path: &Path,
        entries: ReadDir,
        inherited_rules: Option<Arc<IgnoreRules>>,
    ) -> bool {
        let ignore_rules = IgnoreRules::extend(
            inherited_rules,
            load_gitignore(path, self.respect_gitignore).await,
        );
        for entry in sorted_entries(entries).await {
            let entry_path = entry.path();
            let entry_name = entry.file_name();
            if entry_name == ".git" {
                continue;
            }
            if !self.include_hidden && entry_name.to_string_lossy().starts_with('.') {
                // Dotfiles are hidden too, so the filter matches its label and path search.
                continue;
            }
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            let followed_metadata = if file_type.is_dir() || file_type.is_symlink() {
                tokio::fs::metadata(&entry_path).await.ok()
            } else if file_type.is_file() {
                entry.metadata().await.ok()
            } else {
                None
            };
            let is_directory = file_type.is_dir()
                || followed_metadata
                    .as_ref()
                    .is_some_and(std::fs::Metadata::is_dir);
            if ignore_rules
                .as_deref()
                .is_some_and(|rules| is_ignored(rules.nearest_first(), &entry_path, is_directory))
            {
                continue;
            }

            if is_directory {
                // Without an identity the entry is a plain directory, which cannot form a cycle.
                let first_visit = followed_metadata
                    .as_ref()
                    .map(directory_identity)
                    .is_none_or(|identity| self.visited.insert(identity));
                if first_visit {
                    self.queue.push_back(PendingDirectory {
                        path: entry_path,
                        ignore_rules: ignore_rules.clone(),
                    });
                }
            } else if (file_type.is_file()
                || followed_metadata
                    .as_ref()
                    .is_some_and(std::fs::Metadata::is_file))
                && followed_metadata
                    .as_ref()
                    .is_some_and(|metadata| metadata.len() <= MAX_SCANNED_FILE_BYTES)
                && (!scan_file(
                    &entry_path,
                    self.matcher,
                    self.context,
                    self.output,
                    self.sink,
                )
                .await
                    || self.output.truncated)
            {
                return false;
            }
        }
        true
    }
}

/// Reads one directory's whole listing and sorts it by name, so matches come in the same order
/// on every filesystem instead of in `readdir` order.
///
/// Only the listing of the directory being scanned is held, never a whole level of the tree.
async fn sorted_entries(mut entries: ReadDir) -> Vec<DirEntry> {
    let mut sorted = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => sorted.push(entry),
            Ok(None) => break,
            // One unreadable child must not discard useful results from its siblings.
            Err(_) => continue,
        }
    }
    sorted.sort_by_cached_key(DirEntry::file_name);
    sorted
}

/// Buffers one bounded line and rejects binary prefixes before retaining any tentative matches.
///
/// A file's matches are streamed only once the whole file proved to be text. Returns `false`
/// when the writer is gone and the walk should stop.
async fn scan_file(
    path: &Path,
    matcher: &impl Matcher,
    context: ContextSize,
    output: &mut GrepOutput,
    sink: &MatchSink<ContentGrepEvent>,
) -> bool {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return true;
    };
    let mut reader = BufReader::with_capacity(8192, file);
    let mut line = Vec::new();
    let mut line_number = 1_u64;
    let mut oversized = false;
    let mut omitted_long_lines = 0_u64;
    let mut is_first_chunk = true;
    let mut state = FileGrepState::new(path, matcher, context.before, context.after);

    loop {
        let buffer = match reader.fill_buf().await {
            Ok(buffer) => buffer,
            Err(_) => return true,
        };
        if buffer.is_empty() {
            if oversized {
                omitted_long_lines = omitted_long_lines.saturating_add(1);
                state.retain_physical_line(line_number, None);
            } else if !line.is_empty() {
                state.retain_physical_line(line_number, Some(&line));
            }
            break;
        }
        if is_first_chunk {
            if has_common_binary_magic(buffer) {
                return true;
            }
            is_first_chunk = false;
        }
        if buffer.contains(&0) {
            // Any tentative matches belong to a binary file and must never enter the response.
            return true;
        }
        let consumed = buffer.len();
        for byte in buffer {
            if *byte == b'\n' {
                if oversized {
                    omitted_long_lines = omitted_long_lines.saturating_add(1);
                    state.retain_physical_line(line_number, None);
                } else {
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    state.retain_physical_line(line_number, Some(&line));
                }
                line.clear();
                oversized = false;
                line_number = line_number.saturating_add(1);
            } else if !oversized {
                if line.len() < MAX_PHYSICAL_LINE_BYTES {
                    line.push(*byte);
                } else {
                    line.clear();
                    oversized = true;
                }
            }
        }
        reader.consume(consumed);
    }

    output.omitted_long_lines = output.omitted_long_lines.saturating_add(omitted_long_lines);
    for matched_line in state.matches {
        if output.sent == RESULT_LIMIT {
            output.truncated = true;
            break;
        }
        if !sink
            .send(ContentGrepEvent::Match {
                entry: matched_line,
            })
            .await
        {
            return false;
        }
        output.sent += 1;
    }
    true
}

/// Keeps context queues private to one file so tentative binary-file matches remain discardable.
struct FileGrepState<'a, M> {
    path: &'a Path,
    matcher: &'a M,
    before_context: usize,
    after_context: usize,
    previous_lines: VecDeque<Option<ContentGrepContextLine>>,
    pending_after: VecDeque<usize>,
    matches: Vec<ContentGrepMatch>,
}

impl<'a, M: Matcher> FileGrepState<'a, M> {
    /// Allocates only the caller-selected context window before scanning starts.
    fn new(path: &'a Path, matcher: &'a M, before_context: usize, after_context: usize) -> Self {
        Self {
            path,
            matcher,
            before_context,
            after_context,
            previous_lines: VecDeque::with_capacity(before_context),
            pending_after: VecDeque::new(),
            matches: Vec::new(),
        }
    }

    /// Retains bounded context while oversized placeholders preserve physical-line distance.
    fn retain_physical_line(&mut self, line_number: u64, line: Option<&[u8]>) {
        let context_line = if self.before_context > 0 || !self.pending_after.is_empty() {
            line.map(|line| bounded_context_line(line_number, line))
        } else {
            None
        };
        for index in self.pending_after.iter().copied() {
            let matched_line_number = self.matches[index].line_number;
            if line_number.saturating_sub(matched_line_number) <= self.after_context as u64
                && let Some(context_line) = &context_line
            {
                self.matches[index].after_context.push(context_line.clone());
            }
        }
        while self.pending_after.front().is_some_and(|index| {
            line_number.saturating_sub(self.matches[*index].line_number)
                >= self.after_context as u64
        }) {
            self.pending_after.pop_front();
        }

        if let Some(line) = line
            && self.matches.len() <= RESULT_LIMIT
            && self.matcher.is_match(line).unwrap_or(false)
        {
            let returned_length = line.len().min(MAX_RETURNED_LINE_BYTES);
            self.matches.push(ContentGrepMatch {
                path: self.path.to_string_lossy().into_owned(),
                line_number,
                line: String::from_utf8_lossy(&line[..returned_length]).into_owned(),
                line_truncated: line.len() > MAX_RETURNED_LINE_BYTES,
                before_context: self.previous_lines.iter().flatten().cloned().collect(),
                after_context: Vec::with_capacity(self.after_context),
            });
            if self.after_context > 0 {
                self.pending_after.push_back(self.matches.len() - 1);
            }
        }

        if self.before_context > 0 {
            if self.previous_lines.len() == self.before_context {
                self.previous_lines.pop_front();
            }
            self.previous_lines.push_back(context_line);
        }
    }
}

/// Converts arbitrary file bytes to the same bounded representation used for matching lines.
fn bounded_context_line(line_number: u64, line: &[u8]) -> ContentGrepContextLine {
    let returned_length = line.len().min(MAX_RETURNED_LINE_BYTES);
    ContentGrepContextLine {
        line_number,
        line: String::from_utf8_lossy(&line[..returned_length]).into_owned(),
        line_truncated: line.len() > MAX_RETURNED_LINE_BYTES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::search_stream::test_support::{events, recording_writer, symlink_maze};
    use redoor_protocol::api::search::ContentGrepResponse;
    use redoor_protocol::wire::stream::StreamChunk;

    /// Runs a grep with its own slot against a recording stream and returns its result with
    /// the frames sent.
    async fn run(
        request: ContentGrepRequest,
        cancel: &CancellationToken,
    ) -> (Result<(), CommandError>, Vec<StreamChunk>) {
        let (writer, recorder) = recording_writer();
        let (writer, result) = execute(request, writer, cancel, Arc::new(Semaphore::new(1))).await;
        drop(writer);
        (result, recorder.await.expect("the recorder finishes"))
    }

    /// Rebuilds the response a client gets from the streamed events, like the server does.
    fn reduce(frames: &[StreamChunk]) -> ContentGrepResponse {
        let mut response = None;
        let mut results = Vec::new();
        for event in events::<ContentGrepEvent>(frames) {
            // Nothing may follow the `done` line.
            assert!(response.is_none(), "an event followed done");
            match event {
                ContentGrepEvent::Match { entry } => results.push(entry),
                ContentGrepEvent::Done {
                    timed_out,
                    cancelled,
                    truncated,
                    omitted_long_lines,
                    duration_ms,
                } => {
                    response = Some(ContentGrepResponse {
                        results: Vec::new(),
                        timed_out,
                        cancelled,
                        truncated,
                        omitted_long_lines,
                        duration_ms,
                    })
                }
            }
        }
        let mut response = response.expect("a finished grep ends with done");
        response.results = results;
        response
    }

    /// Runs an uncancelled grep and rebuilds its response from the stream.
    async fn grep(request: ContentGrepRequest) -> Result<ContentGrepResponse, CommandError> {
        let (result, frames) = run(request, &CancellationToken::new()).await;
        result.map(|()| reduce(&frames))
    }
    use redoor_core::test_support::TempDir;

    /// Builds the common unit-test request so fixtures only vary path, query, and match mode.
    fn test_request(
        path: impl Into<String>,
        query: impl Into<String>,
        fixed_string: bool,
    ) -> ContentGrepRequest {
        ContentGrepRequest {
            path: path.into(),
            query: query.into(),
            timeout_seconds: 5,
            include_hidden: false,
            respect_gitignore: true,
            fixed_string,
            case_sensitivity: CaseSensitivity::Smart,
            before_context: 0,
            after_context: 0,
        }
    }

    /// Covers line boundaries, CRLF normalization, response truncation, long-line omission, and late binary detection.
    #[tokio::test]
    async fn grep_is_bounded_and_discards_binary_file_matches() {
        let temp = TempDir::create();
        let root = temp.path().join("grep-root");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        tokio::fs::write(
            root.join("text.txt"),
            format!(
                "first target\r\n{}target\nfinal target",
                "x".repeat(MAX_RETURNED_LINE_BYTES)
            )
            .as_bytes(),
        )
        .await
        .expect("text fixture should be written");
        let mut oversized = vec![b'x'; MAX_PHYSICAL_LINE_BYTES + 1];
        oversized.extend_from_slice(b"target\n");
        tokio::fs::write(root.join("long.txt"), oversized)
            .await
            .expect("oversized fixture should be written");
        tokio::fs::write(root.join("binary.bin"), b"target\nclean\0later")
            .await
            .expect("binary fixture should be written");
        tokio::fs::write(root.join("binary.pdf"), b"%PDF-1.7 target without nul")
            .await
            .expect("magic-byte fixture should be written");

        let result = grep(test_request(
            root.to_string_lossy().into_owned(),
            "target",
            false,
        ))
        .await;
        let Ok(response) = result else {
            panic!("valid grep should return its dedicated response");
        };
        // A NUL discovered after an apparent match must suppress the whole binary file.
        assert!(response.results.iter().all(|entry| {
            !entry.path.ends_with("binary.bin") && !entry.path.ends_with("binary.pdf")
        }));
        // CRLF and an unterminated final line are both physical lines with one-based positions.
        assert_eq!(
            response
                .results
                .iter()
                .map(|entry| entry.line_number)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        // The long but permitted matching line is shortened only in the returned payload.
        assert!(response.results[1].line_truncated);
        // A physical line over the scan bound is drained and reported instead of matched.
        assert_eq!(response.omitted_long_lines, 1);
    }

    /// Verifies each match receives its own bounded physical-line window without crossing file edges.
    #[tokio::test]
    async fn grep_retains_per_match_context() {
        let temp = TempDir::create();
        let root = temp.path().join("context-grep");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        tokio::fs::write(
            root.join("text.txt"),
            b"zero\none\nfirst target\nbetween\nsecond target\nfive\n",
        )
        .await
        .expect("context fixture should be written");
        let mut request = test_request(root.to_string_lossy().into_owned(), "target", false);
        request.before_context = 2;
        request.after_context = 2;

        let result = grep(request).await;
        let Ok(response) = result else {
            panic!("context grep should return its dedicated response");
        };
        // Per-match context intentionally duplicates the line shared by overlapping windows.
        assert_eq!(
            response.results[0]
                .before_context
                .iter()
                .map(|line| (line.line_number, line.line.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "zero"), (2, "one")]
        );
        // Following context includes another matching line because context is based on physical distance.
        assert_eq!(
            response.results[0]
                .after_context
                .iter()
                .map(|line| (line.line_number, line.line.as_str()))
                .collect::<Vec<_>>(),
            vec![(4, "between"), (5, "second target")]
        );
        // The second result has an independent window clipped naturally at the end of the file.
        assert_eq!(
            response.results[1]
                .before_context
                .iter()
                .map(|line| line.line_number)
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert_eq!(response.results[1].after_context[0].line, "five");
    }

    /// Covers context normalization, unavailable oversized lines, EOF, and late binary rejection.
    #[tokio::test]
    async fn grep_context_preserves_physical_distances_and_text_rules() {
        let temp = TempDir::create();
        let root = temp.path().join("context-edge-grep");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        let mut text = b"first\r\n\n".to_vec();
        text.extend(std::iter::repeat_n(b'x', MAX_PHYSICAL_LINE_BYTES + 1));
        text.extend_from_slice(b"\ntarget\r\nlast");
        tokio::fs::write(root.join("text.txt"), text)
            .await
            .expect("text fixture should be written");
        tokio::fs::write(root.join("binary.bin"), b"before\ntarget\nafter\0binary")
            .await
            .expect("binary fixture should be written");
        let mut request = test_request(root.to_string_lossy().into_owned(), "target", false);
        request.before_context = 3;
        request.after_context = 1;

        let result = grep(request).await;
        let Ok(response) = result else {
            panic!("context grep should return its dedicated response");
        };
        // Tentative matches and their retained context must still be discarded after a late NUL.
        assert_eq!(response.results.len(), 1);
        // The oversized third physical line is unavailable without extending context past the requested distance.
        assert_eq!(
            response.results[0]
                .before_context
                .iter()
                .map(|line| (line.line_number, line.line.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "first"), (2, "")]
        );
        // CRLF is stripped from context and an unterminated final line remains available.
        assert_eq!(response.results[0].after_context[0].line, "last");
        assert_eq!(response.omitted_long_lines, 1);
    }

    /// Proves the size limit is exclusive and applied before oversized files reach the scanner.
    #[tokio::test]
    async fn grep_skips_files_larger_than_eight_mebibytes() {
        let temp = TempDir::create();
        let root = temp.path().join("size-bounded-grep");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        let eligible_path = root.join("eligible.txt");
        let oversized_path = root.join("oversized.txt");
        let mut eligible = b"eligible target\n".to_vec();
        eligible.resize(MAX_SCANNED_FILE_BYTES as usize, b'x');
        tokio::fs::write(&eligible_path, eligible)
            .await
            .expect("boundary fixture should be written");
        let mut oversized = b"oversized target\n".to_vec();
        oversized.resize(MAX_SCANNED_FILE_BYTES as usize + 1, b'x');
        tokio::fs::write(&oversized_path, oversized)
            .await
            .expect("oversized fixture should be written");

        let result = grep(test_request(
            root.to_string_lossy().into_owned(),
            "target",
            false,
        ))
        .await;
        let Ok(response) = result else {
            panic!("valid grep should return its dedicated response");
        };
        // A file exactly at the limit remains searchable.
        assert_eq!(response.results.len(), 1);
        assert!(response.results[0].path.ends_with("eligible.txt"));
        // The extra byte keeps the oversized file from contributing a second match.
        assert!(
            response
                .results
                .iter()
                .all(|entry| !entry.path.ends_with("oversized.txt"))
        );
    }

    /// Ensures malformed and empty expressions fail before any filesystem access occurs, and
    /// that early errors are the result alone, so the server can still answer with an HTTP
    /// error status.
    #[tokio::test]
    async fn invalid_expressions_are_invalid_input() {
        for query in ["", "(", &"x".repeat(MAX_QUERY_BYTES + 1)] {
            let (result, frames) = run(
                test_request("/missing", query, false),
                &CancellationToken::new(),
            )
            .await;
            // Validation must win over the deliberately missing traversal root.
            assert!(matches!(
                result,
                Err(CommandError {
                    kind: CommandErrorKind::InvalidInput,
                    ..
                })
            ));
            // Not even the ready frame went out.
            assert!(frames.is_empty());
        }
        let (result, frames) = run(
            test_request("/missing", "valid", false),
            &CancellationToken::new(),
        )
        .await;
        // A root that cannot be opened is reported with its own kind, before any data.
        assert_eq!(
            result.map_err(|error| error.kind),
            Err(CommandErrorKind::NotFound)
        );
        assert!(frames.is_empty());
    }

    /// Proves a canceled grep reports the cancel and never ends like a finished one.
    #[tokio::test]
    async fn cancellation_ends_without_done() {
        let temp = TempDir::create();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (result, frames) = run(
            test_request(temp.path().to_string_lossy(), "target", false),
            &cancel,
        )
        .await;
        // The caller learns the grep was canceled, not that it found nothing.
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

    /// Verifies a scan that runs into its deadline still ends with `done`, marked timed out.
    #[tokio::test]
    async fn timeout_still_ends_with_done() {
        let temp = TempDir::create();
        let root = temp.path().join("timeout-grep");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        let mut request = test_request(root.to_string_lossy(), "absent-needle", true);
        request.timeout_seconds = 1;
        // Holding the only grep slot keeps the walk waiting, so only the deadline can end it;
        // the walk visits each directory once, so no tree is endless enough to rely on.
        let slots = Arc::new(Semaphore::new(1));
        let _held = Arc::clone(&slots)
            .acquire_owned()
            .await
            .expect("the slot is free");

        let (writer, recorder) = recording_writer();
        let (writer, result) = execute(request, writer, &CancellationToken::new(), slots).await;
        drop(writer);
        let frames = recorder.await.expect("the recorder finishes");

        // Reaching the deadline is a normal end of a search.
        assert!(result.is_ok());
        // The stream is complete and its summary says it stopped at the deadline.
        assert!(frames.last().is_some_and(|frame| frame.is_last));
        assert!(reduce(&frames).timed_out);
    }

    /// Verifies the walk scans shallow files before deep ones and each directory in name
    /// order, so a deep subtree cannot fill the match cap before the root's own files.
    #[tokio::test]
    async fn grep_walks_breadth_first_in_name_order() {
        let temp = TempDir::create();
        let root = temp.path().join("ordered-grep");
        let deep = root.join("a-vendor").join("nested");
        tokio::fs::create_dir_all(&deep)
            .await
            .expect("deep directory should be created");
        // Enough matches deep down to fill the cap on their own.
        tokio::fs::write(deep.join("many.txt"), "needle\n".repeat(RESULT_LIMIT + 50))
            .await
            .expect("deep fixture should be written");
        tokio::fs::write(root.join("a-vendor").join("middle.txt"), "needle\n")
            .await
            .expect("middle fixture should be written");
        tokio::fs::write(root.join("z-last.txt"), "needle\n")
            .await
            .expect("root fixture should be written");
        tokio::fs::write(root.join("b-first.txt"), "needle\n")
            .await
            .expect("root fixture should be written");

        let Ok(response) = grep(test_request(root.to_string_lossy(), "needle", true)).await else {
            panic!("valid grep should return its dedicated response");
        };

        let relative: Vec<String> = response
            .results
            .iter()
            .map(|entry| {
                Path::new(&entry.path)
                    .strip_prefix(&root)
                    .expect("matches are under the root")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        // The root's files come first and sorted by name, although the subdirectory sorts
        // before them and holds enough matches to fill the cap.
        assert_eq!(relative[..2], ["b-first.txt", "z-last.txt"]);
        // The next level is done before the walk goes deeper.
        assert_eq!(relative[2], "a-vendor/middle.txt");
        assert!(
            relative[3..]
                .iter()
                .all(|path| path == "a-vendor/nested/many.txt")
        );
        // The deep file still fills the rest of the cap.
        assert!(response.truncated);
    }

    /// Verifies queued directories keep their ancestors' ignore rules, nearest first, even
    /// through a directory without a `.gitignore` of its own.
    #[tokio::test]
    async fn grep_applies_inherited_gitignore_rules() {
        let temp = TempDir::create();
        let root = temp.path().join("ignore-grep");
        let deeper = root.join("sub").join("deeper");
        tokio::fs::create_dir_all(&deeper)
            .await
            .expect("directories should be created");
        tokio::fs::write(root.join(".gitignore"), "*.log\n")
            .await
            .expect("root rules should be written");
        tokio::fs::write(root.join("sub").join(".gitignore"), "!keep.log\n")
            .await
            .expect("nested rules should be written");
        for file in [
            root.join("drop.log"),
            root.join("sub").join("other.log"),
            deeper.join("keep.log"),
            deeper.join("plain.txt"),
        ] {
            tokio::fs::write(file, "needle\n")
                .await
                .expect("fixture should be written");
        }

        let Ok(response) = grep(test_request(root.to_string_lossy(), "needle", true)).await else {
            panic!("valid grep should return its dedicated response");
        };

        let mut names: Vec<String> = response
            .results
            .iter()
            .map(|entry| {
                Path::new(&entry.path)
                    .strip_prefix(&root)
                    .expect("matches are under the root")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort_unstable();
        // The root rule hides logs two levels down, and the nearer whitelist re-includes only
        // `keep.log` although `deeper` has no rules of its own.
        assert_eq!(names, ["sub/deeper/keep.log", "sub/deeper/plain.txt"]);
    }

    /// Verifies a symlink maze ends after one visit per real directory instead of queueing
    /// its exponentially many paths.
    #[tokio::test]
    async fn grep_walks_each_symlinked_directory_once() {
        let temp = TempDir::create();
        let root = symlink_maze(temp.path(), "maze.txt", b"needle\n").await;

        let Ok(response) = grep(test_request(root.to_string_lossy(), "needle", true)).await else {
            panic!("valid grep should return its dedicated response");
        };

        // The maze has 41 real directories with one matching file each.
        assert_eq!(response.results.len(), 41);
        // Each file is reported once, however many symlink paths lead to it.
        let unique: HashSet<_> = response
            .results
            .iter()
            .map(|entry| std::fs::canonicalize(&entry.path).expect("matched files exist"))
            .collect();
        assert_eq!(unique.len(), 41);
        // The walk finished on its own rather than at the deadline.
        assert!(!response.timed_out);
    }

    /// Proves metacharacters stay literal when callers opt out of regex compilation.
    #[tokio::test]
    async fn fixed_string_matches_metacharacters_literally() {
        let temp = TempDir::create();
        let root = temp.path().join("literal-grep");
        tokio::fs::create_dir(&root)
            .await
            .expect("root should be created");
        tokio::fs::write(root.join("text.txt"), b"foo(bar\nneedle\n")
            .await
            .expect("text fixture should be written");

        let regex_dot = grep(test_request(
            root.to_string_lossy().into_owned(),
            "nee.le",
            false,
        ))
        .await;
        let Ok(regex_response) = regex_dot else {
            panic!("regex grep should return its dedicated response");
        };
        // A regex dot must still match the adjacent characters in default mode.
        assert_eq!(regex_response.results.len(), 1);

        let literal_dot = grep(test_request(
            root.to_string_lossy().into_owned(),
            "nee.le",
            true,
        ))
        .await;
        let Ok(literal_response) = literal_dot else {
            panic!("literal grep should return its dedicated response");
        };
        // The same query must fail as a substring because the file has no literal period.
        assert!(literal_response.results.is_empty());

        let literal_parens = grep(test_request(
            root.to_string_lossy().into_owned(),
            "foo(bar",
            true,
        ))
        .await;
        let Ok(paren_response) = literal_parens else {
            panic!("literal grep should return its dedicated response");
        };
        // Unbalanced parentheses are valid needles once regex compilation is skipped.
        assert_eq!(paren_response.results.len(), 1);
    }
}
