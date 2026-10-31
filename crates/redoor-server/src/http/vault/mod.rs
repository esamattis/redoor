//! REST handlers of the vault itself: status, unlock material, slots, rotation and backup.
//!
//! Every route is session-only (see `access::routes`): access tokens and MCP clients get no
//! vault capability. The handlers are thin; the rules live in [`crate::vault::VaultStore`].

use axum::{
    Json,
    extract::{Path, State},
    http::header,
    response::IntoResponse,
};
use redoor_protocol::api::vault::{
    AddVaultSlotRequest, CreateVaultRequest, DestroyVaultKeyRequest, RenameVaultSlotRequest,
    RestoreVaultBackupRequest, RotateVaultRequest, UpdateVaultRequest, VaultProof,
    VaultSlotUsedResponse, VaultStatusResponse, VaultUnlockMaterialResponse,
};

use super::{error::ApiError, state::ServerState};

/// Wraps a changed vault in the status response every change returns.
fn status(vault: redoor_protocol::api::vault::VaultSummary) -> Json<VaultStatusResponse> {
    Json(VaultStatusResponse { vault: Some(vault) })
}

/// Route: `GET /api/v1/vault`. Never includes wrapped keys, so ordinary page loads do not
/// fetch them.
pub(crate) async fn get_vault_handler(
    State(state): State<ServerState>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(Json(VaultStatusResponse {
        vault: state.vault.summary().await?,
    }))
}

/// Route: `POST /api/v1/vault`.
pub(crate) async fn create_vault_handler(
    State(state): State<ServerState>,
    Json(request): Json<CreateVaultRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(state.vault.create(request).await?))
}

/// Route: `PATCH /api/v1/vault` renames the vault.
pub(crate) async fn update_vault_handler(
    State(state): State<ServerState>,
    Json(request): Json<UpdateVaultRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(
        state
            .vault
            .update_label(&request.auth_proof, request.label)
            .await?,
    ))
}

/// Route: `GET /api/v1/vault/unlock-material`.
pub(crate) async fn unlock_material_handler(
    State(state): State<ServerState>,
) -> Result<Json<VaultUnlockMaterialResponse>, ApiError> {
    Ok(Json(state.vault.unlock_material().await?))
}

/// Route: `POST /api/v1/vault/slots`.
pub(crate) async fn add_slot_handler(
    State(state): State<ServerState>,
    Json(request): Json<AddVaultSlotRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(state.vault.add_slot(request).await?))
}

/// Route: `PATCH /api/v1/vault/slots/{id}`.
pub(crate) async fn rename_slot_handler(
    State(state): State<ServerState>,
    Path(slot_id): Path<String>,
    Json(request): Json<RenameVaultSlotRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(
        state
            .vault
            .rename_slot(&slot_id, &request.auth_proof, request.label)
            .await?,
    ))
}

/// Route: `DELETE /api/v1/vault/slots/{id}`; the proof travels in the JSON body.
pub(crate) async fn remove_slot_handler(
    State(state): State<ServerState>,
    Path(slot_id): Path<String>,
    Json(request): Json<VaultProof>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(
        state
            .vault
            .remove_slot(&slot_id, &request.auth_proof)
            .await?,
    ))
}

/// Route: `POST /api/v1/vault/slots/{id}/used`.
pub(crate) async fn slot_used_handler(
    State(state): State<ServerState>,
    Path(slot_id): Path<String>,
) -> Result<Json<VaultSlotUsedResponse>, ApiError> {
    Ok(Json(VaultSlotUsedResponse {
        updated: state.vault.mark_slot_used(&slot_id).await?,
    }))
}

/// Route: `POST /api/v1/vault/rotate`.
pub(crate) async fn rotate_handler(
    State(state): State<ServerState>,
    Json(request): Json<RotateVaultRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(state.vault.rotate(request).await?))
}

/// Route: `POST /api/v1/vault/keys/{key_id}/destroy`.
pub(crate) async fn destroy_key_handler(
    State(state): State<ServerState>,
    Path(key_id): Path<String>,
    Json(request): Json<DestroyVaultKeyRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(state.vault.destroy_key(&key_id, request).await?))
}

/// Route: `GET /api/v1/vault/backup`: the document as a file to keep. It holds only
/// wrapped keys, so the download is safe to store anywhere.
pub(crate) async fn export_backup_handler(
    State(state): State<ServerState>,
) -> Result<impl IntoResponse, ApiError> {
    let document = state.vault.document().await?;
    let filename = format!("redoor-vault-{}.json", document.vault_id);
    Ok((
        [(
            header::CONTENT_DISPOSITION,
            super::raw::attachment_disposition(&filename),
        )],
        Json(document),
    ))
}

/// Route: `PUT /api/v1/vault/backup`.
pub(crate) async fn restore_backup_handler(
    State(state): State<ServerState>,
    Json(request): Json<RestoreVaultBackupRequest>,
) -> Result<Json<VaultStatusResponse>, ApiError> {
    Ok(status(state.vault.restore(request).await?))
}
