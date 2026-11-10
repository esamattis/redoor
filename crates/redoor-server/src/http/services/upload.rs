//! Server-to-agent uploads (raw files, archives, edits) for REST, MCP and agent upgrades.

use crate::actors::router::{
    CommitDirectUploadRequest, OutboundError, OutboundFailure, OutboundFailureReason,
    OutboundStream, RouterError, RouterHandle, RouterMsg, StartUploadRequest, UploadStartOutcome,
};
use crate::http::{agent_client::STANDARD_TIMEOUT, error::ApiError};
use axum::body::Body;
use bytes::Bytes;
use futures_util::StreamExt;
use redoor_core::log_failure;
use redoor_protocol::wire::request::{
    self, AgentRequest, CommandError, CommandOutcome, DecodeError,
};
use redoor_protocol::{
    ids::{AgentId, RequestId},
    wire::{command::Command, policy::UploadKind, stream::StreamChunk},
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
            completion,
            cancel_guard,
        })))
    }

    /// Request id of the upload, which public upload-request tokens map to transfers.
    pub(crate) fn request_id(&self) -> RequestId {
        self.stream.request_id()
    }

    /// Streams an HTTP request body into the upload without buffering it.
    pub(crate) async fn forward_body(&mut self, body: Body) -> Result<(), ApiError> {
        let mut body_stream = body.into_data_stream();
        while let Some(next_chunk) = body_stream.next().await {
            let data = next_chunk.map_err(|error| {
                ApiError::bad_request(format!("Failed to read request body: {error}"))
            })?;
            self.send(&data).await?;
        }
        Ok(())
    }

    /// Forwards one producer chunk while enforcing the declared total byte count.
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
        let result = self.stream.send_data(Bytes::copy_from_slice(data), false).await;
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
