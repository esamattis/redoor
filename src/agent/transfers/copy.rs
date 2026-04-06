use super::super::AgentActor;
use anyhow::{Context, Result, bail};
use redoor::{
    commands::CommandResult,
    types::{AgentId, Message, RequestId},
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

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
) -> Result<()> {
    let source_parent = source_path
        .parent()
        .with_context(|| format!("Source parent not found for {}", source_path.display()))?;
    let dest_parent = dest_path
        .parent()
        .with_context(|| format!("Destination parent not found for {}", dest_path.display()))?;

    let canonical_source_parent = std::fs::canonicalize(source_parent).with_context(|| {
        format!(
            "Failed to access source parent: {}",
            source_parent.display()
        )
    })?;
    let canonical_dest_parent = std::fs::canonicalize(dest_parent).with_context(|| {
        format!(
            "Failed to access destination parent: {}",
            dest_parent.display()
        )
    })?;

    let source_canonical = if source_path.is_absolute() {
        std::fs::canonicalize(source_path)
            .with_context(|| format!("Failed to access source path: {}", source_path.display()))?
    } else {
        canonical_source_parent.join(
            source_path
                .file_name()
                .with_context(|| format!("Invalid source path: {}", source_path.display()))?,
        )
    };

    let dest_effective = canonical_dest_parent.join(
        dest_path
            .file_name()
            .with_context(|| format!("Invalid destination path: {}", dest_path.display()))?,
    );

    if source_canonical == dest_effective {
        bail!("Source and destination must be different");
    }

    if source_is_dir && dest_effective.starts_with(&source_canonical) {
        bail!("Destination directory cannot be inside the source directory");
    }

    Ok(())
}

/// Verifies the destination parent exists and is a directory before copy work begins.
async fn validate_local_copy_parent(dest_path: &Path) -> Result<()> {
    let parent = dest_path
        .parent()
        .with_context(|| format!("Destination parent not found for {}", dest_path.display()))?;
    let parent_metadata = tokio::fs::metadata(parent)
        .await
        .with_context(|| format!("Failed to access destination parent: {}", parent.display()))?;
    if !parent_metadata.is_dir() {
        bail!(
            "Destination parent is not a directory: {}",
            parent.display()
        );
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
) -> Result<()> {
    let mut source = File::open(source_path)
        .await
        .with_context(|| format!("Failed to open source file: {}", source_path.display()))?;
    let temp_path = temp_local_copy_path(
        dest_path
            .to_str()
            .with_context(|| format!("Non-utf8 destination path: {}", dest_path.display()))?,
    );

    let mut destination = File::create(&temp_path)
        .await
        .with_context(|| format!("Failed to create destination file: {}", temp_path.display()))?;

    let mut buffer = vec![0u8; 1024 * 1024];

    loop {
        let bytes_read = source
            .read(&mut buffer)
            .await
            .with_context(|| format!("Failed to read source file: {}", source_path.display()))?;

        if bytes_read == 0 {
            break;
        }

        destination
            .write_all(&buffer[..bytes_read])
            .await
            .with_context(|| {
                format!("Failed to write destination file: {}", temp_path.display())
            })?;

        reporter.advance(bytes_read as u64).await;
    }

    destination
        .flush()
        .await
        .with_context(|| format!("Failed to flush destination file: {}", temp_path.display()))?;
    drop(destination);

    tokio::fs::rename(&temp_path, dest_path)
        .await
        .with_context(|| {
            format!(
                "Failed to finalize copied file from {} to {}",
                temp_path.display(),
                dest_path.display()
            )
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
fn build_directory_copy_plan(source_root: &Path) -> Result<DirectoryCopyPlan> {
    fn walk(source_root: &Path, current_path: &Path, plan: &mut DirectoryCopyPlan) -> Result<()> {
        let mut entries = std::fs::read_dir(current_path)
            .with_context(|| format!("Failed to read directory: {}", current_path.display()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .with_context(|| {
                format!("Failed to read directory entry: {}", current_path.display())
            })?;

        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let entry_path = entry.path();
            let relative_path = entry_path
                .strip_prefix(source_root)
                .with_context(|| {
                    format!(
                        "Failed to strip source prefix {} from {}",
                        source_root.display(),
                        entry_path.display()
                    )
                })?
                .to_path_buf();
            let metadata = std::fs::symlink_metadata(&entry_path).with_context(|| {
                format!("Failed to read entry metadata: {}", entry_path.display())
            })?;

            if metadata.is_dir() {
                plan.directories.push(relative_path.clone());
                walk(source_root, &entry_path, plan)?;
            } else if metadata.is_file() {
                plan.total_bytes = plan.total_bytes.saturating_add(metadata.len());
                plan.files.push(relative_path);
            } else {
                bail!(
                    "Unsupported directory entry type in copy source: {}",
                    entry_path.display()
                );
            }
        }

        Ok(())
    }

    let source_metadata = std::fs::symlink_metadata(source_root)
        .with_context(|| format!("Failed to read source metadata: {}", source_root.display()))?;
    if !source_metadata.is_dir() {
        bail!("Source path is not a directory: {}", source_root.display());
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
) -> Result<()> {
    for directory in &plan.directories {
        let destination_directory = temp_dest_root.join(directory);
        tokio::fs::create_dir_all(&destination_directory)
            .await
            .with_context(|| {
                format!(
                    "Failed to create destination directory: {}",
                    destination_directory.display()
                )
            })?;
    }

    for relative_path in &plan.files {
        let source_path = source_root.join(relative_path);
        let dest_path = temp_dest_root.join(relative_path);

        if let Some(parent) = dest_path.parent() {
            tokio::fs::create_dir_all(parent).await.with_context(|| {
                format!(
                    "Failed to create destination directory: {}",
                    parent.display()
                )
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
        message: String,
    ) {
        self.send_command_response(
            write,
            agent_id,
            request_id,
            CommandResult::Error { message },
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
                    format!("Failed to access source file: {}", error),
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
                format!("Source path is not a file: {}", source_path),
            )
            .await;
            return;
        }

        if let Err(error) = validate_local_copy_destination(&source_path_buf, &dest_path_buf, false)
        {
            self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                .await;
            return;
        }

        if let Err(error) = validate_local_copy_parent(&dest_path_buf).await {
            self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                .await;
            return;
        }

        match tokio::fs::try_exists(&dest_path_buf).await {
            Ok(true) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    format!("Destination already exists: {}", dest_path),
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
                    format!("Failed to check destination path: {}", error),
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
                self.send_local_copy_error(write, agent_id, request_id, error.to_string())
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
                    format!("Failed to access source directory: {}", error),
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
                format!("Source path is not a directory: {}", source_path),
            )
            .await;
            return;
        }

        if let Err(error) = validate_local_copy_destination(&source_path_buf, &dest_path_buf, true)
        {
            self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                .await;
            return;
        }

        if let Err(error) = validate_local_copy_parent(&dest_path_buf).await {
            self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                .await;
            return;
        }

        match tokio::fs::try_exists(&dest_path_buf).await {
            Ok(true) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    format!("Destination already exists: {}", dest_path),
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
                    format!("Failed to check destination path: {}", error),
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
                self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                    .await;
                return;
            }
            Err(error) => {
                self.send_local_copy_error(
                    write,
                    agent_id,
                    request_id,
                    format!("Directory copy planner failed: {}", error),
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
                format!("Failed to create temp directory: {}", error),
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
                        format!("Failed to finalize copied directory: {}", error),
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
                self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                    .await;
            }
        }
    }
}
