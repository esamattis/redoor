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
pub mod sessions;
pub mod ssh_keys;
pub mod systemd;
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
    pub code: Option<ApiErrorCode>,
}

/// Machine-readable reasons for failures a client must tell apart, such as the vault errors
/// or a session signed out for reuse, so the UI shows its own message for each one instead of
/// parsing text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApiErrorCode {
    /// The user has no vault.
    VaultNotFound,
    /// Creating a vault when one exists.
    VaultExists,
    /// The proof of possession did not match.
    VaultProofInvalid,
    /// The request would leave the vault without any slot, so nothing could unlock it.
    VaultLastSlot,
    /// The submitted vault data is malformed.
    VaultInvalid,
    /// The file does not start with the vault magic.
    NotAVaultFile,
    /// The file was written by a newer format version.
    VaultFormatUnsupported,
    /// The header is too long, not JSON, or has invalid fields.
    VaultHeaderCorrupted,
    /// The file belongs to another vault.
    ForeignVault,
    /// The file's key generation was destroyed.
    RetiredVaultKey,
    /// The file's key generation is not in this vault.
    UnknownVaultKey,
    /// The header MAC failed: tampered header or wrong file key.
    VaultHeaderTampered,
    /// The payload failed authentication or is truncated.
    VaultPayloadCorrupted,
    /// A write used a generation other than the current one, typically a tab that missed a
    /// rotation.
    StaleVaultKey,
    /// The file changed on the device since it was read.
    VaultFileChanged,
    /// The file key is not 32 bytes of base64url.
    InvalidVaultFileKey,
    /// The path does not end in `.redoorencrypted`.
    NotAVaultPath,
    /// The agent is too old to check write preconditions.
    AgentUpgradeRequired,
    /// The device's SSH key is encrypted with the vault and not held by the server; start
    /// it from the browser, which unlocks the vault and sends the key's file key.
    SshKeyLocked,
    /// The account has a vault, so new SSH keys must be encrypted with it.
    VaultRequired,
    /// A key generation cannot be destroyed while an SSH key still uses it; rewrap the key
    /// first.
    VaultKeyInUse,
    /// The browser's vault device secret is gone: it expired, was locked, belongs to another
    /// or an ended login session, or the server restarted. The browser forgets its wrapped
    /// key and the vault stays locked.
    VaultDeviceNotFound,
    /// The device does not run systemd, so it has no units to manage.
    SystemdUnsupported,
    /// The user's systemd manager does not run, typically because the user has no session
    /// and linger is off; enabling linger starts it.
    SystemdUserManagerNotRunning,
    /// The session cookie was used by two browsers: a request presented a secret the session
    /// had already rotated past, so the server signed the session out for both of them.
    SessionReused,
}
