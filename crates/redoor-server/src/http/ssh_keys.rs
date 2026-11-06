//! REST endpoints for per-device SSH keys and pinned host keys.
//!
//! Session-only, like the other agent configuration routes, because they carry login
//! passwords and file keys and change what the server can log in to. Keys belong to the
//! server's single account, so everyone who can sign in shares them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::{Json, extract::State as AxumState, http::StatusCode};
use redoor_core::config::{AgentConfig, SshBackedAgentConfig, edit_ssh_agent};
use redoor_core::log;
use redoor_protocol::api::ssh_keys::{
    ConfirmManualSshKeyRequest, EnrollSshKeyRequest, ManualSshKeyResponse, PinSshHostKeyRequest,
    PrepareManualSshKeyRequest, RemoveSshKeyRequest, SshHostKeyPinResponse, SshHostKeyResponse,
    SshKeyEnrollmentResponse, SshKeyRemovalResponse, SshKeyStatusResponse, SshKeyVaultSeal,
};
use redoor_protocol::api::vault::ApiErrorCode;
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::log::Level;
use zeroize::Zeroizing;

use super::agent_configuration::{
    find_configured_agent, find_ssh_agent, replace_runtime_agent, stop_for_configuration_change,
    with_name_reserved,
};
use super::vault_files::{file_key, format_error};
use super::{access::ResolvedDevice, error::ApiError, state::ServerState};
use crate::ssh::encrypted_keys::{SshKeyOpenError, SshKeySeal};
use crate::ssh::keys::{GeneratedKey, ManagedKey, StoredKey};
use crate::ssh::managed_keys::{
    ManagedKeyDevice, ManagedKeyError, PendingKey, manual_install_command,
};

/// Route: `GET /api/v1/agents/{agent}/ssh-host-key` probes the host key the device presents
/// so the user can confirm it before any credential is sent.
pub(crate) async fn get_host_key_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<SshHostKeyResponse>, ApiError> {
    // A probe writes temporary state too; edits or deletion must not race that write.
    let _operation = state.ssh_key_operations.begin(&agent_id)?;
    log_failure(
        "Reading the SSH host key",
        &agent_id,
        probe_host_key(&state, &agent_id).await,
    )
    .map(Json)
}

/// The probe itself, separate from the handler so its failures are logged in one place.
async fn probe_host_key(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<SshHostKeyResponse, ApiError> {
    let device = managed_key_device(state, agent_id).await?;
    let probed = device.probe_host_key().await?;
    Ok(SshHostKeyResponse {
        key_type: probed.key.key_type(),
        fingerprint: probed.key.fingerprint(),
        previously_trusted: probed.previously_trusted,
        pinned_fingerprint: probed.pinned.map(|key| key.fingerprint()),
    })
}

/// Route: `POST /api/v1/agents/{agent}/ssh-host-key/pin` replaces the pinned host key after
/// the user confirmed a host key change. Never done automatically.
pub(crate) async fn pin_host_key_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<PinSshHostKeyRequest>,
) -> Result<Json<SshHostKeyPinResponse>, ApiError> {
    let operation = state.ssh_key_operations.begin(&agent_id)?;
    complete_operation(async move {
        let _operation = operation;
        let pinned = pin_host_key(&state, &agent_id, &request).await;
        log_failure("Pinning the SSH host key", &agent_id, pinned).map(Json)
    })
    .await
}

/// The re-pin itself, kept out of the `complete_operation` closure so rustfmt formats it.
async fn pin_host_key(
    state: &ServerState,
    agent_id: &AgentId,
    request: &PinSshHostKeyRequest,
) -> Result<SshHostKeyPinResponse, ApiError> {
    let device = managed_key_device(state, agent_id).await?;
    let key = device.pin_host_key(&request.host_key_fingerprint).await?;
    Ok(SshHostKeyPinResponse {
        key_type: key.key_type(),
        fingerprint: key.fingerprint(),
    })
}

/// Route: `POST /api/v1/agents/{agent}/ssh-key` sets up the device's managed key, or rotates
/// it when the device already has one.
///
/// The new key becomes current only after it is installed and verified, so a failure at any
/// earlier step leaves the device as it was.
pub(crate) async fn enroll_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<EnrollSshKeyRequest>,
) -> Result<Json<SshKeyEnrollmentResponse>, ApiError> {
    let operation = state.ssh_key_operations.begin(&agent_id)?;
    complete_operation(async move {
        let _operation = operation;
        let enrolled = enroll(&state, &agent_id, request).await;
        log_failure("Setting up the managed SSH key", &agent_id, enrolled).map(Json)
    })
    .await
}

/// The enrollment itself, kept out of the `complete_operation` closure so rustfmt formats it.
async fn enroll(
    state: &ServerState,
    agent_id: &AgentId,
    request: EnrollSshKeyRequest,
) -> Result<SshKeyEnrollmentResponse, ApiError> {
    // Choosing the automatic setup abandons a manual one.
    state.manual_ssh_keys.discard(agent_id);
    let config = find_ssh_agent(state, agent_id).await?;
    let device = managed_key_device_for(state, config.clone())?;
    let seal = vault_seal(state, request.vault).await?;
    let rotated = config.managed_ssh_key;
    // The current key logs in for a rotation; resolved before anything changes.
    let current = if rotated {
        Some(
            operation_credential(state, &device, request.current_file_key.as_deref())
                .await?
                .ok_or_else(|| {
                    ssh_key_locked("Unlock the vault to rotate this device's SSH key")
                })?,
        )
    } else {
        None
    };
    // Wrapped right away so the typed password is wiped when the enrollment drops it.
    let password = request
        .password
        .filter(|password| !password.is_empty())
        .map(Zeroizing::new);
    log!(
        Level::Info,
        "Setting up managed SSH key: device={}, rotation={}, encrypted={}, typed_password={}",
        agent_id,
        rotated,
        seal.is_some(),
        password.is_some()
    );
    let pending = device
        .install_new_key(
            request.host_key_fingerprint.as_deref(),
            password,
            current.as_ref(),
            seal.as_ref(),
        )
        .await?;
    let fingerprint = pending.key().fingerprint();
    if rotated {
        let new_key = match commit_rotation(state, agent_id, &config, &device, &pending).await {
            Ok(key) => key,
            Err(error) => {
                device.rollback(pending).await;
                return Err(error);
            }
        };
        // The bootstrap credential is no longer needed once the new key is current.
        drop(pending);
        device.finish_rotation(&new_key).await;
    } else {
        let runtime_error =
            match commit_key(state, agent_id, &config, Some((&device, &pending))).await {
                Ok(error) => error,
                Err(error) => {
                    device.rollback(pending).await;
                    return Err(error);
                }
            };
        drop(pending);
        if let Some(error) = runtime_error {
            return Err(saved_but_not_registered("The SSH key was set up", error));
        }
    }
    log!(
        Level::Info,
        "Managed SSH key in use: device={}, fingerprint={}",
        agent_id,
        fingerprint
    );
    Ok(SshKeyEnrollmentResponse {
        fingerprint,
        rotated,
    })
}

/// Route: `POST /api/v1/agents/{agent}/ssh-key/manual` starts a manual setup: pins the host
/// key, generates the device's first key and returns the line the user adds to the device.
///
/// The key is kept only in the server's memory until the confirmation verified it, so it
/// never becomes the device's key unverified, and abandoning the setup leaves nothing.
pub(crate) async fn prepare_manual_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<PrepareManualSshKeyRequest>,
) -> Result<Json<ManualSshKeyResponse>, ApiError> {
    let operation = state.ssh_key_operations.begin(&agent_id)?;
    complete_operation(async move {
        let _operation = operation;
        let prepared = prepare_manual(&state, &agent_id, request).await;
        log_failure("Preparing a manual SSH key setup", &agent_id, prepared).map(Json)
    })
    .await
}

/// The manual preparation itself, kept out of the `complete_operation` closure so rustfmt
/// formats it.
async fn prepare_manual(
    state: &ServerState,
    agent_id: &AgentId,
    request: PrepareManualSshKeyRequest,
) -> Result<ManualSshKeyResponse, ApiError> {
    // A new attempt replaces an earlier one, also when this one fails.
    state.manual_ssh_keys.discard(agent_id);
    let config = find_ssh_agent(state, agent_id).await?;
    let device = managed_key_device_for(state, config.clone())?;
    let seal = vault_seal(state, request.vault).await?;
    let vault_key_id = seal.as_ref().map(|seal| seal.key_id.clone());
    let generated = device
        .prepare_manual_key(request.host_key_fingerprint.as_deref(), seal.as_ref())
        .await?;
    let line = generated.key.authorized_keys_line().await;
    let response = ManualSshKeyResponse {
        fingerprint: generated.key.fingerprint(),
        install_command: manual_install_command(&line),
        authorized_keys_line: line,
    };
    state.manual_ssh_keys.insert(
        agent_id,
        ManualSshKey {
            generated,
            enrolled_for: config,
            vault_key_id,
        },
    );
    Ok(response)
}

/// Route: `POST /api/v1/agents/{agent}/ssh-key/manual/confirm` verifies that the pending
/// manual key logs in and makes it the device's key, like the automatic setup's commit.
///
/// A failed verification keeps the pending key, so the user can fix the line on the device
/// and confirm again without copying a new command.
pub(crate) async fn confirm_manual_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<ConfirmManualSshKeyRequest>,
) -> Result<Json<SshKeyEnrollmentResponse>, ApiError> {
    let operation = state.ssh_key_operations.begin(&agent_id)?;
    complete_operation(async move {
        let _operation = operation;
        let confirmed = confirm_manual(&state, &agent_id, &request.fingerprint).await;
        log_failure("Confirming the manual SSH key setup", &agent_id, confirmed).map(Json)
    })
    .await
}

/// The confirmation itself, kept out of the `complete_operation` closure so rustfmt formats
/// it.
async fn confirm_manual(
    state: &ServerState,
    agent_id: &AgentId,
    fingerprint: &str,
) -> Result<SshKeyEnrollmentResponse, ApiError> {
    let pending = state
        .manual_ssh_keys
        .take(agent_id, fingerprint)
        .ok_or_else(|| {
            ApiError::not_found(
                "This SSH key setup is no longer pending (it was cancelled, replaced or the server restarted). Start the SSH key setup again.",
            )
        })?;
    let config = find_ssh_agent(state, agent_id).await?;
    // Checked before logging in, so a stale setup never verifies against another account.
    if config.managed_ssh_key {
        return Err(ApiError::conflict(
            "The device got a managed SSH key during the manual setup",
        ));
    }
    if config.target != pending.enrolled_for.target
        || config.username != pending.enrolled_for.username
    {
        return Err(ApiError::conflict(
            "The device's target or username changed during the SSH key setup. Start the SSH key setup again.",
        ));
    }
    check_vault_unchanged(state, pending.vault_key_id.as_deref()).await?;
    let device = managed_key_device_for(state, config)?;
    log!(
        Level::Info,
        "Verifying manually installed SSH key: device={}, fingerprint={}",
        agent_id,
        fingerprint
    );
    let pending_key = match device.finish_manual_key(&pending.generated).await {
        Ok(pending_key) => pending_key,
        Err(error) => {
            // The user may not have added the line yet, or added it for another account;
            // the same key can be confirmed again once they fixed it.
            state.manual_ssh_keys.insert(agent_id, pending);
            return Err(error.into());
        }
    };
    let runtime_error = match commit_key(
        state,
        agent_id,
        &pending.enrolled_for,
        Some((&device, &pending_key)),
    )
    .await
    {
        Ok(error) => error,
        Err(error) => {
            device.rollback(pending_key).await;
            return Err(error);
        }
    };
    let fingerprint = pending_key.key().fingerprint();
    drop(pending_key);
    if let Some(error) = runtime_error {
        return Err(saved_but_not_registered("The SSH key was set up", error));
    }
    log!(
        Level::Info,
        "Managed SSH key in use: device={}, fingerprint={}, installed=manually",
        agent_id,
        fingerprint
    );
    Ok(SshKeyEnrollmentResponse {
        fingerprint,
        rotated: false,
    })
}

/// Refuses to commit a manual key whose vault seal no longer matches the account's vault.
///
/// The key was sealed when the setup started; a vault created, replaced or rotated since
/// would otherwise get a plaintext key or one under a generation that a running vault
/// rotation does not rewrap.
async fn check_vault_unchanged(
    state: &ServerState,
    vault_key_id: Option<&str>,
) -> Result<(), ApiError> {
    let current_key_id = state
        .vault
        .summary()
        .await?
        .map(|summary| summary.current_key_id);
    if current_key_id.as_deref() == vault_key_id {
        return Ok(());
    }
    Err(ApiError::conflict(
        "The vault changed during the SSH key setup. Start the SSH key setup again.",
    ))
}

/// Route: `DELETE /api/v1/agents/{agent}/ssh-key/manual` discards the pending manual key
/// when the user abandons the setup, so the private key does not linger in memory.
///
/// A line the user may already have added stays on the device; it grants nothing, because
/// the private key is gone, and the next setup's `authorized_keys` rewrite drops it.
pub(crate) async fn discard_manual_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<StatusCode, ApiError> {
    let _operation = state.ssh_key_operations.begin(&agent_id)?;
    if state.manual_ssh_keys.discard(&agent_id) {
        log!(
            Level::Info,
            "Discarded a pending manual SSH key setup: device={}",
            agent_id
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Route: `DELETE /api/v1/agents/{agent}/ssh-key` removes the key from the device when it
/// can be reached, then always from the config and locally. The pinned host key stays, so
/// setting up a key again does not ask for confirmation.
///
/// An encrypted key logs in with the file key in the optional body or the held key; without
/// either the removal is local only and reports `removed_from_device: false`.
pub(crate) async fn remove_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    request: Option<Json<RemoveSshKeyRequest>>,
) -> Result<Json<SshKeyRemovalResponse>, ApiError> {
    let request = request.map(|Json(request)| request).unwrap_or_default();
    let operation = state.ssh_key_operations.begin(&agent_id)?;
    complete_operation(async move {
        let _operation = operation;
        let removed = remove_key(&state, &agent_id, request.current_file_key.as_deref()).await;
        log_failure("Removing the managed SSH key", &agent_id, removed).map(Json)
    })
    .await
}

/// The removal itself, kept out of the `complete_operation` closure so rustfmt formats it.
async fn remove_key(
    state: &ServerState,
    agent_id: &AgentId,
    current_file_key: Option<&str>,
) -> Result<SshKeyRemovalResponse, ApiError> {
    let config = find_ssh_agent(state, agent_id).await?;
    if !config.managed_ssh_key {
        return Err(ApiError::not_found(format!(
            "Device '{agent_id}' has no managed SSH key"
        )));
    }
    let device = managed_key_device_for(state, config.clone())?;
    // Resolved before the commit stops the device and releases a held key.
    let credential = removal_credential(state, &device, current_file_key).await?;
    // Persist first: a config write failure must not revoke the still-configured key.
    let runtime_error = commit_key(state, agent_id, &config, None).await?;
    let device_error = device.remove_from_device(credential.as_ref()).await;
    if let Some(error) = &device_error {
        redoor_core::log_failure!(
            Level::Warn,
            "Could not remove the managed SSH key from the device; deleting it locally anyway: device={}, error={}",
            agent_id,
            error
        );
    }
    // The config stops using the key before its files go away.
    state
        .ssh_keys
        .delete_keys(agent_id)
        .await
        .map_err(|error| {
            ApiError::internal(format!("Failed to delete the local SSH key: {error}"))
        })?;
    if let Some(error) = runtime_error {
        return Err(saved_but_not_registered("The SSH key was removed", error));
    }
    log!(
        Level::Info,
        "Removed managed SSH key: device={}, removed_from_device={}",
        agent_id,
        device_error.is_none()
    );
    Ok(SshKeyRemovalResponse {
        removed_from_device: device_error.is_none(),
        device_error,
    })
}

/// Logs a failed key or host key operation with the exact message the browser gets, so a
/// failure a user reports can be traced in the server log without reproducing it.
///
/// Failures of the device, the network or the server are logged as errors; requests the
/// user fixes by changing the input (a missing confirmation or password) as warnings.
fn log_failure<T>(
    operation: &str,
    agent_id: &AgentId,
    result: Result<T, ApiError>,
) -> Result<T, ApiError> {
    if let Err(error) = &result {
        let status = error.status_code();
        if status.is_server_error() {
            redoor_core::log_failure!(
                Level::Error,
                "{} failed: device={}, status={}, error={}",
                operation,
                agent_id,
                status.as_u16(),
                error
            );
        } else {
            log!(
                Level::Warning,
                "{} failed: device={}, status={}, error={}",
                operation,
                agent_id,
                status.as_u16(),
                error
            );
        }
    }
    result
}

/// Explains a failure that happened after the config was already written, so the user does
/// not read it as "nothing changed" and retry an operation that in fact succeeded.
fn saved_but_not_registered(done: &str, error: ApiError) -> ApiError {
    ApiError::status(
        error.status_code(),
        format!(
            "{done} and the config was saved, but the device could not be registered again: {error}. Restart the server to load the device."
        ),
    )
}

/// Loads the device's config entry for a key operation.
async fn managed_key_device(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<ManagedKeyDevice, ApiError> {
    managed_key_device_for(state, find_ssh_agent(state, agent_id).await?)
}

/// The key operations of a config entry.
pub(super) fn managed_key_device_for(
    state: &ServerState,
    config: SshBackedAgentConfig,
) -> Result<ManagedKeyDevice, ApiError> {
    ManagedKeyDevice::new(
        config,
        Some(state.ssh_keys.clone()),
        state.held_ssh_keys.clone(),
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))
}

/// The error for an encrypted key that is neither held nor unlocked by the request.
pub(super) fn ssh_key_locked(message: &str) -> ApiError {
    ApiError::coded(StatusCode::CONFLICT, ApiErrorCode::SshKeyLocked, message)
}

/// Maps a failure to open an encrypted key to the error the UI shows for it.
fn open_error(error: SshKeyOpenError) -> ApiError {
    match error {
        SshKeyOpenError::Format(error) => format_error(error),
        SshKeyOpenError::Mismatch(message) => ApiError::coded(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::VaultHeaderTampered,
            message,
        ),
    }
}

/// Decrypts the device's encrypted key with a file key sent by the browser: the header must
/// belong to the account's vault (current or chained generation), then the MAC, the binding
/// and the public key are checked. Never stored; callers decide whether to hold it.
async fn unlock_with_file_key(
    state: &ServerState,
    device: &ManagedKeyDevice,
    file: &crate::ssh::encrypted_keys::EncryptedKeyFile,
    encoded_file_key: &str,
) -> Result<ManagedKey, ApiError> {
    let key = file_key(encoded_file_key)?;
    state.vault.require_readable(file.header()).await?;
    device.unlock(file, &key).await.map_err(open_error)
}

/// The operation credential of the device's current key for a rotation: the plaintext key,
/// or an encrypted key decrypted from the request's file key or cloned from the held key.
/// `None` when the key is encrypted and neither is available.
///
/// It lives only for the request and is never put into the held keys, so rotating or
/// removing a stopped device does not make it startable with an access token.
async fn operation_credential(
    state: &ServerState,
    device: &ManagedKeyDevice,
    current_file_key: Option<&str>,
) -> Result<Option<ManagedKey>, ApiError> {
    let stored = device.stored_key().await.map_err(|error| {
        ApiError::from(ManagedKeyError::Input(format!(
            "The current SSH key of this device cannot be read from the server's data directory ({error}). Remove the key and set it up again."
        )))
    })?;
    match stored {
        StoredKey::Plaintext(key) => Ok(Some(key)),
        StoredKey::Encrypted(file) => match current_file_key {
            Some(encoded) => unlock_with_file_key(state, device, &file, encoded)
                .await
                .map(Some),
            None => Ok(device.held_key()),
        },
    }
}

/// The operation credential for removing a key or deleting its device. A key that cannot
/// be read is no reason to keep the device configured: the removal then only cleans up
/// locally, like for an unreachable device. A wrong file key is still an error, because the
/// user meant to unlock it.
pub(super) async fn removal_credential(
    state: &ServerState,
    device: &ManagedKeyDevice,
    current_file_key: Option<&str>,
) -> Result<Option<ManagedKey>, ApiError> {
    match device.stored_key().await {
        Ok(StoredKey::Plaintext(key)) => Ok(Some(key)),
        Ok(StoredKey::Encrypted(file)) => match current_file_key {
            Some(encoded) => unlock_with_file_key(state, device, &file, encoded)
                .await
                .map(Some),
            None => Ok(device.held_key()),
        },
        Err(error) => {
            redoor_core::log_failure!(
                Level::Warn,
                "The managed SSH key cannot be read, so it is removed only locally: error={}",
                error
            );
            Ok(None)
        }
    }
}

/// Checks the browser's vault seal against the account's vault: an account with a vault
/// must encrypt new keys with it, and an account without one cannot.
async fn vault_seal(
    state: &ServerState,
    seal: Option<SshKeyVaultSeal>,
) -> Result<Option<SshKeySeal>, ApiError> {
    let has_vault = state.vault.summary().await?.is_some();
    match (has_vault, seal) {
        (false, None) => Ok(None),
        (false, Some(_)) => Err(ApiError::bad_request(
            "This account has no vault to encrypt the SSH key with",
        )),
        (true, None) => Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::VaultRequired,
            "This account has a vault, so the SSH key must be encrypted with it; unlock the vault",
        )),
        (true, Some(seal)) => {
            let document = state.vault.require_current(&seal.key_id).await?;
            if seal.vault_id != document.vault_id {
                return Err(ApiError::coded(
                    StatusCode::CONFLICT,
                    ApiErrorCode::StaleVaultKey,
                    "The vault was replaced; unlock the vault again",
                ));
            }
            Ok(Some(SshKeySeal {
                vault_id: document.vault_id,
                vault_label: document.label,
                key_id: seal.key_id,
                file_key: file_key(&seal.file_key)?,
                wrap: seal.file_key_wrap,
            }))
        }
    }
}

/// Route: `GET /api/v1/agents/{agent}/ssh-key` reports how the device's key is stored:
/// encrypted or not, held or not, and an encrypted key's header for the browser's unwrap.
pub(crate) async fn status_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<SshKeyStatusResponse>, ApiError> {
    let config = find_ssh_agent(&state, &agent_id).await?;
    let mut status = SshKeyStatusResponse {
        managed: config.managed_ssh_key,
        fingerprint: None,
        encrypted: false,
        held: false,
        vault_header: None,
        key_status: None,
        problem: None,
    };
    if !config.managed_ssh_key {
        return Ok(Json(status));
    }
    let device = managed_key_device_for(&state, config)?;
    match device.stored_key().await {
        Ok(stored) => {
            status.fingerprint = Some(stored.fingerprint());
            if let StoredKey::Encrypted(file) = stored {
                status.encrypted = true;
                status.held = device.held_key().is_some();
                status.key_status = Some(state.vault.key_status(file.header()).await?);
                status.vault_header = Some(file.header().clone());
            }
        }
        Err(error) => status.problem = Some(error.to_string()),
    }
    Ok(Json(status))
}

/// Makes a Start of a device with an encrypted key possible: holds the key decrypted from
/// `file_key`, unless the server already holds it. Without either, the start fails at once
/// with `ssh_key_locked`, before the watchdog is touched. Devices with a plaintext key or
/// no managed key need nothing. Called under the config edit lock, like Stop.
pub(super) async fn unlock_for_start(
    state: &ServerState,
    agent_id: &AgentId,
    file_key: Option<&str>,
) -> Result<(), ApiError> {
    let Some(AgentConfig::SshBacked(config)) = find_configured_agent(state, agent_id).await? else {
        return Ok(());
    };
    if !config.managed_ssh_key {
        return Ok(());
    }
    let device = managed_key_device_for(state, config)?;
    // A missing or broken key is reported by the watchdog like before.
    let Ok(StoredKey::Encrypted(file)) = device.stored_key().await else {
        return Ok(());
    };
    if device.held_key().is_some() {
        return Ok(());
    }
    let Some(file_key) = file_key else {
        return Err(ssh_key_locked(
            "The device's SSH key is encrypted with the vault. Start it from the browser to unlock it.",
        ));
    };
    let key = unlock_with_file_key(state, &device, &file, file_key).await?;
    state
        .held_ssh_keys
        .hold(agent_id, key.private_key().clone());
    log!(
        Level::Info,
        "Holding the decrypted SSH key while the device runs: device={}, fingerprint={}",
        agent_id,
        key.fingerprint()
    );
    Ok(())
}

/// Commits a first key (`first_key` is `Some`) or a removal (`None`) to the config: sets
/// `managed_ssh_key` accordingly and always drops the stored password. A device uses either a
/// password or a managed key, never both, and keeping the password would also re-enable
/// askpass, which contradicts the managed-key policy.
///
/// A first key is renamed into place (and the rename synced) before the config write, so a
/// crash in between leaves at worst an unused key file, never a config that claims a key
/// that does not exist. If the config write fails, the key file is deleted again and the
/// caller rolls back the remote line; a crash leftover is overwritten by the next setup.
///
/// The config edit lock is held only for this write, not the whole flow, because it blocks
/// device starts and the flow includes network round trips. The device's target and
/// username are checked again under it, because a key installed for one account must not be
/// recorded for another.
/// An outer error means persistence did not happen. A runtime error is returned inside
/// `Ok` so callers preserve the durably referenced key and finish cleanup before reporting it.
async fn commit_key(
    state: &ServerState,
    agent_id: &AgentId,
    enrolled_for: &SshBackedAgentConfig,
    first_key: Option<(&ManagedKeyDevice, &PendingKey)>,
) -> Result<Option<ApiError>, ApiError> {
    let _edit_guard = state.config_edit_lock.lock().await;
    let mut config = find_ssh_agent(state, agent_id).await?;
    if config.target != enrolled_for.target || config.username != enrolled_for.username {
        return Err(ApiError::conflict(
            "The device's target or username changed during the SSH key setup",
        ));
    }
    config.managed_ssh_key = first_key.is_some();
    config.password = None;
    let agent_config = AgentConfig::SshBacked(config.clone());
    let name = agent_config.effective_name();
    with_name_reserved(state, agent_id, &name, async {
        stop_for_configuration_change(state, agent_id).await?;
        if let Some((device, pending)) = first_key {
            device.commit(pending).await.map_err(|error| {
                ApiError::internal(format!("Failed to save the new SSH key: {error}"))
            })?;
        }
        if let Err(error) = edit_ssh_agent(&state.config_path, agent_id, Some(&config)).await {
            if first_key.is_some() {
                discard_uncommitted_key(state, agent_id).await;
            }
            return Err(ApiError::internal(format!(
                "Failed to save the SSH key setting to {}: {error:#}",
                state.config_path.display()
            )));
        }
        // Once persistence succeeds, this key must survive even if the runtime cannot
        // register it. Return that error separately so callers finish cleanup without rollback.
        Ok(replace_runtime_agent(state, agent_id, agent_config, None)
            .await
            .err())
    })
    .await
}

/// Deletes a first key that was renamed into place but never recorded in the config, so no
/// private key stays around for a device that does not use it. Logged instead of returned:
/// the config write error is what the user needs to see, and the next setup overwrites a
/// leftover anyway.
async fn discard_uncommitted_key(state: &ServerState, agent_id: &AgentId) {
    if let Err(error) = state.ssh_keys.delete_keys(agent_id).await {
        redoor_core::log_failure!(
            Level::Warn,
            "Failed to delete an SSH key whose config write failed: device={}, error={}",
            agent_id,
            error
        );
    }
}

/// Makes a rotated key current with one atomic file rename and no config write.
///
/// The config already says the device uses its managed key and every agent start loads the
/// key file again, so the next start picks up the new key. Skipping the config write means a
/// connected agent is not stopped; its ssh session authenticated already and keeps working.
/// The config edit lock is held only to check, like [`commit_key`], that the device was not
/// pointed at another account or had its key removed meanwhile.
async fn commit_rotation(
    state: &ServerState,
    agent_id: &AgentId,
    enrolled_for: &SshBackedAgentConfig,
    device: &ManagedKeyDevice,
    pending: &PendingKey,
) -> Result<ManagedKey, ApiError> {
    let _edit_guard = state.config_edit_lock.lock().await;
    let config = find_ssh_agent(state, agent_id).await?;
    if config.target != enrolled_for.target
        || config.username != enrolled_for.username
        || !config.managed_ssh_key
    {
        return Err(ApiError::conflict(
            "The device's target, username or SSH key changed during the SSH key rotation",
        ));
    }
    // Checked under the lock Stop uses, so a concurrent Stop wins and a stopped device stays
    // unheld. A running device keeps reconnecting with the new key, also after a rotation
    // from plaintext, which held nothing before. The new key is held before the rename, so
    // a watchdog reconnect never finds an encrypted key file without a held key; the old
    // and the new key both log in until the old line is removed after the commit.
    let running = state
        .watchdog_registry
        .lookup(agent_id.as_str())
        .is_some_and(|watchdog| watchdog.snapshot().desired_running);
    let previous = state.held_ssh_keys.get(agent_id);
    let hold_new = pending.is_encrypted() && running;
    if hold_new {
        state
            .held_ssh_keys
            .hold(agent_id, pending.key().private_key().clone());
    }
    let key = match device.commit(pending).await {
        Ok(key) => key,
        Err(error) => {
            // A failed rotation leaves the held key as it was.
            match previous {
                Some(previous) => state.held_ssh_keys.hold(agent_id, previous),
                None => state.held_ssh_keys.release(agent_id),
            }
            return Err(ApiError::internal(format!(
                "Failed to switch to the new SSH key: {error}"
            )));
        }
    };
    if !hold_new {
        state.held_ssh_keys.release(agent_id);
    }
    Ok(key)
}

/// Lets mutations finish after a browser disconnects, keeping their busy guard and
/// bootstrap credential alive until commit or rollback and all local cleanup complete.
pub(super) async fn complete_operation<T: Send + 'static>(
    operation: impl std::future::Future<Output = Result<T, ApiError>> + Send + 'static,
) -> Result<T, ApiError> {
    redoor_core::logging::spawn_in_user_scope(operation)
        .await
        .map_err(|error| ApiError::internal(format!("SSH key operation task failed: {error}")))?
}

impl From<ManagedKeyError> for ApiError {
    /// Maps each failure to the status the UI needs to choose its message.
    fn from(error: ManagedKeyError) -> Self {
        match &error {
            ManagedKeyError::Input(_) => ApiError::bad_request(error.to_string()),
            ManagedKeyError::HostKeyMismatch(_) => ApiError::conflict(error.to_string()),
            ManagedKeyError::Remote(_) => {
                ApiError::status(StatusCode::BAD_GATEWAY, error.to_string())
            }
            ManagedKeyError::Local(_) => ApiError::internal(error.to_string()),
        }
    }
}

/// Devices with a key or host key operation in progress.
///
/// Enrollment, rotation, removal, re-pinning and device edits of one device would race over
/// `authorized_keys`, the key directory and the config, so a second request for the same
/// device gets 409 instead of waiting behind network round trips.
#[derive(Clone, Default)]
pub(crate) struct SshKeyOperations {
    /// Ids of the devices that are busy.
    busy: Arc<Mutex<HashSet<AgentId>>>,
}

impl SshKeyOperations {
    /// Marks the device busy until the returned guard is dropped, or fails with 409.
    pub(crate) fn begin(&self, agent_id: &AgentId) -> Result<SshKeyOperation, ApiError> {
        let mut busy = self
            .busy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !busy.insert(agent_id.clone()) {
            log!(
                Level::Warning,
                "Refused an SSH key operation because another one is running: device={}",
                agent_id
            );
            return Err(ApiError::conflict(format!(
                "An SSH key operation is already running for device '{agent_id}'"
            )));
        }
        Ok(SshKeyOperation {
            busy: self.busy.clone(),
            agent_id: agent_id.clone(),
        })
    }
}

/// Keeps one device marked busy while alive.
pub(crate) struct SshKeyOperation {
    /// Shared set the device is removed from on drop.
    busy: Arc<Mutex<HashSet<AgentId>>>,
    /// The busy device.
    agent_id: AgentId,
}

impl Drop for SshKeyOperation {
    /// Frees the device, also when the request is cancelled mid-flight.
    fn drop(&mut self) {
        self.busy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.agent_id);
    }
}

/// A manual setup's generated key while the user adds it to the device.
pub(crate) struct ManualSshKey {
    /// The key and its key file content, written only after verification.
    generated: GeneratedKey,
    /// The config the key was generated for; the commit refuses another target or account.
    enrolled_for: SshBackedAgentConfig,
    /// The vault generation the key is sealed with, `None` for a plaintext key, so the
    /// confirmation can refuse a key the vault changed under.
    vault_key_id: Option<String>,
}

/// Pending manual setups, at most one per device, kept in memory only.
///
/// They live across two requests, unlike everything [`SshKeyOperations`] guards, so the
/// busy set alone cannot protect them; every access happens under a device's busy guard,
/// though, so a confirmation never races a new preparation of the same device. A restart
/// forgets them, which only means the user starts the setup again.
#[derive(Clone, Default)]
pub(crate) struct ManualSshKeys {
    /// The pending key of each device in a manual setup.
    pending: Arc<Mutex<HashMap<AgentId, ManualSshKey>>>,
}

impl ManualSshKeys {
    /// Locks the map; a poisoned lock still holds a consistent map, because no access
    /// panics half way through an update.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<AgentId, ManualSshKey>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Makes `key` the device's pending key, replacing an earlier one.
    fn insert(&self, agent_id: &AgentId, key: ManualSshKey) {
        self.lock().insert(agent_id.clone(), key);
    }

    /// Removes and returns the device's pending key when its fingerprint is `fingerprint`,
    /// so a dialog left open from an earlier attempt cannot confirm a newer key.
    fn take(&self, agent_id: &AgentId, fingerprint: &str) -> Option<ManualSshKey> {
        let mut pending = self.lock();
        if pending
            .get(agent_id)
            .is_none_or(|key| key.generated.key.fingerprint() != fingerprint)
        {
            return None;
        }
        pending.remove(agent_id)
    }

    /// Drops the device's pending key, if any, and reports whether there was one. Also used
    /// when the device is edited or deleted, which makes a pending setup meaningless.
    pub(crate) fn discard(&self, agent_id: &AgentId) -> bool {
        self.lock().remove(agent_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lost HTTP waiter must neither interrupt cleanup nor release the per-device guard.
    #[tokio::test]
    async fn cancelled_waiter_keeps_operation_alive_until_cleanup() {
        let operations = SshKeyOperations::default();
        let device = AgentId::generate();
        let operation = operations.begin(&device).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let (cleaned_tx, cleaned_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(complete_operation(async move {
            started_tx.send(()).unwrap();
            finish_rx.await.unwrap();
            drop(operation);
            cleaned_tx.send(()).unwrap();
            Ok(())
        }));
        started_rx.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        // The detached mutation still owns the busy guard while cleanup is pending.
        assert!(operations.begin(&device).is_err());
        finish_tx.send(()).unwrap();
        cleaned_rx.await.unwrap();
        // A new request may proceed only after the previous mutation has finished cleanup.
        assert!(operations.begin(&device).is_ok());
    }
}
