//! REST endpoints for first-use migration from global single-account layout to per-user
//! workspaces (`GET /api/v1/migration`, `POST /api/v1/migration/confirm`).
//!
//! TEMPORARY MIGRATION: Can be removed once all deployed servers have upgraded to layout v2.

use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use redoor_protocol::api::migration::{ConfirmMigrationResponse, MigrationStatusResponse};

use super::{
    access::Principal, error::ApiError, state::ServerState, websocket_security::is_same_origin,
};

/// Route: `GET /api/v1/migration` reports whether first-use migration is pending and summarizes
/// the legacy global data to be moved.
///
/// TEMPORARY MIGRATION: Can be removed after layout v2 adoption.
pub(crate) async fn get_migration_status_handler(
    State(state): State<ServerState>,
) -> Json<MigrationStatusResponse> {
    Json(state.migration.status().await)
}

/// Route: `POST /api/v1/migration/confirm` migrates all legacy global data into the signed-in
/// user's workspace and activates it live.
///
/// Session-only and Origin-checked so a cross-site page cannot claim the server's legacy data
/// into an arbitrary session.
///
/// TEMPORARY MIGRATION: Can be removed after layout v2 adoption.
pub(crate) async fn confirm_migration_handler(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Result<Json<ConfirmMigrationResponse>, ApiError> {
    if !is_same_origin(&headers) {
        return Err(ApiError::status(
            StatusCode::FORBIDDEN,
            "Cross-origin migration confirmation is not allowed",
        ));
    }
    let user = principal.session_user()?;
    let response = state.migration.confirm(&state, &user.name).await?;
    Ok(Json(response))
}
