use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use ractor::call_t;
use redoor::{
    actors,
    commands::{Command, CommandResult, CopyFileRequest, CopyFileResponse, ErrorResponse},
};

use super::{agent_helpers::resolve_agent_path, state::ServerState};

/// Route: `GET /api/v1/transfers/progress`
pub(crate) async fn list_transfer_progress_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::GetTransferProgress { reply },
        5000
    ) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => {
            let error_msg = format!("Failed to get transfer progress: {:?}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

/// Route: `POST /api/v1/copy`
pub(crate) async fn copy_file_handler(
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<CopyFileRequest>,
) -> impl IntoResponse {
    let source_path = match resolve_agent_path(
        &state,
        &payload.source.agent,
        payload.source.path.clone(),
    )
    .await
    {
        Ok(path) => path,
        Err(response) => return response,
    };

    let dest_path =
        match resolve_agent_path(&state, &payload.dest.agent, payload.dest.path.clone()).await {
            Ok(path) => path,
            Err(response) => return response,
        };

    if payload.source.agent == payload.dest.agent && source_path == dest_path {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Source and destination must be different".to_string(),
            }),
        )
            .into_response();
    }

    let source_metadata = match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest(
            actors::router::ExecuteCommandRequest {
                agent_id: payload.source.agent.clone(),
                command: Command::Metadata {
                    path: source_path.clone(),
                },
                reply,
            }
        ),
        30000
    ) {
        Ok(CommandResult::Metadata(metadata)) => metadata,
        Ok(CommandResult::Error { message }) => {
            let status = if message.contains("No such file") || message.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            return (status, Json(ErrorResponse { error: message })).into_response();
        }
        Ok(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected response type from metadata command".to_string(),
                }),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to get source metadata: {:?}", error),
                }),
            )
                .into_response();
        }
    };

    let (total_bytes, content_kind) = if source_metadata.is_file {
        (
            source_metadata.file_size,
            actors::router::CopyContentKind::RawFile,
        )
    } else if source_metadata.is_dir {
        (0, actors::router::CopyContentKind::TarDirectory)
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Copy supports regular files and directories only".to_string(),
            }),
        )
            .into_response();
    };

    let copy_request_id = match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::StartCopyRest(actors::router::StartCopyRequest {
            source_agent_id: payload.source.agent.clone(),
            source_path: source_path.clone(),
            dest_agent_id: payload.dest.agent.clone(),
            dest_path: dest_path.clone(),
            total_bytes,
            content_kind,
            reply,
        }),
        30000
    ) {
        Ok(Ok(copy_request_id)) => copy_request_id,
        Ok(Err(error_msg)) => {
            let status = if error_msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else if error_msg.contains("Permission denied") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return (status, Json(ErrorResponse { error: error_msg })).into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to start copy: {:?}", error),
                }),
            )
                .into_response();
        }
    };

    (StatusCode::OK, Json(CopyFileResponse { copy_request_id })).into_response()
}
