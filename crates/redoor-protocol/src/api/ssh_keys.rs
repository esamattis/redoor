//! Bodies for the per-device SSH key and pinned host key endpoints.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::vault::{VaultFileHeader, VaultFileKeyStatus, VaultKeyWrap};

/// The host key a device presented to a probe, shown to the user for confirmation before
/// any credential is sent to the device.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshHostKeyResponse {
    /// OpenSSH key type, for example `ssh-ed25519`.
    pub key_type: String,
    /// `SHA256:` fingerprint in the format `ssh-keygen -l` prints, so users can compare it
    /// with the value shown on the device itself.
    pub fingerprint: String,
    /// Whether the server user's own known_hosts files already trust this exact key for the
    /// host. Informational only: the user still confirms.
    pub previously_trusted: bool,
    /// Fingerprint of the key pinned for the device, when there is one; differing from
    /// `fingerprint` means the host key changed since it was pinned.
    pub pinned_fingerprint: Option<String>,
}

/// Starts or rotates the device's managed key. Sent only by browser sessions.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EnrollSshKeyRequest {
    /// Fingerprint the user confirmed. Required when no host key is pinned yet; the server
    /// refuses to continue when the device now presents a different key.
    pub host_key_fingerprint: Option<String>,
    /// Login password used once to install the key. Never stored or logged.
    pub password: Option<String>,
    /// Encrypts the new key with the account's vault. Required when the account has a
    /// vault (`vault_required` otherwise) and refused when it has none.
    #[serde(default)]
    #[ts(optional)]
    pub vault: Option<SshKeyVaultSeal>,
    /// For rotating an encrypted key: its file key, so the server can log in with the
    /// current key. Not needed while the server holds the key for a running device.
    #[serde(default)]
    #[ts(optional)]
    pub current_file_key: Option<String>,
}

/// What the browser supplies to encrypt a new SSH key with the vault. The server generates
/// the key itself, so the browser never sees it; it only picks the file key and wraps it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshKeyVaultSeal {
    /// The vault the key is encrypted with; must be the account's vault.
    pub vault_id: String,
    /// Must be the current generation.
    pub key_id: String,
    /// A new random file key, base64url.
    pub file_key: String,
    /// `file_key` wrapped with the current generation for the `ssh-key` kind.
    pub file_key_wrap: VaultKeyWrap,
}

/// Optional body of `DELETE /api/v1/agents/{agent}/ssh-key`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RemoveSshKeyRequest {
    /// The current encrypted key's file key, so the server can log in and remove the key's
    /// line from the device. Without it (and without a held key) the removal is local only.
    #[serde(default)]
    #[ts(optional)]
    pub current_file_key: Option<String>,
}

/// Answers `GET /api/v1/agents/{agent}/ssh-key`: how the device's managed key is stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshKeyStatusResponse {
    /// Whether the device logs in with a managed key at all.
    pub managed: bool,
    /// `SHA256:` fingerprint of the current key; known also while an encrypted key is
    /// locked, because its header carries the public key.
    pub fingerprint: Option<String>,
    /// Whether the key is encrypted with the account's vault.
    pub encrypted: bool,
    /// Whether the server holds the decrypted key, so the device starts without unlocking.
    pub held: bool,
    /// The encrypted key's header, from which the browser unwraps the file key.
    pub vault_header: Option<VaultFileHeader>,
    /// How the encrypted key's generation relates to the account's vault.
    pub key_status: Option<VaultFileKeyStatus>,
    /// Why the key file cannot be read, when it cannot.
    pub problem: Option<String>,
}

/// `POST /api/v1/agents/{agent}/ssh-key/rewrap`: moves an encrypted key to the current
/// vault generation by replacing only its header.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RewrapSshKeyRequest {
    /// The key's file key, unwrapped by the browser with the key's generation.
    pub file_key: String,
    /// Must be the current generation.
    pub key_id: String,
    /// The same file key wrapped with the current generation.
    pub wrap: VaultKeyWrap,
}

/// One encrypted SSH key of the account, for vault rotation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSshKey {
    /// The device the key logs in to.
    pub device_id: String,
    /// The device's current name, when it is still configured.
    pub device_name: Option<String>,
    /// The key's header: generation and wrap.
    pub header: VaultFileHeader,
    /// How the key's generation relates to the vault.
    pub key_status: VaultFileKeyStatus,
}

/// Answers `GET /api/v1/vault/ssh-keys`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSshKeysResponse {
    pub keys: Vec<VaultSshKey>,
}

/// Result of a successful enrollment or rotation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshKeyEnrollmentResponse {
    /// `SHA256:` fingerprint of the new public key, as it appears in the device's logs. It
    /// also identifies the key: the device's `authorized_keys` line carries it in its
    /// `redoor:<device-id>:<account>:<fingerprint>` marker.
    pub fingerprint: String,
    /// Whether an existing managed key was replaced instead of a first key created.
    pub rotated: bool,
}

/// Result of removing the managed key.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshKeyRemovalResponse {
    /// Whether the key's `authorized_keys` line was removed from the device. When false the
    /// key was still deleted locally, but the line is left on the device.
    pub removed_from_device: bool,
    /// Why the device could not be cleaned up, when it could not.
    pub device_error: Option<String>,
}

/// Re-pins the device's host key after the user confirmed a change.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PinSshHostKeyRequest {
    /// Fingerprint the user confirmed; the device must still present exactly this key.
    pub host_key_fingerprint: String,
}

/// The host key pinned for the device after a re-pin.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshHostKeyPinResponse {
    /// OpenSSH key type, for example `ssh-ed25519`.
    pub key_type: String,
    /// `SHA256:` fingerprint of the pinned key.
    pub fingerprint: String,
}
