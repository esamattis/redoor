//! The committed and staged text of one file, which the editor's Git gutter compares its
//! buffer with.
//!
//! The agent sends the texts rather than line ranges, so the browser can diff them against
//! the buffer itself and the gutter follows unsaved edits as they are typed. It is a request
//! of its own, made after the file is on screen, so opening a file never waits for Git.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Most JSON-encoded bytes the index and HEAD texts may take together. Each side is already
/// limited to the editor's 2 MiB, but escaping can grow control characters sixfold, and the
/// answer is one control frame.
pub const MAX_GIT_FILE_BASES_ENCODED_BYTES: usize = 8 * 1024 * 1024;

/// The texts a file's lines are compared with, or why the file has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(tag = "status", rename_all = "snake_case")]
pub enum GitFileBasesResponse {
    /// The file is not in a Git worktree. Not an error, because the editor may ask about a
    /// file whose repository went away since the page was loaded.
    OutsideWorktree,
    /// Git ignores the file, so there is no history to compare it with.
    Ignored,
    /// The index holds unresolved merge stages, so there is no single staged text.
    Conflicted,
    /// A committed or staged version is larger than the editor opens, or the pair would not
    /// fit in one reply.
    TooLarge,
    /// A version is not comparable line by line: binary, not UTF-8, a symlink or a submodule.
    Unsupported,
    /// The texts to compare with. A file Git does not track has neither, so all its lines
    /// count as new.
    Bases {
        /// The staged text, which unstaged changes are measured from. Absent when the index
        /// has no entry: the file is untracked or its removal is staged.
        index: Option<String>,
        /// The committed text, which staged changes are measured from.
        head: GitHeadBase,
    },
}

/// The committed side of the comparison. Usually nothing is staged, so the committed text
/// equals the staged one and is not sent a second time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitHeadBase {
    /// HEAD holds exactly the staged version (or neither has the file), so nothing is staged.
    SameAsIndex,
    /// HEAD does not have the file (a new file, or a branch without commits).
    Missing,
    /// HEAD holds other text than the index.
    Text { content: String },
}
