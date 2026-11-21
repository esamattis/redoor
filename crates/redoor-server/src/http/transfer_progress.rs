//! REST endpoint that lists retained transfer progress for the caller's workspace.

use crate::actors::router::RouterMsg;
use axum::{Extension, Json, extract::State as AxumState};
use redoor_protocol::api::transfers::{TransferProgressEntry, TransferProgressListResponse};

use super::{access::Principal, error::ApiError, state::ServerState};

/// Route: `GET /api/v1/transfers/progress` returns the retained transfer states the caller
/// may see.
pub(crate) async fn list_transfer_progress_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<TransferProgressListResponse>, ApiError> {
    let owner = principal.owner().to_string();
    let mut progress = state
        .router_ref
        .request(|reply| RouterMsg::GetTransferProgress { owner, reply })
        .await?;
    progress
        .transfers
        .retain(|entry| transfer_visible(&principal, entry));
    Ok(Json(progress))
}

/// A transfer is visible only when every device it touches is in the caller's scope, so a
/// token never learns paths on devices outside it.
pub(crate) fn transfer_visible(principal: &Principal, entry: &TransferProgressEntry) -> bool {
    principal.can_see(&entry.agent_id)
        && entry
            .source
            .iter()
            .chain(entry.dest.iter())
            .all(|endpoint| principal.can_see(&endpoint.agent))
}

/// Finds the retained row of a transfer the caller may act on (enforcing workspace ownership
/// for sessions as well as tokens), and requires write on the destination device for tokens.
pub(crate) async fn require_transfer_write(
    state: &ServerState,
    principal: &Principal,
    transfer_id: redoor_protocol::ids::TransferId,
) -> Result<(), ApiError> {
    let owner = principal.owner().to_string();
    let progress = state
        .router_ref
        .request(|reply| RouterMsg::GetTransferProgress { owner, reply })
        .await?;
    let entry = progress
        .transfers
        .into_iter()
        .find(|entry| entry.request_id == transfer_id && transfer_visible(principal, entry))
        .ok_or_else(|| ApiError::not_found("Transfer not found"))?;
    if matches!(principal, Principal::Session(_)) {
        return Ok(());
    }
    let destination = entry
        .dest
        .map(|endpoint| endpoint.agent)
        .unwrap_or(entry.agent_id);
    principal.require(
        &[redoor_protocol::api::tokens::Permission::FilesWrite],
        &destination,
    )
}
