//! REST bodies for a managed device's terminal environment variables.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// Replaces a device's `terminal_env`. Its own endpoint rather than part of the device edit,
/// because that edit stops the agent, while new variables only matter to shells started
/// later and the running ones should keep going.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateTerminalEnvRequest {
    /// The complete new set; variables left out are removed.
    pub env: BTreeMap<String, String>,
}

/// The variables as saved, so the UI shows exactly what new shells will get.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerminalEnvResponse {
    pub env: BTreeMap<String, String>,
}
