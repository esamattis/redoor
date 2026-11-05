//! Filename and content search bodies shared by REST and the agent protocol.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use ts_rs::TS;

/// Bounds per-match context so the fixed result ceiling also bounds response memory.
pub const MAX_GREP_CONTEXT_LINES: u64 = 20;
/// Most paths a path search returns. The agent keeps this many while it walks and the server
/// keeps the same number of streamed matches, so both end with the same list.
pub const FILE_SEARCH_RESULT_LIMIT: usize = 100;

/// Controls how letter case affects path and content search matching.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum CaseSensitivity {
    /// Uses case-insensitive matching until the query contains an uppercase letter.
    #[default]
    Smart,
    /// Requires query and candidate letter case to match exactly.
    Sensitive,
    /// Ignores letter case regardless of the query's capitalization.
    Insensitive,
}

/// Search deadline REST callers get when they do not choose one.
fn default_file_search_timeout_seconds() -> u64 {
    5
}

/// Default for REST search options that are on unless a caller turns them off.
fn default_true() -> bool {
    true
}

/// Describes one matching remote path without requiring additional metadata calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileSearchEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String,
    /// Fuzzy match score, higher is better. Streamed matches arrive in walk order, so clients
    /// need the score to rank them the way the agent does.
    pub score: u32,
}

impl FileSearchEntry {
    /// Orders better matches first: higher score, then path, so equal scores still rank the
    /// same way on the agent, the server and in the browser.
    pub fn rank(&self, other: &Self) -> Ordering {
        other
            .score
            .cmp(&self.score)
            .then_with(|| self.path.cmp(&other.path))
    }
}

/// The best [`FILE_SEARCH_RESULT_LIMIT`] path matches seen so far, best first.
///
/// The agent uses it to decide which matches to stream and the server to rebuild the final
/// list from the stream. Sharing it keeps both ends on the same ranking, so the streamed
/// matches reduce to exactly the agent's own top list.
#[derive(Debug, Default)]
pub struct FileSearchRanking {
    entries: Vec<FileSearchEntry>,
}

impl FileSearchRanking {
    /// Keeps the candidate if it ranks among the best and returns it, so the caller can
    /// forward exactly the matches that changed the list.
    pub fn offer(&mut self, candidate: FileSearchEntry) -> Option<&FileSearchEntry> {
        let position = self
            .entries
            .partition_point(|entry| entry.rank(&candidate).is_le());
        if position >= FILE_SEARCH_RESULT_LIMIT {
            return None;
        }
        self.entries.insert(position, candidate);
        self.entries.truncate(FILE_SEARCH_RESULT_LIMIT);
        self.entries.get(position)
    }

    /// The retained matches, best first.
    pub fn into_entries(self) -> Vec<FileSearchEntry> {
        self.entries
    }
}

/// One line of a streamed path search.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum FileSearchEvent {
    /// A path that entered the agent's current top list. Later matches may push it out, so
    /// clients keep only the best [`FILE_SEARCH_RESULT_LIMIT`].
    Match { entry: FileSearchEntry },
    /// The last line: the walk ended, by itself or at its deadline.
    Done {
        timed_out: bool,
        #[ts(type = "number")]
        duration_ms: u64,
    },
}

/// Carries bounded filename-search controls while the route identifies the agent and root path.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FindRequest {
    pub query: String,
    #[serde(default = "default_file_search_timeout_seconds")]
    #[ts(type = "number")]
    pub timeout: u64,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default = "default_true")]
    pub respect_gitignore: bool,
    #[serde(default)]
    pub case_sensitivity: CaseSensitivity,
    /// Skips files on the agent, so the result limit is spent on directories when only a
    /// folder is wanted, for example to pick a narrower search scope.
    #[serde(default)]
    pub directories_only: bool,
}

/// Returns the best paths discovered before traversal completed or reached its deadline.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileSearchResponse {
    pub results: Vec<FileSearchEntry>,
    pub timed_out: bool,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

/// Identifies one bounded context line adjacent to a grep match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ContentGrepContextLine {
    #[ts(type = "number")]
    pub line_number: u64,
    pub line: String,
    pub line_truncated: bool,
}

/// Identifies one matching physical line and its independently retained context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ContentGrepMatch {
    pub path: String,
    #[ts(type = "number")]
    pub line_number: u64,
    pub line: String,
    pub line_truncated: bool,
    pub before_context: Vec<ContentGrepContextLine>,
    pub after_context: Vec<ContentGrepContextLine>,
}

/// Carries bounded content-search controls while the route identifies the agent and root path.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GrepRequest {
    pub query: String,
    #[serde(default = "default_file_search_timeout_seconds")]
    #[ts(type = "number")]
    pub timeout: u64,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default = "default_true")]
    pub respect_gitignore: bool,
    #[serde(default)]
    pub fixed_string: bool,
    #[serde(default)]
    pub case_sensitivity: CaseSensitivity,
    #[serde(default)]
    #[ts(type = "number")]
    pub before_context: u64,
    #[serde(default)]
    #[ts(type = "number")]
    pub after_context: u64,
}

/// Returns matches completed before the grep deadline or supersession signal.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ContentGrepResponse {
    pub results: Vec<ContentGrepMatch>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
    #[ts(type = "number")]
    pub omitted_long_lines: u64,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

/// One line of a streamed content search.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ContentGrepEvent {
    /// One matching line, sent as soon as its file is known to be text.
    Match { entry: ContentGrepMatch },
    /// The last line, with the summary the whole search shares.
    Done {
        timed_out: bool,
        cancelled: bool,
        truncated: bool,
        #[ts(type = "number")]
        omitted_long_lines: u64,
        #[ts(type = "number")]
        duration_ms: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an entry whose path doubles as its name.
    fn entry(path: &str, score: u32) -> FileSearchEntry {
        FileSearchEntry {
            name: path.to_string(),
            path: path.to_string(),
            file_type: "file".to_string(),
            score,
        }
    }

    /// Verifies the ranking keeps the best entries in rank order and reports only entries
    /// that entered, which is what decides whether the agent streams a match.
    #[test]
    fn ranking_keeps_the_best_entries_in_order() {
        let mut ranking = FileSearchRanking::default();
        for index in 0..FILE_SEARCH_RESULT_LIMIT {
            // Every entry enters while the list has room.
            assert!(ranking.offer(entry(&format!("/f{index:03}"), 10)).is_some());
        }
        // A worse score cannot enter a full list.
        assert!(ranking.offer(entry("/worse", 9)).is_none());
        // An equal score with a later path ranks below every kept entry.
        assert!(ranking.offer(entry("/zzz", 10)).is_none());
        // A better score enters and is returned for streaming.
        assert_eq!(
            ranking
                .offer(entry("/better", 11))
                .map(|kept| kept.path.clone()),
            Some("/better".to_string())
        );
        let entries = ranking.into_entries();
        // The list stays at its limit, best first, and the weakest entry fell out.
        assert_eq!(entries.len(), FILE_SEARCH_RESULT_LIMIT);
        assert_eq!(entries[0].path, "/better");
        assert_eq!(entries.last().map(|last| last.path.as_str()), Some("/f098"));
    }
}
