use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use headers::{HeaderMap, HeaderMapExt, Range as RangeHeader};
use redoor::{
    actors,
    commands::{
        Command, CommandResult, CreateOneTimeTokenResponse, ErrorResponse, RawUploadResponse,
    },
    streaming::StreamChunkFrameRequest,
    types::{AgentId, ChunkIndex, RequestId},
};
use serde::Deserialize;
use uuid::Uuid;

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

/// Controls download presentation and optional cookie-free one-time authorization.
#[derive(Deserialize)]
pub(crate) struct RawQueryParams {
    /// Preserves the authenticated API's explicit attachment option.
    download: Option<String>,
    /// Authorizes exactly one download for the token's bound agent and absolute path.
    one_time_token: Option<Uuid>,
}

/// Triggers router-side upload cancellation if the HTTP handler exits before the
/// upload reaches a terminal state.
struct UploadCancelGuard {
    router_ref: actors::router::RouterHandle,
    agent_id: AgentId,
    request_id: RequestId,
    active: bool,
}

/// Distinguishes setup failures from an agent response that completed before readiness.
pub(crate) enum AgentUploadStartError {
    /// Router or readiness transport failures already mapped to the standard JSON response.
    Response(Response),
    /// Agent-side setup can finish before the transfer websocket reports ready.
    Finished(Box<Result<CommandResult, actors::router::RouterError>>),
}

/// Owns one initialized server-to-agent upload and cancels it if its producer exits early.
pub(crate) struct AgentUpload {
    state: ServerState,
    agent_id: AgentId,
    path: String,
    total_bytes: u64,
    bytes_written: u64,
    request_id: RequestId,
    chunk_index: ChunkIndex,
    completion_receiver:
        tokio::sync::oneshot::Receiver<Result<CommandResult, actors::router::RouterError>>,
    cancel_guard: UploadCancelGuard,
}

impl AgentUpload {
    /// Starts a transfer and waits until its dedicated websocket is ready for bounded chunks.
    pub(crate) async fn start(
        state: &ServerState,
        agent_id: AgentId,
        command: Command,
        path: String,
        total_bytes: u64,
    ) -> Result<Self, AgentUploadStartError> {
        let (completion_sender, completion_receiver) = tokio::sync::oneshot::channel();
        let (ready_sender, ready_receiver) = tokio::sync::oneshot::channel();
        let request_id = match state
            .router_ref
            .request(30000, |reply| {
                actors::router::RouterMsg::StartUploadStreamRest(
                    actors::router::StartUploadRequest {
                        agent_id: agent_id.clone(),
                        command,
                        path: path.clone(),
                        total_bytes,
                        completion_sender,
                        ready_sender,
                        reply,
                    },
                )
            })
            .await
        {
            Ok(Ok(request_id)) => request_id,
            Ok(Err(error)) => {
                return Err(AgentUploadStartError::Response(router_error_response(
                    error,
                )));
            }
            Err(error) => {
                return Err(AgentUploadStartError::Response(
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: format!("Failed to start upload: {error:?}"),
                        }),
                    )
                        .into_response(),
                ));
            }
        };
        let mut cancel_guard =
            UploadCancelGuard::new(state.router_ref.clone(), agent_id.clone(), request_id);
        match tokio::time::timeout(std::time::Duration::from_millis(30000), ready_receiver).await {
            Ok(Ok(Ok(actors::router::UploadStartOutcome::Ready))) => {}
            Ok(Ok(Ok(actors::router::UploadStartOutcome::Finished(completion)))) => {
                cancel_guard.disarm();
                return Err(AgentUploadStartError::Finished(completion));
            }
            Ok(Ok(Err(error))) => {
                cancel_guard.disarm();
                return Err(AgentUploadStartError::Response(router_error_response(
                    error,
                )));
            }
            Ok(Err(_)) => {
                return Err(AgentUploadStartError::Response(
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: "Upload readiness channel closed".to_string(),
                        }),
                    )
                        .into_response(),
                ));
            }
            Err(_) => {
                return Err(AgentUploadStartError::Response(
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: "Timed out waiting for upload readiness".to_string(),
                        }),
                    )
                        .into_response(),
                ));
            }
        }

        Ok(Self {
            state: state.clone(),
            agent_id,
            path,
            total_bytes,
            bytes_written: 0,
            request_id,
            chunk_index: ChunkIndex::new(0),
            completion_receiver,
            cancel_guard,
        })
    }

    /// Forwards one producer chunk while enforcing the declared total byte count.
    pub(crate) async fn send(&mut self, data: &[u8]) -> Result<(), Response> {
        self.bytes_written += data.len() as u64;
        if self.bytes_written > self.total_bytes {
            let message = format!(
                "Upload exceeded Content-Length header: expected {} bytes, received {}",
                self.total_bytes, self.bytes_written
            );
            let result = forward_split_stream_chunk(
                &self.state,
                &self.agent_id,
                &mut self.chunk_index,
                StreamChunkFrameRequest::new(self.request_id, message.as_bytes()).is_error(true),
            )
            .await;
            self.cancel_guard.disarm();
            result?;
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse { error: message }),
            )
                .into_response());
        }
        forward_split_stream_chunk(
            &self.state,
            &self.agent_id,
            &mut self.chunk_index,
            StreamChunkFrameRequest::new(self.request_id, data).is_last(false),
        )
        .await
    }

    /// Sends the terminal marker and waits for permission restoration and atomic rename.
    pub(crate) async fn finish(mut self) -> Result<(CommandResult, u64), Response> {
        if self.bytes_written != self.total_bytes {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!(
                        "Upload stream ended before completion: expected {} bytes, received {}",
                        self.total_bytes, self.bytes_written
                    ),
                }),
            )
                .into_response());
        }
        forward_split_stream_chunk(
            &self.state,
            &self.agent_id,
            &mut self.chunk_index,
            StreamChunkFrameRequest::new(self.request_id, &[]),
        )
        .await?;
        self.cancel_guard.disarm();
        match self.completion_receiver.await {
            Ok(Ok(completion)) => Ok((completion, self.bytes_written)),
            Ok(Err(error)) => Err(router_error_response(error)),
            Err(error) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed waiting for upload completion: {error}"),
                }),
            )
                .into_response()),
        }
    }

    /// Returns the destination for response mapping without exposing transfer internals.
    pub(crate) fn path(&self) -> &str {
        &self.path
    }
}

impl UploadCancelGuard {
    /// Arms a new guard for one active upload request.
    fn new(
        router_ref: actors::router::RouterHandle,
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
            .send(actors::router::RouterMsg::CancelTransfer {
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
        match state
            .router_ref
            .request(30000, |reply| {
                actors::router::RouterMsg::SendStreamChunkToAgent(
                    actors::router::SendStreamChunkRequest {
                        agent_id: agent_id.clone(),
                        request_id: chunk.request_id,
                        chunk,
                        reply,
                    },
                )
            })
            .await
        {
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
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    Query(params): Query<RawQueryParams>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent.clone());
    let token_download = if let Some(one_time_token) = params.one_time_token.as_ref() {
        if !state
            .one_time_token_registry
            .consume(&agent_id, &path, one_time_token)
        {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Invalid or expired one-time token".to_string(),
                }),
            )
                .into_response();
        }
        true
    } else {
        false
    };
    let metadata = match state
        .router_ref
        .request(5000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Metadata { path: path.clone() },
                reply,
            })
        })
        .await
    {
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

    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteStreamCommandRest(
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
                },
            )
        })
        .await
    {
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

    if token_download || params.download.as_deref() == Some("1") {
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

/// Route: `POST /api/v1/agents/{agent}/one-time-token/{*path}`
pub(crate) async fn create_one_time_token_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent);
    let metadata = match state
        .router_ref
        .request(5000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Metadata { path: path.clone() },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::Metadata(metadata)) if metadata.is_file => metadata,
        Ok(CommandResult::Metadata(_)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "One-time download links can only be created for files".to_string(),
                }),
            )
                .into_response();
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
    let one_time_token = state
        .one_time_token_registry
        .create(agent_id, metadata.path)
        .to_string();
    (
        StatusCode::OK,
        Json(CreateOneTimeTokenResponse { one_time_token }),
    )
        .into_response()
}

/// Route: `PUT /api/v1/agents/{agent}/raw/{*path}`
pub(crate) async fn raw_agent_put_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
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

    let resolved_path = path;
    let mut upload = match AgentUpload::start(
        &state,
        agent_id,
        Command::RawUpload {
            path: resolved_path.clone(),
        },
        resolved_path.clone(),
        total_bytes,
    )
    .await
    {
        Ok(upload) => upload,
        Err(AgentUploadStartError::Response(response)) => return response,
        Err(AgentUploadStartError::Finished(completion)) => {
            return raw_upload_completion_response(*completion, &resolved_path, 0);
        }
    };

    let mut body_stream = body.into_data_stream();
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

        if let Err(response) = upload.send(&data).await {
            return response;
        }
    }
    let response_path = upload.path().to_string();
    match upload.finish().await {
        Ok((completion, bytes_written)) => {
            raw_upload_completion_response(Ok(completion), &response_path, bytes_written)
        }
        Err(response) => response,
    }
}

/// Maps one upload completion (including early init failures) to the established HTTP response.
fn raw_upload_completion_response(
    completion: Result<CommandResult, actors::router::RouterError>,
    path: &str,
    bytes_written: u64,
) -> Response {
    match completion {
        Ok(CommandResult::RawUpload) => (
            StatusCode::OK,
            Json(RawUploadResponse {
                path: path.to_string(),
                bytes_written,
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
                error: "Unexpected upload completion response".to_string(),
            }),
        )
            .into_response(),
        Err(error) => router_error_response(error),
    }
}
