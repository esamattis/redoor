use super::RouterError;
use super::cleanup;
use super::messages::{
    AgentListEntry, ApplyManagedLifecycleRequest, ExecuteCommandRequest, OpenAgentLogStreamRequest,
    OpenTerminalRequest, RegisterAgentRequest, RegisterManagedAgentRequest,
    RegisterTransferConnectionRequest, UnregisterManagedAgentRequest,
};
use super::state::{AgentConnection, KnownAgent, RouterState, TransferConnection};
use super::ui;
use crate::commands::{AgentConnectionStatus, CommandResult};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};
use axum::extract::ws::Message as WsMessage;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

impl AgentConnection {
    /// Builds one live router connection entry from the agent registration payload.
    pub(crate) fn from_register_request(request: RegisterAgentRequest) -> Self {
        Self {
            agent_id: request.agent_id,
            agent_name: request.agent_name,
            socket_id: request.socket_id,
            outgoing_commands: request.outgoing_commands,
            outgoing_priority: request.outgoing_priority,
            transfer_token: uuid::Uuid::new_v4().to_string(),
            transfer: None,
            connected_at: crate::types::UnixTimestampSeconds::new(chrono::Utc::now().timestamp()),
            os: request.os,
            arch: request.arch,
            hostname: request.hostname,
            username: request.username,
            default_directory: request.default_directory,
            binary: request.binary,
            supports_self_exec: request.supports_self_exec,
            supports_native_open: request.supports_native_open,
            supports_trash: request.supports_trash,
            supports_move_to_trash: request.supports_move_to_trash,
            uid: request.uid,
            is_root: request.is_root,
        }
    }

    /// Serializes and admits one ordinary command or bootstrap onto the bounded lane.
    pub(crate) fn send_message(&self, message: Message) -> bool {
        self.send_to_lane(message, &self.outgoing_commands)
    }

    /// Queues lifecycle or cancellation traffic independently of command admission.
    pub(crate) fn send_priority_message(&self, message: Message) -> bool {
        self.send_to_lane(message, &self.outgoing_priority)
    }

    /// Serializes one message before attempting non-blocking admission to a bounded lane.
    fn send_to_lane(&self, message: Message, lane: &tokio::sync::mpsc::Sender<WsMessage>) -> bool {
        match serde_json::to_string(&message) {
            Ok(json) => {
                if lane.try_send(WsMessage::Text(json.into())).is_err() {
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
                crate::log_failure!(
                    Level::Error,
                    "Failed to serialize message for agent: socket_id={}, error={}",
                    self.socket_id,
                    error
                );
                false
            }
        }
    }

    /// Returns the payload transport without ever falling back to the control socket.
    pub(crate) fn transfer_connection(&self) -> Result<TransferConnection, RouterError> {
        self.transfer
            .clone()
            .ok_or_else(|| RouterError::TransferConnectionUnavailable {
                agent_id: self.agent_id.to_string(),
            })
    }

    /// Stops the attached payload socket when this control session loses authority.
    pub(crate) fn shutdown_transfer(&self) {
        if let Some(transfer) = &self.transfer {
            let _ = transfer.shutdown.send(true);
        }
    }
}

impl TransferConnection {
    /// Queues one binary frame while preserving bounded payload backpressure.
    pub(crate) async fn send_binary(&self, bytes: Vec<u8>) -> bool {
        if self
            .outgoing_binary
            .send(WsMessage::Binary(bytes.into()))
            .await
            .is_err()
        {
            log!(
                Level::Warning,
                "Failed to queue transfer message: socket_id={}",
                self.socket_id
            );
            false
        } else {
            true
        }
    }
}

/// Compares transfer tokens in constant time so rejection timing does not reveal token contents.
fn transfer_tokens_match(left: &str, right: &str) -> bool {
    let left_digest = Sha256::digest(left.as_bytes());
    let right_digest = Sha256::digest(right.as_bytes());
    bool::from(left_digest.ct_eq(&right_digest))
}

/// Commits live routing and retained inventory together after lifecycle admission.
///
/// Public status stays non-Connected until the payload socket attaches so clients
/// that gate on `Connected` do not start transfers during the normal handshake window.
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
    let binary = connection.binary.clone();
    let supports_self_exec = connection.supports_self_exec;
    let supports_native_open = connection.supports_native_open;
    let supports_trash = connection.supports_trash;
    let supports_move_to_trash = connection.supports_move_to_trash;
    let uid = connection.uid;
    let is_root = connection.is_root;
    let transfer_token = connection.transfer_token.clone();
    let transfer_open_sender = connection.outgoing_priority.clone();
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
            configuration_editable: false,
            ssh_target: None,
            status: AgentConnectionStatus::Disconnected,
            connected_at: None,
            last_seen_at: None,
            connection_issue: None,
            provisioning_status: Vec::new(),
            socket_id: None,
            binary: None,
            supports_self_exec: false,
            supports_native_open: false,
            supports_trash: false,
            supports_move_to_trash: false,
            uid: None,
            is_root: false,
        });
    known.name = name;
    known.default_directory = Some(default_directory);
    // Control is live, but transfer usability still depends on the async payload handshake.
    // Leave Starting/Disconnected (or any non-Connected state) until register_transfer promotes.
    if known.status == AgentConnectionStatus::Connected {
        known.status = if known.managed {
            AgentConnectionStatus::Starting
        } else {
            AgentConnectionStatus::Disconnected
        };
    }
    known.connected_at = Some(connected_at);
    known.connection_issue = None;
    known.socket_id = Some(socket_id);
    known.binary = Some(binary);
    known.supports_self_exec = supports_self_exec;
    known.supports_native_open = supports_native_open;
    known.supports_trash = supports_trash;
    known.supports_move_to_trash = supports_move_to_trash;
    known.uid = uid;
    known.is_root = is_root;
    ui::notify_agents_changed(state);

    if let Ok(message) = serde_json::to_string(&Message::TransferSocketOpen {
        token: transfer_token,
    }) {
        let _ = transfer_open_sender.try_send(WsMessage::Text(message.into()));
    }
}

/// Marks inventory fully ready only after both control and payload sockets are live.
fn mark_agent_transfer_ready(state: &mut RouterState, agent_id: &AgentId) {
    let Some(known) = state.agents.known_by_id.get_mut(agent_id) else {
        return;
    };
    if known.status == AgentConnectionStatus::Connected {
        return;
    }
    known.status = AgentConnectionStatus::Connected;
    known.connection_issue = None;
    ui::notify_agents_changed(state);
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
            old_connection.shutdown_transfer();
            if let Some(known) = state.agents.known_by_id.get_mut(&old_agent_id) {
                known.last_seen_at = Some(crate::types::UnixTimestampSeconds::new(
                    chrono::Utc::now().timestamp(),
                ));
                known.connected_at = None;
                known.socket_id = None;
            }
            // Notify the old session so its agent process exits promptly
            // instead of lingering as a zombie.
            let _ = old_connection.send_priority_message(Message::Error {
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
    let rejection_sender = request.outgoing_priority.clone();
    let watchdog = request.watchdog.clone();
    let watchdog_attempt_generation = request.watchdog_attempt_generation;
    let accepted = match watchdog.as_ref() {
        Some(watchdog) => watchdog_attempt_generation.is_some_and(|attempt_generation| {
            watchdog
                .while_current_attempt(attempt_generation, || commit_registration(state, request))
                .is_some()
        }),
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
            let _ = rejection_sender.try_send(WsMessage::Text(rejection.into()));
        }
        log!(
            Level::Warning,
            "Ignoring managed registration that lost a shutdown race: agent_id={}",
            agent_id
        );
    }
}

/// Authenticates and installs a payload socket under the current control session.
///
/// When a broken transfer socket reconnects before the server processes the old
/// socket's unregister, replacement must fail in-flight payload work first.
/// Otherwise the delayed unregister is ignored as stale while the agent has
/// already dropped the old workers, leaving HTTP requests stuck forever.
///
/// Registration is cancellation-aware: if the socket handler timed out and
/// dropped the reply receiver, we must not install its already-dead senders.
/// A timed-out handler never reaches unregister, so committing would leave a
/// zombie transfer lane until some later socket replaces it.
pub(crate) async fn register_transfer(
    state: &mut RouterState,
    request: RegisterTransferConnectionRequest,
) {
    // Bail before mutating router state when the caller already gave up
    // (request timeout dropped the reply). Otherwise a late-queued message
    // would evict a live payload socket and install dead channels.
    if request.reply.is_closed() {
        log!(
            Level::Warning,
            "Ignoring cancelled transfer registration: agent_id={}, socket_id={}",
            request.agent_id,
            request.socket_id
        );
        let _ = request.shutdown.send(true);
        return;
    }

    let previous = {
        let Some(connection) = state.agents.by_id.get_mut(&request.agent_id) else {
            let _ = request
                .reply
                .send(Err(RouterError::TransferAuthenticationFailed));
            return;
        };
        if !transfer_tokens_match(&connection.transfer_token, &request.token) {
            let _ = request
                .reply
                .send(Err(RouterError::TransferAuthenticationFailed));
            return;
        }
        // Evict the old payload lane before installing the replacement so
        // cleanup cannot race with new traffic on the incoming socket.
        connection.transfer.take()
    };

    if let Some(previous) = previous {
        let _ = previous.shutdown.send(true);
        log!(
            Level::Info,
            "Transfer socket replaced: agent_id={}, old_socket_id={}, socket_id={}",
            request.agent_id,
            previous.socket_id,
            request.socket_id
        );
        // Fail downloads/uploads/remote copies before the new socket is
        // authoritative. Stale unregister for the old socket_id is ignored, and
        // the agent already cleared workers tied to that generation.
        cleanup::cleanup_agent_transfer_requests(
            state,
            &request.agent_id,
            format!("Transfer connection replaced: {}", request.agent_id),
        )
        .await;
    }

    // Re-check after awaits: the socket task may have timed out while we
    // cleaned up the previous generation.
    if request.reply.is_closed() {
        log!(
            Level::Warning,
            "Aborting transfer registration after caller cancelled: agent_id={}, socket_id={}",
            request.agent_id,
            request.socket_id
        );
        let _ = request.shutdown.send(true);
        return;
    }

    let Some(connection) = state.agents.by_id.get_mut(&request.agent_id) else {
        // Control session disappeared during replacement cleanup.
        let _ = request.shutdown.send(true);
        let _ = request
            .reply
            .send(Err(RouterError::TransferAuthenticationFailed));
        return;
    };
    connection.transfer = Some(TransferConnection {
        socket_id: request.socket_id.clone(),
        outgoing_binary: request.outgoing_binary,
        shutdown: request.shutdown,
    });
    log!(
        Level::Info,
        "Transfer socket registered: agent_id={}, socket_id={}",
        request.agent_id,
        request.socket_id
    );
    // Promote only here so Connected means transfers can succeed, not merely control is up.
    mark_agent_transfer_ready(state, &request.agent_id);
    let _ = request.reply.send(Ok(()));
}

/// Clears only the matching payload socket so stale teardown cannot evict a replacement.
pub(crate) async fn unregister_transfer(
    state: &mut RouterState,
    agent_id: AgentId,
    socket_id: crate::types::SocketId,
) {
    let is_current = state
        .agents
        .by_id
        .get(&agent_id)
        .and_then(|connection| connection.transfer.as_ref())
        .is_some_and(|transfer| transfer.socket_id == socket_id);
    if !is_current {
        log!(
            Level::Debug,
            "Ignoring stale transfer unregister: agent_id={}, socket_id={}",
            agent_id,
            socket_id
        );
        return;
    }

    if let Some(connection) = state.agents.by_id.get_mut(&agent_id) {
        connection.transfer = None;
    }
    log!(
        Level::Info,
        "Transfer socket unregistered: agent_id={}, socket_id={}",
        agent_id,
        socket_id
    );
    cleanup::cleanup_agent_transfer_requests(
        state,
        &agent_id,
        format!("Transfer connection lost: {}", agent_id),
    )
    .await;
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
            configuration_editable: request.configuration_editable,
            ssh_target: request.ssh_target,
            status: AgentConnectionStatus::Stopped,
            connected_at: None,
            last_seen_at: None,
            connection_issue: None,
            provisioning_status: Vec::new(),
            socket_id: None,
            binary: None,
            supports_self_exec: false,
            supports_native_open: false,
            supports_trash: false,
            supports_move_to_trash: false,
            uid: None,
            is_root: false,
        },
    );
    ui::notify_agents_changed(state);
    let _ = request.reply.send(());
}

/// Removes all retained state for a managed agent whose supervisor is already dormant.
pub(crate) async fn unregister_managed(
    state: &mut RouterState,
    request: UnregisterManagedAgentRequest,
) {
    if let Some(connection) = state.agents.by_id.remove(&request.agent_id) {
        connection.shutdown_transfer();
    }
    state.agents.known_by_id.remove(&request.agent_id);
    cleanup::cleanup_agent_requests(state, &request.agent_id).await;
    state
        .terminal_registry
        .remove_agent_pending(&request.agent_id);
    state.log_registry.remove_agent(&request.agent_id);
    ui::notify_agents_changed(state);
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
        evict_existing,
        reply,
    } = request;
    let Some(managed) = state
        .agents
        .known_by_id
        .get(&agent_id)
        .map(|known| known.managed)
    else {
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
        return;
    };
    if !managed {
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
        return;
    }

    if evict_existing && let Some(connection) = state.agents.by_id.remove(&agent_id) {
        connection.shutdown_transfer();
        if let Some(known) = state.agents.known_by_id.get_mut(&agent_id) {
            known.last_seen_at = Some(crate::types::UnixTimestampSeconds::new(
                chrono::Utc::now().timestamp(),
            ));
            known.connected_at = None;
            known.socket_id = None;
        }
        let _ = connection.send_priority_message(crate::types::Message::Error {
            message: "Managed agent startup was retried".to_string(),
        });
        cleanup::cleanup_agent_requests(state, &agent_id).await;
        state.terminal_registry.remove_agent_pending(&agent_id);
        state.log_registry.remove_agent(&agent_id);
    }

    let known = state
        .agents
        .known_by_id
        .get_mut(&agent_id)
        .expect("managed agent disappeared during lifecycle projection");

    let live_connection = state.agents.by_id.get(&agent_id);
    let live_socket = live_connection.map(|connection| connection.socket_id.clone());
    let transfer_ready = live_connection
        .and_then(|connection| connection.transfer.as_ref())
        .is_some();
    if live_socket.is_some() && snapshot.status != AgentConnectionStatus::Stopped {
        // Watchdog learns about control registration first; do not advertise Connected
        // until the payload socket is installed. Once Connected, transfer loss must not demote.
        if transfer_ready || known.status == AgentConnectionStatus::Connected {
            known.status = AgentConnectionStatus::Connected;
        } else if snapshot.status == AgentConnectionStatus::Connected {
            known.status = AgentConnectionStatus::Starting;
        } else {
            known.status = snapshot.status.clone();
        }
        known.connection_issue = snapshot.connection_issue;
        known.provisioning_status = snapshot.provisioning_status.clone();
    } else {
        known.status = snapshot.status.clone();
        known.connection_issue = snapshot.connection_issue;
        known.provisioning_status = snapshot.provisioning_status;
        known.socket_id = snapshot.socket_id;
        if known.status != AgentConnectionStatus::Connected {
            known.connected_at = None;
        }
    }

    if known.status == AgentConnectionStatus::Stopped
        && let Some(connection) = state.agents.by_id.remove(&agent_id)
    {
        connection.shutdown_transfer();
        known.last_seen_at = Some(crate::types::UnixTimestampSeconds::new(
            chrono::Utc::now().timestamp(),
        ));
        known.socket_id = None;
        let _ = connection.send_priority_message(crate::types::Message::Error {
            message: "Managed agent was shut down".to_string(),
        });
        cleanup::cleanup_agent_requests(state, &agent_id).await;
        state.terminal_registry.remove_agent_pending(&agent_id);
        state.log_registry.remove_agent(&agent_id);
    }
    ui::notify_agents_changed(state);
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
            configuration_editable: info.configuration_editable,
            ssh_target: info.ssh_target.clone(),
            status: info.status.clone(),
            connected_at: info.connected_at,
            connection_id: info.socket_id.clone(),
            last_seen_at: info.last_seen_at,
            connection_issue: info.connection_issue.clone(),
            provisioning_status: info.provisioning_status.clone(),
            binary: info.binary.clone(),
            supports_self_exec: info.supports_self_exec,
            supports_native_open: info.supports_native_open,
            supports_trash: info.supports_trash,
            supports_move_to_trash: info.supports_move_to_trash,
            uid: info.uid,
            is_root: info.is_root,
        })
        .collect()
}

/// Allocates an internal request id and routes a one-shot command to an agent.
pub(crate) fn execute_command_rest(state: &mut RouterState, request: ExecuteCommandRequest) {
    if request.reply.is_closed() {
        return;
    }
    state
        .pending_rest
        .by_request_id
        .retain(|_, (reply, _)| !reply.is_closed());
    let request_id = state.next_id();

    log!(
        Level::Trace,
        "Routing REST command: agent_id={}, request_id={}, command={:?}",
        request.agent_id,
        request_id,
        request.command
    );
    if let Some(agent_connection) = state.agents.by_id.get(&request.agent_id) {
        if agent_connection.send_message(Message::Command {
            agent_id: request.agent_id.clone(),
            request_id,
            command: request.command,
        }) {
            state
                .pending_rest
                .by_request_id
                .insert(request_id, (request.reply, request.agent_id.clone()));
        } else {
            let _ = request.reply.send(CommandResult::error(
                crate::commands::CommandErrorKind::ServiceUnavailable,
                format!("Agent control queue is full: {}", request.agent_id),
            ));
        }
    } else {
        let _ = request.reply.send(CommandResult::error(
            crate::commands::CommandErrorKind::NotFound,
            format!("Agent not found: {}", request.agent_id),
        ));
    }
}

/// Queues only the log bootstrap secret on the existing control connection.
pub(crate) fn open_log_stream(state: &RouterState, request: OpenAgentLogStreamRequest) {
    let result = match state.agents.by_id.get(&request.agent_id) {
        Some(connection)
            if connection.send_message(Message::LogStreamOpen {
                log_stream_id: request.log_stream_id.clone(),
                token: request.token.clone(),
            }) =>
        {
            Ok(())
        }
        Some(_) => Err(RouterError::ControlQueueFull {
            agent_id: request.agent_id.to_string(),
        }),
        None => Err(RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        }),
    };
    let _ = request.reply.send(result);
}

/// Queues only the terminal bootstrap secret on the existing control connection.
pub(crate) fn open_terminal(state: &RouterState, request: OpenTerminalRequest) {
    let result = match state.agents.by_id.get(&request.agent_id) {
        Some(connection)
            if connection.send_message(Message::TerminalOpen {
                terminal_id: request.terminal_id.clone(),
                token: request.token.clone(),
                size: request.size,
                cwd: request.cwd.clone(),
            }) =>
        {
            Ok(())
        }
        Some(_) => Err(RouterError::ControlQueueFull {
            agent_id: request.agent_id.to_string(),
        }),
        None => Err(RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        }),
    };
    let _ = request.reply.send(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::router::state::RouterState;
    use crate::{log_registry::LogRegistry, terminal_registry::TerminalRegistry};
    use tokio::sync::{mpsc, oneshot, watch};

    /// Builds isolated router state without starting a router mailbox task.
    fn test_state() -> RouterState {
        let refresh_task = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        RouterState::new(refresh_task, TerminalRegistry::new(), LogRegistry::new())
    }

    /// Inserts one authoritative control connection and returns its issued transfer token.
    fn insert_control(state: &mut RouterState, agent_id: &str) -> String {
        let (command_sender, _command_receiver) = mpsc::channel(64);
        let (priority_sender, _priority_receiver) = mpsc::channel(16);
        let request = RegisterAgentRequest {
            agent_id: AgentId::from(agent_id),
            agent_name: agent_id.to_string(),
            socket_id: crate::types::SocketId::new(),
            outgoing_commands: command_sender,
            outgoing_priority: priority_sender,
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            hostname: "host".to_string(),
            username: "user".to_string(),
            default_directory: "/tmp".to_string(),
            binary: crate::commands::current_binary_identity(),
            supports_self_exec: true,
            supports_native_open: true,
            supports_trash: true,
            supports_move_to_trash: true,
            uid: Some(1000),
            is_root: false,
            watchdog: None,
            watchdog_attempt_generation: None,
        };
        commit_registration(state, request);
        state.agents.by_id[&AgentId::from(agent_id)]
            .transfer_token
            .clone()
    }

    /// Verifies retry projection removes the old socket before reporting a fresh start.
    #[tokio::test]
    async fn retry_lifecycle_evicts_existing_managed_connection() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let agent_id = AgentId::from("managed-retry");
        let (register_reply, register_receiver) = oneshot::channel();
        register_managed(
            &mut state,
            RegisterManagedAgentRequest {
                agent_id: agent_id.clone(),
                default_directory: Some("/tmp".to_string()),
                configuration_editable: true,
                ssh_target: None,
                reply: register_reply,
            },
        );
        register_receiver
            .await
            .expect("managed inventory registration acknowledged");
        insert_control(&mut state, "managed-retry");

        apply_managed_lifecycle(
            &mut state,
            ApplyManagedLifecycleRequest {
                agent_id: agent_id.clone(),
                snapshot: crate::watchdog::WatchdogSnapshot {
                    attempt_generation: 2,
                    desired_running: true,
                    status: AgentConnectionStatus::Starting,
                    connection_issue: None,
                    provisioning_status: Vec::new(),
                    socket_id: None,
                },
                evict_existing: true,
                reply: None,
            },
        )
        .await;

        // REST success must not leave a dead socket available for routing or redirect.
        assert!(!state.agents.by_id.contains_key(&agent_id));
        // The retained managed row remains visible as the replacement attempt starts.
        assert_eq!(
            state.agents.known_by_id[&agent_id].status,
            AgentConnectionStatus::Starting
        );
        assert_eq!(state.agents.known_by_id[&agent_id].socket_id, None);
    }

    /// Creates a transfer registration request and exposes its shutdown observer.
    fn transfer_request(
        agent_id: &str,
        token: String,
        socket_id: crate::types::SocketId,
    ) -> (
        RegisterTransferConnectionRequest,
        oneshot::Receiver<Result<(), RouterError>>,
        watch::Receiver<bool>,
    ) {
        let (binary_sender, _binary_receiver) = mpsc::channel(1);
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let (reply, reply_receiver) = oneshot::channel();
        (
            RegisterTransferConnectionRequest {
                agent_id: AgentId::from(agent_id),
                token,
                socket_id,
                outgoing_binary: binary_sender,
                shutdown,
                reply,
            },
            reply_receiver,
            shutdown_receiver,
        )
    }

    /// Verifies clients that wait for Connected never see it before the payload socket is usable.
    #[tokio::test]
    async fn connected_status_waits_for_transfer_socket() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let token = insert_control(&mut state, "agent");
        // Control registration alone must not advertise full readiness.
        assert_eq!(
            state.agents.known_by_id[&AgentId::from("agent")].status,
            AgentConnectionStatus::Disconnected
        );
        assert!(
            state.agents.by_id[&AgentId::from("agent")]
                .transfer_connection()
                .is_err()
        );

        let socket_id = crate::types::SocketId::new();
        let (request, reply, _shutdown) = transfer_request("agent", token, socket_id);
        register_transfer(&mut state, request).await;
        assert_eq!(reply.await.expect("transfer reply delivered"), Ok(()));
        // Connected is reserved for the moment both sockets can serve work.
        assert_eq!(
            state.agents.known_by_id[&AgentId::from("agent")].status,
            AgentConnectionStatus::Connected
        );
        assert!(
            state.agents.by_id[&AgentId::from("agent")]
                .transfer_connection()
                .is_ok()
        );
    }

    /// Verifies only the current session token can attach and replacements shut down old sockets.
    #[tokio::test]
    async fn transfer_registration_authenticates_and_replaces_atomically() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let token = insert_control(&mut state, "agent");
        let first_socket = crate::types::SocketId::new();
        let (wrong_request, wrong_reply, _wrong_shutdown) =
            transfer_request("agent", "wrong-token".to_string(), first_socket.clone());
        register_transfer(&mut state, wrong_request).await;
        // Rejecting a wrong token proves stale or unauthenticated processes cannot attach.
        assert_eq!(
            wrong_reply.await.expect("wrong-token reply delivered"),
            Err(RouterError::TransferAuthenticationFailed)
        );
        // A failed attempt must leave the valid token usable rather than consuming it.
        assert!(
            state.agents.by_id[&AgentId::from("agent")]
                .transfer
                .is_none()
        );

        let (first_request, first_reply, first_shutdown) =
            transfer_request("agent", token.clone(), first_socket.clone());
        register_transfer(&mut state, first_request).await;
        // The current session token must install the payload connection successfully.
        assert_eq!(first_reply.await.expect("first reply delivered"), Ok(()));

        let replacement_socket = crate::types::SocketId::new();
        let (replacement_request, replacement_reply, _replacement_shutdown) =
            transfer_request("agent", token, replacement_socket.clone());
        register_transfer(&mut state, replacement_request).await;
        // Replacement is acknowledged only after router state owns the new socket.
        assert_eq!(
            replacement_reply
                .await
                .expect("replacement reply delivered"),
            Ok(())
        );
        // Replacing the socket must promptly stop both halves of the old connection.
        assert!(*first_shutdown.borrow());
        // The router must retain the replacement identity for stale teardown checks.
        assert_eq!(
            state.agents.by_id[&AgentId::from("agent")]
                .transfer
                .as_ref()
                .map(|transfer| transfer.socket_id.clone()),
            Some(replacement_socket)
        );
    }

    /// Verifies replacement fails payload-dependent work the delayed unregister would skip.
    #[tokio::test]
    async fn transfer_replacement_cleans_up_payload_requests() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let token = insert_control(&mut state, "agent");
        let first_socket = crate::types::SocketId::new();
        let (first_request, first_reply, _first_shutdown) =
            transfer_request("agent", token.clone(), first_socket);
        register_transfer(&mut state, first_request).await;
        assert_eq!(first_reply.await.expect("first reply delivered"), Ok(()));

        let download_id = state.next_id();
        let (chunk_sender, _chunk_receiver) = mpsc::channel(1);
        state.streams.downloads.insert(
            download_id,
            super::super::state::DirectDownload {
                agent_id: AgentId::from("agent"),
                chunk_sender: Some(chunk_sender),
                rest_cancel_sender: None,
                progress_id: Some(download_id.as_transfer_id()),
                canceled_by_rest: false,
            },
        );

        let upload_id = state.next_id();
        let (completion_sender, completion_receiver) = oneshot::channel();
        let (ready_sender, _ready_receiver) = oneshot::channel();
        state.streams.uploads.insert(
            upload_id,
            super::super::state::DirectUpload {
                agent_id: AgentId::from("agent"),
                completion_sender: Some(completion_sender),
                ready_sender: Some(ready_sender),
                ready: true,
                canceled_by_rest: false,
                explicitly_canceled: false,
                kind: super::super::state::DirectUploadKind::RawUpload,
            },
        );

        let replacement_socket = crate::types::SocketId::new();
        let (replacement_request, replacement_reply, _replacement_shutdown) =
            transfer_request("agent", token, replacement_socket);
        register_transfer(&mut state, replacement_request).await;
        assert_eq!(
            replacement_reply
                .await
                .expect("replacement reply delivered"),
            Ok(())
        );

        // Stale unregister is ignored after replacement, so cleanup must happen here.
        assert!(state.streams.downloads.is_empty());
        assert!(state.streams.uploads.is_empty());
        // Waiting HTTP upload clients must observe the lost payload path.
        assert!(matches!(
            completion_receiver
                .await
                .expect("upload completion delivered"),
            Err(RouterError::TransferConnectionUnavailable { .. })
        ));
    }

    /// Verifies a timed-out socket handler cannot install dead channels or evict a live socket.
    #[tokio::test]
    async fn transfer_registration_ignores_cancelled_reply() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let token = insert_control(&mut state, "agent");
        let live_socket = crate::types::SocketId::new();
        let (live_request, live_reply, _live_shutdown) =
            transfer_request("agent", token.clone(), live_socket.clone());
        register_transfer(&mut state, live_request).await;
        assert_eq!(live_reply.await.expect("live reply delivered"), Ok(()));

        let cancelled_socket = crate::types::SocketId::new();
        let (cancelled_request, cancelled_reply, cancelled_shutdown) =
            transfer_request("agent", token, cancelled_socket);
        // Dropping the reply models the socket handler's request timeout path,
        // which exits without ever sending UnregisterTransferConnection.
        drop(cancelled_reply);
        register_transfer(&mut state, cancelled_request).await;

        // The live payload lane must survive; installing dead senders would
        // admit transfers against a socket task that already exited.
        assert_eq!(
            state.agents.by_id[&AgentId::from("agent")]
                .transfer
                .as_ref()
                .map(|transfer| transfer.socket_id.clone()),
            Some(live_socket)
        );
        // Signal the abandoned registration's half so any lingering task exits.
        assert!(*cancelled_shutdown.borrow());
    }

    /// Verifies unknown agents and stale unregister events cannot affect live payload state.
    #[tokio::test]
    async fn transfer_registration_rejects_unknown_and_ignores_stale_unregister() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let unknown_socket = crate::types::SocketId::new();
        let (unknown_request, unknown_reply, _unknown_shutdown) =
            transfer_request("missing", "unknown-token".to_string(), unknown_socket);
        register_transfer(&mut state, unknown_request).await;
        // Unknown identities use the same generic rejection as bad tokens to avoid disclosure.
        assert_eq!(
            unknown_reply.await.expect("unknown reply delivered"),
            Err(RouterError::TransferAuthenticationFailed)
        );

        let token = insert_control(&mut state, "agent");
        let current_socket = crate::types::SocketId::new();
        let (request, reply, _shutdown) = transfer_request("agent", token, current_socket.clone());
        register_transfer(&mut state, request).await;
        // Setup must succeed before exercising stale teardown behavior.
        assert_eq!(reply.await.expect("registration reply delivered"), Ok(()));
        unregister_transfer(
            &mut state,
            AgentId::from("agent"),
            crate::types::SocketId::new(),
        )
        .await;
        // An unrelated socket id must not clear the authoritative transfer connection.
        assert_eq!(
            state.agents.by_id[&AgentId::from("agent")]
                .transfer
                .as_ref()
                .map(|transfer| transfer.socket_id.clone()),
            Some(current_socket)
        );
    }

    /// Verifies command overload is explicit while priority cancellation remains admitted.
    #[tokio::test]
    async fn full_control_queue_rejects_commands_and_preserves_priority_lane() {
        crate::logging::init(None).await.unwrap();
        let mut state = test_state();
        let agent_id = AgentId::from("bounded-agent");
        let (command_sender, mut command_receiver) = mpsc::channel(1);
        let (priority_sender, mut priority_receiver) = mpsc::channel(1);
        commit_registration(
            &mut state,
            RegisterAgentRequest {
                agent_id: agent_id.clone(),
                agent_name: agent_id.to_string(),
                socket_id: crate::types::SocketId::new(),
                outgoing_commands: command_sender,
                outgoing_priority: priority_sender,
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
                hostname: "host".to_string(),
                username: "user".to_string(),
                default_directory: "/tmp".to_string(),
                binary: crate::commands::current_binary_identity(),
                supports_self_exec: true,
                supports_native_open: true,
                supports_trash: true,
                supports_move_to_trash: true,
                uid: Some(1000),
                is_root: false,
                watchdog: None,
                watchdog_attempt_generation: None,
            },
        );
        // Remove the lifecycle bootstrap so the reserved lane is available for cancellation.
        assert!(matches!(
            priority_receiver.recv().await,
            Some(WsMessage::Text(_))
        ));

        let (first_reply, first_receiver) = oneshot::channel();
        execute_command_rest(
            &mut state,
            ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: crate::commands::Command::GetAgentDetails,
                reply: first_reply,
            },
        );
        // The admitted command owns exactly one pending reply while its frame fills the lane.
        assert_eq!(state.pending_rest.by_request_id.len(), 1);
        drop(first_receiver);

        let (overload_reply, overload_receiver) = oneshot::channel();
        execute_command_rest(
            &mut state,
            ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: crate::commands::Command::GetAgentDetails,
                reply: overload_reply,
            },
        );
        // Closed timed-out callers are pruned and rejected commands never enter pending state.
        assert!(state.pending_rest.by_request_id.is_empty());
        assert!(matches!(
            overload_receiver.await.expect("overload reply delivered"),
            CommandResult::Error {
                kind: crate::commands::CommandErrorKind::ServiceUnavailable,
                ..
            }
        ));

        let connection = &state.agents.by_id[&agent_id];
        assert!(connection.send_priority_message(Message::CancelTransfer {
            request_id: crate::types::RequestId::new(99),
        }));
        // Priority admission succeeds despite the unread ordinary command frame.
        assert!(matches!(
            priority_receiver.recv().await,
            Some(WsMessage::Text(_))
        ));
        // The ordinary queue remains bounded to its single admitted frame.
        assert!(matches!(
            command_receiver.recv().await,
            Some(WsMessage::Text(_))
        ));
    }
}
