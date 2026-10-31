//! The per-user vault store: `<data_dir>/users/<username>/vault.json`.
//!
//! The server stores only wrapped keys and a proof verifier, never a vault key: the browser
//! creates, unwraps and rewraps every key. What the server decides is which changes it
//! accepts. Every change needs a proof that the browser holds the current vault key (see
//! [`check_proof`]), so a stolen session cookie cannot add an attacker's passkey or swap the
//! vault, and every write of an encrypted file must use the current key generation.
//!
//! The file is tiny and changes rarely, so the store reads it on every request under one
//! lock instead of caching it; a backup restored by hand is picked up at once.

mod validate;

use std::path::PathBuf;
use std::sync::Arc;

use axum::http::StatusCode;
use jiff::{Timestamp, Unit};
use redoor_core::log_error;
use redoor_protocol::api::vault::{
    AddVaultSlotRequest, ApiErrorCode, CreateVaultRequest, DestroyVaultKeyRequest,
    RestoreVaultBackupRequest, RotateVaultRequest, VAULT_DOCUMENT_VERSION, VaultDocument,
    VaultFileHeader, VaultFileKeyStatus, VaultGenerationSummary, VaultKeyEntry, VaultRetiredKey,
    VaultSlot, VaultSlotInput, VaultSlotKind, VaultSlotSummary, VaultSlotType, VaultSummary,
    VaultUnlockMaterialResponse,
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::http::error::ApiError;
use crate::http::user_state::{
    account_directory, prepare_account_directory, write_private_file_atomically,
};

/// File name inside the account directory.
const VAULT_FILE: &str = "vault.json";

/// Owns reads and writes of one account's `vault.json`.
#[derive(Clone)]
pub(crate) struct VaultStore {
    paths: redoor_core::paths::AppPaths,
    username: String,
    /// Serializes read-modify-write cycles, so two changes can never lose each other.
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl VaultStore {
    /// A store for the login account; nothing is read until the first request.
    pub(crate) fn new(paths: redoor_core::paths::AppPaths, username: String) -> Self {
        Self {
            paths,
            username,
            lock: Arc::default(),
        }
    }

    /// The vault without wrapped keys, or `None` before one is created.
    pub(crate) async fn summary(&self) -> Result<Option<VaultSummary>, ApiError> {
        let _guard = self.lock.lock().await;
        Ok(self.load().await?.as_ref().map(summarize))
    }

    /// The whole document, which is the backup format.
    pub(crate) async fn document(&self) -> Result<VaultDocument, ApiError> {
        let _guard = self.lock.lock().await;
        self.load().await?.ok_or_else(vault_not_found)
    }

    /// The slot and chain wraps the browser needs to unlock.
    pub(crate) async fn unlock_material(&self) -> Result<VaultUnlockMaterialResponse, ApiError> {
        let document = self.document().await?;
        Ok(VaultUnlockMaterialResponse {
            current_key_id: current_key(&document).key_id.clone(),
            vault_id: document.vault_id,
            slots: document.slots,
            keys: document.keys,
        })
    }

    /// Creates the vault; refused when one exists, because replacing it would make every
    /// file encrypted with it unreadable.
    pub(crate) async fn create(
        &self,
        request: CreateVaultRequest,
    ) -> Result<VaultSummary, ApiError> {
        validate::vault_id(&request.vault_id)?;
        validate::key_id(&request.key_id)?;
        validate::label(&request.label)?;
        validate::verifier(&request.auth_verifier)?;
        validate::slots(&request.slots)?;
        let _guard = self.lock.lock().await;
        if self.load().await?.is_some() {
            return Err(ApiError::coded(
                StatusCode::CONFLICT,
                ApiErrorCode::VaultExists,
                "A vault already exists",
            ));
        }
        let now = now();
        let document = VaultDocument {
            version: VAULT_DOCUMENT_VERSION,
            vault_id: request.vault_id,
            label: request.label,
            created_at: now.clone(),
            auth_verifier: request.auth_verifier,
            keys: vec![VaultKeyEntry {
                key_id: request.key_id,
                created_at: now.clone(),
                current: true,
                wrapped_by: None,
                wrap: None,
            }],
            retired_keys: Vec::new(),
            slots: request
                .slots
                .into_iter()
                .map(|slot| stored_slot(slot, &now, None))
                .collect(),
        };
        self.save(&document).await?;
        Ok(summarize(&document))
    }

    /// Renames the vault. New file headers carry the label, so foreign-vault errors elsewhere
    /// name it.
    pub(crate) async fn update_label(
        &self,
        auth_proof: &str,
        label: String,
    ) -> Result<VaultSummary, ApiError> {
        validate::label(&label)?;
        self.change(auth_proof, |document| {
            document.label = label;
            Ok(())
        })
        .await
    }

    /// Adds a slot that wraps the current key.
    pub(crate) async fn add_slot(
        &self,
        request: AddVaultSlotRequest,
    ) -> Result<VaultSummary, ApiError> {
        validate::slot(&request.slot)?;
        self.change(&request.auth_proof, |document| {
            let mut inputs: Vec<VaultSlotInput> =
                document.slots.iter().cloned().map(slot_input).collect();
            inputs.push(request.slot.clone());
            validate::slots(&inputs)?;
            document.slots.push(stored_slot(request.slot, &now(), None));
            Ok(())
        })
        .await
    }

    /// Renames a slot.
    pub(crate) async fn rename_slot(
        &self,
        slot_id: &str,
        auth_proof: &str,
        label: String,
    ) -> Result<VaultSummary, ApiError> {
        validate::label(&label)?;
        self.change(auth_proof, |document| {
            find_slot(document, slot_id)?.label = label;
            Ok(())
        })
        .await
    }

    /// Removes a slot, refusing to remove the last one: a vault without slots could never be
    /// unlocked again, and its files would be lost.
    pub(crate) async fn remove_slot(
        &self,
        slot_id: &str,
        auth_proof: &str,
    ) -> Result<VaultSummary, ApiError> {
        self.change(auth_proof, |document| {
            find_slot(document, slot_id)?;
            document.slots.retain(|slot| slot.id != slot_id);
            let inputs: Vec<VaultSlotInput> =
                document.slots.iter().cloned().map(slot_input).collect();
            validate::slots(&inputs)
        })
        .await
    }

    /// Makes a new key generation current, chaining the previous one under it and replacing
    /// every slot, all in one write.
    pub(crate) async fn rotate(
        &self,
        request: RotateVaultRequest,
    ) -> Result<VaultSummary, ApiError> {
        validate::key_id(&request.new_key_id)?;
        validate::verifier(&request.new_auth_verifier)?;
        validate::wrap(&request.previous_key_wrap)?;
        validate::slots(&request.slots)?;
        self.change(&request.auth_proof, |document| {
            if document
                .keys
                .iter()
                .map(|key| &key.key_id)
                .chain(document.retired_keys.iter().map(|key| &key.key_id))
                .any(|key_id| *key_id == request.new_key_id)
            {
                return Err(invalid("The new key generation id is already in use"));
            }
            let now = now();
            let previous = &mut document.keys[0];
            previous.current = false;
            previous.wrapped_by = Some(request.new_key_id.clone());
            previous.wrap = Some(request.previous_key_wrap.clone());
            document.keys.insert(
                0,
                VaultKeyEntry {
                    key_id: request.new_key_id.clone(),
                    created_at: now.clone(),
                    current: true,
                    wrapped_by: None,
                    wrap: None,
                },
            );
            // Kept slots keep their dates; their wraps are new.
            let previous_slots = std::mem::take(&mut document.slots);
            document.slots = request
                .slots
                .iter()
                .cloned()
                .map(|input| {
                    let existing = previous_slots.iter().find(|slot| slot.id == input.id);
                    stored_slot(
                        input,
                        existing.map_or(&now, |slot| &slot.created_at),
                        existing.and_then(|slot| slot.last_used_at.clone()),
                    )
                })
                .collect();
            document.auth_verifier = request.new_auth_verifier.clone();
            Ok(())
        })
        .await
    }

    /// Destroys an older key generation. Files still encrypted with it become unreadable,
    /// and only its fingerprint and dates remain so they get a precise error.
    pub(crate) async fn destroy_key(
        &self,
        key_id: &str,
        request: DestroyVaultKeyRequest,
    ) -> Result<VaultSummary, ApiError> {
        if let Some(relink) = &request.relink {
            validate::wrap(relink)?;
        }
        self.change(&request.auth_proof, |document| {
            let index = document
                .keys
                .iter()
                .position(|key| key.key_id == key_id)
                .ok_or_else(|| ApiError::not_found("Key generation not found"))?;
            if index == 0 {
                return Err(invalid("The current key generation cannot be destroyed"));
            }
            let newer = document.keys[index - 1].key_id.clone();
            let destroyed = document.keys.remove(index);
            // Older generations were reachable only through the destroyed one.
            if let Some(older) = document.keys.get_mut(index) {
                let Some(relink) = request.relink.clone() else {
                    return Err(invalid(
                        "Destroying this generation needs the next older one wrapped again",
                    ));
                };
                older.wrapped_by = Some(newer);
                older.wrap = Some(relink);
            } else if request.relink.is_some() {
                return Err(invalid("The oldest generation has nothing to relink"));
            }
            document.retired_keys.push(VaultRetiredKey {
                key_id: destroyed.key_id,
                created_at: destroyed.created_at,
                destroyed_at: now(),
            });
            Ok(())
        })
        .await
    }

    /// Replaces the vault with a backup. The backup must come with its own proof (so it
    /// really unlocks) and, when a vault is installed, a proof for that one too: otherwise a
    /// stolen session could build its own backup and swap the vault.
    pub(crate) async fn restore(
        &self,
        request: RestoreVaultBackupRequest,
    ) -> Result<VaultSummary, ApiError> {
        validate::document(&request.backup)?;
        check_proof(&request.backup.auth_verifier, &request.backup_auth_proof)?;
        let _guard = self.lock.lock().await;
        if let Some(installed) = self.load().await? {
            let Some(proof) = request.current_auth_proof.as_deref() else {
                return Err(proof_invalid());
            };
            check_proof(&installed.auth_verifier, proof)?;
        }
        self.save(&request.backup).await?;
        Ok(summarize(&request.backup))
    }

    /// Records that a slot unlocked the vault, at most once a day so unlocking does not
    /// rewrite the file every time. No proof: the date is informational only.
    pub(crate) async fn mark_slot_used(&self, slot_id: &str) -> Result<bool, ApiError> {
        let _guard = self.lock.lock().await;
        let mut document = self.load().await?.ok_or_else(vault_not_found)?;
        let today = Timestamp::now().to_zoned(jiff::tz::TimeZone::UTC).date();
        let slot = find_slot(&mut document, slot_id)?;
        let used_today = slot
            .last_used_at
            .as_deref()
            .and_then(|value| value.parse::<Timestamp>().ok())
            .is_some_and(|value| value.to_zoned(jiff::tz::TimeZone::UTC).date() == today);
        if used_today {
            return Ok(false);
        }
        slot.last_used_at = Some(now());
        self.save(&document).await?;
        Ok(true)
    }

    /// How a file header's key generation relates to the vault; never an error, because
    /// listing headers must work for every file.
    pub(crate) async fn key_status(
        &self,
        header: &VaultFileHeader,
    ) -> Result<VaultFileKeyStatus, ApiError> {
        let _guard = self.lock.lock().await;
        Ok(match self.load().await? {
            None => VaultFileKeyStatus::NoVault,
            Some(document) => key_status(&document, header),
        })
    }

    /// Fails unless the header can be opened with this vault, with the error code the UI
    /// shows for each reason.
    pub(crate) async fn require_readable(&self, header: &VaultFileHeader) -> Result<(), ApiError> {
        match self.key_status(header).await? {
            VaultFileKeyStatus::Current | VaultFileKeyStatus::Older => Ok(()),
            status => Err(status_error(header, &status)),
        }
    }

    /// The document for a write, failing with `stale_vault_key` unless `key_id` is the
    /// current generation. A tab that missed a rotation still holds the old key, and its
    /// writes would otherwise keep producing files on the old generation.
    pub(crate) async fn require_current(&self, key_id: &str) -> Result<VaultDocument, ApiError> {
        let document = self.document().await?;
        if current_key(&document).key_id != key_id {
            return Err(ApiError::coded(
                StatusCode::CONFLICT,
                ApiErrorCode::StaleVaultKey,
                "The vault key was rotated; unlock the vault again",
            ));
        }
        Ok(document)
    }

    /// Runs a proof-checked change under the lock and saves the result atomically.
    async fn change(
        &self,
        auth_proof: &str,
        apply: impl FnOnce(&mut VaultDocument) -> Result<(), ApiError>,
    ) -> Result<VaultSummary, ApiError> {
        let _guard = self.lock.lock().await;
        let mut document = self.load().await?.ok_or_else(vault_not_found)?;
        check_proof(&document.auth_verifier, auth_proof)?;
        apply(&mut document)?;
        validate::document(&document)?;
        self.save(&document).await?;
        Ok(summarize(&document))
    }

    /// The file's location; per account, like the editor buffers, because the vault belongs
    /// to the person holding its passkeys.
    fn path(&self) -> Result<PathBuf, ApiError> {
        account_directory(&self.paths, &self.username)
            .map(|directory| directory.join(VAULT_FILE))
            .map_err(storage_error)
    }

    /// Reads the document; a missing file means no vault.
    async fn load(&self) -> Result<Option<VaultDocument>, ApiError> {
        let path = self.path()?;
        let contents = match tokio::fs::read(&path).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(storage_error(error.into())),
        };
        let document: VaultDocument = serde_json::from_slice(&contents).map_err(|error| {
            storage_error(anyhow::anyhow!(
                "failed to parse '{}': {error}",
                path.display()
            ))
        })?;
        if document.version != VAULT_DOCUMENT_VERSION {
            return Err(storage_error(anyhow::anyhow!(
                "'{}' has unsupported version {}",
                path.display(),
                document.version
            )));
        }
        Ok(Some(document))
    }

    /// Writes the document with mode 0600 through a sibling, so a crash never leaves a
    /// truncated vault behind: losing `vault.json` loses every file.
    async fn save(&self, document: &VaultDocument) -> Result<(), ApiError> {
        let directory = prepare_account_directory(&self.paths, &self.username)
            .await
            .map_err(storage_error)?;
        let contents =
            serde_json::to_vec_pretty(document).map_err(|error| storage_error(error.into()))?;
        write_private_file_atomically(
            &directory.join(".vault.json.tmp"),
            &directory.join(VAULT_FILE),
            &contents,
        )
        .await
        .map_err(storage_error)
    }
}

/// Checks a proof of possession: the SHA-256 of the proof must equal the stored verifier,
/// compared in constant time.
fn check_proof(verifier: &str, proof: &str) -> Result<(), ApiError> {
    let (Some(verifier), Some(proof)) = (
        redoor_vault::decode_fixed::<32>(verifier),
        redoor_vault::decode_fixed::<32>(proof),
    ) else {
        return Err(proof_invalid());
    };
    let hashed: [u8; 32] = Sha256::digest(proof).into();
    if bool::from(hashed.ct_eq(&verifier)) {
        Ok(())
    } else {
        Err(proof_invalid())
    }
}

/// The current generation; validation guarantees it is the first entry.
fn current_key(document: &VaultDocument) -> &VaultKeyEntry {
    &document.keys[0]
}

/// Classifies a file header against the vault.
fn key_status(document: &VaultDocument, header: &VaultFileHeader) -> VaultFileKeyStatus {
    if header.vault_id != document.vault_id {
        return VaultFileKeyStatus::ForeignVault;
    }
    if let Some(position) = document
        .keys
        .iter()
        .position(|key| key.key_id == header.key_id)
    {
        return if position == 0 {
            VaultFileKeyStatus::Current
        } else {
            VaultFileKeyStatus::Older
        };
    }
    match document
        .retired_keys
        .iter()
        .find(|key| key.key_id == header.key_id)
    {
        Some(retired) => VaultFileKeyStatus::Retired {
            created_at: retired.created_at.clone(),
            destroyed_at: retired.destroyed_at.clone(),
        },
        None => VaultFileKeyStatus::UnknownKey,
    }
}

/// The error for a file the vault cannot open, worded for the user.
pub(crate) fn status_error(header: &VaultFileHeader, status: &VaultFileKeyStatus) -> ApiError {
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    match status {
        VaultFileKeyStatus::Current | VaultFileKeyStatus::Older => {
            ApiError::internal("The file can be opened")
        }
        VaultFileKeyStatus::NoVault => vault_not_found(),
        VaultFileKeyStatus::ForeignVault => ApiError::coded(
            unprocessable,
            ApiErrorCode::ForeignVault,
            format!(
                "Encrypted with another vault: {} ({})",
                header.vault_label,
                fingerprint(&header.vault_id)
            ),
        ),
        VaultFileKeyStatus::Retired { destroyed_at, .. } => ApiError::coded(
            unprocessable,
            ApiErrorCode::RetiredVaultKey,
            format!(
                "Encrypted with key generation {}, destroyed on {destroyed_at}",
                fingerprint(&header.key_id)
            ),
        ),
        VaultFileKeyStatus::UnknownKey => ApiError::coded(
            unprocessable,
            ApiErrorCode::UnknownVaultKey,
            format!(
                "Encrypted with unknown key generation {} (maybe an older vault backup was restored)",
                fingerprint(&header.key_id)
            ),
        ),
    }
}

/// A short, readable form of a vault or key id for messages.
fn fingerprint(id: &str) -> String {
    let hex = id.split_once('_').map_or(id, |(_, hex)| hex);
    hex.chars().take(8).collect()
}

/// The status view of a document.
fn summarize(document: &VaultDocument) -> VaultSummary {
    VaultSummary {
        vault_id: document.vault_id.clone(),
        label: document.label.clone(),
        created_at: document.created_at.clone(),
        current_key_id: current_key(document).key_id.clone(),
        generations: document
            .keys
            .iter()
            .map(|key| VaultGenerationSummary {
                key_id: key.key_id.clone(),
                created_at: key.created_at.clone(),
                current: key.current,
            })
            .collect(),
        retired_keys: document.retired_keys.clone(),
        slots: document
            .slots
            .iter()
            .map(|slot| {
                let (slot_type, credential_id, rp_id) = match &slot.kind {
                    VaultSlotKind::Passphrase { .. } => (VaultSlotType::Passphrase, None, None),
                    VaultSlotKind::Passkey {
                        credential_id,
                        rp_id,
                    } => (
                        VaultSlotType::Passkey,
                        Some(credential_id.clone()),
                        Some(rp_id.clone()),
                    ),
                };
                VaultSlotSummary {
                    id: slot.id.clone(),
                    label: slot.label.clone(),
                    slot_type,
                    credential_id,
                    rp_id,
                    created_at: slot.created_at.clone(),
                    last_used_at: slot.last_used_at.clone(),
                }
            })
            .collect(),
    }
}

/// A submitted slot with its server-kept dates.
fn stored_slot(input: VaultSlotInput, created_at: &str, last_used_at: Option<String>) -> VaultSlot {
    VaultSlot {
        id: input.id,
        label: input.label,
        kind: input.kind,
        wrap: input.wrap,
        created_at: created_at.to_string(),
        last_used_at,
    }
}

/// A stored slot in submitted form, so stored and submitted slot lists validate alike.
fn slot_input(slot: VaultSlot) -> VaultSlotInput {
    VaultSlotInput {
        id: slot.id,
        label: slot.label,
        kind: slot.kind,
        wrap: slot.wrap,
    }
}

/// Finds a slot by id.
fn find_slot<'a>(
    document: &'a mut VaultDocument,
    slot_id: &str,
) -> Result<&'a mut VaultSlot, ApiError> {
    document
        .slots
        .iter_mut()
        .find(|slot| slot.id == slot_id)
        .ok_or_else(|| ApiError::not_found("Vault slot not found"))
}

/// The current time at second precision, the form every vault date is stored in.
fn now() -> String {
    Timestamp::now()
        .round(Unit::Second)
        .unwrap_or_else(|_| Timestamp::now())
        .to_string()
}

/// No vault exists for this account.
fn vault_not_found() -> ApiError {
    ApiError::coded(
        StatusCode::NOT_FOUND,
        ApiErrorCode::VaultNotFound,
        "No vault has been created",
    )
}

/// The proof of possession did not match.
fn proof_invalid() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        ApiErrorCode::VaultProofInvalid,
        "The vault key proof is invalid; unlock the vault again",
    )
}

/// A malformed or inconsistent vault change.
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::coded(StatusCode::BAD_REQUEST, ApiErrorCode::VaultInvalid, message)
}

/// A disk failure. Details go to the server log, not the client.
fn storage_error(error: anyhow::Error) -> ApiError {
    log_error!(error, "Vault storage failed");
    ApiError::internal("Vault storage failed")
}

#[cfg(test)]
mod tests;
