//! REST endpoint that counts the uncommitted changes of several checkouts in one request,
//! apart from the worktree list so the list answers without walking every checkout first.

use axum::{Json, extract::State as AxumState};
use redoor_protocol::api::git::worktree_status::{
    GitWorktreeStatusRequest, GitWorktreeStatusResponse,
};

use crate::http::{
    access::ResolvedDevice, agent_client::GitWorktreeStatus, agent_helpers::require_absolute_path,
    error::ApiError, state::ServerState,
};

/// Route: `POST /api/v1/agents/{agent}/git/worktree-status`.
///
/// One request carries every row the browser shows, because a request per row filled the
/// browser's few connections to the server and stalled every other view behind the walks.
pub(crate) async fn git_worktree_status_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(mut request): Json<GitWorktreeStatusRequest>,
) -> Result<Json<GitWorktreeStatusResponse>, ApiError> {
    request.normalize_paths().map_err(ApiError::bad_request)?;
    let paths = request
        .paths
        .into_iter()
        .map(require_absolute_path)
        .collect::<Result<_, _>>()?;
    let call = GitWorktreeStatus { paths };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}
