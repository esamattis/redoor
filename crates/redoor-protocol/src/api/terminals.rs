//! Terminal sessions: shells that run in the agent process and outlive both the browser socket
//! viewing them and the server relaying it.

use crate::ids::{AgentId, TerminalSessionId, UnixTimestampMillis};
use crate::wire::terminal::TerminalSize;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a terminal session is in its life, so a restored tab knows whether it can type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    /// The shell runs and accepts input, as far as the server knows: while the agent is
    /// disconnected its sessions keep the status they last had.
    Running,
    /// The shell is gone. The last screen is kept so a reloaded tab can show why it ended.
    Exited { message: String },
}

/// What a session's shell is doing right now, so a tab can say more than where it started.
///
/// The agent refreshes it while the shell produces output, at most about once a second, so
/// it trails the shell a little and is a hint for people, not something to act on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerminalActivity {
    /// Command line of the job in the foreground, `None` while the shell waits at its prompt.
    pub command: Option<String>,
    /// Directory the shell (or its foreground job) is in now. A remote one reported by a
    /// shell over SSH is prefixed with its host, as `host:/path`.
    pub current_dir: Option<String>,
    /// Window title the shell or a program set with an escape sequence, if any.
    pub title: Option<String>,
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
    /// Live details about the shell for the tab's tooltip.
    pub activity: TerminalActivity,
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
