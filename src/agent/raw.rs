use super::{ActiveDownloads, ActiveUploads, AgentActor, UploadSessionHandle};
use anyhow::Result;
use redoor::{
    Level,
    commands::CommandResult,
    log,
    streaming::{self, StreamChunkFrameRequest, StreamPayloadKind},
    types::{AgentId, ChunkIndex, RequestId},
};
use std::path::{Path, PathBuf};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

struct RawUploadSession {
    path: String,
    temp_path: PathBuf,
    file: File,
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

    pub(crate) async fn send_framed_stream_bytes(
        write: &mpsc::Sender<WsMessage>,
        chunk_index: &mut ChunkIndex,
        request: StreamChunkFrameRequest<'_>,
    ) -> bool {
        let mut frames =
            streaming::StreamChunkFrames::new(request.starting_chunk_index(*chunk_index));

        while let Some(chunk) = frames.next() {
            let next_chunk_index = frames.next_chunk_index();
            if write
                .send(WsMessage::Binary(chunk.to_bytes().into()))
                .await
                .is_err()
            {
                *chunk_index = next_chunk_index;
                return false;
            }

            tokio::task::yield_now().await;
        }

        *chunk_index = frames.next_chunk_index();
        true
    }

    pub(crate) async fn start_raw_upload_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        path: String,
    ) {
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
            return;
        }

        let temp_path = Self::temp_upload_path(&path);
        match File::create(&temp_path).await {
            Ok(file) => {
                let (chunk_sender, chunk_receiver) = mpsc::channel::<streaming::StreamChunk>(8);
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

    /// Streams file contents to the server as reframed websocket binary chunks.
    pub(crate) async fn raw_download(
        &self,
        path: String,
        range_start: Option<u64>,
        range_end: Option<u64>,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        cancel_receiver: watch::Receiver<bool>,
        active_downloads: ActiveDownloads,
    ) {
        let mut cancel_receiver = cancel_receiver;
        let cancel_message = b"Download canceled by server";
        match File::open(&path).await {
            Ok(mut file) => {
                let mut chunk_index = ChunkIndex(0);
                let chunk_size = streaming::CHUNK_SIZE;
                let mut buffer = vec![0u8; chunk_size];
                let mut bytes_remaining: Option<u64> = None;
                let mut pending_chunk: Option<Vec<u8>> = None;

                if let Some(start) = range_start {
                    if let Err(error) = file.seek(std::io::SeekFrom::Start(start)).await {
                        log!(Level::Error, "Failed to seek file: {}", error);
                        let error_msg = format!("Failed to seek file: {}", error);
                        let _ = Self::send_framed_stream_bytes(
                            write,
                            &mut chunk_index,
                            StreamChunkFrameRequest::new(request_id, error_msg.as_bytes())
                                .is_error(true),
                        )
                        .await;
                        return;
                    }

                    if let Some(end) = range_end {
                        bytes_remaining = Some(end.saturating_sub(start));
                    }
                }

                loop {
                    let read_size = match bytes_remaining {
                        Some(remaining) => {
                            if remaining == 0 {
                                break;
                            }
                            std::cmp::min(chunk_size, remaining as usize)
                        }
                        None => chunk_size,
                    };

                    if read_size != buffer.len() {
                        buffer.resize(read_size, 0);
                    }

                    match tokio::select! {
                        changed = cancel_receiver.changed() => {
                            match changed {
                                Ok(()) if *cancel_receiver.borrow() => {
                                    log!(
                                        Level::Info,
                                        "Stopping raw download after cancel: request_id={}, path={}",
                                        request_id,
                                        path
                                    );
                                    let _ = Self::send_framed_stream_bytes(
                                        write,
                                        &mut chunk_index,
                                        StreamChunkFrameRequest::new(request_id, cancel_message)
                                            .is_error(true),
                                    )
                                    .await;
                                    Self::remove_active_download(&active_downloads, request_id).await;
                                    return;
                                }
                                Ok(()) => continue,
                                Err(_) => {
                                    Self::remove_active_download(&active_downloads, request_id).await;
                                    return;
                                }
                            }
                        }
                        read_result = file.read(&mut buffer) => read_result,
                    } {
                        Ok(0) => break,
                        Ok(bytes_read) => {
                            if let Some(ref mut remaining) = bytes_remaining {
                                *remaining = remaining.saturating_sub(bytes_read as u64);
                            }

                            if let Some(data) = pending_chunk.replace(buffer[..bytes_read].to_vec())
                            {
                                if !Self::send_framed_stream_bytes(
                                    write,
                                    &mut chunk_index,
                                    StreamChunkFrameRequest::new(request_id, &data).is_last(false),
                                )
                                .await
                                {
                                    log!(
                                        Level::Warning,
                                        "WebSocket channel full or closed, aborting download"
                                    );
                                    Self::remove_active_download(&active_downloads, request_id)
                                        .await;
                                    return;
                                }
                            }
                        }
                        Err(error) => {
                            log!(Level::Error, "Failed to read file: {}", error);
                            let error_msg = format!("Failed to read file: {}", error);
                            let _ = Self::send_framed_stream_bytes(
                                write,
                                &mut chunk_index,
                                StreamChunkFrameRequest::new(request_id, error_msg.as_bytes())
                                    .is_error(true),
                            )
                            .await;
                            Self::remove_active_download(&active_downloads, request_id).await;
                            return;
                        }
                    }
                }

                let final_chunk = pending_chunk.unwrap_or_default();
                let _ = Self::send_framed_stream_bytes(
                    write,
                    &mut chunk_index,
                    StreamChunkFrameRequest::new(request_id, &final_chunk),
                )
                .await;

                log!(
                    Level::Info,
                    "Raw download complete: path={}, chunks={}",
                    path,
                    chunk_index.display_number()
                );
                Self::remove_active_download(&active_downloads, request_id).await;
            }
            Err(error) => {
                log!(Level::Error, "Failed to open file: {}", error);
                let error_msg = format!("Failed to open file: {}", error);
                let mut chunk_index = ChunkIndex::new(0);
                let _ = Self::send_framed_stream_bytes(
                    write,
                    &mut chunk_index,
                    StreamChunkFrameRequest::new(request_id, error_msg.as_bytes()).is_error(true),
                )
                .await;
                Self::remove_active_download(&active_downloads, request_id).await;
            }
        }
    }
}
