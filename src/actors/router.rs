use crate::actors::session::SessionMsg;
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use ractor::{Actor, ActorProcessingErr, ActorRef};
use serde_json::Value;
use std::collections::HashMap;

pub struct RouterActor;

#[derive(Clone)]
pub struct RouterState {
    agents: HashMap<String, AgentInfo>,
    web_clients: Vec<ActorRef<SessionMsg>>,
    pending_responses: HashMap<String, ActorRef<SessionMsg>>,
}

#[derive(Clone, Debug)]
pub struct AgentInfo {
    pub agent_name: String,
    pub socket_id: String,
    pub session_ref: ActorRef<SessionMsg>,
}

#[derive(Clone)]
pub enum RouterMsg {
    RegisterAgent {
        agent_id: String,
        agent_name: String,
        socket_id: String,
        session_ref: ActorRef<SessionMsg>,
    },
    UnregisterAgent {
        agent_id: String,
    },
    RegisterWebClient {
        session_ref: ActorRef<SessionMsg>,
    },
    UnregisterWebClient {
        session_ref: ActorRef<SessionMsg>,
    },
    RouteCommand {
        agent_id: String,
        command: String,
        args: Vec<String>,
    },
    RouteResponse {
        agent_id: String,
        result: Value,
    },
}

impl Actor for RouterActor {
    type Msg = RouterMsg;
    type State = RouterState;
    type Arguments = ();

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        _args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        log!(Level::Info, "RouterActor started");
        Ok(RouterState {
            agents: HashMap::new(),
            web_clients: Vec::new(),
            pending_responses: HashMap::new(),
        })
    }

    async fn handle(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            RouterMsg::RegisterAgent {
                agent_id,
                agent_name,
                socket_id,
                session_ref,
            } => {
                log!(
                    Level::Info,
                    "Agent registered: agent_id={}, agent_name={}, socket_id={}",
                    agent_id,
                    agent_name,
                    socket_id
                );
                state.agents.insert(
                    agent_id.clone(),
                    AgentInfo {
                        agent_name,
                        socket_id,
                        session_ref,
                    },
                );
                broadcast_agent_list(state);
            }
            RouterMsg::UnregisterAgent { agent_id } => {
                log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
                state.agents.remove(&agent_id);
                broadcast_agent_list(state);
            }
            RouterMsg::RegisterWebClient { session_ref } => {
                log!(
                    Level::Info,
                    "Web client registered: session_id={}",
                    session_ref.get_id()
                );
                state.web_clients.push(session_ref);
                broadcast_agent_list(state);
            }
            RouterMsg::UnregisterWebClient { session_ref } => {
                log!(
                    Level::Info,
                    "Web client unregistered: session_id={}",
                    session_ref.get_id()
                );
                state
                    .web_clients
                    .retain(|client| client.get_id() != session_ref.get_id());
            }
            RouterMsg::RouteCommand {
                agent_id,
                command,
                args,
            } => {
                log!(
                    Level::Info,
                    "Routing command: agent_id={}, command={}, args={:?}",
                    agent_id,
                    command,
                    args
                );
                if let Some(agent_info) = state.agents.get(&agent_id) {
                    state.pending_responses.insert(
                        agent_id.clone(),
                        state.web_clients.first().cloned().unwrap(),
                    );
                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            command,
                            args,
                        },
                    ));
                }
            }
            RouterMsg::RouteResponse { agent_id, result } => {
                if let Some(web_client_ref) = state.pending_responses.remove(&agent_id) {
                    log!(
                        Level::Info,
                        "Routing response: agent_id={}, result={}, web_client_id={}",
                        agent_id,
                        result,
                        web_client_ref.get_id()
                    );
                    let _ = web_client_ref.cast(SessionMsg::OutgoingMessage(
                        Message::CommandResponse { agent_id, result },
                    ));
                } else {
                    log!(
                        Level::Warning,
                        "No pending response found for agent_id={}",
                        agent_id
                    );
                }
            }
        }
        Ok(())
    }
}

fn broadcast_agent_list(state: &RouterState) {
    let agents: HashMap<String, String> = state
        .agents
        .iter()
        .map(|(id, info)| (id.clone(), info.agent_name.clone()))
        .collect();

    for web_client in &state.web_clients {
        let _ = web_client.cast(SessionMsg::OutgoingMessage(Message::AgentList {
            agents: agents.clone(),
        }));
    }
}
