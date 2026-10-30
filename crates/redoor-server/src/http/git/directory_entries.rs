//! REST endpoint for the Git state of the entries of one directory, the file list's status
//! column. Separate from the listing endpoint so listing a directory never waits for a
//! status walk; the browser asks for this in the background once the list is on screen.

use axum::{
    Json,
    extract::{Path, State as AxumState},
};
use redoor_protocol::api::git::directory_entries::GitDirectoryEntriesResponse;

use super::route_path;
use crate::http::{
    access::ResolvedDevice, agent_client::GitDirectoryEntries, agent_helpers::AgentFilePath,
    error::ApiError, state::ServerState,
};

/// Route: `GET /api/v1/agents/{agent}/git/entries[/{*path}]`.
///
/// The agent stops its walk after its own time budget and answers `timed_out`, and stops at
/// once when this request is abandoned, so leaving a directory frees the agent for the next.
pub(crate) async fn git_directory_entries_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(params): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<GitDirectoryEntriesResponse>, ApiError> {
    let call = GitDirectoryEntries {
        path: route_path(params.path)?,
    };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}
