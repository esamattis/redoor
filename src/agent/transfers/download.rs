use super::super::{ActiveDownloads, AgentActor, raw::send_framed_stream_bytes};
use anyhow::{Context, Result, bail};
use redoor::{
    Level,
    directory_measurement::{archive_member_path, directory_archive_root, measure_directory},
    log,
    streaming::{StreamChunkFrameRequest, StreamPayloadKind},
    types::{AgentId, ChunkIndex, Message, RequestId},
};
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Appends a directory tree into a tar builder in stable order so streams are deterministic.
fn append_directory_entries<W: Write>(
    builder: &mut tar::Builder<W>,
    source_root: &Path,
    current_path: &Path,
    archive_root: Option<&Path>,
) -> Result<()> {
    let mut entries = std::fs::read_dir(current_path)
        .with_context(|| format!("Failed to read directory: {}", current_path.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("Failed to read directory entry: {}", current_path.display()))?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let entry_path = entry.path();
        let archive_path = archive_member_path(source_root, &entry_path, archive_root)?;
        let metadata = std::fs::symlink_metadata(&entry_path)
            .with_context(|| format!("Failed to read entry metadata: {}", entry_path.display()))?;

        if metadata.is_dir() {
            builder
                .append_dir(&archive_path, &entry_path)
                .with_context(|| {
                    format!(
                        "Failed to append directory to tar: {}",
                        entry_path.display()
                    )
                })?;
            append_directory_entries(builder, source_root, &entry_path, archive_root)?;
        } else if metadata.is_file() {
            let mut file = std::fs::File::open(&entry_path).with_context(|| {
                format!("Failed to open file for tar: {}", entry_path.display())
            })?;
            builder
                .append_file(&archive_path, &mut file)
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

/// Writes the same directory archive the download worker streams, without reading
/// through a websocket adapter so tests can compare encoded length to the walk.
fn write_directory_tar<W: Write>(writer: W, source_path: &Path, include_root: bool) -> Result<W> {
    let mut builder = tar::Builder::new(writer);
    // Sparse encoding would omit holes and disagree with a metadata-only size walk.
    builder.sparse(false);
    let archive_root = directory_archive_root(source_path, include_root);
    if let Some(root) = archive_root.as_deref() {
        builder.append_dir(root, source_path).with_context(|| {
            format!(
                "Failed to append root directory to tar: {}",
                source_path.display()
            )
        })?;
    }
    append_directory_entries(
        &mut builder,
        source_path,
        source_path,
        archive_root.as_deref(),
    )?;
    builder.finish().context("Failed to finalize tar stream")?;
    builder
        .into_inner()
        .context("Failed to unwrap finished tar writer")
}

/// Publishes the predicted tar size on the text lane so control stays usable
/// while binary chunks continue streaming.
async fn send_download_total_update(
    write: &mpsc::Sender<WsMessage>,
    agent_id: &AgentId,
    request_id: RequestId,
    total_bytes: u64,
) {
    let message = Message::TransferProgressUpdate {
        agent_id: agent_id.clone(),
        request_id,
        transferred_bytes: 0,
        total_bytes: Some(total_bytes),
    };
    if let Ok(json) = serde_json::to_string(&message) {
        let _ = write.send(WsMessage::text(json)).await;
    }
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

/// Outcome of waiting for either the next tar chunk or a cancel signal.
enum TarDownloadEvent {
    Chunk(Option<Vec<u8>>),
    Continue,
    Cancel,
    Exit,
}

/// Owns the state and side effects for one in-progress tar directory download.
struct TarDownloadWorker {
    path: String,
    /// Adds the downloaded directory as the archive's single top-level member.
    include_root: bool,
    request_id: RequestId,
    write: mpsc::Sender<WsMessage>,
    /// Text lane carries the later-discovered total without mixing it into tar bytes.
    write_text: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    cancel_receiver: watch::Receiver<bool>,
    active_downloads: ActiveDownloads,
    chunk_index: ChunkIndex,
}

impl TarDownloadWorker {
    const CANCEL_MESSAGE: &'static [u8] = b"Download canceled by server";

    /// Waits for the cooperative cancel signal used by tar download workers.
    async fn wait_for_event(&mut self) -> TarDownloadEvent {
        match self.cancel_receiver.changed().await {
            Ok(()) if *self.cancel_receiver.borrow() => TarDownloadEvent::Cancel,
            Ok(()) => TarDownloadEvent::Continue,
            Err(_) => TarDownloadEvent::Exit,
        }
    }

    /// Frames and forwards one tar payload over the websocket.
    async fn send_chunk(&mut self, request: StreamChunkFrameRequest<'_>) -> bool {
        send_framed_stream_bytes(&self.write, &mut self.chunk_index, request).await
    }

    /// Unregisters the download worker from the active download registry.
    async fn cleanup(&self) {
        self.active_downloads.remove(self.request_id);
    }

    /// Sends the tar cancellation frame expected by the server and exits.
    async fn cancel(mut self) {
        log!(
            Level::Info,
            "Stopping tar download after cancel: request_id={}, path={}",
            self.request_id,
            self.path
        );
        let _ = self
            .send_chunk(
                StreamChunkFrameRequest::new(self.request_id, Self::CANCEL_MESSAGE)
                    .payload_kind(StreamPayloadKind::Tar)
                    .is_error(true),
            )
            .await;
        self.cleanup().await;
    }

    /// Stops quietly after the download registry has been torn down.
    async fn shutdown(self) {
        self.cleanup().await;
    }

    /// Starts the metadata-only size walk beside the tar stream so HTTP can start now.
    fn spawn_size_measure(&self, source_path: PathBuf) {
        let write_text = self.write_text.clone();
        let agent_id = self.agent_id.clone();
        let request_id = self.request_id;
        let include_root = self.include_root;
        let cancel_receiver = self.cancel_receiver.clone();
        tokio::spawn(async move {
            match measure_directory(&source_path, include_root, &cancel_receiver).await {
                Ok(Some(measurement)) => {
                    if !measurement.tar_complete || !measurement.errors.is_empty() {
                        log!(
                            Level::Warning,
                            "Tar download size measure incomplete: request_id={}, path={}, read_errors={}",
                            request_id,
                            source_path.display(),
                            measurement.errors.len()
                        );
                        return;
                    }
                    let total_bytes = measurement.tar_bytes;
                    log!(
                        Level::Info,
                        "Tar download size measured: request_id={}, path={}, total_bytes={}",
                        request_id,
                        source_path.display(),
                        total_bytes
                    );
                    send_download_total_update(&write_text, &agent_id, request_id, total_bytes)
                        .await;
                }
                Ok(None) => {
                    log!(
                        Level::Info,
                        "Tar download size measure canceled: request_id={}, path={}",
                        request_id,
                        source_path.display()
                    );
                }
                Err(error) => {
                    log!(
                        Level::Warning,
                        "Tar download size measure failed: request_id={}, path={}, error={}",
                        request_id,
                        source_path.display(),
                        error
                    );
                }
            }
        });
    }

    /// Runs the tar streaming loop until EOF, cancellation, or failure.
    async fn process(mut self) {
        let source_path = PathBuf::from(&self.path);

        let metadata = match tokio::fs::metadata(&source_path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                let error_message = format!("Failed to open directory: {}", error);
                log!(
                    Level::Error,
                    "Tar download open failed: request_id={}, path={}, error={}",
                    self.request_id,
                    self.path,
                    error
                );
                let _ = self
                    .send_chunk(
                        StreamChunkFrameRequest::new(self.request_id, error_message.as_bytes())
                            .payload_kind(StreamPayloadKind::Tar)
                            .is_error(true),
                    )
                    .await;
                self.cleanup().await;
                return;
            }
        };

        if !metadata.is_dir() {
            let error_message = format!("Source path is not a directory: {}", self.path);
            log!(
                Level::Error,
                "Tar download open failed: request_id={}, path={}, error=not a directory",
                self.request_id,
                self.path
            );
            let _ = self
                .send_chunk(
                    StreamChunkFrameRequest::new(self.request_id, error_message.as_bytes())
                        .payload_kind(StreamPayloadKind::Tar)
                        .is_error(true),
                )
                .await;
            self.cleanup().await;
            return;
        }

        if self.include_root {
            // REST directory downloads include the root; remote copies do not
            // and already ignore this update, so skip the extra metadata walk.
            self.spawn_size_measure(source_path.clone());
        }

        let (tar_sender, mut tar_receiver) = mpsc::channel::<Vec<u8>>(8);
        let source_path_for_worker = source_path.clone();
        let include_root = self.include_root;

        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Handle::current();
            let writer = ChannelTarWriter {
                sender: tar_sender,
                runtime,
            };
            if let Err(error) = write_directory_tar(writer, &source_path_for_worker, include_root) {
                log!(
                    Level::Error,
                    "Tar directory streaming failed: path={}, error={}",
                    source_path_for_worker.display(),
                    error
                );
            }
        });

        let mut pending_chunk: Option<Vec<u8>> = None;

        loop {
            let next_chunk_bytes = tokio::select! {
                event = self.wait_for_event() => event,
                chunk_bytes = tar_receiver.recv() => TarDownloadEvent::Chunk(chunk_bytes),
            };

            let next_chunk_bytes = match next_chunk_bytes {
                TarDownloadEvent::Chunk(chunk_bytes) => chunk_bytes,
                TarDownloadEvent::Continue => continue,
                TarDownloadEvent::Cancel => {
                    self.cancel().await;
                    return;
                }
                TarDownloadEvent::Exit => {
                    self.shutdown().await;
                    return;
                }
            };

            let Some(chunk_bytes) = next_chunk_bytes else {
                break;
            };

            if let Some(previous_chunk) = pending_chunk.replace(chunk_bytes)
                && !self
                    .send_chunk(
                        StreamChunkFrameRequest::new(self.request_id, &previous_chunk)
                            .payload_kind(StreamPayloadKind::Tar)
                            .is_last(false),
                    )
                    .await
            {
                log!(
                    Level::Warning,
                    "WebSocket channel full or closed, aborting tar download"
                );
                self.cleanup().await;
                return;
            }
        }

        let final_chunk = pending_chunk.unwrap_or_default();
        let _ = self
            .send_chunk(
                StreamChunkFrameRequest::new(self.request_id, &final_chunk)
                    .payload_kind(StreamPayloadKind::Tar),
            )
            .await;

        log!(
            Level::Info,
            "Tar directory download complete: request_id={}, path={}, chunks={}",
            self.request_id,
            self.path,
            self.chunk_index.display_number()
        );
        self.cleanup().await;
    }
}

/// Holds the control and payload lanes needed to start one tar download worker.
pub(crate) struct TarDownloadContext<'a> {
    pub(crate) request_id: RequestId,
    pub(crate) write: &'a mpsc::Sender<WsMessage>,
    /// Text lane is separate so the size update cannot stall behind tar bytes.
    pub(crate) write_text: &'a mpsc::Sender<WsMessage>,
    pub(crate) agent_id: &'a AgentId,
    pub(crate) cancel_receiver: watch::Receiver<bool>,
    pub(crate) active_downloads: ActiveDownloads,
}

impl AgentActor {
    /// Streams a directory as tar bytes to the server using the shared transfer frame size.
    pub(crate) async fn tar_download(
        &self,
        path: String,
        include_root: bool,
        context: TarDownloadContext<'_>,
    ) {
        log!(
            Level::Info,
            "Started tar download: request_id={}, path={}",
            context.request_id,
            path
        );
        TarDownloadWorker {
            path,
            include_root,
            request_id: context.request_id,
            write: context.write.clone(),
            write_text: context.write_text.clone(),
            agent_id: context.agent_id.clone(),
            cancel_receiver: context.cancel_receiver,
            active_downloads: context.active_downloads,
            chunk_index: ChunkIndex::new(0),
        }
        .process()
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    async fn write_tree(root: &Path) {
        tokio::fs::create_dir_all(root.join("nested").join("deeper"))
            .await
            .expect("nested directories should be created");
        tokio::fs::create_dir_all(root.join("empty"))
            .await
            .expect("empty directory should be created");
        tokio::fs::write(root.join("top.txt"), b"directory archive root file")
            .await
            .expect("root file should be written");
        tokio::fs::write(
            root.join("nested").join("deeper").join("child.txt"),
            b"directory archive nested file",
        )
        .await
        .expect("nested file should be written");
        tokio::fs::write(root.join("a".repeat(120)), b"long name")
            .await
            .expect("long member name should be written so GNU long-link size is covered");
    }

    #[tokio::test]
    async fn predicted_tar_size_matches_builder_stream() {
        let temp_dir = TempDir::create();
        let source_root = temp_dir.path().join("tar-size-tree");
        write_tree(&source_root).await;

        for include_root in [true, false] {
            let predicted = measure_directory(&source_root, include_root, &watch::channel(false).1)
                .await
                .expect("metadata walk should succeed")
                .expect("uncanceled walk should return a size")
                .tar_bytes;
            let encoded = write_directory_tar(Vec::new(), &source_root, include_root)
                .expect("tar builder should encode the same tree");
            assert_eq!(
                predicted,
                encoded.len() as u64,
                "predicted tar size must include headers, padding, and end blocks for include_root={include_root}"
            );
        }

        let empty_root = temp_dir.path().join("tar-size-empty");
        tokio::fs::create_dir_all(&empty_root)
            .await
            .expect("empty directory should be created");
        let predicted_empty = measure_directory(&empty_root, true, &watch::channel(false).1)
            .await
            .expect("empty-directory walk should succeed")
            .expect("uncanceled empty walk should return a size")
            .tar_bytes;
        let encoded_empty = write_directory_tar(Vec::new(), &empty_root, true)
            .expect("empty directory should still encode a root member and end blocks");
        assert_eq!(
            predicted_empty,
            encoded_empty.len() as u64,
            "empty directories still have a root header plus two end blocks"
        );
    }

    #[tokio::test]
    async fn canceled_size_walk_returns_none() {
        let temp_dir = TempDir::create();
        let source_root = temp_dir.path().join("tar-size-canceled");
        tokio::fs::create_dir_all(&source_root)
            .await
            .expect("directory should be created");
        let (_cancel_sender, cancel_receiver) = watch::channel(true);

        let measured = measure_directory(&source_root, true, &cancel_receiver)
            .await
            .expect("a canceled walk is not a filesystem failure");
        assert_eq!(
            measured, None,
            "cancel must stop the walk before it publishes a stale total"
        );
    }
}
