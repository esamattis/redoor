use super::super::{ActiveUploads, AgentActor, AgentCommandError, UploadSessionHandle};
use super::destination::{
    DestinationPlaceError, check_existing_destination, place_temp_at_destination,
};
use anyhow::Result;
use redoor::{
    Level,
    commands::{CommandErrorKind, CommandResult, CopyExistingMode},
    log,
    streaming::{self, StreamPayloadKind},
    types::{AgentId, RequestId},
};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Keeps tar upload failures typed so the API layer never depends on parsing text.
#[derive(Debug, Error)]
pub(crate) enum TarUploadError {
    #[error("Tar entry path escapes destination: {0}")]
    EscapingTarEntryPath(String),
    #[error("Tar entry path cannot be empty")]
    EmptyTarEntryPath,
    #[error("Destination parent not found for {0}")]
    DestinationParentNotFound(String),
    #[error("Failed to access destination parent: {0}")]
    AccessDestinationParent(#[source] std::io::Error),
    #[error("Destination parent is not a directory: {0}")]
    DestinationParentNotDirectory(String),
    #[error(transparent)]
    DestinationPlacement(#[from] DestinationPlaceError),
    #[error("Failed to create temp directory: {0}")]
    CreateTempDirectory(#[source] std::io::Error),
    #[error("Failed to read tar entries")]
    ReadTarEntries,
    #[error("Failed to read tar entry")]
    ReadTarEntry,
    #[error("Unsupported tar entry type: {0:?}")]
    UnsupportedTarEntryType(tar::EntryType),
    #[error("Failed to read tar entry path")]
    ReadTarEntryPath,
    #[error("Failed to create destination directory: {0}")]
    CreateDestinationDirectory(String),
    #[error("Failed to unpack tar entry to {0}")]
    UnpackTarEntry(String),
    #[error("Tar extraction worker failed: {0}")]
    ExtractionWorkerFailed(String),
}

impl TarUploadError {
    /// Maps one tar-upload failure to the stable command error kind carried over the protocol.
    pub(crate) fn kind(&self) -> CommandErrorKind {
        match self {
            Self::AccessDestinationParent(error) | Self::CreateTempDirectory(error) => {
                CommandErrorKind::from_io_error(error)
            }
            Self::DestinationPlacement(error) => error.kind(),
            Self::DestinationParentNotDirectory(_) => CommandErrorKind::NotADirectory,
            Self::EscapingTarEntryPath(_)
            | Self::EmptyTarEntryPath
            | Self::DestinationParentNotFound(_)
            | Self::UnsupportedTarEntryType(_) => CommandErrorKind::InvalidInput,
            Self::ReadTarEntries
            | Self::ReadTarEntry
            | Self::ReadTarEntryPath
            | Self::CreateDestinationDirectory(_)
            | Self::UnpackTarEntry(_)
            | Self::ExtractionWorkerFailed(_) => CommandErrorKind::Internal,
        }
    }
}

/// Removes an abandoned upload temp directory so failed tar uploads do not leave partial trees behind.
async fn remove_upload_temp_directory(temp_path: &Path) {
    if let Err(error) = redoor::safe_fs::safe_rm_all(temp_path).await {
        log!(
            Level::Warning,
            "Failed to remove upload temp directory: path={}, error={}",
            temp_path.display(),
            error
        );
    }
}

/// Builds the hidden temp directory path used while a tar upload is still incomplete.
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

/// Rejects tar entry paths that could escape the destination directory during extraction.
fn sanitize_tar_entry_path(entry_path: &Path) -> Result<PathBuf, TarUploadError> {
    let mut sanitized = PathBuf::new();

    for component in entry_path.components() {
        match component {
            Component::Normal(part) => sanitized.push(part),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(TarUploadError::EscapingTarEntryPath(
                    entry_path.display().to_string(),
                ));
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        return Err(TarUploadError::EmptyTarEntryPath);
    }

    Ok(sanitized)
}

/// Creates the temp destination and background unpack worker for one tar upload request.
async fn create_tar_upload_session(
    path: String,
    on_existing: CopyExistingMode,
) -> Result<TarUploadSession, TarUploadError> {
    let destination = PathBuf::from(&path);
    let parent = destination
        .parent()
        .ok_or_else(|| TarUploadError::DestinationParentNotFound(path.clone()))?
        .to_path_buf();

    let parent_metadata = tokio::fs::metadata(&parent)
        .await
        .map_err(TarUploadError::AccessDestinationParent)?;
    if !parent_metadata.is_dir() {
        return Err(TarUploadError::DestinationParentNotDirectory(
            parent.display().to_string(),
        ));
    }

    check_existing_destination(&destination, on_existing, true).await?;

    let temp_path = temp_upload_dir_path(&path);
    tokio::fs::create_dir(&temp_path)
        .await
        .map_err(TarUploadError::CreateTempDirectory)?;

    let (chunk_sender, chunk_receiver) = mpsc::channel::<Vec<u8>>(8);
    let temp_path_for_worker = temp_path.clone();

    let unpacker_handle = tokio::task::spawn_blocking(move || {
        unpack_tar_stream_into_directory(chunk_receiver, &temp_path_for_worker)
    });

    Ok(TarUploadSession {
        path,
        temp_path,
        on_existing,
        chunk_sender: Some(chunk_sender),
        unpacker_handle: Some(unpacker_handle),
        bytes_written: 0,
    })
}

/// Extracts tar bytes from the async-safe chunk channel into the temp destination directory.
fn unpack_tar_stream_into_directory(
    chunk_receiver: mpsc::Receiver<Vec<u8>>,
    destination_root: &Path,
) -> Result<(), TarUploadError> {
    struct ChannelTarReader {
        chunk_receiver: mpsc::Receiver<Vec<u8>>,
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

                match self.chunk_receiver.blocking_recv() {
                    Some(chunk) => {
                        self.current_chunk = chunk;
                        self.offset = 0;
                    }
                    None => {
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
    let entries = archive
        .entries()
        .map_err(|_| TarUploadError::ReadTarEntries)?;

    for entry_result in entries {
        let mut entry = entry_result.map_err(|_| TarUploadError::ReadTarEntry)?;

        let entry_type = entry.header().entry_type();
        if !(entry_type.is_dir() || entry_type.is_file()) {
            return Err(TarUploadError::UnsupportedTarEntryType(entry_type));
        }

        let entry_path = entry.path().map_err(|_| TarUploadError::ReadTarEntryPath)?;
        let sanitized_path = sanitize_tar_entry_path(&entry_path)?;
        let output_path = destination_root.join(&sanitized_path);

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| {
                TarUploadError::CreateDestinationDirectory(parent.display().to_string())
            })?;
        }

        if entry_type.is_dir() {
            std::fs::create_dir_all(&output_path).map_err(|_| {
                TarUploadError::CreateDestinationDirectory(output_path.display().to_string())
            })?;
            continue;
        }

        entry
            .unpack(&output_path)
            .map_err(|_| TarUploadError::UnpackTarEntry(output_path.display().to_string()))?;
    }

    Ok(())
}

/// Streams tar bytes into a blocking unpack worker that extracts into a temp directory.
struct TarUploadSession {
    path: String,
    temp_path: PathBuf,
    on_existing: CopyExistingMode,
    chunk_sender: Option<mpsc::Sender<Vec<u8>>>,
    unpacker_handle: Option<JoinHandle<Result<(), TarUploadError>>>,
    bytes_written: u64,
}

impl TarUploadSession {
    /// Closes the tar input and joins the blocking extractor before its temp tree can be touched.
    async fn join_unpacker(&mut self) -> Result<(), TarUploadError> {
        self.chunk_sender.take();

        let Some(unpacker_handle) = self.unpacker_handle.take() else {
            return Err(TarUploadError::ExtractionWorkerFailed(
                "extractor was already joined".to_string(),
            ));
        };

        match unpacker_handle.await {
            Ok(result) => result,
            Err(error) => Err(TarUploadError::ExtractionWorkerFailed(error.to_string())),
        }
    }
}

/// Outcome of waiting for either the next tar upload chunk or a cancel signal.
enum TarUploadEvent {
    Chunk(Option<streaming::StreamChunk>),
    Cancel,
    Exit,
}

/// Outcome of waiting for extractor capacity while cancellation remains responsive.
enum TarChunkForwardEvent {
    Sent(Result<(), mpsc::error::SendError<Vec<u8>>>),
    Cancel,
    Exit,
}

/// Owns the state and side effects for one in-progress tar upload.
struct TarUploadWorker {
    active_uploads: ActiveUploads,
    chunk_receiver: mpsc::Receiver<streaming::StreamChunk>,
    cancel_receiver: watch::Receiver<bool>,
    session: TarUploadSession,
    tx: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    request_id: RequestId,
}

impl TarUploadWorker {
    /// Waits for the cooperative cancel signal used by tar upload workers.
    async fn wait_for_cancel(cancel_receiver: &mut watch::Receiver<bool>) -> TarUploadEvent {
        match cancel_receiver.wait_for(|cancel| *cancel).await {
            Ok(_) => TarUploadEvent::Cancel,
            Err(_) => TarUploadEvent::Exit,
        }
    }

    /// Waits asynchronously for unpacker capacity without delaying cancellation on a full queue.
    async fn forward_chunk(&mut self, data: Vec<u8>) -> TarChunkForwardEvent {
        let Some(chunk_sender) = self.session.chunk_sender.as_ref() else {
            return TarChunkForwardEvent::Sent(Err(mpsc::error::SendError(data)));
        };
        let cancel_receiver = &mut self.cancel_receiver;

        tokio::select! {
            event = Self::wait_for_cancel(cancel_receiver) => match event {
                TarUploadEvent::Cancel => TarChunkForwardEvent::Cancel,
                TarUploadEvent::Exit => TarChunkForwardEvent::Exit,
                TarUploadEvent::Chunk(_) => unreachable!("cancel wait cannot produce a chunk"),
            },
            result = chunk_sender.send(data) => TarChunkForwardEvent::Sent(result),
        }
    }

    /// Sends an error command response for this tar upload request.
    async fn send_error_response(&self, kind: CommandErrorKind, message: String) {
        AgentActor
            .send_command_response(
                &self.tx,
                &self.agent_id,
                self.request_id,
                AgentCommandError::raw_upload(kind, message).into(),
            )
            .await;
    }

    /// Removes the temporary directory and unregisters the upload worker.
    async fn cleanup(&self) {
        remove_upload_temp_directory(&self.session.temp_path).await;
        self.active_uploads.remove(self.request_id);
    }

    /// Stops and joins the tar extractor while retaining request context for lifecycle failures.
    async fn stop_unpacker(&mut self) {
        if let Err(error) = self.session.join_unpacker().await {
            log!(
                Level::Warning,
                "Tar upload extractor failed while stopping: request_id={}, path={}, error={}",
                self.request_id,
                self.session.path,
                error
            );
        }
    }

    /// Handles an explicit server-side cancellation request.
    async fn cancel(mut self) {
        log!(
            Level::Info,
            "Stopping tar upload after cancel: request_id={}, path={}",
            self.request_id,
            self.session.path
        );
        self.stop_unpacker().await;
        self.cleanup().await;
        self.send_error_response(
            CommandErrorKind::InvalidInput,
            "Upload canceled by server".to_string(),
        )
        .await;
    }

    /// Handles worker shutdown after the upload registry has been torn down.
    async fn shutdown(mut self) {
        // Registry teardown drops the watch sender before the chunk receiver
        // necessarily closes, so treat it as an instruction to stop and clean
        // up now.
        self.stop_unpacker().await;
        self.cleanup().await;
    }

    /// Reports a terminal upload error and cleans up temporary state.
    async fn fail(mut self, kind: CommandErrorKind, message: String) {
        self.stop_unpacker().await;
        self.cleanup().await;
        self.send_error_response(kind, message).await;
    }

    /// Finalizes a successfully received tar stream and reports completion.
    async fn finalize(self) {
        let TarUploadWorker {
            active_uploads,
            session,
            tx,
            agent_id,
            request_id,
            ..
        } = self;

        finalize_tar_upload(&tx, &agent_id, request_id, session).await;
        active_uploads.remove(request_id);
    }

    /// Runs the tar upload loop until completion, cancellation, or failure.
    async fn process(mut self) {
        loop {
            let cancel_receiver = &mut self.cancel_receiver;
            let chunk_receiver = &mut self.chunk_receiver;
            let next_chunk = tokio::select! {
                event = Self::wait_for_cancel(cancel_receiver) => event,
                chunk = chunk_receiver.recv() => TarUploadEvent::Chunk(chunk),
            };

            let next_chunk = match next_chunk {
                TarUploadEvent::Chunk(chunk) => chunk,
                TarUploadEvent::Cancel => {
                    self.cancel().await;
                    return;
                }
                TarUploadEvent::Exit => {
                    self.shutdown().await;
                    return;
                }
            };

            let Some(chunk) = next_chunk else {
                break;
            };

            // Tar uploads must remain tar-framed end-to-end because the unpack
            // worker consumes a tar byte stream from the chunk channel.
            if chunk.payload_kind != StreamPayloadKind::Tar {
                let error_message = format!(
                    "Upload payload kind mismatch: expected {:?}, got {:?}",
                    StreamPayloadKind::Tar,
                    chunk.payload_kind
                );
                self.fail(CommandErrorKind::InvalidInput, error_message)
                    .await;
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

                self.fail(CommandErrorKind::InvalidInput, error_message)
                    .await;
                return;
            }

            if !chunk.data.is_empty() {
                let chunk_len = chunk.data.len() as u64;
                match self.forward_chunk(chunk.data).await {
                    TarChunkForwardEvent::Sent(Ok(())) => {
                        self.session.bytes_written += chunk_len;
                    }
                    TarChunkForwardEvent::Sent(Err(error)) => {
                        let error_message =
                            format!("Failed to forward tar upload chunk to unpacker: {}", error);
                        self.fail(CommandErrorKind::Internal, error_message).await;
                        return;
                    }
                    TarChunkForwardEvent::Cancel => {
                        self.cancel().await;
                        return;
                    }
                    TarChunkForwardEvent::Exit => {
                        self.shutdown().await;
                        return;
                    }
                }
            }

            if !chunk.is_last {
                continue;
            }

            self.finalize().await;
            return;
        }

        self.fail(
            CommandErrorKind::Internal,
            "Upload stream ended before completion".to_string(),
        )
        .await;
    }
}

impl AgentActor {
    /// Starts the agent-side tar upload worker after reserving request tracking state.
    pub(crate) async fn start_tar_upload_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        path: String,
        on_existing: CopyExistingMode,
    ) {
        let upload_already_exists = active_uploads.contains(request_id);

        if upload_already_exists {
            self.send_command_response(
                write,
                agent_id,
                request_id,
                AgentCommandError::raw_upload(
                    CommandErrorKind::AlreadyExists,
                    format!(
                        "Upload session already exists for request_id={}",
                        request_id
                    ),
                )
                .into(),
            )
            .await;
            return;
        }

        match create_tar_upload_session(path.clone(), on_existing).await {
            Ok(session) => {
                let (chunk_sender, chunk_receiver) = mpsc::channel::<streaming::StreamChunk>(8);
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                log!(
                    Level::Info,
                    "Started tar upload: request_id={}, path={}, temp_path={}, on_existing={:?}",
                    request_id,
                    path,
                    session.temp_path.display(),
                    on_existing
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
                    TarUploadWorker {
                        active_uploads,
                        chunk_receiver,
                        cancel_receiver,
                        session,
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
                    AgentCommandError::from(error).into(),
                )
                .await;
            }
        }
    }
}

/// Finalizes a tar upload by waiting for extraction, placing the temp tree, and reporting the result.
async fn finalize_tar_upload(
    tx: &mpsc::Sender<WsMessage>,
    agent_id: &AgentId,
    request_id: RequestId,
    mut session: TarUploadSession,
) {
    let final_path = session.path.clone();
    let temp_path = session.temp_path.clone();
    let on_existing = session.on_existing;
    let bytes_written = session.bytes_written;

    let unpack_result = session.join_unpacker().await;

    match unpack_result {
        Ok(()) => {
            if let Err(error) =
                place_temp_at_destination(&temp_path, Path::new(&final_path), on_existing, true)
                    .await
            {
                let _ = redoor::safe_fs::safe_rm_all(&temp_path).await;

                AgentActor
                    .send_command_response(
                        tx,
                        agent_id,
                        request_id,
                        AgentCommandError::from(TarUploadError::from(error)).into(),
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

            AgentActor
                .send_command_response(tx, agent_id, request_id, CommandResult::TarUpload)
                .await;
        }
        Err(error) => {
            let _ = redoor::safe_fs::safe_rm_all(&temp_path).await;
            AgentActor
                .send_command_response(
                    tx,
                    agent_id,
                    request_id,
                    AgentCommandError::from(error).into(),
                )
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[tokio::test]
    async fn full_unpacker_queue_keeps_cancellation_async_and_joins_before_cleanup() {
        let temp_path = std::env::temp_dir().join(format!(
            "redoor-tar-upload-cancel-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        tokio::fs::create_dir(&temp_path)
            .await
            .expect("tar upload temp directory should be created");

        let (chunk_sender, mut chunk_receiver) = mpsc::channel::<Vec<u8>>(1);
        chunk_sender
            .try_send(vec![1])
            .expect("the first chunk should fill the bounded queue");
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel::<()>();
        let extractor_stopped = Arc::new(AtomicBool::new(false));
        let extractor_stopped_in_worker = Arc::clone(&extractor_stopped);
        let unpacker_handle = tokio::task::spawn_blocking(move || {
            release_receiver
                .blocking_recv()
                .expect("the test should release the extractor");
            while chunk_receiver.blocking_recv().is_some() {}
            extractor_stopped_in_worker.store(true, Ordering::Release);
            Ok(())
        });

        let (_stream_sender, stream_receiver) = mpsc::channel(1);
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        let (tx, _rx) = mpsc::channel(1);
        let mut worker = TarUploadWorker {
            active_uploads: ActiveUploads::new(),
            chunk_receiver: stream_receiver,
            cancel_receiver,
            session: TarUploadSession {
                path: temp_path.display().to_string(),
                temp_path: temp_path.clone(),
                on_existing: CopyExistingMode::Error,
                chunk_sender: Some(chunk_sender),
                unpacker_handle: Some(unpacker_handle),
                bytes_written: 0,
            },
            tx,
            agent_id: AgentId::new("test-agent"),
            request_id: RequestId::new(1),
        };

        let mut forward = Box::pin(worker.forward_chunk(vec![2]));
        assert!(
            matches!(futures_util::poll!(&mut forward), std::task::Poll::Pending),
            "a full extractor queue must yield instead of blocking the Tokio worker"
        );
        cancel_sender
            .send(true)
            .expect("the active worker should receive cancellation");
        assert!(
            matches!(forward.await, TarChunkForwardEvent::Cancel),
            "cancellation must win without waiting for extractor queue capacity"
        );

        release_sender
            .send(())
            .expect("the extractor should still be owned by the upload session");
        worker.stop_unpacker().await;
        assert!(
            extractor_stopped.load(Ordering::Acquire),
            "the blocking extractor must be joined before terminal cleanup continues"
        );
        assert!(
            temp_path.exists(),
            "joining the extractor must happen before its temp tree is removed"
        );

        worker.cleanup().await;
        assert!(
            !temp_path.exists(),
            "terminal cleanup must remove the temp tree after the extractor exits"
        );
    }
}
