use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef};
use redoor::{
    Level,
    commands::{Command, CommandHandler, CommandResult},
    log,
    streaming::{self, StreamPayloadKind},
    types::{ChunkIndex, Message, RequestId},
};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};
use sysinfo::System;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{Mutex, mpsc, oneshot, watch},
};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

pub struct AgentActor;

#[derive(Parser)]
#[command(author, version, about)]
struct AgentArgs {
    ws_address: String,
    #[arg(long)]
    name: String,
    #[arg(long)]
    log: Option<String>,
}

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

struct RawUploadSession {
    path: String,
    temp_path: PathBuf,
    file: File,
    bytes_written: u64,
}

#[derive(Clone)]
struct UploadSessionHandle {
    path: String,
    chunk_sender: mpsc::Sender<streaming::StreamChunk>,
}

type ActiveUploads = Arc<Mutex<HashMap<RequestId, UploadSessionHandle>>>;

#[derive(Clone)]
struct DownloadSessionHandle {
    cancel_sender: watch::Sender<bool>,
}

type ActiveDownloads = Arc<Mutex<HashMap<RequestId, DownloadSessionHandle>>>;

/// Streams tar bytes into a blocking unpack worker that extracts into a temp directory.
struct TarUploadSession {
    path: String,
    temp_path: PathBuf,
    chunk_sender: std_mpsc::SyncSender<Vec<u8>>,
    completion_receiver: oneshot::Receiver<Result<()>>,
    bytes_written: u64,
}

pub struct AgentState {
    agent_id: String,
    agent_name: String,
    server_url: String,
    ws_text_tx: Option<mpsc::Sender<WsMessage>>,
    ws_binary_tx: Option<mpsc::Sender<WsMessage>>,
    active_uploads: ActiveUploads,
    active_downloads: ActiveDownloads,
}

#[derive(Clone)]
pub enum AgentMsg {
    Connect,
    ConnectionEstablished,
    ConnectionFailed { error: String },
    WebSocketMessage { text: String },
    WebSocketBinaryMessage { bytes: Vec<u8> },
    ConnectionLost { reason: String },
    Reconnect,
    SendWebSocketMessage { msg: WsMessage },
    SendWebSocketBinary { bytes: Vec<u8> },
    Shutdown,
    ExitWithError,
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

    async fn remove_active_upload(active_uploads: &ActiveUploads, request_id: RequestId) {
        active_uploads.lock().await.remove(&request_id);
    }

    async fn clear_active_uploads(active_uploads: &ActiveUploads) {
        active_uploads.lock().await.clear();
    }

    async fn remove_active_download(active_downloads: &ActiveDownloads, request_id: RequestId) {
        active_downloads.lock().await.remove(&request_id);
    }

    async fn clear_active_downloads(active_downloads: &ActiveDownloads) {
        let mut active_downloads = active_downloads.lock().await;
        for download in active_downloads.values() {
            let _ = download.cancel_sender.send(true);
        }
        active_downloads.clear();
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
        agent_id: &str,
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

    async fn local_copy_file(
        &self,
        source_path: String,
        dest_path: String,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &str,
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
            agent_id.to_string(),
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

    async fn local_copy_directory(
        &self,
        source_path: String,
        dest_path: String,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &str,
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
            agent_id.to_string(),
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

    /// Streams a directory as tar bytes to the server using the shared transfer
    /// frame size.
    async fn tar_download(
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
                    request_id,
                    &mut chunk_index,
                    StreamPayloadKind::Tar,
                    true,
                    error_message.as_bytes(),
                    true,
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
                request_id,
                &mut chunk_index,
                StreamPayloadKind::Tar,
                true,
                error_message.as_bytes(),
                true,
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
                            let _ = Self::send_framed_stream_bytes(
                                write,
                                request_id,
                                &mut chunk_index,
                                StreamPayloadKind::Tar,
                                true,
                                cancel_message,
                                true,
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
                    request_id,
                    &mut chunk_index,
                    StreamPayloadKind::Tar,
                    false,
                    &previous_chunk,
                    false,
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
            request_id,
            &mut chunk_index,
            StreamPayloadKind::Tar,
            false,
            &final_chunk,
            true,
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
        agent_id: &str,
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
        agent_id: String,
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
        agent_id: String,
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

    /// Dispatches one incoming control message from the server and routes
    /// transfer-producing commands onto the binary websocket sender.
    async fn handle_incoming_message(
        &self,
        text: String,
        state: &mut AgentState,
        write_text: &mpsc::Sender<WsMessage>,
        write_binary: &mpsc::Sender<WsMessage>,
        agent_ref: ActorRef<AgentMsg>,
    ) {
        if let Ok(redoor_msg) = serde_json::from_str::<Message>(&text) {
            match redoor_msg {
                Message::Command {
                    request_id,
                    command,
                    ..
                } => {
                    log!(
                        Level::Trace,
                        "Command received: agent_id={}, request_id={}, command={:?}",
                        state.agent_id,
                        request_id,
                        command
                    );
                    if !self
                        .start_upload_session(
                            state.active_uploads.clone(),
                            write_text,
                            &state.agent_id,
                            request_id,
                            command.clone(),
                        )
                        .await
                    {
                        tokio::spawn(Self::handle_command_message(
                            write_text.clone(),
                            write_binary.clone(),
                            state.agent_id.clone(),
                            request_id,
                            command,
                            state.active_downloads.clone(),
                        ));
                    }
                }
                Message::CancelTransfer { request_id } => {
                    let download_handle = {
                        state
                            .active_downloads
                            .lock()
                            .await
                            .get(&request_id)
                            .cloned()
                    };

                    if let Some(download_handle) = download_handle {
                        let _ = download_handle.cancel_sender.send(true);
                    }
                }
                Message::Error { message } => {
                    log!(Level::Error, "Server error: {}", message);
                    let _ = agent_ref.cast(AgentMsg::ExitWithError);
                }
                _ => {}
            }
        }
    }

    /// Sends a command response back to the server on the prioritized text lane.
    async fn send_command_response(
        &self,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &str,
        request_id: RequestId,
        result: CommandResult,
    ) {
        let response = Message::CommandResponse {
            agent_id: agent_id.to_string(),
            request_id,
            result,
        };

        if let Ok(json) = serde_json::to_string(&response) {
            let _ = write.send(WsMessage::text(json)).await;
        }
    }

    /// Emits one logical transfer payload as bounded websocket binary frames.
    async fn send_framed_stream_bytes(
        write: &mpsc::Sender<WsMessage>,
        request_id: RequestId,
        chunk_index: &mut ChunkIndex,
        payload_kind: StreamPayloadKind,
        is_error: bool,
        data: &[u8],
        is_last: bool,
    ) -> bool {
        let mut frames = streaming::split_stream_chunk_bytes(
            request_id,
            *chunk_index,
            payload_kind,
            is_error,
            data,
            is_last,
        );

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

    /// Executes one non-upload command and routes any streamed payload over the
    /// binary websocket sender while keeping command responses on text.
    async fn handle_command_message(
        write_text: mpsc::Sender<WsMessage>,
        write_binary: mpsc::Sender<WsMessage>,
        agent_id: String,
        request_id: RequestId,
        command: Command,
        active_downloads: ActiveDownloads,
    ) {
        match command {
            Command::RawDownload {
                path,
                range_start,
                range_end,
            } => {
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                active_downloads
                    .lock()
                    .await
                    .insert(request_id, DownloadSessionHandle { cancel_sender });
                AgentActor
                    .raw_download(
                        path,
                        range_start,
                        range_end,
                        request_id,
                        &write_binary,
                        cancel_receiver,
                        active_downloads.clone(),
                    )
                    .await;
            }
            Command::TarDownload { path } => {
                let (cancel_sender, cancel_receiver) = watch::channel(false);
                active_downloads
                    .lock()
                    .await
                    .insert(request_id, DownloadSessionHandle { cancel_sender });
                AgentActor
                    .tar_download(
                        path,
                        request_id,
                        &write_binary,
                        cancel_receiver,
                        active_downloads.clone(),
                    )
                    .await;
            }
            Command::LocalCopyFile {
                source_path,
                dest_path,
            } => {
                AgentActor
                    .local_copy_file(source_path, dest_path, request_id, &write_text, &agent_id)
                    .await;
            }
            Command::LocalCopyDirectory {
                source_path,
                dest_path,
            } => {
                AgentActor
                    .local_copy_directory(
                        source_path,
                        dest_path,
                        request_id,
                        &write_text,
                        &agent_id,
                    )
                    .await;
            }
            Command::RawDelete { path } => {
                let result = CommandHandler::new()
                    .execute(Command::RawDelete { path })
                    .await;
                AgentActor
                    .send_command_response(&write_text, &agent_id, request_id, result)
                    .await;
            }
            other => {
                let result = CommandHandler::new().execute(other).await;
                let result_clone = result.clone();
                let response = Message::CommandResponse {
                    agent_id: agent_id.clone(),
                    request_id,
                    result,
                };

                if let Ok(json) = serde_json::to_string(&response) {
                    let _ = write_text.send(WsMessage::text(json)).await;
                }
                log!(
                    Level::Trace,
                    "Command response sent: agent_id={}, request_id={}, result={:?}",
                    agent_id,
                    request_id,
                    result_clone
                );
            }
        }
    }

    /// Initializes agent-side state for streamed uploads before binary chunks
    /// start arriving for the request id.
    async fn start_upload_session(
        &self,
        active_uploads: ActiveUploads,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &str,
        request_id: RequestId,
        command: Command,
    ) -> bool {
        match command {
            Command::RawUpload { path } => {
                let upload_already_exists = active_uploads.lock().await.contains_key(&request_id);

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
                        active_uploads.lock().await.insert(
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
                            agent_id.to_string(),
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
                let upload_already_exists = active_uploads.lock().await.contains_key(&request_id);

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
                        active_uploads.lock().await.insert(
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
                            agent_id.to_string(),
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

    /// Streams file contents to the server as reframed websocket binary chunks.
    async fn raw_download(
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
                    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
                        log!(Level::Error, "Failed to seek file: {}", e);
                        let error_msg = format!("Failed to seek file: {}", e);
                        let _ = Self::send_framed_stream_bytes(
                            write,
                            request_id,
                            &mut chunk_index,
                            StreamPayloadKind::RawFile,
                            true,
                            error_msg.as_bytes(),
                            true,
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

                    if read_size < buffer.len() {
                        buffer.resize(read_size, 0);
                    } else if read_size > buffer.len() {
                        buffer.resize(read_size, 0);
                    }

                    match tokio::select! {
                        changed = cancel_receiver.changed() => {
                            match changed {
                                Ok(()) if *cancel_receiver.borrow() => {
                                    let _ = Self::send_framed_stream_bytes(
                                        write,
                                        request_id,
                                        &mut chunk_index,
                                        StreamPayloadKind::RawFile,
                                        true,
                                        cancel_message,
                                        true,
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
                        Ok(n) => {
                            if let Some(ref mut remaining) = bytes_remaining {
                                *remaining = remaining.saturating_sub(n as u64);
                            }

                            if let Some(data) = pending_chunk.replace(buffer[..n].to_vec()) {
                                if !Self::send_framed_stream_bytes(
                                    write,
                                    request_id,
                                    &mut chunk_index,
                                    StreamPayloadKind::RawFile,
                                    false,
                                    &data,
                                    false,
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
                        Err(e) => {
                            log!(Level::Error, "Failed to read file: {}", e);
                            let error_msg = format!("Failed to read file: {}", e);
                            let _ = Self::send_framed_stream_bytes(
                                write,
                                request_id,
                                &mut chunk_index,
                                StreamPayloadKind::RawFile,
                                true,
                                error_msg.as_bytes(),
                                true,
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
                    request_id,
                    &mut chunk_index,
                    StreamPayloadKind::RawFile,
                    false,
                    &final_chunk,
                    true,
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
            Err(e) => {
                log!(Level::Error, "Failed to open file: {}", e);
                let error_msg = format!("Failed to open file: {}", e);
                let mut chunk_index = ChunkIndex::new(0);
                let _ = Self::send_framed_stream_bytes(
                    write,
                    request_id,
                    &mut chunk_index,
                    StreamPayloadKind::RawFile,
                    true,
                    error_msg.as_bytes(),
                    true,
                )
                .await;
                Self::remove_active_download(&active_downloads, request_id).await;
            }
        }
    }

    async fn handle_upload_chunk(
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

        let upload_handle = { state.active_uploads.lock().await.get(&request_id).cloned() };

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

    async fn spawn_read_task(
        mut read: futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        agent_ref: ActorRef<AgentMsg>,
    ) {
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        let _ = agent_ref.cast(AgentMsg::WebSocketMessage {
                            text: text.to_string(),
                        });
                    }
                    Ok(WsMessage::Binary(bytes)) => {
                        let _ = agent_ref.cast(AgentMsg::WebSocketBinaryMessage {
                            bytes: bytes.to_vec(),
                        });
                    }
                    Ok(WsMessage::Close(_)) => {
                        let _ = agent_ref.cast(AgentMsg::ConnectionLost {
                            reason: "Server closed connection".to_string(),
                        });
                        break;
                    }
                    Err(e) => {
                        let _ = agent_ref.cast(AgentMsg::ConnectionLost {
                            reason: format!("Error receiving message: {}", e),
                        });
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    async fn spawn_stdin_task(agent_ref: ActorRef<AgentMsg>) {
        let agent_ref_clone = agent_ref.clone();
        tokio::spawn(async move {
            let mut line = String::new();
            while tokio::io::AsyncBufReadExt::read_line(
                &mut tokio::io::BufReader::new(tokio::io::stdin()),
                &mut line,
            )
            .await
            .unwrap()
                > 0
            {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let _ = agent_ref_clone.cast(AgentMsg::SendWebSocketMessage {
                        msg: WsMessage::text(trimmed.to_string()),
                    });
                }
                line.clear();
            }
        });
    }
}

struct DirectoryCopyPlan {
    total_bytes: u64,
    directories: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

struct LocalCopyProgressReporter {
    write: mpsc::Sender<WsMessage>,
    agent_id: String,
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
        agent_id: String,
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

impl Actor for AgentActor {
    type Msg = AgentMsg;
    type State = AgentState;
    type Arguments = (String, String, String);

    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (agent_id, agent_name, server_url) = args;

        log!(
            Level::Info,
            "AgentActor started: agent_id={}, agent_name={}",
            agent_id,
            agent_name
        );

        Self::spawn_stdin_task(myself.clone()).await;

        let _ = myself.cast(AgentMsg::Connect);

        Ok(AgentState {
            agent_id,
            agent_name,
            server_url,
            ws_text_tx: None,
            ws_binary_tx: None,
            active_uploads: Arc::new(Mutex::new(HashMap::new())),
            active_downloads: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            AgentMsg::Connect => {
                log!(
                    Level::Info,
                    "Attempting to connect to {} as agent '{}'",
                    state.server_url,
                    state.agent_name
                );

                match connect_async(&state.server_url).await {
                    Ok((ws_stream, _response)) => {
                        log!(Level::Info, "Connected to {}", state.server_url);
                        log!(
                            Level::Info,
                            "Agent connected: agent_id={}, agent_name={}, server={}",
                            state.agent_id,
                            state.agent_name,
                            state.server_url
                        );

                        let (write, read) = ws_stream.split();
                        let (text_tx, mut text_rx) = mpsc::channel::<WsMessage>(32);
                        let (binary_tx, mut binary_rx) = mpsc::channel::<WsMessage>(1);

                        state.ws_text_tx = Some(text_tx.clone());
                        state.ws_binary_tx = Some(binary_tx.clone());

                        Self::spawn_read_task(read, myself.clone()).await;

                        let mut write = write;
                        tokio::spawn(async move {
                            let mut text_closed = false;
                            let mut binary_closed = false;

                            loop {
                                let next_message = tokio::select! {
                                    biased;
                                    message = text_rx.recv(), if !text_closed => match message {
                                        Some(message) => Some(message),
                                        None => {
                                            text_closed = true;
                                            None
                                        }
                                    },
                                    message = binary_rx.recv(), if !binary_closed => match message {
                                        Some(message) => Some(message),
                                        None => {
                                            binary_closed = true;
                                            None
                                        }
                                    },
                                    else => break,
                                };

                                let Some(message) = next_message else {
                                    continue;
                                };

                                if write.send(message).await.is_err() {
                                    log!(Level::Warning, "Failed to send WebSocket message");
                                    break;
                                }
                            }
                        });

                        let _ = myself.cast(AgentMsg::ConnectionEstablished);

                        let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
                        let os = std::env::consts::OS.to_string();
                        let arch = std::env::consts::ARCH.to_string();
                        let username =
                            std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());

                        let register_msg = Message::AgentRegister {
                            agent_id: state.agent_id.clone(),
                            agent_name: state.agent_name.clone(),
                            os,
                            arch,
                            hostname,
                            username,
                        };

                        if let Ok(json) = serde_json::to_string(&register_msg) {
                            log!(Level::Info, "Sending agent registration message: {}", json);
                            if let Err(e) = text_tx.send(WsMessage::text(json)).await {
                                log!(Level::Error, "Failed to send agent registration: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        log!(Level::Error, "Connection failed: {}", e);
                        let _ = myself.cast(AgentMsg::ConnectionFailed {
                            error: e.to_string(),
                        });
                    }
                }
            }

            AgentMsg::ConnectionEstablished => {
                log!(Level::Info, "Connection established");
            }

            AgentMsg::ConnectionFailed { error } => {
                log!(
                    Level::Error,
                    "Connection failed: {}, scheduling reconnect in 5s",
                    error
                );
                let agent_ref_clone = myself.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = agent_ref_clone.cast(AgentMsg::Reconnect);
                });
            }

            AgentMsg::WebSocketMessage { text } => {
                if let (Some(tx_text), Some(tx_binary)) = (
                    state.ws_text_tx.as_ref().cloned(),
                    state.ws_binary_tx.as_ref().cloned(),
                ) {
                    self.handle_incoming_message(text, state, &tx_text, &tx_binary, myself.clone())
                        .await;
                }
            }

            AgentMsg::ConnectionLost { reason } => {
                log!(
                    Level::Warning,
                    "Connection lost: {}, scheduling reconnect in 5s",
                    reason
                );
                state.ws_text_tx = None;
                state.ws_binary_tx = None;
                Self::clear_active_uploads(&state.active_uploads).await;
                Self::clear_active_downloads(&state.active_downloads).await;
                let agent_ref_clone = myself.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = agent_ref_clone.cast(AgentMsg::Reconnect);
                });
            }

            AgentMsg::Reconnect => {
                log!(Level::Info, "Attempting to reconnect...");
                let _ = myself.cast(AgentMsg::Connect);
            }

            AgentMsg::SendWebSocketMessage { msg } => {
                if let Some(tx) = &state.ws_text_tx {
                    if tx.send(msg).await.is_err() {
                        log!(
                            Level::Error,
                            "Failed to send message, connection may be lost"
                        );
                    }
                }
            }

            AgentMsg::SendWebSocketBinary { bytes } => {
                if let Some(tx) = &state.ws_binary_tx {
                    if tx.send(WsMessage::Binary(bytes.into())).await.is_err() {
                        log!(
                            Level::Error,
                            "Failed to send binary message, connection may be lost"
                        );
                    }
                }
            }

            AgentMsg::WebSocketBinaryMessage { bytes } => {
                self.handle_upload_chunk(state, bytes).await?;
            }

            AgentMsg::Shutdown => {
                log!(
                    Level::Info,
                    "Shutting down agent: agent_id={}",
                    state.agent_id
                );
                state.ws_text_tx = None;
                state.ws_binary_tx = None;
                Self::clear_active_uploads(&state.active_uploads).await;
                Self::clear_active_downloads(&state.active_downloads).await;
                myself.stop(None);
            }

            AgentMsg::ExitWithError => {
                log!(Level::Error, "Exiting agent due to error");
                std::process::exit(1);
            }
        }

        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        log!(Level::Info, "Agent stopped: agent_id={}", state.agent_id);
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = AgentArgs::parse();
    let server_url = args.ws_address;
    let agent_name = args.name;
    let log_file = args.log;

    let agent_id = agent_name.clone();

    redoor::logging::init(log_file);
    log!(Level::Info, "Starting agent '{}'", agent_name);

    let (_, agent_handle) =
        AgentActor::spawn(None, AgentActor, (agent_id, agent_name, server_url)).await?;

    agent_handle.await?;

    Ok(())
}
