//! Revision views: directories and files as they were committed at a user-supplied revision.

use super::commit::GitCommitSummary;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Longest revision text accepted, so a URL parameter cannot make the agent parse unbounded input.
pub const MAX_REVISION_LENGTH: usize = 256;

/// Names the working tree as the right side of a range, such as `origin/main...:worktree`:
/// every staged, unstaged and untracked-but-not-ignored file as `git add -A` would commit it.
///
/// It lives in the revision text rather than in a separate parameter so ranges keep flowing
/// through URLs, pickers and caches as one string. A ref name cannot contain `:`, and in Git's
/// own syntax `:path` names an index blob, never a commit, so no revision that names a commit
/// can ever be spelled this way.
pub const WORKTREE_REVISION: &str = ":worktree";

/// Rejects revision text before it reaches the agent's revision parser.
///
/// Control characters are refused because revisions are echoed into logs and error messages,
/// and an empty revision would silently mean HEAD to some parsers.
pub fn validate_revision(revision: &str) -> Result<(), &'static str> {
    if revision.is_empty() {
        return Err("Git revision must not be empty");
    }
    if revision.len() > MAX_REVISION_LENGTH {
        return Err("Git revision is too long");
    }
    if revision.chars().any(char::is_control) {
        return Err("Git revision must not contain control characters");
    }
    Ok(())
}

/// Selects the revision an endpoint reads, carried in the query string so browser URLs and
/// REST URLs name the revision the same way.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRevisionQuery {
    pub rev: String,
}

/// Names the kind of a tree entry without leaking Git mode numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitTreeEntryKind {
    File,
    Executable,
    Symlink,
    Directory,
    Submodule,
}

/// One child of a directory at a revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitTreeEntry {
    pub name: String,
    pub kind: GitTreeEntryKind,
    /// Blob size for files and symlinks; directories and submodules have no size of their own.
    #[ts(type = "number | null")]
    pub size: Option<u64>,
}

/// What a path is at a revision, with the details each kind of entry can show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitRevisionEntry {
    Directory {
        entries: Vec<GitTreeEntry>,
        /// True when the directory had more entries than one response carries.
        truncated: bool,
        /// Entries skipped because their names are not UTF-8 and cannot be linked.
        omitted_non_utf8_entries: usize,
    },
    File {
        #[ts(type = "number")]
        size: u64,
        executable: bool,
        /// True only when the blob is small enough and valid UTF-8, matching the editor's gate.
        editable: bool,
        blob_id: String,
    },
    Symlink {
        target: String,
    },
    Submodule {
        commit_id: String,
    },
}

/// Describes one path at a revision, so the browser can list or open it without the worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitRevisionTreeResponse {
    /// The revision text as requested, so a branch name stays a branch name in the UI.
    pub rev: String,
    pub commit: GitCommitSummary,
    pub repository_root: String,
    pub path: String,
    pub repository_relative_path: String,
    pub entry: GitRevisionEntry,
}

/// Returns a committed text file for the read-only editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitRevisionContentResponse {
    pub path: String,
    pub commit_id: String,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keeps hostile or meaningless revision text away from the agent's parser.
    #[test]
    fn revision_validation_rejects_empty_long_and_control_text() {
        // Branches, tags and ids are ordinary revisions.
        assert!(validate_revision("main").is_ok());
        assert!(validate_revision("v1.0^{commit}").is_ok());
        // Empty text would be ambiguous with HEAD.
        assert!(validate_revision("").is_err());
        // Overlong text is rejected before parsing.
        assert!(validate_revision(&"a".repeat(MAX_REVISION_LENGTH + 1)).is_err());
        // Control characters could forge log lines.
        assert!(validate_revision("main\nfake").is_err());
    }
}
