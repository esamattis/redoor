//! Server-sent UI events: invalidation hints and the `rd-open` command.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Coarse invalidation hints pushed to browsers so they refetch only when state changed
/// instead of polling every resource, plus the one command a terminal can send to them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
    /// Agent inventory changed and agent-dependent route data may need reloading.
    AgentsChanged,
    /// Filesystem state changed and the active route may need reloading.
    RoutesChanged,
    /// Transfer progress changed without requiring unrelated route loaders to rerun.
    TransfersChanged,
    /// A terminal session was created, closed or exited, so open windows update their tabs.
    TerminalsChanged,
    /// `rd-open` ran in a terminal of `agent_id` and asks a browser to show `path`.
    ///
    /// Unlike the hints above it is a command, not changed state, so it carries its payload
    /// and is never throttled or merged: a dropped or delayed one would lose the request.
    OpenPath {
        agent_id: crate::ids::AgentId,
        /// The device's current name, for the confirmation text and for building the URL
        /// when the window has not listed the device yet.
        device_name: String,
        /// Absolute path on the device.
        path: String,
        kind: OpenPathKind,
    },
}

/// What an `rd-open` path is, decided by the agent that could stat it, so the browser knows
/// whether it opens a file view or a directory listing without asking again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum OpenPathKind {
    File,
    Directory,
}
