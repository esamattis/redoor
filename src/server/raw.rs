use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use headers::{HeaderMap, HeaderMapExt, Range as RangeHeader};
use redoor::{
    Level, actors,
    commands::{Command, CommandResult, CreateOneTimeTokenResponse, ErrorResponse},
    log,
    types::{AgentId, RequestId},
};
use serde::Deserialize;
use uuid::Uuid;

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::{command_error_status, router_error_response},
    state::ServerState,
};

mod upload;

pub(crate) use upload::{AgentUpload, AgentUploadStartError, raw_agent_put_handler};

/// Records the bytes one token-authorized HTTP body handed off, including partial bodies on drop.
struct OneTimeDownloadProgress {
    registry: redoor::one_time_token_registry::OneTimeTokenRegistry,
    agent_id: AgentId,
    path: String,
    token: Uuid,
    start: u64,
    next_offset: u64,
    file_size: u64,
}

/// Cancels a direct download when its HTTP or request consumer disappears early.
pub(crate) struct DownloadCancelGuard {
    router_ref: actors::router::RouterHandle,
    agent_id: AgentId,
    request_id: RequestId,
    active: bool,
}

impl DownloadCancelGuard {
    /// Arms cancellation after the router has allocated the stream request id.
    pub(crate) fn new(
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

    /// Prevents duplicate cancellation after a terminal frame has been consumed.
    pub(crate) fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for DownloadCancelGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }

        let router_ref = self.router_ref.clone();
        let agent_id = self.agent_id.clone();
        let request_id = self.request_id;
        tokio::spawn(async move {
            if let Err(error) = router_ref
                .send_async(actors::router::RouterMsg::CancelTransfer {
                    agent_id: agent_id.clone(),
                    request_id,
                })
                .await
            {
                log!(
                    Level::Error,
                    "Failed to queue dropped download cleanup: agent_id={}, request_id={}, error={}",
                    agent_id,
                    request_id,
                    error
                );
            }
        });
    }
}

impl OneTimeDownloadProgress {
    /// Advances when Axum accepts an item so browser retry offsets cannot leave one frame uncredited.
    fn record_bytes(&mut self, bytes: u64) {
        self.next_offset = self.next_offset.saturating_add(bytes).min(self.file_size);
    }
}

impl Drop for OneTimeDownloadProgress {
    /// Persists partial coverage on cancellation and consumes the token when merged coverage is complete.
    fn drop(&mut self) {
        self.registry.record_downloaded_range(
            &self.agent_id,
            &self.path,
            &self.token,
            self.start..self.next_offset,
            self.file_size,
        );
    }
}

/// Controls download presentation and optional cookie-free one-time authorization.
#[derive(Deserialize)]
pub(crate) struct RawQueryParams {
    /// Preserves the authenticated API's explicit attachment option.
    download: Option<String>,
    /// Authorizes exactly one download for the token's bound agent and absolute path.
    one_time_token: Option<Uuid>,
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
///
/// Files stream as raw bytes (optional Range). Directories reuse the agent tar
/// download path so the browser can save a folder as an archive without a
/// separate copy endpoint.
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
            .contains(&agent_id, &path, one_time_token)
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

    if metadata.is_dir {
        return stream_directory_archive(
            state,
            agent_id,
            path,
            headers.typed_get::<RangeHeader>().is_some(),
        )
        .await;
    }

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

    let (response_sender, response_receiver) =
        tokio::sync::mpsc::channel::<redoor::streaming::StreamChunk>(1);

    let request_id = match state
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
                    full_size: Some(metadata.file_size),
                    resume_offset: range_start,
                    reply,
                    chunk_sender: response_sender,
                },
            )
        })
        .await
    {
        Ok(Ok(request_id)) => request_id,
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
    };

    let cancel_guard =
        DownloadCancelGuard::new(state.router_ref.clone(), agent_id.clone(), request_id);

    let one_time_progress = params.one_time_token.map(|token| OneTimeDownloadProgress {
        registry: state.one_time_token_registry.clone(),
        agent_id: agent_id.clone(),
        path: path.clone(),
        token,
        start: range_start.unwrap_or(0),
        next_offset: range_start.unwrap_or(0),
        file_size: metadata.file_size,
    });
    let body_stream =
        match begin_download_body_stream(response_receiver, &path, one_time_progress, cancel_guard)
            .await
        {
            Ok(stream) => stream,
            Err(response) => return response,
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
        .body(Body::from_stream(body_stream))
        .unwrap()
        .into_response()
}

/// Streams a directory as gzip-compressed tar using the existing agent tar download worker.
///
/// Compression stays on the REST edge so agent↔agent copy can keep piping plain tar without
/// gunzip support or a second transfer payload kind.
async fn stream_directory_archive(
    state: ServerState,
    agent_id: AgentId,
    path: String,
    has_range_header: bool,
) -> Response {
    // Tar size is unknown until the agent finishes walking the tree, so byte ranges
    // cannot be satisfied the way they are for fixed-length file downloads.
    if has_range_header {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Range requests are not supported for directory archive downloads"
                    .to_string(),
            }),
        )
            .into_response();
    }

    let (response_sender, response_receiver) =
        tokio::sync::mpsc::channel::<redoor::streaming::StreamChunk>(1);

    let request_id = match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteStreamCommandRest(
                actors::router::ExecuteStreamRequest {
                    agent_id: agent_id.clone(),
                    command: Command::TarDownload {
                        path: path.clone(),
                        include_root: true,
                    },
                    path: path.clone(),
                    // Archive length is unknown at start so the body can begin immediately
                    // without Content-Length. A parallel metadata walk may publish a total
                    // later; completion still promotes counted bytes if that walk is late.
                    // Counts are plain tar bytes from the agent, before REST-edge gzip.
                    total_bytes: 0,
                    full_size: None,
                    resume_offset: None,
                    reply,
                    chunk_sender: response_sender,
                },
            )
        })
        .await
    {
        Ok(Ok(request_id)) => request_id,
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
    };

    let cancel_guard =
        DownloadCancelGuard::new(state.router_ref.clone(), agent_id.clone(), request_id);

    let body_stream =
        match begin_download_body_stream(response_receiver, &path, None, cancel_guard).await {
            Ok(stream) => stream,
            Err(response) => return response,
        };

    // Gzip only the HTTP body: agent still emits plain tar for reuse by copy uploads.
    let tar_reader = tokio_util::io::StreamReader::new(body_stream);
    let gzip_reader = async_compression::tokio::bufread::GzipEncoder::new(tar_reader);
    let gzipped_stream = tokio_util::io::ReaderStream::new(gzip_reader);

    let leaf_name = path.split('/').next_back().filter(|name| !name.is_empty());
    let archive_name = match leaf_name {
        Some(name) => format!("{name}.tar.gz"),
        None => "archive.tar.gz".to_string(),
    };

    // Always attachment: directory bytes are an archive, never inline browser content.
    // application/gzip keeps the payload as a downloadable .tar.gz rather than transparent
    // Content-Encoding decompression that would leave clients with raw tar bytes.
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/gzip")
        .header(
            "Content-Disposition",
            format!("attachment; filename=\"{archive_name}\""),
        )
        .body(Body::from_stream(gzipped_stream))
        .unwrap()
        .into_response()
}

/// Waits for the first agent chunk so immediate failures can still return JSON errors,
/// then builds the HTTP body stream used by both raw file and directory tar downloads.
async fn begin_download_body_stream(
    mut response_receiver: tokio::sync::mpsc::Receiver<redoor::streaming::StreamChunk>,
    path: &str,
    mut one_time_progress: Option<OneTimeDownloadProgress>,
    mut cancel_guard: DownloadCancelGuard,
) -> Result<impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + use<>, Response>
{
    let first_chunk = match response_receiver.recv().await {
        Some(chunk) => chunk,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "No data received".to_string(),
                }),
            )
                .into_response());
        }
    };

    if first_chunk.is_error {
        cancel_guard.disarm();
        let error_msg = if first_chunk.data.is_empty() {
            format!("File error: {path}")
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

        return Err((status, Json(ErrorResponse { error: error_msg })).into_response());
    }

    use async_stream::stream;

    Ok(stream! {
        // `first_chunk` was awaited before constructing the HTTP response so we could still
        // return a normal JSON error response with an appropriate status code if the agent
        // failed immediately. Once we start streaming the body, the headers and status code are
        // already committed, so from this point forward we can only emit bytes or terminate the
        // stream with an I/O error.
        let mut pending_chunk = Some(first_chunk);
        while let Some(parsed) = match pending_chunk.take() {
            Some(chunk) => Some(chunk),
            None => response_receiver.recv().await,
        } {
            if parsed.is_error {
                // A later chunk can only fail after the response has already started. Convert the
                // agent error into a stream error so Axum/Hyper stops the body stream and the
                // client sees the download fail instead of silently receiving truncated data.
                let error_msg = if parsed.data.is_empty() {
                    "File read error on agent".to_string()
                } else {
                    String::from_utf8_lossy(&parsed.data).to_string()
                };
                cancel_guard.disarm();
                yield Err(std::io::Error::other(error_msg));
                break;
            }

            let is_last = parsed.is_last;
            if is_last {
                cancel_guard.disarm();
            }
            let bytes = parsed.data.len() as u64;
            // Empty chunks carry no payload, so skip them and wait for the next message.
            if !parsed.data.is_empty() {
                if let Some(progress) = one_time_progress.as_mut() {
                    progress.record_bytes(bytes);
                }
                yield Ok(bytes::Bytes::from(parsed.data));
            }
            if is_last {
                break;
            }
        }
        // Reaching the end of the channel cleanly ends the HTTP body stream.
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use redoor::{
        actors::router::{
            ExecuteStreamRequest, RegisterAgentRequest, RegisterTransferConnectionRequest,
            RouteStreamChunkRequest, RouterMsg,
        },
        commands::{Command, TransferProgressState, current_binary_identity},
        log_registry::LogRegistry,
        streaming::{StreamChunk, StreamPayloadKind},
        terminal_registry::TerminalRegistry,
        types::{ChunkIndex, Message, SocketId},
    };
    use tokio::{
        sync::{mpsc, oneshot, watch},
        time::{Duration, timeout},
    };

    /// Dropping an HTTP body must cancel even when the agent never sends another chunk.
    #[tokio::test]
    async fn body_drop_cancels_download_without_subsequent_chunk() {
        let _ = redoor::logging::init(None).await;
        let (router_ref, router_task) =
            actors::router::spawn_router(TerminalRegistry::new(), LogRegistry::new());
        let agent_id = AgentId::from("body-drop-agent");
        let (text_sender, mut text_receiver) = mpsc::channel(64);
        let (priority_sender, mut priority_receiver) = mpsc::channel(16);
        let (binary_sender, _binary_receiver) = mpsc::channel(1);

        router_ref
            .send_async(RouterMsg::RegisterAgent(RegisterAgentRequest {
                agent_id: agent_id.clone(),
                agent_name: "body-drop-agent".to_string(),
                socket_id: SocketId::new(),
                outgoing_commands: text_sender,
                outgoing_priority: priority_sender,
                os: "macos".to_string(),
                arch: "arm64".to_string(),
                hostname: "host".to_string(),
                username: "user".to_string(),
                default_directory: "/tmp".to_string(),
                binary: current_binary_identity(),
                supports_self_exec: true,
                supports_native_open: true,
                supports_trash: true,
                supports_move_to_trash: true,
                watchdog: None,
                watchdog_attempt_generation: None,
            }))
            .await
            .expect("agent registration queued");
        let transfer_token = match priority_receiver
            .recv()
            .await
            .expect("transfer token queued")
        {
            axum::extract::ws::Message::Text(text) => {
                match serde_json::from_str::<Message>(&text).expect("valid transfer bootstrap") {
                    Message::TransferSocketOpen { token } => token,
                    other => panic!("unexpected bootstrap message: {other:?}"),
                }
            }
            other => panic!("unexpected bootstrap frame: {other:?}"),
        };
        let (shutdown_sender, _shutdown_receiver) = watch::channel(false);
        router_ref
            .request(1_000, |reply| {
                RouterMsg::RegisterTransferConnection(RegisterTransferConnectionRequest {
                    agent_id: agent_id.clone(),
                    token: transfer_token,
                    socket_id: SocketId::new(),
                    outgoing_binary: binary_sender,
                    shutdown: shutdown_sender,
                    reply,
                })
            })
            .await
            .expect("transfer registration request completed")
            .expect("transfer registration accepted");

        let path = "/tmp/stalled.bin".to_string();
        let (chunk_sender, chunk_receiver) = mpsc::channel(1);
        let request_id = router_ref
            .request(1_000, |reply| {
                RouterMsg::ExecuteStreamCommandRest(ExecuteStreamRequest {
                    agent_id: agent_id.clone(),
                    command: Command::RawDownload {
                        path: path.clone(),
                        range_start: None,
                        range_end: None,
                    },
                    path: path.clone(),
                    total_bytes: 2,
                    full_size: Some(2),
                    resume_offset: None,
                    reply,
                    chunk_sender,
                })
            })
            .await
            .expect("download start request completed")
            .expect("download start accepted");
        let command_request_id = match text_receiver.recv().await.expect("download command queued")
        {
            axum::extract::ws::Message::Text(text) => {
                match serde_json::from_str::<Message>(&text).expect("valid download command") {
                    Message::Command { request_id, .. } => request_id,
                    other => panic!("unexpected command message: {other:?}"),
                }
            }
            other => panic!("unexpected command frame: {other:?}"),
        };
        // Returning the exact command id lets the body cancel the router-owned transfer.
        assert_eq!(request_id, command_request_id);

        let (chunk_reply, chunk_received) = oneshot::channel();
        router_ref
            .send_async(RouterMsg::RouteStreamChunk(RouteStreamChunkRequest {
                agent_id: agent_id.clone(),
                chunk: StreamChunk {
                    request_id,
                    chunk_index: ChunkIndex::new(0),
                    is_last: false,
                    is_error: false,
                    payload_kind: StreamPayloadKind::RawFile,
                    data: vec![b'a'],
                },
                reply: chunk_reply,
            }))
            .await
            .expect("first chunk queued");
        let cancel_guard =
            DownloadCancelGuard::new(router_ref.clone(), agent_id.clone(), request_id);
        let mut body = Box::pin(
            begin_download_body_stream(chunk_receiver, &path, None, cancel_guard)
                .await
                .expect("first chunk starts body"),
        );
        let first_bytes = body
            .next()
            .await
            .expect("body yielded first chunk")
            .expect("first chunk was successful");
        // Receiving one nonterminal byte proves cancellation does not depend on another frame.
        assert_eq!(first_bytes.as_ref(), b"a");
        chunk_received.await.expect("first chunk acknowledged");

        drop(body);

        let cancel_request_id = match timeout(Duration::from_secs(1), priority_receiver.recv())
            .await
            .expect("body drop should promptly reach the agent")
            .expect("cancel message queued")
        {
            axum::extract::ws::Message::Text(text) => {
                match serde_json::from_str::<Message>(&text).expect("valid cancel command") {
                    Message::CancelTransfer { request_id } => request_id,
                    other => panic!("unexpected cancellation message: {other:?}"),
                }
            }
            other => panic!("unexpected cancellation frame: {other:?}"),
        };
        // The agent receives cancellation for the stalled request without a follow-up chunk.
        assert_eq!(cancel_request_id, request_id);
        let progress = router_ref
            .request(1_000, |reply| RouterMsg::GetTransferProgress { reply })
            .await
            .expect("progress request completed");
        let transfer = progress
            .transfers
            .iter()
            .find(|transfer| transfer.request_id == request_id.as_transfer_id())
            .expect("download progress retained");
        // Terminal progress proves router state no longer remains indefinitely active.
        assert!(matches!(transfer.state, TransferProgressState::Errored));

        router_ref
            .send_async(RouterMsg::Shutdown)
            .await
            .expect("router shutdown queued");
        router_task.await.expect("router task joined");
    }
}
