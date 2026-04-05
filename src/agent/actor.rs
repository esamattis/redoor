use super::{ActiveDownloads, AgentActor, AgentMsg, AgentState, DownloadSessionHandle};
use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef};
use redoor::{
    Level,
    commands::{Command, CommandHandler, CommandResult},
    log,
    types::{AgentId, Message, RequestId},
};
use sysinfo::System;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

impl AgentActor {
    /// Dispatches one incoming control message from the server and routes
    /// transfer-producing commands onto the binary websocket sender.
    async fn handle_incoming_message(
        &self,
        text: String,
        state: &mut AgentState,
        write_text: &mpsc::Sender<WsMessage>,
        write_binary: &mpsc::Sender<WsMessage>,
        agent_ref: ActorRef<AgentMsg>,
    ) {
        if let Ok(redoor_msg) = serde_json::from_str::<Message>(&text) {
            match redoor_msg {
                Message::Command {
                    request_id,
                    command,
                    ..
                } => {
                    log!(
                        Level::Trace,
                        "Command received: agent_id={}, request_id={}, command={:?}",
                        state.agent_id,
                        request_id,
                        command
                    );
                    if !self
                        .start_upload_session(
                            state.active_uploads.clone(),
                            write_text,
                            &state.agent_id,
                            request_id,
                            command.clone(),
                        )
                        .await
                    {
                        tokio::spawn(Self::handle_command_message(
                            write_text.clone(),
                            write_binary.clone(),
                            state.agent_id.clone(),
                            request_id,
                            command,
                            state.active_downloads.clone(),
                        ));
                    }
                }
                Message::CancelTransfer { request_id } => {
                    let download_handle = {
                        state
                            .active_downloads
                            .lock()
                            .expect("active downloads mutex poisoned")
                            .get(&request_id)
                            .cloned()
                    };

                    if let Some(download_handle) = download_handle {
                        log!(
                            Level::Info,
                            "Received transfer cancel from server: request_id={}",
                            request_id
                        );
                        let _ = download_handle.cancel_sender.send(true);
                    } else {
                        log!(
                            Level::Warning,
                            "Received transfer cancel for unknown download: request_id={}",
                            request_id
                        );
                    }
                }
                Message::Error { message } => {
                    log!(Level::Error, "Server error: {}", message);
                    let _ = agent_ref.cast(AgentMsg::ExitWithError);
                }
                _ => {}
            }
        }
    }

    /// Sends a command response back to the server on the prioritized text lane.
    pub(crate) async fn send_command_response(
        &self,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        result: CommandResult,
    ) {
        let response = Message::CommandResponse {
            agent_id: agent_id.clone(),
            request_id,
            result,
        };

        if let Ok(json) = serde_json::to_string(&response) {
            let _ = write.send(WsMessage::text(json)).await;
        }
    }

    /// Executes one non-upload command and routes any streamed payload over the
    /// binary websocket sender while keeping command responses on text.
    async fn handle_command_message(
        write_text: mpsc::Sender<WsMessage>,
        write_binary: mpsc::Sender<WsMessage>,
        agent_id: AgentId,
        request_id: RequestId,
        command: Command,
        active_downloads: ActiveDownloads,
    ) {
        match command {
            Command::RawDownload {
                path,
                range_start,
                range_end,
            } => {
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                active_downloads
                    .lock()
                    .expect("active downloads mutex poisoned")
                    .insert(request_id, DownloadSessionHandle { cancel_sender });
                AgentActor
                    .raw_download(
                        path,
                        range_start,
                        range_end,
                        request_id,
                        &write_binary,
                        cancel_receiver,
                        active_downloads.clone(),
                    )
                    .await;
            }
            Command::TarDownload { path } => {
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                active_downloads
                    .lock()
                    .expect("active downloads mutex poisoned")
                    .insert(request_id, DownloadSessionHandle { cancel_sender });
                AgentActor
                    .tar_download(
                        path,
                        request_id,
                        &write_binary,
                        cancel_receiver,
                        active_downloads.clone(),
                    )
                    .await;
            }
            Command::LocalCopyFile {
                source_path,
                dest_path,
            } => {
                AgentActor
                    .local_copy_file(source_path, dest_path, request_id, &write_text, &agent_id)
                    .await;
            }
            Command::LocalCopyDirectory {
                source_path,
                dest_path,
            } => {
                AgentActor
                    .local_copy_directory(
                        source_path,
                        dest_path,
                        request_id,
                        &write_text,
                        &agent_id,
                    )
                    .await;
            }
            Command::RawDelete { path } => {
                let result = CommandHandler::new()
                    .execute(Command::RawDelete { path })
                    .await;
                AgentActor
                    .send_command_response(&write_text, &agent_id, request_id, result)
                    .await;
            }
            other => {
                let result = CommandHandler::new().execute(other).await;
                let result_clone = result.clone();
                let response = Message::CommandResponse {
                    agent_id: agent_id.clone(),
                    request_id,
                    result,
                };

                if let Ok(json) = serde_json::to_string(&response) {
                    let _ = write_text.send(WsMessage::text(json)).await;
                }
                log!(
                    Level::Trace,
                    "Command response sent: agent_id={}, request_id={}, result={:?}",
                    agent_id,
                    request_id,
                    result_clone
                );
            }
        }
    }
}

impl Actor for AgentActor {
    type Msg = AgentMsg;
    type State = AgentState;
    type Arguments = (AgentId, String, String);

    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> std::result::Result<Self::State, ActorProcessingErr> {
        let (agent_id, agent_name, server_url) = args;

        log!(
            Level::Info,
            "AgentActor started: agent_id={}, agent_name={}",
            agent_id,
            agent_name
        );

        Self::spawn_stdin_task(myself.clone()).await;

        let _ = myself.cast(AgentMsg::Connect);

        Ok(AgentState::new(agent_id, agent_name, server_url))
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> std::result::Result<(), ActorProcessingErr> {
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
                        let (binary_tx, mut binary_rx) = mpsc::channel::<WsMessage>(1);

                        state.ws_text_tx = Some(text_tx.clone());
                        state.ws_binary_tx = Some(binary_tx.clone());

                        Self::spawn_read_task(read, myself.clone()).await;

                        let mut write = write;
                        tokio::spawn(async move {
                            let mut text_closed = false;
                            let mut binary_closed = false;

                            loop {
                                let next_message = tokio::select! {
                                    biased;
                                    message = text_rx.recv(), if !text_closed => match message {
                                        Some(message) => Some(message),
                                        None => {
                                            text_closed = true;
                                            None
                                        }
                                    },
                                    message = binary_rx.recv(), if !binary_closed => match message {
                                        Some(message) => Some(message),
                                        None => {
                                            binary_closed = true;
                                            None
                                        }
                                    },
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

                        let _ = myself.cast(AgentMsg::ConnectionEstablished);

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
                        let _ = myself.cast(AgentMsg::ConnectionFailed {
                            error: error.to_string(),
                        });
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
                let agent_ref_clone = myself.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = agent_ref_clone.cast(AgentMsg::Reconnect);
                });
            }

            AgentMsg::WebSocketMessage { text } => {
                if let (Some(tx_text), Some(tx_binary)) = (
                    state.ws_text_tx.as_ref().cloned(),
                    state.ws_binary_tx.as_ref().cloned(),
                ) {
                    self.handle_incoming_message(text, state, &tx_text, &tx_binary, myself.clone())
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
                Self::clear_active_uploads(&state.active_uploads).await;
                Self::clear_active_downloads(&state.active_downloads).await;
                let agent_ref_clone = myself.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = agent_ref_clone.cast(AgentMsg::Reconnect);
                });
            }

            AgentMsg::Reconnect => {
                log!(Level::Info, "Attempting to reconnect...");
                let _ = myself.cast(AgentMsg::Connect);
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

            AgentMsg::SendWebSocketBinary { bytes } => {
                if let Some(tx) = &state.ws_binary_tx {
                    if tx.send(WsMessage::Binary(bytes.into())).await.is_err() {
                        log!(
                            Level::Error,
                            "Failed to send binary message, connection may be lost"
                        );
                    }
                }
            }

            AgentMsg::WebSocketBinaryMessage { bytes } => {
                self.handle_upload_chunk(state, bytes).await?;
            }

            AgentMsg::Shutdown => {
                log!(
                    Level::Info,
                    "Shutting down agent: agent_id={}",
                    state.agent_id
                );
                state.ws_text_tx = None;
                state.ws_binary_tx = None;
                Self::clear_active_uploads(&state.active_uploads).await;
                Self::clear_active_downloads(&state.active_downloads).await;
                myself.stop(None);
            }

            AgentMsg::ExitWithError => {
                log!(Level::Error, "Exiting agent due to error");
                std::process::exit(1);
            }
        }

        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> std::result::Result<(), ActorProcessingErr> {
        log!(Level::Info, "Agent stopped: agent_id={}", state.agent_id);
        Ok(())
    }
}
