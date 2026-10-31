//! The per-user vault that encrypts `.redoorvault` files, and the REST bodies around it.
//!
//! Every binary value (wraps, salts, proofs, keys) is base64url without padding, so the
//! browser and the server agree on one encoding. Times are RFC 3339 strings, like the
//! access token API. The vault document itself is also the backup format, so a backup is
//! exactly what the server stores.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The `vault.json` format version this server writes and accepts.
pub const VAULT_DOCUMENT_VERSION: u32 = 1;

/// The only key wrapping algorithm: AES-256-GCM, which WebCrypto offers everywhere.
pub const VAULT_WRAP_ALG: &str = "A256GCM";

/// The only payload algorithm of format version 1.
pub const VAULT_PAYLOAD_ALG: &str = "chacha20poly1305-stream";

/// The only passphrase key derivation function.
pub const VAULT_KDF_ALG: &str = "argon2id";

/// Suffix that marks a file as encrypted with the vault.
pub const VAULT_FILE_SUFFIX: &str = ".redoorvault";

/// One AES-256-GCM wrap of a 32-byte key: a slot's vault key, a chain entry's older vault
/// key, or a file's key in a file header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultKeyWrap {
    /// Always [`VAULT_WRAP_ALG`]; stored so a later version can add another.
    pub alg: String,
    /// 12-byte nonce.
    pub iv: String,
    /// 32-byte key followed by the 16-byte GCM tag.
    pub ct: String,
}

/// Argon2id parameters of a passphrase slot, stored per slot so they can be raised later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultKdfParams {
    /// Always [`VAULT_KDF_ALG`].
    pub alg: String,
    /// Memory cost in KiB.
    pub m_kib: u32,
    /// Iterations.
    pub t: u32,
    /// Parallelism.
    pub p: u32,
    /// 16-byte random salt.
    pub salt: String,
}

/// What unlocks a slot, with the inputs the browser needs to derive its key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum VaultSlotKind {
    /// A passphrase stretched with Argon2id. Every vault has one, because passkeys only
    /// work on the hostname they were registered on.
    Passphrase { kdf: VaultKdfParams },
    /// A WebAuthn credential whose PRF output derives the slot key.
    Passkey {
        /// The credential id, base64url.
        credential_id: String,
        /// The relying party id the credential is bound to, so the UI can explain why a
        /// passkey does not work on another hostname.
        rp_id: String,
    },
}

/// A slot as the browser submits it: everything except the server-kept dates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSlotInput {
    /// `slot_` followed by 32 hex digits. The browser picks it because the wrap's
    /// associated data includes it.
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub kind: VaultSlotKind,
    /// The current vault key wrapped with this slot's key.
    pub wrap: VaultKeyWrap,
}

/// A stored slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSlot {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub kind: VaultSlotKind,
    pub wrap: VaultKeyWrap,
    pub created_at: String,
    /// Written at most once a day, so unlocking does not rewrite `vault.json` every time.
    #[serde(default)]
    pub last_used_at: Option<String>,
}

/// One vault key generation. The current one has no wrap; every older one is wrapped by
/// the next newer generation, so one unlock reaches them all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultKeyEntry {
    /// `kid_` followed by the hex of the first 16 bytes of HKDF(VK, "redoor-vault v1
    /// key-id"): a public fingerprint of the generation.
    pub key_id: String,
    pub created_at: String,
    #[serde(default)]
    pub current: bool,
    /// The key id of the generation whose key wraps this one.
    #[serde(default)]
    pub wrapped_by: Option<String>,
    #[serde(default)]
    pub wrap: Option<VaultKeyWrap>,
}

/// A destroyed generation. Only its fingerprint and dates remain, so a file encrypted
/// with it gets a precise error instead of "unknown key".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultRetiredKey {
    pub key_id: String,
    pub created_at: String,
    pub destroyed_at: String,
}

/// The whole `vault.json`, which is also the backup format. It holds only wrapped keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultDocument {
    pub version: u32,
    /// `vlt_` followed by 32 hex digits.
    pub vault_id: String,
    /// Copied into new file headers, so a foreign-vault error can name the other vault.
    pub label: String,
    pub created_at: String,
    /// SHA-256 of the current auth proof, base64url; see [`VaultProof`].
    pub auth_verifier: String,
    /// Newest first; the first entry is the current generation.
    pub keys: Vec<VaultKeyEntry>,
    #[serde(default)]
    pub retired_keys: Vec<VaultRetiredKey>,
    pub slots: Vec<VaultSlot>,
}

/// A slot without its wrap, for ordinary page loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSlotSummary {
    pub id: String,
    pub label: String,
    /// `"passphrase"` or `"passkey"`.
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub slot_type: VaultSlotType,
    /// Present for passkeys: needed for `allowCredentials` when unlocking.
    pub credential_id: Option<String>,
    /// Present for passkeys.
    pub rp_id: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// The two slot types, without their parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum VaultSlotType {
    Passphrase,
    Passkey,
}

/// One key generation without its wrap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultGenerationSummary {
    pub key_id: String,
    pub created_at: String,
    pub current: bool,
}

/// The vault as ordinary page loads see it: no wrapped keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSummary {
    pub vault_id: String,
    pub label: String,
    pub created_at: String,
    pub current_key_id: String,
    /// Newest first.
    pub generations: Vec<VaultGenerationSummary>,
    pub retired_keys: Vec<VaultRetiredKey>,
    pub slots: Vec<VaultSlotSummary>,
}

/// Answers `GET /api/v1/vault` and every request that changes the vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultStatusResponse {
    /// Absent until the user creates a vault.
    pub vault: Option<VaultSummary>,
}

/// Answers `GET /api/v1/vault/unlock-material`: what the browser needs to unwrap the
/// vault key and every older generation. Kept apart from the status so page loads never
/// fetch wrapped keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultUnlockMaterialResponse {
    pub vault_id: String,
    pub current_key_id: String,
    pub slots: Vec<VaultSlot>,
    /// Newest first, with the chain wraps of the older generations.
    pub keys: Vec<VaultKeyEntry>,
}

/// `POST /api/v1/vault`: creates the vault. The browser generated every key.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateVaultRequest {
    pub vault_id: String,
    pub label: String,
    pub key_id: String,
    pub auth_verifier: String,
    /// At least one passphrase slot.
    pub slots: Vec<VaultSlotInput>,
}

/// Proves the browser holds the current vault key: HKDF(VK, "redoor-vault v1 auth"),
/// base64url. The server stores only its SHA-256, so the proof reveals nothing about VK and
/// a stolen session cookie alone cannot change the vault.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultProof {
    pub auth_proof: String,
}

/// `PATCH /api/v1/vault`: renames the vault.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateVaultRequest {
    pub auth_proof: String,
    pub label: String,
}

/// `POST /api/v1/vault/slots`: adds a slot that wraps the current key.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AddVaultSlotRequest {
    pub auth_proof: String,
    pub slot: VaultSlotInput,
}

/// `PATCH /api/v1/vault/slots/{id}`: renames a slot.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenameVaultSlotRequest {
    pub auth_proof: String,
    pub label: String,
}

/// `POST /api/v1/vault/rotate`: replaces the slots, the chain and the verifier at once.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RotateVaultRequest {
    /// Proof for the generation being replaced.
    pub auth_proof: String,
    pub new_key_id: String,
    pub new_auth_verifier: String,
    /// The previous vault key wrapped with the new one, the new chain link.
    pub previous_key_wrap: VaultKeyWrap,
    /// Every kept slot, wrapping the new key. At least one passphrase slot.
    pub slots: Vec<VaultSlotInput>,
}

/// `POST /api/v1/vault/keys/{key_id}/destroy`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DestroyVaultKeyRequest {
    pub auth_proof: String,
    /// The next older generation wrapped with the next newer one. Required unless the
    /// destroyed generation is the oldest, because the older ones would become
    /// unreachable.
    pub relink: Option<VaultKeyWrap>,
}

/// `PUT /api/v1/vault/backup`: replaces the vault with a backup.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RestoreVaultBackupRequest {
    pub backup: VaultDocument,
    /// Proves the backup really unlocks.
    pub backup_auth_proof: String,
    /// Required when a vault is installed, so a stolen session cannot swap it for its own.
    pub current_auth_proof: Option<String>,
}

/// Answers `POST /api/v1/vault/slots/{id}/used`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultSlotUsedResponse {
    /// False when the slot was already marked today, so nothing was written.
    pub updated: bool,
}

/// What kind of object a vault file holds; the server compares it with what it expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum VaultObjectKind {
    /// A user file opened, edited, uploaded or downloaded through redoor.
    File,
}

impl VaultObjectKind {
    /// The name used in the header JSON and in the file key wrap's associated data.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
        }
    }
}

/// How the payload of a vault file is encrypted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultPayloadParams {
    /// Always [`VAULT_PAYLOAD_ALG`].
    pub alg: String,
    /// Plaintext bytes per chunk; always 65536 in format version 1.
    pub chunk_size: u32,
    /// 16 random bytes, new for every encryption.
    pub salt: String,
}

/// The plaintext JSON header of a `.redoorvault` file. It has no dates on purpose: it is
/// readable by anyone holding the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultFileHeader {
    pub vault_id: String,
    pub vault_label: String,
    pub key_id: String,
    pub kind: VaultObjectKind,
    /// What the object is bound to (for example a device id and key fingerprint), compared
    /// by the server; empty for files.
    pub context: std::collections::BTreeMap<String, String>,
    /// The file key wrapped with the vault key generation `key_id`.
    pub wrap: VaultKeyWrap,
    pub payload: VaultPayloadParams,
}

/// How a file's key generation relates to the user's vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum VaultFileKeyStatus {
    /// Encrypted with the current generation.
    Current,
    /// Encrypted with an older generation that the vault can still open; offer a rewrap.
    Older,
    /// The user has no vault yet.
    NoVault,
    /// Encrypted with a different vault.
    ForeignVault,
    /// Encrypted with a generation that was destroyed.
    Retired {
        created_at: String,
        destroyed_at: String,
    },
    /// The generation is not in the vault, for example after an older backup was restored.
    UnknownKey,
}

/// Answers `GET /api/v1/agents/{agent}/vault/header/{*path}`. Nothing is decrypted, so it
/// works while the vault is locked.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultFileHeaderResponse {
    pub path: String,
    pub header: VaultFileHeader,
    /// Opaque version of the file on the device; writes send it back so they never
    /// overwrite a newer version.
    pub revision: String,
    #[ts(type = "number")]
    pub file_size: u64,
    #[ts(type = "number")]
    pub plaintext_size: u64,
    pub key_status: VaultFileKeyStatus,
}

/// Answers every encrypted write (save, upload, rewrap, re-encrypt).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VaultFileWriteResponse {
    pub path: String,
    /// Ciphertext bytes written to the device.
    #[ts(type = "number")]
    pub bytes_written: u64,
    /// The new version on the device, read right after publishing. Another writer in that
    /// short window would make the next save conflict, never get lost.
    pub revision: Option<String>,
}

/// `POST /api/v1/agents/{agent}/vault/rewrap/{*path}`: moves a file to the current key
/// generation without touching its payload.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RewrapVaultFileRequest {
    /// The file's key, unwrapped by the browser with the file's generation.
    pub file_key: String,
    /// Must be the current generation.
    pub key_id: String,
    /// The same file key wrapped with the current generation.
    pub wrap: VaultKeyWrap,
    pub expected_revision: String,
}

/// `POST /api/v1/agents/{agent}/vault/reencrypt/{*path}`: decrypts with the old file key
/// and encrypts again with a new one, for files a compromised server may have seen.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReencryptVaultFileRequest {
    pub file_key: String,
    pub new_file_key: String,
    /// Must be the current generation.
    pub key_id: String,
    /// The new file key wrapped with the current generation.
    pub wrap: VaultKeyWrap,
    pub expected_revision: String,
}

/// Machine-readable reasons for vault failures, so the UI shows its own message for each
/// one instead of parsing text.
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
    /// The request would leave the vault without a passphrase slot.
    VaultPassphraseRequired,
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
    /// The path does not end in `.redoorvault`.
    NotAVaultPath,
    /// The agent is too old to check write preconditions.
    AgentUpgradeRequired,
}
