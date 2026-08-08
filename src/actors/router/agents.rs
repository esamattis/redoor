use super::RouterError;
use super::cleanup;
use super::messages::{
    AgentListEntry, ApplyManagedLifecycleRequest, ExecuteCommandRequest, OpenAgentLogStreamRequest,
    OpenTerminalRequest, RegisterAgentRequest, RegisterManagedAgentRequest,
};
use super::state::{AgentConnection, KnownAgent, RouterState};
use super::ui;
use crate::commands::{AgentConnectionStatus, CommandResult};
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use axum::extract::ws::Message as WsMessage;

impl AgentConnection {
    /// Builds one live router connection entry from the agent registration payload.
    pub(crate) fn from_register_request(request: RegisterAgentRequest) -> Self {
        Self {
            agent_name: request.agent_name,
            socket_id: request.socket_id,
            outgoing_text: request.outgoing_text,
            outgoing_binary: request.outgoing_binary,
            connected_at: crate::types::UnixTimestampSeconds::new(chrono::Utc::now().timestamp()),
            os: request.os,
            arch: request.arch,
            hostname: request.hostname,
            username: request.username,
            default_directory: request.default_directory,
        }
    }

    /// Serializes and queues one control-plane message onto this agent's text lane.
    pub(crate) fn send_message(&self, message: Message) -> bool {
        match serde_json::to_string(&message) {
            Ok(json) => {
                if self
                    .outgoing_text
                    .send(WsMessage::Text(json.into()))
                    .is_err()
                {
                    log!(
                        Level::Warning,
                        "Failed to queue text message for agent: socket_id={}",
                        self.socket_id
                    );
                    false
                } else {
                    true
                }
            }
            Err(error) => {
                log!(
                    Level::Error,
                    "Failed to serialize message for agent: socket_id={}, error={}",
                    self.socket_id,
                    error
                );
                false
            }
        }
    }

    /// Queues one binary websocket frame while preserving bounded backpressure.
    pub(crate) async fn send_binary(&self, bytes: Vec<u8>) -> bool {
        if self
            .outgoing_binary
            .send(WsMessage::Binary(bytes.into()))
            .await
            .is_err()
        {
            log!(
                Level::Warning,
                "Failed to queue binary message for agent: socket_id={}",
                self.socket_id
            );
            false
        } else {
            true
        }
    }
}

/// Commits live routing and retained inventory together after lifecycle admission.
fn commit_registration(state: &mut RouterState, request: RegisterAgentRequest) {
    log!(
        Level::Info,
        "Agent registered: agent_id={}, agent_name={}, socket_id={}",
        request.agent_id,
        request.agent_name,
        request.socket_id
    );
    let agent_id = request.agent_id.clone();
    let connection = AgentConnection::from_register_request(request);
    let connected_at = connection.connected_at;
    let socket_id = connection.socket_id.clone();
    let name = connection.agent_name.clone();
    let default_directory = connection.default_directory.clone();
    state.agents.by_id.insert(agent_id.clone(), connection);
    let known = state
        .agents
        .known_by_id
        .entry(agent_id.clone())
        .or_insert_with(|| KnownAgent {
            id: agent_id,
            name: name.clone(),
            default_directory: None,
            managed: false,
            status: AgentConnectionStatus::Disconnected,
            connected_at: None,
            last_seen_at: None,
            connection_issue: None,
            socket_id: None,
        });
    known.name = name;
    known.default_directory = Some(default_directory);
    known.status = AgentConnectionStatus::Connected;
    known.connected_at = Some(connected_at);
    known.connection_issue = None;
    known.socket_id = Some(socket_id);
    ui::notify_refresh(state);
}

/// Registers a connected agent, replacing any existing connection that
/// already owns the same agent name.
///
/// When the SSH tunnel drops without a clean TCP close, the server may not
/// detect the old session's disconnect for a long time. Rejecting the new
/// connection in that window would make the agent permanently unreachable
/// until the TCP timeout fires. Instead, the new connection takes over the
/// name and the old session is cleaned up. The stale session's later
/// `UnregisterAgent` is ignored because its `socket_id` will not match.
pub(crate) async fn register(state: &mut RouterState, request: RegisterAgentRequest) {
    // Token validation happens in the session layer before this message is
    // enqueued, so name takeover here is only reachable with a valid agent_token.
    let existing_agent_id = state
        .agents
        .by_id
        .iter()
        .find(|(_, info)| info.agent_name == request.agent_name)
        .map(|(id, _)| id.clone());

    if let Some(old_agent_id) = existing_agent_id {
        log!(
            Level::Warning,
            "Replacing stale agent connection: agent_name={}, old_agent_id={}, new_agent_id={}",
            request.agent_name,
            old_agent_id,
            request.agent_id
        );

        if let Some(old_connection) = state.agents.by_id.remove(&old_agent_id) {
            if let Some(known) = state.agents.known_by_id.get_mut(&old_agent_id) {
                known.last_seen_at = Some(crate::types::UnixTimestampSeconds::new(
                    chrono::Utc::now().timestamp(),
                ));
                known.connected_at = None;
                known.socket_id = None;
            }
            // Notify the old session so its agent process exits promptly
            // instead of lingering as a zombie.
            let _ = old_connection.send_message(Message::Error {
                message: "Connection replaced by a new agent with the same name".to_string(),
            });
        }

        // Clean up any in-flight transfers or pending REST requests that
        // belonged to the old connection before the new one takes over.
        cleanup::cleanup_agent_requests(state, &old_agent_id).await;
        state.terminal_registry.remove_agent_pending(&old_agent_id);
        state.log_registry.remove_agent(&old_agent_id);
    }

    let agent_id = request.agent_id.clone();
    let rejection_sender = request.outgoing_text.clone();
    let watchdog = request.watchdog.clone();
    let accepted = match watchdog.as_ref() {
        Some(watchdog) => watchdog
            .while_desired_running(|| commit_registration(state, request))
            .is_some(),
        None => {
            commit_registration(state, request);
            true
        }
    };
    if !accepted {
        let rejection = serde_json::to_string(&Message::Error {
            message: "Managed agent is intentionally stopped".to_string(),
        });
        if let Ok(rejection) = rejection {
            let _ = rejection_sender.send(WsMessage::Text(rejection.into()));
        }
        log!(
            Level::Warning,
            "Ignoring managed registration that lost a shutdown race: agent_id={}",
            agent_id
        );
    }
}

/// Adds a configured stopped record before its dormant supervisor can be controlled.
pub(crate) fn register_managed(state: &mut RouterState, request: RegisterManagedAgentRequest) {
    let id = request.agent_id;
    state.agents.known_by_id.insert(
        id.clone(),
        KnownAgent {
            id: id.clone(),
            name: id.to_string(),
            default_directory: request.default_directory,
            managed: true,
            status: AgentConnectionStatus::Stopped,
            connected_at: None,
            last_seen_at: None,
            connection_issue: None,
            socket_id: None,
        },
    );
    let _ = request.reply.send(());
}

/// Projects supervisor changes into retained inventory without touching streaming lanes.
pub(crate) async fn apply_managed_lifecycle(
    state: &mut RouterState,
    request: ApplyManagedLifecycleRequest,
) {
    let ApplyManagedLifecycleRequest {
        agent_id,
        snapshot,
        reply,
    } = request;
    let Some(known) = state.agents.known_by_id.get_mut(&agent_id) else {
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
        return;
    };
    if !known.managed {
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
        return;
    }

    let live_socket = state
        .agents
        .by_id
        .get(&agent_id)
        .map(|connection| connection.socket_id.clone());
    if live_socket.is_some() && snapshot.status != AgentConnectionStatus::Stopped {
        known.status = AgentConnectionStatus::Connected;
        known.connection_issue = snapshot.connection_issue;
    } else {
        known.status = snapshot.status.clone();
        known.connection_issue = snapshot.connection_issue;
        known.socket_id = snapshot.socket_id;
        if known.status != AgentConnectionStatus::Connected {
            known.connected_at = None;
        }
    }

    if known.status == AgentConnectionStatus::Stopped {
        if let Some(connection) = state.agents.by_id.remove(&agent_id) {
            known.last_seen_at = Some(crate::types::UnixTimestampSeconds::new(
                chrono::Utc::now().timestamp(),
            ));
            known.socket_id = None;
            let _ = connection.send_message(crate::types::Message::Error {
                message: "Managed agent was shut down".to_string(),
            });
            cleanup::cleanup_agent_requests(state, &agent_id).await;
            state.terminal_registry.remove_agent_pending(&agent_id);
            state.log_registry.remove_agent(&agent_id);
        }
    }
    ui::notify_refresh(state);
    if let Some(reply) = reply {
        let _ = reply.send(());
    }
}

/// Projects every retained inventory entry for deterministic REST sorting.
pub(crate) fn list_agents(state: &RouterState) -> Vec<AgentListEntry> {
    state
        .agents
        .known_by_id
        .values()
        .map(|info| AgentListEntry {
            id: info.id.clone(),
            name: info.name.clone(),
            default_directory: info.default_directory.clone(),
            managed: info.managed,
            status: info.status.clone(),
            connected_at: info.connected_at,
            last_seen_at: info.last_seen_at,
            connection_issue: info.connection_issue.clone(),
        })
        .collect()
}

/// Allocates an internal request id and routes a one-shot command to an agent.
pub(crate) fn execute_command_rest(state: &mut RouterState, request: ExecuteCommandRequest) {
    let request_id = state.next_id();

    log!(
        Level::Trace,
        "Routing REST command: agent_id={}, request_id={}, command={:?}",
        request.agent_id,
        request_id,
        request.command
    );
    if let Some(agent_connection) = state.agents.by_id.get(&request.agent_id) {
        state
            .pending_rest
            .by_request_id
            .insert(request_id, (request.reply, request.agent_id.clone()));
        let _ = agent_connection.send_message(Message::Command {
            agent_id: request.agent_id,
            request_id,
            command: request.command,
        });
    } else {
        let _ = request.reply.send(CommandResult::error(
            crate::commands::CommandErrorKind::NotFound,
            format!("Agent not found: {}", request.agent_id),
        ));
    }
}

/// Queues only the log bootstrap secret on the existing control connection.
pub(crate) fn open_log_stream(state: &RouterState, request: OpenAgentLogStreamRequest) {
    let result = state
        .agents
        .by_id
        .get(&request.agent_id)
        .filter(|connection| {
            connection.send_message(Message::LogStreamOpen {
                log_stream_id: request.log_stream_id.clone(),
                token: request.token.clone(),
            })
        })
        .map(|_| ())
        .ok_or_else(|| RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        });
    let _ = request.reply.send(result);
}

/// Queues only the terminal bootstrap secret on the existing control connection.
pub(crate) fn open_terminal(state: &RouterState, request: OpenTerminalRequest) {
    let result = state
        .agents
        .by_id
        .get(&request.agent_id)
        .filter(|connection| {
            connection.send_message(Message::TerminalOpen {
                terminal_id: request.terminal_id.clone(),
                token: request.token.clone(),
                size: request.size,
                cwd: request.cwd.clone(),
            })
        })
        .map(|_| ())
        .ok_or_else(|| RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        });
    let _ = request.reply.send(result);
}
