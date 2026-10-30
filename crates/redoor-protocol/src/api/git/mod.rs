//! Git REST and wire bodies, one submodule per feature area so new Git features get their own
//! module instead of growing a single file. Vocabulary shared by several areas lives here.

pub mod commit;
pub mod directory_entries;
pub mod history;
pub mod refs;
pub mod revision;
pub mod worktree;
pub mod worktree_list;
pub mod worktree_status;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Rows a Git list returns when the request names no page size; the browser loads more on demand.
pub const DEFAULT_GIT_PAGE_SIZE: u32 = 100;
/// Largest page one request may ask for, so a reply stays a small control frame.
pub const MAX_GIT_PAGE_SIZE: u32 = 500;
/// Deepest page a request may start at. Ref listings keep `skip + limit` rows in memory to
/// sort them, so an unbounded offset would let one URL grow the agent's memory.
pub const MAX_GIT_PAGE_SKIP: u32 = 1_000_000;

/// Selects one page of a long Git list, carried in the query string so a browser can ask for
/// the next page with the same URL plus an offset.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct GitPageQuery {
    pub skip: Option<u32>,
    pub limit: Option<u32>,
}

/// A validated page: how many rows to pass over and how many to return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitPage {
    pub skip: u32,
    pub limit: u32,
}

impl GitPage {
    /// Fills in the defaults and rejects pages outside the bounds, so the REST boundary and the
    /// agent apply the same limits.
    pub fn new(skip: Option<u32>, limit: Option<u32>) -> Result<Self, &'static str> {
        let page = Self {
            skip: skip.unwrap_or(0),
            limit: limit.unwrap_or(DEFAULT_GIT_PAGE_SIZE),
        };
        page.validate()?;
        Ok(page)
    }

    /// Checks a page that arrived over the wire, which the agent must not trust blindly.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.limit == 0 || self.limit > MAX_GIT_PAGE_SIZE {
            return Err("Git page size must be between 1 and 500");
        }
        if self.skip > MAX_GIT_PAGE_SKIP {
            return Err("Git page offset is too large");
        }
        Ok(())
    }
}

/// Normalizes index and worktree status into a stable public vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum GitChangeState {
    Unmodified,
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

/// The largest patch sent with every unchanged line of its file. Whole files let the UI expand
/// context without another request, but past this size the rows cost more to send and render
/// than the context is worth, so the patch falls back to default context.
pub const MAX_FULL_CONTEXT_PATCH_BYTES: usize = 256 * 1024;

/// Represents every bounded single-file diff outcome explicitly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitDiffResult {
    Text {
        unified_diff: String,
        /// True when the patch holds every unchanged line of the file, so the UI can fold and
        /// expand context locally. Older agents omit it and their patches stay unexpandable.
        #[serde(default)]
        full_context: bool,
    },
    NoChanges,
    Untracked,
    Ignored,
    Binary,
    TooLarge,
    UnsupportedEntry,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keeps list requests bounded in both size and depth.
    #[test]
    fn git_page_applies_defaults_and_bounds() {
        // Omitted values fall back to the first page of the default size.
        assert_eq!(
            GitPage::new(None, None).unwrap(),
            GitPage {
                skip: 0,
                limit: DEFAULT_GIT_PAGE_SIZE
            }
        );
        // An empty page would make "load more" loop forever.
        assert!(GitPage::new(None, Some(0)).is_err());
        // Oversized pages would outgrow a control frame.
        assert!(GitPage::new(None, Some(MAX_GIT_PAGE_SIZE + 1)).is_err());
        // Deep offsets would let ref listings hold unbounded rows.
        assert!(GitPage::new(Some(MAX_GIT_PAGE_SKIP + 1), None).is_err());
    }
}
