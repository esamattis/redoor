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
    /// True when merging the sides of a symmetric range `A...B` conflicts at this path, so
    /// the view can label it: its diff then shows the conflict markers the merge left in the
    /// file. A flag rather than a change state, because the file is still added, modified or
    /// deleted compared with A, or unmodified when the merge kept A's version, which is
    /// listed only because it conflicts. Defaults to false for agents that predate merge
    /// previews.
    #[serde(default)]
    pub conflicted: bool,
    /// Why merging conflicts at this path, phrased by what each side did, such as a file the
    /// branch deletes but A changed. Such a conflict can resolve to A's version and leave
    /// nothing to diff, so the reason is all the view can show for it. Absent for files that
    /// do not conflict and from agents that predate it.
    #[serde(default)]
    pub conflict_reason: Option<String>,
}

/// Shows what one commit changed below a path, compared with its first parent, or what a
/// range `A..B` of commits changed together, compared with A.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitCommitDiffResponse {
    /// The commit the revision names; for a range, its newer end B. When B is the working
    /// tree (`:worktree`), HEAD, the commit the working tree's changes are on top of.
    pub commit: GitCommitSummary,
    /// The message after the summary line, empty when there is none. It lives here rather
    /// than in the summary because history lists repeat summaries and never show bodies.
    pub body: String,
    /// The compared commit: the first parent, or a range's start. For a symmetric range it is
    /// A when the diff is a merge preview, whose left side is A's tree, and the merge base
    /// when it fell back to that. Absent for a root commit or a range starting before one,
    /// whose files all count as added.
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

/// The start of a revision range `A..B` or `A...B` a commit diff compared with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitCommitRange {
    /// The commit A names, or for a symmetric range the merge base of A and B. Absent when
    /// the range starts at the parent of a root commit and the diff starts from the empty
    /// tree.
    pub base: Option<GitCommitSummary>,
    /// True for a symmetric range `A...B`, whose base is where B split from A rather than A
    /// itself, so the view can say the diff shows only what B added. Defaults to false for
    /// agents that predate symmetric ranges.
    #[serde(default)]
    pub merge_base: bool,
    /// True when a symmetric range was diffed as a merge preview: A's tree against an
    /// in-memory merge of B into A, so work A already has under other commit ids cancels out.
    /// False when the merge failed or ran out of time and the diff fell back to comparing
    /// the merge base with B, or with the working tree when B is `:worktree`, which the view
    /// mentions because squashed or cherry-picked work then shows up again. Always false for other ranges and for agents that predate merge
    /// previews, which only ever compared with the merge base.
    #[serde(default)]
    pub merge_preview: bool,
}
