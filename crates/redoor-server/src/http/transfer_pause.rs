//! Pause waits for destination durability before returning control to the browser.

use super::{
    access::Principal, error::ApiError, state::ServerState,
    transfer_progress::require_transfer_write,
};
use crate::actors::router::RouterMsg;
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use redoor_protocol::{api::transfers::PauseTransferResponse, ids::TransferId};

/// The router removes the transfer only after its destination acknowledges durable storage.
pub(crate) async fn pause(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<u64>,
) -> Result<Json<PauseTransferResponse>, ApiError> {
    let transfer_id = TransferId::new(id);
    require_transfer_write(&state, &principal, transfer_id).await?;
    let owner = principal.owner().to_string();
    state
        .router_ref
        .request(|reply| RouterMsg::PauseTransfer {
            owner,
            transfer_id,
            reply,
        })
        .await?
        .map_err(ApiError::conflict)?;
    Ok(Json(PauseTransferResponse { transfer_id }))
}
