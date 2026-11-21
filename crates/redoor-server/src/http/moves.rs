//! REST endpoint that starts an asynchronous move between agent filesystem endpoints.

use axum::{Extension, Json, extract::State as AxumState};
use redoor_protocol::api::{
    tokens::Permission,
    transfers::{MoveFileRequest, MoveFileResponse},
};

use super::{
    access::Principal,
    error::ApiError,
    services::transfer::{CopySpec, StartedCopy},
    state::ServerState,
};
use crate::actors::router::CopyOperation;

/// Route: `POST /api/v1/move` starts one atomic-or-copy/delete logical move.
///
/// A move reads and removes the source, so it needs read, write and delete there, and write
/// on the destination.
pub(crate) async fn move_file_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(mut payload): Json<MoveFileRequest>,
) -> Result<Json<MoveFileResponse>, ApiError> {
    let owner = principal.owner().to_string();
    // Body fields accept a name or an id; resolving before `require` keeps scope checks on
    // ids, so a name that now belongs to another device cannot slip past a scope.
    payload.source.agent = state
        .agents
        .resolve(&owner, payload.source.agent.as_str())
        .await?;
    payload.dest.agent = state
        .agents
        .resolve(&owner, payload.dest.agent.as_str())
        .await?;
    principal.require(
        &[
            Permission::FilesRead,
            Permission::FilesWrite,
            Permission::FilesDelete,
        ],
        &payload.source.agent,
    )?;
    principal.require(&[Permission::FilesWrite], &payload.dest.agent)?;
    let StartedCopy { transfer_id, .. } = state
        .transfers
        .start_copy(CopySpec {
            owner,
            op: CopyOperation::Move,
            source: payload.source,
            dest: payload.dest,
            on_existing: payload.on_existing,
            resume: payload.resume,
            observe_terminal: false,
        })
        .await?;
    Ok(Json(MoveFileResponse {
        move_request_id: transfer_id,
    }))
}
