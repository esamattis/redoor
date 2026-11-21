//! REST endpoint that cancels one public transfer.

use crate::actors::router::{CancelPublicTransferError, RouterMsg};
use axum::{
    Extension, Json,
    extract::{Path, State as AxumState},
};
use redoor_protocol::{api::transfers::CancelTransferResponse, ids::TransferId};

use super::{
    access::Principal, error::ApiError, state::ServerState,
    transfer_progress::require_transfer_write,
};

/// Route: `DELETE /api/v1/transfers/{transfer_id}` cancels one active transfer.
pub(crate) async fn cancel_transfer_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
    Path(transfer_id): Path<u64>,
) -> Result<Json<CancelTransferResponse>, ApiError> {
    let transfer_id = TransferId::new(transfer_id);
    require_transfer_write(&state, &principal, transfer_id).await?;
    let owner = principal.owner().to_string();
    match state
        .router_ref
        .request(|reply| RouterMsg::CancelPublicTransfer {
            owner,
            transfer_id,
            reply,
        })
        .await?
    {
        Ok(response) => Ok(Json(response)),
        Err(CancelPublicTransferError::NotFound) => Err(ApiError::not_found("Transfer not found")),
        Err(CancelPublicTransferError::NotCancelable) => {
            Err(ApiError::conflict("Transfer can no longer be canceled"))
        }
        Err(CancelPublicTransferError::Delivery(error)) => Err(error.into()),
    }
}
