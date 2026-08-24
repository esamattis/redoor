use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor::{
    actors,
    commands::{
        Command, CommandResult, DiffEndpoint, DiffFilesRequest, DiffFilesResponse, ErrorResponse,
        MetadataResponse,
    },
};

use super::{
    agent_helpers::require_absolute_path,
    raw::DownloadCancelGuard,
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

/// Route: `POST /api/v1/diff`
pub(crate) async fn diff_files_handler(
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<DiffFilesRequest>,
) -> impl IntoResponse {
    let left_path = match require_absolute_path(payload.left.path.clone()) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    let right_path = match require_absolute_path(payload.right.path.clone()) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    let left = DiffEndpoint {
        agent: payload.left.agent,
        path: left_path,
    };
    let right = DiffEndpoint {
        agent: payload.right.agent,
        path: right_path,
    };

    let (left_metadata, right_metadata) = tokio::join!(
        fetch_metadata(&state, &left),
        fetch_metadata(&state, &right)
    );
    let left_metadata = match left_metadata {
        Ok(metadata) => metadata,
        Err(response) => return response,
    };
    let right_metadata = match right_metadata {
        Ok(metadata) => metadata,
        Err(response) => return response,
    };

    if !left_metadata.editable || !right_metadata.editable {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Diff supports editable files only".to_string(),
            }),
        )
            .into_response();
    }

    let (left_content, right_content) = tokio::join!(
        download_editable_file(&state, &left, left_metadata.file_size),
        download_editable_file(&state, &right, right_metadata.file_size)
    );
    let left_content = match left_content {
        Ok(content) => content,
        Err(response) => return response,
    };
    let right_content = match right_content {
        Ok(content) => content,
        Err(response) => return response,
    };

    let unified_diff = similar::TextDiff::from_lines(&left_content, &right_content)
        .unified_diff()
        .header(&left.path, &right.path)
        .to_string();

    (StatusCode::OK, Json(DiffFilesResponse { unified_diff })).into_response()
}

/// Reuses agent metadata so diff eligibility cannot drift from the file editor's gate.
async fn fetch_metadata(
    state: &ServerState,
    endpoint: &DiffEndpoint,
) -> Result<MetadataResponse, axum::response::Response> {
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: endpoint.agent.clone(),
                command: Command::Metadata {
                    path: endpoint.path.clone(),
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::Metadata(metadata)) => Ok(metadata),
        Ok(CommandResult::Error { kind, message }) => Err((
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response()),
        Ok(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected response type from metadata command".to_string(),
            }),
        )
            .into_response()),
        Err(error) => Err(internal_error_response(&format!(
            "Failed to get file metadata: {error:?}"
        ))),
    }
}

/// Downloads an already size-bounded editable file through the normal agent stream path.
async fn download_editable_file(
    state: &ServerState,
    endpoint: &DiffEndpoint,
    expected_size: u64,
) -> Result<String, axum::response::Response> {
    let (chunk_sender, mut chunk_receiver) =
        tokio::sync::mpsc::channel::<redoor::streaming::StreamChunk>(1);

    let request_id = match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteStreamCommandRest(
                actors::router::ExecuteStreamRequest {
                    agent_id: endpoint.agent.clone(),
                    command: Command::RawDownload {
                        path: endpoint.path.clone(),
                        range_start: None,
                        range_end: None,
                    },
                    path: endpoint.path.clone(),
                    total_bytes: expected_size,
                    full_size: Some(expected_size),
                    resume_offset: None,
                    reply,
                    chunk_sender,
                    rest_cancel_sender: None,
                },
            )
        })
        .await
    {
        Ok(Ok(request_id)) => request_id,
        Ok(Err(error)) => return Err(router_error_response(error)),
        Err(error) => {
            return Err(internal_error_response(&format!(
                "Failed to start file download: {error:?}"
            )));
        }
    };
    let mut cancel_guard =
        DownloadCancelGuard::new(state.router_ref.clone(), endpoint.agent.clone(), request_id);

    let capacity = match usize::try_from(expected_size) {
        Ok(capacity) => capacity,
        Err(_) => {
            return Err(invalid_download_response(
                "Editable file size is unsupported",
            ));
        }
    };
    let mut content = Vec::with_capacity(capacity);
    let mut completed = false;
    while let Some(chunk) = chunk_receiver.recv().await {
        if chunk.is_error {
            cancel_guard.disarm();
            let message = if chunk.data.is_empty() {
                format!("Failed to download {}", endpoint.path)
            } else {
                String::from_utf8_lossy(&chunk.data).into_owned()
            };
            return Err(invalid_download_response(&message));
        }
        if content.len().saturating_add(chunk.data.len()) > capacity {
            return Err(invalid_download_response(
                "File changed while it was being prepared for diff",
            ));
        }
        content.extend_from_slice(&chunk.data);
        if chunk.is_last {
            cancel_guard.disarm();
            completed = true;
            break;
        }
    }

    if !completed || content.len() != capacity {
        return Err(invalid_download_response(
            "File changed while it was being prepared for diff",
        ));
    }

    String::from_utf8(content).map_err(|_| {
        invalid_download_response("File is no longer editable because it is not valid UTF-8")
    })
}

/// Converts a changed or malformed download into the standard REST error shape.
fn invalid_download_response(message: &str) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
        .into_response()
}

/// Reports actor request failures separately from agent and filesystem errors.
fn internal_error_response(message: &str) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
        .into_response()
}
