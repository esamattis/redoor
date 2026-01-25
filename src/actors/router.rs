use crate::actors::session::SessionMsg;
use crate::commands::{Command, CommandResult};
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort};
use std::collections::HashMap;

pub struct RouterActor;

pub struct RouterState {
    agents: HashMap<String, AgentInfo>,
    web_clients: Vec<ActorRef<SessionMsg>>,
    pending_responses: HashMap<String, ActorRef<SessionMsg>>,
    rest_pending_responses: HashMap<u64, (RpcReplyPort<CommandResult>, String)>,
    rest_streaming_responses: HashMap<u64, tokio::sync::mpsc::Sender<Vec<u8>>>,
    next_request_id: u64,
}

#[derive(Clone, Debug)]
pub struct AgentInfo {
    pub agent_name: String,
    pub socket_id: String,
    pub session_ref: ActorRef<SessionMsg>,
    pub connected_at: i64,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub username: String,
}

impl RouterState {
    fn next_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }
}

pub enum RouterMsg {
    RegisterAgent {
        agent_id: String,
        agent_name: String,
        socket_id: String,
        session_ref: ActorRef<SessionMsg>,
        os: String,
        arch: String,
        hostname: String,
        username: String,
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
        command: Command,
        originating_client: ActorRef<SessionMsg>,
    },
    RouteResponse {
        agent_id: String,
        request_id: u64,
        result: CommandResult,
    },
    GetAgentList {
        reply: RpcReplyPort<HashMap<String, String>>,
    },
    ExecuteCommandRest {
        agent_id: String,
        command: Command,
        reply: RpcReplyPort<CommandResult>,
    },
    RouteStreamChunk {
        agent_id: String,
        request_id: u64,
        chunk_index: u64,
        is_last: bool,
        is_error: bool,
        data: Vec<u8>,
    },
    ExecuteStreamCommandRest {
        agent_id: String,
        command: Command,
        reply: RpcReplyPort<()>,
        chunk_sender: tokio::sync::mpsc::Sender<Vec<u8>>,
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
            rest_pending_responses: HashMap::new(),
            rest_streaming_responses: HashMap::new(),
            next_request_id: 1,
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
                os,
                arch,
                hostname,
                username,
            } => {
                let duplicate_name = state
                    .agents
                    .values()
                    .any(|info| info.agent_name == agent_name);

                if duplicate_name {
                    log!(
                        Level::Error,
                        "Agent with name '{}' already registered, rejecting connection",
                        agent_name
                    );
                    let _ = session_ref.cast(SessionMsg::OutgoingMessage(Message::Error {
                        message: format!("Agent with name '{}' already connected", agent_name),
                    }));
                    return Ok(());
                }

                log!(
                    Level::Info,
                    "Agent registered: agent_id={}, agent_name={}, socket_id={}",
                    agent_id,
                    agent_name,
                    socket_id
                );
                let connected_at = chrono::Utc::now().timestamp();
                state.agents.insert(
                    agent_id.clone(),
                    AgentInfo {
                        agent_name,
                        socket_id,
                        session_ref,
                        connected_at,
                        os,
                        arch,
                        hostname,
                        username,
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
                originating_client,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Info,
                    "Routing command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );
                if let Some(agent_info) = state.agents.get(&agent_id) {
                    state
                        .pending_responses
                        .insert(agent_id.clone(), originating_client);
                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));
                }
            }
            RouterMsg::RouteResponse {
                agent_id,
                request_id,
                result,
            } => {
                let mut found = false;

                if let Some((reply, stored_agent_id)) =
                    state.rest_pending_responses.remove(&request_id)
                {
                    log!(
                        Level::Info,
                        "Routing REST response: agent_id={}, request_id={}, result={:?}",
                        agent_id,
                        request_id,
                        result
                    );

                    let result_to_send = match (&result, state.agents.get(&stored_agent_id)) {
                        (CommandResult::GetAgentDetails(details), Some(agent_info)) => {
                            // Agent returns runtime data (pid, cwd, load averages, system uptime, os, arch, hostname, username)
                            // but doesn't have access to registration metadata (id, name, connected_at) stored in router cache
                            // Fill in these fields from cached registration data before returning to REST API caller
                            let mut details = details.clone();
                            details.id = stored_agent_id.clone();
                            details.name = agent_info.agent_name.clone();
                            details.connected_at = agent_info.connected_at;
                            CommandResult::GetAgentDetails(details)
                        }
                        _ => result.clone(),
                    };

                    let _ = reply.send(result_to_send);
                    found = true;
                }

                if let Some(web_client_ref) = state.pending_responses.remove(&agent_id) {
                    log!(
                        Level::Info,
                        "Routing response: agent_id={}, result={:?}, web_client_id={}",
                        agent_id,
                        result,
                        web_client_ref.get_id()
                    );
                    let _ = web_client_ref.cast(SessionMsg::OutgoingMessage(
                        Message::CommandResponse {
                            agent_id: agent_id.clone(),
                            request_id: 0,
                            result: result.clone(),
                        },
                    ));
                    found = true;
                }

                if !found {
                    log!(
                        Level::Warning,
                        "No pending response found for request_id={}",
                        request_id
                    );
                }
            }
            RouterMsg::GetAgentList { reply } => {
                let agents: HashMap<String, String> = state
                    .agents
                    .iter()
                    .map(|(id, info)| (id.clone(), info.agent_name.clone()))
                    .collect();
                let _ = reply.send(agents);
            }
            RouterMsg::ExecuteCommandRest {
                agent_id,
                command,
                reply,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Info,
                    "Routing REST command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );
                if let Some(agent_info) = state.agents.get(&agent_id) {
                    state
                        .rest_pending_responses
                        .insert(request_id, (reply, agent_id.clone()));
                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));
                } else {
                    let _ = reply.send(CommandResult::Error {
                        message: format!("Agent not found: {}", agent_id),
                    });
                }
            }
            RouterMsg::RouteStreamChunk {
                agent_id,
                request_id,
                chunk_index,
                is_last,
                is_error,
                data,
            } => {
                if let Some(chunk_sender) = state.rest_streaming_responses.remove(&request_id) {
                    let chunk = crate::streaming::StreamChunk {
                        request_id,
                        chunk_index,
                        is_last,
                        is_error,
                        data,
                    };

                    if !is_last && !is_error {
                        state.rest_streaming_responses.insert(request_id, chunk_sender.clone());
                    }

                    if let Err(_e) = chunk_sender.send(chunk.to_bytes()).await {
                        log!(
                            Level::Warning,
                            "Failed to send chunk to REST stream (channel closed or full): request_id={}",
                            request_id
                        );
                    }

                    if is_last || is_error {
                        log!(
                            Level::Info,
                            "Streaming complete: agent_id={}, request_id={}, total_chunks={}, is_error={}",
                            agent_id,
                            request_id,
                            chunk_index + 1,
                            is_error
                        );
                    }
                } else {
                    log!(
                        Level::Warning,
                        "No streaming response found for request_id={}",
                        request_id
                    );
                }
            }
            RouterMsg::ExecuteStreamCommandRest {
                agent_id,
                command,
                reply,
                chunk_sender,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Info,
                    "Routing REST streaming command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );

                if let Some(agent_info) = state.agents.get(&agent_id) {
                    state.rest_streaming_responses.insert(request_id, chunk_sender);

                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));

                    let _ = reply.send(());
                } else {
                    let _ = reply.send(());
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
