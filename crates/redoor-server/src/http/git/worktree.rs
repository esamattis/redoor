//! REST endpoints for the worktree: git context, status and diffs of uncommitted changes.

use crate::http::access::ResolvedDevice;
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
};
use redoor_protocol::api::git::worktree::{
    GitContextResponse, GitDiffRequest, GitDiffResponse, GitStatusQuery, GitStatusResponse,
};

use super::route_path;
use crate::http::{
    agent_client::{GitContext, GitDiff, GitStatus},
    agent_helpers::AgentFilePath,
    error::ApiError,
    state::ServerState,
};

/// Route: `GET /api/v1/agents/{agent}/git/context[/{*path}]`.
pub(crate) async fn git_context_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(params): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<GitContextResponse>, ApiError> {
    let call = GitContext {
        path: route_path(params.path)?,
    };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}

/// Route: `GET /api/v1/agents/{agent}/git/status[/{*path}]?all=`.
pub(crate) async fn git_status_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(params): Path<AgentFilePath>,
    Query(query): Query<GitStatusQuery>,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let call = GitStatus {
        path: route_path(params.path)?,
        all: query.all,
    };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}

/// Route: `POST /api/v1/agents/{agent}/git/diff`.
pub(crate) async fn git_diff_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(mut request): Json<GitDiffRequest>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    request
        .normalize_files()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let call = GitDiff {
        files: request.files,
        mode: request.mode,
    };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}
