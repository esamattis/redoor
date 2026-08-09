use super::{state::ServerState, websocket_security::is_same_origin};
use axum::{
    extract::{
        Path, State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use redoor::{
    Level,
    actors::router::{OpenAgentLogStreamRequest, RouterMsg},
    log,
    log_protocol::{LogAgentHandshake, LogEvent, LogStreamId},
    log_registry::LogRegistry,
    types::AgentId,
};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

const MAX_LOG_MESSAGE_SIZE: usize = 256 * 1024;
const LOG_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const LOG_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const ROUTER_REQUEST_TIMEOUT_MS: u64 = 5_000;

/// Distinguishes a paired socket from setup timeout and browser-owned cancellation.
enum SetupResult {
    Paired(Box<WebSocket>),
    TimedOut,
    BrowserDisconnected,
}

/// Upgrades an authenticated same-origin browser into one ephemeral agent log stream.
pub(crate) async fn browser_agent_logs_websocket_handler(
    Path(agent): Path<String>,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
    websocket: WebSocketUpgrade,
) -> Response {
    if !is_same_origin(&headers) {
        return (
            StatusCode::FORBIDDEN,
            "agent log websocket origin is not allowed",
        )
            .into_response();
    }
    websocket
        .max_message_size(MAX_LOG_MESSAGE_SIZE)
        .max_frame_size(MAX_LOG_MESSAGE_SIZE)
        .on_upgrade(move |socket| run_browser_setup(socket, AgentId::from(agent), state))
        .into_response()
}

/// Upgrades the public data-plane endpoint before validating its one-time first frame.
pub(crate) async fn agent_logs_websocket_handler(
    Path(log_stream_id): Path<String>,
    AxumState(state): AxumState<ServerState>,
    websocket: WebSocketUpgrade,
) -> Response {
    let log_stream_id = match Uuid::parse_str(&log_stream_id) {
        Ok(id) => LogStreamId(id),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    websocket
        .max_message_size(MAX_LOG_MESSAGE_SIZE)
        .max_frame_size(MAX_LOG_MESSAGE_SIZE)
        .on_upgrade(move |socket| {
            authenticate_agent_socket(socket, log_stream_id, state.log_registry)
        })
        .into_response()
}

/// Registers setup before sending one small bootstrap over the authoritative control socket.
async fn run_browser_setup(mut browser: WebSocket, agent_id: AgentId, state: ServerState) {
    let log_stream_id = LogStreamId::new();
    let token = Uuid::new_v4().to_string();
    let (agent_sender, agent_receiver) = oneshot::channel();
    let agent_disconnect = match state.log_registry.register_pending(
        log_stream_id.clone(),
        agent_id.clone(),
        token.clone(),
        agent_sender,
    ) {
        Ok(receiver) => receiver,
        Err(_) => {
            send_log_error(&mut browser, "Too many log connections are pending").await;
            return;
        }
    };

    let request_result = state
        .router_ref
        .request(ROUTER_REQUEST_TIMEOUT_MS, |reply| {
            RouterMsg::OpenAgentLogStream(OpenAgentLogStreamRequest {
                agent_id: agent_id.clone(),
                log_stream_id: log_stream_id.clone(),
                token,
                reply,
            })
        })
        .await;
    if !matches!(request_result, Ok(Ok(()))) {
        state.log_registry.remove(&log_stream_id);
        send_log_error(&mut browser, "Agent is not connected").await;
        return;
    }

    let setup = wait_for_agent(&mut browser, agent_receiver).await;
    match setup {
        SetupResult::Paired(agent) => {
            log!(
                Level::Info,
                "Agent log relay started: agent_id={}, log_stream_id={}",
                agent_id,
                log_stream_id.0
            );
            relay_logs(browser, *agent, agent_disconnect).await;
            state.log_registry.remove(&log_stream_id);
            log!(
                Level::Info,
                "Agent log relay stopped: agent_id={}, log_stream_id={}",
                agent_id,
                log_stream_id.0
            );
        }
        SetupResult::TimedOut => {
            state.log_registry.remove(&log_stream_id);
            send_log_error(&mut browser, "Agent did not establish the log connection").await;
        }
        SetupResult::BrowserDisconnected => {
            state.log_registry.remove(&log_stream_id);
        }
    }
}

/// Waits for pairing while rejecting browser data and detecting route teardown immediately.
async fn wait_for_agent(
    browser: &mut WebSocket,
    mut agent_receiver: oneshot::Receiver<WebSocket>,
) -> SetupResult {
    let setup_timeout = tokio::time::sleep(LOG_SETUP_TIMEOUT);
    tokio::pin!(setup_timeout);
    loop {
        tokio::select! {
            result = &mut agent_receiver => {
                return result
                    .map(|agent| SetupResult::Paired(Box::new(agent)))
                    .unwrap_or(SetupResult::TimedOut);
            }
            _ = &mut setup_timeout => return SetupResult::TimedOut,
            frame = browser.recv() => {
                if !handle_browser_setup_frame(browser, frame).await {
                    return SetupResult::BrowserDisconnected;
                }
            }
        }
    }
}

/// Allows only keepalive frames because agent log viewing is server-to-browser only.
async fn handle_browser_setup_frame(
    browser: &mut WebSocket,
    frame: Option<Result<WsMessage, axum::Error>>,
) -> bool {
    match frame {
        Some(Ok(WsMessage::Ping(bytes))) => browser.send(WsMessage::Pong(bytes)).await.is_ok(),
        Some(Ok(WsMessage::Pong(_))) => true,
        Some(Ok(WsMessage::Text(_) | WsMessage::Binary(_) | WsMessage::Close(_)))
        | Some(Err(_))
        | None => false,
    }
}

/// Authenticates exactly one initial text frame before consuming pending browser ownership.
async fn authenticate_agent_socket(
    mut socket: WebSocket,
    log_stream_id: LogStreamId,
    registry: LogRegistry,
) {
    let frame = tokio::time::timeout(LOG_HANDSHAKE_TIMEOUT, socket.recv()).await;
    let token = match frame {
        Ok(Some(Ok(WsMessage::Text(text)))) => {
            match serde_json::from_str::<LogAgentHandshake>(&text) {
                Ok(LogAgentHandshake::Authenticate { token }) => token,
                Err(_) => return,
            }
        }
        _ => return,
    };
    let _ = registry.attach_agent(&log_stream_id, &token, socket);
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

/// Runs independent directions so browser closure drops the agent socket even during backpressure.
async fn relay_logs(
    browser: WebSocket,
    agent: WebSocket,
    mut agent_disconnect: watch::Receiver<bool>,
) {
    let (browser_sink, browser_stream) = browser.split();
    let (agent_sink, agent_stream) = agent.split();
    tokio::select! {
        _ = forward_agent_events(agent_stream, browser_sink) => {}
        _ = wait_for_browser_disconnect(browser_stream, agent_sink) => {}
        _ = wait_for_authoritative_agent_disconnect(&mut agent_disconnect) => {}
    }
}

/// Ends a paired relay even when the dedicated socket outlives its authoritative control socket.
async fn wait_for_authoritative_agent_disconnect(disconnect: &mut watch::Receiver<bool>) {
    if *disconnect.borrow() {
        return;
    }
    let _ = disconnect.changed().await;
}

/// Validates typed agent events before forwarding them unchanged to the browser.
async fn forward_agent_events(
    mut agent: SplitStream<WebSocket>,
    mut browser: SplitSink<WebSocket, WsMessage>,
) -> Result<(), ()> {
    while let Some(frame) = agent.next().await {
        match frame.map_err(|_| ())? {
            WsMessage::Text(text) => {
                serde_json::from_str::<LogEvent>(&text).map_err(|_| ())?;
                browser.send(WsMessage::Text(text)).await.map_err(|_| ())?;
            }
            WsMessage::Ping(bytes) => browser.send(WsMessage::Ping(bytes)).await.map_err(|_| ())?,
            WsMessage::Pong(bytes) => browser.send(WsMessage::Pong(bytes)).await.map_err(|_| ())?,
            WsMessage::Close(frame) => {
                let _ = browser.send(WsMessage::Close(frame)).await;
                return Ok(());
            }
            WsMessage::Binary(_) => return Err(()),
        }
    }
    Ok(())
}

/// Observes browser departure and owns the opposite sink so cancellation closes the agent socket.
async fn wait_for_browser_disconnect(
    mut browser: SplitStream<WebSocket>,
    mut agent: SplitSink<WebSocket, WsMessage>,
) -> Result<(), ()> {
    while let Some(frame) = browser.next().await {
        match frame.map_err(|_| ())? {
            WsMessage::Ping(bytes) => agent.send(WsMessage::Ping(bytes)).await.map_err(|_| ())?,
            WsMessage::Pong(bytes) => agent.send(WsMessage::Pong(bytes)).await.map_err(|_| ())?,
            WsMessage::Close(frame) => {
                let _ = agent.send(WsMessage::Close(frame)).await;
                return Ok(());
            }
            WsMessage::Text(_) | WsMessage::Binary(_) => return Err(()),
        }
    }
    Ok(())
}
