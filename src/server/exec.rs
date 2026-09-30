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
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    let (terminal_sender, mut terminal_receiver) = tokio::sync::watch::channel(None);
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
    let mut guard = OutputCancelGuard::new(state.router_ref.clone(), agent_id, id);
    drop(terminal_sender);
    let stream = async_stream::stream! {
        let mut terminal_open = true;
        loop {
            let chunk = tokio::select! {
                biased;
                result = terminal_receiver.changed(), if terminal_open => Err(result.is_ok()),
                chunk = receiver.recv() => Ok(chunk),
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
    Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("X-Redoor-Execution-Id", id.to_string())
        .body(Body::from_stream(stream))
        .unwrap()
}
