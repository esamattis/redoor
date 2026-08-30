use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{ChmodPathRequest, Command, CommandResult, ErrorResponse},
    types::AgentId,
};

use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::command_error_status,
    state::ServerState,
};

/// Route: `POST /api/v1/agents/{agent}/chmod/{*path}` replaces ordinary rwx bits only.
pub(crate) async fn chmod_path_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<ChmodPathRequest>,
) -> impl IntoResponse {
    if request.permissions > 0o777 {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!(
                    "Permissions must be between 0 and 0o777, got {:#o}",
                    request.permissions
                ),
            }),
        )
            .into_response();
    }
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent);

    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::ChmodPath {
                    path,
                    permissions: request.permissions,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::ChmodPath(response)) => (StatusCode::OK, Json(response)).into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type while changing permissions".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to change permissions: {error:?}"),
            }),
        )
            .into_response(),
    }
}
