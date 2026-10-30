//! Worktree diffs, plus the bounded blob reading and patch formatting every Git diff shares.

use std::{
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

use gix::bstr::ByteSlice;

use redoor_protocol::{
    api::git::{
        GitDiffResult, MAX_FULL_CONTEXT_PATCH_BYTES,
        worktree::{GitDiffMode, GitDiffRequest, GitDiffResponse, GitFileDiff, GitTrackingState},
    },
    wire::{command::CommandErrorKind, request::CommandError},
};

use super::{
    GitFailure, discover_repository, head_tree, internal_failure, io_failure, run_blocking,
    status::classify_tracking, utf8_relative, validate_absolute_path,
};

/// Matches the editor's existing per-file safety policy for both sides of a diff.
pub(super) const MAX_DIFF_INPUT_BYTES: u64 = 2 * 1024 * 1024;
/// Prevents a bounded pair of inputs from expanding into an unexpectedly large control frame.
/// Measured as JSON-encoded bytes, like the batch budget.
const MAX_UNIFIED_DIFF_BYTES: usize = 4 * 1024 * 1024;
/// Caps patch text per batch on agents with restrained memory. It is measured as JSON-encoded
/// bytes because escaping can grow control characters sixfold, and the encoded response is
/// what must fit in one WebSocket control frame.
const MAX_BATCH_DIFF_BYTES: usize = 8 * 1024 * 1024;
/// Caps the unchanged lines a batch adds by sending files whole, which lets the UI expand
/// context without another request. It is separate from the patch budget so whole files can
/// never push a later file's changes out of the response; the frame grows by at most this.
const MAX_BATCH_CONTEXT_BYTES: usize = 4 * 1024 * 1024;
/// The unchanged lines `similar` and `git diff` keep around each change by default, which is
/// what a patch falls back to when its whole file does not fit.
const DEFAULT_CONTEXT_LINES: usize = 3;

/// Keeps size and entry-kind classifications out of the command-error channel.
pub(super) enum DiffSource {
    Missing,
    Content(Vec<u8>),
    TooLarge,
    Unsupported,
}

/// Returns how many bytes text occupies inside a JSON string, so patch budgets bound the
/// serialized control frame rather than the raw text.
pub(super) fn json_encoded_len(text: &[u8]) -> usize {
    text.iter()
        .map(|byte| match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 0x08 | 0x0c => 2,
            // Other control characters are written as `\u00XX`.
            0x00..=0x1f => 6,
            _ => 1,
        })
        .sum()
}

/// Collects formatter output without allowing a control response to exceed its hard limit.
struct LimitedWriter {
    bytes: Vec<u8>,
    /// The JSON-encoded size of `bytes`, which is what the limit applies to.
    encoded: usize,
    limit: usize,
}

impl Write for LimitedWriter {
    /// Rejects a chunk before it can grow the response beyond the configured limit.
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let encoded = self.encoded.saturating_add(json_encoded_len(buffer));
        if encoded > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::FileTooLarge,
                "unified diff exceeds its output limit",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        self.encoded = encoded;
        Ok(buffer.len())
    }

    /// In-memory output has no pending data to flush.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Runs ordered object reads, worktree reads, and text diffing away from Tokio workers.
pub(crate) async fn diff(
    files: Vec<String>,
    mode: GitDiffMode,
) -> Result<GitDiffResponse, CommandError> {
    run_blocking(move |interrupt| diff_blocking(files, mode, interrupt)).await
}

/// Produces bounded comparisons in request order so directory views remain stable.
fn diff_blocking(
    files: Vec<String>,
    mode: GitDiffMode,
    interrupt: Arc<AtomicBool>,
) -> Result<GitDiffResponse, GitFailure> {
    // Agent-side validation also protects commands sent outside the REST API.
    let mut request = GitDiffRequest { files, mode };
    request
        .normalize_files()
        .map_err(|message| GitFailure::new(CommandErrorKind::InvalidInput, message))?;
    let mut budget = DiffBudget::new();
    let mut diffs = Vec::with_capacity(request.files.len());
    for path in request.files {
        diffs.push(diff_file_blocking(
            path,
            mode,
            interrupt.clone(),
            &mut budget,
        )?);
    }
    Ok(GitDiffResponse { diffs })
}

/// Compares one requested path while retaining explicit non-text outcomes per file.
fn diff_file_blocking(
    path: String,
    mode: GitDiffMode,
    interrupt: Arc<AtomicBool>,
    budget: &mut DiffBudget,
) -> Result<GitFileDiff, GitFailure> {
    let requested = validate_absolute_path(&path)?;
    let repository = discover_repository(requested.clone())?.ok_or_else(|| {
        GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Path is not inside a non-bare Git worktree",
        )
    })?;
    let relative = utf8_relative(&repository.relative)?;
    if relative.is_empty() {
        return Err(GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Git diff path must select a file",
        ));
    }
    if relative.chars().any(char::is_control) {
        return Ok(GitFileDiff {
            path,
            result: GitDiffResult::UnsupportedEntry,
        });
    }
    let tracking = classify_tracking(&repository, relative.as_bytes(), interrupt)?;
    let early_result = match tracking {
        GitTrackingState::Untracked if mode == GitDiffMode::Staged => {
            Some(GitDiffResult::NoChanges)
        }
        GitTrackingState::Untracked => None,
        GitTrackingState::Ignored => Some(GitDiffResult::Ignored),
        GitTrackingState::Tracked | GitTrackingState::Deleted => None,
    };
    if let Some(result) = early_result {
        return Ok(GitFileDiff { path, result });
    }
    if path_declared_binary(&repository.repo, &repository.relative)? {
        return Ok(GitFileDiff {
            path,
            result: GitDiffResult::Binary,
        });
    }

    let head_source = if tracking == GitTrackingState::Untracked {
        DiffSource::Missing
    } else {
        head_blob(&repository.repo, &repository.relative)?
    };
    let right_source = match mode {
        GitDiffMode::Full => worktree_blob(&requested)?,
        GitDiffMode::Staged => index_blob(&repository.repo, relative.as_bytes())?,
    };
    let result = budget.compare(head_source, right_source, &relative)?;
    Ok(GitFileDiff { path, result })
}

/// Reads a bounded blob from HEAD, treating only an unborn HEAD as an empty side.
fn head_blob(repo: &gix::Repository, relative: &Path) -> Result<DiffSource, GitFailure> {
    let tree = match head_tree(repo)? {
        Some(tree) => tree,
        None => return Ok(DiffSource::Missing),
    };
    let Some(entry) = tree
        .lookup_entry_by_path(relative)
        .map_err(|error| internal_failure("lookup Git HEAD file", error))?
    else {
        return Ok(DiffSource::Missing);
    };
    if !entry.mode().is_blob() {
        return Ok(DiffSource::Unsupported);
    }
    read_object_blob(repo, entry.object_id())
}

/// Reads a bounded stage-zero index blob and rejects conflicts or special entry kinds.
fn index_blob(repo: &gix::Repository, relative: &[u8]) -> Result<DiffSource, GitFailure> {
    let index = repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index", error))?;
    if index
        .entries()
        .iter()
        .any(|entry| entry.path(&index) == relative.as_bstr() && entry.flags.stage_raw() != 0)
    {
        return Ok(DiffSource::Unsupported);
    }
    let Some(entry) = index.entry_by_path(relative.as_bstr()) else {
        return Ok(DiffSource::Missing);
    };
    let mode = entry.mode.to_tree_entry_mode();
    if !mode.is_some_and(|mode| mode.is_blob()) {
        return Ok(DiffSource::Unsupported);
    }
    read_object_blob(repo, entry.id)
}

/// Checks object size before decompression so oversized repository blobs remain bounded.
pub(super) fn read_object_blob(
    repo: &gix::Repository,
    id: gix::ObjectId,
) -> Result<DiffSource, GitFailure> {
    let header = repo
        .find_header(id)
        .map_err(|error| internal_failure("read Git object header", error))?;
    if header.size() > MAX_DIFF_INPUT_BYTES {
        return Ok(DiffSource::TooLarge);
    }
    let object = repo
        .find_object(id)
        .map_err(|error| internal_failure("read Git blob", error))?;
    Ok(DiffSource::Content(object.detach().data))
}

/// Reads a worktree file with metadata and post-read bounds, never following symlinks.
fn worktree_blob(path: &Path) -> Result<DiffSource, GitFailure> {
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiffSource::Missing);
        }
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Ok(DiffSource::Unsupported);
        }
        Err(error) => return Err(io_failure("open Git worktree file", error)),
    };
    let metadata = file
        .metadata()
        .map_err(|error| io_failure("inspect open Git worktree file", error))?;
    if !metadata.is_file() {
        return Ok(DiffSource::Unsupported);
    }
    if metadata.len() > MAX_DIFF_INPUT_BYTES {
        return Ok(DiffSource::TooLarge);
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_DIFF_INPUT_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| io_failure("read Git worktree file", error))?;
    if data.len() as u64 > MAX_DIFF_INPUT_BYTES {
        return Ok(DiffSource::TooLarge);
    }
    Ok(DiffSource::Content(data))
}

/// What is left of a batch's response budgets, shared by every file of one diff response.
pub(super) struct DiffBudget {
    /// JSON-encoded bytes left for the patches as they would be with default context.
    patch: usize,
    /// JSON-encoded bytes left for the extra unchanged lines of patches sent whole.
    context: usize,
}

impl DiffBudget {
    /// Starts a batch with both budgets full.
    pub(super) fn new() -> Self {
        Self {
            patch: MAX_BATCH_DIFF_BYTES,
            context: MAX_BATCH_CONTEXT_BYTES,
        }
    }

    /// Formats bounded UTF-8 blobs as unified text with Git-style path headers and charges the
    /// patch to the budgets. The patch carries every unchanged line when that fits, so the UI
    /// can expand context locally, and falls back to default context when it does not.
    pub(super) fn compare(
        &mut self,
        left: DiffSource,
        right: DiffSource,
        relative: &str,
    ) -> Result<GitDiffResult, GitFailure> {
        if matches!(left, DiffSource::TooLarge) || matches!(right, DiffSource::TooLarge) {
            return Ok(GitDiffResult::TooLarge);
        }
        if matches!(left, DiffSource::Unsupported) || matches!(right, DiffSource::Unsupported) {
            return Ok(GitDiffResult::UnsupportedEntry);
        }
        let left = match left {
            DiffSource::Content(content) => content,
            DiffSource::Missing => Vec::new(),
            DiffSource::TooLarge | DiffSource::Unsupported => unreachable!("classified above"),
        };
        let right = match right {
            DiffSource::Content(content) => content,
            DiffSource::Missing => Vec::new(),
            DiffSource::TooLarge | DiffSource::Unsupported => unreachable!("classified above"),
        };
        if left == right {
            return Ok(GitDiffResult::NoChanges);
        }
        if left.contains(&0) || right.contains(&0) {
            return Ok(GitDiffResult::Binary);
        }
        let (Ok(left), Ok(right)) = (std::str::from_utf8(&left), std::str::from_utf8(&right))
        else {
            return Ok(GitDiffResult::Binary);
        };
        let text_diff = similar::TextDiff::from_lines(left, right);
        // The default-context patch decides whether the file fits at all, exactly as before
        // whole files were sent, so the extra context can never turn a file into `TooLarge`.
        let Some(compact) = format_patch(
            &text_diff,
            DEFAULT_CONTEXT_LINES,
            relative,
            MAX_UNIFIED_DIFF_BYTES.min(self.patch),
        ) else {
            return Ok(GitDiffResult::TooLarge);
        };
        self.patch -= compact.encoded;
        // A file has no more lines than bytes, so this radius keeps every unchanged line
        // without the overflow `usize::MAX` would cause inside `similar`.
        let whole_radius = left.len().max(right.len());
        let whole_limit =
            MAX_FULL_CONTEXT_PATCH_BYTES.min(compact.encoded.saturating_add(self.context));
        let whole = format_patch(&text_diff, whole_radius, relative, whole_limit);
        let (patch, full_context) = match whole {
            Some(whole) => {
                self.context -= whole.encoded.saturating_sub(compact.encoded);
                (whole, true)
            }
            None => (compact, false),
        };
        let unified_diff = String::from_utf8(patch.bytes)
            .map_err(|error| internal_failure("encode unified Git diff", error))?;
        Ok(GitDiffResult::Text {
            unified_diff,
            full_context,
        })
    }
}

/// Formats a patch with `radius` unchanged lines around each change, or returns `None` when
/// it would exceed `limit` JSON-encoded bytes, so an oversized patch is never held whole.
fn format_patch(
    text_diff: &similar::TextDiff<'_, '_, str>,
    radius: usize,
    relative: &str,
    limit: usize,
) -> Option<LimitedWriter> {
    let mut unified_diff = text_diff.unified_diff();
    unified_diff
        .context_radius(radius)
        .header(&format!("a/{relative}"), &format!("b/{relative}"));
    let mut output = LimitedWriter {
        bytes: Vec::new(),
        encoded: 0,
        limit,
    };
    unified_diff.to_writer(&mut output).ok()?;
    Some(output)
}

/// Honors Git's built-in `-diff` binary declaration without invoking configured drivers.
pub(super) fn path_declared_binary(
    repo: &gix::Repository,
    relative: &Path,
) -> Result<bool, GitFailure> {
    let index = repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index for attributes", error))?;
    let mut attributes = repo
        .attributes_only(
            &index,
            gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping,
        )
        .map_err(|error| internal_failure("prepare Git attributes", error))?;
    let mut matches = attributes.selected_attribute_matches(["diff"]);
    attributes
        .at_path(relative, None)
        .map_err(|error| internal_failure("read Git attributes", error))?
        .matching_attributes(&mut matches);
    Ok(matches
        .iter_selected()
        .next()
        .is_some_and(|attribute| attribute.assignment.state.is_unset()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Covers explicit no-change, binary, and Git-style unified patch outcomes.
    #[test]
    fn bounded_diff_formatter_classifies_content() {
        // Equal content has a semantic result instead of an empty ambiguous patch.
        assert_eq!(
            DiffBudget::new()
                .compare(
                    DiffSource::Content(b"same\n".to_vec()),
                    DiffSource::Content(b"same\n".to_vec()),
                    "file.txt",
                )
                .unwrap(),
            GitDiffResult::NoChanges
        );
        // NUL bytes identify binary data before line formatting.
        assert_eq!(
            DiffBudget::new()
                .compare(
                    DiffSource::Content(vec![0]),
                    DiffSource::Content(vec![1]),
                    "file.bin",
                )
                .unwrap(),
            GitDiffResult::Binary
        );
        let result = DiffBudget::new()
            .compare(
                DiffSource::Content(b"old\n".to_vec()),
                DiffSource::Content(b"new\n".to_vec()),
                "nested/file.txt",
            )
            .unwrap();
        let GitDiffResult::Text { unified_diff, .. } = result else {
            panic!("changed UTF-8 should produce text");
        };
        // Git-style labels let the existing renderer identify the browser path.
        assert!(unified_diff.contains("--- a/nested/file.txt"));
        assert!(unified_diff.contains("+++ b/nested/file.txt"));
        // Signed lines preserve replacement direction for patch consumers.
        assert!(unified_diff.contains("-old\n+new"));
    }

    /// Checks that the batch budget is applied before patch bytes are retained.
    #[test]
    fn formatter_respects_remaining_batch_budget() {
        let mut budget = DiffBudget {
            patch: 4,
            context: MAX_BATCH_CONTEXT_BYTES,
        };
        let result = budget
            .compare(
                DiffSource::Missing,
                DiffSource::Content(b"addition".to_vec()),
                "file.txt",
            )
            .unwrap();
        // An individually valid patch must still respect the remaining shared budget.
        assert_eq!(result, GitDiffResult::TooLarge);
    }

    /// Builds a file of numbered lines, so context sizes are easy to reason about.
    fn numbered_lines(count: usize, changed: Option<usize>) -> Vec<u8> {
        (1..=count)
            .map(|line| {
                if Some(line) == changed {
                    format!("changed {line}\n")
                } else {
                    format!("line {line}\n")
                }
            })
            .collect::<String>()
            .into_bytes()
    }

    /// Checks that small files are sent whole, so the UI can expand context without asking
    /// again, and that the whole file is charged to the context budget only.
    #[test]
    fn formatter_sends_whole_files_that_fit() {
        let mut budget = DiffBudget::new();
        let result = budget
            .compare(
                DiffSource::Content(numbered_lines(50, None)),
                DiffSource::Content(numbered_lines(50, Some(25))),
                "file.txt",
            )
            .unwrap();
        let GitDiffResult::Text {
            unified_diff,
            full_context,
        } = result
        else {
            panic!("changed UTF-8 should produce text");
        };
        // The flag tells the UI it may fold and expand the unchanged lines itself.
        assert!(full_context);
        // One hunk spans the whole file, so lines far from the change are included.
        assert!(unified_diff.contains("@@ -1,50 +1,50 @@"));
        assert!(unified_diff.contains(" line 1\n"));
        assert!(unified_diff.contains(" line 50\n"));
        // The patch budget is charged as if default context had been sent, so whole files
        // never crowd later files' changes out of a batch.
        let compact = format_patch(
            &similar::TextDiff::from_lines(
                std::str::from_utf8(&numbered_lines(50, None)).unwrap(),
                std::str::from_utf8(&numbered_lines(50, Some(25))).unwrap(),
            ),
            DEFAULT_CONTEXT_LINES,
            "file.txt",
            usize::MAX,
        )
        .unwrap();
        assert_eq!(budget.patch, MAX_BATCH_DIFF_BYTES - compact.encoded);
        // Only the extra unchanged lines come out of the context budget.
        assert_eq!(
            budget.context,
            MAX_BATCH_CONTEXT_BYTES - (json_encoded_len(unified_diff.as_bytes()) - compact.encoded)
        );
    }

    /// Checks that a file whose whole patch does not fit the context budget still shows its
    /// changes with default context instead of becoming too large.
    #[test]
    fn formatter_falls_back_to_default_context() {
        let mut budget = DiffBudget {
            patch: MAX_BATCH_DIFF_BYTES,
            context: 0,
        };
        let result = budget
            .compare(
                DiffSource::Content(numbered_lines(50, None)),
                DiffSource::Content(numbered_lines(50, Some(25))),
                "file.txt",
            )
            .unwrap();
        let GitDiffResult::Text {
            unified_diff,
            full_context,
        } = result
        else {
            panic!("changed UTF-8 should produce text");
        };
        // The UI must not offer expansion for lines the patch does not carry.
        assert!(!full_context);
        // Three lines of context around line 25, as `git diff` would show.
        assert!(unified_diff.contains("@@ -22,7 +22,7 @@"));
        assert!(!unified_diff.contains(" line 1\n"));
    }

    /// Protects direct agent commands from duplicate work and excessive batch metadata.
    #[test]
    fn diff_requests_deduplicate_in_order_and_reject_excess_files() {
        let mut request = GitDiffRequest {
            files: vec!["/b".to_string(), "/a".to_string(), "/b".to_string()],
            mode: GitDiffMode::Full,
        };
        request.normalize_files().unwrap();
        // First-occurrence ordering keeps file rows aligned with the request.
        assert_eq!(request.files, vec!["/b", "/a"]);
        request.files = (0..GitDiffRequest::MAX_FILES)
            .map(|index| format!("/{index}"))
            .collect();
        // Exactly the documented number of distinct files remains supported.
        assert!(request.normalize_files().is_ok());
        request.files.push("/overflow".to_string());
        // Rejecting before repository reads bounds work even for direct agent commands.
        assert!(request.normalize_files().is_err());
    }

    /// Verifies the formatter preserves missing-final-newline markers needed for exact display.
    #[test]
    fn bounded_diff_formatter_marks_missing_final_newlines() {
        let result = DiffBudget::new()
            .compare(
                DiffSource::Content(b"old".to_vec()),
                DiffSource::Content(b"new".to_vec()),
                "file.txt",
            )
            .unwrap();
        let GitDiffResult::Text { unified_diff, .. } = result else {
            panic!("changed UTF-8 should produce text");
        };
        // The marker tells users the visible line ending is absent rather than hidden.
        assert!(unified_diff.contains("\\ No newline at end of file"));
    }

    /// Ensures formatter chunks cannot allocate beyond the control-response budget.
    #[test]
    fn limited_writer_rejects_output_over_its_limit() {
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            encoded: 0,
            limit: 3,
        };
        // Output up to the limit is retained normally.
        assert_eq!(writer.write(b"abc").unwrap(), 3);
        // The overflowing chunk is rejected without partially growing the response.
        assert_eq!(
            writer.write(b"d").unwrap_err().kind(),
            std::io::ErrorKind::FileTooLarge
        );
        assert_eq!(writer.bytes, b"abc");
    }

    /// Ensures escaped control characters count at their serialized size, so a patch full of
    /// them cannot fit the budget yet overflow the WebSocket frame once encoded.
    #[test]
    fn limited_writer_counts_json_escaping() {
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            encoded: 0,
            limit: 8,
        };
        // A newline encodes as two bytes and U+0001 as six, filling the limit exactly.
        assert_eq!(writer.write(b"\n\x01").unwrap(), 2);
        // One more raw byte would exceed the encoded limit even though only two are retained.
        assert!(writer.write(b"a").is_err());
        // The encoded measure matches what serde_json actually writes.
        let text = "\"\\\n\x01\x7f\u{e4}";
        assert_eq!(
            json_encoded_len(text.as_bytes()),
            serde_json::to_string(text).unwrap().len() - 2
        );
    }
}
