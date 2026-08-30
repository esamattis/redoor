use super::super::transfers::destination::{check_existing_destination, place_temp_at_destination};
use super::super::{ActiveUploads, AgentActor, AgentCommandError, UploadSessionHandle};
use redoor::ownership::{OwnershipPlan, ResolvedOwnership};
use redoor::{
    Level,
    commands::{CommandErrorKind, CommandResult, CopyExistingMode, CreationOwnershipOptions},
    log,
    streaming::{self, StreamPayloadKind},
    types::{AgentId, RequestId},
};
use std::path::{Path, PathBuf};
use tokio::{
    fs::{File, OpenOptions},
    io::AsyncWriteExt,
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Removes an abandoned upload temp file so failed uploads do not leave partial output behind.
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

/// Builds the hidden temp file path used while a raw upload is still incomplete.
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

/// Reserves a new sibling temp entry without following a colliding symlink.
async fn create_upload_temp(path: &str) -> std::io::Result<(PathBuf, File)> {
    for _ in 0..16 {
        let temp_path = temp_upload_path(path);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "Failed to reserve a unique upload temp file",
    ))
}

/// Captures metadata only from a regular destination entry and never from a symlink target.
async fn existing_destination_metadata(
    path: &Path,
) -> std::io::Result<Option<(std::fs::Permissions, u32, u32)>> {
    use std::os::unix::fs::MetadataExt;

    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some((
            metadata.permissions(),
            metadata.uid(),
            metadata.gid(),
        ))),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Keeps path, collision policy, and ownership together so session startup stays under the argument lint.
pub(crate) struct RawUploadDestination {
    pub path: String,
    pub on_existing: CopyExistingMode,
    pub ownership: CreationOwnershipOptions,
}

struct RawUploadSession {
    path: String,
    temp_path: PathBuf,
    on_existing: CopyExistingMode,
    file: File,
    existing_permissions: Option<std::fs::Permissions>,
    ownership: ResolvedOwnership,
    bytes_written: u64,
}

/// Outcome of waiting for either the next raw upload chunk or a cancel signal.
enum RawUploadEvent {
    Chunk(Option<streaming::StreamChunk>),
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

    /// Removes the temporary file and unregisters the upload worker.
    async fn cleanup(&self) {
        remove_upload_temp_file(&self.session.temp_path).await;
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
        self.cleanup().await;
        self.send_error_response(
            CommandErrorKind::InvalidInput,
            "Upload canceled by server".to_string(),
        )
        .await;
    }

    /// Handles worker shutdown after the upload registry has been torn down.
    async fn shutdown(self) {
        // If the cancel sender disappears entirely the upload registry is
        // already being torn down, so this worker should exit and discard its
        // temp file.
        self.cleanup().await;
    }

    /// Reports a terminal upload error and cleans up temporary state.
    async fn fail(self, kind: CommandErrorKind, message: String) {
        self.send_error_response(kind, message).await;
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
            on_existing,
            file,
            existing_permissions,
            ownership,
            bytes_written,
        } = session;

        drop(file);

        if let Err(error) = ownership.apply(&temp_path).await {
            let error_message = format!("Failed to set uploaded file ownership: {error}");
            remove_upload_temp_file(&temp_path).await;
            AgentActor
                .send_command_response(
                    &tx,
                    &agent_id,
                    request_id,
                    AgentCommandError::raw_upload(error.kind(), error_message).into(),
                )
                .await;
            active_uploads.remove(request_id);
            return;
        }

        if let Some(permissions) = existing_permissions
            && let Err(error) = tokio::fs::set_permissions(&temp_path, permissions).await
        {
            let error_message = format!("Failed to preserve uploaded file permissions: {error}");
            redoor::log_failure!(
                Level::Error,
                "Upload permission restore failed: request_id={}, path={}, temp_path={}, error={}",
                request_id,
                final_path,
                temp_path.display(),
                error_message
            );
            remove_upload_temp_file(&temp_path).await;
            AgentActor
                .send_command_response(
                    &tx,
                    &agent_id,
                    request_id,
                    AgentCommandError::raw_upload(
                        CommandErrorKind::from_io_error(&error),
                        error_message,
                    )
                    .into(),
                )
                .await;
            active_uploads.remove(request_id);
            return;
        }

        if let Err(error) =
            place_temp_at_destination(&temp_path, Path::new(&final_path), on_existing, false).await
        {
            let error_message = format!("Failed to finalize uploaded file: {}", error);
            redoor::log_failure!(
                Level::Error,
                "Upload place failed: request_id={}, path={}, temp_path={}, error={}",
                request_id,
                final_path,
                temp_path.display(),
                error_message
            );

            remove_upload_temp_file(&temp_path).await;
            AgentActor
                .send_command_response(
                    &tx,
                    &agent_id,
                    request_id,
                    AgentCommandError::raw_upload(error.kind(), error_message).into(),
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

            if let Err(error) = self.session.file.write_all(&chunk.data).await {
                let error_message = format!("Failed to write upload chunk: {}", error);
                redoor::log_failure!(
                    Level::Error,
                    "Upload write failed: request_id={}, path={}, error={}",
                    self.request_id,
                    self.session.path,
                    error_message
                );

                self.fail(CommandErrorKind::from_io_error(&error), error_message)
                    .await;
                return;
            }

            self.session.bytes_written += chunk.data.len() as u64;

            if !chunk.is_last {
                continue;
            }

            if let Err(error) = self.session.file.flush().await {
                let error_message = format!("Failed to flush uploaded file: {}", error);
                redoor::log_failure!(
                    Level::Error,
                    "Upload flush failed: request_id={}, path={}, error={}",
                    self.request_id,
                    self.session.path,
                    error_message
                );

                self.fail(CommandErrorKind::from_io_error(&error), error_message)
                    .await;
                return;
            }

            self.finalize().await;
            return;
        }

        // Reaching EOF on the chunk channel without an explicit final chunk
        // means the upload ended unexpectedly before completion.
        self.fail(
            CommandErrorKind::Internal,
            "Upload stream ended before completion".to_string(),
        )
        .await;
    }
}

impl AgentActor {
    /// Stages a temp file and ownership plan before the HTTP body starts streaming.
    pub(crate) async fn start_raw_upload_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        destination: RawUploadDestination,
    ) {
        let RawUploadDestination {
            path,
            on_existing,
            ownership,
        } = destination;
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

        if let Err(error) = check_existing_destination(Path::new(&path), on_existing, false).await {
            self.send_command_response(
                write,
                agent_id,
                request_id,
                AgentCommandError::raw_upload(error.kind(), error.to_string()).into(),
            )
            .await;
            return;
        }

        let existing_metadata = match existing_destination_metadata(Path::new(&path)).await {
            Ok(metadata) => metadata,
            Err(error) => {
                self.send_command_response(
                    write,
                    agent_id,
                    request_id,
                    AgentCommandError::raw_upload(
                        CommandErrorKind::from_io_error(&error),
                        format!("Failed to inspect upload destination: {error}"),
                    )
                    .into(),
                )
                .await;
                return;
            }
        };
        let existing_ids = existing_metadata.as_ref().map(|(_, uid, gid)| (*uid, *gid));
        let ownership_plan = match OwnershipPlan::resolve(ownership, existing_ids).await {
            Ok(plan) => plan,
            Err(error) => {
                self.send_command_response(
                    write,
                    agent_id,
                    request_id,
                    AgentCommandError::raw_upload(error.kind(), error.to_string()).into(),
                )
                .await;
                return;
            }
        };
        let parent = Path::new(&path).parent().unwrap_or_else(|| Path::new("."));
        let resolved_ownership = match ownership_plan.for_parent(parent).await {
            Ok(ownership) => ownership,
            Err(error) => {
                self.send_command_response(
                    write,
                    agent_id,
                    request_id,
                    AgentCommandError::raw_upload(error.kind(), error.to_string()).into(),
                )
                .await;
                return;
            }
        };
        let existing_permissions = existing_metadata.map(|(permissions, _, _)| permissions);
        match create_upload_temp(&path).await {
            Ok((temp_path, file)) => {
                let (chunk_sender, chunk_receiver) = mpsc::channel::<streaming::StreamChunk>(8);
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                log!(
                    Level::Info,
                    "Started raw upload: request_id={}, path={}, temp_path={}, on_existing={:?}",
                    request_id,
                    path,
                    temp_path.display(),
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
                    RawUploadWorker {
                        active_uploads,
                        chunk_receiver,
                        cancel_receiver,
                        session: RawUploadSession {
                            path,
                            temp_path,
                            on_existing,
                            file,
                            existing_permissions,
                            ownership: resolved_ownership,
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
                    AgentCommandError::raw_upload(
                        CommandErrorKind::from_io_error(&error),
                        format!("Failed to create file: {}", error),
                    )
                    .into(),
                )
                .await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[tokio::test]
    async fn permission_capture_uses_destination_entry_without_following_symlinks() {
        let temp = TempDir::create();
        let target = temp.path().join("target");
        let peer = temp.path().join("peer");
        let valid_link = temp.path().join("valid-link");
        let dangling_link = temp.path().join("dangling-link");
        tokio::fs::write(&target, b"target").await.unwrap();
        tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751))
            .await
            .unwrap();
        tokio::fs::hard_link(&target, &peer).await.unwrap();
        symlink(&target, &valid_link).unwrap();
        symlink("missing", &dangling_link).unwrap();

        let regular = existing_destination_metadata(&target)
            .await
            .unwrap()
            .unwrap()
            .0;
        let hard_link = existing_destination_metadata(&peer)
            .await
            .unwrap()
            .unwrap()
            .0;

        // A regular entry keeps its own previous mode for replacement publication.
        assert_eq!(regular.mode() & 0o777, 0o751);
        // A hard-link name directly identifies a regular entry and supplies the same mode.
        assert_eq!(hard_link.mode() & 0o777, 0o751);
        // A valid symlink must not leak its target mode into the replacement file.
        assert!(
            existing_destination_metadata(&valid_link)
                .await
                .unwrap()
                .is_none()
        );
        // A dangling symlink is still an entry and must likewise provide no target metadata.
        assert!(
            existing_destination_metadata(&dangling_link)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn temp_creation_reserves_a_new_regular_sibling() {
        let temp = TempDir::create();
        let destination = temp.path().join("destination");

        let (temp_path, file) = create_upload_temp(&destination.to_string_lossy())
            .await
            .unwrap();
        drop(file);

        // The reserved temp entry must be a newly created regular file.
        assert!(
            tokio::fs::symlink_metadata(&temp_path)
                .await
                .unwrap()
                .is_file()
        );
        tokio::fs::remove_file(temp_path).await.unwrap();
    }
}
