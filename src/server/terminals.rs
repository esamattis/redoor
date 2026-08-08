use super::{
    agent_helpers::require_absolute_path, state::ServerState, websocket_security::is_same_origin,
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
use redoor::{
    actors::router::{OpenTerminalRequest, RouterMsg},
    terminal_protocol::{
        TerminalAgentHandshake, TerminalClientMessage, TerminalId, TerminalServerMessage,
        TerminalSize,
    },
    terminal_registry::TerminalRegistry,
    types::AgentId,
};
use serde::Deserialize;
use std::time::Duration;
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_TERMINAL_MESSAGE_SIZE: usize = 1024 * 1024;
const TERMINAL_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const ROUTER_REQUEST_TIMEOUT_MS: u64 = 5_000;
const MAX_PRE_READY_FRAMES: usize = 32;
const MAX_PRE_READY_BYTES: usize = 64 * 1024;

/// Carries the paired socket and bounded browser input received during agent startup.
struct PairedTerminal {
    agent: WebSocket,
    buffered_browser_frames: Vec<WsMessage>,
}

/// Parses initial terminal dimensions before the browser upgrade is accepted.
#[derive(Deserialize)]
pub(crate) struct TerminalQuery {
    rows: u16,
    cols: u16,
    cwd: String,
}

/// Upgrades a same-origin browser request and starts one ephemeral rendezvous.
pub(crate) async fn browser_terminal_websocket_handler(
    Path(agent): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
    websocket: WebSocketUpgrade,
) -> Response {
    let cwd = match require_absolute_path(query.cwd) {
        Ok(cwd) => cwd,
        Err(response) => return response,
    };
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
    websocket
        .max_message_size(MAX_TERMINAL_MESSAGE_SIZE)
        .max_frame_size(MAX_TERMINAL_MESSAGE_SIZE)
        .on_upgrade(move |socket| run_browser_setup(socket, AgentId::from(agent), size, cwd, state))
        .into_response()
}

/// Upgrades the agent data-plane endpoint before validating its first frame.
pub(crate) async fn agent_terminal_websocket_handler(
    Path(terminal_id): Path<String>,
    AxumState(state): AxumState<ServerState>,
    websocket: WebSocketUpgrade,
) -> Response {
    let terminal_id = match Uuid::parse_str(&terminal_id) {
        Ok(id) => TerminalId(id),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    websocket
        .max_message_size(MAX_TERMINAL_MESSAGE_SIZE)
        .max_frame_size(MAX_TERMINAL_MESSAGE_SIZE)
        .on_upgrade(move |socket| {
            authenticate_agent_socket(socket, terminal_id, state.terminal_registry)
        })
        .into_response()
}

/// Registers setup before notifying the authoritative agent control socket.
async fn run_browser_setup(
    mut browser: WebSocket,
    agent_id: AgentId,
    size: TerminalSize,
    cwd: String,
    state: ServerState,
) {
    let terminal_id = TerminalId::new();
    let token = Uuid::new_v4().to_string();
    let (agent_sender, agent_receiver) = oneshot::channel();
    if state
        .terminal_registry
        .register_pending(
            terminal_id.clone(),
            agent_id.clone(),
            token.clone(),
            agent_sender,
        )
        .is_err()
    {
        send_terminal_error(&mut browser, "Too many terminal connections are pending").await;
        return;
    }

    let request_result = state
        .router_ref
        .request(ROUTER_REQUEST_TIMEOUT_MS, |reply| {
            RouterMsg::OpenTerminal(OpenTerminalRequest {
                agent_id: agent_id.clone(),
                terminal_id: terminal_id.clone(),
                token,
                size,
                cwd,
                reply,
            })
        })
        .await;
    if !matches!(request_result, Ok(Ok(()))) {
        state.terminal_registry.remove_pending(&terminal_id);
        send_terminal_error(&mut browser, "Agent is not connected").await;
        return;
    }

    let paired = wait_for_agent(&mut browser, agent_receiver).await;
    state.terminal_registry.remove_pending(&terminal_id);
    match paired {
        Some(paired) => relay_terminal(browser, paired.agent, paired.buffered_browser_frames).await,
        None => {
            send_terminal_error(
                &mut browser,
                "Agent did not establish the terminal connection",
            )
            .await
        }
    }
}

/// Waits for pairing while also detecting a browser that leaves during setup.
async fn wait_for_agent(
    browser: &mut WebSocket,
    mut agent_receiver: oneshot::Receiver<WebSocket>,
) -> Option<PairedTerminal> {
    let setup_timeout = tokio::time::sleep(TERMINAL_SETUP_TIMEOUT);
    tokio::pin!(setup_timeout);
    let mut buffered_browser_frames = Vec::new();
    let mut buffered_bytes = 0;
    loop {
        tokio::select! {
            result = &mut agent_receiver => {
                return result.ok().map(|agent| PairedTerminal {
                    agent,
                    buffered_browser_frames,
                });
            }
            _ = &mut setup_timeout => return None,
            frame = browser.recv() => {
                if !handle_browser_setup_frame(
                    browser,
                    frame,
                    &mut buffered_browser_frames,
                    &mut buffered_bytes,
                ).await {
                    return None;
                }
            }
        }
    }
}

/// Preserves bounded early input, responds to keepalives, and detects browser departure.
async fn handle_browser_setup_frame(
    browser: &mut WebSocket,
    frame: Option<Result<WsMessage, axum::Error>>,
    buffered_frames: &mut Vec<WsMessage>,
    buffered_bytes: &mut usize,
) -> bool {
    match frame {
        Some(Ok(WsMessage::Binary(bytes))) => {
            if buffered_frames.len() >= MAX_PRE_READY_FRAMES
                || bytes.len() > MAX_PRE_READY_BYTES.saturating_sub(*buffered_bytes)
            {
                return false;
            }
            *buffered_bytes += bytes.len();
            buffered_frames.push(WsMessage::Binary(bytes));
            true
        }
        Some(Ok(WsMessage::Text(text))) => {
            if buffered_frames.len() >= MAX_PRE_READY_FRAMES
                || text.len() > MAX_PRE_READY_BYTES.saturating_sub(*buffered_bytes)
            {
                return false;
            }
            *buffered_bytes += text.len();
            buffered_frames.push(WsMessage::Text(text));
            true
        }
        Some(Ok(WsMessage::Ping(bytes))) => browser.send(WsMessage::Pong(bytes)).await.is_ok(),
        Some(Ok(WsMessage::Pong(_))) => true,
        Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => false,
    }
}

/// Authenticates exactly one initial text frame and consumes its pending entry.
async fn authenticate_agent_socket(
    mut socket: WebSocket,
    terminal_id: TerminalId,
    registry: TerminalRegistry,
) {
    let frame = tokio::time::timeout(TERMINAL_HANDSHAKE_TIMEOUT, socket.recv()).await;
    let token = match frame {
        Ok(Some(Ok(WsMessage::Text(text)))) => {
            match serde_json::from_str::<TerminalAgentHandshake>(&text) {
                Ok(TerminalAgentHandshake::Authenticate { token }) => token,
                Err(_) => return,
            }
        }
        _ => return,
    };
    let _ = registry.attach_agent(&terminal_id, &token, socket);
}

/// Sends a typed setup error without exposing tokens or terminal contents.
async fn send_terminal_error(socket: &mut WebSocket, message: &str) {
    let notification = TerminalServerMessage::Error {
        message: message.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&notification) {
        let _ = socket.send(WsMessage::Text(json.into())).await;
    }
    let _ = socket.close().await;
}

/// Runs independent directions so one blocked sink cannot hide opposite-side closure.
async fn relay_terminal(
    browser: WebSocket,
    agent: WebSocket,
    buffered_browser_frames: Vec<WsMessage>,
) {
    let (browser_sink, browser_stream) = browser.split();
    let (agent_sink, agent_stream) = agent.split();
    tokio::select! {
        _ = forward_browser_to_agent(browser_stream, agent_sink, buffered_browser_frames) => {}
        _ = forward_agent_to_browser(agent_stream, browser_sink) => {}
    }
}

/// Validates browser controls while forwarding binary terminal input unchanged.
async fn forward_browser_to_agent(
    mut browser: SplitStream<WebSocket>,
    mut agent: SplitSink<WebSocket, WsMessage>,
    buffered_frames: Vec<WsMessage>,
) -> Result<(), ()> {
    for frame in buffered_frames {
        if !forward_browser_frame(frame, &mut agent).await? {
            return Ok(());
        }
    }
    while let Some(frame) = browser.next().await {
        if !forward_browser_frame(frame.map_err(|_| ())?, &mut agent).await? {
            return Ok(());
        }
    }
    Ok(())
}

/// Validates and forwards one browser frame regardless of whether it arrived before pairing.
async fn forward_browser_frame(
    frame: WsMessage,
    agent: &mut SplitSink<WebSocket, WsMessage>,
) -> Result<bool, ()> {
    match frame {
        WsMessage::Binary(bytes) => agent
            .send(WsMessage::Binary(bytes))
            .await
            .map(|()| true)
            .map_err(|_| ()),
        WsMessage::Text(text) => {
            let message = serde_json::from_str::<TerminalClientMessage>(&text).map_err(|_| ())?;
            let TerminalClientMessage::Resize { size } = message;
            size.validate().map_err(|_| ())?;
            agent
                .send(WsMessage::Text(text))
                .await
                .map(|()| true)
                .map_err(|_| ())
        }
        WsMessage::Ping(bytes) => agent
            .send(WsMessage::Ping(bytes))
            .await
            .map(|()| true)
            .map_err(|_| ()),
        WsMessage::Pong(bytes) => agent
            .send(WsMessage::Pong(bytes))
            .await
            .map(|()| true)
            .map_err(|_| ()),
        WsMessage::Close(frame) => {
            let _ = agent.send(WsMessage::Close(frame)).await;
            Ok(false)
        }
    }
}

/// Validates agent lifecycle controls while forwarding PTY bytes unchanged.
async fn forward_agent_to_browser(
    mut agent: SplitStream<WebSocket>,
    mut browser: SplitSink<WebSocket, WsMessage>,
) -> Result<(), ()> {
    while let Some(frame) = agent.next().await {
        match frame.map_err(|_| ())? {
            WsMessage::Binary(bytes) => browser
                .send(WsMessage::Binary(bytes))
                .await
                .map_err(|_| ())?,
            WsMessage::Text(text) => {
                serde_json::from_str::<TerminalServerMessage>(&text).map_err(|_| ())?;
                browser.send(WsMessage::Text(text)).await.map_err(|_| ())?;
            }
            WsMessage::Ping(bytes) => browser.send(WsMessage::Ping(bytes)).await.map_err(|_| ())?,
            WsMessage::Pong(bytes) => browser.send(WsMessage::Pong(bytes)).await.map_err(|_| ())?,
            WsMessage::Close(frame) => {
                let _ = browser.send(WsMessage::Close(frame)).await;
                return Ok(());
            }
        }
    }
    Ok(())
}
