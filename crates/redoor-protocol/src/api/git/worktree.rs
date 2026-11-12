//! Worktree views: repository context, status and diffs of uncommitted changes.

use super::{GitChangeState, GitDiffResult};
use crate::ids::UnixTimestampSeconds;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Distinguishes filesystem shapes without exposing platform metadata details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitEntryType {
    File,
    Directory,
    Symlink,
    Missing,
    Other,
}

/// Describes whether a browser file participates in repository tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitTrackingState {
    Tracked,
    Untracked,
    Ignored,
    Deleted,
}

/// Prevents repository-only context from being represented for paths outside a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(tag = "status", rename_all = "snake_case")]
pub enum GitContextResponse {
    /// Reports Git-tab unavailability without duplicating general filesystem metadata.
    OutsideWorktree,
    /// Provides classification and repository paths only when repository discovery succeeded.
    InsideWorktree {
        entry_type: GitEntryType,
        tracking_state: Option<GitTrackingState>,
        repository_root: String,
        repository_relative_path: String,
        /// The checked-out branch, absent for a detached HEAD, so every Git page can name it
        /// without a full status walk.
        branch_name: Option<String>,
        /// The commit HEAD points at, absent while the branch has no commits yet.
        head_commit_id: Option<String>,
        /// The remote-tracking branch the default remote's `HEAD` names, such as
        /// `refs/remotes/origin/main`, which the Git view compares the checkout with. Absent
        /// when the repository has no remote `HEAD`. Defaults to absent for agents that
        /// predate the comparison.
        #[serde(default)]
        default_remote_branch: Option<GitDefaultRemoteBranch>,
    },
}

/// The branch a project treats as its main line, as last fetched from the default remote.
///
/// It is the remote-tracking branch rather than the local branch of the same name, because
/// local `main` is often behind (never pulled while work happens in other branches) or ahead
/// (unpushed commits), and either would hide or add changes in a "what does my branch bring"
/// comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDefaultRemoteBranch {
    /// The full ref name, such as `refs/remotes/origin/main`, so a revision link to it can
    /// never resolve to a local branch or tag of the same short name.
    pub full_name: String,
    /// The commit the branch points at, so the view can tell when HEAD is that commit and
    /// there is nothing to compare.
    pub commit_id: String,
    /// When the repository last fetched, as far as the files a fetch writes tell, because the
    /// branch is only as fresh as that. Absent when no such file records it.
    pub fetched_at: Option<UnixTimestampSeconds>,
}

/// Identifies entries that cannot be represented by ordinary staged/unstaged states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitConflictState {
    Conflicted,
}

/// Identifies the Git object kind without leaking gix mode values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitStatusEntryKind {
    File,
    Symlink,
    Submodule,
    Other,
}

/// Describes one changed path from the merged HEAD/index/worktree view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitStatusEntry {
    pub path: String,
    pub repository_relative_path: String,
    pub original_path: Option<String>,
    pub index_state: GitChangeState,
    pub worktree_state: GitChangeState,
    pub conflict_state: Option<GitConflictState>,
    pub entry_kind: GitStatusEntryKind,
}

/// Returns bounded, deterministic status for one literal directory prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitStatusResponse {
    pub path: String,
    pub repository_root: String,
    pub branch_name: Option<String>,
    pub detached_head_id: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub entries: Vec<GitStatusEntry>,
    pub truncated: bool,
    pub omitted_non_utf8_entries: usize,
}

/// Selects the source on the right side of a comparison with HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitDiffMode {
    Full,
    Staged,
}

/// Selects ordered files and the source compared with HEAD without exposing paths in the URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDiffRequest {
    pub files: Vec<String>,
    pub mode: GitDiffMode,
}

impl GitDiffRequest {
    /// Bounds batch work and response metadata even when no file produces a text patch.
    pub const MAX_FILES: usize = 128;

    /// Keeps first-occurrence order while preventing repeated paths from amplifying work.
    pub fn normalize_files(&mut self) -> Result<(), &'static str> {
        let mut seen = std::collections::HashSet::new();
        let mut files = Vec::new();
        for path in std::mem::take(&mut self.files) {
            if seen.insert(path.clone()) {
                if files.len() == Self::MAX_FILES {
                    return Err("Git diff requests support at most 128 distinct files");
                }
                files.push(path);
            }
        }
        self.files = files;
        Ok(())
    }
}

/// Carries one file's bounded comparison in the same order as the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitFileDiff {
    pub path: String,
    pub result: GitDiffResult,
}

/// Returns ordered per-file Git comparisons without merging their patch payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDiffResponse {
    pub diffs: Vec<GitFileDiff>,
}
