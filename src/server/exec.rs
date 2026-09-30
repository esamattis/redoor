//! Dedicated non-PTY execution endpoint reuses stream routing and drop-triggered cancellation.

use super::{responses::router_error_response, state::ServerState, streaming::OutputCancelGuard};
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors::router::{ExecuteStreamRequest, OutputStreamTracking, RouterMsg},
    commands::{Command, ErrorResponse},
    exec_protocol::{CancelExecutionResponse, ExecRequest},
    types::{AgentId, RequestId},
};

/// Cancels process output through its own resource while file-transfer history stays file-only.
pub(crate) async fn cancel_execution_handler(
    Path((agent, execution_id)): Path<(String, u64)>,
    State(state): State<ServerState>,
) -> Response {
    let request_id = RequestId::new(execution_id);
    match state
        .router_ref
        .request(5_000, |reply| RouterMsg::CancelExecution {
            agent_id: AgentId::from(agent),
            request_id,
            reply,
        })
        .await
    {
        Ok(Ok(true)) => (
            StatusCode::ACCEPTED,
            Json(CancelExecutionResponse {
                execution_id: request_id,
            }),
        )
            .into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Execution not found".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => router_error_response(error),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to cancel execution: {error:?}"),
            }),
        )
            .into_response(),
    }
}

/// Returns NDJSON immediately after admission; dropping the body cancels the owned process.
pub(crate) async fn exec_handler(
    Path(agent): Path<String>,
    State(state): State<ServerState>,
    Json(request): Json<ExecRequest>,
) -> Response {
    if let Err(error) = request.validate() {
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })).into_response();
    }
    let agent_id = AgentId::from(agent);
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    let (terminal_sender, terminal_receiver) = tokio::sync::watch::channel(None);
    let id = match state
        .router_ref
        .request(30_000, |reply| {
            RouterMsg::ExecuteStreamCommandRest(ExecuteStreamRequest {
                agent_id: agent_id.clone(),
                command: Command::Exec { request },
                tracking: OutputStreamTracking::Execution {
                    terminal: terminal_sender.clone(),
                },
                reply,
                chunk_sender: sender,
                rest_cancel_sender: None,
            })
        })
        .await
    {
        Ok(Ok(id)) => id,
        Ok(Err(error)) => return router_error_response(error),
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: format!("Execution admission failed: {error:?}"),
                }),
            )
                .into_response();
        }
    };
    let guard = OutputCancelGuard::new(state.router_ref.clone(), agent_id, id);
    drop(terminal_sender);
    Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("X-Redoor-Execution-Id", id.to_string())
        .body(execution_body(receiver, terminal_receiver, guard))
        .unwrap()
}

/// Drains already accepted payload before fallback completion so timeouts cannot erase trailing output.
fn execution_body(
    mut receiver: tokio::sync::mpsc::Receiver<redoor::streaming::StreamChunk>,
    mut terminal_receiver: tokio::sync::watch::Receiver<Option<redoor::exec_protocol::ExecEvent>>,
    mut guard: OutputCancelGuard,
) -> Body {
    let stream = async_stream::stream! {
        let mut terminal_open = true;
        loop {
            let chunk = tokio::select! {
                biased;
                chunk = receiver.recv() => Ok(chunk),
                result = terminal_receiver.changed(), if terminal_open => Err(result.is_ok()),
            };
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(false) => { terminal_open = false; continue; }
                Err(true) => {
                    let event = terminal_receiver.borrow_and_update().clone();
                    let Some(event) = event else { break; };
                    // Only agent terminal acknowledgements can describe process termination.
                    guard.disarm();
                    let mut data = serde_json::to_vec(&event).unwrap();
                    data.push(b'\n');
                    yield Ok(bytes::Bytes::from(data));
                    break;
                }
            };
            let Some(chunk) = chunk else {
                // Accepted cancellation drops the payload sink to release backpressure,
                // but termination is still pending on the independent acknowledgement lane.
                if terminal_open && terminal_receiver.borrow().is_none() {
                    let _ = terminal_receiver.changed().await;
                }
                let event = terminal_receiver.borrow_and_update().clone();
                if let Some(event) = event {
                    guard.disarm();
                    let mut data = serde_json::to_vec(&event).unwrap();
                    data.push(b'\n');
                    yield Ok(bytes::Bytes::from(data));
                } else {
                    yield Err(std::io::Error::other("Execution stream ended before completion"));
                }
                break;
            };
            if chunk.is_error {
                yield Err(std::io::Error::other(String::from_utf8_lossy(&chunk.data).to_string()));
                break;
            }
            if chunk.is_last { guard.disarm(); }
            yield Ok(bytes::Bytes::from(chunk.data));
            if chunk.is_last { break; }
        }
    };
    Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor::{
        actors::router::spawn_router,
        exec_protocol::ExecEvent,
        streaming::{StreamChunk, StreamPayloadKind},
        types::ChunkIndex,
    };

    /// A slow HTTP consumer can have buffered output when the independent fallback arrives.
    #[tokio::test]
    async fn fallback_drains_buffered_output_before_single_terminal_event() {
        let (sink, receiver) = tokio::sync::mpsc::channel(1);
        let output = ExecEvent::Stdout {
            data: b"trailing output".to_vec(),
        };
        let mut data = serde_json::to_vec(&output).unwrap();
        data.push(b'\n');
        sink.send(StreamChunk {
            request_id: RequestId::new(1),
            chunk_index: ChunkIndex::new(0),
            is_last: false,
            is_error: false,
            payload_kind: StreamPayloadKind::RawFile,
            data,
        })
        .await
        .unwrap();
        let (terminal, terminal_receiver) = tokio::sync::watch::channel(None);
        terminal.send_replace(Some(ExecEvent::TimedOut));
        drop(sink);
        let (router, task) = spawn_router(
            redoor::terminal_registry::TerminalRegistry::new(),
            redoor::log_registry::LogRegistry::new(),
        );
        let guard = OutputCancelGuard::new(router, AgentId::from("test"), RequestId::new(1));
        let bytes = axum::body::to_bytes(execution_body(receiver, terminal_receiver, guard), 4096)
            .await
            .unwrap();
        let events: Vec<ExecEvent> = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        // Independent completion must not skip accepted stdout or emit a duplicate terminal record.
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], ExecEvent::Stdout { data } if data == b"trailing output"));
        assert!(matches!(&events[1], ExecEvent::TimedOut));
        task.abort();
    }
}
