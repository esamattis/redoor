use super::{
    CommandErrorKind, CommandResult, ContentGrepContextLine, ContentGrepMatch, ContentGrepResponse,
    MAX_GREP_CONTEXT_LINES,
    file_search::{TraversedDirectory, directory_identity, is_ignored, load_gitignore},
    metadata::has_common_binary_magic,
};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use std::{
    collections::{HashSet, VecDeque},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::{Semaphore, watch},
};

/// Bounds the JSON response and all retained matching-line state.
const RESULT_LIMIT: usize = 100;
/// Prevents one pathological physical line from growing an agent task without bound.
const MAX_PHYSICAL_LINE_BYTES: usize = 1024 * 1024;
/// Keeps each returned result useful while bounding serialization and transport work.
const MAX_RETURNED_LINE_BYTES: usize = 500;
/// Bounds synchronous regex compilation before the matcher can yield back to Tokio.
const MAX_QUERY_BYTES: usize = 4096;
/// Avoids opening files whose scan cost is disproportionate to interactive grep.
const MAX_SCANNED_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Accumulates scan state that remains valid when a deadline interrupts traversal.
struct GrepOutput {
    results: Vec<ContentGrepMatch>,
    truncated: bool,
    omitted_long_lines: u64,
}

impl GrepOutput {
    /// Allocates only the documented result cap up front.
    fn new() -> Self {
        Self {
            results: Vec::with_capacity(RESULT_LIMIT),
            truncated: false,
            omitted_long_lines: 0,
        }
    }
}

/// Bundles grep controls so dispatch stays under clippy's argument cap as options grow.
pub struct ContentGrepRequest {
    pub path: String,
    pub query: String,
    pub timeout_seconds: u64,
    pub include_hidden: bool,
    pub respect_gitignore: bool,
    pub fixed_string: bool,
    pub before_context: u64,
    pub after_context: u64,
}

/// Runs grep without runtime coordination for direct command-dispatch callers and unit tests.
pub(super) async fn execute(request: ContentGrepRequest) -> CommandResult {
    let (_cancel_sender, cancel_receiver) = watch::channel(false);
    execute_with_cancellation(request, cancel_receiver, Arc::new(Semaphore::new(1))).await
}

/// Includes exclusive-slot waiting in the deadline so queued requests always return promptly.
pub(super) async fn execute_with_cancellation(
    request: ContentGrepRequest,
    mut cancel_receiver: watch::Receiver<bool>,
    permit: Arc<Semaphore>,
) -> CommandResult {
    let ContentGrepRequest {
        path,
        query,
        timeout_seconds,
        include_hidden,
        respect_gitignore,
        fixed_string,
        before_context,
        after_context,
    } = request;
    if query.trim().is_empty() || query.len() > MAX_QUERY_BYTES {
        return CommandResult::error(
            CommandErrorKind::InvalidInput,
            format!("Content grep query must be between 1 and {MAX_QUERY_BYTES} bytes"),
        );
    }
    if before_context > MAX_GREP_CONTEXT_LINES || after_context > MAX_GREP_CONTEXT_LINES {
        return CommandResult::error(
            CommandErrorKind::InvalidInput,
            format!(
                "Content grep context must be between 0 and {MAX_GREP_CONTEXT_LINES} lines per direction"
            ),
        );
    }
    let before_context = usize::try_from(before_context).unwrap_or(0);
    let after_context = usize::try_from(after_context).unwrap_or(0);

    let started_at = Instant::now();
    let mut output = GrepOutput::new();
    let (timed_out, cancelled, io_result) = {
        let operation = async {
            let _permit = permit
                .acquire_owned()
                .await
                .map_err(|_| std::io::Error::other("Content grep coordinator is unavailable"))?;
            let matcher = RegexMatcherBuilder::new()
                .unicode(false)
                .fixed_strings(fixed_string)
                .build(&query)
                .map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!("Invalid content grep regular expression: {error}"),
                    )
                })?;
            #[cfg(not(test))]
            crate::log!(
                crate::logging::Level::Info,
                "Content grep scan started: path={path}"
            );
            collect_matches(
                Path::new(&path),
                &matcher,
                include_hidden,
                respect_gitignore,
                before_context,
                after_context,
                &mut output,
            )
            .await
        };
        tokio::pin!(operation);
        let deadline = tokio::time::sleep(Duration::from_secs(timeout_seconds));
        tokio::pin!(deadline);

        if *cancel_receiver.borrow() {
            (false, true, None)
        } else {
            tokio::select! {
                biased;
                _ = cancel_receiver.changed() => (false, true, None),
                _ = &mut deadline => (true, false, None),
                result = &mut operation => (false, false, Some(result)),
            }
        }
    };
    if let Some(Err(error)) = io_result {
        if error.kind() == std::io::ErrorKind::InvalidInput {
            return CommandResult::error(CommandErrorKind::InvalidInput, error.to_string());
        }
        return CommandResult::io_error("Failed to grep directory", error);
    }

    CommandResult::ContentGrep(ContentGrepResponse {
        results: output.results,
        context_supported: true,
        timed_out,
        cancelled,
        truncated: output.truncated,
        omitted_long_lines: output.omitted_long_lines,
        duration_ms: u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

/// Traverses incrementally with the same hidden, ignore, and symlink-cycle policy as filename search.
async fn collect_matches(
    root: &Path,
    matcher: &impl Matcher,
    include_hidden: bool,
    respect_gitignore: bool,
    before_context: usize,
    after_context: usize,
    output: &mut GrepOutput,
) -> std::io::Result<()> {
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
            // One unreadable child must not discard useful results from its siblings.
            Err(_) => continue,
        };
        let entry_path = entry.path();
        let entry_name = entry.file_name();
        if entry_name == ".git" {
            continue;
        }
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        let is_hidden = entry_name.to_string_lossy().starts_with('.');
        if is_hidden && !include_hidden && file_type.is_dir() {
            continue;
        }
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
        if respect_gitignore && is_ignored(&directories, &entry_path, is_directory) {
            continue;
        }
        if is_hidden && !include_hidden && is_directory {
            continue;
        }

        if !is_directory
            && (file_type.is_file()
                || followed_metadata
                    .as_ref()
                    .is_some_and(std::fs::Metadata::is_file))
            && followed_metadata
                .as_ref()
                .is_some_and(|metadata| metadata.len() <= MAX_SCANNED_FILE_BYTES)
        {
            scan_file(&entry_path, matcher, before_context, after_context, output).await;
            if output.truncated {
                break;
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

/// Buffers one bounded line and rejects binary prefixes before retaining any tentative matches.
async fn scan_file(
    path: &Path,
    matcher: &impl Matcher,
    before_context: usize,
    after_context: usize,
    output: &mut GrepOutput,
) {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return;
    };
    let mut reader = BufReader::with_capacity(8192, file);
    let mut line = Vec::new();
    let mut line_number = 1_u64;
    let mut oversized = false;
    let mut omitted_long_lines = 0_u64;
    let mut is_first_chunk = true;
    let mut state = FileGrepState::new(path, matcher, before_context, after_context);

    loop {
        let buffer = match reader.fill_buf().await {
            Ok(buffer) => buffer,
            Err(_) => return,
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
                return;
            }
            is_first_chunk = false;
        }
        if buffer.contains(&0) {
            // Any tentative matches belong to a binary file and must never enter the response.
            return;
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
        if output.results.len() == RESULT_LIMIT {
            output.truncated = true;
            break;
        }
        output.results.push(matched_line);
    }
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
    use crate::test_support::TempDir;

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

        let result = execute(test_request(
            root.to_string_lossy().into_owned(),
            "target",
            false,
        ))
        .await;
        let CommandResult::ContentGrep(response) = result else {
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

        let result = execute(request).await;
        let CommandResult::ContentGrep(response) = result else {
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

        let result = execute(request).await;
        let CommandResult::ContentGrep(response) = result else {
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

        let result = execute(test_request(
            root.to_string_lossy().into_owned(),
            "target",
            false,
        ))
        .await;
        let CommandResult::ContentGrep(response) = result else {
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

    /// Ensures malformed and empty expressions fail before any filesystem access occurs.
    #[tokio::test]
    async fn invalid_expressions_are_invalid_input() {
        for query in ["", "(", &"x".repeat(MAX_QUERY_BYTES + 1)] {
            let result = execute(test_request("/missing", query, false)).await;
            // Validation must win over the deliberately missing traversal root.
            assert!(matches!(
                result,
                CommandResult::Error {
                    kind: CommandErrorKind::InvalidInput,
                    ..
                }
            ));
        }
    }

    /// Proves supersession has a distinct response flag rather than masquerading as a deadline.
    #[tokio::test]
    async fn cancellation_returns_bounded_partial_response() {
        let (sender, receiver) = watch::channel(false);
        sender.send(true).expect("receiver should remain active");
        let result = execute_with_cancellation(
            test_request("/missing", "target", false),
            receiver,
            Arc::new(Semaphore::new(1)),
        )
        .await;
        let CommandResult::ContentGrep(response) = result else {
            panic!("cancellation should remain a grep response");
        };
        // Latest-wins cancellation is observable independently from a caller deadline.
        assert!(response.cancelled && !response.timed_out);
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

        let regex_dot = execute(test_request(
            root.to_string_lossy().into_owned(),
            "nee.le",
            false,
        ))
        .await;
        let CommandResult::ContentGrep(regex_response) = regex_dot else {
            panic!("regex grep should return its dedicated response");
        };
        // A regex dot must still match the adjacent characters in default mode.
        assert_eq!(regex_response.results.len(), 1);

        let literal_dot = execute(test_request(
            root.to_string_lossy().into_owned(),
            "nee.le",
            true,
        ))
        .await;
        let CommandResult::ContentGrep(literal_response) = literal_dot else {
            panic!("literal grep should return its dedicated response");
        };
        // The same query must fail as a substring because the file has no literal period.
        assert!(literal_response.results.is_empty());

        let literal_parens = execute(test_request(
            root.to_string_lossy().into_owned(),
            "foo(bar",
            true,
        ))
        .await;
        let CommandResult::ContentGrep(paren_response) = literal_parens else {
            panic!("literal grep should return its dedicated response");
        };
        // Unbalanced parentheses are valid needles once regex compilation is skipped.
        assert_eq!(paren_response.results.len(), 1);
    }
}
