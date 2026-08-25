use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor::{
    Level, actors,
    commands::{Command, CommandResult, ErrorResponse, MoveFileRequest, MoveFileResponse},
    log,
};

use super::{
    agent_helpers::require_absolute_path,
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

/// Route: `POST /api/v1/move` starts one atomic-or-copy/delete logical move.
pub(crate) async fn move_file_handler(
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<MoveFileRequest>,
) -> impl IntoResponse {
    let source_path = match require_absolute_path(payload.source.path.clone()) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    let dest_path = match require_absolute_path(payload.dest.path.clone()) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    log!(
        Level::Debug,
        "Smart move request received: source_agent={}, source_path={}, dest_agent={}, dest_path={}, on_existing={:?}",
        payload.source.agent,
        source_path,
        payload.dest.agent,
        dest_path,
        payload.on_existing
    );
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
                command: Command::MoveMetadata {
                    path: source_path.clone(),
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::MoveMetadata(metadata)) => {
            log!(
                Level::Debug,
                "Smart move source metadata: source_agent={}, source_path={}, is_file={}, is_dir={}, file_size={}, identity={:?}",
                payload.source.agent,
                source_path,
                metadata.is_file,
                metadata.is_dir,
                metadata.file_size,
                metadata.identity
            );
            metadata
        }
        Ok(CommandResult::Error { kind, message }) => {
            return (
                command_error_status(&kind),
                Json(ErrorResponse { error: message }),
            )
                .into_response();
        }
        Ok(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected response type from move metadata command".to_string(),
                }),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to get source metadata: {error:?}"),
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
                error: "Move supports regular files and directories only".to_string(),
            }),
        )
            .into_response();
    };

    let source_agent_id = payload.source.agent.clone();
    let dest_agent_id = payload.dest.agent.clone();
    let move_request_id = match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::StartCopyRest(actors::router::StartCopyRequest {
                source_agent_id: payload.source.agent,
                source_path: source_path.clone(),
                dest_agent_id: payload.dest.agent,
                dest_path: dest_path.clone(),
                total_bytes,
                content_kind,
                on_existing: payload.on_existing,
                operation: actors::router::CopyOperation::Move,
                source_identity: Some(source_metadata.identity),
                reply,
            })
        })
        .await
    {
        Ok(Ok(request_id)) => {
            log!(
                Level::Debug,
                "Smart move started: move_request_id={}, source_agent={}, source_path={}, dest_agent={}, dest_path={}, content_kind={:?}, total_bytes={}",
                request_id,
                source_agent_id,
                source_path,
                dest_agent_id,
                dest_path,
                content_kind,
                total_bytes
            );
            request_id
        }
        Ok(Err(error)) => return router_error_response(error),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to start move: {error:?}"),
                }),
            )
                .into_response();
        }
    };

    (StatusCode::OK, Json(MoveFileResponse { move_request_id })).into_response()
}
