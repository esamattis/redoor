//! Server-to-agent uploads (raw files, archives, edits) for REST, MCP and agent upgrades.

use crate::actors::router::{
    CommitDirectUploadRequest, OutboundError, OutboundFailure, OutboundFailureReason,
    OutboundStream, RouterError, RouterHandle, RouterMsg, StartUploadRequest, UploadStartOutcome,
};
use crate::http::{agent_client::STANDARD_TIMEOUT, error::ApiError};
use axum::body::Body;
use bytes::{Bytes, BytesMut};
use futures_util::{FutureExt, StreamExt};
use redoor_core::log_failure;
use redoor_protocol::wire::request::{
    self, AgentRequest, CommandError, CommandOutcome, DecodeError,
};
use redoor_protocol::{
    ids::{AgentId, RequestId},
    wire::{
        command::Command,
        policy::UploadKind,
        stream::{MAX_TRANSFER_FRAME_PAYLOAD_BYTES, StreamChunk},
    },
};
use tokio::sync::oneshot;

/// Result of starting an upload.
pub(crate) enum UploadStart {
    /// The agent worker is ready for the body.
    Ready(Box<AgentUpload>),
    /// The agent already finished successfully before asking for any byte (an empty file).
    Completed,
}

/// Owns one admitted server-to-agent upload and cancels it if its producer exits early.
pub(crate) struct AgentUpload {
    router: RouterHandle,
    agent_id: AgentId,
    kind: UploadKind,
    total_bytes: u64,
    bytes_written: u64,
    /// Writes frames straight onto the connection's bulk lane, spending per-stream credit.
    stream: OutboundStream,
    /// Producer bytes not yet sent because they do not fill a frame yet.
    frames: FrameBuffer,
    completion: oneshot::Receiver<Result<CommandOutcome, RouterError>>,
    cancel_guard: UploadCancelGuard,
}

impl AgentUpload {
    /// Admits an upload command and waits until the agent worker is ready for bytes.
    ///
    /// Setup failures the agent reports before readiness (missing parent, permission denied,
    /// existing destination) come back as the matching [`ApiError`].
    pub(crate) async fn start(
        router: &RouterHandle,
        agent_id: AgentId,
        command: Command,
        path: String,
        total_bytes: u64,
    ) -> Result<UploadStart, ApiError> {
        let Some(kind) = command.policy().upload_kind() else {
            return Err(ApiError::internal("Command does not upload a stream"));
        };
        let (completion_sender, completion) = oneshot::channel();
        let (ready_sender, ready) = oneshot::channel();
        let stream = router
            .request(|reply| {
                RouterMsg::StartUploadStreamRest(StartUploadRequest {
                    agent_id: agent_id.clone(),
                    command,
                    path: path.clone(),
                    total_bytes,
                    completion_sender,
                    ready_sender,
                    reply,
                })
            })
            .await??;
        let request_id = stream.request_id();
        let mut cancel_guard = UploadCancelGuard {
            router: router.clone(),
            agent_id: agent_id.clone(),
            request_id,
            armed: true,
        };
        let outcome = tokio::time::timeout(STANDARD_TIMEOUT, ready)
            .await
            .map_err(|_| ApiError::internal("Timed out waiting for upload readiness"))?
            .map_err(|_| ApiError::internal("Upload readiness channel closed"))?;
        match outcome {
            Ok(UploadStartOutcome::Ready) => {}
            Ok(UploadStartOutcome::Finished(result)) => {
                cancel_guard.armed = false;
                Self::check_completion(kind, (*result)?)?;
                return Ok(UploadStart::Completed);
            }
            Err(error) => {
                cancel_guard.armed = false;
                return Err(error.into());
            }
        }
        Ok(UploadStart::Ready(Box::new(Self {
            router: router.clone(),
            agent_id,
            kind,
            total_bytes,
            bytes_written: 0,
            stream,
            frames: FrameBuffer::default(),
            completion,
            cancel_guard,
        })))
    }

    /// Request id of the upload, which public upload-request tokens map to transfers.
    pub(crate) fn request_id(&self) -> RequestId {
        self.stream.request_id()
    }

    /// Streams an HTTP request body into the upload without buffering it.
    ///
    /// Only body bytes that are already available are coalesced: once the client has nothing
    /// more ready, the partial frame is flushed before waiting, so a slow or pausing client's
    /// bytes still reach the agent (and the progress display) right away.
    pub(crate) async fn forward_body(&mut self, body: Body) -> Result<(), ApiError> {
        let mut body_stream = body.into_data_stream();
        loop {
            let next = match body_stream.next().now_or_never() {
                Some(next) => next,
                None => {
                    self.flush().await?;
                    body_stream.next().await
                }
            };
            let Some(next_chunk) = next else {
                break;
            };
            let data = next_chunk.map_err(|error| {
                ApiError::bad_request(format!("Failed to read request body: {error}"))
            })?;
            self.send(&data).await?;
        }
        Ok(())
    }

    /// Forwards one producer chunk while enforcing the declared total byte count.
    ///
    /// Bytes are coalesced into full frames: body chunks and vault reads come in arbitrary
    /// sizes, and each tiny frame would cost a whole unit of the small per-stream credit window
    /// plus an allocation. Only full frames are sent here, one at a time and each after its
    /// credit, so the caller still does not read more input while the agent is behind.
    pub(crate) async fn send(&mut self, data: &[u8]) -> Result<(), ApiError> {
        self.bytes_written += data.len() as u64;
        if !self.is_tar() && self.bytes_written > self.total_bytes {
            let message = format!(
                "{} exceeded Content-Length header: expected {} bytes, received {}",
                self.operation_name(),
                self.total_bytes,
                self.bytes_written
            );
            self.cancel_guard.armed = false;
            // The router records why the transfer failed and cancels the agent's worker.
            let _ = self
                .router
                .send_async(RouterMsg::OutboundStreamFailed(OutboundFailure {
                    agent_id: self.agent_id.clone(),
                    request_id: self.request_id(),
                    reason: OutboundFailureReason::ProducerAborted(message.clone()),
                }))
                .await;
            return Err(ApiError::bad_request(message));
        }
        let mut rest = data;
        while let Some(frame) = self.frames.fill(&mut rest) {
            let result = self.stream.send_data(frame, false).await;
            self.forward_result(result).await?;
        }
        Ok(())
    }

    /// Sends the buffered partial frame, if any.
    ///
    /// Producers call this when their input stalls, so coalescing never holds bytes back
    /// waiting for data that may take long to arrive.
    pub(crate) async fn flush(&mut self) -> Result<(), ApiError> {
        let Some(frame) = self.frames.take_remainder() else {
            return Ok(());
        };
        let result = self.stream.send_data(frame, false).await;
        self.forward_result(result).await
    }

    /// Ends the body and waits for the agent to publish it; returns the bytes written.
    ///
    /// Edits hand their terminal frame to the router, which owns the commit boundary.
    pub(crate) async fn finish(mut self) -> Result<u64, ApiError> {
        if !self.is_tar() && self.bytes_written != self.total_bytes {
            return Err(ApiError::bad_request(format!(
                "{} stream ended before completion: expected {} bytes, received {}",
                self.operation_name(),
                self.total_bytes,
                self.bytes_written
            )));
        }
        // The last partial frame must reach the agent before the terminal frame (or the edit
        // commit, which the router sends) ends the stream.
        self.flush().await?;
        if self.kind == UploadKind::EditFile {
            self.commit_edit().await?;
        } else {
            let result = self.stream.send_data(Bytes::new(), true).await;
            self.forward_result(result).await?;
        }
        let result = (&mut self.completion).await.map_err(|error| {
            ApiError::internal(format!("Failed waiting for upload completion: {error}"))
        })??;
        self.cancel_guard.armed = false;
        Self::check_completion(self.kind, result)?;
        Ok(self.bytes_written)
    }

    /// Decodes the upload's result as the response of its own request type.
    fn check_completion(kind: UploadKind, result: CommandOutcome) -> Result<(), ApiError> {
        let decoded = match kind {
            UploadKind::RawUpload => request::RawUpload::decode(result),
            UploadKind::TarUpload => request::TarUpload::decode(result),
            UploadKind::EditFile => request::EditFile::decode(result),
        };
        decoded.map_err(|error| match error {
            DecodeError::Failed(CommandError { kind, message }) => {
                ApiError::Command { kind, message }
            }
            DecodeError::Malformed(_) => ApiError::Unexpected("completing an upload"),
        })
    }

    /// Maps the outcome of sending frames directly to the agent, never through the router;
    /// only a lost lane is reported to the router as a terminal event.
    async fn forward_result(&mut self, result: Result<(), OutboundError>) -> Result<(), ApiError> {
        match result {
            Ok(()) => Ok(()),
            Err(OutboundError::Stopped) => Err(RouterError::ClientCanceledUpload.into()),
            Err(OutboundError::LaneClosed) => {
                let _ = self
                    .router
                    .send_async(RouterMsg::OutboundStreamFailed(OutboundFailure {
                        agent_id: self.agent_id.clone(),
                        request_id: self.request_id(),
                        reason: OutboundFailureReason::LaneClosed,
                    }))
                    .await;
                Err(RouterError::UploadForwardFailed {
                    agent_id: self.agent_id.to_string(),
                    request_id: self.request_id().to_string(),
                }
                .into())
            }
        }
    }

    /// Whether the body is a tar archive of unknown length.
    fn is_tar(&self) -> bool {
        self.kind == UploadKind::TarUpload
    }

    /// Names the semantic operation in transport errors.
    fn operation_name(&self) -> &'static str {
        if self.kind == UploadKind::EditFile {
            "File edit"
        } else {
            "Upload"
        }
    }

    /// Atomically publishes the edit boundary with router ownership of its terminal frame.
    async fn commit_edit(&mut self) -> Result<(), ApiError> {
        let terminal = StreamChunk::data(self.request_id(), Vec::new(), true);
        let (reply, response) = oneshot::channel();
        self.router
            .send_async(RouterMsg::CommitDirectUpload(CommitDirectUploadRequest {
                agent_id: self.agent_id.clone(),
                request_id: self.request_id(),
                chunk: terminal,
                reply,
            }))
            .await
            .map_err(|error| {
                ApiError::internal(format!("Failed to hand off edit commit: {error}"))
            })?;
        // Once queued, router-owned work either delivers the terminal or starts worker cleanup.
        self.cancel_guard.armed = false;
        tokio::time::timeout(STANDARD_TIMEOUT, response)
            .await
            .map_err(|_| ApiError::internal("Timed out waiting for edit commit handoff"))?
            .map_err(|_| ApiError::internal("Edit commit handoff channel closed"))??;
        Ok(())
    }
}

/// Coalesces producer bytes into full stream frames.
///
/// Kept apart from [`AgentUpload`] so the sending loop stays a plain "fill, send full frame"
/// cycle and the buffering rules can be reasoned about on their own. Dropping it discards the
/// partial frame, which is what every failure path wants: the agent's worker is canceled and
/// must not receive a tail of a body that was rejected.
#[derive(Default)]
struct FrameBuffer {
    /// At most one frame of bytes; allocated only when bytes arrive, so a finished or empty
    /// upload holds no frame-sized buffer.
    pending: BytesMut,
}

impl FrameBuffer {
    /// Moves as much of `data` as fits into the pending frame and returns the frame once full.
    ///
    /// `data` is advanced past the consumed bytes. Callers loop until this returns `None`,
    /// which means everything was buffered and the pending frame still has room.
    fn fill(&mut self, data: &mut &[u8]) -> Option<Bytes> {
        if self.pending.capacity() == 0 && !data.is_empty() {
            self.pending.reserve(MAX_TRANSFER_FRAME_PAYLOAD_BYTES);
        }
        let room = MAX_TRANSFER_FRAME_PAYLOAD_BYTES - self.pending.len();
        let (head, rest) = data.split_at(data.len().min(room));
        self.pending.extend_from_slice(head);
        *data = rest;
        (self.pending.len() == MAX_TRANSFER_FRAME_PAYLOAD_BYTES)
            .then(|| std::mem::take(&mut self.pending).freeze())
    }

    /// Takes the final partial frame, if any bytes are pending.
    fn take_remainder(&mut self) -> Option<Bytes> {
        (!self.pending.is_empty()).then(|| std::mem::take(&mut self.pending).freeze())
    }
}

/// Cancels an upload whose producer exits before it reaches a terminal state.
struct UploadCancelGuard {
    router: RouterHandle,
    agent_id: AgentId,
    request_id: RequestId,
    armed: bool,
}

impl Drop for UploadCancelGuard {
    /// Waits for mailbox capacity in a task: a lost cancel would leave the agent waiting for
    /// bytes that never come.
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let router = self.router.clone();
        let agent_id = self.agent_id.clone();
        let request_id = self.request_id;
        redoor_core::logging::spawn_in_user_scope(async move {
            if let Err(error) = router
                .send_async(RouterMsg::CancelTransfer {
                    agent_id: agent_id.clone(),
                    request_id,
                })
                .await
            {
                log_failure!(
                    redoor_protocol::wire::log::Level::Error,
                    "Failed to queue dropped upload cleanup: agent_id={}, request_id={}, error={}",
                    agent_id,
                    request_id,
                    error
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// Builds an upload over a detached stream, plus the frames it sends and the sender of its
    /// completion; the router is closed, so failure paths can report to it without one.
    fn upload(
        kind: UploadKind,
        total_bytes: u64,
    ) -> (
        AgentUpload,
        mpsc::Receiver<StreamChunk>,
        oneshot::Sender<Result<CommandOutcome, RouterError>>,
    ) {
        let request_id = RequestId::new(11);
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let router = RouterHandle::closed_for_test();
        let (stream, frames) = OutboundStream::detached(request_id, 64);
        let (completion_sender, completion) = oneshot::channel();
        let upload = AgentUpload {
            router: router.clone(),
            agent_id: agent_id.clone(),
            kind,
            total_bytes,
            bytes_written: 0,
            stream,
            frames: FrameBuffer::default(),
            completion,
            cancel_guard: UploadCancelGuard {
                router,
                agent_id,
                request_id,
                armed: false,
            },
        };
        (upload, frames, completion_sender)
    }

    /// Collects the frames sent so far as (payload length, FIN) pairs.
    fn sent(frames: &mut mpsc::Receiver<StreamChunk>) -> Vec<(usize, bool)> {
        let mut sent = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            sent.push((frame.data.len(), frame.is_last));
        }
        sent
    }

    /// Odd-sized producer chunks become full frames, and finishing sends the remainder
    /// before the terminal frame.
    #[tokio::test]
    async fn sends_only_full_frames_until_finish_flushes_the_remainder() {
        let frame = MAX_TRANSFER_FRAME_PAYLOAD_BYTES;
        let total = 2 * frame + 100;
        let (mut upload, mut frames, completion) = upload(UploadKind::RawUpload, total as u64);
        // Mimics the vault writer, whose reads alternate a full chunk and a short tail.
        for piece in [frame - 16, 16, frame, 100] {
            upload.send(&vec![1u8; piece]).await.unwrap();
        }
        // Nothing smaller than a frame leaves before the end, so each frame spends its credit
        // on a full payload.
        assert_eq!(sent(&mut frames), vec![(frame, false), (frame, false)]);

        completion
            .send(Ok(CommandOutcome::Ok(serde_json::Value::Null)))
            .unwrap();
        let written = upload.finish().await.unwrap();
        // The declared length was forwarded in full.
        assert_eq!(written, total as u64);
        // The buffered tail goes out as an ordinary frame, then the empty FIN ends the stream.
        assert_eq!(sent(&mut frames), vec![(100, false), (0, true)]);
    }

    /// A client that pauses mid-body still gets its partial frame forwarded, so a slow
    /// upload shows progress and reaches the agent without waiting for a full frame.
    #[tokio::test]
    async fn stalled_body_flushes_its_partial_frame() {
        let (mut upload, mut frames, _completion) = upload(UploadKind::RawUpload, 10);
        let (sender, mut receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(1);
        let body = Body::from_stream(async_stream::stream! {
            while let Some(item) = receiver.recv().await {
                yield item;
            }
        });
        let forwarding = tokio::spawn(async move {
            let result = upload.forward_body(body).await;
            (upload, result)
        });
        sender.send(Ok(Bytes::from_static(b"12345"))).await.unwrap();
        let frame = frames.recv().await.unwrap();
        // The bytes left while the body was still open, as soon as no more input was ready.
        assert_eq!((frame.data.len(), frame.is_last), (5, false));
        drop(sender);
        let (_upload, result) = forwarding.await.unwrap();
        // Ending the body is not an error; finishing is a separate step.
        assert!(result.is_ok());
    }

    /// A body that overruns its declared length is rejected without forwarding its buffered
    /// bytes.
    #[tokio::test]
    async fn overrun_sends_nothing_buffered() {
        let (mut upload, mut frames, _completion) = upload(UploadKind::RawUpload, 10);
        upload.send(b"12345").await.unwrap();
        // The overrun is a client error.
        assert!(upload.send(b"678901").await.is_err());
        // Neither the buffered prefix nor the overrunning chunk reached the agent.
        assert!(sent(&mut frames).is_empty());
    }

    /// A body that ends short is rejected at finish and its buffered tail is dropped, not
    /// flushed as if the upload were complete.
    #[tokio::test]
    async fn short_body_sends_nothing_buffered_at_finish() {
        let (mut upload, mut frames, _completion) = upload(UploadKind::RawUpload, 10);
        upload.send(b"12345").await.unwrap();
        // A truncated body must fail instead of publishing.
        assert!(upload.finish().await.is_err());
        // No data frame and no FIN was sent for the rejected body.
        assert!(sent(&mut frames).is_empty());
    }
}
