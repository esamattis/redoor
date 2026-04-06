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

/// Registers a connected agent unless another live agent already owns its name.
pub(crate) fn register(state: &mut RouterState, request: RegisterAgentRequest) {
    let duplicate_name = state
        .agents
        .by_id
        .values()
        .any(|info| info.agent_name == request.agent_name);

    if duplicate_name {
        log!(
            Level::Error,
            "Agent with name '{}' already registered, rejecting connection",
            request.agent_name
        );
        let duplicate_error = Message::Error {
            message: format!("Agent with name '{}' already connected", request.agent_name),
        };
        let duplicate_agent_connection = AgentConnection {
            agent_name: request.agent_name,
            socket_id: request.socket_id,
            outgoing_text: request.outgoing_text,
            outgoing_binary: request.outgoing_binary,
            connected_at: crate::types::UnixTimestampSeconds::new(chrono::Utc::now().timestamp()),
            os: request.os,
            arch: request.arch,
            hostname: request.hostname,
            username: request.username,
        };
        duplicate_agent_connection.send_message(duplicate_error);
        return;
    }

    log!(
        Level::Info,
        "Agent registered: agent_id={}, agent_name={}, socket_id={}",
        request.agent_id,
        request.agent_name,
        request.socket_id
    );
    let connected_at = crate::types::UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    state.agents.by_id.insert(
        request.agent_id,
        AgentConnection {
            agent_name: request.agent_name,
            socket_id: request.socket_id,
            outgoing_text: request.outgoing_text,
            outgoing_binary: request.outgoing_binary,
            connected_at,
            os: request.os,
            arch: request.arch,
            hostname: request.hostname,
            username: request.username,
        },
    );
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
