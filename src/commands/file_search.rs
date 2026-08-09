use super::{CommandErrorKind, CommandResult, FileSearchEntry, FileSearchResponse};
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};
use std::{path::Path, time::Duration};
use tokio::sync::watch;

/// Prevents one broad or slow filesystem search from occupying an agent indefinitely.
const TIMEOUT: Duration = Duration::from_secs(3);
/// Bounds both response size and memory retained while traversing a large tree.
const RESULT_LIMIT: usize = 100;

/// Retains the matcher score internally so the agent can rank a bounded result set.
#[derive(Debug)]
struct RankedEntry {
    entry: FileSearchEntry,
    score: u32,
}

/// Traverses incrementally so timeout returns useful partial results without retaining the tree.
pub(super) async fn execute(path: String, query: String) -> CommandResult {
    let (_cancel_sender, cancel_receiver) = watch::channel(false);
    execute_with_cancellation(path, query, cancel_receiver).await
}

/// Preserves partial matches when a newer search supersedes this traversal.
pub(super) async fn execute_with_cancellation(
    path: String,
    query: String,
    mut cancel_receiver: watch::Receiver<bool>,
) -> CommandResult {
    if query.trim().is_empty() {
        return CommandResult::error(
            CommandErrorKind::InvalidInput,
            "File search query must not be empty",
        );
    }

    let mut matches = Vec::with_capacity(RESULT_LIMIT);
    let result = {
        let traversal = collect_matches(Path::new(&path), &query, &mut matches);
        tokio::pin!(traversal);
        let timeout = tokio::time::sleep(TIMEOUT);
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies superseded searches still return a terminal response to their original caller.
    #[tokio::test]
    async fn canceled_search_returns_empty_partial_response() {
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        // Pre-canceling makes this deterministic without sleeping or constructing a large tree.
        cancel_sender.send(true).expect("receiver remains active");

        let result = execute_with_cancellation(
            "/path-that-does-not-need-to-exist".to_string(),
            "query".to_string(),
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
    }
}

/// Walks depth-first with one open directory per depth so broad trees do not become an in-memory plan.
async fn collect_matches(
    root: &Path,
    query: &str,
    matches: &mut Vec<RankedEntry>,
) -> std::io::Result<()> {
    let pattern = Pattern::new(
        query,
        CaseMatching::Smart,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut utf32_buffer = Vec::new();
    let mut directories = vec![tokio::fs::read_dir(root).await?];

    while let Some(directory) = directories.last_mut() {
        let entry = match directory.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) | Err(_) => {
                directories.pop();
                continue;
            }
        };
        let entry_path = entry.path();
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };

        if let Some(relative_path) = entry_path.strip_prefix(root).ok().and_then(Path::to_str) {
            let haystack = Utf32Str::new(relative_path, &mut utf32_buffer);
            if let Some(score) = pattern.score(haystack, &mut matcher) {
                retain_match(
                    matches,
                    RankedEntry {
                        entry: FileSearchEntry {
                            name: entry.file_name().to_string_lossy().into_owned(),
                            path: entry_path.to_string_lossy().into_owned(),
                            file_type: if file_type.is_dir() {
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

        // `DirEntry::file_type` does not follow symlinks, avoiding cycles and root escapes.
        if file_type.is_dir()
            && let Ok(child_directory) = tokio::fs::read_dir(&entry_path).await
        {
            directories.push(child_directory);
        }
    }

    Ok(())
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
