use super::{
    AgentActor, AgentHandle, AgentMsg, AgentRuntime, AgentState,
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

/// Converts a channel receive result into the next outbound websocket frame
/// while marking the lane closed once its sender side is gone.
fn take_outbound_message(message: Option<WsMessage>, lane_closed: &mut bool) -> Option<WsMessage> {
    match message {
        Some(message) => Some(message),
        None => {
            *lane_closed = true;
            None
        }
    }
}

impl AgentRuntime {
    /// Creates the initial agent runtime state before any websocket connection exists.
    pub(crate) fn new(agent_id: AgentId, agent_name: String, server_url: String) -> Self {
        Self {
            state: AgentState::new(agent_id, agent_name, server_url),
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

        self.state.ws_text_tx = None;
        self.state.ws_binary_tx = None;
        self.state.active_uploads.clear();
        self.state.active_downloads.clear();

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
                self.connect(handle).await;
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
            AgentMsg::WebSocketMessage { text } => {
                if let (Some(tx_text), Some(tx_binary)) = (
                    self.state.ws_text_tx.as_ref().cloned(),
                    self.state.ws_binary_tx.as_ref().cloned(),
                ) {
                    agent
                        .handle_incoming_message(
                            text,
                            &mut self.state,
                            &tx_text,
                            &tx_binary,
                            handle,
                        )
                        .await;
                }
            }
            AgentMsg::WebSocketBinaryMessage { bytes } => {
                agent.handle_upload_chunk(&mut self.state, bytes).await;
            }
            AgentMsg::ConnectionLost { reason } => {
                log!(
                    Level::Warning,
                    "Connection lost: {}, scheduling reconnect in 5s",
                    reason
                );
                self.state.ws_text_tx = None;
                self.state.ws_binary_tx = None;
                self.state.active_uploads.clear();
                self.state.active_downloads.clear();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = handle.try_send(AgentMsg::Connect);
                });
            }
            AgentMsg::SendWebSocketMessage { msg } => {
                if let Some(tx) = &self.state.ws_text_tx
                    && tx.send(msg).await.is_err()
                {
                    log!(
                        Level::Error,
                        "Failed to send message, connection may be lost"
                    );
                }
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
                let (text_tx, mut text_rx) = mpsc::channel::<WsMessage>(32);
                let (binary_tx, mut binary_rx) = mpsc::channel::<WsMessage>(1);

                self.state.ws_text_tx = Some(text_tx.clone());
                self.state.ws_binary_tx = Some(binary_tx.clone());

                spawn_read_task(read, handle.clone()).await;

                tokio::spawn(async move {
                    let mut write = write;
                    let mut text_closed = false;
                    let mut binary_closed = false;

                    loop {
                        let next_message = tokio::select! {
                            biased;
                            message = text_rx.recv(), if !text_closed => take_outbound_message(message, &mut text_closed),
                            message = binary_rx.recv(), if !binary_closed => take_outbound_message(message, &mut binary_closed),
                            else => break,
                        };

                        let Some(message) = next_message else {
                            continue;
                        };

                        if write.send(message).await.is_err() {
                            log!(Level::Warning, "Failed to send WebSocket message");
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
                };

                if let Ok(json) = serde_json::to_string(&register_msg) {
                    log!(Level::Info, "Sending agent registration message: {}", json);
                    if let Err(error) = text_tx.send(WsMessage::text(json)).await {
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
