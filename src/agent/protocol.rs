use super::{
    ActiveDownloads, ActiveUploads, AgentActor, AgentCommandError, AgentHandle, AgentMsg,
    AgentState, DownloadSessionHandle, LogStreamSessionHandle, TerminalSessionHandle, logs,
    notification, raw::RawDownloadContext, terminal,
};
use redoor::{
    Level,
    commands::{Command, CommandErrorKind, CommandHandler, CommandResult},
    log, streaming,
    types::{AgentId, Message, RequestId},
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Executes one non-upload command and routes any streamed payload over the
/// binary websocket sender while keeping command responses on text.
async fn handle_command_message(
    write_text: mpsc::Sender<WsMessage>,
    write_binary: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    request_id: RequestId,
    command: Command,
    active_downloads: ActiveDownloads,
    file_search_cancel: Option<watch::Receiver<bool>>,
) {
    match command {
        Command::RawDownload {
            path,
            range_start,
            range_end,
        } => {
            let (cancel_sender, cancel_receiver) = watch::channel(false);
            active_downloads.insert(request_id, DownloadSessionHandle { cancel_sender });
            AgentActor
                .raw_download(
                    path,
                    range_start,
                    range_end,
                    RawDownloadContext {
                        request_id,
                        write: &write_binary,
                        cancel_receiver,
                        active_downloads: active_downloads.clone(),
                    },
                )
                .await;
        }
        Command::TarDownload { path } => {
            let (cancel_sender, cancel_receiver) = watch::channel(false);
            active_downloads.insert(request_id, DownloadSessionHandle { cancel_sender });
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
                .local_copy_file(
                    source_path,
                    dest_path,
                    super::transfers::copy::LocalCopyResponseContext {
                        write: &write_text,
                        agent_id: &agent_id,
                        request_id,
                    },
                )
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
                    super::transfers::copy::LocalCopyResponseContext {
                        write: &write_text,
                        agent_id: &agent_id,
                        request_id,
                    },
                )
                .await;
        }
        Command::OpenPath { path } => {
            let result = match notification::open_path(&path).await {
                Ok(()) => CommandResult::OpenPath,
                Err(message) => CommandResult::error(CommandErrorKind::Internal, message),
            };
            log!(
                Level::Info,
                "Command complete: agent_id={}, request_id={}, result={}",
                agent_id,
                request_id,
                result.summary()
            );
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        Command::RawDelete { path } => {
            let result = CommandHandler::new()
                .execute(Command::RawDelete { path })
                .await;
            log!(
                Level::Info,
                "Command complete: agent_id={}, request_id={}, result={}",
                agent_id,
                request_id,
                result.summary()
            );
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        Command::FileSearch { path, query } => {
            let result = match file_search_cancel {
                Some(cancel_receiver) => {
                    CommandHandler::new()
                        .execute_file_search(path, query, cancel_receiver)
                        .await
                }
                None => {
                    CommandHandler::new()
                        .execute(Command::FileSearch { path, query })
                        .await
                }
            };
            log!(
                Level::Info,
                "Command complete: agent_id={}, request_id={}, result={}",
                agent_id,
                request_id,
                result.summary()
            );
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        other => {
            let result = CommandHandler::new().execute(other).await;
            log!(
                Level::Info,
                "Command complete: agent_id={}, request_id={}, result={}",
                agent_id,
                request_id,
                result.summary()
            );
            let response = Message::CommandResponse {
                agent_id: agent_id.clone(),
                request_id,
                result,
            };

            if let Ok(json) = serde_json::to_string(&response) {
                let _ = write_text.send(WsMessage::text(json)).await;
            }
        }
    }
}

impl AgentActor {
    /// Dispatches one incoming control message while keeping payload work on the transfer sender.
    pub(crate) async fn handle_incoming_message(
        &self,
        text: String,
        state: &mut AgentState,
        write_text: &mpsc::Sender<WsMessage>,
        agent_ref: AgentHandle,
    ) {
        if let Ok(redoor_msg) = serde_json::from_str::<Message>(&text) {
            match redoor_msg {
                Message::TransferSocketOpen { token } => {
                    super::transfer::begin_transfer_connection(state, agent_ref, token);
                }
                Message::Command {
                    request_id,
                    command,
                    ..
                } => {
                    log!(
                        Level::Info,
                        "Command received: agent_id={}, request_id={}, command={}",
                        state.agent_id,
                        request_id,
                        command.summary()
                    );
                    let requires_transfer = matches!(
                        command,
                        Command::RawUpload { .. }
                            | Command::TarUpload { .. }
                            | Command::RawDownload { .. }
                            | Command::TarDownload { .. }
                    );
                    let file_search_cancel = if matches!(&command, Command::FileSearch { .. }) {
                        Some(state.begin_file_search())
                    } else {
                        None
                    };
                    let transfer_sender = state.ws_transfer_tx.as_ref().cloned();
                    if requires_transfer && transfer_sender.is_none() {
                        let result = CommandResult::error(
                            CommandErrorKind::Internal,
                            "Transfer connection unavailable",
                        );
                        log!(
                            Level::Info,
                            "Command complete: agent_id={}, request_id={}, result={}",
                            state.agent_id,
                            request_id,
                            result.summary()
                        );
                        self.send_command_response(write_text, &state.agent_id, request_id, result)
                            .await;
                        return;
                    }

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
                        let transfer_sender = match transfer_sender {
                            Some(sender) => sender,
                            None => write_text.clone(),
                        };
                        tokio::spawn(handle_command_message(
                            write_text.clone(),
                            transfer_sender,
                            state.agent_id.clone(),
                            request_id,
                            command,
                            state.active_downloads.clone(),
                            file_search_cancel,
                        ));
                    }
                }
                Message::CancelTransfer { request_id } => {
                    // The router uses the same cancel message for both transfer
                    // directions, so the agent checks downloads and uploads.
                    let download_handle = state.active_downloads.get(request_id);

                    let upload_handle = state.active_uploads.get(request_id);

                    if let Some(download_handle) = download_handle {
                        log!(
                            Level::Info,
                            "Received transfer cancel from server: request_id={}",
                            request_id
                        );
                        let _ = download_handle.cancel_sender.send(true);
                    } else if let Some(upload_handle) = upload_handle {
                        log!(
                            Level::Info,
                            "Received upload cancel from server: request_id={}",
                            request_id
                        );
                        let _ = upload_handle.cancel_sender.send(true);
                    } else {
                        log!(
                            Level::Warning,
                            "Received transfer cancel for unknown transfer: request_id={}",
                            request_id
                        );
                    }
                }
                Message::LogStreamOpen {
                    log_stream_id,
                    token,
                } => {
                    let (cancel_sender, cancel_receiver) = watch::channel(false);
                    if !state.active_log_streams.insert_if_absent(
                        log_stream_id.clone(),
                        LogStreamSessionHandle { cancel_sender },
                    ) {
                        log!(
                            Level::Warning,
                            "Rejected duplicate or excess log stream bootstrap: log_stream_id={}",
                            log_stream_id.0
                        );
                        return;
                    }

                    let server_url = state.server_url.clone();
                    tokio::spawn(async move {
                        if let Err(error) = logs::connect_and_run(
                            &server_url,
                            log_stream_id.clone(),
                            token,
                            cancel_receiver,
                        )
                        .await
                        {
                            log!(
                                Level::Warning,
                                "Log stream ended with an error: log_stream_id={}, error={}",
                                log_stream_id.0,
                                error
                            );
                        }
                        let _ = agent_ref
                            .send(AgentMsg::LogStreamFinished { log_stream_id })
                            .await;
                    });
                }
                Message::TerminalOpen {
                    terminal_id,
                    token,
                    size,
                    cwd,
                } => {
                    if size.validate().is_err() {
                        log!(
                            Level::Warning,
                            "Rejected terminal with invalid dimensions: terminal_id={}",
                            terminal_id.0
                        );
                        return;
                    }

                    let (cancel_sender, cancel_receiver) = watch::channel(false);
                    if !state.active_terminals.insert_if_absent(
                        terminal_id.clone(),
                        TerminalSessionHandle { cancel_sender },
                    ) {
                        log!(
                            Level::Warning,
                            "Rejected duplicate terminal bootstrap: terminal_id={}",
                            terminal_id.0
                        );
                        return;
                    }

                    let server_url = state.server_url.clone();
                    tokio::spawn(async move {
                        if let Err(error) = terminal::connect_and_run(
                            &server_url,
                            terminal_id.clone(),
                            token,
                            size,
                            cwd,
                            cancel_receiver,
                        )
                        .await
                        {
                            log!(
                                Level::Warning,
                                "Terminal session ended with an error: terminal_id={}, error={}",
                                terminal_id.0,
                                error
                            );
                        }
                        let _ = agent_ref
                            .send(AgentMsg::TerminalFinished { terminal_id })
                            .await;
                    });
                }
                Message::Error { message } => {
                    log!(Level::Error, "Server error: {}", message);
                    let _ = agent_ref.try_send(AgentMsg::ExitWithError);
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

    async fn start_upload_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        command: Command,
    ) -> bool {
        match command {
            Command::RawUpload { path } => {
                self.start_raw_upload_session(
                    active_uploads.clone(),
                    write,
                    agent_id,
                    request_id,
                    path,
                )
                .await;
                self.send_transfer_ready_if_started(&active_uploads, write, agent_id, request_id)
                    .await;
                true
            }
            Command::TarUpload { path } => {
                self.start_tar_upload_session(
                    active_uploads.clone(),
                    write,
                    agent_id,
                    request_id,
                    path,
                )
                .await;
                self.send_transfer_ready_if_started(&active_uploads, write, agent_id, request_id)
                    .await;
                true
            }
            _ => false,
        }
    }

    /// Acknowledges worker registration so the independent payload socket cannot race control setup.
    async fn send_transfer_ready_if_started(
        &self,
        active_uploads: &ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
    ) {
        if !active_uploads.contains(request_id) {
            return;
        }
        let message = Message::TransferReady {
            agent_id: agent_id.clone(),
            request_id,
        };
        if let Ok(json) = serde_json::to_string(&message) {
            let _ = write.send(WsMessage::text(json)).await;
        }
    }
}

/// Routes one payload frame directly to its bounded upload worker without entering the control mailbox.
pub(crate) async fn route_upload_chunk(
    active_uploads: ActiveUploads,
    control_sender: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    bytes: Vec<u8>,
) {
    let chunk = match streaming::StreamChunk::from_bytes(&bytes) {
        Ok(chunk) => chunk,
        Err(error) => {
            log!(
                Level::Warning,
                "Failed to parse binary stream chunk: {}",
                error
            );
            return;
        }
    };

    let request_id = chunk.request_id;
    let upload_handle = active_uploads.get(request_id);

    let Some(upload_handle) = upload_handle else {
        return;
    };

    if upload_handle.chunk_sender.send(chunk).await.is_err() {
        log!(
            Level::Warning,
            "Upload worker dropped before chunk delivery: request_id={}, path={}",
            request_id,
            upload_handle.path
        );
        active_uploads.remove(request_id);
        AgentActor
            .send_command_response(
                &control_sender,
                &agent_id,
                request_id,
                AgentCommandError::raw_upload(
                    CommandErrorKind::Internal,
                    "Upload worker is no longer available",
                )
                .into(),
            )
            .await;
    }
}
