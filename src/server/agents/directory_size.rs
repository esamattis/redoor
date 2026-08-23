use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse},
    types::AgentId,
};

use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::command_error_status,
    state::ServerState,
};

const DIRECTORY_SIZE_TIMEOUT_SECONDS: u64 = 10;

/// Route: `POST /api/v1/agents/{agent}/directory-size/{*path}` calculates recursive file bytes.
pub(crate) async fn directory_size_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent);
    let request_timeout_ms = (DIRECTORY_SIZE_TIMEOUT_SECONDS + 2) * 1000;

    match state
        .router_ref
        .request(request_timeout_ms, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::DirectorySize {
                    path,
                    timeout_seconds: DIRECTORY_SIZE_TIMEOUT_SECONDS,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::DirectorySize(response)) => {
            (StatusCode::OK, Json(response)).into_response()
        }
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
                error: format!("Failed to calculate directory size: {error:?}"),
            }),
        )
            .into_response(),
    }
}
