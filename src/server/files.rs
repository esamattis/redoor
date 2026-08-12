use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{
        Command, CommandResult, CreateDirectoryResponse, ErrorResponse, RawDeleteResponse,
        RenamePathRequest, RenamePathResponse,
    },
    types::AgentId,
};
use std::path::Path as FilePath;

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url, require_absolute_path},
    responses::command_error_status,
    state::ServerState,
};

/// Route: `DELETE /api/v1/agents/{agent}/raw/{*path}`
pub(crate) async fn raw_agent_delete_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let resolved_path = absolute_path_from_url(path.unwrap_or_default());

    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::RawDelete {
                    path: resolved_path.clone(),
                },
                reply,
            })
        })
        .await
    {
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
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let resolved_path = absolute_path_from_url(path.unwrap_or_default());

    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::CreateDirectory {
                    path: resolved_path.clone(),
                },
                reply,
            })
        })
        .await
    {
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

/// Route: `POST /api/v1/agents/{agent}/rename`
pub(crate) async fn rename_path_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<RenamePathRequest>,
) -> impl IntoResponse {
    let dir = match require_absolute_path(request.dir) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    if !is_filename(&request.old) || !is_filename(&request.new) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Rename names must each be a single filename".to_string(),
            }),
        )
            .into_response();
    }
    let source_path = FilePath::new(&dir)
        .join(&request.old)
        .to_string_lossy()
        .into_owned();
    let dest_path = FilePath::new(&dir)
        .join(&request.new)
        .to_string_lossy()
        .into_owned();
    let agent_id = AgentId::from(agent);

    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::RenamePath {
                    dir: dir.clone(),
                    old: request.old.clone(),
                    new: request.new.clone(),
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::RenamePath) => (
            StatusCode::OK,
            Json(RenamePathResponse {
                source_path,
                dest_path,
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
                error: "Unexpected rename response".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to rename path: {:?}", error),
            }),
        )
            .into_response(),
    }
}

/// Rejects path syntax so the REST boundary only accepts entry names within `dir`.
fn is_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && name != "."
        && name != ".."
        && FilePath::new(name)
            .file_name()
            .is_some_and(|part| part == name)
}
