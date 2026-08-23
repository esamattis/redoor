use super::{
    ActiveDownloads, ActiveUploads, AgentActor, AgentCommandError, AgentHandle, AgentMsg,
    AgentState, DownloadSessionHandle, LogStreamSessionHandle, TerminalSessionHandle, logs,
    raw::RawDownloadContext, terminal,
};
use redoor::{
    Level,
    commands::{Command, CommandErrorKind, CommandHandler, CommandResult},
    log, streaming,
    types::{AgentId, Message, RequestId},
};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Caps independently executing non-upload commands for one control generation.
const MAX_CONCURRENT_COMMANDS: usize = 32;

/// Reaps completed workers and reports whether another bounded command can start.
fn command_task_capacity_available(command_tasks: &mut JoinSet<()>, is_upload: bool) -> bool {
    while let Some(result) = command_tasks.try_join_next() {
        if let Err(error) = result {
            log!(Level::Warning, "Agent command task failed: {error}");
        }
    }
    is_upload || command_tasks.len() < MAX_CONCURRENT_COMMANDS
}

/// Bundles one command's owned connection resources so task spawning stays explicit.
struct CommandMessageContext {
    /// Prioritized control lane used for command responses and progress updates.
    write_text: mpsc::Sender<WsMessage>,
    /// Transfer lane used for potentially large streamed payload frames.
    write_binary: mpsc::Sender<WsMessage>,
    /// Stable identity included in every response routed back to the server.
    agent_id: AgentId,
    /// Shared download registry used by streaming command variants.
    active_downloads: ActiveDownloads,
    /// Dedicated traversal cancellation retained for the file-search command.
    file_search_cancel: Option<watch::Receiver<bool>>,
    /// Control-generation cancellation used by temp-owning local operations.
    command_cancel: Option<watch::Receiver<bool>>,
    /// Immutable platform trash service resolved at process startup.
    trash: super::trash::TrashService,
}

/// Executes one owned command task with the connection resources it may use.
async fn handle_command_message(
    request_id: RequestId,
    command: Command,
    context: CommandMessageContext,
) {
    let CommandMessageContext {
        write_text,
        write_binary,
        agent_id,
        active_downloads,
        file_search_cancel,
        command_cancel,
        trash,
    } = context;
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
        Command::TarDownload { path, include_root } => {
            let (cancel_sender, cancel_receiver) = watch::channel(false);
            active_downloads.insert(request_id, DownloadSessionHandle { cancel_sender });
            AgentActor
                .tar_download(
                    path,
                    include_root,
                    super::transfers::download::TarDownloadContext {
                        request_id,
                        write: &write_binary,
                        write_text: &write_text,
                        agent_id: &agent_id,
                        cancel_receiver,
                        active_downloads: active_downloads.clone(),
                    },
                )
                .await;
        }
        Command::LocalCopyFile {
            source_path,
            dest_path,
            on_existing,
        } => {
            let command_cancel =
                command_cancel.expect("local copy commands always receive generation cancellation");
            AgentActor
                .local_copy_file(
                    source_path,
                    dest_path,
                    on_existing,
                    super::transfers::copy::LocalCopyResponseContext {
                        write: &write_text,
                        agent_id: &agent_id,
                        request_id,
                        cancel: command_cancel,
                    },
                )
                .await;
        }
        Command::LocalCopyDirectory {
            source_path,
            dest_path,
            on_existing,
        } => {
            let command_cancel =
                command_cancel.expect("local copy commands always receive generation cancellation");
            AgentActor
                .local_copy_directory(
                    source_path,
                    dest_path,
                    on_existing,
                    super::transfers::copy::LocalCopyResponseContext {
                        write: &write_text,
                        agent_id: &agent_id,
                        request_id,
                        cancel: command_cancel,
                    },
                )
                .await;
        }
        Command::LocalMove {
            source_path,
            dest_path,
            source_is_directory,
            expected_identity,
            on_existing,
        } => {
            let command_cancel =
                command_cancel.expect("local move commands always receive generation cancellation");
            AgentActor
                .local_move(
                    source_path,
                    dest_path,
                    source_is_directory,
                    expected_identity,
                    on_existing,
                    super::transfers::copy::LocalCopyResponseContext {
                        write: &write_text,
                        agent_id: &agent_id,
                        request_id,
                        cancel: command_cancel,
                    },
                )
                .await;
        }
        Command::OpenPath { path } => {
            let result = match crate::desktop::open_with_desktop(&path).await {
                Ok(()) => CommandResult::OpenPath,
                Err(message) => {
                    // Agent-facing wording: operators care that this host cannot open paths, not the launcher probe.
                    let message = if message.contains("No graphical desktop") {
                        "Agent does not have access to a graphical desktop".to_string()
                    } else {
                        message
                    };
                    CommandResult::error(CommandErrorKind::Internal, message)
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
        Command::Trash { path } => {
            let result = match trash.trash(std::path::PathBuf::from(path)).await {
                Ok(()) => CommandResult::Trash,
                Err(error) => CommandResult::error(error.kind.clone(), error.to_string()),
            };
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        Command::ListTrash => {
            let result = match trash.list().await {
                Ok(list) => CommandResult::TrashList(list),
                Err(error) => CommandResult::error(error.kind.clone(), error.to_string()),
            };
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        Command::EmptyTrash => {
            let result = match trash.empty().await {
                Ok(deleted_items) => CommandResult::EmptyTrash { deleted_items },
                Err(error) => CommandResult::error(error.kind.clone(), error.to_string()),
            };
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        Command::RestoreTrash {
            location_id,
            item_id,
            destination_path,
        } => {
            let result = match trash
                .restore(
                    &location_id,
                    &item_id,
                    std::path::PathBuf::from(destination_path),
                )
                .await
            {
                Ok(path) => match path.into_os_string().into_string() {
                    Ok(path) => CommandResult::RestoreTrash { path },
                    Err(_) => CommandResult::error(
                        CommandErrorKind::InvalidInput,
                        "Restored path is not valid UTF-8",
                    ),
                },
                Err(error) => CommandResult::error(error.kind.clone(), error.to_string()),
            };
            AgentActor
                .send_command_response(&write_text, &agent_id, request_id, result)
                .await;
        }
        Command::DeleteMoveSource {
            path,
            expected_identity,
        } => {
            let result = CommandHandler::new()
                .execute(Command::DeleteMoveSource {
                    path,
                    expected_identity,
                })
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
        Command::FileSearch {
            path,
            query,
            timeout_seconds,
            include_hidden,
            respect_gitignore,
        } => {
            let result = match file_search_cancel {
                Some(cancel_receiver) => {
                    CommandHandler::new()
                        .execute_file_search(
                            path,
                            query,
                            timeout_seconds,
                            include_hidden,
                            respect_gitignore,
                            cancel_receiver,
                        )
                        .await
                }
                None => {
                    CommandHandler::new()
                        .execute(Command::FileSearch {
                            path,
                            query,
                            timeout_seconds,
                            include_hidden,
                            respect_gitignore,
                        })
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
        command_tasks: &mut JoinSet<()>,
        command_cancel: watch::Receiver<bool>,
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
                    let is_upload = matches!(
                        command,
                        Command::RawUpload { .. } | Command::TarUpload { .. }
                    );
                    let requires_transfer = matches!(
                        command,
                        Command::RawUpload { .. }
                            | Command::TarUpload { .. }
                            | Command::RawDownload { .. }
                            | Command::TarDownload { .. }
                    );
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

                    if !command_task_capacity_available(command_tasks, is_upload) {
                        let result = CommandResult::error(
                            CommandErrorKind::ServiceUnavailable,
                            "Agent command execution limit reached",
                        );
                        self.send_command_response(write_text, &state.agent_id, request_id, result)
                            .await;
                        return;
                    }
                    let file_search_cancel = if matches!(&command, Command::FileSearch { .. }) {
                        Some(state.begin_file_search())
                    } else {
                        None
                    };

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
                        let write_text = write_text.clone();
                        let agent_id = state.agent_id.clone();
                        let active_downloads = state.active_downloads.clone();
                        let trash = state.trash.clone();
                        command_tasks.spawn(async move {
                            let handles_cancellation = matches!(
                                command,
                                Command::LocalCopyFile { .. }
                                    | Command::LocalCopyDirectory { .. }
                                    | Command::LocalMove { .. }
                                    | Command::Trash { .. }
                                    | Command::EmptyTrash
                                    | Command::RestoreTrash { .. }
                            );
                            if handles_cancellation {
                                handle_command_message(
                                    request_id,
                                    command,
                                    CommandMessageContext {
                                        write_text,
                                        write_binary: transfer_sender,
                                        agent_id,
                                        active_downloads,
                                        file_search_cancel,
                                        command_cancel: Some(command_cancel),
                                        trash,
                                    },
                                )
                                .await;
                            } else {
                                let mut command_cancel = command_cancel;
                                tokio::select! {
                                    _ = handle_command_message(
                                        request_id,
                                        command,
                                        CommandMessageContext {
                                            write_text,
                                            write_binary: transfer_sender,
                                            agent_id,
                                            active_downloads,
                                            file_search_cancel,
                                            command_cancel: None,
                                            trash,
                                        },
                                    ) => {}
                                    _ = command_cancel.changed() => {}
                                }
                            }
                        });
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

                    let connection = state.connection.clone();
                    tokio::spawn(async move {
                        if let Err(error) = logs::connect_and_run(
                            &connection,
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

                    let connection = state.connection.clone();
                    tokio::spawn(async move {
                        if let Err(error) = terminal::connect_and_run(
                            &connection,
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
            Command::RawUpload { path, on_existing } => {
                self.start_raw_upload_session(
                    active_uploads.clone(),
                    write,
                    agent_id,
                    request_id,
                    path,
                    on_existing,
                )
                .await;
                self.send_transfer_ready_if_started(&active_uploads, write, agent_id, request_id)
                    .await;
                true
            }
            Command::TarUpload { path, on_existing } => {
                self.start_tar_upload_session(
                    active_uploads.clone(),
                    write,
                    agent_id,
                    request_id,
                    path,
                    on_existing,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies stalled command workers cannot create an unbounded task set.
    #[tokio::test]
    async fn non_upload_command_admission_is_bounded() {
        let mut command_tasks = JoinSet::new();
        for _ in 0..MAX_CONCURRENT_COMMANDS {
            command_tasks.spawn(std::future::pending());
        }

        // A full set must reject ordinary commands without waiting and blocking cancel handling.
        assert!(!command_task_capacity_available(&mut command_tasks, false));
        // Upload setup is managed by its bounded transfer worker path rather than this task set.
        assert!(command_task_capacity_available(&mut command_tasks, true));

        command_tasks.abort_all();
        while command_tasks.join_next().await.is_some() {}
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
