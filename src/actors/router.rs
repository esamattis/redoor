use crate::actors::session::SessionMsg;
use crate::commands::{Command, CommandResult};
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort};
use std::collections::HashMap;

/// Central command router actor (singleton).
///
/// `RouterActor` acts as the hub between the REST API and connected agents.
/// It maintains a registry of all connected agents (each identified by an
/// `AgentInfo` that includes a handle back to the agent's `SessionActor`),
/// and correlates outgoing commands with incoming responses using request IDs.
///
/// When the REST API wants to execute a command on an agent, it sends an
/// `ExecuteCommandRest` message here. The router looks up the target agent's
/// `SessionActor` reference and forwards the command over the WebSocket.
/// When the agent responds, the router matches the response's `request_id`
/// to the waiting REST reply port and completes the round-trip.
pub struct RouterActor;

/// Internal state for the [`RouterActor`].
///
/// Tracks all connected agents and maps in-flight request IDs to their
/// corresponding REST reply ports (for both one-shot and streaming responses).
pub struct RouterState {
    agents: HashMap<String, AgentInfo>,
    rest_pending_responses: HashMap<u64, (RpcReplyPort<CommandResult>, String)>,
    rest_streaming_responses: HashMap<
        u64,
        (
            String,
            tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
        ),
    >,
    next_request_id: u64,
}

/// Metadata about a connected agent, cached at registration time.
///
/// Stored in the router's agent registry and used to route commands to the
/// correct [`SessionActor`] via `session_ref`, as well as to enrich
/// responses with registration-time metadata (e.g. `connected_at`, `agent_name`).
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

/// Messages accepted by the [`RouterActor`].
pub enum RouterMsg {
    /// An agent has connected and identified itself; add it to the registry.
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
    /// An agent has disconnected; remove it from the registry.
    UnregisterAgent { agent_id: String },
    /// An agent sent a command response; match it to the pending REST reply port.
    RouteResponse {
        agent_id: String,
        request_id: u64,
        result: CommandResult,
    },
    /// Request the list of currently connected agents (used by the REST API).
    GetAgentList {
        reply: RpcReplyPort<HashMap<String, String>>,
    },
    /// Execute a one-shot command on an agent, initiated from the REST API.
    ExecuteCommandRest {
        agent_id: String,
        command: Command,
        reply: RpcReplyPort<CommandResult>,
    },
    /// An agent sent a streaming chunk; forward it to the waiting REST stream sender.
    RouteStreamChunk {
        agent_id: String,
        chunk: crate::streaming::StreamChunk,
    },
    /// Execute a streaming command on an agent, initiated from the REST API.
    ExecuteStreamCommandRest {
        agent_id: String,
        command: Command,
        reply: RpcReplyPort<Result<(), String>>,
        chunk_sender: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
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
            }
            RouterMsg::UnregisterAgent { agent_id } => {
                log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
                state.agents.remove(&agent_id);

                // Clean up any in-flight streaming responses for this agent.
                // Dropping the Sender closes the channel, which causes the REST handler's
                // recv() to return None, unblocking it.
                let orphaned_requests: Vec<u64> = state
                    .rest_streaming_responses
                    .iter()
                    .filter(|(_, (aid, _))| aid == &agent_id)
                    .map(|(request_id, _)| *request_id)
                    .collect();

                for request_id in &orphaned_requests {
                    log!(
                        Level::Warning,
                        "Cleaning up orphaned streaming response: request_id={}, agent_id={}",
                        request_id,
                        agent_id
                    );
                    state.rest_streaming_responses.remove(request_id);
                }

                // Also clean up any pending one-shot REST responses for this agent
                let orphaned_oneshot: Vec<u64> = state
                    .rest_pending_responses
                    .iter()
                    .filter(|(_, (_, aid))| aid == &agent_id)
                    .map(|(request_id, _)| *request_id)
                    .collect();

                for request_id in &orphaned_oneshot {
                    if let Some((reply, _)) = state.rest_pending_responses.remove(request_id) {
                        log!(
                            Level::Warning,
                            "Cleaning up orphaned pending response: request_id={}, agent_id={}",
                            request_id,
                            agent_id
                        );
                        let _ = reply.send(CommandResult::Error {
                            message: format!("Agent disconnected: {}", agent_id),
                        });
                    }
                }
            }
            RouterMsg::RouteResponse {
                agent_id,
                request_id,
                result,
            } => {
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
                } else {
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
            RouterMsg::RouteStreamChunk { agent_id, chunk } => {
                let request_id = chunk.request_id;

                if let Some((_, chunk_sender)) = state.rest_streaming_responses.get(&request_id) {
                    if let Err(_e) = chunk_sender.send(chunk.clone()).await {
                        log!(
                            Level::Warning,
                            "Failed to send chunk to REST stream: request_id={}",
                            request_id
                        );
                        state.rest_streaming_responses.remove(&request_id);
                    } else if chunk.is_last || chunk.is_error {
                        state.rest_streaming_responses.remove(&request_id);
                        log!(
                            Level::Info,
                            "Streaming complete: agent_id={}, request_id={}, total_chunks={}, is_error={}",
                            agent_id,
                            request_id,
                            chunk.chunk_index + 1,
                            chunk.is_error
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
                    state
                        .rest_streaming_responses
                        .insert(request_id, (agent_id.clone(), chunk_sender));

                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));
                    let _ = reply.send(Ok(()));
                } else {
                    log!(
                        Level::Warning,
                        "Agent not found for streaming command: agent_id={}",
                        agent_id
                    );
                    let _ = reply.send(Err(format!("Agent not found: {}", agent_id)));
                }
            }
        }
        Ok(())
    }
}
