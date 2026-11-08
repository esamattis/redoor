//! Browser terminal endpoint: attaches one browser websocket to one terminal session, through
//! an attach stream to the agent that runs the shell. Closing the socket only detaches; the
//! shell keeps running in the agent.

use super::{
    auth::ActiveSession,
    session_watch::{SessionWatch, close_for_ended_session},
    state::ServerState,
    terminal_sessions::parse_session_id,
    websocket_security::is_same_origin,
};
use crate::actors::lanes::ControlLanes;
use crate::actors::router::{
    AttachTerminalRequest, OutboundStream, OutputReceiver, RouterHandle, RouterMsg,
    StreamCloseGuard, TerminalStream,
};
use crate::terminals::registry::{DetachReason, TerminalRegistry, ViewerTicket};
use axum::{
    Extension,
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
use redoor_protocol::{
    ids::{RequestId, TerminalSessionId},
    wire::{
        ServerToAgent,
        request::CommandError,
        stream::StreamChunk,
        terminal::{TerminalClientMessage, TerminalServerMessage, TerminalSize},
    },
};
use serde::Deserialize;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

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

/// Upgrades a same-origin browser request and attaches it to a listed session.
pub(crate) async fn attach_terminal_websocket_handler(
    Path(id): Path<String>,
    Query(query): Query<AttachQuery>,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
    Extension(session): Extension<ActiveSession>,
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
    let id = match parse_session_id(&id) {
        Ok(id) if state.terminals.contains(id) => id,
        Ok(_) => return super::terminal_sessions::session_not_found().into_response(),
        Err(error) => return error.into_response(),
    };
    let viewer = Viewer {
        registry: state.terminals.clone(),
        router: state.router_ref.clone(),
        id,
        size,
        timeouts: state.runtime.ws_timeouts,
        watch: SessionWatch::new(state.auth.clone(), &session),
    };
    websocket
        .max_message_size(MAX_TERMINAL_MESSAGE_SIZE)
        .max_frame_size(MAX_TERMINAL_MESSAGE_SIZE)
        .on_upgrade(move |socket| viewer.run(socket))
        .into_response()
}

/// Everything one attach needs once the socket is upgraded, gathered so the bridge does not
/// take a long list of loose arguments.
struct Viewer {
    registry: TerminalRegistry,
    router: RouterHandle,
    id: TerminalSessionId,
    size: TerminalSize,
    timeouts: WebSocketTimeouts,
    /// Detaches the viewer once the browser session ends, so a terminal left open in an
    /// idle browser stops showing the shell; the shell itself keeps running.
    watch: SessionWatch,
}

/// Tells the registry the viewer left, however the bridge ends.
struct DetachGuard {
    registry: TerminalRegistry,
    id: TerminalSessionId,
    serial: u64,
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        self.registry.detach(self.id, self.serial);
    }
}

impl Viewer {
    /// Becomes the session's viewer and relays between the browser and an attach stream on
    /// the agent until the browser leaves, the session lets the viewer go, the stream ends
    /// or the browser's sign-in session ends.
    async fn run(self, mut browser: WebSocket) {
        let Self {
            registry,
            router,
            id,
            size,
            timeouts,
            watch: session_watch,
        } = self;
        let Some(ViewerTicket {
            serial,
            agent_id,
            reason,
            ended,
        }) = registry.attach(id)
        else {
            // Closed between the lookup and the attach.
            let _ = send_event(&mut browser, &TerminalServerMessage::Closed).await;
            let _ = browser.close().await;
            return;
        };
        let _detach = DetachGuard {
            registry,
            id,
            serial,
        };
        if let Some(event) = ended {
            let _ = send_event(&mut browser, &event).await;
            let _ = browser.close().await;
            return;
        }
        let attached = router
            .request(|reply| {
                RouterMsg::AttachTerminal(AttachTerminalRequest {
                    agent_id: agent_id.clone(),
                    session: id,
                    size,
                    reply,
                })
            })
            .await;
        let Ok(Ok(terminal)) = attached else {
            // The agent is away, such as while it reconnects after a server restart. Closing
            // without an event makes the browser attach again, which works once it is back.
            let _ = browser.close().await;
            return;
        };
        let _close = StreamCloseGuard::new(router, agent_id, terminal.stream);
        let TerminalStream {
            stream,
            output,
            input,
            events,
        } = terminal;
        let resizes = input.lease().link.lanes().clone();
        let (ready, ready_rx) = watch::channel(false);
        let (mut sink, source) = browser.split();
        let session_ended = tokio::select! {
            () = forward_browser_to_agent(source, &input, &resizes, stream, ready_rx) => None,
            () = forward_agent_to_browser(output, events, reason, &mut sink, timeouts, ready) => None,
            end = session_watch.ended() => Some(end),
        };
        if let Some(end) = session_ended {
            close_for_ended_session(&mut sink, end).await;
        }
    }
}

/// Relays keystrokes and validated resizes until the browser closes.
///
/// Nothing is read before the agent's `ready`, because the agent routes input only once the
/// attachment exists; keystrokes typed meanwhile wait in the socket. Sending waits for
/// credit, which holds the browser back while the shell is slow instead of buffering.
async fn forward_browser_to_agent(
    mut browser: SplitStream<WebSocket>,
    input: &OutboundStream,
    resizes: &ControlLanes,
    stream: RequestId,
    mut ready: watch::Receiver<bool>,
) {
    if ready.wait_for(|ready| *ready).await.is_err() {
        return std::future::pending().await;
    }
    while let Some(Ok(frame)) = browser.next().await {
        match frame {
            WsMessage::Binary(bytes) => {
                if input.send_data(&bytes, false).await.is_err() {
                    // The attachment is gone; its end reaches the browser the other way.
                    return std::future::pending().await;
                }
            }
            WsMessage::Text(text) => {
                let Ok(TerminalClientMessage::Resize { size }) =
                    serde_json::from_str::<TerminalClientMessage>(&text)
                else {
                    return;
                };
                if size.validate().is_err() {
                    return;
                }
                // Resizes go ahead of queued keystrokes, so a paste does not delay them.
                resizes.try_priority_or_command(ServerToAgent::TerminalResize { stream, size });
            }
            WsMessage::Ping(_) | WsMessage::Pong(_) => {}
            WsMessage::Close(_) => return,
        }
    }
}

/// What the agent side produced for the browser.
enum ViewerEvent {
    Released(Result<DetachReason, oneshot::error::RecvError>),
    Event(Option<TerminalServerMessage>),
    Output(Option<Result<StreamChunk, CommandError>>),
    Keepalive,
}

/// Relays the attach stream until it ends or the registry lets this viewer go.
///
/// The release reason is watched next to every send, so a takeover or close interrupts a
/// send stuck on a slow browser, and the browser always learns why it was let go instead of
/// seeing a dropped connection it would answer by attaching again. A stream that ends
/// without a final event (the agent disconnected) closes the socket without one, so the
/// browser does attach again.
async fn forward_agent_to_browser(
    mut output: OutputReceiver,
    events: mpsc::Receiver<TerminalServerMessage>,
    mut reason: oneshot::Receiver<DetachReason>,
    browser: &mut SplitSink<WebSocket, WsMessage>,
    timeouts: WebSocketTimeouts,
    ready: watch::Sender<bool>,
) {
    let mut events = Some(events);
    // The shell's final event; it is sent once the output before it has been relayed.
    let mut ending = None;
    let mut keepalive = timeouts.keepalive_interval();
    loop {
        let next = tokio::select! {
            biased;
            released = &mut reason => ViewerEvent::Released(released),
            event = recv_event(&mut events) => ViewerEvent::Event(event),
            chunk = output.recv() => ViewerEvent::Output(chunk),
            _ = keepalive.tick() => ViewerEvent::Keepalive,
        };
        let message = match next {
            ViewerEvent::Released(released) => {
                let event = released.map_or(TerminalServerMessage::Closed, DetachReason::message);
                return finish(browser, Some(&event)).await;
            }
            ViewerEvent::Event(None) => {
                // A closed channel returns at once on every poll, so the arm turns off.
                events = None;
                continue;
            }
            ViewerEvent::Event(Some(TerminalServerMessage::Ready)) => {
                let _ = ready.send(true);
                event_message(&TerminalServerMessage::Ready)
            }
            ViewerEvent::Event(Some(
                event @ (TerminalServerMessage::Exit { .. } | TerminalServerMessage::Error { .. }),
            )) => {
                ending = Some(event);
                continue;
            }
            // Server-only messages from an agent mean nothing.
            ViewerEvent::Event(Some(_)) => continue,
            ViewerEvent::Output(Some(Ok(chunk))) if chunk.is_last => {
                if !chunk.data.is_empty()
                    && browser
                        .send(WsMessage::Binary(chunk.data.into()))
                        .await
                        .is_err()
                {
                    return;
                }
                // The event travels before FIN, so it has been received by now.
                if ending.is_none()
                    && let Some(events) = &mut events
                {
                    ending = events.try_recv().ok();
                }
                return finish(browser, ending.as_ref()).await;
            }
            ViewerEvent::Output(Some(Ok(chunk))) => WsMessage::Binary(chunk.data.into()),
            ViewerEvent::Output(Some(Err(_)) | None) => {
                return finish(browser, ending.as_ref()).await;
            }
            ViewerEvent::Keepalive => WsMessage::Ping(bytes::Bytes::new()),
        };
        let sent = tokio::select! {
            biased;
            released = &mut reason => {
                let event = released.map_or(TerminalServerMessage::Closed, DetachReason::message);
                return finish(browser, Some(&event)).await;
            }
            sent = browser.send(message) => sent,
        };
        if sent.is_err() {
            return;
        }
    }
}

/// Next lifecycle event; never resolves once the channel is gone.
async fn recv_event(
    events: &mut Option<mpsc::Receiver<TerminalServerMessage>>,
) -> Option<TerminalServerMessage> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
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

/// Sends the last event, if there is one, and closes the socket, bounded so a stalled
/// browser cannot keep the bridge alive.
async fn finish(
    browser: &mut SplitSink<WebSocket, WsMessage>,
    event: Option<&TerminalServerMessage>,
) {
    let _ = tokio::time::timeout(FINAL_SEND_TIMEOUT, async {
        if let Some(event) = event {
            browser.send(event_message(event)).await?;
        }
        browser.send(WsMessage::Close(None)).await
    })
    .await;
}
