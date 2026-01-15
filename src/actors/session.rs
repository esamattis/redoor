use crate::actors::router::RouterMsg;
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef};
use tokio::sync::mpsc;

pub struct SessionActor;

pub struct SessionState {
    pub socket_id: String,
    pub router_ref: ActorRef<RouterMsg>,
    pub agent_id: Option<String>,
    pub outgoing: mpsc::UnboundedSender<Message>,
}

#[derive(Clone)]
pub enum SessionMsg {
    IncomingMessage(Message),
    OutgoingMessage(Message),
}

impl Actor for SessionActor {
    type Msg = SessionMsg;
    type State = SessionState;
    type Arguments = (String, ActorRef<RouterMsg>, mpsc::UnboundedSender<Message>);

    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (socket_id, router_ref, outgoing) = args;
        log!(Level::Info, "SessionActor started: socket_id={}", socket_id);

        let myself_clone = myself.clone();
        let _ = router_ref.cast(RouterMsg::RegisterWebClient {
            session_ref: myself_clone,
        });

        Ok(SessionState {
            socket_id,
            router_ref,
            agent_id: None,
            outgoing,
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
                } => {
                    let _ = state.router_ref.cast(RouterMsg::RegisterAgent {
                        agent_id: agent_id.clone(),
                        agent_name,
                        socket_id: state.socket_id.clone(),
                    });
                    state.agent_id = Some(agent_id);
                }
                Message::AgentUnregister { agent_id } => {
                    let _ = state
                        .router_ref
                        .cast(RouterMsg::UnregisterAgent { agent_id });
                }
                Message::Command {
                    agent_id,
                    command,
                    args,
                } => {
                    let _ = state.router_ref.cast(RouterMsg::RouteCommand {
                        agent_id,
                        command,
                        args,
                    });
                }
                _ => {}
            },
            SessionMsg::OutgoingMessage(msg) => {
                let _ = state.outgoing.send(msg);
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

pub async fn handle_websocket(
    socket: WebSocket,
    socket_id: String,
    router_ref: ActorRef<RouterMsg>,
) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let (session_ref, _handle) = SessionActor::spawn(
        None,
        SessionActor,
        (socket_id.clone(), router_ref.clone(), tx),
    )
    .await
    .expect("Failed to spawn SessionActor");

    let session_ref_clone = session_ref.clone();

    tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let WsMessage::Text(text) = msg {
                if let Ok(message) = serde_json::from_str::<Message>(&text) {
                    let _ = session_ref_clone.cast(SessionMsg::IncomingMessage(message));
                }
            }
        }
    });

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = sender.send(WsMessage::Text(json.into())).await;
            }
        }
    });
}
