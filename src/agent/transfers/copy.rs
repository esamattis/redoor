use super::super::{AgentActor, AgentCommandError};
use super::destination::{
    DestinationPlaceError, check_existing_destination, place_temp_at_destination,
};
use redoor::{
    Level,
    commands::{CommandResult, CopyExistingMode, MoveSourceIdentity},
    log,
    types::{AgentId, Message, RequestId},
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

/// Keeps local-copy failures typed so the HTTP layer never has to infer them from text.
#[derive(Debug, Error)]
pub(crate) enum LocalCopyError {
    #[error("Failed to access source file: {0}")]
    AccessSourceFile(#[source] std::io::Error),
    #[error("Failed to access source directory: {0}")]
    AccessSourceDirectory(#[source] std::io::Error),
    #[error("Source path is not a file: {0}")]
    SourceNotFile(String),
    #[error("Source path is not a directory: {0}")]
    SourceNotDirectory(String),
    #[error("Source and destination must be different")]
    SamePath,
    #[error("Destination directory cannot be inside the source directory")]
    DestinationInsideSource,
    #[error("Destination parent not found for {0}")]
    DestinationParentNotFound(String),
    #[error("Destination parent is not a directory: {0}")]
    DestinationParentNotDirectory(String),
    #[error(transparent)]
    DestinationPlacement(#[from] DestinationPlaceError),
    #[error("Invalid source path: {0}")]
    InvalidSourcePath(String),
    #[error("Invalid destination path: {0}")]
    InvalidDestinationPath(String),
    #[error("Non-utf8 destination path: {0}")]
    NonUtf8DestinationPath(String),
    #[error("Failed to access source parent: {0}")]
    AccessSourceParent(String),
    #[error("Failed to access absolute source path: {0}")]
    AccessAbsoluteSourcePath(String),
    #[error("Failed to access destination parent: {0}")]
    AccessDestinationParent(String),
    #[error("Failed to open source file: {0}")]
    OpenSourceFile(String),
    #[error("Failed to create destination file: {0}")]
    CreateDestinationFile(String),
    #[error("Failed to read source file: {0}")]
    ReadSourceFile(String),
    #[error("Failed to write destination file: {0}")]
    WriteDestinationFile(String),
    #[error("Failed to flush destination file: {0}")]
    FlushDestinationFile(String),
    #[error("Failed to finalize copied file from {from} to {to}")]
    FinalizeCopiedFile { from: String, to: String },
    #[error("Failed to read directory: {0}")]
    ReadDirectory(String),
    #[error("Failed to read directory entry: {0}")]
    ReadDirectoryEntry(String),
    #[error("Failed to read entry metadata: {0}")]
    ReadEntryMetadata(String),
    #[error("Unsupported directory entry type in copy source: {0}")]
    UnsupportedEntryType(String),
    #[error("Failed to create destination directory: {0}")]
    CreateDestinationDirectory(String),
    #[error("Failed to create temp directory: {0}")]
    CreateTempDirectory(#[source] std::io::Error),
    #[error("Lost router connection while reporting local copy progress")]
    ProgressChannelClosed,
    #[error("Failed to rename move source to destination: {0}")]
    RenameMoveSource(#[source] std::io::Error),
    #[error("Failed to delete move source after copying: {0}")]
    DeleteMoveSource(#[source] std::io::Error),
    #[error("Move source changed while it was being copied; refusing to delete it")]
    MoveSourceChanged,
}

impl LocalCopyError {
    /// Maps one local-copy failure to the stable command error kind carried over the protocol.
    pub(crate) fn kind(&self) -> redoor::commands::CommandErrorKind {
        match self {
            Self::AccessSourceFile(error)
            | Self::AccessSourceDirectory(error)
            | Self::CreateTempDirectory(error) => {
                redoor::commands::CommandErrorKind::from_io_error(error)
            }
            Self::DestinationPlacement(error) => error.kind(),
            Self::RenameMoveSource(error) | Self::DeleteMoveSource(error) => {
                redoor::commands::CommandErrorKind::from_io_error(error)
            }
            Self::SourceNotDirectory(_) | Self::DestinationParentNotDirectory(_) => {
                redoor::commands::CommandErrorKind::NotADirectory
            }
            Self::SamePath
            | Self::DestinationInsideSource
            | Self::SourceNotFile(_)
            | Self::DestinationParentNotFound(_)
            | Self::InvalidSourcePath(_)
            | Self::InvalidDestinationPath(_)
            | Self::NonUtf8DestinationPath(_)
            | Self::UnsupportedEntryType(_) => redoor::commands::CommandErrorKind::InvalidInput,
            Self::MoveSourceChanged => redoor::commands::CommandErrorKind::InvalidInput,
            Self::AccessSourceParent(_)
            | Self::AccessAbsoluteSourcePath(_)
            | Self::AccessDestinationParent(_)
            | Self::OpenSourceFile(_)
            | Self::CreateDestinationFile(_)
            | Self::ReadSourceFile(_)
            | Self::WriteDestinationFile(_)
            | Self::FlushDestinationFile(_)
            | Self::FinalizeCopiedFile { .. }
            | Self::ReadDirectory(_)
            | Self::ReadDirectoryEntry(_)
            | Self::ReadEntryMetadata(_)
            | Self::CreateDestinationDirectory(_)
            | Self::ProgressChannelClosed => redoor::commands::CommandErrorKind::Internal,
        }
    }
}

/// Builds the hidden temp file path used while a local file copy is still incomplete.
fn temp_local_copy_path(path: &str) -> PathBuf {
    let destination = Path::new(path);
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("copy");
    let temp_name = format!(".{}.redoor-local-copy-{}", file_name, fastrand::u64(..));

    match destination.parent() {
        Some(parent) => parent.join(temp_name),
        None => PathBuf::from(format!("./{}", temp_name)),
    }
}

/// Removes one local-copy temp file or directory if it is still present.
async fn cleanup_local_copy_temp_path(path: &Path) {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_dir() => {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
        Ok(_) => {
            let _ = tokio::fs::remove_file(path).await;
        }
        Err(_) => {}
    }
}

/// Builds the hidden temp directory path used while a local directory copy is still incomplete.
fn temp_local_copy_dir_path(path: &str) -> PathBuf {
    let destination = Path::new(path);
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("copy-dir");
    let temp_name = format!(".{}.redoor-local-copy-dir-{}", file_name, fastrand::u64(..));

    match destination.parent() {
        Some(parent) => parent.join(temp_name),
        None => PathBuf::from(format!("./{}", temp_name)),
    }
}

/// Verifies the copy destination differs from the source and does not recurse into it.
async fn validate_local_copy_destination(
    source_path: &Path,
    dest_path: &Path,
    source_is_dir: bool,
) -> Result<(), LocalCopyError> {
    let source_parent = source_path
        .parent()
        .ok_or_else(|| LocalCopyError::InvalidSourcePath(source_path.display().to_string()))?;
    let dest_parent = dest_path.parent().ok_or_else(|| {
        LocalCopyError::DestinationParentNotFound(dest_path.display().to_string())
    })?;

    let canonical_source_parent = tokio::fs::canonicalize(source_parent)
        .await
        .map_err(|_| LocalCopyError::AccessSourceParent(source_parent.display().to_string()))?;
    let canonical_dest_parent = tokio::fs::canonicalize(dest_parent)
        .await
        .map_err(|_| LocalCopyError::AccessDestinationParent(dest_parent.display().to_string()))?;

    let source_canonical =
        if source_path.is_absolute() {
            tokio::fs::canonicalize(source_path).await.map_err(|_| {
                LocalCopyError::AccessAbsoluteSourcePath(source_path.display().to_string())
            })?
        } else {
            canonical_source_parent.join(source_path.file_name().ok_or_else(|| {
                LocalCopyError::InvalidSourcePath(source_path.display().to_string())
            })?)
        };

    let dest_effective =
        canonical_dest_parent.join(dest_path.file_name().ok_or_else(|| {
            LocalCopyError::InvalidDestinationPath(dest_path.display().to_string())
        })?);

    if source_canonical == dest_effective {
        return Err(LocalCopyError::SamePath);
    }

    if source_is_dir && dest_effective.starts_with(&source_canonical) {
        return Err(LocalCopyError::DestinationInsideSource);
    }

    Ok(())
}

/// Verifies the destination parent exists and is a directory before copy work begins.
async fn validate_local_copy_parent(dest_path: &Path) -> Result<(), LocalCopyError> {
    let parent = dest_path.parent().ok_or_else(|| {
        LocalCopyError::DestinationParentNotFound(dest_path.display().to_string())
    })?;
    let parent_metadata = tokio::fs::metadata(parent)
        .await
        .map_err(|_| LocalCopyError::AccessDestinationParent(parent.display().to_string()))?;
    if !parent_metadata.is_dir() {
        return Err(LocalCopyError::DestinationParentNotDirectory(
            parent.display().to_string(),
        ));
    }
    Ok(())
}

/// Reports local-copy byte progress over the websocket without spamming tiny updates.
struct LocalCopyProgressReporter {
    write: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    request_id: RequestId,
    total_bytes: u64,
    transferred_bytes: u64,
    last_reported_bytes: u64,
    last_reported_at: Instant,
}

impl LocalCopyProgressReporter {
    const REPORT_EVERY_BYTES: u64 = 1024 * 1024;
    const REPORT_EVERY_DURATION: Duration = Duration::from_millis(250);

    /// Starts tracking one local copy so progress is visible to the server UI.
    fn new(
        write: mpsc::Sender<WsMessage>,
        agent_id: AgentId,
        request_id: RequestId,
        total_bytes: u64,
    ) -> Self {
        Self {
            write,
            agent_id,
            request_id,
            total_bytes,
            transferred_bytes: 0,
            last_reported_bytes: 0,
            last_reported_at: Instant::now() - Self::REPORT_EVERY_DURATION,
        }
    }

    /// Emits a progress update once enough bytes or time have passed.
    async fn report(&mut self, force: bool) -> Result<(), LocalCopyError> {
        if self.write.is_closed() {
            return Err(LocalCopyError::ProgressChannelClosed);
        }

        let now = Instant::now();
        let should_report = force
            || self
                .transferred_bytes
                .saturating_sub(self.last_reported_bytes)
                >= Self::REPORT_EVERY_BYTES
            || now.saturating_duration_since(self.last_reported_at) >= Self::REPORT_EVERY_DURATION;

        if !should_report {
            return Ok(());
        }

        let message = Message::TransferProgressUpdate {
            agent_id: self.agent_id.clone(),
            request_id: self.request_id,
            transferred_bytes: self.transferred_bytes,
            total_bytes: Some(self.total_bytes),
        };

        let json =
            serde_json::to_string(&message).map_err(|_| LocalCopyError::ProgressChannelClosed)?;
        self.write
            .send(WsMessage::text(json))
            .await
            .map_err(|_| LocalCopyError::ProgressChannelClosed)?;

        self.last_reported_bytes = self.transferred_bytes;
        self.last_reported_at = now;
        Ok(())
    }

    /// Adds copied bytes and reports if the throttle allows it.
    async fn advance(&mut self, bytes: u64) -> Result<(), LocalCopyError> {
        self.transferred_bytes = self.transferred_bytes.saturating_add(bytes);
        self.report(false).await
    }

    /// Expands an initially unknown directory total as traversal discovers regular files.
    fn add_total_bytes(&mut self, bytes: u64) {
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }

    /// Forces the final progress update so the UI lands on 100%.
    async fn finish(&mut self) -> Result<(), LocalCopyError> {
        self.transferred_bytes = self.total_bytes;
        self.report(true).await
    }
}

/// Holds the protocol response plumbing shared by local copy operations.
pub(crate) struct LocalCopyResponseContext<'a> {
    pub(crate) write: &'a mpsc::Sender<WsMessage>,
    pub(crate) agent_id: &'a AgentId,
    pub(crate) request_id: RequestId,
}

/// Copies one file through a temp file so partially copied output is never exposed as final data.
async fn copy_file_streaming(
    source_path: &Path,
    dest_path: &Path,
    temp_path: &Path,
    reporter: &mut LocalCopyProgressReporter,
) -> Result<(), LocalCopyError> {
    stream_file_to_temp(source_path, temp_path, reporter).await?;

    tokio::fs::rename(temp_path, dest_path).await.map_err(|_| {
        LocalCopyError::FinalizeCopiedFile {
            from: temp_path.display().to_string(),
            to: dest_path.display().to_string(),
        }
    })?;

    Ok(())
}

/// Streams one source file into a temp path without publishing the final destination yet.
async fn stream_file_to_temp(
    source_path: &Path,
    temp_path: &Path,
    reporter: &mut LocalCopyProgressReporter,
) -> Result<(), LocalCopyError> {
    let mut source = File::open(source_path)
        .await
        .map_err(|_| LocalCopyError::OpenSourceFile(source_path.display().to_string()))?;

    let mut destination = File::create(temp_path)
        .await
        .map_err(|_| LocalCopyError::CreateDestinationFile(temp_path.display().to_string()))?;

    let mut buffer = vec![0u8; 1024 * 1024];

    loop {
        let bytes_read = source
            .read(&mut buffer)
            .await
            .map_err(|_| LocalCopyError::ReadSourceFile(source_path.display().to_string()))?;

        if bytes_read == 0 {
            break;
        }

        destination
            .write_all(&buffer[..bytes_read])
            .await
            .map_err(|_| LocalCopyError::WriteDestinationFile(temp_path.display().to_string()))?;

        reporter.advance(bytes_read as u64).await?;
    }

    destination
        .flush()
        .await
        .map_err(|_| LocalCopyError::FlushDestinationFile(temp_path.display().to_string()))?;
    drop(destination);

    Ok(())
}

/// Traverses and copies a directory incrementally so memory grows with depth, not entry count.
async fn copy_directory_streaming(
    source_root: &Path,
    temp_dest_root: &Path,
    reporter: &mut LocalCopyProgressReporter,
) -> std::result::Result<(), LocalCopyError> {
    let root_entries = tokio::fs::read_dir(source_root)
        .await
        .map_err(|_| LocalCopyError::ReadDirectory(source_root.display().to_string()))?;
    let mut stack = vec![(
        source_root.to_path_buf(),
        temp_dest_root.to_path_buf(),
        root_entries,
    )];

    while !stack.is_empty() {
        let entry = {
            let (source_dir, _, entries) = stack.last_mut().expect("stack is known non-empty");
            entries
                .next_entry()
                .await
                .map_err(|_| LocalCopyError::ReadDirectoryEntry(source_dir.display().to_string()))?
        };
        let Some(entry) = entry else {
            stack.pop();
            continue;
        };
        let entry_path = entry.path();
        let metadata = tokio::fs::symlink_metadata(&entry_path)
            .await
            .map_err(|_| LocalCopyError::ReadEntryMetadata(entry_path.display().to_string()))?;
        let destination_path = stack
            .last()
            .expect("the current directory remains on the stack")
            .1
            .join(entry.file_name());

        if metadata.is_dir() {
            tokio::fs::create_dir(&destination_path)
                .await
                .map_err(|_| {
                    LocalCopyError::CreateDestinationDirectory(
                        destination_path.display().to_string(),
                    )
                })?;
            let entries = tokio::fs::read_dir(&entry_path)
                .await
                .map_err(|_| LocalCopyError::ReadDirectory(entry_path.display().to_string()))?;
            stack.push((entry_path, destination_path, entries));
        } else if metadata.is_file() {
            reporter.add_total_bytes(metadata.len());
            let temp_path = temp_local_copy_path_for_destination(&destination_path)?;
            copy_file_streaming(&entry_path, &destination_path, &temp_path, reporter).await?;
        } else {
            return Err(LocalCopyError::UnsupportedEntryType(
                entry_path.display().to_string(),
            ));
        }
    }

    Ok(())
}

impl AgentActor {
    /// Sends a consistent local-copy error response back to the router.
    async fn send_local_copy_error(
        &self,
        response: &LocalCopyResponseContext<'_>,
        error: LocalCopyError,
    ) {
        self.send_command_response(
            response.write,
            response.agent_id,
            response.request_id,
            AgentCommandError::from(error).into(),
        )
        .await;
    }

    /// Performs a same-agent file copy through a temp file so readers never see partial output.
    pub(crate) async fn local_copy_file(
        &self,
        source_path: String,
        dest_path: String,
        on_existing: CopyExistingMode,
        response: LocalCopyResponseContext<'_>,
    ) {
        log!(
            Level::Info,
            "Started local copy file: request_id={}, source={}, dest={}, on_existing={:?}",
            response.request_id,
            source_path,
            dest_path,
            on_existing
        );
        match self
            .run_local_copy_file(source_path, dest_path, on_existing, &response)
            .await
        {
            Ok(result) => {
                log!(
                    Level::Info,
                    "Local copy file complete: request_id={}, result={}",
                    response.request_id,
                    result.summary()
                );
                self.send_command_response(
                    response.write,
                    response.agent_id,
                    response.request_id,
                    result,
                )
                .await;
            }
            Err(error) => {
                log!(
                    Level::Info,
                    "Local copy file failed: request_id={}, error={}",
                    response.request_id,
                    error
                );
                self.send_local_copy_error(&response, error).await;
            }
        }
    }

    /// Executes one same-agent file copy and returns the final protocol result.
    async fn run_local_copy_file(
        &self,
        source_path: String,
        dest_path: String,
        on_existing: CopyExistingMode,
        response: &LocalCopyResponseContext<'_>,
    ) -> Result<CommandResult, LocalCopyError> {
        let source_path_buf = PathBuf::from(&source_path);
        let dest_path_buf = PathBuf::from(&dest_path);

        let source_metadata = tokio::fs::metadata(&source_path_buf)
            .await
            .map_err(LocalCopyError::AccessSourceFile)?;

        if !source_metadata.is_file() {
            return Err(LocalCopyError::SourceNotFile(source_path));
        }

        validate_local_copy_destination(&source_path_buf, &dest_path_buf, false).await?;
        validate_local_copy_parent(&dest_path_buf).await?;
        check_existing_destination(&dest_path_buf, on_existing, false).await?;

        let mut reporter = LocalCopyProgressReporter::new(
            response.write.clone(),
            response.agent_id.clone(),
            response.request_id,
            source_metadata.len(),
        );
        let temp_path = temp_local_copy_path_for_destination(&dest_path_buf)?;

        reporter.report(true).await?;

        match stream_file_to_temp(&source_path_buf, &temp_path, &mut reporter).await {
            Ok(()) => {
                if let Err(error) =
                    place_temp_at_destination(&temp_path, &dest_path_buf, on_existing, false).await
                {
                    cleanup_local_copy_temp_path(&temp_path).await;
                    return Err(LocalCopyError::from(error));
                }
                if let Err(error) = reporter.finish().await {
                    cleanup_local_copy_temp_path(&temp_path).await;
                    return Err(error);
                }
                Ok(CommandResult::LocalCopyFile)
            }
            Err(error) => {
                cleanup_local_copy_temp_path(&temp_path).await;
                Err(error)
            }
        }
    }

    /// Performs a same-agent directory copy by planning first and then streaming file contents.
    pub(crate) async fn local_copy_directory(
        &self,
        source_path: String,
        dest_path: String,
        on_existing: CopyExistingMode,
        response: LocalCopyResponseContext<'_>,
    ) {
        log!(
            Level::Info,
            "Started local copy directory: request_id={}, source={}, dest={}, on_existing={:?}",
            response.request_id,
            source_path,
            dest_path,
            on_existing
        );
        match self
            .run_local_copy_directory(source_path, dest_path, on_existing, &response)
            .await
        {
            Ok(result) => {
                log!(
                    Level::Info,
                    "Local copy directory complete: request_id={}, result={}",
                    response.request_id,
                    result.summary()
                );
                self.send_command_response(
                    response.write,
                    response.agent_id,
                    response.request_id,
                    result,
                )
                .await;
            }
            Err(error) => {
                log!(
                    Level::Info,
                    "Local copy directory failed: request_id={}, error={}",
                    response.request_id,
                    error
                );
                self.send_local_copy_error(&response, error).await;
            }
        }
    }

    /// Executes one same-agent directory copy and returns the final protocol result.
    async fn run_local_copy_directory(
        &self,
        source_path: String,
        dest_path: String,
        on_existing: CopyExistingMode,
        response: &LocalCopyResponseContext<'_>,
    ) -> Result<CommandResult, LocalCopyError> {
        let source_path_buf = PathBuf::from(&source_path);
        let dest_path_buf = PathBuf::from(&dest_path);

        let source_metadata = tokio::fs::metadata(&source_path_buf)
            .await
            .map_err(LocalCopyError::AccessSourceDirectory)?;

        if !source_metadata.is_dir() {
            return Err(LocalCopyError::SourceNotDirectory(source_path));
        }

        validate_local_copy_destination(&source_path_buf, &dest_path_buf, true).await?;
        validate_local_copy_parent(&dest_path_buf).await?;
        check_existing_destination(&dest_path_buf, on_existing, true).await?;

        let temp_dest_root = temp_local_copy_dir_path(&dest_path);

        tokio::fs::create_dir(&temp_dest_root)
            .await
            .map_err(LocalCopyError::CreateTempDirectory)?;

        let mut reporter = LocalCopyProgressReporter::new(
            response.write.clone(),
            response.agent_id.clone(),
            response.request_id,
            0,
        );

        if let Err(error) = reporter.report(true).await {
            let _ = tokio::fs::remove_dir_all(&temp_dest_root).await;
            return Err(error);
        }

        match copy_directory_streaming(&source_path_buf, &temp_dest_root, &mut reporter).await {
            Ok(()) => {
                if let Err(error) =
                    place_temp_at_destination(&temp_dest_root, &dest_path_buf, on_existing, true)
                        .await
                {
                    let _ = tokio::fs::remove_dir_all(&temp_dest_root).await;
                    return Err(LocalCopyError::from(error));
                }

                if let Err(error) = reporter.finish().await {
                    let _ = tokio::fs::remove_dir_all(&temp_dest_root).await;
                    return Err(error);
                }
                Ok(CommandResult::LocalCopyDirectory)
            }
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&temp_dest_root).await;
                Err(error)
            }
        }
    }

    /// Moves a same-agent path atomically when possible and otherwise copies before deleting.
    pub(crate) async fn local_move(
        &self,
        source_path: String,
        dest_path: String,
        source_is_directory: bool,
        expected_identity: MoveSourceIdentity,
        on_existing: CopyExistingMode,
        response: LocalCopyResponseContext<'_>,
    ) {
        let result = self
            .run_local_move(
                source_path,
                dest_path,
                source_is_directory,
                expected_identity,
                on_existing,
                &response,
            )
            .await;
        let result = match result {
            Ok(()) => CommandResult::LocalMove,
            Err(error) => AgentCommandError::from(error).into(),
        };
        self.send_command_response(
            response.write,
            response.agent_id,
            response.request_id,
            result,
        )
        .await;
    }

    /// Keeps source deletion after successful publication while selecting the cheap rename path.
    async fn run_local_move(
        &self,
        source_path: String,
        dest_path: String,
        source_is_directory: bool,
        expected_identity: MoveSourceIdentity,
        on_existing: CopyExistingMode,
        response: &LocalCopyResponseContext<'_>,
    ) -> Result<(), LocalCopyError> {
        let source = PathBuf::from(&source_path);
        let dest = PathBuf::from(&dest_path);
        validate_local_copy_destination(&source, &dest, source_is_directory).await?;
        validate_local_copy_parent(&dest).await?;
        check_existing_destination(&dest, on_existing, source_is_directory).await?;

        let source_metadata = tokio::fs::metadata(&source).await.map_err(|error| {
            if source_is_directory {
                LocalCopyError::AccessSourceDirectory(error)
            } else {
                LocalCopyError::AccessSourceFile(error)
            }
        })?;
        if source_is_directory != source_metadata.is_dir()
            || (!source_is_directory && !source_metadata.is_file())
        {
            return Err(if source_is_directory {
                LocalCopyError::SourceNotDirectory(source_path)
            } else {
                LocalCopyError::SourceNotFile(source_path)
            });
        }
        if move_source_identity(&source_metadata) != expected_identity {
            return Err(LocalCopyError::MoveSourceChanged);
        }

        let destination_exists = tokio::fs::try_exists(&dest)
            .await
            .map_err(DestinationPlaceError::CheckDestinationPath)?;
        let dest_parent = dest
            .parent()
            .ok_or_else(|| LocalCopyError::DestinationParentNotFound(dest.display().to_string()))?;
        let dest_parent_metadata = tokio::fs::metadata(dest_parent).await.map_err(|_| {
            LocalCopyError::AccessDestinationParent(dest_parent.display().to_string())
        })?;
        let same_mount = metadata_on_same_mount(&source_metadata, &dest_parent_metadata);

        if can_use_atomic_rename(same_mount, destination_exists) {
            match rename_without_replacement(source.clone(), dest.clone()).await {
                Ok(AtomicRenameResult::Renamed) => return Ok(()),
                Ok(AtomicRenameResult::FallbackRequired) => {}
                Err(error) => return Err(LocalCopyError::RenameMoveSource(error)),
            }
        }

        if source_is_directory {
            self.run_local_copy_directory(source_path.clone(), dest_path, on_existing, response)
                .await?;
            verify_move_source_identity(&source, &expected_identity).await?;
            tokio::fs::remove_dir_all(source)
                .await
                .map_err(LocalCopyError::DeleteMoveSource)?;
        } else {
            self.run_local_copy_file(source_path.clone(), dest_path, on_existing, response)
                .await?;
            verify_move_source_identity(&source, &expected_identity).await?;
            tokio::fs::remove_file(source)
                .await
                .map_err(LocalCopyError::DeleteMoveSource)?;
        }
        Ok(())
    }
}

/// Identifies one local source for conditional cleanup after copy publication.
fn move_source_identity(metadata: &std::fs::Metadata) -> MoveSourceIdentity {
    use std::os::unix::fs::MetadataExt;

    MoveSourceIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        is_directory: metadata.is_dir(),
    }
}

/// Refuses destructive cleanup if a source pathname now resolves to another object.
async fn verify_move_source_identity(
    source: &Path,
    expected_identity: &MoveSourceIdentity,
) -> Result<(), LocalCopyError> {
    let metadata = tokio::fs::metadata(source)
        .await
        .map_err(LocalCopyError::DeleteMoveSource)?;
    if move_source_identity(&metadata) != *expected_identity {
        return Err(LocalCopyError::MoveSourceChanged);
    }
    Ok(())
}

/// Outcome of a no-replace rename attempt that may require copy semantics instead.
enum AtomicRenameResult {
    Renamed,
    FallbackRequired,
}

#[cfg(target_os = "linux")]
/// Uses `renameat2` so a destination created after preflight can never be overwritten.
async fn rename_without_replacement(
    source: PathBuf,
    dest: PathBuf,
) -> std::io::Result<AtomicRenameResult> {
    tokio::task::spawn_blocking(move || {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let dest = CString::new(dest.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                dest.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            return Ok(AtomicRenameResult::Renamed);
        }
        let error = std::io::Error::last_os_error();
        if matches!(
            error.raw_os_error(),
            Some(libc::EEXIST) | Some(libc::EXDEV) | Some(libc::ENOSYS)
        ) {
            Ok(AtomicRenameResult::FallbackRequired)
        } else {
            Err(error)
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(not(target_os = "linux"))]
/// Conservatively falls back where an atomic no-replace rename primitive is unavailable.
async fn rename_without_replacement(
    _source: PathBuf,
    _dest: PathBuf,
) -> std::io::Result<AtomicRenameResult> {
    Ok(AtomicRenameResult::FallbackRequired)
}

/// Atomic replacement is avoided for existing destinations so copy conflict semantics stay exact.
fn can_use_atomic_rename(same_mount: bool, destination_exists: bool) -> bool {
    same_mount && !destination_exists
}

#[cfg(unix)]
/// Device ids provide a cheap preflight while rename remains authoritative for cross-device races.
fn metadata_on_same_mount(source: &std::fs::Metadata, dest_parent: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    source.dev() == dest_parent.dev()
}

#[cfg(not(unix))]
/// Platforms without device ids conservatively use copy/delete rather than assuming atomicity.
fn metadata_on_same_mount(_source: &std::fs::Metadata, _dest_parent: &std::fs::Metadata) -> bool {
    false
}

/// Builds the temp copy path from one validated destination path.
fn temp_local_copy_path_for_destination(dest_path: &Path) -> Result<PathBuf, LocalCopyError> {
    Ok(temp_local_copy_path(dest_path.to_str().ok_or_else(
        || LocalCopyError::NonUtf8DestinationPath(dest_path.display().to_string()),
    )?))
}

#[cfg(test)]
fn unique_test_path(prefix: &str) -> PathBuf {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "redoor-{prefix}-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentActor;

    #[test]
    fn atomic_move_requires_same_mount_and_missing_destination() {
        assert!(
            can_use_atomic_rename(true, false),
            "same-mount moves to missing destinations should use atomic rename"
        );
        assert!(
            !can_use_atomic_rename(false, false),
            "different mounts must fall back to copy/delete"
        );
        assert!(
            !can_use_atomic_rename(true, true),
            "existing destinations need copy placement semantics before source deletion"
        );
    }
    use redoor::commands::{CommandErrorKind, CommandResult};

    #[tokio::test]
    async fn local_copy_file_fails_when_progress_channel_is_closed() {
        let source_path = unique_test_path("local-copy-source");
        let dest_path = unique_test_path("local-copy-dest");
        let source_contents = b"copy me";
        tokio::fs::write(&source_path, source_contents)
            .await
            .expect("test source file should be created");

        let (write_tx, write_rx) = mpsc::channel(1);
        drop(write_rx);

        AgentActor
            .local_copy_file(
                source_path.display().to_string(),
                dest_path.display().to_string(),
                CopyExistingMode::Error,
                LocalCopyResponseContext {
                    write: &write_tx,
                    agent_id: &AgentId::from("agent-1"),
                    request_id: RequestId::new(42),
                },
            )
            .await;

        assert!(
            !tokio::fs::try_exists(&dest_path)
                .await
                .expect("destination existence should be readable"),
            "the destination should stay absent when the router text lane has already closed"
        );

        let parent = dest_path
            .parent()
            .expect("temp test file should have a parent");
        let file_name = dest_path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("temp test file name should stay utf-8");
        let mut entries = tokio::fs::read_dir(parent)
            .await
            .expect("temp test parent should stay readable");
        while let Some(entry) = entries
            .next_entry()
            .await
            .expect("temp test directory iteration should succeed")
        {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !entry_name.contains(&format!(".{file_name}.redoor-local-copy-")),
                "failed local copies should remove their temp file instead of leaking hidden copy output"
            );
        }

        let _ = tokio::fs::remove_file(&source_path).await;
    }

    #[tokio::test]
    async fn local_copy_progress_reporter_surfaces_closed_channel() {
        let (write_tx, write_rx) = mpsc::channel(1);
        drop(write_rx);
        let mut reporter = LocalCopyProgressReporter::new(
            write_tx,
            AgentId::from("agent-1"),
            RequestId::new(7),
            10,
        );

        let error = reporter
            .report(true)
            .await
            .expect_err("closed text lanes should stop local copy reporting immediately");

        assert!(
            matches!(error, LocalCopyError::ProgressChannelClosed),
            "the reporter should return a dedicated connection-health error so the copy can abort cleanly"
        );
        assert_eq!(
            error.kind(),
            CommandErrorKind::Internal,
            "the surfaced protocol error kind should stay stable for router-side handling"
        );
        let command_result: CommandResult = AgentCommandError::from(error).into();
        assert!(
            matches!(
                command_result,
                CommandResult::Error {
                    kind: CommandErrorKind::Internal,
                    ..
                }
            ),
            "connection-loss during local copy reporting should become a final command error if it can still be sent"
        );
    }
}
