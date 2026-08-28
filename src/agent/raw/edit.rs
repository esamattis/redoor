use super::super::{ActiveUploads, AgentActor, AgentCommandError, UploadSessionHandle};
use redoor::{
    Level,
    commands::{CommandErrorKind, CommandResult},
    log,
    streaming::{self, StreamPayloadKind},
    types::{AgentId, RequestId},
};
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

const STAGING_CREATE_ATTEMPTS: usize = 16;

/// Captures the inode properties that a successful editor rewrite must preserve.
#[derive(Clone, Copy, Debug)]
struct TargetIdentity {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    ordinary_mode: u32,
}

impl TargetIdentity {
    /// Records identity, ownership, and ordinary permissions from the pinned descriptor.
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            ordinary_mode: metadata.mode() & 0o777,
        }
    }

    /// Checks whether pathname resolution still selects the inode opened at setup.
    fn matches_inode(self, metadata: &std::fs::Metadata) -> bool {
        self.dev == metadata.dev() && self.ino == metadata.ino()
    }
}

/// Holds both descriptors so staging failures cannot touch the selected target inode.
#[derive(Debug)]
struct EditSession {
    path: String,
    target: File,
    staging: File,
    identity: TargetIdentity,
    bytes_written: u64,
}

impl EditSession {
    /// Pins an existing regular file and reserves an anonymous staging inode before readiness.
    async fn open(path: String) -> Result<Self, AgentCommandError> {
        if !Path::new(&path).is_absolute() {
            return Err(edit_error(
                CommandErrorKind::InvalidInput,
                "File edit path must be absolute",
            ));
        }

        let target = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&path)
            .await
            .map_err(|error| classify_target_open_error(&path, error))?;
        let metadata = target.metadata().await.map_err(|error| {
            edit_error(
                CommandErrorKind::from_io_error(&error),
                format!("Failed to inspect edit target: {error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(edit_error(
                if metadata.is_dir() {
                    CommandErrorKind::IsDirectory
                } else {
                    CommandErrorKind::InvalidInput
                },
                format!("File edit target is not a regular file: {path}"),
            ));
        }

        let staging = create_unlinked_staging_file().await?;
        Ok(Self {
            path,
            target,
            staging,
            identity: TargetIdentity::from_metadata(&metadata),
            bytes_written: 0,
        })
    }

    /// Appends one bounded transfer chunk to staging without mutating the target.
    async fn stage(&mut self, data: &[u8]) -> Result<(), AgentCommandError> {
        self.staging.write_all(data).await.map_err(|error| {
            edit_error(
                CommandErrorKind::from_io_error(&error),
                format!("Failed to stage file edit: {error}"),
            )
        })?;
        self.bytes_written = self.bytes_written.saturating_add(data.len() as u64);
        Ok(())
    }

    /// Rechecks pathname identity, then rewrites only the inode pinned during setup.
    async fn commit(mut self) -> Result<u64, AgentCommandError> {
        self.staging.flush().await.map_err(|error| {
            edit_error(
                CommandErrorKind::from_io_error(&error),
                format!("Failed to flush staged file edit: {error}"),
            )
        })?;
        self.staging
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|error| {
                edit_error(
                    CommandErrorKind::from_io_error(&error),
                    format!("Failed to rewind staged file edit: {error}"),
                )
            })?;
        self.verify_path_identity().await?;

        self.target
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|error| post_commit_error("seek edit target", error))?;
        self.target
            .set_len(0)
            .await
            .map_err(|error| post_commit_error("truncate edit target", error))?;
        let copied = tokio::io::copy(&mut self.staging, &mut self.target)
            .await
            .map_err(|error| post_commit_error("copy staged edit into target", error))?;
        if copied != self.bytes_written {
            return Err(edit_error(
                CommandErrorKind::Internal,
                format!(
                    "File edit committed an unexpected byte count after truncation: expected {}, wrote {copied}",
                    self.bytes_written
                ),
            ));
        }
        self.target
            .flush()
            .await
            .map_err(|error| post_commit_error("flush edit target", error))?;
        self.restore_ordinary_permissions().await?;
        self.verify_committed_metadata().await?;
        Ok(copied)
    }

    /// Rejects a namespace change before any bytes are written to the pinned target.
    async fn verify_path_identity(&self) -> Result<(), AgentCommandError> {
        let metadata = tokio::fs::metadata(&self.path)
            .await
            .map_err(|error| classify_identity_lookup_error(&self.path, error))?;
        if !self.identity.matches_inode(&metadata) {
            return Err(edit_error(
                CommandErrorKind::Conflict,
                format!(
                    "File edit target changed while content was being staged: {}",
                    self.path
                ),
            ));
        }
        Ok(())
    }

    /// Restores mandatory rwx bits without re-enabling special bits cleared by the kernel.
    async fn restore_ordinary_permissions(&self) -> Result<(), AgentCommandError> {
        let metadata = self.target.metadata().await.map_err(|error| {
            post_commit_error("inspect edit target permissions after writing", error)
        })?;
        if metadata.mode() & 0o777 == self.identity.ordinary_mode {
            return Ok(());
        }
        let restored_mode = (metadata.mode() & 0o7000) | self.identity.ordinary_mode;
        self.target
            .set_permissions(std::fs::Permissions::from_mode(restored_mode))
            .await
            .map_err(|error| post_commit_error("restore edit target permissions", error))
    }

    /// Prevents success if identity, ownership, or mandatory rwx preservation was lost.
    async fn verify_committed_metadata(&self) -> Result<(), AgentCommandError> {
        let metadata = self
            .target
            .metadata()
            .await
            .map_err(|error| post_commit_error("verify committed edit metadata", error))?;
        if !self.identity.matches_inode(&metadata)
            || metadata.uid() != self.identity.uid
            || metadata.gid() != self.identity.gid
            || metadata.mode() & 0o777 != self.identity.ordinary_mode
        {
            return Err(edit_error(
                CommandErrorKind::Internal,
                "File content was rewritten but required inode metadata was not preserved",
            ));
        }
        Ok(())
    }
}

/// Owns one edit session and its cancellation-sensitive pre-commit stream loop.
struct EditFileWorker {
    active_uploads: ActiveUploads,
    chunk_receiver: mpsc::Receiver<streaming::StreamChunk>,
    cancel_receiver: watch::Receiver<bool>,
    session: EditSession,
    tx: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    request_id: RequestId,
}

/// Represents one event selected while an edit is still safe to discard.
enum EditFileEvent {
    Chunk(Option<streaming::StreamChunk>),
    Continue,
    Cancel,
    Exit,
}

impl EditFileWorker {
    /// Waits for cancellation while preserving watch closure as worker shutdown.
    async fn wait_for_cancel(cancel_receiver: &mut watch::Receiver<bool>) -> EditFileEvent {
        match cancel_receiver.changed().await {
            Ok(()) if *cancel_receiver.borrow() => EditFileEvent::Cancel,
            Ok(()) => EditFileEvent::Continue,
            Err(_) => EditFileEvent::Exit,
        }
    }

    /// Sends one typed edit failure and releases registry ownership.
    async fn fail(self, error: AgentCommandError) {
        AgentActor
            .send_command_response(&self.tx, &self.agent_id, self.request_id, error.into())
            .await;
        self.active_uploads.remove(self.request_id);
    }

    /// Discards staged bytes after an accepted cancellation without touching the target.
    async fn cancel(self) {
        log!(
            Level::Info,
            "Stopping file edit after cancel: request_id={}, path={}",
            self.request_id,
            self.session.path
        );
        self.fail(edit_error(
            CommandErrorKind::InvalidInput,
            "File edit canceled by server",
        ))
        .await;
    }

    /// Commits after the terminal frame and ignores cancellation until the rewrite finishes.
    async fn commit(self) {
        let EditFileWorker {
            active_uploads,
            session,
            tx,
            agent_id,
            request_id,
            ..
        } = self;
        let path = session.path.clone();
        match session.commit().await {
            Ok(bytes_written) => {
                log!(
                    Level::Info,
                    "File edit complete: request_id={}, path={}, bytes_written={}",
                    request_id,
                    path,
                    bytes_written
                );
                AgentActor
                    .send_command_response(&tx, &agent_id, request_id, CommandResult::EditFile)
                    .await;
            }
            Err(error) => {
                AgentActor
                    .send_command_response(&tx, &agent_id, request_id, error.into())
                    .await;
            }
        }
        active_uploads.remove(request_id);
    }

    /// Stages frames until terminal input authorizes the non-atomic inode rewrite.
    async fn process(mut self) {
        loop {
            let event = tokio::select! {
                biased;
                chunk = self.chunk_receiver.recv() => EditFileEvent::Chunk(chunk),
                event = Self::wait_for_cancel(&mut self.cancel_receiver) => event,
            };
            let Some(chunk) = (match event {
                EditFileEvent::Chunk(chunk) => chunk,
                EditFileEvent::Continue => continue,
                EditFileEvent::Cancel => {
                    self.cancel().await;
                    return;
                }
                EditFileEvent::Exit => return,
            }) else {
                self.fail(edit_error(
                    CommandErrorKind::Internal,
                    "File edit stream ended before completion",
                ))
                .await;
                return;
            };

            if chunk.payload_kind != StreamPayloadKind::RawFile {
                self.fail(edit_error(
                    CommandErrorKind::InvalidInput,
                    format!(
                        "File edit payload kind mismatch: expected {:?}, got {:?}",
                        StreamPayloadKind::RawFile,
                        chunk.payload_kind
                    ),
                ))
                .await;
                return;
            }
            if chunk.is_error {
                let message = if chunk.data.is_empty() {
                    "File edit aborted by server".to_string()
                } else {
                    String::from_utf8_lossy(&chunk.data).to_string()
                };
                self.fail(edit_error(CommandErrorKind::InvalidInput, message))
                    .await;
                return;
            }
            if let Err(error) = self.session.stage(&chunk.data).await {
                self.fail(error).await;
                return;
            }
            if chunk.is_last {
                self.commit().await;
                return;
            }
        }
    }
}

impl AgentActor {
    /// Starts a pinned-inode edit worker and registers it before readiness is announced.
    pub(crate) async fn start_file_edit_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        path: String,
    ) {
        if active_uploads.contains(request_id) {
            self.send_command_response(
                write,
                agent_id,
                request_id,
                edit_error(
                    CommandErrorKind::AlreadyExists,
                    format!("Upload session already exists for request_id={request_id}"),
                )
                .into(),
            )
            .await;
            return;
        }

        let session = match EditSession::open(path.clone()).await {
            Ok(session) => session,
            Err(error) => {
                self.send_command_response(write, agent_id, request_id, error.into())
                    .await;
                return;
            }
        };
        let (chunk_sender, chunk_receiver) = mpsc::channel::<streaming::StreamChunk>(8);
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        active_uploads.insert(
            request_id,
            UploadSessionHandle {
                path: path.clone(),
                chunk_sender,
                cancel_sender,
            },
        );
        log!(
            Level::Info,
            "Started file edit: request_id={}, path={}",
            request_id,
            path
        );
        tokio::spawn(
            EditFileWorker {
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
}

/// Creates an unlinked mode-0600 staging inode without following a colliding name.
async fn create_unlinked_staging_file() -> Result<File, AgentCommandError> {
    for _ in 0..STAGING_CREATE_ATTEMPTS {
        let path = staging_path();
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC)
            .open(&path)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(edit_error(
                    CommandErrorKind::from_io_error(&error),
                    format!("Failed to create file edit staging file: {error}"),
                ));
            }
        };
        if let Err(error) = tokio::fs::remove_file(&path).await {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(edit_error(
                CommandErrorKind::from_io_error(&error),
                format!("Failed to unlink file edit staging file: {error}"),
            ));
        }
        return Ok(file);
    }
    Err(edit_error(
        CommandErrorKind::AlreadyExists,
        "Failed to reserve a unique file edit staging file",
    ))
}

/// Generates an unpredictable staging name under the platform temporary directory.
fn staging_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        ".redoor-edit-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

/// Preserves useful Unix pathname errors while making special-file rejection actionable.
fn classify_target_open_error(path: &str, error: std::io::Error) -> AgentCommandError {
    let (kind, message) = if error.raw_os_error() == Some(libc::ELOOP) {
        (
            CommandErrorKind::InvalidInput,
            format!("File edit target contains a symlink loop: {path}"),
        )
    } else if error.raw_os_error() == Some(libc::ENXIO) {
        (
            CommandErrorKind::InvalidInput,
            format!("File edit target is not a regular file: {path}"),
        )
    } else {
        (
            CommandErrorKind::from_io_error(&error),
            format!("Failed to open file edit target {path}: {error}"),
        )
    };
    edit_error(kind, message)
}

/// Classifies the final following lookup used only to detect namespace races.
fn classify_identity_lookup_error(path: &str, error: std::io::Error) -> AgentCommandError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    ) || error.raw_os_error() == Some(libc::ELOOP)
    {
        return edit_error(
            CommandErrorKind::Conflict,
            format!("File edit target changed while content was being staged: {path}"),
        );
    }
    edit_error(
        CommandErrorKind::from_io_error(&error),
        format!("Failed to recheck file edit target {path}: {error}"),
    )
}

/// Makes irreversible post-truncation failures explicit instead of implying rollback.
fn post_commit_error(action: &str, error: std::io::Error) -> AgentCommandError {
    edit_error(
        CommandErrorKind::from_io_error(&error),
        format!("Failed to {action} after file edit commit started: {error}"),
    )
}

/// Builds the protocol error shape used consistently by edit setup and commit.
fn edit_error(kind: CommandErrorKind, message: impl Into<String>) -> AgentCommandError {
    AgentCommandError::edit_file(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    /// Stages and commits bytes directly so filesystem semantics can be tested without sockets.
    async fn edit(path: &Path, content: &[u8]) -> Result<u64, AgentCommandError> {
        let mut session = EditSession::open(path.to_string_lossy().into_owned()).await?;
        session.stage(content).await?;
        session.commit().await
    }

    #[tokio::test]
    async fn regular_file_edit_preserves_inode_links_ownership_and_mode() {
        let temp = TempDir::create();
        let path = temp.path().join("target");
        let peer = temp.path().join("peer");
        tokio::fs::write(&path, b"old").await.unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751))
            .await
            .unwrap();
        tokio::fs::hard_link(&path, &peer).await.unwrap();
        let before = tokio::fs::metadata(&path).await.unwrap();

        let written = edit(&path, b"longer replacement").await.unwrap();
        let after = tokio::fs::metadata(&path).await.unwrap();

        // The returned byte count must describe the staged replacement exactly.
        assert_eq!(written, b"longer replacement".len() as u64);
        // Editing must retain the selected inode and every hard-link relationship.
        assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
        // Owner and group are mandatory success properties rather than best effort metadata.
        assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
        // All ordinary permission bits must survive the content rewrite exactly.
        assert_eq!(after.mode() & 0o777, 0o751);
        // The link count proves publication did not replace only one directory entry.
        assert_eq!(after.nlink(), before.nlink());
        // A peer hard link must expose the same replacement bytes.
        assert_eq!(tokio::fs::read(&peer).await.unwrap(), b"longer replacement");
    }

    #[tokio::test]
    async fn edits_absolute_relative_and_chained_symlinks_without_replacing_them() {
        let temp = TempDir::create();
        let target = temp.path().join("target");
        let absolute = temp.path().join("absolute");
        let relative = temp.path().join("relative");
        let chain = temp.path().join("chain");
        tokio::fs::write(&target, b"one").await.unwrap();
        symlink(&target, &absolute).unwrap();
        symlink("target", &relative).unwrap();
        symlink("relative", &chain).unwrap();
        let inode = tokio::fs::metadata(&target).await.unwrap().ino();

        edit(&absolute, b"two").await.unwrap();
        edit(&chain, b"three").await.unwrap();

        // Following both absolute and relative chains must leave every link entry intact.
        assert!(
            tokio::fs::symlink_metadata(&absolute)
                .await
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // The relative link text must not be canonicalized or rewritten.
        assert_eq!(
            tokio::fs::read_link(&relative).await.unwrap(),
            PathBuf::from("target")
        );
        // The chain link text must likewise remain the caller-created relative value.
        assert_eq!(
            tokio::fs::read_link(&chain).await.unwrap(),
            PathBuf::from("relative")
        );
        // Every edit must target the original regular-file inode.
        assert_eq!(tokio::fs::metadata(&target).await.unwrap().ino(), inode);
        // The final edit through the chain must be visible at the target.
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"three");
    }

    #[tokio::test]
    async fn rejects_dangling_links_and_loops_without_altering_entries() {
        let temp = TempDir::create();
        let dangling = temp.path().join("dangling");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        symlink("missing", &dangling).unwrap();
        symlink("second", &first).unwrap();
        symlink("first", &second).unwrap();

        let dangling_error = EditSession::open(dangling.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        let loop_error = EditSession::open(first.to_string_lossy().into_owned())
            .await
            .unwrap_err();

        // A dangling target must map to the stable not-found response kind.
        assert_eq!(dangling_error.kind(), CommandErrorKind::NotFound);
        // Kernel ELOOP must become an actionable invalid-input response.
        assert_eq!(loop_error.kind(), CommandErrorKind::InvalidInput);
        // Failed setup must retain the dangling link text exactly.
        assert_eq!(
            tokio::fs::read_link(&dangling).await.unwrap(),
            PathBuf::from("missing")
        );
        // Failed loop setup must not unlink either member of the cycle.
        assert_eq!(
            tokio::fs::read_link(&first).await.unwrap(),
            PathBuf::from("second")
        );
    }

    #[tokio::test]
    async fn path_change_before_commit_returns_conflict_without_mutation() {
        let temp = TempDir::create();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let selected = temp.path().join("selected");
        tokio::fs::write(&first, b"first old").await.unwrap();
        tokio::fs::write(&second, b"second old").await.unwrap();
        symlink("first", &selected).unwrap();
        let mut session = EditSession::open(selected.to_string_lossy().into_owned())
            .await
            .unwrap();
        session.stage(b"replacement").await.unwrap();
        tokio::fs::remove_file(&selected).await.unwrap();
        symlink("second", &selected).unwrap();

        let error = session.commit().await.unwrap_err();

        // A namespace swap must be rejected as conflict before truncation.
        assert_eq!(error.kind(), CommandErrorKind::Conflict);
        // The originally pinned target must retain its old bytes.
        assert_eq!(tokio::fs::read(&first).await.unwrap(), b"first old");
        // The newly selected target must never receive the staged bytes.
        assert_eq!(tokio::fs::read(&second).await.unwrap(), b"second old");
    }

    #[tokio::test]
    async fn path_disappearance_before_commit_returns_conflict_without_mutation() {
        let temp = TempDir::create();
        let target = temp.path().join("target");
        let selected = temp.path().join("selected");
        tokio::fs::write(&target, b"old bytes").await.unwrap();
        symlink("target", &selected).unwrap();
        let mut session = EditSession::open(selected.to_string_lossy().into_owned())
            .await
            .unwrap();
        session.stage(b"replacement").await.unwrap();
        tokio::fs::remove_file(&selected).await.unwrap();

        let error = session.commit().await.unwrap_err();

        // Losing the selected pathname after setup is a race conflict, not a missing initial target.
        assert_eq!(error.kind(), CommandErrorKind::Conflict);
        // Identity failure must happen before the pinned target is truncated.
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"old bytes");
    }

    #[tokio::test]
    async fn rejects_non_absolute_directory_and_fifo_targets() {
        let temp = TempDir::create();
        let fifo = temp.path().join("fifo");
        let fifo_path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
        assert_eq!(
            result, 0,
            "FIFO fixture must be created for nonblocking setup coverage"
        );

        let relative_error = EditSession::open("relative".to_string()).await.unwrap_err();
        let directory_error = EditSession::open(temp.path().to_string_lossy().into_owned())
            .await
            .unwrap_err();
        let fifo_error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            EditSession::open(fifo.to_string_lossy().into_owned()),
        )
        .await
        .expect("FIFO open must not hang")
        .unwrap_err();

        // Relative commands are invalid at the agent trust boundary.
        assert_eq!(relative_error.kind(), CommandErrorKind::InvalidInput);
        // Directories have a dedicated stable error classification.
        assert_eq!(directory_error.kind(), CommandErrorKind::IsDirectory);
        // O_NONBLOCK must turn a FIFO into a prompt special-file rejection.
        assert_eq!(fifo_error.kind(), CommandErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn dropping_staged_edits_leaves_target_unchanged() {
        let temp = TempDir::create();
        let path = temp.path().join("target");
        tokio::fs::write(&path, b"original").await.unwrap();
        let before = tokio::fs::metadata(&path).await.unwrap();
        let mut session = EditSession::open(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        session.stage(b"partial replacement").await.unwrap();

        drop(session);
        let after = tokio::fs::metadata(&path).await.unwrap();

        // Missing terminal input must leave all original bytes untouched.
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"original");
        // Dropping staging must retain the original inode and mode.
        assert_eq!((after.ino(), after.mode()), (before.ino(), before.mode()));
    }

    #[tokio::test]
    async fn supports_zero_shorter_and_longer_replacements() {
        let temp = TempDir::create();
        let path = temp.path().join("target");
        tokio::fs::write(&path, b"initial bytes").await.unwrap();

        edit(&path, b"").await.unwrap();
        // A zero-byte terminal body must truncate the existing inode to empty.
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"");
        edit(&path, b"x").await.unwrap();
        // A shorter replacement must not leave stale tail bytes.
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"x");
        edit(&path, b"a much longer replacement").await.unwrap();
        // A longer replacement must stream fully from staging.
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            b"a much longer replacement"
        );
    }

    #[tokio::test]
    async fn permission_restore_never_reenables_cleared_special_bits() {
        let temp = TempDir::create();
        let path = temp.path().join("target");
        tokio::fs::write(&path, b"old").await.unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o6751))
            .await
            .unwrap();

        let mut session = EditSession::open(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        session.stage(b"new").await.unwrap();
        session
            .target
            .set_permissions(std::fs::Permissions::from_mode(0o751))
            .await
            .unwrap();
        session.commit().await.unwrap();
        let mode = tokio::fs::metadata(&path).await.unwrap().mode();

        // Mandatory ordinary bits survive even when special bits were cleared before commit.
        assert_eq!(mode & 0o777, 0o751);
        // Descriptor-based restoration must not re-enable the cleared setuid or setgid bits.
        assert_eq!(mode & 0o6000, 0);
    }

    #[tokio::test]
    async fn queued_terminal_wins_over_transfer_teardown_cancellation() {
        redoor::logging::init(None).await.unwrap();
        let temp = TempDir::create();
        let path = temp.path().join("target");
        tokio::fs::write(&path, b"old").await.unwrap();
        let session = EditSession::open(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        let active_uploads = ActiveUploads::new();
        let (chunk_sender, chunk_receiver) = mpsc::channel(8);
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        let request_id = RequestId::new(77);
        active_uploads.insert(
            request_id,
            UploadSessionHandle {
                path: path.to_string_lossy().into_owned(),
                chunk_sender: chunk_sender.clone(),
                cancel_sender,
            },
        );
        let (tx, mut rx) = mpsc::channel(1);
        chunk_sender
            .send(streaming::StreamChunk {
                request_id,
                chunk_index: redoor::types::ChunkIndex::new(0),
                is_last: false,
                is_error: false,
                payload_kind: StreamPayloadKind::RawFile,
                data: b"replacement".to_vec(),
            })
            .await
            .unwrap();
        chunk_sender
            .send(streaming::StreamChunk {
                request_id,
                chunk_index: redoor::types::ChunkIndex::new(1),
                is_last: true,
                is_error: false,
                payload_kind: StreamPayloadKind::RawFile,
                data: Vec::new(),
            })
            .await
            .unwrap();

        // Transfer teardown sets cancellation and drops registry senders after terminal delivery.
        active_uploads.clear();
        drop(chunk_sender);
        EditFileWorker {
            active_uploads: active_uploads.clone(),
            chunk_receiver,
            cancel_receiver,
            session,
            tx,
            agent_id: AgentId::from("agent-1"),
            request_id,
        }
        .process()
        .await;

        // A terminal already accepted by the FIFO channel authorizes commit despite later teardown.
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"replacement");
        // Completion must release worker ownership even though teardown cleared it first.
        assert!(!active_uploads.contains(request_id));
        let response = rx.recv().await.expect("edit completion response queued");
        let WsMessage::Text(text) = response else {
            panic!("edit completion must use the control text lane");
        };
        let message: redoor::types::Message = serde_json::from_str(&text).unwrap();
        // Success proves cancellation did not nondeterministically win after terminal receipt.
        assert!(matches!(
            message,
            redoor::types::Message::CommandResponse {
                request_id: response_id,
                result: CommandResult::EditFile,
                ..
            } if response_id == request_id
        ));
    }
}
