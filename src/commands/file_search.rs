use super::{CommandErrorKind, CommandResult, FileSearchEntry, FileSearchResponse};
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};
use std::{path::Path, time::Duration};

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
    if query.trim().is_empty() {
        return CommandResult::error(
            CommandErrorKind::InvalidInput,
            "File search query must not be empty",
        );
    }

    let mut matches = Vec::with_capacity(RESULT_LIMIT);
    let result = tokio::time::timeout(
        TIMEOUT,
        collect_matches(Path::new(&path), &query, &mut matches),
    )
    .await;

    let timed_out = match result {
        Ok(Ok(())) => false,
        Ok(Err(error)) => {
            return CommandResult::io_error("Failed to search directory", error);
        }
        Err(_) => true,
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
