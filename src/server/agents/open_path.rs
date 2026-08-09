use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, OpenPathResponse},
    types::AgentId,
};

use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::command_error_status,
    state::ServerState,
};

/// Route: `POST /api/v1/agents/{agent}/open/{*path}` launches a path on the agent desktop.
pub(crate) async fn open_path_agent_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent);
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::OpenPath { path: path.clone() },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::OpenPath) => {
            (StatusCode::OK, Json(OpenPathResponse { path })).into_response()
        }
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type while opening path".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to open path: {error:?}"),
            }),
        )
            .into_response(),
    }
}
