//! REST endpoint for the committed and staged text of one file, which the editor's Git gutter
//! compares its buffer with. Separate from the file content endpoint so opening a file never
//! waits for Git; the browser asks for this in the background once the editor is on screen.

use axum::{
    Json,
    extract::{Path, State as AxumState},
};
use redoor_protocol::api::git::file_bases::GitFileBasesResponse;

use super::route_path;
use crate::http::{
    access::ResolvedDevice, agent_client::GitFileBases, agent_helpers::AgentFilePath,
    error::ApiError, state::ServerState,
};

/// Route: `GET /api/v1/agents/{agent}/git/file-bases/{*path}`.
///
/// The agent stops reading at once when this request is abandoned, so switching quickly
/// between files never leaves reads running for files no longer shown.
pub(crate) async fn git_file_bases_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(params): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<GitFileBasesResponse>, ApiError> {
    let call = GitFileBases {
        path: route_path(params.path)?,
    };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}
