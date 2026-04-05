use super::{ActiveUploads, AgentActor, AgentState, UploadSessionHandle};
use anyhow::{Context, Result, anyhow, bail};
use ractor::ActorProcessingErr;
use redoor::{
    Level,
    commands::{Command, CommandResult},
    log,
    streaming::{self, StreamPayloadKind},
    types::{AgentId, RequestId},
};
use std::{
    path::{Component, Path, PathBuf},
    sync::mpsc as std_mpsc,
};
use tokio::{
    fs::File,
    io::AsyncWriteExt,
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

struct RawUploadSession {
    path: String,
    temp_path: PathBuf,
    file: File,
    bytes_written: u64,
}

/// Streams tar bytes into a blocking unpack worker that extracts into a temp directory.
struct TarUploadSession {
    path: String,
    temp_path: PathBuf,
    chunk_sender: std_mpsc::SyncSender<Vec<u8>>,
    completion_receiver: oneshot::Receiver<Result<()>>,
    bytes_written: u64,
}

impl AgentActor {
    async fn remove_upload_temp_file(temp_path: &Path) {
        if let Err(error) = tokio::fs::remove_file(temp_path).await {
            log!(
                Level::Warning,
                "Failed to remove upload temp file: path={}, error={}",
                temp_path.display(),
                error
            );
        }
    }

    async fn remove_upload_temp_directory(temp_path: &Path) {
        if let Err(error) = tokio::fs::remove_dir_all(temp_path).await {
            log!(
                Level::Warning,
                "Failed to remove upload temp directory: path={}, error={}",
                temp_path.display(),
                error
            );
        }
    }

    fn temp_upload_path(path: &str) -> PathBuf {
        let destination = Path::new(path);
        let file_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload");
        let temp_name = format!(".{}.redoor-upload-{}", file_name, fastrand::u64(..));

        match destination.parent() {
            Some(parent) => parent.join(temp_name),
            None => PathBuf::from(format!("./{}", temp_name)),
        }
    }

    fn temp_upload_dir_path(path: &str) -> PathBuf {
        let destination = Path::new(path);
        let file_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload-dir");
        let temp_name = format!(".{}.redoor-upload-dir-{}", file_name, fastrand::u64(..));

        match destination.parent() {
            Some(parent) => parent.join(temp_name),
            None => PathBuf::from(format!("./{}", temp_name)),
        }
    }

    fn sanitize_tar_entry_path(entry_path: &Path) -> Result<PathBuf> {
        let mut sanitized = PathBuf::new();

        for component in entry_path.components() {
            match component {
                Component::Normal(part) => sanitized.push(part),
                Component::CurDir => {}
                Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                    bail!(
                        "Tar entry path escapes destination: {}",
                        entry_path.display()
                    );
                }
            }
        }

        if sanitized.as_os_str().is_empty() {
            bail!("Tar entry path cannot be empty");
        }

        Ok(sanitized)
    }

    async fn create_tar_upload_session(path: String) -> Result<TarUploadSession> {
        let destination = PathBuf::from(&path);
        let parent = destination
            .parent()
            .with_context(|| format!("Destination parent not found for {}", path))?
            .to_path_buf();

        let parent_metadata = tokio::fs::metadata(&parent).await.with_context(|| {
            format!("Failed to access destination parent: {}", parent.display())
        })?;
        if !parent_metadata.is_dir() {
            bail!(
                "Destination parent is not a directory: {}",
                parent.display()
            );
        }

        if tokio::fs::try_exists(&destination).await.with_context(|| {
            format!(
                "Failed to check destination path: {}",
                destination.display()
            )
        })? {
            bail!("Destination already exists: {}", destination.display());
        }

        let temp_path = Self::temp_upload_dir_path(&path);
        tokio::fs::create_dir(&temp_path)
            .await
            .with_context(|| format!("Failed to create temp directory: {}", temp_path.display()))?;

        let (chunk_sender, chunk_receiver) = std_mpsc::sync_channel::<Vec<u8>>(8);
        let (completion_sender, completion_receiver) = oneshot::channel::<Result<()>>();
        let temp_path_for_worker = temp_path.clone();

        tokio::task::spawn_blocking(move || {
            let unpack_result =
                Self::unpack_tar_stream_into_directory(chunk_receiver, &temp_path_for_worker);
            let _ = completion_sender.send(unpack_result);
        });

        Ok(TarUploadSession {
            path,
            temp_path,
            chunk_sender,
            completion_receiver,
            bytes_written: 0,
        })
    }

    fn unpack_tar_stream_into_directory(
        chunk_receiver: std_mpsc::Receiver<Vec<u8>>,
        destination_root: &Path,
    ) -> Result<()> {
        struct ChannelTarReader {
            chunk_receiver: std_mpsc::Receiver<Vec<u8>>,
            current_chunk: Vec<u8>,
            offset: usize,
            finished: bool,
        }

        impl std::io::Read for ChannelTarReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if buf.is_empty() {
                    return Ok(0);
                }

                loop {
                    if self.offset < self.current_chunk.len() {
                        let remaining = self.current_chunk.len() - self.offset;
                        let bytes_to_copy = remaining.min(buf.len());
                        buf[..bytes_to_copy].copy_from_slice(
                            &self.current_chunk[self.offset..self.offset + bytes_to_copy],
                        );
                        self.offset += bytes_to_copy;
                        return Ok(bytes_to_copy);
                    }

                    if self.finished {
                        return Ok(0);
                    }

                    match self.chunk_receiver.recv() {
                        Ok(chunk) => {
                            self.current_chunk = chunk;
                            self.offset = 0;
                        }
                        Err(_) => {
                            self.finished = true;
                            return Ok(0);
                        }
                    }
                }
            }
        }

        let reader = ChannelTarReader {
            chunk_receiver,
            current_chunk: Vec::new(),
            offset: 0,
            finished: false,
        };
        let mut archive = tar::Archive::new(reader);
        let entries = archive.entries().context("Failed to read tar entries")?;

        for entry_result in entries {
            let mut entry = entry_result.context("Failed to read tar entry")?;

            let entry_type = entry.header().entry_type();
            if !(entry_type.is_dir() || entry_type.is_file()) {
                bail!("Unsupported tar entry type: {:?}", entry_type);
            }

            let entry_path = entry.path().context("Failed to read tar entry path")?;
            let sanitized_path = Self::sanitize_tar_entry_path(&entry_path)?;
            let output_path = destination_root.join(&sanitized_path);

            if let Some(parent) = output_path.parent() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!(
                        "Failed to create destination directory: {}",
                        parent.display()
                    )
                })?;
            }

            if entry_type.is_dir() {
                std::fs::create_dir_all(&output_path).with_context(|| {
                    format!(
                        "Failed to create destination directory: {}",
                        output_path.display()
                    )
                })?;
                continue;
            }

            entry.unpack(&output_path).with_context(|| {
                format!("Failed to unpack tar entry to {}", output_path.display())
            })?;
        }

        Ok(())
    }

    async fn finalize_tar_upload(
        &self,
        session: TarUploadSession,
        tx: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
    ) {
        let final_path = session.path.clone();
        let temp_path = session.temp_path.clone();
        let bytes_written = session.bytes_written;

        drop(session.chunk_sender);

        let unpack_result = match session.completion_receiver.await {
            Ok(result) => result,
            Err(error) => Err(anyhow!("Tar extraction worker failed: {}", error)),
        };

        match unpack_result {
            Ok(()) => {
                if let Err(error) = tokio::fs::rename(&temp_path, &final_path).await {
                    let error_message = format!("Failed to finalize uploaded directory: {}", error);
                    let _ = tokio::fs::remove_dir_all(&temp_path).await;

                    self.send_command_response(
                        tx,
                        agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                    return;
                }

                log!(
                    Level::Info,
                    "Tar upload complete: request_id={}, path={}, bytes_written={}",
                    request_id,
                    final_path,
                    bytes_written
                );

                self.send_command_response(tx, agent_id, request_id, CommandResult::TarUpload)
                    .await;
            }
            Err(error_message) => {
                let _ = tokio::fs::remove_dir_all(&temp_path).await;
                self.send_command_response(
                    tx,
                    agent_id,
                    request_id,
                    CommandResult::Error {
                        message: error_message.to_string(),
                    },
                )
                .await;
            }
        }
    }

    async fn process_raw_upload(
        active_uploads: ActiveUploads,
        mut chunk_receiver: mpsc::Receiver<streaming::StreamChunk>,
        mut session: RawUploadSession,
        tx: mpsc::Sender<WsMessage>,
        agent_id: AgentId,
        request_id: RequestId,
    ) {
        while let Some(chunk) = chunk_receiver.recv().await {
            if chunk.payload_kind != StreamPayloadKind::RawFile {
                let error_message = format!(
                    "Upload payload kind mismatch: expected {:?}, got {:?}",
                    StreamPayloadKind::RawFile,
                    chunk.payload_kind
                );
                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                Self::remove_upload_temp_file(&session.temp_path).await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            if chunk.is_error {
                let error_message = if chunk.data.is_empty() {
                    "Upload aborted by server".to_string()
                } else {
                    String::from_utf8_lossy(&chunk.data).to_string()
                };

                log!(
                    Level::Warning,
                    "Upload aborted: request_id={}, path={}, error={}",
                    request_id,
                    session.path,
                    error_message
                );

                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                Self::remove_upload_temp_file(&session.temp_path).await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            if let Err(error) = session.file.write_all(&chunk.data).await {
                let error_message = format!("Failed to write upload chunk: {}", error);
                log!(
                    Level::Error,
                    "Upload write failed: request_id={}, path={}, error={}",
                    request_id,
                    session.path,
                    error_message
                );

                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                Self::remove_upload_temp_file(&session.temp_path).await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            session.bytes_written += chunk.data.len() as u64;

            if !chunk.is_last {
                continue;
            }

            if let Err(error) = session.file.flush().await {
                let error_message = format!("Failed to flush uploaded file: {}", error);
                log!(
                    Level::Error,
                    "Upload flush failed: request_id={}, path={}, error={}",
                    request_id,
                    session.path,
                    error_message
                );

                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                Self::remove_upload_temp_file(&session.temp_path).await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            let final_path = session.path.clone();
            let temp_path = session.temp_path.clone();
            let bytes_written = session.bytes_written;
            drop(session.file);

            if let Err(error) = tokio::fs::rename(&temp_path, &final_path).await {
                let error_message = format!("Failed to finalize uploaded file: {}", error);
                log!(
                    Level::Error,
                    "Upload rename failed: request_id={}, path={}, temp_path={}, error={}",
                    request_id,
                    final_path,
                    temp_path.display(),
                    error_message
                );

                Self::remove_upload_temp_file(&temp_path).await;
                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            log!(
                Level::Info,
                "Raw upload complete: request_id={}, path={}, bytes_written={}",
                request_id,
                final_path,
                bytes_written
            );

            AgentActor
                .send_command_response(&tx, &agent_id, request_id, CommandResult::RawUpload)
                .await;
            Self::remove_active_upload(&active_uploads, request_id).await;
            return;
        }

        let error_message = "Upload stream ended before completion".to_string();
        AgentActor
            .send_command_response(
                &tx,
                &agent_id,
                request_id,
                CommandResult::Error {
                    message: error_message,
                },
            )
            .await;
        Self::remove_upload_temp_file(&session.temp_path).await;
        Self::remove_active_upload(&active_uploads, request_id).await;
    }

    async fn process_tar_upload(
        active_uploads: ActiveUploads,
        mut chunk_receiver: mpsc::Receiver<streaming::StreamChunk>,
        mut session: TarUploadSession,
        tx: mpsc::Sender<WsMessage>,
        agent_id: AgentId,
        request_id: RequestId,
    ) {
        while let Some(chunk) = chunk_receiver.recv().await {
            if chunk.payload_kind != StreamPayloadKind::Tar {
                let error_message = format!(
                    "Upload payload kind mismatch: expected {:?}, got {:?}",
                    StreamPayloadKind::Tar,
                    chunk.payload_kind
                );
                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                drop(session.chunk_sender);
                Self::remove_upload_temp_directory(&session.temp_path).await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            if chunk.is_error {
                let error_message = if chunk.data.is_empty() {
                    "Upload aborted by server".to_string()
                } else {
                    String::from_utf8_lossy(&chunk.data).to_string()
                };

                log!(
                    Level::Warning,
                    "Upload aborted: request_id={}, path={}, error={}",
                    request_id,
                    session.path,
                    error_message
                );

                AgentActor
                    .send_command_response(
                        &tx,
                        &agent_id,
                        request_id,
                        CommandResult::Error {
                            message: error_message,
                        },
                    )
                    .await;
                drop(session.chunk_sender);
                Self::remove_upload_temp_directory(&session.temp_path).await;
                Self::remove_active_upload(&active_uploads, request_id).await;
                return;
            }

            if !chunk.data.is_empty() {
                if let Err(error) = session.chunk_sender.send(chunk.data.clone()) {
                    let error_message =
                        format!("Failed to forward tar upload chunk to unpacker: {}", error);
                    AgentActor
                        .send_command_response(
                            &tx,
                            &agent_id,
                            request_id,
                            CommandResult::Error {
                                message: error_message,
                            },
                        )
                        .await;
                    drop(session.chunk_sender);
                    Self::remove_upload_temp_directory(&session.temp_path).await;
                    Self::remove_active_upload(&active_uploads, request_id).await;
                    return;
                }
                session.bytes_written += chunk.data.len() as u64;
            }

            if !chunk.is_last {
                continue;
            }

            AgentActor
                .finalize_tar_upload(session, &tx, &agent_id, request_id)
                .await;
            Self::remove_active_upload(&active_uploads, request_id).await;
            return;
        }

        drop(session.chunk_sender);
        AgentActor
            .send_command_response(
                &tx,
                &agent_id,
                request_id,
                CommandResult::Error {
                    message: "Upload stream ended before completion".to_string(),
                },
            )
            .await;
        Self::remove_upload_temp_directory(&session.temp_path).await;
        Self::remove_active_upload(&active_uploads, request_id).await;
    }

    pub(crate) async fn start_upload_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        command: Command,
    ) -> bool {
        match command {
            Command::RawUpload { path } => {
                let upload_already_exists = active_uploads
                    .lock()
                    .expect("active uploads mutex poisoned")
                    .contains_key(&request_id);

                if upload_already_exists {
                    self.send_command_response(
                        write,
                        agent_id,
                        request_id,
                        CommandResult::Error {
                            message: format!(
                                "Upload session already exists for request_id={}",
                                request_id
                            ),
                        },
                    )
                    .await;
                    return true;
                }

                let temp_path = Self::temp_upload_path(&path);
                match File::create(&temp_path).await {
                    Ok(file) => {
                        let (chunk_sender, chunk_receiver) =
                            mpsc::channel::<streaming::StreamChunk>(8);
                        log!(
                            Level::Info,
                            "Started raw upload: request_id={}, path={}, temp_path={}",
                            request_id,
                            path,
                            temp_path.display()
                        );
                        active_uploads
                            .lock()
                            .expect("active uploads mutex poisoned")
                            .insert(
                                request_id,
                                UploadSessionHandle {
                                    path: path.clone(),
                                    chunk_sender,
                                },
                            );
                        tokio::spawn(Self::process_raw_upload(
                            active_uploads,
                            chunk_receiver,
                            RawUploadSession {
                                path,
                                temp_path,
                                file,
                                bytes_written: 0,
                            },
                            write.clone(),
                            agent_id.clone(),
                            request_id,
                        ));
                    }
                    Err(error) => {
                        self.send_command_response(
                            write,
                            agent_id,
                            request_id,
                            CommandResult::Error {
                                message: format!("Failed to create file: {}", error),
                            },
                        )
                        .await;
                    }
                }
                true
            }
            Command::TarUpload { path } => {
                let upload_already_exists = active_uploads
                    .lock()
                    .expect("active uploads mutex poisoned")
                    .contains_key(&request_id);

                if upload_already_exists {
                    self.send_command_response(
                        write,
                        agent_id,
                        request_id,
                        CommandResult::Error {
                            message: format!(
                                "Upload session already exists for request_id={}",
                                request_id
                            ),
                        },
                    )
                    .await;
                    return true;
                }

                match Self::create_tar_upload_session(path.clone()).await {
                    Ok(session) => {
                        let (chunk_sender, chunk_receiver) =
                            mpsc::channel::<streaming::StreamChunk>(8);
                        log!(
                            Level::Info,
                            "Started tar upload: request_id={}, path={}, temp_path={}",
                            request_id,
                            path,
                            session.temp_path.display()
                        );
                        active_uploads
                            .lock()
                            .expect("active uploads mutex poisoned")
                            .insert(
                                request_id,
                                UploadSessionHandle {
                                    path: path.clone(),
                                    chunk_sender,
                                },
                            );
                        tokio::spawn(Self::process_tar_upload(
                            active_uploads,
                            chunk_receiver,
                            session,
                            write.clone(),
                            agent_id.clone(),
                            request_id,
                        ));
                    }
                    Err(error) => {
                        self.send_command_response(
                            write,
                            agent_id,
                            request_id,
                            CommandResult::Error {
                                message: error.to_string(),
                            },
                        )
                        .await;
                    }
                }
                true
            }
            _ => false,
        }
    }

    pub(crate) async fn handle_upload_chunk(
        &self,
        state: &mut AgentState,
        bytes: Vec<u8>,
    ) -> Result<(), ActorProcessingErr> {
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
            Self::remove_active_upload(&state.active_uploads, request_id).await;
            return Ok(());
        };

        let upload_handle = {
            state
                .active_uploads
                .lock()
                .expect("active uploads mutex poisoned")
                .get(&request_id)
                .cloned()
        };

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
            Self::remove_active_upload(&state.active_uploads, request_id).await;
            self.send_command_response(
                &tx,
                &state.agent_id,
                request_id,
                CommandResult::Error {
                    message: "Upload worker is no longer available".to_string(),
                },
            )
            .await;
        }

        Ok(())
    }
}
