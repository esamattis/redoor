use super::{ActiveDownloads, AgentActor};
use anyhow::{Context, Result, bail};
use redoor::{
    Level, log,
    streaming::{self, StreamChunkFrameRequest, StreamPayloadKind},
    types::{ChunkIndex, RequestId},
};
use std::path::{Path, PathBuf};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
    sync::{mpsc, watch},
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

impl AgentActor {
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

    pub(crate) async fn send_framed_stream_bytes(
        write: &mpsc::Sender<WsMessage>,
        chunk_index: &mut ChunkIndex,
        request: StreamChunkFrameRequest<'_>,
    ) -> bool {
        let mut frames =
            streaming::StreamChunkFrames::new(request.starting_chunk_index(*chunk_index));

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

    /// Streams file contents to the server as reframed websocket binary chunks.
    pub(crate) async fn raw_download(
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
                    if let Err(error) = file.seek(std::io::SeekFrom::Start(start)).await {
                        log!(Level::Error, "Failed to seek file: {}", error);
                        let error_msg = format!("Failed to seek file: {}", error);
                        let _ = Self::send_framed_stream_bytes(
                            write,
                            &mut chunk_index,
                            StreamChunkFrameRequest::new(request_id, error_msg.as_bytes())
                                .is_error(true),
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

                    if read_size != buffer.len() {
                        buffer.resize(read_size, 0);
                    }

                    match tokio::select! {
                        changed = cancel_receiver.changed() => {
                            match changed {
                                Ok(()) if *cancel_receiver.borrow() => {
                                    log!(
                                        Level::Info,
                                        "Stopping raw download after cancel: request_id={}, path={}",
                                        request_id,
                                        path
                                    );
                                    let _ = Self::send_framed_stream_bytes(
                                        write,
                                        &mut chunk_index,
                                        StreamChunkFrameRequest::new(request_id, cancel_message)
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
                        read_result = file.read(&mut buffer) => read_result,
                    } {
                        Ok(0) => break,
                        Ok(bytes_read) => {
                            if let Some(ref mut remaining) = bytes_remaining {
                                *remaining = remaining.saturating_sub(bytes_read as u64);
                            }

                            if let Some(data) = pending_chunk.replace(buffer[..bytes_read].to_vec())
                            {
                                if !Self::send_framed_stream_bytes(
                                    write,
                                    &mut chunk_index,
                                    StreamChunkFrameRequest::new(request_id, &data).is_last(false),
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
                        Err(error) => {
                            log!(Level::Error, "Failed to read file: {}", error);
                            let error_msg = format!("Failed to read file: {}", error);
                            let _ = Self::send_framed_stream_bytes(
                                write,
                                &mut chunk_index,
                                StreamChunkFrameRequest::new(request_id, error_msg.as_bytes())
                                    .is_error(true),
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
                    &mut chunk_index,
                    StreamChunkFrameRequest::new(request_id, &final_chunk),
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
            Err(error) => {
                log!(Level::Error, "Failed to open file: {}", error);
                let error_msg = format!("Failed to open file: {}", error);
                let mut chunk_index = ChunkIndex::new(0);
                let _ = Self::send_framed_stream_bytes(
                    write,
                    &mut chunk_index,
                    StreamChunkFrameRequest::new(request_id, error_msg.as_bytes()).is_error(true),
                )
                .await;
                Self::remove_active_download(&active_downloads, request_id).await;
            }
        }
    }
}
