//! REST endpoints for bounded content search below an agent directory.

use crate::http::access::ResolvedDevice;
use crate::http::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    error::ApiError,
    services::search::AgentSearch,
    state::ServerState,
};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    response::Response,
};
use redoor_protocol::api::search::{ContentGrepResponse, GrepRequest, MAX_GREP_CONTEXT_LINES};

/// Route: `POST /api/v1/agents/{agent}/grep/{*path}` searches below one filesystem root and
/// answers once the search ended.
pub(crate) async fn content_grep_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    Json(search): Json<GrepRequest>,
) -> Result<Json<ContentGrepResponse>, ApiError> {
    validate_grep(&search)?;
    let path = absolute_path_from_url(path.unwrap_or_default());
    let search = AgentSearch::contents(&state.router_ref, agent_id, path, search).await?;
    Ok(Json(search.collect().await?))
}

/// Route: `POST /api/v1/agents/{agent}/grep-stream/{*path}` searches below one filesystem
/// root and answers with NDJSON `ContentGrepEvent` lines while the agent still scans, so the
/// browser shows matches as they are found. Dropping the response cancels the search.
pub(crate) async fn content_grep_stream_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    Json(search): Json<GrepRequest>,
) -> Result<Response, ApiError> {
    validate_grep(&search)?;
    let path = absolute_path_from_url(path.unwrap_or_default());
    let search = AgentSearch::contents(&state.router_ref, agent_id, path, search).await?;
    Ok(search.into_response())
}

/// Rejects options the agent would not accept, so both content search routes fail the same
/// way before contacting the agent.
fn validate_grep(search: &GrepRequest) -> Result<(), ApiError> {
    if !(1..=60).contains(&search.timeout) {
        return Err(ApiError::bad_request(
            "Content grep timeout must be between 1 and 60 seconds",
        ));
    }
    if search.before_context > MAX_GREP_CONTEXT_LINES
        || search.after_context > MAX_GREP_CONTEXT_LINES
    {
        return Err(ApiError::bad_request(format!(
            "Content grep context must be between 0 and {MAX_GREP_CONTEXT_LINES} lines per direction"
        )));
    }
    Ok(())
}
