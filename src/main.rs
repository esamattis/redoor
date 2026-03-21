use redoor::actors;
use redoor::commands::{
    AgentInfoResponse, AgentListResponse, CatResponse, Command, CommandResult, EchoRequest,
    EchoResponse, ErrorResponse, LsDirectoryResponse, LsFileResponse, RawUploadResponse,
};

use serde::Deserialize;

use axum::{
    Json, Router,
    body::Body,
    extract::{
        Path, Query, State as AxumState,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use headers::{HeaderMap, HeaderMapExt, Range as RangeHeader};

use ractor::{ActorRef, call_t};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

#[derive(Clone)]
struct ServerState {
    router_ref: ActorRef<actors::router::RouterMsg>,
}

#[derive(Deserialize)]
struct RawQueryParams {
    download: Option<String>,
}

#[tokio::main]
async fn main() {
    use ractor::Actor;
    use std::env;

    let (router_ref, _) = actors::router::RouterActor::spawn(None, actors::router::RouterActor, ())
        .await
        .expect("Failed to spawn RouterActor");

    let _ = actors::command_executor::CommandExecutorActor::spawn(
        None,
        actors::command_executor::CommandExecutorActor,
        (),
    )
    .await
    .expect("Failed to spawn CommandExecutorActor");

    let server_state = ServerState {
        router_ref: router_ref.clone(),
    };

    let app = Router::new()
        .route("/ws", get(websocket_handler))
        .route("/api/v1/agents", get(list_agents_handler))
        .route(
            "/api/v1/transfers/progress",
            get(list_transfer_progress_handler),
        )
        .route("/api/v1/agents/{agent}", get(get_agent_details_handler))
        .route("/api/v1/agents/{agent}/ls/{*path}", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/cat/{*path}", get(cat_agent_handler))
        .route(
            "/api/v1/agents/{agent}/raw/{*path}",
            get(raw_agent_handler).put(raw_agent_put_handler),
        )
        .route("/api/v1/agents/{agent}/echo", post(echo_agent_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(server_state);

    let port = env::var("REDOOR_PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse::<u16>()
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
    println!("Server running on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state.router_ref))
}

async fn handle_socket(socket: WebSocket, router_ref: ActorRef<actors::router::RouterMsg>) {
    let socket_id = Uuid::new_v4().to_string();
    actors::session::handle_websocket(socket, socket_id, router_ref).await;
}

async fn list_agents_handler(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::GetAgentList { reply },
        5000
    ) {
        Ok(agents) => {
            let response = AgentListResponse {
                agents: agents
                    .into_iter()
                    .map(|(id, name)| AgentInfoResponse { id, name })
                    .collect(),
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => {
            let error_msg = format!("Failed to get agents: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

async fn list_transfer_progress_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::GetTransferProgress { reply },
        5000
    ) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(e) => {
            let error_msg = format!("Failed to get transfer progress: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

async fn get_agent_details_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::GetAgentDetails,
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::GetAgentDetails(details) => {
                if details.name.is_empty() {
                    (
                        StatusCode::NOT_FOUND,
                        Json(ErrorResponse {
                            error: format!("Agent not found: {}", agent),
                        }),
                    )
                        .into_response()
                } else {
                    (StatusCode::OK, Json(details)).into_response()
                }
            }
            CommandResult::Error { message } => {
                let status = if message.contains("not found") {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                };
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to get agent details: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

async fn ls_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Ls { path: Some(path) },
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::LsDirectory(ls_result) => (
                StatusCode::OK,
                Json(LsDirectoryResponse {
                    files: ls_result.files,
                }),
            )
                .into_response(),
            CommandResult::LsFile(ls_result) => (
                StatusCode::OK,
                Json(LsFileResponse {
                    size: ls_result.size,
                    path: ls_result.path,
                    owner: ls_result.owner,
                    group: ls_result.group,
                    uid: ls_result.uid,
                    gid: ls_result.gid,
                }),
            )
                .into_response(),
            CommandResult::Error { message } => {
                let status = if message.contains("not found")
                    || message.contains("No such file")
                    || message.contains("not a directory")
                {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to execute ls command: {:?}", e);
            let status = StatusCode::INTERNAL_SERVER_ERROR;
            (status, Json(ErrorResponse { error: error_msg })).into_response()
        }
    }
}

async fn cat_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Cat { path },
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::Cat(cat_result) => (
                StatusCode::OK,
                Json(CatResponse {
                    content: cat_result.content,
                    path: cat_result.path,
                }),
            )
                .into_response(),
            CommandResult::Error { message } => {
                let status = if message.contains("not found")
                    || message.contains("No such file")
                    || message.contains("not a directory")
                {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to execute cat command: {:?}", e);
            let status = StatusCode::INTERNAL_SERVER_ERROR;
            (status, Json(ErrorResponse { error: error_msg })).into_response()
        }
    }
}

async fn echo_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<EchoRequest>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Echo {
                request: payload.clone()
            },
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::Echo(echo_result) => (
                StatusCode::OK,
                Json(EchoResponse {
                    message: echo_result.message,
                }),
            )
                .into_response(),
            CommandResult::Error { message } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to execute echo command: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

/// Parse Range header and return (start, end) byte positions (inclusive)
/// Returns None if no valid range can be satisfied
/// Only supports a single range for simplicity
fn parse_range_header(range: &RangeHeader, file_size: u64) -> Option<(u64, u64)> {
    use std::ops::Bound;

    // Get satisfiable ranges - these are already validated against file_size
    let mut ranges = range.satisfiable_ranges(file_size);

    // Get the first range (we only support single range for now)
    let (start_bound, end_bound) = ranges.next()?;

    let start = match start_bound {
        Bound::Included(s) => s,
        Bound::Excluded(s) => s + 1,
        Bound::Unbounded => 0,
    };

    // For the end bound, we need to clamp to file_size - 1
    // The satisfiable_ranges method doesn't clamp the end bound for us
    let end = match end_bound {
        Bound::Included(e) => std::cmp::min(e, file_size - 1),
        Bound::Excluded(e) => std::cmp::min(e.saturating_sub(1), file_size - 1),
        Bound::Unbounded => file_size - 1,
    };

    // Final validation
    if start >= file_size || start > end {
        return None;
    }

    Some((start, end))
}

async fn raw_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    Query(params): Query<RawQueryParams>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    // Get file metadata first
    let metadata = match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Metadata { path: path.clone() },
            reply,
        },
        5000
    ) {
        Ok(CommandResult::Metadata(metadata)) => metadata,
        Ok(CommandResult::Error { message }) => {
            return (
                StatusCode::NOT_FOUND,
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
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to get file metadata: {:?}", e),
                }),
            )
                .into_response();
        }
    };

    // Parse Range header if present
    let range_option = headers.typed_get::<RangeHeader>();
    let (range_start, range_end, status_code, content_length, content_range_header) =
        if let Some(range) = range_option {
            match parse_range_header(&range, metadata.file_size) {
                Some((start, end)) => {
                    // end is inclusive, so content_length = end - start + 1
                    let length = end - start + 1;
                    let content_range = format!("bytes {}-{}/{}", start, end, metadata.file_size);
                    (
                        Some(start),
                        Some(end + 1), // range_end is exclusive for the command
                        StatusCode::PARTIAL_CONTENT,
                        length,
                        Some(content_range),
                    )
                }
                None => {
                    // Range not satisfiable
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
            // No range header - return full file
            (None, None, StatusCode::OK, metadata.file_size, None)
        };

    let (response_sender, mut response_receiver) =
        tokio::sync::mpsc::unbounded_channel::<redoor::streaming::StreamChunk>();

    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteStreamCommandRest {
            agent_id: agent.clone(),
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
        30000
    ) {
        Ok(Ok(())) => {} // stream started successfully
        Ok(Err(error_msg)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response();
        }
        Err(_e) => {
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
        if !first_chunk.data.is_empty() {
            yield Ok(bytes::Bytes::from(first_chunk.data));
        }

        while let Some(parsed) = response_receiver.recv().await {
            if parsed.is_error {
                let error_msg = if parsed.data.is_empty() {
                    "File read error on agent".to_string()
                } else {
                    String::from_utf8_lossy(&parsed.data).to_string()
                };
                yield Err(std::io::Error::other(error_msg));
                break;
            }
            if !parsed.data.is_empty() {
                yield Ok(bytes::Bytes::from(parsed.data));
            }
        }
    };

    let mut response_builder = Response::builder()
        .status(status_code)
        .header("Content-Type", metadata.mime_type)
        .header("Content-Length", content_length.to_string())
        .header("Accept-Ranges", "bytes");

    // Add Content-Range header for partial content
    if let Some(content_range) = content_range_header {
        response_builder = response_builder.header("Content-Range", content_range);
    }

    // Add Content-Disposition only if download=1 query parameter is present
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

async fn raw_agent_put_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
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

    let resolved_path = if path.starts_with('/') {
        path
    } else {
        match call_t!(
            &state.router_ref,
            |reply| actors::router::RouterMsg::ExecuteCommandRest {
                agent_id: agent.clone(),
                command: Command::GetAgentDetails,
                reply,
            },
            30000
        ) {
            Ok(CommandResult::GetAgentDetails(details)) => {
                format!(
                    "{}/{}",
                    details.cwd.trim_end_matches('/'),
                    path.trim_start_matches('/')
                )
            }
            Ok(CommandResult::Error { message }) => {
                let status = if message.contains("not found") {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                };

                return (status, Json(ErrorResponse { error: message })).into_response();
            }
            Ok(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Unexpected result type while resolving upload path".to_string(),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Failed to resolve upload path: {:?}", e),
                    }),
                )
                    .into_response();
            }
        }
    };

    let (upload_completion_sender, upload_completion_receiver) =
        tokio::sync::oneshot::channel::<Result<CommandResult, String>>();

    let request_id = match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::StartUploadStreamRest {
            agent_id: agent.clone(),
            command: Command::RawUpload {
                path: resolved_path.clone(),
            },
            path: resolved_path.clone(),
            total_bytes,
            completion_sender: upload_completion_sender,
            reply,
        },
        30000
    ) {
        Ok(Ok(request_id)) => request_id,
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
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to start upload: {:?}", e),
                }),
            )
                .into_response();
        }
    };

    let mut body_stream = body.into_data_stream();
    let mut chunk_index = 0u64;
    let mut bytes_written = 0u64;

    while let Some(next_chunk) = body_stream.next().await {
        let data = match next_chunk {
            Ok(data) => data,
            Err(error) => {
                let abort_chunk = redoor::streaming::StreamChunk {
                    request_id,
                    chunk_index,
                    is_last: true,
                    is_error: true,
                    data: format!("Failed to read request body: {}", error).into_bytes(),
                };

                let _ = call_t!(
                    &state.router_ref,
                    |reply| actors::router::RouterMsg::SendStreamChunkToAgent {
                        agent_id: agent.clone(),
                        request_id,
                        chunk: abort_chunk,
                        reply,
                    },
                    30000
                );

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

        let stream_chunk = redoor::streaming::StreamChunk {
            request_id,
            chunk_index,
            is_last: false,
            is_error: false,
            data: data.to_vec(),
        };

        match call_t!(
            &state.router_ref,
            |reply| actors::router::RouterMsg::SendStreamChunkToAgent {
                agent_id: agent.clone(),
                request_id,
                chunk: stream_chunk,
                reply,
            },
            30000
        ) {
            Ok(Ok(())) => {}
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
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Failed to forward upload chunk: {:?}", e),
                    }),
                )
                    .into_response();
            }
        }

        chunk_index += 1;
    }

    let final_chunk = redoor::streaming::StreamChunk {
        request_id,
        chunk_index,
        is_last: true,
        is_error: false,
        data: Vec::new(),
    };

    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::SendStreamChunkToAgent {
            agent_id: agent.clone(),
            request_id,
            chunk: final_chunk,
            reply,
        },
        30000
    ) {
        Ok(Ok(())) => {}
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
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to forward final upload chunk: {:?}", e),
                }),
            )
                .into_response();
        }
    }

    match upload_completion_receiver.await {
        Ok(Ok(CommandResult::RawUpload)) => (
            StatusCode::OK,
            Json(RawUploadResponse {
                path: resolved_path,
                bytes_written,
            }),
        )
            .into_response(),
        Ok(Ok(CommandResult::Error { message })) => {
            let status = if message.contains("not found") {
                StatusCode::NOT_FOUND
            } else if message.contains("Permission denied") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };

            (status, Json(ErrorResponse { error: message })).into_response()
        }
        Ok(Ok(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected upload completion response".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error_msg)) => {
            let status = if error_msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else if error_msg.contains("Permission denied") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };

            (status, Json(ErrorResponse { error: error_msg })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed waiting for upload completion: {}", e),
            }),
        )
            .into_response(),
    }
}
