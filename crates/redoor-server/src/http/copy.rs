//! REST endpoint that starts an asynchronous copy between agents.

use axum::{Extension, Json, extract::State as AxumState};
use redoor_protocol::api::{
    tokens::Permission,
    transfers::{CopyFileRequest, CopyFileResponse},
};

use super::{
    access::Principal,
    error::ApiError,
    services::transfer::{CopySpec, RevisionCopySpec, StartedCopy},
    state::ServerState,
};
use crate::actors::router::CopyOperation;

/// Route: `POST /api/v1/copy`; needs read on the source and write on the destination.
///
/// A `source_rev` reads the source from Git history instead of the working tree.
pub(crate) async fn copy_file_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(mut payload): Json<CopyFileRequest>,
) -> Result<Json<CopyFileResponse>, ApiError> {
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
    principal.require(&[Permission::FilesRead], &payload.source.agent)?;
    principal.require(&[Permission::FilesWrite], &payload.dest.agent)?;
    if let Some(rev) = payload.source_rev {
        let transfer_id = state
            .transfers
            .start_revision_copy(RevisionCopySpec {
                owner,
                source: payload.source,
                rev,
                dest: payload.dest,
                on_existing: payload.on_existing,
            })
            .await?;
        return Ok(Json(CopyFileResponse {
            copy_request_id: transfer_id,
        }));
    }
    let StartedCopy { transfer_id, .. } = state
        .transfers
        .start_copy(CopySpec {
            owner,
            op: CopyOperation::Copy,
            source: payload.source,
            dest: payload.dest,
            on_existing: payload.on_existing,
            resume: payload.resume,
            observe_terminal: false,
        })
        .await?;
    Ok(Json(CopyFileResponse {
        copy_request_id: transfer_id,
    }))
}
