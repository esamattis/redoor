//! Request and response bodies for the first-use migration from global to per-user workspaces.
//!
//! TEMPORARY MIGRATION: Supports upgrading existing single-workspace deployments to per-user
//! workspaces. Can be removed once all deployed servers have upgraded to layout version 2.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Summary of legacy global data waiting to be moved into a user's workspace.
///
/// TEMPORARY MIGRATION: Presented on the confirmation screen so the operator can verify what
/// will move into the signed-in account before confirming. Can be removed after layout v2 adoption.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MigrationSummary {
    /// Number of managed `[[agents]]` entries in `config.toml`.
    pub managed_device_count: usize,
    /// Effective display names of those managed devices, in config order.
    pub managed_device_names: Vec<String>,
    /// Whether a legacy global `vault.json` exists.
    pub has_vault: bool,
    /// Number of legacy managed SSH key directories under `<data_dir>/ssh/`.
    pub ssh_key_count: usize,
    /// Number of legacy access tokens in `<data_dir>/tokens/access-tokens.json`.
    pub access_token_count: usize,
    /// Existing top-level `agent_token` from `config.toml`, when present.
    pub agent_token: Option<String>,
}

/// Response for `GET /api/v1/migration`.
///
/// TEMPORARY MIGRATION: Reports whether first-use migration is still pending and what legacy
/// data will be migrated. Can be removed after layout v2 adoption.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MigrationStatusResponse {
    /// True while legacy global data awaits confirmation into a user workspace.
    pub pending: bool,
    /// Details of legacy data to move when `pending` is true.
    pub summary: Option<MigrationSummary>,
}

/// Request body for `POST /api/v1/migration/confirm`.
///
/// TEMPORARY MIGRATION: Binds the confirmation to the username shown on the migration screen
/// so switching accounts in another tab cannot assign legacy data to the wrong user. Can be
/// removed after layout v2 adoption.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConfirmMigrationRequest {
    /// Canonical username the operator explicitly confirmed in the UI.
    pub expected_username: String,
}

/// Response for `POST /api/v1/migration/confirm`.
///
/// TEMPORARY MIGRATION: Confirms which user received the migrated legacy workspace. Can be
/// removed after layout v2 adoption.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConfirmMigrationResponse {
    /// Canonical username that now owns the migrated workspace.
    pub migrated_to: String,
}
