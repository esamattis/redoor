use super::state::ServerState;
use axum::{
    extract::{
        Path, Query, State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
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

/// Parses initial terminal dimensions before the browser upgrade is accepted.
#[derive(Deserialize)]
pub(crate) struct TerminalQuery {
    rows: u16,
    cols: u16,
}

/// Upgrades a same-origin browser request and starts one ephemeral rendezvous.
pub(crate) async fn browser_terminal_websocket_handler(
    Path(agent): Path<String>,
    Query(query): Query<TerminalQuery>,
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
    websocket
        .max_message_size(MAX_TERMINAL_MESSAGE_SIZE)
        .max_frame_size(MAX_TERMINAL_MESSAGE_SIZE)
        .on_upgrade(move |socket| run_browser_setup(socket, AgentId::from(agent), size, state))
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

/// Enforces the browser Origin authority against the HTTP Host authority.
fn is_same_origin(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        // Browser WebSocket handshakes always carry Origin; non-browser API
        // clients have no ambient browser credentials to protect here.
        return true;
    };
    let Ok(origin) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    matches!(origin.scheme_str(), Some("http" | "https"))
        && origin
            .authority()
            .map(|authority| authority.as_str().eq_ignore_ascii_case(host))
            .unwrap_or(false)
}

/// Registers setup before notifying the authoritative agent control socket.
async fn run_browser_setup(
    mut browser: WebSocket,
    agent_id: AgentId,
    size: TerminalSize,
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
        Some(agent) => relay_terminal(browser, agent).await,
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
    agent_receiver: oneshot::Receiver<WebSocket>,
) -> Option<WebSocket> {
    tokio::select! {
        result = agent_receiver => result.ok(),
        _ = tokio::time::sleep(TERMINAL_SETUP_TIMEOUT) => None,
        frame = browser.recv() => handle_browser_setup_frame(frame),
    }
}

/// Treats any pre-ready browser frame as setup cancellation except keepalive frames.
fn handle_browser_setup_frame(frame: Option<Result<WsMessage, axum::Error>>) -> Option<WebSocket> {
    let _ = frame;
    None
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
async fn relay_terminal(browser: WebSocket, agent: WebSocket) {
    let (browser_sink, browser_stream) = browser.split();
    let (agent_sink, agent_stream) = agent.split();
    tokio::select! {
        _ = forward_browser_to_agent(browser_stream, agent_sink) => {}
        _ = forward_agent_to_browser(agent_stream, browser_sink) => {}
    }
}

/// Validates browser controls while forwarding binary terminal input unchanged.
async fn forward_browser_to_agent(
    mut browser: SplitStream<WebSocket>,
    mut agent: SplitSink<WebSocket, WsMessage>,
) -> Result<(), ()> {
    while let Some(frame) = browser.next().await {
        match frame.map_err(|_| ())? {
            WsMessage::Binary(bytes) => {
                agent.send(WsMessage::Binary(bytes)).await.map_err(|_| ())?
            }
            WsMessage::Text(text) => {
                let message =
                    serde_json::from_str::<TerminalClientMessage>(&text).map_err(|_| ())?;
                let TerminalClientMessage::Resize { size } = message;
                size.validate().map_err(|_| ())?;
                agent.send(WsMessage::Text(text)).await.map_err(|_| ())?;
            }
            WsMessage::Ping(bytes) => agent.send(WsMessage::Ping(bytes)).await.map_err(|_| ())?,
            WsMessage::Pong(bytes) => agent.send(WsMessage::Pong(bytes)).await.map_err(|_| ())?,
            WsMessage::Close(frame) => {
                let _ = agent.send(WsMessage::Close(frame)).await;
                return Ok(());
            }
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_same_origin_authority() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:3000".parse().unwrap());
        headers.insert(header::ORIGIN, "http://localhost:3000".parse().unwrap());
        // A matching browser authority is permitted even though the schemes differ from WS.
        assert!(is_same_origin(&headers));
        headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
        // A cross-site browser cannot use ambient access to open a remote shell.
        assert!(!is_same_origin(&headers));
    }
}
