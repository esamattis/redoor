use super::{ActiveDownloads, ActiveUploads, AgentActor, UploadSessionHandle};
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

/// Outcome of waiting for either the next raw upload chunk or a cancel signal.
enum RawUploadEvent {
    Chunk(Option<streaming::StreamChunk>),
    Continue,
    Cancel,
    Exit,
}

/// Outcome of waiting for either the next file read or a cancel signal.
enum RawDownloadEvent {
    Read(std::io::Result<usize>),
    Continue,
    Cancel,
    Exit,
}

/// Owns the state and side effects for one in-progress raw file upload.
struct RawUploadWorker {
    active_uploads: ActiveUploads,
    chunk_receiver: mpsc::Receiver<streaming::StreamChunk>,
    cancel_receiver: watch::Receiver<bool>,
    session: RawUploadSession,
    tx: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    request_id: RequestId,
}

impl RawUploadWorker {
    /// Waits for the cooperative cancel signal used by upload workers.
    async fn wait_for_cancel(cancel_receiver: &mut watch::Receiver<bool>) -> RawUploadEvent {
        match cancel_receiver.changed().await {
            Ok(()) if *cancel_receiver.borrow() => RawUploadEvent::Cancel,
            Ok(()) => RawUploadEvent::Continue,
            Err(_) => RawUploadEvent::Exit,
        }
    }

    /// Sends an error command response for this upload request.
    async fn send_error_response(&self, message: String) {
        AgentActor
            .send_command_response(
                &self.tx,
                &self.agent_id,
                self.request_id,
                CommandResult::Error { message },
            )
            .await;
    }

    /// Removes the temporary file and unregisters the upload worker.
    async fn cleanup(&self) {
        AgentActor::remove_upload_temp_file(&self.session.temp_path).await;
        self.active_uploads.remove(self.request_id);
    }

    /// Handles an explicit server-side cancellation request.
    async fn cancel(self) {
        log!(
            Level::Info,
            "Stopping raw upload after cancel: request_id={}, path={}",
            self.request_id,
            self.session.path
        );
        self.send_error_response("Upload canceled by server".to_string())
            .await;
        self.cleanup().await;
    }

    /// Handles worker shutdown after the upload registry has been torn down.
    async fn shutdown(self) {
        // If the cancel sender disappears entirely the upload registry is
        // already being torn down, so this worker should exit and discard its
        // temp file.
        self.cleanup().await;
    }

    /// Reports a terminal upload error and cleans up temporary state.
    async fn fail(self, message: String) {
        self.send_error_response(message).await;
        self.cleanup().await;
    }

    /// Renames the completed temp file into place and reports success.
    async fn finalize(self) {
        let RawUploadWorker {
            active_uploads,
            session,
            tx,
            agent_id,
            request_id,
            ..
        } = self;
        let RawUploadSession {
            path: final_path,
            temp_path,
            file,
            bytes_written,
        } = session;

        drop(file);

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

            AgentActor::remove_upload_temp_file(&temp_path).await;
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
            active_uploads.remove(request_id);
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
        active_uploads.remove(request_id);
    }

    /// Runs the raw upload loop until completion, cancellation, or failure.
    async fn process(mut self) {
        loop {
            let cancel_receiver = &mut self.cancel_receiver;
            let chunk_receiver = &mut self.chunk_receiver;
            let next_chunk = tokio::select! {
                event = Self::wait_for_cancel(cancel_receiver) => event,
                chunk = chunk_receiver.recv() => RawUploadEvent::Chunk(chunk),
            };

            let next_chunk = match next_chunk {
                RawUploadEvent::Chunk(chunk) => chunk,
                RawUploadEvent::Continue => continue,
                RawUploadEvent::Cancel => {
                    self.cancel().await;
                    return;
                }
                RawUploadEvent::Exit => {
                    self.shutdown().await;
                    return;
                }
            };

            let Some(chunk) = next_chunk else {
                break;
            };

            // Raw uploads accept only raw file payload frames; any other kind
            // indicates protocol corruption and must fail the transfer.
            if chunk.payload_kind != StreamPayloadKind::RawFile {
                let error_message = format!(
                    "Upload payload kind mismatch: expected {:?}, got {:?}",
                    StreamPayloadKind::RawFile,
                    chunk.payload_kind
                );
                self.fail(error_message).await;
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
                    self.request_id,
                    self.session.path,
                    error_message
                );

                self.fail(error_message).await;
                return;
            }

            if let Err(error) = self.session.file.write_all(&chunk.data).await {
                let error_message = format!("Failed to write upload chunk: {}", error);
                log!(
                    Level::Error,
                    "Upload write failed: request_id={}, path={}, error={}",
                    self.request_id,
                    self.session.path,
                    error_message
                );

                self.fail(error_message).await;
                return;
            }

            self.session.bytes_written += chunk.data.len() as u64;

            if !chunk.is_last {
                continue;
            }

            if let Err(error) = self.session.file.flush().await {
                let error_message = format!("Failed to flush uploaded file: {}", error);
                log!(
                    Level::Error,
                    "Upload flush failed: request_id={}, path={}, error={}",
                    self.request_id,
                    self.session.path,
                    error_message
                );

                self.fail(error_message).await;
                return;
            }

            self.finalize().await;
            return;
        }

        // Reaching EOF on the chunk channel without an explicit final chunk
        // means the upload ended unexpectedly before completion.
        self.fail("Upload stream ended before completion".to_string())
            .await;
    }
}

/// Owns the state and side effects for one in-progress raw file download.
struct RawDownloadWorker {
    path: String,
    range_start: Option<u64>,
    range_end: Option<u64>,
    request_id: RequestId,
    write: mpsc::Sender<WsMessage>,
    cancel_receiver: watch::Receiver<bool>,
    active_downloads: ActiveDownloads,
    chunk_index: ChunkIndex,
}

impl RawDownloadWorker {
    const CANCEL_MESSAGE: &'static [u8] = b"Download canceled by server";

    /// Waits for the cooperative cancel signal used by download workers.
    async fn wait_for_event(&mut self) -> RawDownloadEvent {
        match self.cancel_receiver.changed().await {
            Ok(()) if *self.cancel_receiver.borrow() => RawDownloadEvent::Cancel,
            Ok(()) => RawDownloadEvent::Continue,
            Err(_) => RawDownloadEvent::Exit,
        }
    }

    /// Frames and forwards one raw download payload over the websocket.
    async fn send_chunk(&mut self, request: StreamChunkFrameRequest<'_>) -> bool {
        AgentActor::send_framed_stream_bytes(&self.write, &mut self.chunk_index, request).await
    }

    /// Unregisters the download worker from the active download registry.
    async fn cleanup(&self) {
        self.active_downloads.remove(self.request_id);
    }

    /// Sends the cancellation frame expected by the server and exits.
    async fn cancel(mut self) {
        log!(
            Level::Info,
            "Stopping raw download after cancel: request_id={}, path={}",
            self.request_id,
            self.path
        );
        let _ = self
            .send_chunk(
                StreamChunkFrameRequest::new(self.request_id, Self::CANCEL_MESSAGE).is_error(true),
            )
            .await;
        self.cleanup().await;
    }

    /// Stops quietly after the download registry has been torn down.
    async fn shutdown(self) {
        self.cleanup().await;
    }

    /// Runs the raw download loop until EOF, cancellation, or failure.
    async fn process(mut self) {
        match File::open(&self.path).await {
            Ok(mut file) => {
                let chunk_size = streaming::CHUNK_SIZE;
                let mut buffer = vec![0u8; chunk_size];
                let mut bytes_remaining: Option<u64> = None;
                let mut pending_chunk: Option<Vec<u8>> = None;

                if let Some(start) = self.range_start {
                    if let Err(error) = file.seek(std::io::SeekFrom::Start(start)).await {
                        log!(Level::Error, "Failed to seek file: {}", error);
                        let error_msg = format!("Failed to seek file: {}", error);
                        let _ = self
                            .send_chunk(
                                StreamChunkFrameRequest::new(self.request_id, error_msg.as_bytes())
                                    .is_error(true),
                            )
                            .await;
                        return;
                    }

                    if let Some(end) = self.range_end {
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
                        event = self.wait_for_event() => event,
                        read_result = file.read(&mut buffer) => RawDownloadEvent::Read(read_result),
                    } {
                        RawDownloadEvent::Continue => continue,
                        RawDownloadEvent::Cancel => {
                            self.cancel().await;
                            return;
                        }
                        RawDownloadEvent::Exit => {
                            self.shutdown().await;
                            return;
                        }
                        RawDownloadEvent::Read(read_result) => match read_result {
                            Ok(0) => break,
                            Ok(bytes_read) => {
                                if let Some(ref mut remaining) = bytes_remaining {
                                    *remaining = remaining.saturating_sub(bytes_read as u64);
                                }

                                if let Some(data) =
                                    pending_chunk.replace(buffer[..bytes_read].to_vec())
                                {
                                    if !self
                                        .send_chunk(
                                            StreamChunkFrameRequest::new(self.request_id, &data)
                                                .is_last(false),
                                        )
                                        .await
                                    {
                                        log!(
                                            Level::Warning,
                                            "WebSocket channel full or closed, aborting download"
                                        );
                                        self.cleanup().await;
                                        return;
                                    }
                                }
                            }
                            Err(error) => {
                                log!(Level::Error, "Failed to read file: {}", error);
                                let error_msg = format!("Failed to read file: {}", error);
                                let _ = self
                                    .send_chunk(
                                        StreamChunkFrameRequest::new(
                                            self.request_id,
                                            error_msg.as_bytes(),
                                        )
                                        .is_error(true),
                                    )
                                    .await;
                                self.cleanup().await;
                                return;
                            }
                        },
                    }
                }

                let final_chunk = pending_chunk.unwrap_or_default();
                let _ = self
                    .send_chunk(StreamChunkFrameRequest::new(self.request_id, &final_chunk))
                    .await;

                log!(
                    Level::Info,
                    "Raw download complete: path={}, chunks={}",
                    self.path,
                    self.chunk_index.display_number()
                );
                self.cleanup().await;
            }
            Err(error) => {
                log!(Level::Error, "Failed to open file: {}", error);
                let error_msg = format!("Failed to open file: {}", error);
                let _ = self
                    .send_chunk(
                        StreamChunkFrameRequest::new(self.request_id, error_msg.as_bytes())
                            .is_error(true),
                    )
                    .await;
                self.cleanup().await;
            }
        }
    }
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
        let upload_already_exists = active_uploads.contains(request_id);

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
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                log!(
                    Level::Info,
                    "Started raw upload: request_id={}, path={}, temp_path={}",
                    request_id,
                    path,
                    temp_path.display()
                );
                active_uploads.insert(
                    request_id,
                    UploadSessionHandle {
                        path: path.clone(),
                        chunk_sender,
                        cancel_sender,
                    },
                );
                tokio::spawn(
                    RawUploadWorker {
                        active_uploads,
                        chunk_receiver,
                        cancel_receiver,
                        session: RawUploadSession {
                            path,
                            temp_path,
                            file,
                            bytes_written: 0,
                        },
                        tx: write.clone(),
                        agent_id: agent_id.clone(),
                        request_id,
                    }
                    .process(),
                );
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
        RawDownloadWorker {
            path,
            range_start,
            range_end,
            request_id,
            write: write.clone(),
            cancel_receiver,
            active_downloads,
            chunk_index: ChunkIndex::new(0),
        }
        .process()
        .await;
    }
}
