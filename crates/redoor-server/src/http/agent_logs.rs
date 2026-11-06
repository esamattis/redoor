//! Browser endpoint for live agent logs: bridges one browser websocket to one log stream of
//! the agent's connection.

use super::{
    auth::ActiveSession,
    session_watch::{SessionWatch, close_for_ended_session},
    state::ServerState,
    websocket_security::is_same_origin,
};
use crate::actors::router::{
    LogStream, OpenAgentLogStreamRequest, OutputReceiver, RouterError, RouterMsg, StreamCloseGuard,
};
use crate::http::access::ResolvedDevice;
use axum::{
    Extension,
    extract::{
        State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use redoor_core::{log, websocket::WebSocketTimeouts};
use redoor_protocol::{
    ids::AgentId,
    wire::log::{Level, LogEvent, MAX_LOG_EVENT_SIZE},
};

/// Caps websocket frames on log sockets so one oversized event cannot force a large allocation.
const MAX_LOG_MESSAGE_SIZE: usize = 256 * 1024;

/// Upgrades an authenticated same-origin browser into one live agent log stream.
pub(crate) async fn browser_agent_logs_websocket_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
    Extension(session): Extension<ActiveSession>,
    websocket: WebSocketUpgrade,
) -> Response {
    if !is_same_origin(&headers) {
        return (
            StatusCode::FORBIDDEN,
            "agent log websocket origin is not allowed",
        )
            .into_response();
    }
    let watch = SessionWatch::new(state.auth.clone(), &session);
    websocket
        .max_message_size(MAX_LOG_MESSAGE_SIZE)
        .max_frame_size(MAX_LOG_MESSAGE_SIZE)
        .on_upgrade(move |socket| run_log_relay(socket, agent_id, state, watch))
        .into_response()
}

/// Opens the log stream and relays its events until the browser or the agent goes away, or
/// the session that opened the socket ends.
async fn run_log_relay(
    mut browser: WebSocket,
    agent_id: AgentId,
    state: ServerState,
    watch: SessionWatch,
) {
    let opened = state
        .router_ref
        .request(|reply| {
            RouterMsg::OpenAgentLogStream(OpenAgentLogStreamRequest {
                agent_id: agent_id.clone(),
                reply,
            })
        })
        .await;
    let LogStream { stream, output } = match opened {
        Ok(Ok(log_stream)) => log_stream,
        Ok(Err(RouterError::StreamLimitReached { .. })) => {
            send_log_error(&mut browser, "Too many log viewers are open on this agent").await;
            return;
        }
        _ => {
            send_log_error(&mut browser, "Agent is not connected").await;
            return;
        }
    };
    let _close = StreamCloseGuard::new(state.router_ref.clone(), agent_id.clone(), stream);
    log!(
        Level::Info,
        "Agent log relay started: agent_id={}, stream={}",
        agent_id,
        stream
    );
    let (mut browser_sink, browser_stream) = browser.split();
    let session_ended = tokio::select! {
        _ = forward_agent_events(output, &mut browser_sink, state.runtime.ws_timeouts) => false,
        _ = wait_for_browser_disconnect(browser_stream) => false,
        () = watch.ended() => true,
    };
    if session_ended {
        close_for_ended_session(&mut browser_sink).await;
    }
    log!(
        Level::Info,
        "Agent log relay stopped: agent_id={}, stream={}",
        agent_id,
        stream
    );
}

/// Sends a typed safe setup failure and closes so mounted viewers can reconnect cleanly.
async fn send_log_error(socket: &mut WebSocket, message: &str) {
    let event = LogEvent::Error {
        message: message.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = socket.send(WsMessage::Text(json.into())).await;
    }
    let _ = socket.close().await;
}

/// Reassembles newline-delimited log events that may span several stream frames.
///
/// Bounded by the largest event the agent may send, so a malformed stream cannot make the
/// server buffer without limit.
#[derive(Default)]
struct LineAssembler {
    buffer: Vec<u8>,
}

impl LineAssembler {
    /// Appends frame data and returns every complete line, or an error once a line exceeds
    /// the event size bound.
    fn push(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>, ()> {
        let mut lines = Vec::new();
        for byte in data {
            if *byte == b'\n' {
                lines.push(std::mem::take(&mut self.buffer));
            } else if self.buffer.len() >= MAX_LOG_EVENT_SIZE {
                return Err(());
            } else {
                self.buffer.push(*byte);
            }
        }
        Ok(lines)
    }
}

/// One thing the log stream produced for the browser.
enum StreamOutput {
    Data(
        Option<
            Result<
                redoor_protocol::wire::stream::StreamChunk,
                redoor_protocol::wire::request::CommandError,
            >,
        >,
    ),
    Keepalive,
}

/// Validates the agent's events before forwarding them unchanged to the browser.
async fn forward_agent_events(
    mut output: OutputReceiver,
    browser: &mut SplitSink<WebSocket, WsMessage>,
    timeouts: WebSocketTimeouts,
) -> Result<(), ()> {
    let mut keepalive = timeouts.keepalive_interval();
    let mut lines = LineAssembler::default();
    loop {
        let next = tokio::select! {
            chunk = output.recv() => StreamOutput::Data(chunk),
            _ = keepalive.tick() => StreamOutput::Keepalive,
        };
        let chunk = match next {
            StreamOutput::Keepalive => {
                browser
                    .send(WsMessage::Ping(bytes::Bytes::new()))
                    .await
                    .map_err(|_| ())?;
                continue;
            }
            StreamOutput::Data(None | Some(Err(_))) => return close(browser).await,
            StreamOutput::Data(Some(Ok(chunk))) => chunk,
        };
        for line in lines.push(&chunk.data)? {
            forward_line(browser, line).await?;
        }
        if chunk.is_last {
            return close(browser).await;
        }
    }
}

/// Forwards one complete event line after checking it is a bounded `LogEvent`.
async fn forward_line(
    browser: &mut SplitSink<WebSocket, WsMessage>,
    line: Vec<u8>,
) -> Result<(), ()> {
    let event = serde_json::from_slice::<LogEvent>(&line).map_err(|_| ())?;
    if !event.diagnostics_are_bounded() {
        return Err(());
    }
    let text = String::from_utf8(line).map_err(|_| ())?;
    browser
        .send(WsMessage::Text(text.into()))
        .await
        .map_err(|_| ())
}

/// Closes the browser socket so the viewer reconnects with a fresh snapshot.
async fn close(browser: &mut SplitSink<WebSocket, WsMessage>) -> Result<(), ()> {
    let _ = browser.send(WsMessage::Close(None)).await;
    Ok(())
}

/// Returns when the browser leaves; log viewing is server-to-browser only.
async fn wait_for_browser_disconnect(mut browser: SplitStream<WebSocket>) {
    while let Some(Ok(frame)) = browser.next().await {
        if matches!(
            frame,
            WsMessage::Close(_) | WsMessage::Text(_) | WsMessage::Binary(_)
        ) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies events split across frames are reassembled and oversized lines are refused.
    #[test]
    fn line_assembler_joins_frames_and_bounds_lines() {
        let mut lines = LineAssembler::default();
        // A partial line waits for its remainder.
        assert!(lines.push(br#"{"a""#).unwrap().is_empty());
        // The newline completes the line across frames, and a second line in the same frame
        // is returned too.
        assert_eq!(
            lines.push(b":1}\n{}\n").unwrap(),
            vec![br#"{"a":1}"#.to_vec(), b"{}".to_vec()]
        );
        // A line longer than any valid event fails instead of growing the buffer forever.
        assert!(lines.push(&vec![b'x'; MAX_LOG_EVENT_SIZE + 1]).is_err());
    }
}
