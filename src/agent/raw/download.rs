use super::{
    super::{ActiveDownloads, AgentActor},
    send_framed_stream_bytes,
};
use redoor::{
    Level, log,
    streaming::{self, StreamChunkFrameRequest},
    types::{ChunkIndex, RequestId},
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Holds the state needed to start one raw download worker.
pub(crate) struct RawDownloadContext<'a> {
    pub(crate) request_id: RequestId,
    pub(crate) write: &'a mpsc::Sender<WsMessage>,
    pub(crate) cancel_receiver: watch::Receiver<bool>,
    pub(crate) active_downloads: ActiveDownloads,
}

/// Outcome of waiting for either the next file read or a cancel signal.
enum RawDownloadEvent {
    Read(std::io::Result<usize>),
    Continue,
    Cancel,
    Exit,
    Send(bool),
}

/// Owns the state and side effects for one in-progress raw file download.
struct RawDownloadWorker {
    path: String,
    range_start: Option<u64>,
    range_end: Option<u64>,
    request_id: RequestId,
    write: mpsc::Sender<WsMessage>,
    cancel_receiver: watch::Receiver<bool>,
    active_downloads: ActiveDownloads,
    chunk_index: ChunkIndex,
}

impl RawDownloadWorker {
    const CANCEL_MESSAGE: &'static [u8] = b"Download canceled by server";

    /// Waits for the cooperative cancel signal used by download workers.
    async fn wait_for_event(&mut self) -> RawDownloadEvent {
        Self::wait_for_cancel(&mut self.cancel_receiver).await
    }

    /// Waits on a split receiver so payload sends can race cancellation without borrowing all state.
    async fn wait_for_cancel(cancel_receiver: &mut watch::Receiver<bool>) -> RawDownloadEvent {
        match cancel_receiver.changed().await {
            Ok(()) if *cancel_receiver.borrow() => RawDownloadEvent::Cancel,
            Ok(()) => RawDownloadEvent::Continue,
            Err(_) => RawDownloadEvent::Exit,
        }
    }

    /// Frames and forwards one raw download payload over the websocket.
    async fn send_chunk(&mut self, request: StreamChunkFrameRequest<'_>) -> bool {
        send_framed_stream_bytes(&self.write, &mut self.chunk_index, request).await
    }

    /// Keeps priority cancellation responsive while a throttled payload lane applies backpressure.
    async fn send_chunk_while_cancelable(
        &mut self,
        request: StreamChunkFrameRequest<'_>,
    ) -> RawDownloadEvent {
        let write = &self.write;
        let chunk_index = &mut self.chunk_index;
        let cancel_receiver = &mut self.cancel_receiver;
        tokio::select! {
            sent = send_framed_stream_bytes(write, chunk_index, request) => RawDownloadEvent::Send(sent),
            event = Self::wait_for_cancel(cancel_receiver) => event,
        }
    }

    /// Unregisters the download worker from the active download registry.
    async fn cleanup(&self) {
        self.active_downloads.remove(self.request_id);
    }

    /// Sends the cancellation frame expected by the server and exits.
    async fn cancel(mut self) {
        log!(
            Level::Info,
            "Stopping raw download after cancel: request_id={}, path={}",
            self.request_id,
            self.path
        );
        self.cleanup().await;
        let _ = self
            .send_chunk(
                StreamChunkFrameRequest::new(self.request_id, Self::CANCEL_MESSAGE).is_error(true),
            )
            .await;
    }

    /// Stops quietly after the download registry has been torn down.
    async fn shutdown(self) {
        self.cleanup().await;
    }

    /// Runs the raw download loop until EOF, cancellation, or failure.
    async fn process(mut self) {
        match File::open(&self.path).await {
            Ok(mut file) => {
                let chunk_size = streaming::CHUNK_SIZE;
                let mut buffer = vec![0u8; chunk_size];
                let mut bytes_remaining: Option<u64> = None;
                let mut pending_chunk: Option<Vec<u8>> = None;

                if let Some(start) = self.range_start {
                    if let Err(error) = file.seek(std::io::SeekFrom::Start(start)).await {
                        log!(Level::Error, "Failed to seek file: {error:#}");
                        let error_msg = format!("Failed to seek file: {error:#}");
                        let _ = self
                            .send_chunk(
                                StreamChunkFrameRequest::new(self.request_id, error_msg.as_bytes())
                                    .is_error(true),
                            )
                            .await;
                        return;
                    }

                    if let Some(end) = self.range_end {
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
                        event = self.wait_for_event() => event,
                        read_result = file.read(&mut buffer) => RawDownloadEvent::Read(read_result),
                    } {
                        RawDownloadEvent::Continue => continue,
                        RawDownloadEvent::Cancel => {
                            drop(file);
                            self.cancel().await;
                            return;
                        }
                        RawDownloadEvent::Exit => {
                            self.shutdown().await;
                            return;
                        }
                        RawDownloadEvent::Read(read_result) => match read_result {
                            Ok(0) => break,
                            Ok(bytes_read) => {
                                if let Some(ref mut remaining) = bytes_remaining {
                                    *remaining = remaining.saturating_sub(bytes_read as u64);
                                }

                                if let Some(data) =
                                    pending_chunk.replace(buffer[..bytes_read].to_vec())
                                {
                                    match self
                                        .send_chunk_while_cancelable(
                                            StreamChunkFrameRequest::new(self.request_id, &data)
                                                .is_last(false),
                                        )
                                        .await
                                    {
                                        RawDownloadEvent::Send(true)
                                        | RawDownloadEvent::Continue => {}
                                        RawDownloadEvent::Cancel => {
                                            drop(file);
                                            self.cancel().await;
                                            return;
                                        }
                                        RawDownloadEvent::Send(false) | RawDownloadEvent::Exit => {
                                            log!(
                                                Level::Warning,
                                                "WebSocket channel full or closed, aborting download"
                                            );
                                            self.cleanup().await;
                                            return;
                                        }
                                        RawDownloadEvent::Read(_) => {
                                            unreachable!("send wait cannot read a file")
                                        }
                                    }
                                }
                            }
                            Err(error) => {
                                log!(Level::Error, "Failed to read file: {error:#}");
                                let error_msg = format!("Failed to read file: {error:#}");
                                let _ = self
                                    .send_chunk(
                                        StreamChunkFrameRequest::new(
                                            self.request_id,
                                            error_msg.as_bytes(),
                                        )
                                        .is_error(true),
                                    )
                                    .await;
                                self.cleanup().await;
                                return;
                            }
                        },
                        RawDownloadEvent::Send(_) => unreachable!("read wait cannot send a chunk"),
                    }
                }

                let final_chunk = pending_chunk.unwrap_or_default();
                match self
                    .send_chunk_while_cancelable(StreamChunkFrameRequest::new(
                        self.request_id,
                        &final_chunk,
                    ))
                    .await
                {
                    RawDownloadEvent::Cancel => {
                        drop(file);
                        self.cancel().await;
                        return;
                    }
                    RawDownloadEvent::Send(_) | RawDownloadEvent::Continue => {}
                    RawDownloadEvent::Exit => {
                        self.cleanup().await;
                        return;
                    }
                    RawDownloadEvent::Read(_) => unreachable!("send wait cannot read a file"),
                }

                log!(
                    Level::Info,
                    "Raw download complete: request_id={}, path={}, chunks={}",
                    self.request_id,
                    self.path,
                    self.chunk_index.display_number()
                );
                self.cleanup().await;
            }
            Err(error) => {
                log!(Level::Error, "Failed to open file: {error:#}");
                let error_msg = format!("Failed to open file: {error:#}");
                let _ = self
                    .send_chunk(
                        StreamChunkFrameRequest::new(self.request_id, error_msg.as_bytes())
                            .is_error(true),
                    )
                    .await;
                self.cleanup().await;
            }
        }
    }
}

impl AgentActor {
    /// Streams file contents to the server as reframed websocket binary chunks.
    pub(crate) async fn raw_download(
        &self,
        path: String,
        range_start: Option<u64>,
        range_end: Option<u64>,
        context: RawDownloadContext<'_>,
    ) {
        match (range_start, range_end) {
            (Some(start), Some(end)) => {
                log!(
                    Level::Info,
                    "Started raw download: request_id={}, path={}, range={}-{}",
                    context.request_id,
                    path,
                    start,
                    end
                );
            }
            (Some(start), None) => {
                log!(
                    Level::Info,
                    "Started raw download: request_id={}, path={}, range_start={}",
                    context.request_id,
                    path,
                    start
                );
            }
            (None, Some(end)) => {
                log!(
                    Level::Info,
                    "Started raw download: request_id={}, path={}, range_end={}",
                    context.request_id,
                    path,
                    end
                );
            }
            (None, None) => {
                log!(
                    Level::Info,
                    "Started raw download: request_id={}, path={}",
                    context.request_id,
                    path
                );
            }
        }
        RawDownloadWorker {
            path,
            range_start,
            range_end,
            request_id: context.request_id,
            write: context.write.clone(),
            cancel_receiver: context.cancel_receiver,
            active_downloads: context.active_downloads,
            chunk_index: ChunkIndex::new(0),
        }
        .process()
        .await;
    }
}
