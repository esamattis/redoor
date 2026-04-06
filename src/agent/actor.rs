use super::{
    AgentActor, AgentMsg, AgentState,
    ws::{spawn_read_task, spawn_stdin_task},
};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    Level, log,
    types::{AgentId, Message},
};
use sysinfo::System;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

/// Bounded control mailbox keeps agent self-messaging explicit after removing the actor framework.
const AGENT_CONTROL_MAILBOX_CAPACITY: usize = 64;
/// Bounded binary ingress lane keeps server-to-agent upload chunks backpressured.
const AGENT_BINARY_INGRESS_CAPACITY: usize = 1;

/// Converts a channel receive result into the next outbound websocket frame while marking the lane closed once its sender side is gone.
fn take_outbound_message(message: Option<WsMessage>, lane_closed: &mut bool) -> Option<WsMessage> {
    match message {
        Some(message) => Some(message),
        None => {
            *lane_closed = true;
            None
        }
    }
}

impl AgentActor {
    /// Runs the agent runtime as one explicit Tokio event loop plus helper tasks.
    pub(crate) async fn run(
        &self,
        agent_id: AgentId,
        agent_name: String,
        server_url: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (control_tx, mut control_rx) =
            mpsc::channel::<AgentMsg>(AGENT_CONTROL_MAILBOX_CAPACITY);
        let (binary_tx, mut binary_rx) = mpsc::channel::<Vec<u8>>(AGENT_BINARY_INGRESS_CAPACITY);
        let mut state = AgentState::new(agent_id, agent_name, server_url);

        log!(
            Level::Info,
            "Agent runtime started: agent_id={}, agent_name={}",
            state.agent_id,
            state.agent_name
        );

        spawn_stdin_task(control_tx.clone()).await;
        let _ = control_tx.send(AgentMsg::Connect).await;

        loop {
            tokio::select! {
                maybe_bytes = binary_rx.recv() => {
                    let Some(bytes) = maybe_bytes else {
                        break;
                    };
                    self.handle_upload_chunk(&mut state, bytes).await;
                }
                maybe_message = control_rx.recv() => {
                    let Some(message) = maybe_message else {
                        break;
                    };
                    if !self.handle_message(message, &mut state, &control_tx, &binary_tx).await {
                        break;
                    }
                }
            }
        }

        state.ws_text_tx = None;
        state.ws_binary_tx = None;
        state.active_uploads.clear();
        state.active_downloads.clear();
        log!(Level::Info, "Agent stopped: agent_id={}", state.agent_id);
        Ok(())
    }

    /// Schedules a reconnect attempt without blocking the main agent loop.
    fn schedule_reconnect(&self, control_tx: mpsc::Sender<AgentMsg>) {
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            let _ = control_tx.send(AgentMsg::Reconnect).await;
        });
    }

    /// Handles one control-plane message in the explicit agent event loop.
    async fn handle_message(
        &self,
        message: AgentMsg,
        state: &mut AgentState,
        control_tx: &mpsc::Sender<AgentMsg>,
        binary_tx: &mpsc::Sender<Vec<u8>>,
    ) -> bool {
        match message {
            AgentMsg::Connect => {
                log!(
                    Level::Info,
                    "Attempting to connect to {} as agent '{}'",
                    state.server_url,
                    state.agent_name
                );

                match connect_async(&state.server_url).await {
                    Ok((ws_stream, _response)) => {
                        log!(Level::Info, "Connected to {}", state.server_url);
                        log!(
                            Level::Info,
                            "Agent connected: agent_id={}, agent_name={}, server={}",
                            state.agent_id,
                            state.agent_name,
                            state.server_url
                        );

                        let (write, read) = ws_stream.split();
                        let (text_tx, mut text_rx) = mpsc::channel::<WsMessage>(32);
                        let (binary_out_tx, mut binary_out_rx) = mpsc::channel::<WsMessage>(1);

                        state.ws_text_tx = Some(text_tx.clone());
                        state.ws_binary_tx = Some(binary_out_tx.clone());

                        spawn_read_task(read, control_tx.clone(), binary_tx.clone()).await;

                        tokio::spawn(async move {
                            let mut write = write;
                            let mut text_closed = false;
                            let mut binary_closed = false;

                            loop {
                                let next_message = tokio::select! {
                                    biased;
                                    message = text_rx.recv(), if !text_closed => take_outbound_message(message, &mut text_closed),
                                    message = binary_out_rx.recv(), if !binary_closed => take_outbound_message(message, &mut binary_closed),
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

                        let _ = control_tx.send(AgentMsg::ConnectionEstablished).await;

                        let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
                        let os = std::env::consts::OS.to_string();
                        let arch = std::env::consts::ARCH.to_string();
                        let username =
                            std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());

                        let register_msg = Message::AgentRegister {
                            agent_id: state.agent_id.clone(),
                            agent_name: state.agent_name.clone(),
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
                        let _ = control_tx
                            .send(AgentMsg::ConnectionFailed {
                                error: error.to_string(),
                            })
                            .await;
                    }
                }
            }
            AgentMsg::ConnectionEstablished => {
                log!(Level::Info, "Connection established");
            }
            AgentMsg::ConnectionFailed { error } => {
                log!(
                    Level::Error,
                    "Connection failed: {}, scheduling reconnect in 5s",
                    error
                );
                self.schedule_reconnect(control_tx.clone());
            }
            AgentMsg::WebSocketMessage { text } => {
                if let (Some(tx_text), Some(tx_binary)) = (
                    state.ws_text_tx.as_ref().cloned(),
                    state.ws_binary_tx.as_ref().cloned(),
                ) {
                    self.handle_incoming_message(
                        text,
                        state,
                        &tx_text,
                        &tx_binary,
                        control_tx.clone(),
                    )
                    .await;
                }
            }
            AgentMsg::ConnectionLost { reason } => {
                log!(
                    Level::Warning,
                    "Connection lost: {}, scheduling reconnect in 5s",
                    reason
                );
                state.ws_text_tx = None;
                state.ws_binary_tx = None;
                state.active_uploads.clear();
                state.active_downloads.clear();
                self.schedule_reconnect(control_tx.clone());
            }
            AgentMsg::Reconnect => {
                log!(Level::Info, "Attempting to reconnect...");
                let _ = control_tx.send(AgentMsg::Connect).await;
            }
            AgentMsg::SendWebSocketMessage { msg } => {
                if let Some(tx) = &state.ws_text_tx {
                    if tx.send(msg).await.is_err() {
                        log!(
                            Level::Error,
                            "Failed to send message, connection may be lost"
                        );
                    }
                }
            }
            AgentMsg::ExitWithError => {
                log!(Level::Error, "Exiting agent due to error");
                std::process::exit(1);
            }
        }

        true
    }
}
