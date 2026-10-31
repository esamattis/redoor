//! Shape checks of everything the browser submits for the vault.
//!
//! The server cannot check that a wrap really wraps the right key (it never holds one), but
//! it can refuse anything that is malformed, so a buggy or hostile client cannot store a
//! vault that later fails to unlock in confusing ways.

use std::collections::HashSet;

use axum::http::StatusCode;
use redoor_core::vault::{WRAP_CT_LEN, WRAP_IV_LEN, decode_fixed};
use redoor_protocol::api::vault::{
    ApiErrorCode, VAULT_DOCUMENT_VERSION, VAULT_KDF_ALG, VAULT_WRAP_ALG, VaultDocument,
    VaultKdfParams, VaultKeyWrap, VaultSlotInput, VaultSlotKind,
};

use crate::http::error::ApiError;

/// Bounds labels so lists and headers stay readable; headers are limited to 4 KiB.
const MAX_LABEL_CHARS: usize = 100;
/// Bounds the slot list; nobody registers this many passkeys.
const MAX_SLOTS: usize = 32;
/// Argon2id floor: 64 MiB and 3 passes, because a leaked `vault.json` allows offline
/// guessing of the passphrase slot.
const MIN_KDF_MEMORY_KIB: u32 = 64 * 1024;
const MIN_KDF_ITERATIONS: u32 = 3;
/// Ceilings that keep a hostile document from making browsers hash for minutes.
const MAX_KDF_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_KDF_ITERATIONS: u32 = 64;
const MAX_KDF_PARALLELISM: u32 = 16;
/// WebAuthn allows credential ids up to 1023 bytes.
const MAX_CREDENTIAL_ID_BYTES: usize = 1023;

/// A malformed field.
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::coded(StatusCode::BAD_REQUEST, ApiErrorCode::VaultInvalid, message)
}

/// Checks `<prefix>` followed by 32 lowercase hex digits (128 random or derived bits).
fn prefixed_hex(value: &str, prefix: &str, what: &str) -> Result<(), ApiError> {
    let valid = value.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if valid {
        Ok(())
    } else {
        Err(invalid(format!("Invalid {what}")))
    }
}

/// `vlt_` and 32 hex digits.
pub(super) fn vault_id(value: &str) -> Result<(), ApiError> {
    prefixed_hex(value, "vlt_", "vault id")
}

/// `kid_` and 32 hex digits.
pub(super) fn key_id(value: &str) -> Result<(), ApiError> {
    prefixed_hex(value, "kid_", "key generation id")
}

/// `slot_` and 32 hex digits.
fn slot_id(value: &str) -> Result<(), ApiError> {
    prefixed_hex(value, "slot_", "slot id")
}

/// A short single-line label.
pub(super) fn label(value: &str) -> Result<(), ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_LABEL_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!(
            "Labels must be 1 to {MAX_LABEL_CHARS} characters on one line"
        )));
    }
    Ok(())
}

/// The SHA-256 of a proof: 32 bytes.
pub(super) fn verifier(value: &str) -> Result<(), ApiError> {
    decode_fixed::<32>(value)
        .map(|_| ())
        .ok_or_else(|| invalid("The auth verifier must be 32 bytes"))
}

/// An AES-256-GCM wrap of a 32-byte key.
pub(super) fn wrap(wrap: &VaultKeyWrap) -> Result<(), ApiError> {
    if wrap.alg != VAULT_WRAP_ALG
        || decode_fixed::<WRAP_IV_LEN>(&wrap.iv).is_none()
        || decode_fixed::<WRAP_CT_LEN>(&wrap.ct).is_none()
    {
        return Err(invalid("A key wrap must be AES-256-GCM of a 32-byte key"));
    }
    Ok(())
}

/// Argon2id parameters within the accepted range.
fn kdf(kdf: &VaultKdfParams) -> Result<(), ApiError> {
    if kdf.alg != VAULT_KDF_ALG
        || !(MIN_KDF_MEMORY_KIB..=MAX_KDF_MEMORY_KIB).contains(&kdf.m_kib)
        || !(MIN_KDF_ITERATIONS..=MAX_KDF_ITERATIONS).contains(&kdf.t)
        || !(1..=MAX_KDF_PARALLELISM).contains(&kdf.p)
        || decode_fixed::<16>(&kdf.salt).is_none()
    {
        return Err(invalid(format!(
            "The passphrase must use Argon2id with at least {MIN_KDF_MEMORY_KIB} KiB, \
{MIN_KDF_ITERATIONS} passes and a 16-byte salt"
        )));
    }
    Ok(())
}

/// One slot.
pub(super) fn slot(slot: &VaultSlotInput) -> Result<(), ApiError> {
    slot_id(&slot.id)?;
    label(&slot.label)?;
    wrap(&slot.wrap)?;
    match &slot.kind {
        VaultSlotKind::Passphrase { kdf: params } => kdf(params),
        VaultSlotKind::Passkey {
            credential_id,
            rp_id,
        } => {
            let credential = base64::Engine::decode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                credential_id,
            )
            .map_err(|_| invalid("The passkey credential id must be base64url"))?;
            if credential.is_empty() || credential.len() > MAX_CREDENTIAL_ID_BYTES {
                return Err(invalid("The passkey credential id has an invalid length"));
            }
            if rp_id.is_empty() || rp_id.len() > 253 || rp_id.chars().any(char::is_control) {
                return Err(invalid("The passkey relying party id is invalid"));
            }
            Ok(())
        }
    }
}

/// A whole slot list: valid slots, unique ids and credentials, and a passphrase slot.
pub(super) fn slots(slots: &[VaultSlotInput]) -> Result<(), ApiError> {
    if slots.len() > MAX_SLOTS {
        return Err(invalid(format!("A vault holds at most {MAX_SLOTS} slots")));
    }
    let mut ids = HashSet::new();
    let mut credentials = HashSet::new();
    for entry in slots {
        slot(entry)?;
        if !ids.insert(entry.id.as_str()) {
            return Err(invalid("Slot ids must be unique"));
        }
        if let VaultSlotKind::Passkey { credential_id, .. } = &entry.kind
            && !credentials.insert(credential_id.as_str())
        {
            return Err(invalid("This passkey is already registered"));
        }
    }
    if !slots
        .iter()
        .any(|slot| matches!(slot.kind, VaultSlotKind::Passphrase { .. }))
    {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            ApiErrorCode::VaultPassphraseRequired,
            "A vault always keeps a passphrase slot, because passkeys only work on the \
hostname they were registered on",
        ));
    }
    Ok(())
}

/// A whole document, as restored from a backup or about to be saved: the chain must lead
/// from the current generation through every older one.
pub(super) fn document(document: &VaultDocument) -> Result<(), ApiError> {
    if document.version != VAULT_DOCUMENT_VERSION {
        return Err(invalid(format!(
            "Unsupported vault version {}",
            document.version
        )));
    }
    vault_id(&document.vault_id)?;
    label(&document.label)?;
    verifier(&document.auth_verifier)?;
    let Some((current, older)) = document.keys.split_first() else {
        return Err(invalid("The vault has no key generation"));
    };
    key_id(&current.key_id)?;
    if !current.current || current.wrap.is_some() || current.wrapped_by.is_some() {
        return Err(invalid("The first key generation must be the current one"));
    }
    let mut ids = HashSet::from([current.key_id.as_str()]);
    let mut newer = current.key_id.as_str();
    for entry in older {
        key_id(&entry.key_id)?;
        let Some(entry_wrap) = &entry.wrap else {
            return Err(invalid("Older key generations must be wrapped"));
        };
        wrap(entry_wrap)?;
        if entry.current || entry.wrapped_by.as_deref() != Some(newer) {
            return Err(invalid(
                "Each older key generation must be wrapped by the next newer one",
            ));
        }
        if !ids.insert(entry.key_id.as_str()) {
            return Err(invalid("Key generation ids must be unique"));
        }
        newer = &entry.key_id;
    }
    for retired in &document.retired_keys {
        key_id(&retired.key_id)?;
        if !ids.insert(retired.key_id.as_str()) {
            return Err(invalid(
                "A destroyed key generation is still listed as usable",
            ));
        }
    }
    let inputs: Vec<VaultSlotInput> = document
        .slots
        .iter()
        .map(|slot| VaultSlotInput {
            id: slot.id.clone(),
            label: slot.label.clone(),
            kind: slot.kind.clone(),
            wrap: slot.wrap.clone(),
        })
        .collect();
    slots(&inputs)
}
