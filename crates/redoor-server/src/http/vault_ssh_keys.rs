//! Vault rotation support for managed SSH keys encrypted with the vault.
//!
//! Encrypted SSH keys live on the server at known paths, so the device scan in the vault
//! settings does not find them. These routes list them and move them to the current key
//! generation, and destroying a generation is refused while an SSH key still uses it.
//! Session-only like every vault route.

use std::collections::HashMap;

use axum::{Json, extract::State as AxumState, http::StatusCode};
use redoor_core::log;
use redoor_protocol::api::ssh_keys::{
    RewrapSshKeyRequest, SshKeyStatusResponse, VaultSshKey, VaultSshKeysResponse,
};
use redoor_protocol::api::vault::ApiErrorCode;
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::log::Level;

use super::access::ResolvedDevice;
use super::agents::list_agent_snapshots;
use super::ssh_keys::{account_keys, complete_operation, status_handler};
use super::vault_files::{file_key, format_error};
use super::{error::ApiError, state::ServerState};
use crate::ssh::keys::StoredKey;

/// Route: `GET /api/v1/vault/ssh-keys` lists the account's encrypted SSH keys with their
/// generation, so the settings page can rewrap them after a rotation.
pub(crate) async fn list_handler(
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<VaultSshKeysResponse>, ApiError> {
    let names: HashMap<AgentId, String> = list_agent_snapshots(&state)
        .await?
        .into_iter()
        .map(|agent| (agent.id, agent.name))
        .collect();
    let mut keys = Vec::new();
    for (device, file) in encrypted_keys(&state).await? {
        keys.push(VaultSshKey {
            device_name: names.get(&device).cloned(),
            device_id: device.to_string(),
            key_status: state.vault.key_status(file.header()).await?,
            header: file.header().clone(),
        });
    }
    keys.sort_by(|left, right| {
        left.device_name
            .cmp(&right.device_name)
            .then_with(|| left.device_id.cmp(&right.device_id))
    });
    Ok(Json(VaultSshKeysResponse { keys }))
}

/// Route: `POST /api/v1/agents/{agent}/ssh-key/rewrap` moves the device's encrypted key to
/// the current generation by replacing only its header. The old MAC is checked with the
/// file key first, which proves the key belongs to this file; the payload is copied
/// unchanged and a held key is unaffected. Answers with the key's new status.
pub(crate) async fn rewrap_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<RewrapSshKeyRequest>,
) -> Result<Json<SshKeyStatusResponse>, ApiError> {
    let operation = state.ssh_key_operations.begin(&agent_id)?;
    let rewrap_state = state.clone();
    let rewrap_agent = agent_id.clone();
    complete_operation(async move {
        let _operation = operation;
        rewrap(&rewrap_state, &rewrap_agent, request).await
    })
    .await?;
    status_handler(ResolvedDevice(agent_id), AxumState(state)).await
}

/// The rewrap itself, kept out of the `complete_operation` closure so rustfmt formats it.
async fn rewrap(
    state: &ServerState,
    agent_id: &AgentId,
    request: RewrapSshKeyRequest,
) -> Result<(), ApiError> {
    let key = file_key(&request.file_key)?;
    let document = state.vault.require_current(&request.key_id).await?;
    let keys = account_keys(state)?;
    let StoredKey::Encrypted(file) = keys
        .load(agent_id)
        .await
        .map_err(|error| ApiError::not_found(format!("No encrypted SSH key: {error}")))?
    else {
        return Err(ApiError::bad_request(
            "The device's SSH key is not encrypted with the vault",
        ));
    };
    state.vault.require_readable(file.header()).await?;
    let bytes = file
        .rewrapped(&key, request.key_id.clone(), request.wrap, document.label)
        .map_err(format_error)?;
    keys.replace_encrypted(agent_id, &bytes)
        .await
        .map_err(|error| ApiError::internal(format!("Failed to save the SSH key: {error}")))?;
    log!(
        Level::Info,
        "Rewrapped the encrypted SSH key: device={}, key_id={}",
        agent_id,
        request.key_id
    );
    Ok(())
}

/// Refuses to destroy a generation that an encrypted SSH key still uses: the key would
/// become unreadable and the device could no longer be started. The settings page lists
/// such keys with a rewrap action.
pub(crate) async fn require_no_ssh_key_on(
    state: &ServerState,
    key_id: &str,
) -> Result<(), ApiError> {
    let devices: Vec<String> = encrypted_keys(state)
        .await?
        .into_iter()
        .filter(|(_, file)| file.header().key_id == key_id)
        .map(|(device, _)| device.to_string())
        .collect();
    if devices.is_empty() {
        return Ok(());
    }
    Err(ApiError::coded(
        StatusCode::CONFLICT,
        ApiErrorCode::VaultKeyInUse,
        format!(
            "SSH keys of these devices still use this key generation; rewrap them first: {}",
            devices.join(", ")
        ),
    ))
}

/// The account's encrypted SSH keys.
async fn encrypted_keys(
    state: &ServerState,
) -> Result<Vec<(AgentId, crate::ssh::encrypted_keys::EncryptedKeyFile)>, ApiError> {
    account_keys(state)?
        .encrypted_keys()
        .await
        .map_err(|error| ApiError::internal(format!("Failed to list the SSH keys: {error}")))
}
