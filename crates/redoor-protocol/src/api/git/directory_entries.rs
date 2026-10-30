//! Git state of the entries of one browsed directory, for the file list's status column.
//!
//! Separate from the directory listing because a status walk can take far longer than reading
//! one directory: the list shows at once and the column fills in when the walk answers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::GitChangeState;

/// Most changed paths below one directory that are told apart for the per-directory counts.
/// The counts only explain the "contains changes" mark, so a huge untracked tree need not be
/// counted to the end; the mark itself stays correct past this bound.
pub const MAX_GIT_DIRECTORY_COUNTED_CHANGES: usize = 5_000;

/// The Git state of the entries in one directory, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(tag = "status", rename_all = "snake_case")]
pub enum GitDirectoryEntriesResponse {
    /// The directory is not in a Git worktree. Not an error, because the browser asks for any
    /// directory it shows and a plain directory simply has no Git state.
    OutsideWorktree,
    /// The status walk ran past the agent's time budget and was stopped, so a huge checkout
    /// leaves the column empty instead of holding agent resources indefinitely.
    TimedOut,
    /// Git ignores the directory itself, and with it every entry inside, so the agent answers
    /// without walking it.
    Ignored,
    /// The state of every entry that differs from a clean tracked file. Entries not listed
    /// are clean and tracked.
    Entries { entries: Vec<GitDirectoryEntry> },
}

/// The Git state of one direct child of the directory, keyed by its name in the listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDirectoryEntry {
    pub name: String,
    pub state: GitDirectoryEntryState,
}

/// What Git says about one entry. A directory is described by its own state when Git has one
/// for it as a whole (ignored, untracked, a changed submodule), otherwise by what it contains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitDirectoryEntryState {
    /// Matched by an ignore rule, so Git neither tracks it nor offers to add it.
    Ignored,
    /// Not tracked and not ignored: a new file, or a directory holding only new files.
    Untracked,
    /// The entry itself differs from HEAD in the index, the worktree, or both.
    Changed {
        /// HEAD compared with the index: what is staged.
        index_state: GitChangeState,
        /// The index compared with the worktree: what is not staged yet.
        worktree_state: GitChangeState,
        /// The index holds unresolved merge stages for it.
        conflicted: bool,
        /// The absolute path a staged rename or copy came from.
        original_path: Option<String>,
    },
    /// A directory whose descendants hold changes, so a change deep in the tree is visible
    /// from every directory above it. Ignored descendants are not counted.
    ContainsChanges(GitDirectoryChanges),
}

/// How many changed paths a directory contains, split like `git status` groups them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDirectoryChanges {
    /// The most severe kind of change inside, which the column shows.
    pub most_severe: GitDescendantChange,
    /// Tracked paths that differ from HEAD in the index or on disk, without conflicts.
    pub changed: u32,
    /// Untracked files, where a wholly untracked directory counts once like `git status`.
    pub untracked: u32,
    /// Paths with unresolved merge stages.
    pub conflicted: u32,
    /// True when the directory tree had more changes than were told apart, so the counts
    /// are lower bounds.
    pub truncated: bool,
}

/// The kinds of change a directory can contain, from the least to the most severe, so the
/// column can show the one that most needs attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitDescendantChange {
    Untracked,
    Changed,
    Conflicted,
}
