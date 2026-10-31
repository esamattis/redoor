//! Browser terminal endpoint: attaches one browser websocket to one server-owned terminal
//! session. Closing the socket only detaches; the shell keeps running in its session.

use super::{
    state::ServerState, terminal_sessions::parse_session_id, websocket_security::is_same_origin,
};
use crate::terminals::session::{
    AttachedViewer, DetachReason, InputChunk, SessionCommand, TerminalSessionHandle, ViewerFrame,
};
use axum::{
    extract::{
        Path, Query, State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use redoor_core::websocket::WebSocketTimeouts;
use redoor_protocol::wire::terminal::{TerminalClientMessage, TerminalServerMessage, TerminalSize};
use serde::Deserialize;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// Caps websocket frames on terminal sockets so one message cannot force a large allocation.
const MAX_TERMINAL_MESSAGE_SIZE: usize = 1024 * 1024;
/// How long the last message to a departing viewer may take. A viewer that is let go is
/// often the one whose socket is stalled, and it must not keep the bridge alive.
const FINAL_SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// The viewer's terminal size, validated before the upgrade is accepted.
#[derive(Deserialize)]
pub(crate) struct AttachQuery {
    rows: u16,
    cols: u16,
}

/// Upgrades a same-origin browser request and attaches it to an existing session.
pub(crate) async fn attach_terminal_websocket_handler(
    Path(id): Path<String>,
    Query(query): Query<AttachQuery>,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
    websocket: WebSocketUpgrade,
) -> Response {
    let size = match TerminalSize::new(query.rows, query.cols) {
        Ok(size) => size,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    if !is_same_origin(&headers) {
        return (
            StatusCode::FORBIDDEN,
            "terminal websocket origin is not allowed",
        )
            .into_response();
    }
    let session = match parse_session_id(&id).map(|id| state.terminals.get(id)) {
        Ok(Some(session)) => session,
        Ok(None) => return super::terminal_sessions::session_not_found().into_response(),
        Err(error) => return error.into_response(),
    };
    let timeouts = state.runtime.ws_timeouts;
    websocket
        .max_message_size(MAX_TERMINAL_MESSAGE_SIZE)
        .max_frame_size(MAX_TERMINAL_MESSAGE_SIZE)
        .on_upgrade(move |socket| run_viewer(socket, session, size, timeouts))
        .into_response()
}

/// Tells the session the viewer left, however the bridge ends.
struct DetachGuard {
    session: TerminalSessionHandle,
    serial: u64,
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        self.session.send_detached(SessionCommand::Detach {
            serial: self.serial,
        });
    }
}

/// Attaches and relays until the browser leaves or the session lets the viewer go.
async fn run_viewer(
    mut browser: WebSocket,
    session: TerminalSessionHandle,
    size: TerminalSize,
    timeouts: WebSocketTimeouts,
) {
    let Ok(AttachedViewer {
        serial,
        frames,
        reason,
        input,
    }) = session.attach(size).await
    else {
        // Closed between the lookup and the attach.
        let _ = send_event(&mut browser, &TerminalServerMessage::Closed).await;
        let _ = browser.close().await;
        return;
    };
    let _detach = DetachGuard {
        session: session.clone(),
        serial,
    };
    let (sink, stream) = browser.split();
    tokio::select! {
        () = forward_browser_to_session(stream, &session, serial, input) => {}
        () = forward_session_to_browser(frames, reason, sink, timeouts) => {}
    }
}

/// Relays keystrokes and validated resizes until the browser closes.
///
/// Keystrokes wait for room in the session's input queue, which holds the browser back while
/// the agent is slow, instead of buffering without bound.
async fn forward_browser_to_session(
    mut browser: SplitStream<WebSocket>,
    session: &TerminalSessionHandle,
    serial: u64,
    mut input: Option<mpsc::Sender<InputChunk>>,
) {
    while let Some(Ok(frame)) = browser.next().await {
        match frame {
            WsMessage::Binary(bytes) => {
                let Some(queue) = &input else { continue };
                if queue.send(InputChunk { serial, bytes }).await.is_err() {
                    // The shell is gone; its exit event follows on the other direction.
                    input = None;
                }
            }
            WsMessage::Text(text) => {
                let Ok(TerminalClientMessage::Resize { size }) =
                    serde_json::from_str::<TerminalClientMessage>(&text)
                else {
                    return;
                };
                if size.validate().is_err()
                    || session
                        .send(SessionCommand::Resize { serial, size })
                        .await
                        .is_err()
                {
                    return;
                }
            }
            WsMessage::Ping(_) | WsMessage::Pong(_) => {}
            WsMessage::Close(_) => return,
        }
    }
}

/// What the session side produced for the browser.
enum ViewerEvent {
    Released(Result<DetachReason, oneshot::error::RecvError>),
    Frame(Option<ViewerFrame>),
    Keepalive,
}

/// Relays the session's frames until the session ends or lets this viewer go.
///
/// The release reason is watched next to every send, so a takeover or close interrupts a
/// send stuck on a slow browser, and the browser always learns why it was let go instead of
/// seeing a dropped connection it would answer by attaching again.
async fn forward_session_to_browser(
    mut frames: mpsc::Receiver<ViewerFrame>,
    mut reason: oneshot::Receiver<DetachReason>,
    mut browser: SplitSink<WebSocket, WsMessage>,
    timeouts: WebSocketTimeouts,
) {
    let mut keepalive = timeouts.keepalive_interval();
    loop {
        let next = tokio::select! {
            biased;
            released = &mut reason => ViewerEvent::Released(released),
            frame = frames.recv() => ViewerEvent::Frame(frame),
            _ = keepalive.tick() => ViewerEvent::Keepalive,
        };
        let message = match next {
            ViewerEvent::Released(Ok(reason)) => {
                return finish(&mut browser, &reason.message()).await;
            }
            // The session ended without a word, which only happens when it is gone.
            ViewerEvent::Released(Err(_)) | ViewerEvent::Frame(None) => {
                return finish(&mut browser, &TerminalServerMessage::Closed).await;
            }
            ViewerEvent::Frame(Some(ViewerFrame::Output(bytes))) => WsMessage::Binary(bytes),
            ViewerEvent::Frame(Some(ViewerFrame::Event(event))) => {
                if matches!(
                    event,
                    TerminalServerMessage::Exit { .. } | TerminalServerMessage::Error { .. }
                ) {
                    // The final event follows the last output; the viewer has seen it all.
                    return finish(&mut browser, &event).await;
                }
                event_message(&event)
            }
            ViewerEvent::Keepalive => WsMessage::Ping(bytes::Bytes::new()),
        };
        let sent = tokio::select! {
            biased;
            released = &mut reason => {
                let event = released.map_or(TerminalServerMessage::Closed, DetachReason::message);
                return finish(&mut browser, &event).await;
            }
            sent = browser.send(message) => sent,
        };
        if sent.is_err() {
            return;
        }
    }
}

/// Encodes one lifecycle event as a text frame.
fn event_message(event: &TerminalServerMessage) -> WsMessage {
    let json = serde_json::to_string(event).unwrap_or_default();
    WsMessage::Text(json.into())
}

/// Sends a lifecycle event before the bridge returns, used before the socket is split.
async fn send_event(socket: &mut WebSocket, event: &TerminalServerMessage) -> bool {
    socket.send(event_message(event)).await.is_ok()
}

/// Sends the last event and closes the socket, bounded so a stalled browser cannot keep the
/// bridge alive.
async fn finish(browser: &mut SplitSink<WebSocket, WsMessage>, event: &TerminalServerMessage) {
    let _ = tokio::time::timeout(FINAL_SEND_TIMEOUT, async {
        browser.send(event_message(event)).await?;
        browser.send(WsMessage::Close(None)).await
    })
    .await;
}
