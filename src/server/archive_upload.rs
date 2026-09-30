//! Recursive uploads reuse agent extraction and staging without buffering or precomputing archive size.

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    raw::{AgentUpload, AgentUploadStartError, forward_request_body},
    responses::{command_error_status, router_error_response},
    state::ServerState,
};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use redoor::{
    commands::{ArchiveUploadResponse, Command, CommandResult, CopyExistingMode, ErrorResponse},
    types::AgentId,
};

/// Defaults to strict creation so replacing an existing destination requires an explicit choice.
#[derive(serde::Deserialize)]
pub(crate) struct ArchiveQuery {
    #[serde(default)]
    on_existing: CopyExistingMode,
}

/// PUT /api/v1/agents/{agent}/archive/{*path} accepts plain tar members relative to the resulting directory.
pub(crate) async fn upload_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    Query(query): Query<ArchiveQuery>,
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let request_guard = match state.upload_requests.reserve(&headers) {
        Ok(guard) => guard,
        Err(response) => return *response,
    };
    let mut upload = match AgentUpload::start(
        &state,
        AgentId::from(agent),
        Command::TarUpload {
            path: path.clone(),
            on_existing: query.on_existing,
        },
        path.clone(),
        0,
    )
    .await
    {
        Ok(upload) => upload,
        Err(AgentUploadStartError::Response(response)) => return response,
        Err(AgentUploadStartError::Finished(completion)) => {
            return match *completion {
                Ok(result) => completion_response(result, path, 0),
                Err(error) => router_error_response(error),
            };
        }
    };
    if request_guard
        .as_ref()
        .is_some_and(|guard| !guard.activate(upload.request_id.as_transfer_id()))
    {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Upload request canceled during setup".into(),
            }),
        )
            .into_response();
    }
    if let Err(response) = forward_request_body(body, &mut upload).await {
        return *response;
    }
    match upload.finish().await {
        Ok((result, bytes)) => completion_response(result, path, bytes),
        Err(response) => response,
    }
}

/// Returns success only after extraction and conflict-policy placement finish on the agent.
fn completion_response(result: CommandResult, path: String, bytes_written: u64) -> Response {
    match result {
        CommandResult::TarUpload => Json(ArchiveUploadResponse {
            path,
            bytes_written,
        })
        .into_response(),
        CommandResult::Error { kind, message } => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected archive upload completion".into(),
            }),
        )
            .into_response(),
    }
}
