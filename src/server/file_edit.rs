use axum::{
    Json,
    body::Body,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use headers::HeaderMap;
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, FileEditResponse},
    types::AgentId,
};

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    raw::{AgentUpload, AgentUploadStartError, forward_request_body, required_content_length},
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

/// Route: `PUT /api/v1/agents/{agent}/edit/{*path}`.
pub(crate) async fn file_edit_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let total_bytes = match required_content_length(&headers, "file edits") {
        Ok(total_bytes) => total_bytes,
        Err(response) => return *response,
    };
    let mut upload = match AgentUpload::start(
        &state,
        AgentId::from(agent),
        Command::EditFile { path: path.clone() },
        path.clone(),
        total_bytes,
    )
    .await
    {
        Ok(upload) => upload,
        Err(AgentUploadStartError::Response(response)) => return response,
        Err(AgentUploadStartError::Finished(completion)) => {
            return file_edit_completion_response(*completion, &path, 0);
        }
    };

    if let Err(response) = forward_request_body(body, &mut upload).await {
        return *response;
    }
    let response_path = upload.path().to_string();
    match upload.finish().await {
        Ok((completion, bytes_written)) => {
            file_edit_completion_response(Ok(completion), &response_path, bytes_written)
        }
        Err(response) => response,
    }
}

/// Maps only EditFile completion so protocol mismatches cannot report editor success.
fn file_edit_completion_response(
    completion: Result<CommandResult, actors::router::RouterError>,
    path: &str,
    bytes_written: u64,
) -> Response {
    match completion {
        Ok(CommandResult::EditFile) => (
            StatusCode::OK,
            Json(FileEditResponse {
                path: path.to_string(),
                bytes_written,
            }),
        )
            .into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected file edit completion response".to_string(),
            }),
        )
            .into_response(),
        Err(error) => router_error_response(error),
    }
}
