use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use ractor::call_t;
use redoor::{
    actors,
    commands::{Command, CommandResult, CreateDirectoryResponse, ErrorResponse, RawDeleteResponse},
    types::AgentId,
};

use super::{
    agent_helpers::resolve_agent_path, responses::command_error_status, state::ServerState,
};

/// Route: `DELETE /api/v1/agents/{agent}/raw/{*path}`
pub(crate) async fn raw_agent_delete_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let resolved_path = match resolve_agent_path(&state, &agent_id, path).await {
        Ok(path) => path,
        Err(response) => return response,
    };

    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest(
            actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::RawDelete {
                    path: resolved_path.clone(),
                },
                reply,
            }
        ),
        30000
    ) {
        Ok(CommandResult::RawDelete) => (
            StatusCode::OK,
            Json(RawDeleteResponse {
                path: resolved_path,
            }),
        )
            .into_response(),
        Ok(CommandResult::Error { kind, message }) => {
            let status = command_error_status(&kind);
            (status, Json(ErrorResponse { error: message })).into_response()
        }
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected delete response".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to delete file: {:?}", error),
            }),
        )
            .into_response(),
    }
}

/// Route: `POST /api/v1/agents/{agent}/mkdir/{*path}`
pub(crate) async fn create_directory_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let resolved_path = match resolve_agent_path(&state, &agent_id, path).await {
        Ok(path) => path,
        Err(response) => return response,
    };

    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest(
            actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::CreateDirectory {
                    path: resolved_path.clone(),
                },
                reply,
            }
        ),
        30000
    ) {
        Ok(CommandResult::CreateDirectory) => (
            StatusCode::OK,
            Json(CreateDirectoryResponse {
                path: resolved_path,
            }),
        )
            .into_response(),
        Ok(CommandResult::Error { kind, message }) => {
            let status = command_error_status(&kind);
            (status, Json(ErrorResponse { error: message })).into_response()
        }
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected create directory response".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to create directory: {:?}", error),
            }),
        )
            .into_response(),
    }
}
