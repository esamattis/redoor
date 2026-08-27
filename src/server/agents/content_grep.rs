use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse},
    types::AgentId,
};
use serde::Deserialize;

use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::command_error_status,
    state::ServerState,
};

/// Carries bounded grep controls separately from the absolute route path.
#[derive(Deserialize)]
pub(crate) struct ContentGrepQuery {
    query: String,
    #[serde(default = "default_timeout_seconds")]
    timeout: u64,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default = "default_true")]
    respect_gitignore: bool,
}

/// Keeps omitted deadlines useful for interactive callers.
fn default_timeout_seconds() -> u64 {
    5
}

/// Preserves repository-aware traversal unless a caller explicitly opts out.
fn default_true() -> bool {
    true
}

/// Route: `GET /api/v1/agents/{agent}/grep/{*path}?query=...`
pub(crate) async fn content_grep_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    Query(search): Query<ContentGrepQuery>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    if !(1..=60).contains(&search.timeout) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Content grep timeout must be between 1 and 60 seconds".to_string(),
            }),
        )
            .into_response();
    }

    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent);
    let request_timeout_ms = (search.timeout + 2) * 1000;
    match state
        .router_ref
        .request(request_timeout_ms, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::ContentGrep {
                    path,
                    query: search.query,
                    timeout_seconds: search.timeout,
                    include_hidden: search.include_hidden,
                    respect_gitignore: search.respect_gitignore,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::ContentGrep(result)) => (StatusCode::OK, Json(result)).into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to execute content grep command: {error:?}"),
            }),
        )
            .into_response(),
    }
}
