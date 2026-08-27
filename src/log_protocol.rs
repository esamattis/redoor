use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use ts_rs::TS;
use uuid::Uuid;

use crate::logging::LogEntry;

/// Leaves framing headroom below the configured 256 KiB WebSocket message ceiling.
pub const MAX_LOG_EVENT_SIZE: usize = 240 * 1024;

/// Identifies one browser-owned agent log tunnel until both sockets are released.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LogStreamId(pub Uuid);

impl LogStreamId {
    /// Creates an unpredictable rendezvous id so pending stream URLs cannot be enumerated.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for LogStreamId {
    /// Generates a fresh identifier rather than a reusable nil UUID.
    fn default() -> Self {
        Self::new()
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
            entry.message.len() <= crate::logging::LOG_MESSAGE_LIMIT
                && entry.error.as_ref().is_none_or(|details| {
                    details.chain.len() <= crate::logging::LOG_DIAGNOSTIC_LIMIT
                        && details.backtrace.as_ref().is_none_or(|backtrace| {
                            backtrace.len() <= crate::logging::LOG_DIAGNOSTIC_LIMIT
                        })
                })
        };
        let fields_are_bounded = match self {
            Self::Snapshot { entries, .. } => {
                entries.len() <= crate::logging::LOG_HISTORY_ENTRY_LIMIT
                    && entries.iter().all(valid_entry)
            }
            Self::Entry { entry } => valid_entry(entry),
            Self::Lagged { .. } | Self::Error { .. } => true,
        };
        fields_are_bounded
            && serde_json::to_vec(self).is_ok_and(|encoded| encoded.len() <= MAX_LOG_EVENT_SIZE)
    }
}

/// First dedicated-agent frame proving possession of the bootstrap secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LogAgentHandshake {
    /// Consumes the one-time token only after the server validates it.
    Authenticate { token: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::Level;

    /// Builds a deterministic structured record for protocol shape assertions.
    fn entry(message: &str) -> LogEntry {
        LogEntry {
            timestamp: "2026-08-27T12:34:56.789+03:00".to_string(),
            level: Level::Info,
            message: message.to_string(),
            error: None,
        }
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

    /// Locks authentication to a first-frame tagged message rather than URL credentials.
    #[test]
    fn serializes_agent_handshake_without_changing_its_tag() {
        let handshake = serde_json::to_value(LogAgentHandshake::Authenticate {
            token: "secret".to_string(),
        })
        .expect("handshake should serialize");
        // Keeping the token in a text frame prevents it from leaking through request URLs and access logs.
        assert_eq!(
            handshake,
            serde_json::json!({"type":"authenticate","token":"secret"})
        );
    }
}
