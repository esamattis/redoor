//! Ref views: the branches and tags of a repository, most recently committed first or by name.

use super::commit::GitCommitSummary;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Chooses which refs a listing reads. Branches and tags are separate lists because people
/// look for them separately, and one huge tag namespace should not push branches off a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitRefListKind {
    /// Local and remote-tracking branches.
    Branches,
    Tags,
}

/// Chooses the order of a ref listing. The agent sorts because pages are offsets into one
/// order, so the browser could not reorder a partially loaded list itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitRefSort {
    /// Newest commit first, so the refs people are working on lead the list.
    #[default]
    Recent,
    /// By name with digit runs compared as numbers, so `v1.10` follows `v1.9` and a known
    /// ref is easy to find in a long list.
    Name,
}

/// Chooses which branches a branch listing reads. Local branches are what people work on,
/// while a busy remote can hold hundreds of branches nobody has checked out, so the browser
/// lists them apart. Comparing picks from both, so the listing reads both unless asked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitBranchScope {
    /// Local and remote-tracking branches together.
    #[default]
    All,
    /// Only branches under `refs/heads/`.
    Local,
    /// Only remote-tracking branches under `refs/remotes/`.
    Remote,
}

/// Selects which branches a branch listing reads in the query string. Kept apart from the
/// order because tag listings have no scope.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct GitBranchScopeQuery {
    pub scope: Option<GitBranchScope>,
}

/// Selects the order of a ref listing in the query string, apart from the page so the page
/// query stays shared with the other Git lists.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct GitRefSortQuery {
    pub sort: Option<GitRefSort>,
}

/// Distinguishes where a ref lives, so the browser can mark remote and tag rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitRefKind {
    Branch,
    RemoteBranch,
    Tag,
}

/// One branch or tag with the commit it points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitRef {
    /// The short name people type, such as `main`, `origin/main` or `v1.0`.
    pub name: String,
    /// The full ref name, which links use as the revision because a short name can be
    /// ambiguous between a tag and a branch.
    pub full_name: String,
    pub kind: GitRefKind,
    /// True for the branch HEAD has checked out.
    pub is_head: bool,
    /// True for the repository's default branch, which leads the branch list in either order.
    pub is_default: bool,
    /// The commit the ref points at, with annotated tags peeled.
    pub commit: GitCommitSummary,
}

/// One page of a repository's branches or tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitRefListResponse {
    pub repository_root: String,
    /// In the requested order: most recently committed first by default, or by name. The
    /// default branch always comes first.
    pub refs: Vec<GitRef>,
    /// Every listable ref of this kind, so the browser can tell how many remain.
    pub total: usize,
    pub has_more: bool,
}
