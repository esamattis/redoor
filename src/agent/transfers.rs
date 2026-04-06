use super::{ActiveDownloads, ActiveUploads, AgentActor, UploadSessionHandle};
use anyhow::{Context, Result, anyhow, bail};
use redoor::{
    Level,
    commands::CommandResult,
    log,
    streaming::{self, StreamChunkFrameRequest, StreamPayloadKind},
    types::{AgentId, ChunkIndex, Message, RequestId},
};
use std::{
    path::{Component, Path, PathBuf},
    sync::mpsc as std_mpsc,
    time::{Duration, Instant},
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot, watch},
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Bridges synchronous `tar::Builder` writes into the async websocket sender.
///
/// The tar crate exposes a blocking `std::io::Write` API, so directory archive
/// creation runs in a blocking task and pushes produced tar chunks through this
/// adapter into an async channel.
struct ChannelTarWriter {
    sender: mpsc::Sender<Vec<u8>>,
    runtime: tokio::runtime::Handle,
}

impl std::io::Write for ChannelTarWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.runtime
            .block_on(self.sender.send(buf.to_vec()))
            .map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "Tar stream receiver dropped",
                )
            })?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Streams tar bytes into a blocking unpack worker that extracts into a temp directory.
struct TarUploadSession {
    path: String,
    temp_path: PathBuf,
    chunk_sender: std_mpsc::SyncSender<Vec<u8>>,
    completion_receiver: oneshot::Receiver<Result<()>>,
    bytes_written: u64,
}

struct DirectoryCopyPlan {
    total_bytes: u64,
    directories: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

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

    async fn advance(&mut self, bytes: u64) {
        self.transferred_bytes = self.transferred_bytes.saturating_add(bytes);
        self.report(false).await;
    }

    async fn finish(&mut self) {
        self.transferred_bytes = self.total_bytes;
        self.report(true).await;
    }
}

impl AgentActor {
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
            std::fs::canonicalize(source_path).with_context(|| {
                format!("Failed to access source path: {}", source_path.display())
            })?
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

    async fn validate_local_copy_parent(dest_path: &Path) -> Result<()> {
        let parent = dest_path
            .parent()
            .with_context(|| format!("Destination parent not found for {}", dest_path.display()))?;
        let parent_metadata = tokio::fs::metadata(parent).await.with_context(|| {
            format!("Failed to access destination parent: {}", parent.display())
        })?;
        if !parent_metadata.is_dir() {
            bail!(
                "Destination parent is not a directory: {}",
                parent.display()
            );
        }
        Ok(())
    }

    async fn copy_file_streaming(
        source_path: &Path,
        dest_path: &Path,
        reporter: &mut LocalCopyProgressReporter,
    ) -> Result<()> {
        let mut source = File::open(source_path)
            .await
            .with_context(|| format!("Failed to open source file: {}", source_path.display()))?;
        let temp_path = Self::temp_local_copy_path(
            dest_path
                .to_str()
                .with_context(|| format!("Non-utf8 destination path: {}", dest_path.display()))?,
        );

        let mut destination = File::create(&temp_path).await.with_context(|| {
            format!("Failed to create destination file: {}", temp_path.display())
        })?;

        let mut buffer = vec![0u8; 1024 * 1024];

        loop {
            let bytes_read = source.read(&mut buffer).await.with_context(|| {
                format!("Failed to read source file: {}", source_path.display())
            })?;

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

        destination.flush().await.with_context(|| {
            format!("Failed to flush destination file: {}", temp_path.display())
        })?;
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

    fn build_directory_copy_plan(source_root: &Path) -> Result<DirectoryCopyPlan> {
        fn walk(
            source_root: &Path,
            current_path: &Path,
            plan: &mut DirectoryCopyPlan,
        ) -> Result<()> {
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

        let source_metadata = std::fs::symlink_metadata(source_root).with_context(|| {
            format!("Failed to read source metadata: {}", source_root.display())
        })?;
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

            Self::copy_file_streaming(&source_path, &dest_path, reporter).await?;
        }

        Ok(())
    }

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

        if let Err(error) =
            Self::validate_local_copy_destination(&source_path_buf, &dest_path_buf, false)
        {
            self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                .await;
            return;
        }

        if let Err(error) = Self::validate_local_copy_parent(&dest_path_buf).await {
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

        match Self::copy_file_streaming(&source_path_buf, &dest_path_buf, &mut reporter).await {
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
                let temp_path = Self::temp_local_copy_path(&dest_path);
                let _ = tokio::fs::remove_file(&temp_path).await;
                self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                    .await;
            }
        }
    }

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

        if let Err(error) =
            Self::validate_local_copy_destination(&source_path_buf, &dest_path_buf, true)
        {
            self.send_local_copy_error(write, agent_id, request_id, error.to_string())
                .await;
            return;
        }

        if let Err(error) = Self::validate_local_copy_parent(&dest_path_buf).await {
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
            move || Self::build_directory_copy_plan(&source_path_buf)
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

        let temp_dest_root = Self::temp_local_copy_dir_path(&dest_path);

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

        match Self::copy_directory_from_plan(
            &source_path_buf,
            &temp_dest_root,
            &plan,
            &mut reporter,
        )
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

    fn append_directory_entries(
        builder: &mut tar::Builder<ChannelTarWriter>,
        source_root: &Path,
        current_path: &Path,
    ) -> Result<()> {
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
                builder
                    .append_dir(&relative_path, &entry_path)
                    .with_context(|| {
                        format!(
                            "Failed to append directory to tar: {}",
                            entry_path.display()
                        )
                    })?;
                Self::append_directory_entries(builder, source_root, &entry_path)?;
            } else if metadata.is_file() {
                let mut file = std::fs::File::open(&entry_path).with_context(|| {
                    format!("Failed to open file for tar: {}", entry_path.display())
                })?;
                builder
                    .append_file(&relative_path, &mut file)
                    .with_context(|| {
                        format!("Failed to append file to tar: {}", entry_path.display())
                    })?;
            } else {
                bail!(
                    "Unsupported directory entry type in copy source: {}",
                    entry_path.display()
                );
            }
        }

        Ok(())
    }

    pub(crate) async fn start_tar_upload_session(
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

        match Self::create_tar_upload_session(path.clone()).await {
            Ok(session) => {
                let (chunk_sender, chunk_receiver) = mpsc::channel::<streaming::StreamChunk>(8);
                let (cancel_sender, cancel_receiver) = watch::channel(false);
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
                            cancel_sender,
                        },
                    );
                tokio::spawn(Self::process_tar_upload(
                    active_uploads,
                    chunk_receiver,
                    cancel_receiver,
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
    }

    /// Streams a directory as tar bytes to the server using the shared transfer
    /// frame size.
    pub(crate) async fn tar_download(
        &self,
        path: String,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        mut cancel_receiver: watch::Receiver<bool>,
        active_downloads: ActiveDownloads,
    ) {
        let source_path = PathBuf::from(&path);
        let cancel_message = b"Download canceled by server";

        let metadata = match tokio::fs::metadata(&source_path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                let mut chunk_index = ChunkIndex::new(0);
                let error_message = format!("Failed to open directory: {}", error);
                let _ = Self::send_framed_stream_bytes(
                    write,
                    &mut chunk_index,
                    StreamChunkFrameRequest::new(request_id, error_message.as_bytes())
                        .payload_kind(StreamPayloadKind::Tar)
                        .is_error(true),
                )
                .await;
                Self::remove_active_download(&active_downloads, request_id).await;
                return;
            }
        };

        if !metadata.is_dir() {
            let mut chunk_index = ChunkIndex::new(0);
            let error_message = format!("Source path is not a directory: {}", path);
            let _ = Self::send_framed_stream_bytes(
                write,
                &mut chunk_index,
                StreamChunkFrameRequest::new(request_id, error_message.as_bytes())
                    .payload_kind(StreamPayloadKind::Tar)
                    .is_error(true),
            )
            .await;
            Self::remove_active_download(&active_downloads, request_id).await;
            return;
        }

        let (tar_sender, mut tar_receiver) = mpsc::channel::<Vec<u8>>(8);
        let source_path_for_worker = source_path.clone();

        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Handle::current();
            let writer = ChannelTarWriter {
                sender: tar_sender,
                runtime,
            };
            let mut builder = tar::Builder::new(writer);

            let result = Self::append_directory_entries(
                &mut builder,
                &source_path_for_worker,
                &source_path_for_worker,
            )
            .and_then(|_| builder.finish().context("Failed to finalize tar stream"));

            if let Err(error) = result {
                log!(
                    Level::Error,
                    "Tar directory streaming failed: path={}, error={}",
                    source_path_for_worker.display(),
                    error
                );
            }
        });

        let mut chunk_index = ChunkIndex(0);
        let mut pending_chunk: Option<Vec<u8>> = None;

        loop {
            let next_chunk_bytes = tokio::select! {
                changed = cancel_receiver.changed() => {
                    match changed {
                        Ok(()) if *cancel_receiver.borrow() => {
                            log!(
                                Level::Info,
                                "Stopping tar download after cancel: request_id={}, path={}",
                                request_id,
                                path
                            );
                            let _ = Self::send_framed_stream_bytes(
                                write,
                                &mut chunk_index,
                                StreamChunkFrameRequest::new(request_id, cancel_message)
                                    .payload_kind(StreamPayloadKind::Tar)
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
                chunk_bytes = tar_receiver.recv() => chunk_bytes,
            };

            let Some(chunk_bytes) = next_chunk_bytes else {
                break;
            };

            if let Some(previous_chunk) = pending_chunk.replace(chunk_bytes) {
                if !Self::send_framed_stream_bytes(
                    write,
                    &mut chunk_index,
                    StreamChunkFrameRequest::new(request_id, &previous_chunk)
                        .payload_kind(StreamPayloadKind::Tar)
                        .is_last(false),
                )
                .await
                {
                    log!(
                        Level::Warning,
                        "WebSocket channel full or closed, aborting tar download"
                    );
                    Self::remove_active_download(&active_downloads, request_id).await;
                    return;
                }
            }
        }

        let final_chunk = pending_chunk.unwrap_or_default();
        let _ = Self::send_framed_stream_bytes(
            write,
            &mut chunk_index,
            StreamChunkFrameRequest::new(request_id, &final_chunk)
                .payload_kind(StreamPayloadKind::Tar),
        )
        .await;

        log!(
            Level::Info,
            "Tar directory download complete: path={}, chunks={}",
            path,
            chunk_index.display_number()
        );
        Self::remove_active_download(&active_downloads, request_id).await;
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

    /// Waits for tar upload chunks or cancellation and tears down the temp
    /// directory unless a full tar stream is finalized successfully.
    async fn process_tar_upload(
        active_uploads: ActiveUploads,
        mut chunk_receiver: mpsc::Receiver<streaming::StreamChunk>,
        mut cancel_receiver: watch::Receiver<bool>,
        mut session: TarUploadSession,
        tx: mpsc::Sender<WsMessage>,
        agent_id: AgentId,
        request_id: RequestId,
    ) {
        loop {
            let next_chunk = tokio::select! {
                changed = cancel_receiver.changed() => {
                    match changed {
                        Ok(()) if *cancel_receiver.borrow() => {
                            let error_message = "Upload canceled by server".to_string();
                            log!(
                                Level::Info,
                                "Stopping tar upload after cancel: request_id={}, path={}",
                                request_id,
                                session.path
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
                        Ok(()) => continue,
                        Err(_) => {
                            // Registry teardown drops the watch sender before
                            // the chunk receiver necessarily closes, so treat it
                            // as an instruction to stop and clean up now.
                            drop(session.chunk_sender);
                            Self::remove_upload_temp_directory(&session.temp_path).await;
                            Self::remove_active_upload(&active_uploads, request_id).await;
                            return;
                        }
                    }
                }
                chunk = chunk_receiver.recv() => chunk,
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
}
