use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use headers::{HeaderMap, HeaderMapExt, Range as RangeHeader};
use ractor::{ActorRef, call_t};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, RawUploadResponse},
    streaming::StreamChunkFrameRequest,
    types::{AgentId, ChunkIndex, RequestId},
};
use serde::Deserialize;

use super::{
    agent_helpers::resolve_agent_path,
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

#[derive(Deserialize)]
pub(crate) struct RawQueryParams {
    download: Option<String>,
}

/// Triggers router-side upload cancellation if the HTTP handler exits before the
/// upload reaches a terminal state.
struct UploadCancelGuard {
    router_ref: ActorRef<actors::router::RouterMsg>,
    agent_id: AgentId,
    request_id: RequestId,
    active: bool,
}

impl UploadCancelGuard {
    /// Arms a new guard for one active upload request.
    fn new(
        router_ref: ActorRef<actors::router::RouterMsg>,
        agent_id: AgentId,
        request_id: RequestId,
    ) -> Self {
        Self {
            router_ref,
            agent_id,
            request_id,
            active: true,
        }
    }

    /// Disables drop-driven cancellation once the upload has already been
    /// finalized or explicitly aborted through the normal chunk flow.
    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for UploadCancelGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }

        let _ = self
            .router_ref
            .cast(actors::router::RouterMsg::CancelTransfer {
                agent_id: self.agent_id.clone(),
                request_id: self.request_id,
            });
    }
}

/// Reframes one upload-side payload into bounded transfer chunks and forwards
/// them to the destination agent in order.
async fn forward_split_stream_chunk(
    state: &ServerState,
    agent_id: &AgentId,
    chunk_index: &mut ChunkIndex,
    request: StreamChunkFrameRequest<'_>,
) -> Result<(), Response> {
    let is_error = request.is_error_flag();
    let is_last = request.is_last_flag();
    let mut frames =
        redoor::streaming::StreamChunkFrames::new(request.starting_chunk_index(*chunk_index));

    while let Some(chunk) = frames.next() {
        let next_chunk_index = frames.next_chunk_index();
        match call_t!(
            &state.router_ref,
            |reply| actors::router::RouterMsg::SendStreamChunkToAgent(
                actors::router::SendStreamChunkRequest {
                    agent_id: agent_id.clone(),
                    request_id: chunk.request_id,
                    chunk,
                    reply,
                }
            ),
            30000
        ) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                *chunk_index = next_chunk_index;
                return Err(router_error_response(error));
            }
            Err(error) => {
                *chunk_index = next_chunk_index;
                let action = if is_last {
                    "final upload chunk"
                } else if is_error {
                    "upload abort chunk"
                } else {
                    "upload chunk"
                };

                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Failed to forward {}: {:?}", action, error),
                    }),
                )
                    .into_response());
            }
        }
    }

    *chunk_index = frames.next_chunk_index();
    Ok(())
}

/// Parse Range header and return (start, end) byte positions (inclusive)
/// Returns None if no valid range can be satisfied
/// Only supports a single range for simplicity
fn parse_range_header(range: &RangeHeader, file_size: u64) -> Option<(u64, u64)> {
    use std::ops::Bound;

    let mut ranges = range.satisfiable_ranges(file_size);
    let (start_bound, end_bound) = ranges.next()?;

    let start = match start_bound {
        Bound::Included(start) => start,
        Bound::Excluded(start) => start + 1,
        Bound::Unbounded => 0,
    };

    let end = match end_bound {
        Bound::Included(end) => std::cmp::min(end, file_size - 1),
        Bound::Excluded(end) => std::cmp::min(end.saturating_sub(1), file_size - 1),
        Bound::Unbounded => file_size - 1,
    };

    if start >= file_size || start > end {
        return None;
    }

    Some((start, end))
}

/// Route: `GET /api/v1/agents/{agent}/raw/{*path}`
pub(crate) async fn raw_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    Query(params): Query<RawQueryParams>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let metadata = match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest(
            actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Metadata { path: path.clone() },
                reply,
            }
        ),
        5000
    ) {
        Ok(CommandResult::Metadata(metadata)) => metadata,
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
                    error: "Unexpected response type from metadata command".to_string(),
                }),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to get file metadata: {:?}", error),
                }),
            )
                .into_response();
        }
    };

    let range_option = headers.typed_get::<RangeHeader>();
    let (range_start, range_end, status_code, content_length, content_range_header) =
        if let Some(range) = range_option {
            match parse_range_header(&range, metadata.file_size) {
                Some((start, end)) => {
                    let length = end - start + 1;
                    let content_range = format!("bytes {}-{}/{}", start, end, metadata.file_size);
                    (
                        Some(start),
                        Some(end + 1),
                        StatusCode::PARTIAL_CONTENT,
                        length,
                        Some(content_range),
                    )
                }
                None => {
                    return (
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        [("Content-Range", format!("bytes */{}", metadata.file_size))],
                        Json(ErrorResponse {
                            error: "Range not satisfiable".to_string(),
                        }),
                    )
                        .into_response();
                }
            }
        } else {
            (None, None, StatusCode::OK, metadata.file_size, None)
        };

    let (response_sender, mut response_receiver) =
        tokio::sync::mpsc::channel::<redoor::streaming::StreamChunk>(1);

    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteStreamCommandRest(
            actors::router::ExecuteStreamRequest {
                agent_id: agent_id.clone(),
                command: Command::RawDownload {
                    path: path.clone(),
                    range_start,
                    range_end,
                },
                path: path.clone(),
                total_bytes: content_length,
                reply,
                chunk_sender: response_sender,
            }
        ),
        30000
    ) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            return router_error_response(error);
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Failed to start stream".to_string(),
                }),
            )
                .into_response();
        }
    }

    let first_chunk = match response_receiver.recv().await {
        Some(chunk) => chunk,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "No data received".to_string(),
                }),
            )
                .into_response();
        }
    };

    if first_chunk.is_error {
        let error_msg = if first_chunk.data.is_empty() {
            format!("File error: {}", path)
        } else {
            String::from_utf8_lossy(&first_chunk.data).to_string()
        };

        let status = if error_msg.contains("No such file") || error_msg.contains("not found") {
            StatusCode::NOT_FOUND
        } else if error_msg.contains("Permission denied") {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };

        return (status, Json(ErrorResponse { error: error_msg })).into_response();
    }

    use async_stream::stream;

    let stream = stream! {
        // `first_chunk` was awaited before constructing the HTTP response so we could still
        // return a normal JSON error response with an appropriate status code if the agent
        // failed immediately. Once we start streaming the body, the headers and status code are
        // already committed, so from this point forward we can only emit bytes or terminate the
        // stream with an I/O error.
        if !first_chunk.data.is_empty() {
            // `yield` produces one item from this async stream, which Axum forwards as the next
            // chunk in the HTTP response body.
            yield Ok(bytes::Bytes::from(first_chunk.data));
        }

        // Continue forwarding chunks from the agent to the HTTP client until the agent closes
        // the channel or reports a read error.
        while let Some(parsed) = response_receiver.recv().await {
            if parsed.is_error {
                // A later chunk can only fail after the response has already started. Convert the
                // agent error into a stream error so Axum/Hyper stops the body stream and the
                // client sees the download fail instead of silently receiving truncated data.
                let error_msg = if parsed.data.is_empty() {
                    "File read error on agent".to_string()
                } else {
                    String::from_utf8_lossy(&parsed.data).to_string()
                };
                yield Err(std::io::Error::other(error_msg));
                break;
            }

            // Empty chunks carry no payload, so skip them and wait for the next message.
            if !parsed.data.is_empty() {
                yield Ok(bytes::Bytes::from(parsed.data));
            }
        }
        // Reaching the end of the channel cleanly ends the HTTP body stream.
    };

    let mut response_builder = Response::builder()
        .status(status_code)
        .header("Content-Type", metadata.mime_type)
        .header("Content-Length", content_length.to_string())
        .header("Accept-Ranges", "bytes");

    if let Some(content_range) = content_range_header {
        response_builder = response_builder.header("Content-Range", content_range);
    }

    if params.download.as_deref() == Some("1") {
        let filename = path.split('/').next_back().unwrap_or("file");
        response_builder = response_builder.header(
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", filename),
        );
    }

    response_builder
        .body(Body::from_stream(stream))
        .unwrap()
        .into_response()
}

/// Route: `PUT /api/v1/agents/{agent}/raw/{*path}`
pub(crate) async fn raw_agent_put_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let total_bytes = match headers.get(axum::http::header::CONTENT_LENGTH) {
        Some(header_value) => match header_value.to_str() {
            Ok(value) => match value.parse::<u64>() {
                Ok(total_bytes) => total_bytes,
                Err(_) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: "Invalid Content-Length header".to_string(),
                        }),
                    )
                        .into_response();
                }
            },
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "Invalid Content-Length header".to_string(),
                    }),
                )
                    .into_response();
            }
        },
        None => {
            return (
                StatusCode::LENGTH_REQUIRED,
                Json(ErrorResponse {
                    error: "Content-Length header is required for uploads".to_string(),
                }),
            )
                .into_response();
        }
    };

    let resolved_path = match resolve_agent_path(&state, &agent_id, path).await {
        Ok(path) => path,
        Err(response) => return response,
    };

    let (upload_completion_sender, upload_completion_receiver) =
        tokio::sync::oneshot::channel::<Result<CommandResult, actors::router::RouterError>>();

    let request_id = match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::StartUploadStreamRest(
            actors::router::StartUploadRequest {
                agent_id: agent_id.clone(),
                command: Command::RawUpload {
                    path: resolved_path.clone(),
                },
                path: resolved_path.clone(),
                total_bytes,
                completion_sender: upload_completion_sender,
                reply,
            }
        ),
        30000
    ) {
        Ok(Ok(request_id)) => request_id,
        Ok(Err(error)) => {
            return router_error_response(error);
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to start upload: {:?}", error),
                }),
            )
                .into_response();
        }
    };

    let mut body_stream = body.into_data_stream();
    let mut chunk_index = ChunkIndex::new(0);
    let mut bytes_written = 0u64;
    // Any early return after this point means the client request ended before
    // the agent saw a terminal chunk, so drop-driven cancel must clean up.
    let mut cancel_guard =
        UploadCancelGuard::new(state.router_ref.clone(), agent_id.clone(), request_id);

    while let Some(next_chunk) = body_stream.next().await {
        let data = match next_chunk {
            Ok(data) => data,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("Failed to read request body: {}", error),
                    }),
                )
                    .into_response();
            }
        };

        bytes_written += data.len() as u64;

        if bytes_written > total_bytes {
            let abort_message = format!(
                "Upload exceeded Content-Length header: expected {} bytes, received {}",
                total_bytes, bytes_written
            );
            let abort_result = forward_split_stream_chunk(
                &state,
                &agent_id,
                &mut chunk_index,
                StreamChunkFrameRequest::new(request_id, abort_message.as_bytes()).is_error(true),
            )
            .await;
            cancel_guard.disarm();

            if let Err(response) = abort_result {
                return response;
            }

            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: abort_message,
                }),
            )
                .into_response();
        }

        // Upload chunks are forwarded as non-terminal frames until the handler
        // has seen exactly the declared Content-Length.
        if let Err(response) = forward_split_stream_chunk(
            &state,
            &agent_id,
            &mut chunk_index,
            StreamChunkFrameRequest::new(request_id, &data).is_last(false),
        )
        .await
        {
            return response;
        }
    }

    if bytes_written != total_bytes {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!(
                    "Upload stream ended before completion: expected {} bytes, received {}",
                    total_bytes, bytes_written
                ),
            }),
        )
            .into_response();
    }

    // The final empty frame is the protocol-level completion marker for uploads.
    if let Err(response) = forward_split_stream_chunk(
        &state,
        &agent_id,
        &mut chunk_index,
        StreamChunkFrameRequest::new(request_id, &[]),
    )
    .await
    {
        return response;
    }

    // Past this point the router or agent owns completion, so drop should no
    // longer emit a redundant cancel request.
    cancel_guard.disarm();

    match upload_completion_receiver.await {
        Ok(Ok(CommandResult::RawUpload)) => (
            StatusCode::OK,
            Json(RawUploadResponse {
                path: resolved_path,
                bytes_written,
            }),
        )
            .into_response(),
        Ok(Ok(CommandResult::Error { kind, message })) => {
            let status = command_error_status(&kind);

            (status, Json(ErrorResponse { error: message })).into_response()
        }
        Ok(Ok(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected upload completion response".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => router_error_response(error),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed waiting for upload completion: {}", error),
            }),
        )
            .into_response(),
    }
}
