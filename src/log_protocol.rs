use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

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
        entries: Vec<String>,
        /// Explains whether persistent history was available without exposing a file path.
        file_logging_enabled: bool,
    },
    /// Appends one logger record accepted after the snapshot boundary.
    Entry {
        /// Uses the logger's formatted output so file and live rendering stay consistent.
        entry: String,
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

    /// Locks the browser protocol tags and field names to stable JSON shapes.
    #[test]
    fn serializes_log_events_with_stable_tagged_shapes() {
        let snapshot = serde_json::to_value(LogEvent::Snapshot {
            entries: vec!["first".to_string()],
            file_logging_enabled: true,
        })
        .expect("snapshot should serialize");
        // Snapshot replacement depends on this exact tagged field shape in the shared viewer.
        assert_eq!(
            snapshot,
            serde_json::json!({"type":"snapshot","entries":["first"],"file_logging_enabled":true})
        );

        let entry = serde_json::to_value(LogEvent::Entry {
            entry: "next".to_string(),
        })
        .expect("entry should serialize");
        // Live appends must remain distinguishable from replacement snapshots.
        assert_eq!(entry, serde_json::json!({"type":"entry","entry":"next"}));

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
