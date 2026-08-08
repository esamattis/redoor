use super::{
    AgentActor, AgentHandle, AgentMsg, AgentRuntime, AgentState,
    transfer::{begin_transfer_connection, schedule_transfer_reconnect},
    ws::{spawn_read_task, spawn_stdin_task},
};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    Level, log,
    types::{AgentId, Message},
};
use sysinfo::System;
use tokio::sync::mpsc::{self, Receiver};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

impl AgentRuntime {
    /// Creates the initial agent runtime state before any websocket connection exists.
    pub(crate) fn new(
        agent_id: AgentId,
        agent_name: String,
        server_url: String,
        default_directory: String,
        token: String,
    ) -> Self {
        Self {
            state: AgentState::new(agent_id, agent_name, server_url, default_directory, token),
        }
    }

    /// Runs the agent event loop until shutdown or fatal error.
    pub(crate) async fn run(mut self, mut receiver: Receiver<AgentMsg>, handle: AgentHandle) {
        spawn_stdin_task(handle.clone()).await;
        let _ = handle.try_send(AgentMsg::Connect);

        log!(
            Level::Info,
            "Agent task started: agent_id={}, agent_name={}",
            self.state.agent_id,
            self.state.agent_name
        );

        while let Some(message) = receiver.recv().await {
            if !self.handle_message(handle.clone(), message).await {
                break;
            }
        }

        self.state.ws_control_tx = None;
        self.state.clear_transfer_connection();
        self.state.active_uploads.clear();
        self.state.active_downloads.clear();
        self.state.active_terminals.clear();
        self.state.active_log_streams.clear();

        log!(
            Level::Info,
            "Agent stopped: agent_id={}",
            self.state.agent_id
        );
    }

    /// Handles one agent control message and returns whether the event loop should continue.
    async fn handle_message(&mut self, handle: AgentHandle, message: AgentMsg) -> bool {
        let agent = AgentActor;

        match message {
            AgentMsg::Connect => {
                if self.state.ws_control_tx.is_none() {
                    self.connect(handle).await;
                }
            }
            AgentMsg::ScheduleReconnect { error } => {
                log!(
                    Level::Error,
                    "Connection failed: {}, scheduling reconnect in 5s",
                    error
                );
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = handle.try_send(AgentMsg::Connect);
                });
            }
            AgentMsg::WebSocketMessage {
                connection_generation,
                text,
            } => {
                if connection_generation != self.state.connection_generation {
                    return true;
                }
                if let Some(tx_control) = self.state.ws_control_tx.as_ref().cloned() {
                    agent
                        .handle_incoming_message(text, &mut self.state, &tx_control, handle)
                        .await;
                }
            }
            AgentMsg::TransferConnected {
                control_generation,
                transfer_generation,
                token,
                sender,
                shutdown,
                installed,
            } => {
                let is_current = control_generation == self.state.connection_generation
                    && transfer_generation == self.state.transfer_generation
                    && self.state.transfer_token.as_ref() == Some(&token);
                if is_current {
                    // Install before acknowledging so transfer auth cannot expose the server first.
                    self.state.ws_transfer_tx = Some(sender);
                    self.state.transfer_shutdown = Some(shutdown);
                    let _ = installed.send(true);
                } else {
                    let _ = shutdown.send(true);
                    let _ = installed.send(false);
                }
            }
            AgentMsg::TransferConnectionLost {
                control_generation,
                transfer_generation,
                reason,
            } => {
                if control_generation != self.state.connection_generation
                    || transfer_generation != self.state.transfer_generation
                {
                    log!(
                        Level::Debug,
                        "Ignoring stale transfer loss: generation={}",
                        transfer_generation
                    );
                    return true;
                }
                log!(
                    Level::Warning,
                    "Transfer connection lost: agent_id={}, reason={}",
                    self.state.agent_id,
                    reason
                );
                self.state.ws_transfer_tx = None;
                self.state.transfer_shutdown = None;
                self.state.active_uploads.clear();
                self.state.active_downloads.clear();
                let next_generation = self.state.advance_transfer_generation();
                if let Some(token) = self.state.transfer_token.clone() {
                    log!(
                        Level::Info,
                        "Transfer reconnect scheduled: agent_id={}, generation={}",
                        self.state.agent_id,
                        next_generation
                    );
                    schedule_transfer_reconnect(handle, control_generation, next_generation, token);
                }
            }
            AgentMsg::ReconnectTransfer {
                control_generation,
                transfer_generation,
                token,
            } => {
                if control_generation == self.state.connection_generation
                    && transfer_generation == self.state.transfer_generation
                    && self.state.transfer_token.as_ref() == Some(&token)
                    && self.state.ws_control_tx.is_some()
                    && self.state.ws_transfer_tx.is_none()
                {
                    begin_transfer_connection(&mut self.state, handle, token);
                }
            }
            AgentMsg::ConnectionLost {
                connection_generation,
                reason,
            } => {
                if connection_generation != self.state.connection_generation {
                    log!(
                        Level::Debug,
                        "Ignoring stale connection loss from generation {}: {}",
                        connection_generation,
                        reason
                    );
                    return true;
                }
                if self.state.ws_control_tx.is_none() {
                    log!(
                        Level::Debug,
                        "Ignoring duplicate connection loss: {}",
                        reason
                    );
                    return true;
                }
                log!(
                    Level::Warning,
                    "Connection lost: {}, scheduling reconnect in 5s",
                    reason
                );
                self.state.ws_control_tx = None;
                self.state.clear_transfer_connection();
                self.state.active_uploads.clear();
                self.state.active_downloads.clear();
                self.state.active_terminals.clear();
                self.state.active_log_streams.clear();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = handle.try_send(AgentMsg::Connect);
                });
            }
            AgentMsg::SendWebSocketMessage { msg } => {
                if let Some(tx) = &self.state.ws_control_tx
                    && tx.send(msg).await.is_err()
                {
                    log!(
                        Level::Error,
                        "Failed to send message, connection may be lost"
                    );
                }
            }
            AgentMsg::TerminalFinished { terminal_id } => {
                self.state.active_terminals.remove(&terminal_id);
            }
            AgentMsg::LogStreamFinished { log_stream_id } => {
                self.state.active_log_streams.remove(&log_stream_id);
            }
            AgentMsg::ExitWithError => {
                log!(Level::Error, "Exiting agent due to error");
                std::process::exit(1);
            }
        }

        true
    }

    /// Opens a websocket connection and wires the connection tasks into the runtime channels.
    async fn connect(&mut self, handle: AgentHandle) {
        log!(
            Level::Info,
            "Attempting to connect to {} as agent '{}'",
            self.state.server_url,
            self.state.agent_name
        );

        match connect_async(&self.state.server_url).await {
            Ok((ws_stream, _response)) => {
                log!(Level::Info, "Connected to {}", self.state.server_url);
                log!(
                    Level::Info,
                    "Agent connected: agent_id={}, agent_name={}, server={}",
                    self.state.agent_id,
                    self.state.agent_name,
                    self.state.server_url
                );

                let (write, read) = ws_stream.split();
                let (control_tx, mut control_rx) = mpsc::channel::<WsMessage>(32);
                let connection_generation = self.state.advance_connection_generation();

                self.state.ws_control_tx = Some(control_tx.clone());

                spawn_read_task(read, handle.clone(), connection_generation).await;

                let writer_handle = handle.clone();
                tokio::spawn(async move {
                    let mut write = write;
                    while let Some(message) = control_rx.recv().await {
                        if write.send(message).await.is_err() {
                            log!(Level::Warning, "Failed to send WebSocket message");
                            let _ = writer_handle
                                .send(AgentMsg::ConnectionLost {
                                    connection_generation,
                                    reason: "Failed to write to server connection".to_string(),
                                })
                                .await;
                            break;
                        }
                    }
                });

                let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
                let os = std::env::consts::OS.to_string();
                let arch = std::env::consts::ARCH.to_string();
                let username = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());

                let register_msg = Message::AgentRegister {
                    agent_id: self.state.agent_id.clone(),
                    agent_name: self.state.agent_name.clone(),
                    os,
                    arch,
                    hostname,
                    username,
                    cwd: self.state.default_directory.clone(),
                    token: self.state.token.clone(),
                    // Lets the server compare agent builds against itself without a round-trip command.
                    binary: redoor::commands::current_binary_identity(),
                };

                if let Ok(json) = serde_json::to_string(&register_msg) {
                    // Do not log the JSON body: it includes the agent token secret.
                    log!(
                        Level::Info,
                        "Sending agent registration message: agent_id={}, agent_name={}",
                        self.state.agent_id,
                        self.state.agent_name
                    );
                    if let Err(error) = control_tx.send(WsMessage::text(json)).await {
                        log!(Level::Error, "Failed to send agent registration: {}", error);
                    }
                }
            }
            Err(error) => {
                log!(Level::Error, "Connection failed: {}", error);
                let _ = handle.try_send(AgentMsg::ScheduleReconnect {
                    error: error.to_string(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor::types::AgentId;

    /// Verifies a delayed writer failure cannot clear a newer live connection.
    #[tokio::test]
    async fn stale_connection_loss_does_not_clear_replacement_connection() {
        redoor::logging::init(None).await;
        let mut runtime = AgentRuntime::new(
            AgentId::from("agent"),
            "agent".to_string(),
            "ws://localhost".to_string(),
            "/tmp".to_string(),
            "test-token".to_string(),
        );
        let stale_generation = runtime.state.advance_connection_generation();
        let current_generation = runtime.state.advance_connection_generation();
        let (control_tx, _control_rx) = mpsc::channel(1);
        let (transfer_tx, _transfer_rx) = mpsc::channel(1);
        runtime.state.ws_control_tx = Some(control_tx);
        runtime.state.ws_transfer_tx = Some(transfer_tx);
        let (sender, _receiver) = mpsc::channel(1);
        let handle = AgentHandle { sender };

        let keep_running = runtime
            .handle_message(
                handle,
                AgentMsg::ConnectionLost {
                    connection_generation: stale_generation,
                    reason: "old writer failed".to_string(),
                },
            )
            .await;

        // The stale event must not stop the actor or detach the current writer lanes.
        assert!(keep_running);
        assert_eq!(runtime.state.connection_generation, current_generation);
        // The current control sender must survive a delayed loss from the old generation.
        assert!(runtime.state.ws_control_tx.is_some());
        // The independently attached transfer sender must also remain available.
        assert!(runtime.state.ws_transfer_tx.is_some());
    }

    /// Verifies delayed transfer teardown cannot detach a newer payload socket.
    #[tokio::test]
    async fn stale_transfer_loss_does_not_clear_replacement_sender() {
        redoor::logging::init(None).await;
        let mut runtime = AgentRuntime::new(
            AgentId::from("agent"),
            "agent".to_string(),
            "ws://localhost".to_string(),
            "/tmp".to_string(),
            "test-token".to_string(),
        );
        runtime.state.advance_connection_generation();
        let stale_generation = runtime.state.advance_transfer_generation();
        let current_generation = runtime.state.advance_transfer_generation();
        runtime.state.transfer_token = Some("session-token".to_string());
        let (control_tx, _control_rx) = mpsc::channel(1);
        let (transfer_tx, _transfer_rx) = mpsc::channel(1);
        runtime.state.ws_control_tx = Some(control_tx);
        runtime.state.ws_transfer_tx = Some(transfer_tx);
        let (sender, _receiver) = mpsc::channel(1);
        let handle = AgentHandle { sender };

        let keep_running = runtime
            .handle_message(
                handle,
                AgentMsg::TransferConnectionLost {
                    control_generation: runtime.state.connection_generation,
                    transfer_generation: stale_generation,
                    reason: "old transfer reader ended".to_string(),
                },
            )
            .await;

        // A stale transfer event must not stop the authoritative control actor.
        assert!(keep_running);
        // The current transfer generation must remain unchanged by delayed teardown.
        assert_eq!(runtime.state.transfer_generation, current_generation);
        // The replacement payload sender must remain installed and usable.
        assert!(runtime.state.ws_transfer_tx.is_some());
    }
}
