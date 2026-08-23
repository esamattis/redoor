use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, GitDiffRequest},
    types::AgentId,
};

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url, require_absolute_path},
    responses::command_error_status,
    state::ServerState,
};

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

/// Route: `POST /api/v1/agents/{agent}/git/diff`.
pub(crate) async fn git_diff_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<GitDiffRequest>,
) -> Response {
    execute_git_command(
        &state,
        AgentId::from(agent),
        Command::GitDiff {
            files: request.files,
            mode: request.mode,
        },
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
