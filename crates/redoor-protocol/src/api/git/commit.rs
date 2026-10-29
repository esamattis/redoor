//! Commit views: what one commit is and what it changed.

use super::{GitChangeState, GitDiffResult};
use crate::ids::UnixTimestampSeconds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The facts a revision banner (and later history rows) show about one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitCommitSummary {
    pub id: String,
    /// The first line of the message, which is what Git tools conventionally show.
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, because that is when the change was made rather than when it was rebased.
    pub authored_at: UnixTimestampSeconds,
    pub parent_ids: Vec<String>,
}

/// One file a commit changed below the requested path, with its bounded diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitCommitFileChange {
    /// The absolute worktree path, so the browser can link to the file at the commit.
    pub path: String,
    pub repository_relative_path: String,
    pub change: GitChangeState,
    pub result: GitDiffResult,
}

/// Shows what one commit changed below a path, compared with its first parent, or what a
/// range `A..B` of commits changed together, compared with A.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitCommitDiffResponse {
    /// The commit the revision names; for a range, its newer end B.
    pub commit: GitCommitSummary,
    /// The message after the summary line, empty when there is none. It lives here rather
    /// than in the summary because history lists repeat summaries and never show bodies.
    pub body: String,
    /// The compared commit: the first parent, or a range's start. Absent for a root commit
    /// or a range starting before one, whose files all count as added.
    pub parent_id: Option<String>,
    /// Set when the revision was a range, so the view can describe several commits instead
    /// of presenting the newest one's message as if it explained every change. Defaults to
    /// absent for agents that predate ranges.
    #[serde(default)]
    pub range: Option<GitCommitRange>,
    pub repository_root: String,
    pub repository_relative_path: String,
    pub files: Vec<GitCommitFileChange>,
    /// True when the commit changed more files than one response carries.
    pub truncated: bool,
}

/// The start of a revision range `A..B` a commit diff compared with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitCommitRange {
    /// The commit A names, absent when the range starts at the parent of a root commit and
    /// the diff starts from the empty tree.
    pub base: Option<GitCommitSummary>,
}
