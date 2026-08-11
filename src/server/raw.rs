use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use headers::{HeaderMap, HeaderMapExt, Range as RangeHeader};
use redoor::{
    actors,
    commands::{Command, CommandResult, CreateOneTimeTokenResponse, ErrorResponse},
    types::AgentId,
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
                    full_size: Some(metadata.file_size),
                    resume_offset: range_start,
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
        match begin_download_body_stream(response_receiver, &path, one_time_progress).await {
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

    match state
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
                    // Archive length is discovered while streaming; progress promotes the
                    // transferred count to total_bytes when the transfer completes.
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

    let body_stream = match begin_download_body_stream(response_receiver, &path, None).await {
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
                yield Err(std::io::Error::other(error_msg));
                break;
            }

            let is_last = parsed.is_last;
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
