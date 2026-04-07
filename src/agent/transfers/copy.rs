use super::super::{AgentActor, AgentCommandError};
use redoor::{
    commands::CommandResult,
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
    #[error("Destination already exists: {0}")]
    DestinationAlreadyExists(String),
    #[error("Failed to check destination path: {0}")]
    CheckDestinationPath(#[source] std::io::Error),
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
    #[error("Failed to strip source prefix {source_root} from {entry_path}")]
    StripSourcePrefix {
        source_root: String,
        entry_path: String,
    },
    #[error("Failed to read entry metadata: {0}")]
    ReadEntryMetadata(String),
    #[error("Unsupported directory entry type in copy source: {0}")]
    UnsupportedEntryType(String),
    #[error("Failed to read source metadata: {0}")]
    ReadSourceMetadata(String),
    #[error("Failed to create destination directory: {0}")]
    CreateDestinationDirectory(String),
    #[error("Directory copy planner failed: {0}")]
    PlannerFailed(String),
    #[error("Failed to create temp directory: {0}")]
    CreateTempDirectory(#[source] std::io::Error),
    #[error("Failed to finalize copied directory: {0}")]
    FinalizeCopiedDirectory(#[source] std::io::Error),
}

impl LocalCopyError {
    /// Maps one local-copy failure to the stable command error kind carried over the protocol.
    pub(crate) fn kind(&self) -> redoor::commands::CommandErrorKind {
        match self {
            Self::AccessSourceFile(error)
            | Self::AccessSourceDirectory(error)
            | Self::CheckDestinationPath(error)
            | Self::CreateTempDirectory(error)
            | Self::FinalizeCopiedDirectory(error) => {
                redoor::commands::CommandErrorKind::from_io_error(error)
            }
            Self::SourceNotDirectory(_) | Self::DestinationParentNotDirectory(_) => {
                redoor::commands::CommandErrorKind::NotADirectory
            }
            Self::DestinationAlreadyExists(_) => redoor::commands::CommandErrorKind::AlreadyExists,
            Self::SamePath
            | Self::DestinationInsideSource
            | Self::SourceNotFile(_)
            | Self::DestinationParentNotFound(_)
            | Self::InvalidSourcePath(_)
            | Self::InvalidDestinationPath(_)
            | Self::NonUtf8DestinationPath(_)
            | Self::UnsupportedEntryType(_) => redoor::commands::CommandErrorKind::InvalidInput,
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
            | Self::StripSourcePrefix { .. }
            | Self::ReadEntryMetadata(_)
            | Self::ReadSourceMetadata(_)
            | Self::CreateDestinationDirectory(_)
            | Self::PlannerFailed(_) => redoor::commands::CommandErrorKind::Internal,
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
fn validate_local_copy_destination(
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

    let canonical_source_parent = std::fs::canonicalize(source_parent)
        .map_err(|_| LocalCopyError::AccessSourceParent(source_parent.display().to_string()))?;
    let canonical_dest_parent = std::fs::canonicalize(dest_parent)
        .map_err(|_| LocalCopyError::AccessDestinationParent(dest_parent.display().to_string()))?;

    let source_canonical =
        if source_path.is_absolute() {
            std::fs::canonicalize(source_path).map_err(|_| {
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
    async fn report(&mut self, force: bool) {
        let now = Instant::now();
        let should_report = force
            || self
                .transferred_bytes
                .saturating_sub(self.last_reported_bytes)
                >= Self::REPORT_EVERY_BYTES
            || now.saturating_duration_since(self.last_reported_at) >= Self::REPORT_EVERY_DURATION;

        if !should_report {
            return;
        }

        let message = Message::TransferProgressUpdate {
            agent_id: self.agent_id.clone(),
            request_id: self.request_id,
            transferred_bytes: self.transferred_bytes,
            total_bytes: Some(self.total_bytes),
        };

        if let Ok(json) = serde_json::to_string(&message) {
            let _ = self.write.send(WsMessage::text(json)).await;
        }

        self.last_reported_bytes = self.transferred_bytes;
        self.last_reported_at = now;
    }

    /// Adds copied bytes and reports if the throttle allows it.
    async fn advance(&mut self, bytes: u64) {
        self.transferred_bytes = self.transferred_bytes.saturating_add(bytes);
        self.report(false).await;
    }

    /// Forces the final progress update so the UI lands on 100%.
    async fn finish(&mut self) {
        self.transferred_bytes = self.total_bytes;
        self.report(true).await;
    }
}

/// Copies one file through a temp file so partially copied output is never exposed as final data.
async fn copy_file_streaming(
    source_path: &Path,
    dest_path: &Path,
    reporter: &mut LocalCopyProgressReporter,
) -> Result<(), LocalCopyError> {
    let mut source = File::open(source_path)
        .await
        .map_err(|_| LocalCopyError::OpenSourceFile(source_path.display().to_string()))?;
    let temp_path =
        temp_local_copy_path(dest_path.to_str().ok_or_else(|| {
            LocalCopyError::NonUtf8DestinationPath(dest_path.display().to_string())
        })?);

    let mut destination = File::create(&temp_path)
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

        reporter.advance(bytes_read as u64).await;
    }

    destination
        .flush()
        .await
        .map_err(|_| LocalCopyError::FlushDestinationFile(temp_path.display().to_string()))?;
    drop(destination);

    tokio::fs::rename(&temp_path, dest_path)
        .await
        .map_err(|_| LocalCopyError::FinalizeCopiedFile {
            from: temp_path.display().to_string(),
            to: dest_path.display().to_string(),
        })?;

    Ok(())
}

/// Describes the sorted directory traversal needed to stream a tree copy safely.
struct DirectoryCopyPlan {
    total_bytes: u64,
    directories: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

/// Builds the deterministic directory traversal plan used to copy trees without loading file data eagerly.
fn build_directory_copy_plan(
    source_root: &Path,
) -> std::result::Result<DirectoryCopyPlan, LocalCopyError> {
    fn walk(
        source_root: &Path,
        current_path: &Path,
        plan: &mut DirectoryCopyPlan,
    ) -> Result<(), LocalCopyError> {
        let mut entries = std::fs::read_dir(current_path)
            .map_err(|_| LocalCopyError::ReadDirectory(current_path.display().to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| LocalCopyError::ReadDirectoryEntry(current_path.display().to_string()))?;

        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let entry_path = entry.path();
            let relative_path = entry_path
                .strip_prefix(source_root)
                .map_err(|_| LocalCopyError::StripSourcePrefix {
                    source_root: source_root.display().to_string(),
                    entry_path: entry_path.display().to_string(),
                })?
                .to_path_buf();
            let metadata = std::fs::symlink_metadata(&entry_path)
                .map_err(|_| LocalCopyError::ReadEntryMetadata(entry_path.display().to_string()))?;

            if metadata.is_dir() {
                plan.directories.push(relative_path.clone());
                walk(source_root, &entry_path, plan)?;
            } else if metadata.is_file() {
                plan.total_bytes = plan.total_bytes.saturating_add(metadata.len());
                plan.files.push(relative_path);
            } else {
                return Err(LocalCopyError::UnsupportedEntryType(
                    entry_path.display().to_string(),
                ));
            }
        }

        Ok(())
    }

    let source_metadata = std::fs::symlink_metadata(source_root)
        .map_err(|_| LocalCopyError::ReadSourceMetadata(source_root.display().to_string()))?;
    if !source_metadata.is_dir() {
        return Err(LocalCopyError::SourceNotDirectory(
            source_root.display().to_string(),
        ));
    }

    let mut plan = DirectoryCopyPlan {
        total_bytes: 0,
        directories: Vec::new(),
        files: Vec::new(),
    };
    walk(source_root, source_root, &mut plan)?;
    Ok(plan)
}

/// Executes a prepared directory copy plan so planning and streaming work remain separate.
async fn copy_directory_from_plan(
    source_root: &Path,
    temp_dest_root: &Path,
    plan: &DirectoryCopyPlan,
    reporter: &mut LocalCopyProgressReporter,
) -> std::result::Result<(), LocalCopyError> {
    for directory in &plan.directories {
        let destination_directory = temp_dest_root.join(directory);
        tokio::fs::create_dir_all(&destination_directory)
            .await
            .map_err(|_| {
                LocalCopyError::CreateDestinationDirectory(
                    destination_directory.display().to_string(),
                )
            })?;
    }

    for relative_path in &plan.files {
        let source_path = source_root.join(relative_path);
        let dest_path = temp_dest_root.join(relative_path);

        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|_| {
                LocalCopyError::CreateDestinationDirectory(parent.display().to_string())
            })?;
        }

        copy_file_streaming(&source_path, &dest_path, reporter).await?;
    }

    Ok(())
}

impl AgentActor {
    /// Sends a consistent local-copy error response back to the router.
    async fn send_local_copy_error(
        &self,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
        request_id: RequestId,
        error: LocalCopyError,
    ) {
        self.send_command_response(
            write,
            agent_id,
            request_id,
            AgentCommandError::from(error).into(),
        )
        .await;
    }

    /// Performs a same-agent file copy through a temp file so readers never see partial output.
    pub(crate) async fn local_copy_file(
        &self,
        source_path: String,
        dest_path: String,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
    ) {
        let source_path_buf = PathBuf::from(&source_path);
        let dest_path_buf = PathBuf::from(&dest_path);

        let source_metadata = match tokio::fs::metadata(&source_path_buf).await {
            Ok(metadata) => metadata,
            Err(error) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::AccessSourceFile(error),
                )
                .await;
                return;
            }
        };

        if !source_metadata.is_file() {
            self.send_local_copy_error(
                write,
                agent_id,
                request_id,
                LocalCopyError::SourceNotFile(source_path.clone()),
            )
            .await;
            return;
        }

        if let Err(error) = validate_local_copy_destination(&source_path_buf, &dest_path_buf, false)
        {
            self.send_local_copy_error(write, agent_id, request_id, error)
                .await;
            return;
        }

        if let Err(error) = validate_local_copy_parent(&dest_path_buf).await {
            self.send_local_copy_error(write, agent_id, request_id, error)
                .await;
            return;
        }

        match tokio::fs::try_exists(&dest_path_buf).await {
            Ok(true) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::DestinationAlreadyExists(dest_path.clone()),
                )
                .await;
                return;
            }
            Ok(false) => {}
            Err(error) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::CheckDestinationPath(error),
                )
                .await;
                return;
            }
        }

        let mut reporter = LocalCopyProgressReporter::new(
            write.clone(),
            agent_id.clone(),
            request_id,
            source_metadata.len(),
        );

        reporter.report(true).await;

        match copy_file_streaming(&source_path_buf, &dest_path_buf, &mut reporter).await {
            Ok(()) => {
                reporter.finish().await;
                self.send_command_response(
                    write,
                    agent_id,
                    request_id,
                    CommandResult::LocalCopyFile,
                )
                .await;
            }
            Err(error) => {
                let temp_path = temp_local_copy_path(&dest_path);
                let _ = tokio::fs::remove_file(&temp_path).await;
                self.send_local_copy_error(write, agent_id, request_id, error)
                    .await;
            }
        }
    }

    /// Performs a same-agent directory copy by planning first and then streaming file contents.
    pub(crate) async fn local_copy_directory(
        &self,
        source_path: String,
        dest_path: String,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &AgentId,
    ) {
        let source_path_buf = PathBuf::from(&source_path);
        let dest_path_buf = PathBuf::from(&dest_path);

        let source_metadata = match tokio::fs::metadata(&source_path_buf).await {
            Ok(metadata) => metadata,
            Err(error) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::AccessSourceDirectory(error),
                )
                .await;
                return;
            }
        };

        if !source_metadata.is_dir() {
            self.send_local_copy_error(
                write,
                agent_id,
                request_id,
                LocalCopyError::SourceNotDirectory(source_path.clone()),
            )
            .await;
            return;
        }

        if let Err(error) = validate_local_copy_destination(&source_path_buf, &dest_path_buf, true)
        {
            self.send_local_copy_error(write, agent_id, request_id, error)
                .await;
            return;
        }

        if let Err(error) = validate_local_copy_parent(&dest_path_buf).await {
            self.send_local_copy_error(write, agent_id, request_id, error)
                .await;
            return;
        }

        match tokio::fs::try_exists(&dest_path_buf).await {
            Ok(true) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::DestinationAlreadyExists(dest_path.clone()),
                )
                .await;
                return;
            }
            Ok(false) => {}
            Err(error) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::CheckDestinationPath(error),
                )
                .await;
                return;
            }
        }

        let plan = match tokio::task::spawn_blocking({
            let source_path_buf = source_path_buf.clone();
            move || build_directory_copy_plan(&source_path_buf)
        })
        .await
        {
            Ok(Ok(plan)) => plan,
            Ok(Err(error)) => {
                self.send_local_copy_error(write, agent_id, request_id, error)
                    .await;
                return;
            }
            Err(error) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    LocalCopyError::PlannerFailed(error.to_string()),
                )
                .await;
                return;
            }
        };

        let temp_dest_root = temp_local_copy_dir_path(&dest_path);

        if let Err(error) = tokio::fs::create_dir(&temp_dest_root).await {
            self.send_local_copy_error(
                write,
                agent_id,
                request_id,
                LocalCopyError::CreateTempDirectory(error),
            )
            .await;
            return;
        }

        let mut reporter = LocalCopyProgressReporter::new(
            write.clone(),
            agent_id.clone(),
            request_id,
            plan.total_bytes,
        );

        reporter.report(true).await;

        match copy_directory_from_plan(&source_path_buf, &temp_dest_root, &plan, &mut reporter)
            .await
        {
            Ok(()) => {
                if let Err(error) = tokio::fs::rename(&temp_dest_root, &dest_path_buf).await {
                    let _ = tokio::fs::remove_dir_all(&temp_dest_root).await;
                    self.send_local_copy_error(
                        write,
                        agent_id,
                        request_id,
                        LocalCopyError::FinalizeCopiedDirectory(error),
                    )
                    .await;
                    return;
                }

                reporter.finish().await;
                self.send_command_response(
                    write,
                    agent_id,
                    request_id,
                    CommandResult::LocalCopyDirectory,
                )
                .await;
            }
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&temp_dest_root).await;
                self.send_local_copy_error(write, agent_id, request_id, error)
                    .await;
            }
        }
    }
}
