use serde::{Deserialize, Serialize};
use std::fmt;
use tokio::sync::mpsc;
use ts_rs::TS;

/// Identifies one agent across the router, websocket protocol, and REST API.
///
/// This is the stable key used to address a connected agent and to associate
/// agent-originated messages with that agent.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
#[ts(type = "string")]
pub struct AgentId(pub String);

impl AgentId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

impl From<String> for AgentId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for AgentId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Correlates one router command request with its eventual response.
///
/// This is used for internal command routing between the server router,
/// websocket protocol messages, stream uploads/downloads, and agent-side
/// upload session tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
#[ts(type = "number")]
pub struct RequestId(pub u64);

impl RequestId {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }

    pub fn as_transfer_id(self) -> TransferId {
        TransferId(self.0)
    }

    pub fn to_le_bytes(self) -> [u8; 8] {
        self.0.to_le_bytes()
    }

    pub fn from_le_bytes(bytes: [u8; 8]) -> Self {
        Self(u64::from_le_bytes(bytes))
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Identifies a public transfer or copy operation exposed to REST and UI
/// consumers.
///
/// Unlike `RequestId`, this represents the externally visible transfer job,
/// not the internal per-agent request IDs that may be used to implement it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
#[ts(type = "number")]
pub struct TransferId(pub u64);

impl TransferId {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

impl fmt::Display for TransferId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Monotonic index of one binary chunk within a streamed transfer.
///
/// This is used in the binary streaming protocol to preserve chunk ordering
/// across uploads, downloads, and agent-to-agent copy forwarding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
#[ts(type = "number")]
pub struct ChunkIndex(pub u64);

impl ChunkIndex {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn next_index(self) -> Self {
        Self(self.0 + 1)
    }

    pub fn saturating_next_index(self) -> Self {
        Self(self.0.saturating_add(1))
    }

    pub fn display_number(self) -> u64 {
        self.0 + 1
    }

    pub fn to_le_bytes(self) -> [u8; 8] {
        self.0.to_le_bytes()
    }

    pub fn from_le_bytes(bytes: [u8; 8]) -> Self {
        Self(u64::from_le_bytes(bytes))
    }
}

impl fmt::Display for ChunkIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl UnixTimestampSeconds {
    pub fn new(value: i64) -> Self {
        Self(value)
    }
}

/// Unix timestamp in whole seconds since the epoch.
///
/// This is used for registration-time metadata such as when an agent
/// connected to the router.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
#[ts(type = "number")]
pub struct UnixTimestampSeconds(pub i64);

impl fmt::Display for UnixTimestampSeconds {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Message {
    /// Sent by a newly connected agent to bind the websocket session to its
    /// stable agent id and publish metadata used by the router, UI, and agent
    /// detail responses.
    #[serde(rename = "agent_register")]
    AgentRegister {
        agent_id: AgentId,
        agent_name: String,
        os: String,
        arch: String,
        hostname: String,
        username: String,
    },

    /// Optional explicit teardown signal from an agent asking the router to
    /// remove it from the active registry; websocket session shutdown also
    /// triggers the same cleanup automatically.
    #[serde(rename = "agent_unregister")]
    AgentUnregister { agent_id: AgentId },

    /// Sent by the router to start a request on an agent.
    ///
    /// The `request_id` becomes the correlation key for the request's terminal
    /// `CommandResponse` and, for streaming commands, any binary stream frames.
    #[serde(rename = "command")]
    Command {
        agent_id: AgentId,
        request_id: RequestId,
        command: crate::commands::Command,
    },

    /// Sent by an agent when a request reaches its terminal result.
    ///
    /// The router routes this either back to a waiting one-shot REST caller or
    /// uses it to complete router-managed uploads and copy operations.
    #[serde(rename = "command_response")]
    CommandResponse {
        agent_id: AgentId,
        request_id: RequestId,
        result: crate::commands::CommandResult,
    },

    /// Sent by an agent to report byte progress for a router-managed copy that
    /// executes locally on one agent.
    ///
    /// Direct uploads and downloads do not use this message because the router
    /// derives their progress from streamed chunks instead.
    #[serde(rename = "transfer_progress_update")]
    TransferProgressUpdate {
        agent_id: AgentId,
        request_id: RequestId,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    },

    /// Sent by the router to ask an agent to abort an active download-style
    /// stream for the given request id.
    ///
    /// This is used when the REST-side consumer goes away or router cleanup
    /// cancels the transfer; the agent currently applies it to active
    /// downloads, not uploads.
    #[serde(rename = "cancel_transfer")]
    CancelTransfer { request_id: RequestId },

    /// Protocol-level error outside any request-specific response flow.
    ///
    /// The router currently uses this to reject invalid agent registration such
    /// as duplicate live agent names, and the agent treats it as fatal.
    #[serde(rename = "error")]
    Error { message: String },
}

pub type AgentSender = mpsc::UnboundedSender<Message>;
