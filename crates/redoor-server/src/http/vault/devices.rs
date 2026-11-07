//! REST handlers of the vault's device secrets (see [`crate::vault::devices`]).
//!
//! Session-only like every vault route, and bound to the request's login session: a browser
//! can only open, touch, check or delete the entry its own session created. The handlers are
//! thin; the rules live in the store.

use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use redoor_protocol::api::vault::{
    CreateVaultDeviceRequest, CreateVaultDeviceResponse, OpenVaultDeviceResponse,
    VaultDeviceStatusResponse,
};

use crate::http::{auth::ActiveSession, error::ApiError, state::ServerState};

/// Route: `POST /api/v1/vault/devices`. Needs no vault proof, because a random secret opens
/// nothing by itself and the browser only ever wraps a key it already holds; it does need an
/// existing vault, since there is nothing to keep unlocked otherwise.
pub(crate) async fn create_device_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
    Json(request): Json<CreateVaultDeviceRequest>,
) -> Result<Json<CreateVaultDeviceResponse>, ApiError> {
    state.vault.document().await?;
    Ok(Json(
        state.vault_devices.create(&session.id, request.lock_after),
    ))
}

/// Route: `POST /api/v1/vault/devices/{id}/open`: the secret, for a page load restoring the
/// vault. A POST, because handing out a secret should never be a cacheable or prefetchable
/// GET.
pub(crate) async fn open_device_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
    Path(device_id): Path<String>,
) -> Result<Json<OpenVaultDeviceResponse>, ApiError> {
    Ok(Json(state.vault_devices.open(&device_id, &session.id)?))
}

/// Route: `POST /api/v1/vault/devices/{id}/touch`: the vault was used, so the idle lock
/// restarts.
pub(crate) async fn touch_device_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
    Path(device_id): Path<String>,
) -> Result<Json<VaultDeviceStatusResponse>, ApiError> {
    Ok(Json(state.vault_devices.touch(&device_id, &session.id)?))
}

/// Route: `GET /api/v1/vault/devices/{id}`: whether the entry still opens, so an open tab
/// that holds keys can notice a lost entry and lock itself.
pub(crate) async fn check_device_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
    Path(device_id): Path<String>,
) -> Result<Json<VaultDeviceStatusResponse>, ApiError> {
    Ok(Json(state.vault_devices.status(&device_id, &session.id)?))
}

/// Route: `DELETE /api/v1/vault/devices/{id}`, for "Lock now". Idempotent, so a lock that
/// races another tab's lock still succeeds.
pub(crate) async fn delete_device_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
    Path(device_id): Path<String>,
) -> StatusCode {
    state.vault_devices.delete(&device_id, &session.id);
    StatusCode::NO_CONTENT
}
