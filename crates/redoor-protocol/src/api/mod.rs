//! REST request and response bodies grouped by domain.

pub mod agents;
pub mod auth;
pub mod diffs;
pub mod editor_buffers;
pub mod exec;
pub mod files;
pub mod git;
pub mod logging;
pub mod search;
pub mod server;
pub mod ssh_keys;
pub mod terminals;
pub mod tokens;
pub mod transfers;
pub mod trash;
pub mod ui_events;
pub mod user_state;
pub mod vault;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Uniform JSON error body so clients can show failures without parsing per-route shapes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorResponse {
    pub error: String,
    /// Set for failures a client must tell apart, such as the vault errors, so the UI can
    /// choose a message without parsing text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<vault::ApiErrorCode>,
}
