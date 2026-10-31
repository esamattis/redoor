//! Server-owned terminal sessions: shells that outlive the browser socket viewing them.

use crate::ids::{AgentId, TerminalSessionId, UnixTimestampMillis};
use crate::wire::terminal::TerminalSize;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a terminal session is in its life, so a restored tab knows whether it can type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    /// The agent is still starting the PTY.
    Starting,
    /// The shell runs and accepts input.
    Running,
    /// The shell is gone. The last screen is kept so a reloaded tab can show why it ended.
    Exited { message: String },
}

/// One terminal session as every browser window sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerminalSessionInfo {
    pub id: TerminalSessionId,
    pub agent_id: AgentId,
    /// Directory the shell started in; tab reuse matches on it.
    pub cwd: String,
    /// Tab title chosen by the creating window, so every window shows the same name.
    pub title: String,
    /// Per-device tab number, so a window that restores tabs numbers new ones after it.
    pub number: u32,
    pub created_at: UnixTimestampMillis,
    pub status: TerminalSessionStatus,
    /// Whether a browser currently views the session.
    pub attached: bool,
}

/// Every terminal session of the server, in creation order.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerminalSessionList {
    pub sessions: Vec<TerminalSessionInfo>,
}

/// Starts a shell on a device that lives until its tab is closed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateTerminalSessionRequest {
    /// Absolute directory the shell starts in.
    pub cwd: String,
    pub title: String,
    pub number: u32,
    /// Initial PTY size, so the shell's first prompt is laid out for the creating window.
    pub size: TerminalSize,
}

/// The created session, registered before the reply so a list fetch already contains it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateTerminalSessionResponse {
    pub session: TerminalSessionInfo,
}

/// Confirms that a session's shell was stopped and the session forgotten.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CloseTerminalSessionResponse {
    pub id: TerminalSessionId,
}
