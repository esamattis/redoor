use crate::actors::router::RouterMsg;
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef};
use tokio::sync::mpsc;

/// Per-WebSocket-connection actor that bridges the raw WebSocket transport and
/// the actor system. Each connected agent gets its own `SessionActor` instance,
/// spawned in [`handle_websocket`].
///
/// **Inbound**: deserializes WebSocket text/binary frames into typed messages and
/// forwards them to the [`RouterActor`](super::router::RouterActor) (e.g.
/// agent registration, command responses, stream chunks).
///
/// **Outbound**: receives [`SessionMsg::OutgoingMessage`] /
/// [`SessionMsg::OutgoingBinary`] from other actors and pushes them into the
/// WebSocket send channels so they reach the remote agent.
pub struct SessionActor;

/// Internal state held by a [`SessionActor`] for the lifetime of one WebSocket
/// connection.
pub struct SessionState {
    /// Unique identifier for this WebSocket connection.
    pub socket_id: String,
    /// Handle to the singleton [`RouterActor`](super::router::RouterActor) used
    /// to forward inbound messages (registrations, responses, stream chunks).
    pub router_ref: ActorRef<RouterMsg>,
    /// The agent ID assigned after the agent sends an `AgentRegister` message.
    /// `None` until registration completes.
    pub agent_id: Option<String>,
    /// Channel for sending serialized JSON messages back to the agent over the
    /// WebSocket.
    pub outgoing: mpsc::UnboundedSender<Message>,
    /// Channel for sending raw binary frames (e.g. stream chunks) back to the
    /// agent over the WebSocket.
    pub outgoing_binary: mpsc::UnboundedSender<Vec<u8>>,
}

/// Messages that can be sent to a [`SessionActor`].
#[derive(Clone)]
pub enum SessionMsg {
    /// A JSON message received from the remote agent over the WebSocket.
    IncomingMessage(Message),
    /// A JSON message to send to the remote agent (e.g. a command from the REST API).
    OutgoingMessage(Message),
    /// A binary frame received from the remote agent (e.g. a stream chunk).
    IncomingBinary(Vec<u8>),
    /// A binary frame to send to the remote agent.
    OutgoingBinary(Vec<u8>),
}

impl Actor for SessionActor {
    type Msg = SessionMsg;
    type State = SessionState;
    type Arguments = (
        String,
        ActorRef<RouterMsg>,
        mpsc::UnboundedSender<Message>,
        mpsc::UnboundedSender<Vec<u8>>,
    );

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (socket_id, router_ref, outgoing, outgoing_binary) = args;
        log!(Level::Info, "SessionActor started: socket_id={}", socket_id);

        Ok(SessionState {
            socket_id,
            router_ref,
            agent_id: None,
            outgoing,
            outgoing_binary,
        })
    }

    async fn handle(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            SessionMsg::IncomingMessage(msg) => match msg {
                Message::AgentRegister {
                    agent_id,
                    agent_name,
                    os,
                    arch,
                    hostname,
                    username,
                } => {
                    let _ = state.router_ref.cast(RouterMsg::RegisterAgent {
                        agent_id: agent_id.clone(),
                        agent_name,
                        socket_id: state.socket_id.clone(),
                        session_ref: _myself.clone(),
                        os,
                        arch,
                        hostname,
                        username,
                    });
                    state.agent_id = Some(agent_id);
                }
                Message::AgentUnregister { agent_id } => {
                    let _ = state
                        .router_ref
                        .cast(RouterMsg::UnregisterAgent { agent_id });
                }
                Message::CommandResponse {
                    agent_id,
                    request_id,
                    result,
                } => {
                    let _ = state.router_ref.cast(RouterMsg::RouteResponse {
                        agent_id,
                        request_id,
                        result,
                    });
                }
                _ => {}
            },
            SessionMsg::OutgoingMessage(msg) => {
                if let Message::CommandResponse {
                    agent_id,
                    request_id,
                    result,
                } = &msg
                {
                    log!(
                        Level::Info,
                        "Web client received response: session_id={}, agent_id={}, request_id={}, result={:?}",
                        state.socket_id,
                        agent_id,
                        request_id,
                        result
                    );
                }
                let _ = state.outgoing.send(msg);
            }
            SessionMsg::IncomingBinary(bytes) => {
                if let Ok(chunk) = crate::streaming::StreamChunk::from_bytes(&bytes) {
                    let _ =
                        state
                            .router_ref
                            .cast(crate::actors::router::RouterMsg::RouteStreamChunk {
                                agent_id: state.agent_id.clone().unwrap_or_default(),
                                request_id: chunk.request_id,
                                chunk_index: chunk.chunk_index,
                                is_last: chunk.is_last,
                                is_error: chunk.is_error,
                                data: chunk.data,
                            });
                }
            }
            SessionMsg::OutgoingBinary(bytes) => {
                let _ = state.outgoing_binary.send(bytes);
            }
        }
        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        if let Some(agent_id) = &state.agent_id {
            let _ = state.router_ref.cast(RouterMsg::UnregisterAgent {
                agent_id: agent_id.clone(),
            });
        }
        log!(
            Level::Info,
            "SessionActor stopped: socket_id={}",
            state.socket_id
        );
        Ok(())
    }
}

/// Entry point for a new WebSocket connection. Splits the socket into send/receive
/// halves, spawns a [`SessionActor`] to manage the connection, and wires up
/// background tasks that shuttle frames between the WebSocket and the actor.
///
/// When the remote side disconnects, the receive task detects the closed stream
/// and stops the `SessionActor`, which in turn unregisters the agent from the
/// [`RouterActor`](super::router::RouterActor) via its `post_stop` hook.
pub async fn handle_websocket(
    socket: WebSocket,
    socket_id: String,
    router_ref: ActorRef<RouterMsg>,
) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let (tx_binary, mut rx_binary) = mpsc::unbounded_channel::<Vec<u8>>();
    let (tx_out, mut rx_out) = mpsc::unbounded_channel::<WsMessage>();

    let (session_ref, _handle) = SessionActor::spawn(
        None,
        SessionActor,
        (socket_id.clone(), router_ref.clone(), tx, tx_binary),
    )
    .await
    .expect("Failed to spawn SessionActor");

    let session_ref_clone = session_ref.clone();
    let session_ref_stop = session_ref.clone();

    tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                WsMessage::Text(text) => match serde_json::from_str::<Message>(&text) {
                    Ok(message) => {
                        let _ = session_ref_clone.cast(SessionMsg::IncomingMessage(message));
                    }
                    Err(e) => {
                        log!(
                            Level::Error,
                            "Failed to deserialize WebSocket message: {}, raw text: {}",
                            e,
                            text
                        );
                    }
                },
                WsMessage::Binary(bytes) => {
                    let _ = session_ref_clone.cast(SessionMsg::IncomingBinary(bytes.to_vec()));
                }
                _ => {}
            }
        }
        let _ = session_ref_stop.stop(None);
    });

    let tx_out_clone = tx_out.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = tx_out_clone.send(WsMessage::Text(json.into()));
            }
        }
    });

    let tx_out_clone2 = tx_out.clone();
    tokio::spawn(async move {
        while let Some(bytes) = rx_binary.recv().await {
            let _ = tx_out_clone2.send(WsMessage::Binary(bytes.into()));
        }
    });

    tokio::spawn(async move {
        while let Some(msg) = rx_out.recv().await {
            let _ = sender.send(msg).await;
        }
    });
}
