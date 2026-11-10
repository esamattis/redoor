//! Dedicated non-PTY execution endpoint reuses stream routing and drop-triggered cancellation.

use super::{error::ApiError, services::output::OutputStream, state::ServerState};
use crate::http::access::ResolvedDevice;
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::Response,
};
use redoor_protocol::{
    api::exec::CancelExecutionResponse,
    ids::RequestId,
    wire::exec::{ExecEvent, ExecRequest},
};

/// Cancels process output through its own resource while file-transfer history stays file-only.
pub(crate) async fn cancel_execution_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path((_, execution_id)): Path<(String, u64)>,
    State(state): State<ServerState>,
) -> Result<(StatusCode, Json<CancelExecutionResponse>), ApiError> {
    let request_id = RequestId::new(execution_id);
    if !state.agents.cancel_execution(agent_id, request_id).await? {
        return Err(ApiError::not_found("Execution not found"));
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(CancelExecutionResponse {
            execution_id: request_id,
        }),
    ))
}

/// Returns NDJSON immediately after admission; dropping the body cancels the owned process.
pub(crate) async fn exec_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
    Json(request): Json<ExecRequest>,
) -> Result<Response, ApiError> {
    request.validate().map_err(ApiError::bad_request)?;
    let (output, terminal) =
        OutputStream::open_execution(&state.router_ref, agent_id, request).await?;
    let id = output.request_id();
    Ok(Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("X-Redoor-Execution-Id", id.to_string())
        .body(execution_body(output, terminal))
        .unwrap())
}

/// Serializes one terminal event as an NDJSON line.
fn ndjson_line(event: &ExecEvent) -> bytes::Bytes {
    let mut data = serde_json::to_vec(event).expect("execution events always serialize");
    data.push(b'\n');
    bytes::Bytes::from(data)
}

/// Streams the output events, then the exit event from the terminal lane.
///
/// The agent sends the exit status as its result after the output, so the body reads the
/// output to its end (`FIN`, or a cancel that stopped it) without losing trailing events and
/// then waits for the status, which arrives independently of how fast the body is read.
fn execution_body(
    mut output: OutputStream,
    mut terminal: tokio::sync::watch::Receiver<Option<ExecEvent>>,
) -> Body {
    let stream = async_stream::stream! {
        while let Some(item) = output.recv().await {
            match item {
                Ok(chunk) => yield Ok(chunk.data),
                Err(error) => {
                    yield Err(std::io::Error::other(error.0.message));
                    return;
                }
            }
        }
        let event = loop {
            let current = terminal.borrow_and_update().clone();
            if current.is_some() {
                break current;
            }
            // A closed lane means the router dropped the execution without a result.
            if terminal.changed().await.is_err() {
                break None;
            }
        };
        match event {
            Some(event) => {
                output.disarm();
                yield Ok(ndjson_line(&event));
            }
            None => yield Err(std::io::Error::other("Execution stream ended before completion")),
        }
    };
    Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::router::{ConnectionStreams, spawn_router};
    use redoor_protocol::wire::{exec::ExecEvent, stream::StreamChunk};

    /// A slow HTTP consumer can have buffered output when the exit status arrives.
    #[tokio::test]
    async fn buffered_output_precedes_single_terminal_event() {
        let streams = ConnectionStreams::new(redoor_core::test_support::test_agent_id("test"));
        let receiver = streams.open_detached(RequestId::new(1));
        let output = ExecEvent::Stdout {
            data: b"trailing output".to_vec(),
        };
        let mut data = serde_json::to_vec(&output).unwrap();
        data.push(b'\n');
        streams.deliver(StreamChunk::data(RequestId::new(1), data, false));
        streams.deliver(StreamChunk::data(RequestId::new(1), Vec::new(), true));
        let (terminal, terminal_receiver) = tokio::sync::watch::channel(None);
        terminal.send_replace(Some(ExecEvent::TimedOut));
        let (router, task) = spawn_router();
        let output = OutputStream::detached(
            router,
            redoor_core::test_support::test_agent_id("test"),
            receiver,
        );
        let bytes = axum::body::to_bytes(execution_body(output, terminal_receiver), 4096)
            .await
            .unwrap();
        let events: Vec<ExecEvent> = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        // The status must not skip accepted stdout or be emitted twice.
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], ExecEvent::Stdout { data } if data == b"trailing output"));
        assert!(matches!(&events[1], ExecEvent::TimedOut));
        task.abort();
    }
}
