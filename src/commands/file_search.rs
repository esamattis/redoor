use super::{CommandErrorKind, CommandResult, FileSearchEntry, FileSearchResponse};
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};
use std::{collections::HashSet, os::unix::fs::MetadataExt, path::Path, time::Duration};
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
}

/// Uses filesystem identity rather than path spelling because multiple symlinks can reach one directory.
fn directory_identity(metadata: &std::fs::Metadata) -> DirectoryIdentity {
    DirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
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
        )
        .await;

        tokio::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700))
            .await
            .expect("test directory permissions should be restored");
        tokio::fs::remove_dir_all(&root)
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
        )
        .await;

        tokio::fs::remove_dir_all(&root)
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
        )
        .await;

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("search root should be removed");
        tokio::fs::remove_dir_all(&external)
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

        if let Ok(relative_path) = entry_path.strip_prefix(root) {
            let relative_path = relative_path.to_string_lossy();
            let haystack = Utf32Str::new(&relative_path, &mut utf32_buffer);
            if let Some(score) = pattern.score(haystack, &mut matcher) {
                retain_match(
                    matches,
                    RankedEntry {
                        entry: FileSearchEntry {
                            name: entry.file_name().to_string_lossy().into_owned(),
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
            });
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
