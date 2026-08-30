use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{actors, commands::ErrorResponse, types::TransferId};

use super::state::ServerState;

/// Route: `DELETE /api/v1/transfers/{transfer_id}` cancels one active transfer.
pub(crate) async fn cancel_transfer_handler(
    AxumState(state): AxumState<ServerState>,
    Path(transfer_id): Path<u64>,
) -> impl IntoResponse {
    let transfer_id = TransferId::new(transfer_id);
    match state
        .router_ref
        .request(5_000, |reply| {
            actors::router::RouterMsg::CancelPublicTransfer { transfer_id, reply }
        })
        .await
    {
        Ok(Ok(response)) => (StatusCode::OK, Json(response)).into_response(),
        Ok(Err(actors::router::CancelPublicTransferError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Transfer not found".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(actors::router::CancelPublicTransferError::NotCancelable)) => (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Transfer can no longer be canceled".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to cancel transfer: {error:?}"),
            }),
        )
            .into_response(),
    }
}
