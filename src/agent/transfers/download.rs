use super::super::{ActiveDownloads, AgentActor, raw::send_framed_stream_bytes};
use anyhow::{Context, Result, bail};
use redoor::{
    Level, log,
    streaming::{StreamChunkFrameRequest, StreamPayloadKind},
    types::{ChunkIndex, RequestId},
};
use std::path::{Path, PathBuf};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Appends a directory tree into a tar builder in stable order so streams are deterministic.
fn append_directory_entries(
    builder: &mut tar::Builder<ChannelTarWriter>,
    source_root: &Path,
    current_path: &Path,
) -> Result<()> {
    let mut entries = std::fs::read_dir(current_path)
        .with_context(|| format!("Failed to read directory: {}", current_path.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("Failed to read directory entry: {}", current_path.display()))?;

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
        let metadata = std::fs::symlink_metadata(&entry_path)
            .with_context(|| format!("Failed to read entry metadata: {}", entry_path.display()))?;

        if metadata.is_dir() {
            builder
                .append_dir(&relative_path, &entry_path)
                .with_context(|| {
                    format!(
                        "Failed to append directory to tar: {}",
                        entry_path.display()
                    )
                })?;
            append_directory_entries(builder, source_root, &entry_path)?;
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
    request_id: RequestId,
    write: mpsc::Sender<WsMessage>,
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

    /// Runs the tar streaming loop until EOF, cancellation, or failure.
    async fn process(mut self) {
        let source_path = PathBuf::from(&self.path);

        let metadata = match tokio::fs::metadata(&source_path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                let error_message = format!("Failed to open directory: {}", error);
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

        let (tar_sender, mut tar_receiver) = mpsc::channel::<Vec<u8>>(8);
        let source_path_for_worker = source_path.clone();

        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Handle::current();
            let writer = ChannelTarWriter {
                sender: tar_sender,
                runtime,
            };
            let mut builder = tar::Builder::new(writer);

            let result = append_directory_entries(
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
            "Tar directory download complete: path={}, chunks={}",
            self.path,
            self.chunk_index.display_number()
        );
        self.cleanup().await;
    }
}

impl AgentActor {
    /// Streams a directory as tar bytes to the server using the shared transfer frame size.
    pub(crate) async fn tar_download(
        &self,
        path: String,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
        cancel_receiver: watch::Receiver<bool>,
        active_downloads: ActiveDownloads,
    ) {
        TarDownloadWorker {
            path,
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
