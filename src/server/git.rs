use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, GitDiffMode},
    types::AgentId,
};
use serde::Deserialize;

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url, require_absolute_path},
    responses::command_error_status,
    state::ServerState,
};

/// Holds raw query text so invalid modes can use the standard JSON error shape.
#[derive(Default, Deserialize)]
pub(crate) struct GitDiffQuery {
    mode: Option<String>,
}

/// Route: `GET /api/v1/agents/{agent}/git/context[/{*path}]`.
pub(crate) async fn git_context_handler(
    Path(params): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    let path = match route_path(params.path) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    execute_git_command(
        &state,
        AgentId::from(params.agent),
        Command::GitContext { path },
        |result| match result {
            CommandResult::GitContext(response) => Some(Json(response).into_response()),
            _ => None,
        },
        "Git context",
    )
    .await
}

/// Route: `GET /api/v1/agents/{agent}/git/status[/{*path}]`.
pub(crate) async fn git_status_handler(
    Path(params): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    let path = match route_path(params.path) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    execute_git_command(
        &state,
        AgentId::from(params.agent),
        Command::GitStatus { path },
        |result| match result {
            CommandResult::GitStatus(response) => Some(Json(response).into_response()),
            _ => None,
        },
        "Git status",
    )
    .await
}

/// Route: `GET /api/v1/agents/{agent}/git/diff[/{*path}]?mode=full|staged`.
pub(crate) async fn git_diff_handler(
    Path(params): Path<AgentFilePath>,
    Query(query): Query<GitDiffQuery>,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    let path = match route_path(params.path) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    let mode = match query.mode.as_deref().unwrap_or("full") {
        "full" => GitDiffMode::Full,
        "staged" => GitDiffMode::Staged,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Git diff mode must be 'full' or 'staged'".to_string(),
                }),
            )
                .into_response();
        }
    };
    execute_git_command(
        &state,
        AgentId::from(params.agent),
        Command::GitDiff { path, mode },
        |result| match result {
            CommandResult::GitDiff(response) => Some(Json(response).into_response()),
            _ => None,
        },
        "Git diff",
    )
    .await
}

/// Restores the implicit root and applies the shared absolute-path policy.
fn route_path(path: Option<String>) -> Result<String, Box<Response>> {
    let path = absolute_path_from_url(path.unwrap_or_default());
    require_absolute_path(path)
}

/// Sends one Git command over the prioritized control lane and maps shared failures.
async fn execute_git_command(
    state: &ServerState,
    agent_id: AgentId,
    command: Command,
    success: impl FnOnce(CommandResult) -> Option<Response>,
    operation: &str,
) -> Response {
    match state
        .router_ref
        .request(30_000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id,
                command,
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(result) => success(result).unwrap_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Unexpected response type from {operation} command"),
                }),
            )
                .into_response()
        }),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to execute {operation}: {error:?}"),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keeps both exact and wildcard routes on the same absolute filesystem convention.
    #[test]
    fn route_paths_restore_the_implicit_root() {
        // The exact route addresses filesystem root rather than an agent cwd.
        assert_eq!(route_path(None).unwrap(), "/");
        // Wildcard segments preserve their hierarchy behind a single route slash.
        assert_eq!(
            route_path(Some("tmp/repo".to_string())).unwrap(),
            "/tmp/repo"
        );
    }
}
