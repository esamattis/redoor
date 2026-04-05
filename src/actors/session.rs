use crate::actors::router::RouterMsg;
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort, rpc::CallResult};
use tokio::sync::mpsc;

/// Per-WebSocket-connection actor that bridges the raw WebSocket transport and
/// the actor system. Each connected agent gets its own `SessionActor` instance,
/// spawned in [`handle_websocket`].
///
/// **Inbound**: deserializes WebSocket text/binary frames into typed messages and
/// forwards them to the [`RouterActor`](super::router::RouterActor) (e.g.
/// agent registration, command responses, stream chunks).
///
/// **Outbound**: owns the prioritized WebSocket send channels used by the
/// router to push control and streaming frames to the remote agent.
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
    /// Channel for sending JSON/control WebSocket frames back to the agent.
    pub outgoing_text: mpsc::UnboundedSender<WsMessage>,
    /// Channel for sending binary streaming frames back to the agent.
    pub outgoing_binary: mpsc::Sender<WsMessage>,
}

/// Messages that can be sent to a [`SessionActor`].
pub enum SessionMsg {
    /// A JSON message received from the remote agent over the WebSocket.
    IncomingMessage(Message),
    /// A binary frame received from the remote agent (e.g. a stream chunk).
    IncomingBinary(Vec<u8>, RpcReplyPort<()>),
}

impl Actor for SessionActor {
    type Msg = SessionMsg;
    type State = SessionState;
    type Arguments = (
        String,
        ActorRef<RouterMsg>,
        mpsc::UnboundedSender<WsMessage>,
        mpsc::Sender<WsMessage>,
    );

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (socket_id, router_ref, outgoing_text, outgoing_binary) = args;
        log!(Level::Info, "SessionActor started: socket_id={}", socket_id);

        Ok(SessionState {
            socket_id,
            router_ref,
            agent_id: None,
            outgoing_text,
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
                    let _ = state.router_ref.cast(RouterMsg::RegisterAgent(
                        crate::actors::router::RegisterAgentRequest {
                            agent_id: agent_id.clone(),
                            agent_name,
                            socket_id: state.socket_id.clone(),
                            outgoing_text: state.outgoing_text.clone(),
                            outgoing_binary: state.outgoing_binary.clone(),
                            os,
                            arch,
                            hostname,
                            username,
                        },
                    ));
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
                    let _ = state.router_ref.cast(RouterMsg::RouteResponse(
                        crate::actors::router::RouteResponse {
                            agent_id,
                            request_id,
                            result,
                        },
                    ));
                }
                Message::TransferProgressUpdate {
                    agent_id,
                    request_id,
                    transferred_bytes,
                    total_bytes,
                } => {
                    let _ = state.router_ref.cast(RouterMsg::TransferProgressUpdate(
                        crate::actors::router::TransferProgressUpdateRequest {
                            agent_id,
                            request_id,
                            transferred_bytes,
                            total_bytes,
                        },
                    ));
                }
                _ => {}
            },
            SessionMsg::IncomingBinary(bytes, reply) => {
                if let Ok(chunk) = crate::streaming::StreamChunk::from_bytes(&bytes) {
                    let _ =
                        state
                            .router_ref
                            .cast(crate::actors::router::RouterMsg::RouteStreamChunk(
                                crate::actors::router::RouteStreamChunkRequest {
                                    agent_id: state.agent_id.clone().unwrap_or_default(),
                                    chunk,
                                    reply,
                                },
                            ));
                } else {
                    let _ = reply.send(());
                }
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
    let (tx_out_text, mut rx_out_text) = mpsc::unbounded_channel::<WsMessage>();
    let (tx_out_binary, mut rx_out_binary) = mpsc::channel::<WsMessage>(1);

    let (session_ref, _handle) = SessionActor::spawn(
        None,
        SessionActor,
        (
            socket_id.clone(),
            router_ref.clone(),
            tx_out_text.clone(),
            tx_out_binary.clone(),
        ),
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
                    match session_ref_clone
                        .call(
                            |reply| SessionMsg::IncomingBinary(bytes.to_vec(), reply),
                            None,
                        )
                        .await
                    {
                        Ok(CallResult::Success(())) => {}
                        Ok(CallResult::Timeout) | Ok(CallResult::SenderError) | Err(_) => break,
                    }
                }
                _ => {}
            }
        }
        let _ = session_ref_stop.stop(None);
    });

    tokio::spawn(async move {
        let mut text_closed = false;
        let mut binary_closed = false;

        loop {
            let next_message = tokio::select! {
                biased;
                message = rx_out_text.recv(), if !text_closed => match message {
                    Some(message) => Some(message),
                    None => {
                        text_closed = true;
                        None
                    }
                },
                message = rx_out_binary.recv(), if !binary_closed => match message {
                    Some(message) => Some(message),
                    None => {
                        binary_closed = true;
                        None
                    }
                },
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
}
