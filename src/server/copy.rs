use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor::{
    actors,
    commands::{Command, CommandResult, CopyFileRequest, CopyFileResponse, ErrorResponse},
};

use super::{
    agent_helpers::require_absolute_path,
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

/// Route: `POST /api/v1/copy`
pub(crate) async fn copy_file_handler(
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<CopyFileRequest>,
) -> impl IntoResponse {
    let source_path = match require_absolute_path(payload.source.path.clone()) {
        Ok(path) => path,
        Err(response) => return *response,
    };

    let dest_path = match require_absolute_path(payload.dest.path.clone()) {
        Ok(path) => path,
        Err(response) => return *response,
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

    let source_metadata = match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: payload.source.agent.clone(),
                command: Command::Metadata {
                    path: source_path.clone(),
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::Metadata(metadata)) => metadata,
        Ok(CommandResult::Error { kind, message }) => {
            let status = command_error_status(&kind);
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

    let copy_request_id = match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::StartCopyRest(actors::router::StartCopyRequest {
                source_agent_id: payload.source.agent.clone(),
                source_path: source_path.clone(),
                dest_agent_id: payload.dest.agent.clone(),
                dest_path: dest_path.clone(),
                total_bytes,
                content_kind,
                on_existing: payload.on_existing,
                operation: actors::router::CopyOperation::Copy,
                source_identity: None,
                reply,
            })
        })
        .await
    {
        Ok(Ok(copy_request_id)) => copy_request_id,
        Ok(Err(error)) => {
            return router_error_response(error);
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
