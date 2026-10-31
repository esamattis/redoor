//! Store rules: proofs, the passphrase requirement, rotation, destroy and restore.

use super::*;
use redoor_core::test_support::TempDir;
use redoor_core::vault::{encode_base64url, random_base64url};
use redoor_protocol::api::vault::{
    VaultKdfParams, VaultKeyWrap, VaultObjectKind, VaultPayloadParams,
};

/// A proof and its verifier, as the browser derives them from a vault key.
struct Proof {
    proof: String,
    verifier: String,
}

impl Proof {
    /// Random proof material; the store only ever sees the hash relation.
    fn new() -> Self {
        let mut proof = [0u8; 32];
        getrandom::fill(&mut proof).unwrap();
        Self {
            proof: encode_base64url(&proof),
            verifier: encode_base64url(&Sha256::digest(proof)),
        }
    }
}

/// A random id with the given prefix.
fn id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    format!(
        "{prefix}{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

/// A random wrap of a 32-byte key.
fn wrap() -> VaultKeyWrap {
    VaultKeyWrap {
        alg: "A256GCM".to_string(),
        iv: random_base64url(12),
        ct: random_base64url(48),
    }
}

/// A passphrase slot with the minimum accepted parameters.
fn passphrase_slot() -> VaultSlotInput {
    VaultSlotInput {
        id: id("slot_"),
        label: "Passphrase".to_string(),
        kind: VaultSlotKind::Passphrase {
            kdf: VaultKdfParams {
                alg: "argon2id".to_string(),
                m_kib: 65536,
                t: 3,
                p: 1,
                salt: random_base64url(16),
            },
        },
        wrap: wrap(),
    }
}

/// A passkey slot.
fn passkey_slot() -> VaultSlotInput {
    VaultSlotInput {
        id: id("slot_"),
        label: "YubiKey".to_string(),
        kind: VaultSlotKind::Passkey {
            credential_id: random_base64url(32),
            rp_id: "redoor.example.com".to_string(),
        },
        wrap: wrap(),
    }
}

/// A store in a fresh home with a vault created, plus its proof.
async fn created(temp: &TempDir) -> (VaultStore, Proof, VaultSummary) {
    let store = VaultStore::new(
        redoor_core::paths::AppPaths::for_home("redoor-test", temp.path()),
        "tester".to_string(),
    );
    let proof = Proof::new();
    let summary = store
        .create(CreateVaultRequest {
            vault_id: id("vlt_"),
            label: "tester@test".to_string(),
            key_id: id("kid_"),
            auth_verifier: proof.verifier.clone(),
            slots: vec![passphrase_slot()],
        })
        .await
        .unwrap();
    (store, proof, summary)
}

/// A file header on the given vault and generation.
fn header(vault_id: &str, key_id: &str) -> VaultFileHeader {
    VaultFileHeader {
        vault_id: vault_id.to_string(),
        vault_label: "other".to_string(),
        key_id: key_id.to_string(),
        kind: VaultObjectKind::File,
        context: serde_json::Map::new(),
        wrap: wrap(),
        payload: VaultPayloadParams {
            alg: "chacha20poly1305-stream".to_string(),
            chunk_size: 65536,
            salt: random_base64url(16),
        },
    }
}

/// Rotates to a new generation with a new proof, keeping the slots given.
async fn rotate(store: &VaultStore, proof: &Proof, slots: Vec<VaultSlotInput>) -> (Proof, String) {
    let next = Proof::new();
    let key_id = id("kid_");
    store
        .rotate(RotateVaultRequest {
            auth_proof: proof.proof.clone(),
            new_key_id: key_id.clone(),
            new_auth_verifier: next.verifier.clone(),
            previous_key_wrap: wrap(),
            slots,
        })
        .await
        .unwrap();
    (next, key_id)
}

/// The error code of a failed call.
fn code<T: std::fmt::Debug>(result: Result<T, ApiError>) -> Option<ApiErrorCode> {
    result.unwrap_err().code()
}

/// A vault can be created once, and the file is private.
#[tokio::test]
async fn create_refuses_a_second_vault_and_writes_a_private_file() {
    let temp = TempDir::create();
    let (store, proof, summary) = created(&temp).await;
    // The summary reports the one generation as current.
    assert_eq!(summary.generations.len(), 1);
    assert!(summary.generations[0].current);
    let second = store
        .create(CreateVaultRequest {
            vault_id: id("vlt_"),
            label: "again".to_string(),
            key_id: id("kid_"),
            auth_verifier: proof.verifier.clone(),
            slots: vec![passphrase_slot()],
        })
        .await;
    // Replacing a vault would make its files unreadable, so creation is refused.
    assert_eq!(code(second), Some(ApiErrorCode::VaultExists));
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(store.path().unwrap())
        .unwrap()
        .permissions()
        .mode();
    // Only the server user may read the wrapped keys.
    assert_eq!(mode & 0o777, 0o600);
}

/// Creation without a passphrase slot is refused, because passkeys are bound to hostnames.
#[tokio::test]
async fn create_requires_a_passphrase_slot() {
    let temp = TempDir::create();
    let store = VaultStore::new(
        redoor_core::paths::AppPaths::for_home("redoor-test", temp.path()),
        "tester".to_string(),
    );
    let result = store
        .create(CreateVaultRequest {
            vault_id: id("vlt_"),
            label: "tester".to_string(),
            key_id: id("kid_"),
            auth_verifier: Proof::new().verifier,
            slots: vec![passkey_slot()],
        })
        .await;
    // Passkey-only vaults would be lost on another hostname.
    assert_eq!(code(result), Some(ApiErrorCode::VaultPassphraseRequired));
}

/// Slot changes need the proof, and the last passphrase slot stays.
#[tokio::test]
async fn slot_changes_need_proof_and_keep_a_passphrase() {
    let temp = TempDir::create();
    let (store, proof, summary) = created(&temp).await;
    let passkey = passkey_slot();
    let forged = store
        .add_slot(AddVaultSlotRequest {
            auth_proof: Proof::new().proof,
            slot: passkey.clone(),
        })
        .await;
    // A stolen session without the vault key cannot add its own passkey.
    assert_eq!(code(forged), Some(ApiErrorCode::VaultProofInvalid));
    let added = store
        .add_slot(AddVaultSlotRequest {
            auth_proof: proof.proof.clone(),
            slot: passkey.clone(),
        })
        .await
        .unwrap();
    // The right proof adds the slot.
    assert_eq!(added.slots.len(), 2);
    let duplicate = store
        .add_slot(AddVaultSlotRequest {
            auth_proof: proof.proof.clone(),
            slot: VaultSlotInput {
                id: id("slot_"),
                ..passkey.clone()
            },
        })
        .await;
    // The same credential twice would only confuse unlocking.
    assert_eq!(code(duplicate), Some(ApiErrorCode::VaultInvalid));
    let passphrase_id = &summary.slots[0].id;
    let removed = store.remove_slot(passphrase_id, &proof.proof).await;
    // Removing the only passphrase slot is refused.
    assert_eq!(code(removed), Some(ApiErrorCode::VaultPassphraseRequired));
    let renamed = store
        .rename_slot(&passkey.id, &proof.proof, "Laptop key".to_string())
        .await
        .unwrap();
    // Renaming changes only the label.
    assert!(renamed.slots.iter().any(|slot| slot.label == "Laptop key"));
    let after = store.remove_slot(&passkey.id, &proof.proof).await.unwrap();
    // A passkey slot can be removed.
    assert_eq!(after.slots.len(), 1);
}

/// Rotation chains the old generation, and writes with the old key id become stale.
#[tokio::test]
async fn rotation_chains_generations_and_rejects_stale_writes() {
    let temp = TempDir::create();
    let (store, proof, summary) = created(&temp).await;
    let old_key = summary.current_key_id.clone();
    let stale_proof = store
        .rotate(RotateVaultRequest {
            auth_proof: Proof::new().proof,
            new_key_id: id("kid_"),
            new_auth_verifier: Proof::new().verifier,
            previous_key_wrap: wrap(),
            slots: vec![passphrase_slot()],
        })
        .await;
    // Rotation is a vault change and needs the proof.
    assert_eq!(code(stale_proof), Some(ApiErrorCode::VaultProofInvalid));
    let (next, new_key) = rotate(&store, &proof, vec![passphrase_slot()]).await;
    let material = store.unlock_material().await.unwrap();
    // The new generation is current and wraps the old one.
    assert_eq!(material.current_key_id, new_key);
    assert_eq!(material.keys[1].key_id, old_key);
    assert_eq!(
        material.keys[1].wrapped_by.as_deref(),
        Some(new_key.as_str())
    );
    // A tab that missed the rotation must not keep writing with the old generation.
    assert_eq!(
        code(store.require_current(&old_key).await),
        Some(ApiErrorCode::StaleVaultKey)
    );
    assert!(store.require_current(&new_key).await.is_ok());
    // Old files stay readable, reported as older so the UI offers a rewrap.
    let vault_id = summary.vault_id.clone();
    assert_eq!(
        store
            .key_status(&header(&vault_id, &old_key))
            .await
            .unwrap(),
        VaultFileKeyStatus::Older
    );
    // The old proof is no longer accepted.
    assert_eq!(
        code(store.update_label(&proof.proof, "x".to_string()).await),
        Some(ApiErrorCode::VaultProofInvalid)
    );
    assert!(
        store
            .update_label(&next.proof, "x".to_string())
            .await
            .is_ok()
    );
}

/// Destroying a middle generation keeps the older ones reachable and retires its id.
#[tokio::test]
async fn destroying_a_middle_generation_relinks_the_chain() {
    let temp = TempDir::create();
    let (store, proof, summary) = created(&temp).await;
    let first = summary.current_key_id.clone();
    let (proof, middle) = rotate(&store, &proof, vec![passphrase_slot()]).await;
    let (proof, newest) = rotate(&store, &proof, vec![passphrase_slot()]).await;
    let without_relink = store
        .destroy_key(
            &middle,
            DestroyVaultKeyRequest {
                auth_proof: proof.proof.clone(),
                relink: None,
            },
        )
        .await;
    // Without a relink the first generation would become unreachable.
    assert_eq!(code(without_relink), Some(ApiErrorCode::VaultInvalid));
    store
        .destroy_key(
            &middle,
            DestroyVaultKeyRequest {
                auth_proof: proof.proof.clone(),
                relink: Some(wrap()),
            },
        )
        .await
        .unwrap();
    let material = store.unlock_material().await.unwrap();
    // The first generation is now wrapped by the newest one directly.
    assert_eq!(material.keys.len(), 2);
    assert_eq!(material.keys[1].key_id, first);
    assert_eq!(
        material.keys[1].wrapped_by.as_deref(),
        Some(newest.as_str())
    );
    // Files on the destroyed generation get a precise error.
    let status = store
        .key_status(&header(&summary.vault_id, &middle))
        .await
        .unwrap();
    assert!(matches!(status, VaultFileKeyStatus::Retired { .. }));
    // The current generation can never be destroyed.
    assert_eq!(
        code(
            store
                .destroy_key(
                    &newest,
                    DestroyVaultKeyRequest {
                        auth_proof: proof.proof.clone(),
                        relink: None,
                    },
                )
                .await
        ),
        Some(ApiErrorCode::VaultInvalid)
    );
}

/// Restoring over an installed vault needs a proof for that vault, not only the backup's.
#[tokio::test]
async fn restore_over_a_vault_needs_its_proof() {
    let temp = TempDir::create();
    let (store, proof, _) = created(&temp).await;
    let backup = store.document().await.unwrap();
    let other_temp = TempDir::create();
    let (other, other_proof, _) = created(&other_temp).await;
    let foreign = other.document().await.unwrap();
    let swapped = store
        .restore(RestoreVaultBackupRequest {
            backup: foreign.clone(),
            backup_auth_proof: other_proof.proof.clone(),
            current_auth_proof: None,
        })
        .await;
    // A stolen session could otherwise install a vault it controls.
    assert_eq!(code(swapped), Some(ApiErrorCode::VaultProofInvalid));
    let wrong_backup_proof = store
        .restore(RestoreVaultBackupRequest {
            backup: foreign.clone(),
            backup_auth_proof: proof.proof.clone(),
            current_auth_proof: Some(proof.proof.clone()),
        })
        .await;
    // The backup must really unlock with the key the browser holds.
    assert_eq!(
        code(wrong_backup_proof),
        Some(ApiErrorCode::VaultProofInvalid)
    );
    let restored = store
        .restore(RestoreVaultBackupRequest {
            backup: foreign.clone(),
            backup_auth_proof: other_proof.proof.clone(),
            current_auth_proof: Some(proof.proof.clone()),
        })
        .await
        .unwrap();
    // With both proofs the backup replaces the vault.
    assert_eq!(restored.vault_id, foreign.vault_id);
    assert_ne!(restored.vault_id, backup.vault_id);
}

/// Last use is written at most once a day.
#[tokio::test]
async fn slot_use_is_recorded_once_a_day() {
    let temp = TempDir::create();
    let (store, _, summary) = created(&temp).await;
    let slot = &summary.slots[0].id;
    // The first unlock of the day writes the date.
    assert!(store.mark_slot_used(slot).await.unwrap());
    // Later unlocks the same day do not rewrite the file.
    assert!(!store.mark_slot_used(slot).await.unwrap());
}

/// Files of other vaults and unknown generations are told apart.
#[tokio::test]
async fn key_status_names_foreign_and_unknown_files() {
    let temp = TempDir::create();
    let (store, _, summary) = created(&temp).await;
    // Another vault id means another vault, whatever the key id.
    assert_eq!(
        store
            .key_status(&header(&id("vlt_"), &summary.current_key_id))
            .await
            .unwrap(),
        VaultFileKeyStatus::ForeignVault
    );
    // A key id the vault never had suggests an older backup was restored.
    assert_eq!(
        store
            .key_status(&header(&summary.vault_id, &id("kid_")))
            .await
            .unwrap(),
        VaultFileKeyStatus::UnknownKey
    );
    let error = store
        .require_readable(&header(&id("vlt_"), &summary.current_key_id))
        .await
        .unwrap_err();
    // The message names the other vault so the user knows which one to look for.
    assert!(error.to_string().contains("other"));
    assert_eq!(error.code(), Some(ApiErrorCode::ForeignVault));
}
