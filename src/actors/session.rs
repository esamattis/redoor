use crate::actors::router::RouterMsg;
use crate::actors::router::{self, RouterHandle};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};

/// Per-websocket runtime state kept locally inside the connection task rather than in a framework actor.
struct SessionState {
    /// Unique identifier for this websocket connection.
    socket_id: String,
    /// Shared router handle used to forward inbound messages and lifecycle updates.
    router_ref: RouterHandle,
    /// The agent id assigned after registration arrives.
    agent_id: Option<AgentId>,
    /// Channel for sending JSON/control websocket frames back to the agent.
    outgoing_text: mpsc::UnboundedSender<WsMessage>,
    /// Channel for sending binary streaming frames back to the agent.
    outgoing_binary: mpsc::Sender<WsMessage>,
}

/// Converts a lane receive result into the next outbound websocket frame while tracking when that lane has closed.
fn take_outbound_message(message: Option<WsMessage>, lane_closed: &mut bool) -> Option<WsMessage> {
    match message {
        Some(message) => Some(message),
        None => {
            *lane_closed = true;
            None
        }
    }
}

/// Routes one parsed websocket control message into the central router.
async fn handle_incoming_message(state: &mut SessionState, msg: Message) {
    match msg {
        Message::AgentRegister {
            agent_id,
            agent_name,
            os,
            arch,
            hostname,
            username,
        } => {
            let _ = state
                .router_ref
                .send(RouterMsg::RegisterAgent(router::RegisterAgentRequest {
                    agent_id: agent_id.clone(),
                    agent_name,
                    socket_id: state.socket_id.clone(),
                    outgoing_text: state.outgoing_text.clone(),
                    outgoing_binary: state.outgoing_binary.clone(),
                    os,
                    arch,
                    hostname,
                    username,
                }))
                .await;
            state.agent_id = Some(agent_id);
        }
        Message::AgentUnregister { agent_id } => {
            let _ = state
                .router_ref
                .send(RouterMsg::UnregisterAgent { agent_id })
                .await;
        }
        Message::CommandResponse {
            agent_id,
            request_id,
            result,
        } => {
            let _ = state
                .router_ref
                .send(RouterMsg::RouteResponse(router::RouteResponse {
                    agent_id,
                    request_id,
                    result,
                }))
                .await;
        }
        Message::TransferProgressUpdate {
            agent_id,
            request_id,
            transferred_bytes,
            total_bytes,
        } => {
            let _ = state
                .router_ref
                .send(RouterMsg::TransferProgressUpdate(
                    router::TransferProgressUpdateRequest {
                        agent_id,
                        request_id,
                        transferred_bytes,
                        total_bytes,
                    },
                ))
                .await;
        }
        _ => {}
    }
}

/// Routes one binary websocket frame into the router while keeping the acknowledged chunk backpressure path intact.
async fn handle_incoming_binary(state: &SessionState, bytes: Vec<u8>) -> bool {
    let Ok(chunk) = crate::streaming::StreamChunk::from_bytes(&bytes) else {
        return true;
    };

    let Some(agent_id) = state.agent_id.clone() else {
        return true;
    };

    let (reply, wait_for_reply) = oneshot::channel();
    if state
        .router_ref
        .send(crate::actors::router::RouterMsg::RouteStreamChunk(
            crate::actors::router::RouteStreamChunkRequest {
                agent_id,
                chunk,
                reply,
            },
        ))
        .await
        .is_err()
    {
        return false;
    }

    wait_for_reply.await.is_ok()
}

/// Unregisters the last known agent id once the websocket runtime is shutting down.
async fn unregister_session(state: &SessionState) {
    if let Some(agent_id) = &state.agent_id {
        let _ = state
            .router_ref
            .send(RouterMsg::UnregisterAgent {
                agent_id: agent_id.clone(),
            })
            .await;
    }
    log!(
        Level::Info,
        "Session stopped: socket_id={}",
        state.socket_id
    );
}

/// Entry point for a new websocket connection.
///
/// The connection owns local mutable session state, forwards inbound control and
/// binary frames to the router, and relays prioritized outbound text/binary
/// frames back to the websocket sink.
pub async fn handle_websocket(socket: WebSocket, socket_id: String, router_ref: RouterHandle) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    let (tx_out_text, mut rx_out_text) = mpsc::unbounded_channel::<WsMessage>();
    let (tx_out_binary, mut rx_out_binary) = mpsc::channel::<WsMessage>(1);

    log!(Level::Info, "Session started: socket_id={}", socket_id);

    let send_task = tokio::spawn(async move {
        let mut text_closed = false;
        let mut binary_closed = false;

        loop {
            // Drain both outbound lanes onto the single websocket sink while keeping control traffic responsive.
            let next_message = tokio::select! {
                biased;
                message = rx_out_text.recv(), if !text_closed => take_outbound_message(message, &mut text_closed),
                message = rx_out_binary.recv(), if !binary_closed => take_outbound_message(message, &mut binary_closed),
                else => break,
            };

            let Some(message) = next_message else {
                continue;
            };

            if sender.send(message).await.is_err() {
                break;
            }
        }
    });

    let mut state = SessionState {
        socket_id,
        router_ref,
        agent_id: None,
        outgoing_text: tx_out_text,
        outgoing_binary: tx_out_binary,
    };

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            WsMessage::Text(text) => match serde_json::from_str::<Message>(&text) {
                Ok(message) => handle_incoming_message(&mut state, message).await,
                Err(error) => {
                    log!(
                        Level::Error,
                        "Failed to deserialize WebSocket message: {}, raw text: {}",
                        error,
                        text
                    );
                }
            },
            WsMessage::Binary(bytes) => {
                if !handle_incoming_binary(&state, bytes.to_vec()).await {
                    break;
                }
            }
            _ => {}
        }
    }

    unregister_session(&state).await;
    drop(state);
    send_task.abort();
}
