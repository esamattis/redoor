use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor::{actors, commands::ErrorResponse};

use super::state::ServerState;

/// Route: `GET /api/v1/transfers/progress` returns all retained transfer states.
pub(crate) async fn list_transfer_progress_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match state
        .router_ref
        .request(5000, |reply| {
            actors::router::RouterMsg::GetTransferProgress { reply }
        })
        .await
    {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get transfer progress: {error:?}"),
            }),
        )
            .into_response(),
    }
}
