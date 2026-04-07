use crate::actors::router::{
    RegisterAgentRequest, RouteResponse, RouteStreamChunkRequest, RouterHandle, RouterMsg,
    TransferProgressUpdateRequest,
};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message, SocketId};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};

/// Converts a lane receive result into the next outbound websocket frame while
/// tracking when that lane has closed.
fn take_outbound_message(message: Option<WsMessage>, lane_closed: &mut bool) -> Option<WsMessage> {
    match message {
        Some(message) => Some(message),
        None => {
            *lane_closed = true;
            None
        }
    }
}

/// Runtime state held for one websocket-backed agent session.
struct SessionRuntime {
    /// Identifies the websocket connection so the router can map routed work back
    /// to this specific session.
    socket_id: SocketId,
    /// Provides the actor handle used to register the session and forward control
    /// and streaming messages into the routing layer.
    router_ref: RouterHandle,
    /// Remains absent until the websocket sends `Message::AgentRegister`, because
    /// the socket exists before the remote agent has announced which logical
    /// agent identity it should be associated with.
    agent_id: Option<AgentId>,
    /// Sends control and other small text frames without backpressure so router
    /// notifications stay responsive.
    outgoing_text: mpsc::UnboundedSender<WsMessage>,
    /// Sends binary frames on a bounded lane so large stream transfers apply
    /// backpressure instead of growing memory usage without bound.
    outgoing_binary: mpsc::Sender<WsMessage>,
}

impl SessionRuntime {
    /// Registers the agent with the router once the websocket announces itself.
    fn handle_control_message(&mut self, message: Message) {
        match message {
            Message::AgentRegister {
                agent_id,
                agent_name,
                os,
                arch,
                hostname,
                username,
            } => {
                let _ = self
                    .router_ref
                    .send(RouterMsg::RegisterAgent(RegisterAgentRequest {
                        agent_id: agent_id.clone(),
                        agent_name,
                        socket_id: self.socket_id.clone(),
                        outgoing_text: self.outgoing_text.clone(),
                        outgoing_binary: self.outgoing_binary.clone(),
                        os,
                        arch,
                        hostname,
                        username,
                    }));
                self.agent_id = Some(agent_id);
            }
            Message::AgentUnregister { agent_id } => {
                let _ = self
                    .router_ref
                    .send(RouterMsg::UnregisterAgent { agent_id });
            }
            Message::CommandResponse {
                agent_id,
                request_id,
                result,
            } => {
                let _ = self
                    .router_ref
                    .send(RouterMsg::RouteResponse(RouteResponse {
                        agent_id,
                        request_id,
                        result,
                    }));
            }
            Message::TransferProgressUpdate {
                agent_id,
                request_id,
                transferred_bytes,
                total_bytes,
            } => {
                let _ = self.router_ref.send(RouterMsg::TransferProgressUpdate(
                    TransferProgressUpdateRequest {
                        agent_id,
                        request_id,
                        transferred_bytes,
                        total_bytes,
                    },
                ));
            }
            _ => {}
        }
    }

    /// Forwards one parsed binary stream chunk and waits until the router has finished routing it.
    async fn handle_binary_message(&mut self, bytes: Vec<u8>) -> bool {
        let Ok(chunk) = crate::streaming::StreamChunk::from_bytes(&bytes) else {
            return true;
        };

        let Some(agent_id) = self.agent_id.clone() else {
            return true;
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .router_ref
            .send_async(RouterMsg::RouteStreamChunk(RouteStreamChunkRequest {
                agent_id,
                chunk,
                reply: reply_tx,
            }))
            .await
            .is_err()
        {
            return false;
        }

        reply_rx.await.is_ok()
    }

    /// Unregisters the session's agent after the websocket goes away.
    fn shutdown(self) {
        if let Some(agent_id) = self.agent_id {
            let _ = self
                .router_ref
                .send(RouterMsg::UnregisterAgent { agent_id });
        }

        log!(Level::Info, "Session stopped: socket_id={}", self.socket_id);
    }
}

/// Entry point for a new WebSocket connection. Splits the socket into send/receive
/// halves and wires them to the router using explicit Tokio channels.
pub async fn handle_websocket(socket: WebSocket, socket_id: SocketId, router_ref: RouterHandle) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    let (tx_out_text, mut rx_out_text) = mpsc::unbounded_channel::<WsMessage>();
    let (tx_out_binary, mut rx_out_binary) = mpsc::channel::<WsMessage>(1);

    let mut runtime = SessionRuntime {
        socket_id: socket_id.clone(),
        router_ref,
        agent_id: None,
        outgoing_text: tx_out_text,
        outgoing_binary: tx_out_binary,
    };

    log!(Level::Info, "Session started: socket_id={}", socket_id);

    let writer_task = tokio::spawn(async move {
        let mut text_closed = false;
        let mut binary_closed = false;

        loop {
            // `biased` keeps control-plane text messages responsive while binary streaming is active.
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

    while let Some(Ok(message)) = receiver.next().await {
        match message {
            WsMessage::Text(text) => match serde_json::from_str::<Message>(&text) {
                Ok(message) => runtime.handle_control_message(message),
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
                if !runtime.handle_binary_message(bytes.to_vec()).await {
                    break;
                }
            }
            _ => {}
        }
    }

    runtime.shutdown();
    writer_task.abort();
}
