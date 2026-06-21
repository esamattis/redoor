use super::cleanup;
use super::messages::{ExecuteCommandRequest, RegisterAgentRequest};
use super::state::{AgentConnection, RouterState};
use super::ui;
use crate::commands::CommandResult;
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};
use axum::extract::ws::Message as WsMessage;
use std::collections::HashMap;

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
        }
    }

    /// Serializes and queues one control-plane message onto this agent's text lane.
    pub(crate) fn send_message(&self, message: Message) {
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
                }
            }
            Err(error) => {
                log!(
                    Level::Error,
                    "Failed to serialize message for agent: socket_id={}, error={}",
                    self.socket_id,
                    error
                );
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
            // Notify the old session so its agent process exits promptly
            // instead of lingering as a zombie.
            old_connection.send_message(Message::Error {
                message: "Connection replaced by a new agent with the same name".to_string(),
            });
        }

        // Clean up any in-flight transfers or pending REST requests that
        // belonged to the old connection before the new one takes over.
        cleanup::cleanup_agent_requests(state, &old_agent_id).await;
    }

    log!(
        Level::Info,
        "Agent registered: agent_id={}, agent_name={}, socket_id={}",
        request.agent_id,
        request.agent_name,
        request.socket_id
    );
    let agent_id = request.agent_id.clone();
    state
        .agents
        .by_id
        .insert(agent_id, AgentConnection::from_register_request(request));
    ui::notify_refresh(state);
}

/// Builds the agent id to agent name map returned by the REST API.
pub(crate) fn list_agents(state: &RouterState) -> HashMap<AgentId, String> {
    state
        .agents
        .by_id
        .iter()
        .map(|(id, info)| (id.clone(), info.agent_name.clone()))
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
        agent_connection.send_message(Message::Command {
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
