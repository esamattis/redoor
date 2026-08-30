use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{ChownPathRequest, Command, CommandResult, ErrorResponse},
    types::AgentId,
};

use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::command_error_status,
    state::ServerState,
};

/// Route: `POST /api/v1/agents/{agent}/chown/{*path}` changes followed-inode ownership.
pub(crate) async fn chown_path_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    Query(request): Query<ChownPathRequest>,
) -> impl IntoResponse {
    if request.owner.is_none() && request.group.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Owner or group is required".to_string(),
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
                command: Command::ChownPath {
                    path,
                    owner: request.owner,
                    group: request.group,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::ChownPath(response)) => (StatusCode::OK, Json(response)).into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type while changing ownership".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to change ownership: {error:?}"),
            }),
        )
            .into_response(),
    }
}
