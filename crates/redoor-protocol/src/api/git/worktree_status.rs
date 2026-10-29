//! Worktree status summary: how much uncommitted work the checkouts of a worktree list hold.
//!
//! Separate from the worktree list because counting changes walks the whole checkout, while
//! the list only reads each checkout's HEAD. The browser shows the list at once and asks for
//! the rows it shows in one request, so a long list does not take every browser connection.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::worktree_list::MAX_GIT_WORKTREES;

/// Most changed paths counted per worktree. The counts only tell a dirty checkout from a
/// clean one at a glance, so a huge untracked directory need not be counted to the end.
pub const MAX_GIT_WORKTREE_CHANGES: usize = 1_000;

/// Selects the checkouts to count, in the body so long paths stay out of the URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitWorktreeStatusRequest {
    /// Absolute paths inside the checkouts to count, in the order they should be walked.
    pub paths: Vec<String>,
}

impl GitWorktreeStatusRequest {
    /// Every row the worktree list can show: the main checkout and the linked ones.
    pub const MAX_PATHS: usize = MAX_GIT_WORKTREES + 1;

    /// Keeps first-occurrence order, so the rows asked for first are walked first, and drops
    /// repeated paths so one request cannot walk the same checkout many times.
    pub fn normalize_paths(&mut self) -> Result<(), String> {
        let mut seen = HashSet::new();
        let mut paths = Vec::new();
        for path in std::mem::take(&mut self.paths) {
            if seen.insert(path.clone()) {
                if paths.len() == Self::MAX_PATHS {
                    return Err(format!(
                        "Git worktree status requests support at most {} distinct paths",
                        Self::MAX_PATHS
                    ));
                }
                paths.push(path);
            }
        }
        if paths.is_empty() {
            return Err("Git worktree status requests need at least one path".to_string());
        }
        self.paths = paths;
        Ok(())
    }
}

/// The checkouts the agent counted before its time budget ran out. A requested path missing
/// from `statuses` was not reached and can be asked for again; the agent always answers with
/// at least one, so asking again for the rest always makes progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitWorktreeStatusResponse {
    /// One entry per counted path, in the order the walks finished.
    pub statuses: Vec<GitWorktreeStatusEntry>,
}

/// The outcome for one requested path, keyed by the path as it was requested so the browser
/// can match it to its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitWorktreeStatusEntry {
    pub path: String,
    pub result: GitWorktreeStatusResult,
}

/// Counts or a failure per path, so one unreadable checkout does not hide the counts of the
/// others in the same request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitWorktreeStatusResult {
    Counted(GitWorktreeChanges),
    Failed { message: String },
}

/// How many uncommitted paths a checkout has, split the way people decide what to do next:
/// tracked edits to commit or stash, and new files that `git stash` would leave behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitWorktreeChanges {
    /// Tracked paths that differ from HEAD in the index or on disk, including conflicts.
    pub changed: u32,
    /// Files Git does not track and does not ignore.
    pub untracked: u32,
    /// True when the checkout had more changed paths than were counted, so the counts are
    /// lower bounds.
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a request for the given paths.
    fn request(paths: &[&str]) -> GitWorktreeStatusRequest {
        GitWorktreeStatusRequest {
            paths: paths.iter().map(ToString::to_string).collect(),
        }
    }

    /// Repeated rows collapse to their first occurrence, keeping the walk order.
    #[test]
    fn normalize_drops_repeated_paths_in_order() {
        let mut request = request(&["/b", "/a", "/b"]);
        request.normalize_paths().unwrap();
        assert_eq!(request.paths, ["/b", "/a"]);
    }

    /// A request asks about at least one and at most every listable checkout.
    #[test]
    fn normalize_bounds_the_path_count() {
        assert!(request(&[]).normalize_paths().is_err());
        let paths: Vec<String> = (0..=GitWorktreeStatusRequest::MAX_PATHS)
            .map(|index| format!("/w{index}"))
            .collect();
        let mut too_many = GitWorktreeStatusRequest { paths };
        assert!(too_many.normalize_paths().is_err());
    }
}
