//! Dedicated non-PTY execution endpoint reuses stream routing and drop-triggered cancellation.

use super::{raw::DownloadCancelGuard, responses::router_error_response, state::ServerState};
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors::router::{ExecuteStreamRequest, RouterMsg},
    commands::{Command, ErrorResponse},
    exec_protocol::{ExecEvent, ExecRequest},
    types::AgentId,
};

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
    let (cancel_sender, mut cancel_receiver) = tokio::sync::watch::channel(false);
    let id = match state
        .router_ref
        .request(30_000, |reply| {
            RouterMsg::ExecuteStreamCommandRest(ExecuteStreamRequest {
                agent_id: agent_id.clone(),
                command: Command::Exec { request },
                path: "remote exec".into(),
                total_bytes: 0,
                full_size: None,
                resume_offset: None,
                reply,
                chunk_sender: sender,
                rest_cancel_sender: Some(cancel_sender.clone()),
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
    let mut guard = DownloadCancelGuard::new(state.router_ref.clone(), agent_id, id);
    let stream = async_stream::stream! {
        // Keep normal router completion from looking like watch-channel cancellation before the last chunk is read.
        let _cancel_keepalive = cancel_sender;
        loop {
            let chunk = tokio::select! {
                chunk = receiver.recv() => Ok(chunk),
                _ = cancel_receiver.changed() => Err(()),
            };
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(()) => {
                    // Explicit API cancellation has a typed terminal result, unlike an unexplained disconnect.
                    let mut data = serde_json::to_vec(&ExecEvent::Canceled).unwrap();
                    data.push(b'\n');
                    yield Ok(bytes::Bytes::from(data));
                    break;
                }
            };
            let Some(chunk) = chunk else {
                yield Err(std::io::Error::other("Execution stream ended before completion"));
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
