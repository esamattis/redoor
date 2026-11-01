//! Structured log records and the relay protocol agents use to stream their logs to the server.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use ts_rs::TS;

/// Gives relay validation the same per-section diagnostic bound used by producers.
pub const LOG_DIAGNOSTIC_LIMIT: usize = 64 * 1_024;
/// Keeps one structured entry comfortably below the relay frame limit.
pub const LOG_MESSAGE_LIMIT: usize = 32 * 1_024;
/// Caps process-local browser replay at an exact, predictable memory bound.
pub const LOG_HISTORY_ENTRY_LIMIT: usize = 1_000;
/// Leaves framing headroom below the configured 256 KiB WebSocket message ceiling.
pub const MAX_LOG_EVENT_SIZE: usize = 240 * 1024;

/// Orders log records so callers can consistently filter and present process output.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Level {
    /// Includes highly detailed events intended for short diagnostic sessions.
    Trace,
    /// Includes developer-oriented state without enabling full trace volume.
    Debug,
    /// Includes normal lifecycle events useful to operators.
    Info,
    /// Includes recoverable conditions that may need operator attention.
    Warning,
    /// Includes failures that prevented an operation from completing.
    Error,
}

impl Level {
    /// Short uppercase label used in human-readable line output.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warning => "WARN",
            Self::Error => "ERROR",
        }
    }

    /// Converts the compact atomic representation back to the canonical level.
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Trace,
            1 => Self::Debug,
            2 => Self::Info,
            3 => Self::Warning,
            4 => Self::Error,
            _ => Self::Info,
        }
    }
}

impl Default for Level {
    /// Keeps normal lifecycle output enabled unless another source overrides it.
    fn default() -> Self {
        Self::Info
    }
}

impl std::str::FromStr for Level {
    type Err = String;

    /// Accepts human startup spelling while retaining one API vocabulary.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "trace" => Ok(Self::Trace),
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" | "warning" => Ok(Self::Warning),
            "error" => Ok(Self::Error),
            _ => {
                Err("logging level must be one of: trace, debug, info, warning, error".to_string())
            }
        }
    }
}

impl std::fmt::Display for Level {
    /// Uses the lowercase spelling accepted by TOML, CLI, env, and REST.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        })
    }
}

/// Retains diagnostics separately so viewers can disclose them on demand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogErrorDetails {
    /// Contains the anyhow context/source sequence, subject to a visible bound.
    pub chain: String,
    /// Contains a captured backtrace when runtime capture is enabled.
    pub backtrace: Option<String>,
}

/// Represents one record identically across replay, live events, and JSON output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogEntry {
    /// Uses RFC 3339 milliseconds and an explicit offset for unambiguous ordering.
    pub timestamp: String,
    pub level: Level,
    /// Excludes rendered timestamp and severity prefixes.
    pub message: String,
    /// Exists only for failures sent through the dedicated error logger.
    pub error: Option<LogErrorDetails>,
    /// The signed-in user whose request wrote the record, such as `alice (password)`; absent
    /// for background work, so operators can tell who did what on a shared account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user: Option<String>,
}

impl LogEntry {
    /// Captures time before enqueueing so output backlog does not alter event chronology.
    pub fn new(level: Level, message: String, error: Option<LogErrorDetails>) -> Self {
        Self {
            timestamp: jiff::Zoned::now()
                .strftime("%Y-%m-%dT%H:%M:%S%.3f%:z")
                .to_string(),
            level,
            message,
            error,
            user: None,
        }
    }

    /// Preserves the established human-readable line format for existing consumers; a
    /// record written for a signed-in user gets a `[user=...]` field before the message.
    pub fn render_line(&self) -> String {
        let timestamp = jiff::Zoned::strptime("%Y-%m-%dT%H:%M:%S%.f%:z", &self.timestamp)
            .expect("logger-created timestamps must remain valid RFC 3339 values")
            .strftime("%Y-%m-%d %H:%M:%S%.3f");
        match &self.user {
            Some(user) => format!(
                "[{timestamp}] [{}] [user={user}] {}",
                self.level.as_str(),
                self.message
            ),
            None => format!("[{timestamp}] [{}] {}", self.level.as_str(), self.message),
        }
    }
}

/// Carries bounded history and live updates for either server or agent logs.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum LogEvent {
    /// Replaces the browser rolling window at an exact history/live boundary.
    Snapshot {
        /// Preserves chronological source order so the newest retained entry renders last.
        entries: Vec<LogEntry>,
        /// Explains whether persistent history was available without exposing a file path.
        file_logging_enabled: bool,
    },
    /// Appends one logger record accepted after the snapshot boundary.
    Entry {
        /// Remains structured regardless of the process output sink format.
        entry: LogEntry,
    },
    /// Forces a fresh snapshot because bounded live delivery dropped records.
    Lagged {
        /// Quantifies missed records while remaining safe for JavaScript consumers.
        #[ts(type = "number")]
        skipped: u64,
    },
    /// Reports a safe setup or history failure without exposing filesystem details.
    Error {
        /// Gives the operator an actionable generic reason while details remain process-local.
        message: String,
    },
}

impl LogEvent {
    /// Retains the newest complete records that fit in one relay-safe snapshot frame.
    pub fn bounded_snapshot(entries: Vec<LogEntry>, file_logging_enabled: bool) -> Self {
        let empty = Self::Snapshot {
            entries: Vec::new(),
            file_logging_enabled,
        };
        let base_size = serde_json::to_vec(&empty)
            .expect("an owned empty log snapshot must serialize")
            .len();
        let mut retained = VecDeque::new();
        let mut encoded_size = base_size;
        for entry in entries.into_iter().rev() {
            let entry_size = serde_json::to_vec(&entry)
                .expect("an owned structured log entry must serialize")
                .len();
            let separator_size = usize::from(!retained.is_empty());
            if encoded_size + separator_size + entry_size > MAX_LOG_EVENT_SIZE {
                break;
            }
            encoded_size += separator_size + entry_size;
            retained.push_front(entry);
        }
        Self::Snapshot {
            entries: retained.into(),
            file_logging_enabled,
        }
    }

    /// Rejects malformed matched-version agent records before relaying them to browsers.
    pub fn diagnostics_are_bounded(&self) -> bool {
        let valid_entry = |entry: &LogEntry| {
            entry.message.len() <= LOG_MESSAGE_LIMIT
                && entry
                    .user
                    .as_ref()
                    .is_none_or(|user| user.len() <= LOG_MESSAGE_LIMIT)
                && entry.error.as_ref().is_none_or(|details| {
                    details.chain.len() <= LOG_DIAGNOSTIC_LIMIT
                        && details
                            .backtrace
                            .as_ref()
                            .is_none_or(|backtrace| backtrace.len() <= LOG_DIAGNOSTIC_LIMIT)
                })
        };
        let fields_are_bounded = match self {
            Self::Snapshot { entries, .. } => {
                entries.len() <= LOG_HISTORY_ENTRY_LIMIT && entries.iter().all(valid_entry)
            }
            Self::Entry { entry } => valid_entry(entry),
            Self::Lagged { .. } | Self::Error { .. } => true,
        };
        fields_are_bounded
            && serde_json::to_vec(self).is_ok_and(|encoded| encoded.len() <= MAX_LOG_EVENT_SIZE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a deterministic structured record for protocol shape assertions.
    fn entry(message: &str) -> LogEntry {
        LogEntry {
            timestamp: "2026-08-27T12:34:56.789+03:00".to_string(),
            level: Level::Info,
            message: message.to_string(),
            error: None,
            user: None,
        }
    }

    /// A record of a signed-in user names them in both renderings, and records without one
    /// keep the established shapes.
    #[test]
    fn user_field_is_rendered_only_when_present() {
        let plain = entry("ready");
        // Records without a user keep the line and JSON shapes existing consumers parse.
        assert_eq!(
            plain.render_line(),
            "[2026-08-27 12:34:56.789] [INFO] ready"
        );
        assert!(serde_json::to_value(&plain).unwrap().get("user").is_none());
        let with_user = LogEntry {
            user: Some("alice (password)".to_string()),
            ..entry("ready")
        };
        // The line format puts the user before the message.
        assert_eq!(
            with_user.render_line(),
            "[2026-08-27 12:34:56.789] [INFO] [user=alice (password)] ready"
        );
        // JSON carries it as its own field.
        assert_eq!(
            serde_json::to_value(&with_user).unwrap()["user"],
            "alice (password)"
        );
    }

    /// Locks the browser protocol tags and field names to stable JSON shapes.
    #[test]
    fn serializes_log_events_with_stable_tagged_shapes() {
        let snapshot = serde_json::to_value(LogEvent::Snapshot {
            entries: vec![entry("first")],
            file_logging_enabled: true,
        })
        .expect("snapshot should serialize");
        // Snapshot replacement depends on this exact tagged field shape in the shared viewer.
        assert_eq!(
            snapshot,
            serde_json::json!({"type":"snapshot","entries":[{"timestamp":"2026-08-27T12:34:56.789+03:00","level":"info","message":"first","error":null}],"file_logging_enabled":true})
        );

        let entry = serde_json::to_value(LogEvent::Entry {
            entry: entry("next"),
        })
        .expect("entry should serialize");
        // Live appends must remain distinguishable from replacement snapshots.
        assert_eq!(
            entry,
            serde_json::json!({"type":"entry","entry":{"timestamp":"2026-08-27T12:34:56.789+03:00","level":"info","message":"next","error":null}})
        );

        let lagged =
            serde_json::to_value(LogEvent::Lagged { skipped: 7 }).expect("lagged should serialize");
        // Lag notifications carry the dropped count so clients know a fresh snapshot is required.
        assert_eq!(lagged, serde_json::json!({"type":"lagged","skipped":7}));

        let error = serde_json::to_value(LogEvent::Error {
            message: "unavailable".to_string(),
        })
        .expect("error should serialize");
        // Safe setup failures need a typed shape without raw internal error details.
        assert_eq!(
            error,
            serde_json::json!({"type":"error","message":"unavailable"})
        );
    }

    /// Keeps large histories below the relay limit while retaining their newest records.
    #[test]
    fn snapshot_is_bounded_to_one_websocket_message() {
        let entries = (0..1_000)
            .map(|index| entry(&format!("record-{index}-{}", "x".repeat(1_024))))
            .collect();
        let snapshot = LogEvent::bounded_snapshot(entries, true);
        let encoded = serde_json::to_vec(&snapshot).expect("snapshot should serialize");
        // Dedicated agent sockets reject larger frames, so every emitted snapshot needs headroom.
        assert!(encoded.len() <= MAX_LOG_EVENT_SIZE);
        let LogEvent::Snapshot { entries, .. } = snapshot else {
            panic!("constructor must return a snapshot");
        };
        let expected_latest = format!("record-999-{}", "x".repeat(1_024));
        // Truncation evicts old history rather than losing the latest process record.
        assert_eq!(
            entries.last().map(|entry| entry.message.as_str()),
            Some(expected_latest.as_str())
        );
    }
}
