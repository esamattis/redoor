//! REST uploads, archive uploads and file edits streaming into one agent.
//!
//! Body frames go from the HTTP producer straight onto the agent's bulk lane through an
//! [`OutboundStream`]; the router owns admission, the readiness barrier (the agent's first
//! credit grant), the irreversible commit and publication boundaries, cancellation and the
//! final result. A producer that gives up never sends an error frame: the router cancels the
//! agent's worker, which discards its staging and answers with its result.

use super::super::RouterError;
use super::super::flows::{CopyPhase, Flow, FlowId, UploadFlow, UploadPhase};
use super::super::messages::{
    CommitDirectUploadRequest, OutboundFailure, OutboundFailureReason, RouteResponse,
    StartUploadRequest, UploadStartOutcome,
};
use super::super::progress::UploadStartContext;
use super::super::state::RouterState;
use super::super::streams::{OutboundError, OutboundStart, OutboundStream, StreamLease};
use redoor_core::{log, log_command_failure};
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::policy::UploadKind;
use redoor_protocol::wire::request::CommandOutcome;
use redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES;
use redoor_protocol::{
    api::transfers::TransferProgressState,
    ids::{AgentId, RequestId},
    wire::ServerToAgent,
};

/// Uploads (including edits and copy destinations) one connection may receive at once.
///
/// Each one holds a staging file, a worker and its credit window on the agent, and the agent
/// relies on the server for this bound, so excess uploads are refused with 503 instead of
/// piling up.
pub(crate) const MAX_UPLOADS_PER_CONNECTION: usize = 32;

impl RouterState {
    /// Admits an upload and returns its producer immediately.
    ///
    /// The producer carries the request id so HTTP can arm cancellation before it waits on
    /// the readiness barrier, which is released separately once the agent worker exists.
    pub(crate) fn start_upload(&mut self, request: StartUploadRequest) {
        let request_id = self.next_id();
        let Some(kind) = request.command.policy().upload_kind() else {
            let _ = request.reply.send(Err(RouterError::UnexpectedResponseType {
                operation: "starting direct upload command",
            }));
            return;
        };
        log!(
            Level::Info,
            "Routing REST upload command: agent_id={}, request_id={}, command={:?}",
            request.agent_id,
            request_id,
            request.command
        );
        let Some(connection) = self.agents.by_id.get_mut(&request.agent_id) else {
            log!(
                Level::Warning,
                "Agent not found for upload command: agent_id={}",
                request.agent_id
            );
            let _ = request.reply.send(Err(RouterError::AgentNotFound {
                agent_id: request.agent_id.to_string(),
            }));
            return;
        };
        if request.reply.is_closed() {
            return;
        }
        if self.flows.uploads_into(&request.agent_id) >= MAX_UPLOADS_PER_CONNECTION {
            let _ = request.reply.send(Err(RouterError::StreamLimitReached {
                agent_id: request.agent_id.to_string(),
                kind: "uploads",
            }));
            return;
        }
        let stream = OutboundStream::new(
            StreamLease::new(request_id, connection.link(), 0),
            connection.streams.open_outbound(
                request_id,
                STREAM_CREDIT_WINDOW_FRAMES,
                OutboundStart::AwaitGrant,
            ),
            false,
        );
        if !connection.send_command(request_id, request.command) {
            connection.streams.close_outbound(request_id);
            let _ = request.reply.send(Err(RouterError::ControlQueueFull {
                agent_id: request.agent_id.to_string(),
            }));
            return;
        }
        self.record_upload_start(UploadStartContext {
            request_id,
            agent_id: request.agent_id.clone(),
            path: request.path,
            total_bytes: request.total_bytes,
            kind,
        });
        self.flows.insert(
            request_id,
            Flow::Upload(UploadFlow {
                request_id,
                agent_id: request.agent_id.clone(),
                kind,
                phase: UploadPhase::AwaitingReady,
                completion: Some(request.completion_sender),
                ready: Some(request.ready_sender),
                stream: stream.clone(),
            }),
        );

        // Caller abandoned the RPC after admission; tear down local state and cancel so the
        // agent does not retain a temp-file worker.
        if request.reply.send(Ok(stream)).is_err() {
            if let Some(Flow::Upload(flow)) = self.flows.remove(request_id) {
                self.release_upload(&flow);
                self.mark_transfer_errored(
                    request_id.as_transfer_id(),
                    "Upload stream canceled by client".to_string(),
                );
                self.notify_transfer_refresh();
            }
            let _ = self.cancel_on_agent(
                &request.agent_id,
                request_id,
                redoor_protocol::wire::partials::CancelReason::Canceled,
            );
        }
    }

    /// Stops an upload's data path and forgets its credit on the agent's session.
    pub(crate) fn release_upload(&self, flow: &UploadFlow) {
        flow.stream.lease().stop();
        if let Some(connection) = self.agents.by_id.get(&flow.agent_id) {
            connection.streams.close_outbound(flow.request_id);
        }
    }

    /// Publishes the edit's irreversible boundary and takes ownership of its terminal frame.
    ///
    /// The terminal frame is sent by a router-owned task, so the inode rewrite proceeds even if
    /// the HTTP task disappears right after handing it over.
    pub(crate) fn commit_edit(&mut self, request: CommitDirectUploadRequest) {
        if let Err(error) = self.validate_commit(&request) {
            self.cancel_transfer(request.request_id, request.agent_id);
            let _ = request.reply.send(Err(error));
            return;
        }
        let Some(Flow::Upload(flow)) = self.flows.get_mut(request.request_id) else {
            return;
        };
        flow.phase = UploadPhase::Committing;
        let stream = flow.stream.clone();
        if let Some(entry) = self
            .progress
            .entries
            .get_mut(&request.request_id.as_transfer_id())
        {
            entry.cancelable = false;
            entry.pausable = false;
        }
        self.notify_transfer_refresh_immediately();
        let agent_id = request.agent_id;
        let request_id = request.request_id;
        let chunk = request.chunk;
        let reply = request.reply;
        tokio::spawn(async move {
            let result = stream.send(chunk).await.map_err(|error| match error {
                OutboundError::Stopped => RouterError::ClientCanceledUpload,
                OutboundError::LaneClosed => RouterError::UploadForwardFailed {
                    agent_id: agent_id.to_string(),
                    request_id: request_id.to_string(),
                },
            });
            let _ = reply.send(result);
        });
    }

    /// Validates that only the matching live edit can cross the irreversible boundary.
    pub(crate) fn validate_commit(
        &self,
        request: &CommitDirectUploadRequest,
    ) -> Result<(), RouterError> {
        let not_found = || RouterError::StreamNotFound {
            agent_id: request.agent_id.to_string(),
            request_id: request.request_id.to_string(),
        };
        let Some(Flow::Upload(upload)) = self.flows.get(request.request_id) else {
            return Err(not_found());
        };
        if upload.agent_id != request.agent_id {
            return Err(not_found());
        }
        if upload.kind != UploadKind::EditFile {
            return Err(RouterError::UnexpectedResponseType {
                operation: "beginning edit commit",
            });
        }
        if upload.phase != UploadPhase::Streaming {
            return Err(RouterError::ClientCanceledUpload);
        }
        if request.chunk.request_id != request.request_id
            || !request.chunk.is_last
            || !request.chunk.data.is_empty()
        {
            return Err(RouterError::UnexpectedResponseType {
                operation: "routing edit commit terminal",
            });
        }
        if !self
            .progress
            .entries
            .contains_key(&request.request_id.as_transfer_id())
        {
            return Err(not_found());
        }
        Ok(())
    }

    /// Releases the HTTP producer once the agent worker exists, or starts a copy's source.
    pub(crate) fn mark_transfer_ready(&mut self, agent_id: AgentId, request_id: RequestId) {
        let Some(flow_id) = self.flows.id_for(&agent_id, request_id) else {
            return;
        };
        match self.flows.get_mut(flow_id) {
            Some(Flow::Upload(upload)) => {
                if upload.agent_id != agent_id || upload.phase != UploadPhase::AwaitingReady {
                    return;
                }
                upload.phase = UploadPhase::Streaming;
                // A dropped readiness receiver means no body producer remains; cancel so the
                // agent does not keep a temporary-file worker forever.
                if let Some(ready) = upload.ready.take()
                    && ready.send(Ok(UploadStartOutcome::Ready)).is_err()
                {
                    self.cancel_transfer(request_id, agent_id);
                }
            }
            Some(Flow::Copy(_)) => self.start_copy_source(flow_id, &agent_id, request_id),
            Some(Flow::Command(_) | Flow::Output(_)) | None => {}
        }
    }

    /// Reserves the irreversible publication boundary only for a live destination worker.
    pub(crate) fn authorize_publication(
        &mut self,
        agent_id: &AgentId,
        request_id: RequestId,
    ) -> bool {
        let Some(flow_id) = self.flows.id_for(agent_id, request_id) else {
            return false;
        };
        // Remote copies own their destination's progress and cancellation under the public
        // copy id, so publication is authorized against that row.
        let transfer_id = match self.flows.get(flow_id) {
            Some(Flow::Copy(copy)) => match &copy.phase {
                CopyPhase::Remote(remote)
                    if remote.dest_id() == request_id && &copy.dest_agent_id == agent_id =>
                {
                    copy.progress_id
                }
                CopyPhase::Local { request_id: local }
                    if *local == request_id && &copy.dest_agent_id == agent_id =>
                {
                    copy.progress_id
                }
                _ => return false,
            },
            Some(Flow::Upload(upload))
                if &upload.agent_id == agent_id
                    && upload.kind != UploadKind::EditFile
                    && upload.phase == UploadPhase::Streaming =>
            {
                request_id.as_transfer_id()
            }
            _ => return false,
        };
        let Some(entry) = self.progress.entries.get_mut(&transfer_id) else {
            return false;
        };
        if !matches!(entry.state, TransferProgressState::Active) || !entry.cancelable {
            return false;
        }
        entry.cancelable = false;
        entry.pausable = false;
        if let Some(Flow::Upload(upload)) = self.flows.get_mut(flow_id) {
            upload.phase = UploadPhase::Publishing;
        }
        true
    }

    /// Sends a publication grant only after cancellation became unavailable in the same turn.
    ///
    /// The decision must never be lost: the agent's worker waits for it, and a granted
    /// publication is already non-cancelable, so a full priority lane retains it in a task.
    pub(crate) fn begin_upload_publication(&mut self, agent_id: AgentId, request_id: RequestId) {
        let allowed = self.authorize_publication(&agent_id, request_id);
        if let Some(connection) = self.agents.by_id.get(&agent_id) {
            let decision = ServerToAgent::PublishDecision {
                id: request_id,
                allowed,
            };
            // A closed lane means the connection is gone and teardown settles the upload.
            let _ = connection.lanes.queue_priority(decision);
        }
        if allowed {
            self.notify_transfer_refresh_immediately();
        }
    }

    /// Records a producer-side failure of an upload stream.
    pub(crate) fn fail_outbound_stream(&mut self, failure: OutboundFailure) {
        let Some(flow_id) = self.flows.id_for(&failure.agent_id, failure.request_id) else {
            return;
        };
        let Some(Flow::Upload(upload)) = self.flows.get(flow_id) else {
            return;
        };
        if upload.agent_id != failure.agent_id {
            return;
        }
        let message = match failure.reason {
            OutboundFailureReason::ProducerAborted(message) => message,
            OutboundFailureReason::LaneClosed => RouterError::UploadForwardFailed {
                agent_id: failure.agent_id.to_string(),
                request_id: failure.request_id.to_string(),
            }
            .to_string(),
        };
        self.abandon_upload(flow_id, message);
    }

    /// Fails an upload whose bytes can no longer reach the agent and stops its worker.
    fn abandon_upload(&mut self, flow_id: FlowId, message: String) {
        let Some(Flow::Upload(upload)) = self.flows.get_mut(flow_id) else {
            return;
        };
        if matches!(upload.phase, UploadPhase::Canceling { .. }) {
            return;
        }
        upload.phase = UploadPhase::Canceling { explicit: false };
        upload.stream.lease().stop();
        let (agent_id, request_id) = (upload.agent_id.clone(), upload.request_id);
        self.mark_transfer_errored(request_id.as_transfer_id(), message);
        if self
            .cancel_on_agent(
                &agent_id,
                request_id,
                redoor_protocol::wire::partials::CancelReason::Canceled,
            )
            .is_err()
            && let Some(Flow::Upload(upload)) = self.flows.remove(flow_id)
        {
            // No control owner remains that could acknowledge cancellation.
            self.release_upload(&upload);
            self.notify_transfer_refresh();
        }
    }

    /// Settles an upload from the agent's final response.
    pub(crate) fn finish_upload_response(&mut self, flow_id: FlowId, response: RouteResponse) {
        match self.flows.get(flow_id) {
            Some(Flow::Upload(upload)) if upload.agent_id == response.agent_id => {}
            Some(Flow::Upload(upload)) => {
                log!(
                    Level::Warning,
                    "Upload response agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                    response.request_id,
                    upload.agent_id,
                    response.agent_id
                );
                return;
            }
            _ => return,
        }
        let Some(Flow::Upload(mut upload)) = self.flows.remove(flow_id) else {
            return;
        };
        self.release_upload(&upload);
        let request_id = response.request_id;
        let result = response.result;
        let transfer_id = request_id.as_transfer_id();
        let completion = upload.completion.take();
        let ready = upload.ready.take();

        if let UploadPhase::Canceling { explicit } = upload.phase {
            // After REST went away the response only acknowledges cleanup; the user-visible
            // outcome is the one recorded when cancellation was initiated.
            log!(
                Level::Info,
                "Received canceled upload ack from agent: agent_id={}, request_id={}, is_error={}",
                response.agent_id,
                request_id,
                matches!(result, CommandOutcome::Error(_))
            );
            if explicit && result.failure().is_none() {
                // A publication acknowledged before cancel processing remains completed.
                self.mark_transfer_completed(transfer_id);
            } else if explicit {
                self.mark_transfer_canceled(transfer_id);
            }
            self.notify_transfer_refresh();
            if let Some(sender) = completion {
                let _ = sender.send(Err(RouterError::ClientCanceledUpload));
            }
            if let Some(sender) = ready {
                let _ = sender.send(Err(RouterError::ClientCanceledUpload));
            }
            return;
        }

        // The result can only be this upload's own, so any success means it was published.
        match &result {
            CommandOutcome::Ok(_) => {
                self.mark_transfer_completed(transfer_id);
                log!(
                    Level::Info,
                    "Routing upload completion response: agent_id={}, request_id={}",
                    response.agent_id,
                    request_id
                );
            }
            CommandOutcome::Error(error) => {
                self.mark_transfer_errored(transfer_id, error.message.clone());
                log_command_failure!(
                    error,
                    "Routing upload error response: agent_id={}, request_id={}",
                    response.agent_id,
                    request_id
                );
            }
        }
        let completion_result = Ok(result);
        self.notify_transfer_refresh();

        if let Some(sender) = ready {
            // HTTP is still blocked on readiness when setup fails before the first credit grant.
            // Deliver the real completion so permission/missing-path errors keep their
            // established status mapping instead of becoming a generic 500.
            let _ = sender.send(Ok(UploadStartOutcome::Finished(Box::new(
                completion_result,
            ))));
        } else if let Some(sender) = completion {
            let _ = sender.send(completion_result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::flows::{CopyFlow, DeleteSource, RemoteCopy, RemoteStage};
    use super::super::super::progress::CopyStartContext;
    use super::super::super::state::CopyContentKind;
    use super::super::super::streams::AgentLink;
    use super::*;
    use redoor_protocol::wire::request;
    use redoor_protocol::{
        api::transfers::{TransferDirection, TransferProgressState},
        ids::TransferId,
        wire::command::{Command, MoveSourceIdentity},
    };
    use tokio::sync::oneshot;

    /// Builds isolated router state for upload transition tests.
    fn router_state() -> RouterState {
        RouterState::new(tokio::spawn(async {}))
    }

    /// Builds a lease on a detached link; these tests never send frames.
    fn lease(request_id: RequestId) -> StreamLease {
        StreamLease::new(
            request_id,
            AgentLink::new(crate::actors::lanes::ControlLanes::bounded(1, 1).0),
            0,
        )
    }

    /// Registers one streaming upload flow plus its history row and returns its completion.
    fn record_upload(
        state: &mut RouterState,
        request_id: RequestId,
        kind: UploadKind,
    ) -> oneshot::Receiver<Result<CommandOutcome, RouterError>> {
        let (completion, completion_receiver) = oneshot::channel();
        state.record_upload_start(UploadStartContext {
            request_id,
            agent_id: redoor_core::test_support::test_agent_id("agent-1"),
            path: "/tmp/file.txt".to_string(),
            total_bytes: 4,
            kind,
        });
        state.flows.insert(
            request_id,
            Flow::Upload(UploadFlow {
                request_id,
                agent_id: redoor_core::test_support::test_agent_id("agent-1"),
                kind,
                phase: UploadPhase::Streaming,
                completion: Some(completion),
                ready: None,
                stream: OutboundStream::new(
                    lease(request_id),
                    redoor_core::stream_credit::CreditGate::default(),
                    false,
                ),
            }),
        );
        completion_receiver
    }

    /// One connection receives at most `MAX_UPLOADS_PER_CONNECTION` uploads at once; more
    /// are refused instead of piling up staging files and workers on the agent.
    #[tokio::test]
    async fn uploads_beyond_the_per_connection_cap_are_refused() {
        let mut state = router_state();
        let agent = redoor_core::test_support::test_agent_id("agent-1");
        let (lanes, _receivers) = crate::actors::lanes::ControlLanes::bounded(64, 16);
        state.agents.by_id.insert(
            agent.clone(),
            super::super::super::state::AgentConnection::from_register_request(
                super::super::super::messages::RegisterAgentRequest::for_test(
                    &agent,
                    lanes,
                    super::super::super::streams::ConnectionStreams::new(agent.clone()),
                ),
            ),
        );
        let _receivers: Vec<_> = (0..MAX_UPLOADS_PER_CONNECTION as u64)
            .map(|id| record_upload(&mut state, RequestId::new(1000 + id), UploadKind::RawUpload))
            .collect();
        let (reply, reply_receiver) = oneshot::channel();
        state.start_upload(StartUploadRequest {
            agent_id: agent,
            command: request::RawUpload {
                partial: None,
                path: "/tmp/one-too-many".to_string(),
                on_existing: redoor_protocol::api::transfers::CopyExistingMode::Override,
                ownership: Default::default(),
                executable: false,
                precondition: None,
            }
            .into(),
            path: "/tmp/one-too-many".to_string(),
            total_bytes: 1,
            completion_sender: oneshot::channel().0,
            ready_sender: oneshot::channel().0,
            reply,
        });
        // The extra upload is refused with a 503-mapped limit error, not queued.
        assert!(matches!(
            reply_receiver.await.unwrap(),
            Err(RouterError::StreamLimitReached {
                kind: "uploads",
                ..
            })
        ));
        state.ui.refresh_check_task.abort();
    }

    /// Remote copy/move destinations must reserve the public copy's lifecycle boundary.
    #[tokio::test]
    async fn remote_upload_publication_uses_copy_or_move_identity() {
        for is_move in [false, true] {
            let mut state = router_state();
            let public_id = RequestId::new(60);
            let source_id = RequestId::new(61);
            let destination_id = RequestId::new(62);
            state.record_copy_start(CopyStartContext {
                request_id: public_id.as_transfer_id(),
                source_agent_id: redoor_core::test_support::test_agent_id("source"),
                source_path: "/source".into(),
                dest_agent_id: redoor_core::test_support::test_agent_id("agent-1"),
                dest_path: "/dest".into(),
                total_bytes: 4,
                direction: TransferDirection::Copy,
            });
            state.flows.insert(
                public_id,
                Flow::Copy(Box::new(CopyFlow {
                    pause: None,
                    resumable: false,
                    progress_id: public_id.as_transfer_id(),
                    source_agent_id: redoor_core::test_support::test_agent_id("source"),
                    dest_agent_id: redoor_core::test_support::test_agent_id("agent-1"),
                    content_kind: CopyContentKind::TarDirectory,
                    then: is_move.then(|| DeleteSource {
                        path: "/source".into(),
                        identity: MoveSourceIdentity {
                            device: 1,
                            inode: 1,
                            size: 0,
                            modified_seconds: 0,
                            modified_nanoseconds: 0,
                            is_directory: true,
                        },
                    }),
                    phase: CopyPhase::Remote(Box::new(RemoteCopy {
                        source: lease(source_id),
                        dest: OutboundStream::new(
                            lease(destination_id),
                            redoor_core::stream_credit::CreditGate::default(),
                            false,
                        ),
                        stage: RemoteStage::Streaming,
                        source_finished: false,
                    })),
                })),
            );
            assert!(
                !state.authorize_publication(
                    &redoor_core::test_support::test_agent_id("source"),
                    source_id
                ),
                "the source worker cannot reserve the destination's publication boundary"
            );
            assert!(
                state.authorize_publication(
                    &redoor_core::test_support::test_agent_id("agent-1"),
                    destination_id
                ),
                "a remote destination must use public copy progress"
            );
            assert!(
                !state.progress.entries[&public_id.as_transfer_id()].cancelable,
                "the copy or move must become noncancelable before destination placement"
            );
            state.ui.refresh_check_task.abort();
        }
    }

    /// Both router orderings: accepted cancellation cannot race a later publication grant.
    #[tokio::test]
    async fn publication_boundary_orders_cancellation_for_raw_and_tar_uploads() {
        for kind in [UploadKind::RawUpload, UploadKind::TarUpload] {
            let mut state = router_state();
            let request_id = RequestId::new(51);
            let _completion = record_upload(&mut state, request_id, kind);
            assert!(
                !state.authorize_publication(
                    &redoor_core::test_support::test_agent_id("other-agent"),
                    request_id
                ),
                "another agent must not make a live upload noncancelable"
            );
            assert!(
                state
                    .cancel_public_transfer(request_id.as_transfer_id())
                    .is_ok(),
                "post-body cancellation must remain accepted before publication authorization"
            );
            assert!(
                !state.authorize_publication(
                    &redoor_core::test_support::test_agent_id("agent-1"),
                    request_id
                ),
                "an accepted cancel must prevent publication before its control reaches the agent"
            );
            state.ui.refresh_check_task.abort();

            let mut state = router_state();
            let _completion = record_upload(&mut state, request_id, kind);
            assert!(
                state.authorize_publication(
                    &redoor_core::test_support::test_agent_id("agent-1"),
                    request_id
                ),
                "the owning prepared worker must be able to reserve publication"
            );
            assert!(
                matches!(
                    state.cancel_public_transfer(request_id.as_transfer_id()),
                    Err(super::super::super::messages::CancelPublicTransferError::NotCancelable)
                ),
                "cancellation after the irreversible grant must be rejected"
            );
            state.ui.refresh_check_task.abort();
        }
    }

    /// Only a matching empty terminal of a live edit may cross the commit boundary.
    #[tokio::test]
    async fn commit_validation_accepts_only_live_edit_terminals() {
        let mut state = router_state();
        let terminal = |request_id| {
            redoor_protocol::wire::stream::StreamChunk::data(request_id, Vec::new(), true)
        };
        let edit_id = RequestId::new(41);
        let _edit_completion = record_upload(&mut state, edit_id, UploadKind::EditFile);
        let edit_request = CommitDirectUploadRequest {
            agent_id: redoor_core::test_support::test_agent_id("agent-1"),
            request_id: edit_id,
            chunk: terminal(edit_id),
            reply: oneshot::channel().0,
        };
        // A matching empty terminal is the only frame allowed to authorize an edit commit.
        assert!(state.validate_commit(&edit_request).is_ok());

        let upload_id = RequestId::new(42);
        let _upload_completion = record_upload(&mut state, upload_id, UploadKind::RawUpload);
        let upload_request = CommitDirectUploadRequest {
            agent_id: redoor_core::test_support::test_agent_id("agent-1"),
            request_id: upload_id,
            chunk: terminal(upload_id),
            reply: oneshot::channel().0,
        };
        // Replacement uploads do not use the editor's non-atomic commit transition.
        assert!(matches!(
            state.validate_commit(&upload_request),
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        // Validation alone must not publish a boundary before terminal routing is owned.
        assert!(state.progress.entries[&upload_id.as_transfer_id()].cancelable);
        state.ui.refresh_check_task.abort();
    }

    /// An edit's result completes the transfer and is handed to the REST request, which
    /// decodes it as the edit's own response.
    #[tokio::test]
    async fn edit_result_completes_the_transfer_and_reaches_the_rest_request() {
        let mut state = router_state();
        let request_id = RequestId::new(43);
        let completion_receiver = record_upload(&mut state, request_id, UploadKind::EditFile);
        state.finish_upload_response(
            request_id,
            RouteResponse {
                agent_id: redoor_core::test_support::test_agent_id("agent-1"),
                socket_id: redoor_protocol::ids::SocketId::new(),
                request_id,
                result: CommandOutcome::Ok(serde_json::Value::Null),
            },
        );
        // The REST request receives the agent's outcome unchanged.
        assert!(matches!(
            completion_receiver.await.unwrap(),
            Ok(CommandOutcome::Ok(serde_json::Value::Null))
        ));
        // A result can only be this upload's own, so success completes its history row.
        assert!(matches!(
            state.progress.entries[&TransferId::new(43)].state,
            TransferProgressState::Completed
        ));
        // Settling the result releases the flow.
        assert!(
            state
                .flows
                .id_for(
                    &redoor_core::test_support::test_agent_id("agent-1"),
                    request_id
                )
                .is_none()
        );
        state.ui.refresh_check_task.abort();
    }

    /// Edit commands select edit progress semantics.
    #[test]
    fn edit_commands_select_edit_progress_semantics() {
        let command = Command::EditFile(request::EditFile {
            path: "/tmp/file.txt".to_string(),
        });
        let kind = command.policy().upload_kind().unwrap();
        // The wire command must retain edit identity throughout shared upload transport.
        assert_eq!(kind, UploadKind::EditFile);
        // Public progress must distinguish inode rewrites from replacement uploads.
        assert!(matches!(kind.direction(), TransferDirection::Edit));
    }
}
