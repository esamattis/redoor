use super::{
    ActiveDownloads, ActiveUploads, AgentActor, AgentCommandError, AgentMsg, AgentState,
    DownloadSessionHandle,
};
use ractor::{ActorProcessingErr, ActorRef};
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
                    request_id,
                    &write_binary,
                    cancel_receiver,
                    active_downloads.clone(),
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
                .local_copy_file(source_path, dest_path, request_id, &write_text, &agent_id)
                .await;
        }
        Command::LocalCopyDirectory {
            source_path,
            dest_path,
        } => {
            AgentActor
                .local_copy_directory(source_path, dest_path, request_id, &write_text, &agent_id)
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

impl AgentActor {
    /// Dispatches one incoming control message from the server and routes
    /// transfer-producing commands onto the binary websocket sender.
    pub(crate) async fn handle_incoming_message(
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
                        tokio::spawn(handle_command_message(
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
                self.start_raw_upload_session(active_uploads, write, agent_id, request_id, path)
                    .await;
                true
            }
            Command::TarUpload { path } => {
                self.start_tar_upload_session(active_uploads, write, agent_id, request_id, path)
                    .await;
                true
            }
            _ => false,
        }
    }

    pub(crate) async fn handle_upload_chunk(
        &self,
        state: &mut AgentState,
        bytes: Vec<u8>,
    ) -> std::result::Result<(), ActorProcessingErr> {
        let chunk = match streaming::StreamChunk::from_bytes(&bytes) {
            Ok(chunk) => chunk,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Failed to parse binary stream chunk: {}",
                    error
                );
                return Ok(());
            }
        };

        let request_id = chunk.request_id;
        let Some(tx) = state.ws_text_tx.as_ref().cloned() else {
            log!(
                Level::Warning,
                "Upload chunk received without active websocket sender: request_id={}",
                request_id
            );
            state.active_uploads.remove(request_id);
            return Ok(());
        };

        let upload_handle = state.active_uploads.get(request_id);

        let Some(upload_handle) = upload_handle else {
            return Ok(());
        };

        if upload_handle.chunk_sender.send(chunk).await.is_err() {
            log!(
                Level::Warning,
                "Upload worker dropped before chunk delivery: request_id={}, path={}",
                request_id,
                upload_handle.path
            );
            state.active_uploads.remove(request_id);
            self.send_command_response(
                &tx,
                &state.agent_id,
                request_id,
                AgentCommandError::raw_upload(
                    CommandErrorKind::Internal,
                    "Upload worker is no longer available",
                )
                .into(),
            )
            .await;
        }

        Ok(())
    }
}
