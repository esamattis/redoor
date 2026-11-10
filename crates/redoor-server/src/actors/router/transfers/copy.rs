//! Copies and moves on one agent or between two agents.
//!
//! A cross-agent copy is a source download and a destination upload joined by a
//! [`CopyForwarder`] task that moves frames directly between the two streams. A slow
//! destination therefore stalls only this copy's forwarder and, through credit, its source
//! stream, never the source agent's connection reader or other streams of either agent.

use super::super::RouterError;
use super::super::flows::{
    CopyFlow, CopyPhase, DeleteSource, Flow, FlowId, PrefixVerification, RemoteCopy, RemoteStage,
    SegmentDigest,
};
use super::super::messages::{
    CancelPublicTransferError, CopyTarget, ResumeVerification, RouteResponse, RouterReply,
    StartCopyRequest, TransferProgressUpdateRequest,
};
use super::super::progress::CopyStartContext;
use super::super::state::{CopyContentKind, CopyOperation, RouterState};
use super::super::streams::{OutboundStart, OutboundStream, OutputReceiver, StreamLease};
use redoor_core::partials::SEGMENT_SIZE;
use redoor_core::{log, log_command_failure};
use redoor_protocol::ids::{AgentId, RequestId, TransferId};
use redoor_protocol::wire::command::CommandErrorKind;
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::partials::CancelReason;
use redoor_protocol::wire::request::{
    self, AgentRequest, CommandError, CommandOutcome, DecodeError,
};
use redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES;
use redoor_protocol::{
    api::transfers::{TransferDirection, TransferProgressState},
    wire::command::Command,
};

/// How a finished copy releases its streams.
pub(crate) enum CopyRelease {
    /// Completed or fully acknowledged: stop the data path without notifying agents.
    Quiet,
    /// Failed: cancel the destination worker so it discards its staging, and an unfinished
    /// source so it stops producing.
    Fail,
    /// Identity changes invalidate the prefix rather than preserving it for another source.
    SourceChanged,
}

/// Moves one remote copy's frames from the source stream to the destination stream.
///
/// Runs outside the router so per-frame work never touches its mailbox. It only forwards
/// data and `FIN`: a source that fails ends without `FIN`, and the router, which learns that
/// from the source's result, cancels the destination.
struct CopyForwarder {
    source: OutputReceiver,
    dest: OutboundStream,
}

impl CopyForwarder {
    /// Forwards frames until the source ends, the destination fails or the router stops it.
    async fn run(mut self) {
        let stop = self.dest.lease().cancel.clone();
        loop {
            let item = tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                item = self.source.recv() => item,
            };
            // A failed or stopped source is settled by the router.
            let Some(Ok(chunk)) = item else {
                break;
            };
            let is_last = chunk.is_last;
            // After FIN nothing follows. A stopped destination was settled by the router, and
            // a lost destination connection fails the copy when the router sees it go.
            if self.dest.send_data(chunk.data, is_last).await.is_err() || is_last {
                break;
            }
        }
    }
}

impl RouterState {
    /// Starts a local copy or move, or a remote streamed one, and replies with its public id.
    pub(crate) fn start_copy(&mut self, request: StartCopyRequest) {
        let StartCopyRequest {
            target,
            resume_verification,
            terminal,
            reply,
        } = request;
        let (Some(_), Some(_)) = (
            self.agents.by_id.get(&target.source_agent_id),
            self.agents.by_id.get(&target.dest_agent_id),
        ) else {
            let missing = if self.agents.by_id.contains_key(&target.source_agent_id) {
                &target.dest_agent_id
            } else {
                &target.source_agent_id
            };
            let _ = reply.send(Err(RouterError::AgentNotFound {
                agent_id: missing.to_string(),
            }));
            return;
        };
        // Two writers would share one deterministic partial, and even without partials the
        // later publication would silently replace the earlier one.
        if self.progress.entries.values().any(|entry| {
            matches!(
                entry.state,
                TransferProgressState::Active | TransferProgressState::Canceling
            ) && entry.dest.as_ref().is_some_and(|dest| {
                dest.agent == target.dest_agent_id && dest.path == target.dest_path
            })
        }) {
            let _ = reply.send(Err(RouterError::DestinationBusy {
                path: target.dest_path,
            }));
            return;
        }
        let remote = target.source_agent_id != target.dest_agent_id;
        let streamed = remote || target.source_rev.is_some();
        let then = match (target.operation, target.source_identity.clone()) {
            (CopyOperation::Copy, _) => None,
            (CopyOperation::Move, Some(identity)) => Some(DeleteSource {
                path: target.source_path.clone(),
                identity,
            }),
            (CopyOperation::Move, None) => {
                // Deleting a source whose identity was never captured could remove a
                // replacement created while copying.
                let _ = reply.send(Err(RouterError::UnexpectedResponseType {
                    operation: "starting a move without its source identity",
                }));
                return;
            }
        };

        if streamed
            && self.flows.uploads_into(&target.dest_agent_id)
                >= super::upload::MAX_UPLOADS_PER_CONNECTION
        {
            // The destination side is an upload and counts against the same cap.
            let _ = reply.send(Err(RouterError::StreamLimitReached {
                agent_id: target.dest_agent_id.to_string(),
                kind: "uploads",
            }));
            return;
        }
        let flow_id = self.next_id();
        let progress_id = flow_id.as_transfer_id();
        self.record_copy_start(CopyStartContext {
            request_id: progress_id,
            source_agent_id: target.source_agent_id.clone(),
            source_path: target.source_path.clone(),
            dest_agent_id: target.dest_agent_id.clone(),
            dest_path: target.dest_path.clone(),
            total_bytes: target.total_bytes,
            direction: match target.operation {
                CopyOperation::Copy => TransferDirection::Copy,
                CopyOperation::Move => TransferDirection::Move,
            },
        });
        if let Some(terminal) = terminal {
            self.progress
                .terminal_observers
                .insert(progress_id, terminal);
        }
        if then.is_some() {
            log!(
                Level::Debug,
                "Smart move routing started: public_request_id={}, source_agent_id={}, dest_agent_id={}, source_path={}, dest_path={}, local={}, content_kind={:?}, on_existing={:?}, source_identity={:?}",
                progress_id,
                target.source_agent_id,
                target.dest_agent_id,
                target.source_path,
                target.dest_path,
                !remote,
                target.content_kind,
                target.on_existing,
                target.source_identity
            );
        }

        if let Some(entry) = self.progress.entries.get_mut(&progress_id) {
            // Local moves may publish by rename; the worker announces resumable staging.
            entry.pausable = target.partial.is_some() && remote;
        }
        let (queued_agent, queued) = match resume_verification {
            Some(verification) if remote && target.partial.is_some() && verification.end > 0 => {
                self.start_prefix_verification(flow_id, target, then, verification)
            }
            _ if streamed => self.start_remote_copy(flow_id, &target, then),
            _ => self.start_local_copy(flow_id, &target, then),
        };
        if !queued {
            if let Some(Flow::Copy(flow)) = self.flows.remove(flow_id) {
                self.release_copy(&flow, CopyRelease::Quiet);
            }
            self.mark_transfer_errored(progress_id, "Agent control queue is full".to_string());
            let _ = reply.send(Err(RouterError::ControlQueueFull {
                agent_id: queued_agent.to_string(),
            }));
            return;
        }
        let _ = reply.send(Ok(progress_id));
    }

    /// Starts comparing the destination partial with its source before any byte is appended;
    /// returns the agent and whether both first segment hashes were queued.
    fn start_prefix_verification(
        &mut self,
        flow_id: FlowId,
        target: CopyTarget,
        then: Option<DeleteSource>,
        verification: ResumeVerification,
    ) -> (AgentId, bool) {
        if let Some(entry) = self.progress.entries.get_mut(&flow_id.as_transfer_id()) {
            entry.verifying = true;
        }
        let dest_agent_id = target.dest_agent_id.clone();
        let source = SegmentDigest {
            request_id: self.next_id(),
            digest: None,
        };
        let dest = SegmentDigest {
            request_id: self.next_id(),
            digest: None,
        };
        self.flows.insert(
            flow_id,
            Flow::Copy(Box::new(CopyFlow {
                pause: None,
                resumable: true,
                progress_id: flow_id.as_transfer_id(),
                source_agent_id: target.source_agent_id.clone(),
                dest_agent_id: target.dest_agent_id.clone(),
                content_kind: target.content_kind,
                then,
                phase: CopyPhase::Verifying(Box::new(PrefixVerification {
                    target,
                    key: verification.key,
                    end: verification.end,
                    offset: 0,
                    source,
                    dest,
                })),
            })),
        );
        match self.send_segment_hashes(flow_id) {
            Ok(()) => (dest_agent_id, true),
            Err(agent_id) => (agent_id, false),
        }
    }

    /// Asks both agents for the hash of the segment at the current verification offset;
    /// returns the agent whose control queue refused its command.
    fn send_segment_hashes(&mut self, flow_id: FlowId) -> Result<(), AgentId> {
        let Some(Flow::Copy(flow)) = self.flows.get(flow_id) else {
            return Ok(());
        };
        let CopyPhase::Verifying(verification) = &flow.phase else {
            return Ok(());
        };
        let start = verification.offset;
        let end = start + SEGMENT_SIZE;
        let commands = [
            (
                flow.source_agent_id.clone(),
                verification.source.request_id,
                request::HashSegments {
                    path: verification.target.source_path.clone(),
                    start,
                    end,
                    partial_key: None,
                    // A source replaced during verification must not vouch for the prefix.
                    expected_identity: verification.target.source_identity.clone(),
                },
            ),
            (
                flow.dest_agent_id.clone(),
                verification.dest.request_id,
                request::HashSegments {
                    path: verification.target.dest_path.clone(),
                    start,
                    end,
                    partial_key: Some(verification.key.clone()),
                    expected_identity: None,
                },
            ),
        ];
        for (agent_id, request_id, command) in commands {
            let queued = self.agents.by_id.get_mut(&agent_id).is_some_and(|agent| {
                agent.send_command(request_id, Command::HashSegments(command))
            });
            if !queued {
                return Err(agent_id);
            }
        }
        Ok(())
    }

    /// Records one agent's segment hash and, once both arrived, advances to the next segment
    /// or starts streaming from the verified offset.
    fn finish_segment_hash(&mut self, flow_id: FlowId, from_source: bool, result: CommandOutcome) {
        let digest = match request::HashSegments::decode(result) {
            Ok(digest) => digest,
            Err(DecodeError::Failed(error)) if error.kind == CommandErrorKind::SourceChanged => {
                // The prefix may belong to the previous source, so it must not be resumed.
                self.settle_verifying_partial(flow_id, Some(error.message));
                return;
            }
            Err(DecodeError::Failed(error)) => {
                self.end_copy(flow_id, Some(error.message));
                return;
            }
            Err(DecodeError::Malformed(error)) => {
                self.end_copy(
                    flow_id,
                    Some(format!("Unexpected verification response: {error}")),
                );
                return;
            }
        };
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return;
        };
        let CopyPhase::Verifying(verification) = &mut flow.phase else {
            return;
        };
        let side = if from_source {
            &mut verification.source
        } else {
            &mut verification.dest
        };
        side.digest = Some(digest);
        let (Some(source), Some(dest)) = (&verification.source.digest, &verification.dest.digest)
        else {
            return;
        };
        let matched = source == dest;
        if matched {
            verification.offset += SEGMENT_SIZE;
        }
        let offset = verification.offset;
        let done = !matched || offset >= verification.end;
        let progress_id = flow.progress_id;
        if let Some(entry) = self.progress.entries.get_mut(&progress_id) {
            // Hashed bytes are the only visible progress on slow disks.
            entry.transferred_bytes = offset;
        }
        self.notify_transfer_refresh();
        if done {
            self.finish_prefix_verification(flow_id);
        } else {
            self.next_segment_hashes(flow_id);
        }
    }

    /// Re-indexes the flow under fresh request ids and requests the next pair of hashes.
    fn next_segment_hashes(&mut self, flow_id: FlowId) {
        let previous = self.flows.request_ids(flow_id);
        let source_id = self.next_id();
        let dest_id = self.next_id();
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return;
        };
        let CopyPhase::Verifying(verification) = &mut flow.phase else {
            return;
        };
        verification.source = SegmentDigest {
            request_id: source_id,
            digest: None,
        };
        verification.dest = SegmentDigest {
            request_id: dest_id,
            digest: None,
        };
        self.flows.reindex(flow_id, &previous);
        if let Err(agent_id) = self.send_segment_hashes(flow_id) {
            self.end_copy(
                flow_id,
                Some(format!("Agent control queue is unavailable: {agent_id}")),
            );
        }
    }

    /// Starts the streamed copy from the verified offset under the same flow and public id.
    fn finish_prefix_verification(&mut self, flow_id: FlowId) {
        let Some(Flow::Copy(flow)) = self.flows.remove(flow_id) else {
            return;
        };
        let CopyFlow {
            progress_id,
            then,
            phase: CopyPhase::Verifying(verification),
            ..
        } = *flow
        else {
            return;
        };
        let PrefixVerification {
            mut target, offset, ..
        } = *verification;
        if let Some(partial) = &mut target.partial {
            partial.offset = offset;
        }
        if let Some(entry) = self.progress.entries.get_mut(&progress_id) {
            entry.verifying = false;
            entry.resumed_bytes = offset;
            entry.transferred_bytes = offset;
        }
        let (agent_id, queued) = self.start_remote_copy(flow_id, &target, then);
        if !queued {
            self.end_copy(
                flow_id,
                Some(format!("Agent control queue is unavailable: {agent_id}")),
            );
        }
    }

    /// Stops in-flight hashing and asks the destination to persist the partial for a pause or
    /// delete it for a cancel or a changed source; the transfer settles on its answer.
    fn settle_verifying_partial(&mut self, flow_id: FlowId, failure: Option<String>) {
        let previous = self.flows.request_ids(flow_id);
        let request_id = self.next_id();
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return;
        };
        let CopyPhase::Verifying(verification) = &flow.phase else {
            return;
        };
        let command = if flow.pause.is_some() {
            Command::PersistPartial(request::PersistPartial {
                key: verification.key.clone(),
                // The paused attempt's operation and conflict policy replace the saved ones.
                signed: verification
                    .target
                    .partial
                    .as_ref()
                    .map(|partial| Box::new(partial.signed.clone())),
            })
        } else {
            Command::DeletePartial(request::DeletePartial {
                key: verification.key.clone(),
            })
        };
        let pending = pending_segment_hashes(flow, verification);
        flow.phase = CopyPhase::SettlingPartial {
            request_id,
            failure,
        };
        let dest_agent_id = flow.dest_agent_id.clone();
        self.flows.reindex(flow_id, &previous);
        for (agent_id, hash_id) in pending {
            let _ = self.cancel_on_agent(&agent_id, hash_id, CancelReason::Canceled);
        }
        let queued = self
            .agents
            .by_id
            .get_mut(&dest_agent_id)
            .is_some_and(|agent| agent.send_command(request_id, command));
        if !queued {
            self.finish_partial_settlement(
                flow_id,
                CommandOutcome::Error(CommandError::new(
                    CommandErrorKind::ServiceUnavailable,
                    format!("Agent control queue is unavailable: {dest_agent_id}"),
                )),
            );
        }
    }

    /// Settles a transfer whose interrupted verification left the destination to persist or
    /// delete its partial.
    fn finish_partial_settlement(&mut self, flow_id: FlowId, result: CommandOutcome) {
        let Some(Flow::Copy(mut flow)) = self.flows.remove(flow_id) else {
            return;
        };
        let CopyPhase::SettlingPartial { failure, .. } = &mut flow.phase else {
            return;
        };
        let progress_id = flow.progress_id;
        let settled = result
            .failure()
            .map_or(Ok(()), |error| Err(error.message.clone()));
        if let Some(reply) = flow.pause.take() {
            match &settled {
                Ok(()) => self.forget_paused_transfer(progress_id),
                Err(message) => self.mark_transfer_errored(progress_id, message.clone()),
            }
            let _ = reply.send(settled);
            return;
        }
        match (failure.take(), settled) {
            (Some(message), Ok(())) => {
                self.mark_transfer_errored(progress_id, format!("{message}; partial discarded"))
            }
            (Some(message), Err(cleanup)) => self.mark_transfer_errored(
                progress_id,
                format!("{message}; cannot discard partial: {cleanup}"),
            ),
            (None, Ok(())) => self.mark_transfer_canceled(progress_id),
            (None, Err(message)) => self.mark_transfer_errored(progress_id, message),
        }
    }

    /// Runs the whole copy or move as one agent-local command; returns the agent and whether
    /// the command was queued.
    fn start_local_copy(
        &mut self,
        flow_id: FlowId,
        target: &CopyTarget,
        then: Option<DeleteSource>,
    ) -> (AgentId, bool) {
        let request_id = self.next_id();
        let command = match &then {
            Some(delete) => Command::LocalMove(request::LocalMove {
                partial: target.partial.clone(),
                source_path: target.source_path.clone(),
                dest_path: target.dest_path.clone(),
                source_is_directory: target.content_kind == CopyContentKind::TarDirectory,
                expected_identity: delete.identity.clone(),
                on_existing: target.on_existing,
            }),
            None => match target.content_kind {
                CopyContentKind::RawFile => Command::LocalCopyFile(request::LocalCopyFile {
                    partial: target.partial.clone(),
                    source_path: target.source_path.clone(),
                    dest_path: target.dest_path.clone(),
                    on_existing: target.on_existing,
                }),
                CopyContentKind::TarDirectory => {
                    Command::LocalCopyDirectory(request::LocalCopyDirectory {
                        source_path: target.source_path.clone(),
                        dest_path: target.dest_path.clone(),
                        on_existing: target.on_existing,
                    })
                }
            },
        };
        self.flows.insert(
            flow_id,
            Flow::Copy(Box::new(CopyFlow {
                pause: None,
                resumable: target.partial.is_some(),
                progress_id: flow_id.as_transfer_id(),
                source_agent_id: target.source_agent_id.clone(),
                dest_agent_id: target.dest_agent_id.clone(),
                content_kind: target.content_kind,
                then,
                phase: CopyPhase::Local { request_id },
            })),
        );
        let queued = self
            .agents
            .by_id
            .get_mut(&target.source_agent_id)
            .is_some_and(|agent| agent.send_command(request_id, command));
        (target.source_agent_id.clone(), queued)
    }

    /// Opens both streams and the forwarder, then starts the destination upload; the source
    /// download waits for the destination's readiness. Copies from Git history take this path
    /// on one agent too, with the agent as both source and destination.
    fn start_remote_copy(
        &mut self,
        flow_id: FlowId,
        target: &CopyTarget,
        then: Option<DeleteSource>,
    ) -> (AgentId, bool) {
        let dest_id = self.next_id();
        let source_id = self.next_id();
        let Some(source_agent) = self.agents.by_id.get(&target.source_agent_id) else {
            return (target.source_agent_id.clone(), false);
        };
        let source = StreamLease::new(source_id, source_agent.link(), 0);
        let source_receiver = source_agent
            .streams
            .open_inbound(source.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        let Some(dest_agent) = self.agents.by_id.get_mut(&target.dest_agent_id) else {
            return (target.dest_agent_id.clone(), false);
        };
        // The destination's first credit grant tells the router its worker is ready.
        let dest = OutboundStream::new(
            StreamLease::new(
                dest_id,
                dest_agent.link(),
                target.partial.as_ref().map_or(0, |partial| partial.offset),
            ),
            dest_agent.streams.open_outbound(
                dest_id,
                STREAM_CREDIT_WINDOW_FRAMES,
                OutboundStart::AwaitGrant,
            ),
            false,
        );
        tokio::spawn(
            CopyForwarder {
                source: source_receiver,
                dest: dest.clone(),
            }
            .run(),
        );
        let mut upload = target
            .content_kind
            .upload_command(target.dest_path.clone(), target.on_existing);
        if let Command::RawUpload(raw) = &mut upload {
            raw.partial = target.partial.clone();
            raw.executable = target.executable;
        }
        let queued = dest_agent.send_command(dest_id, upload);
        self.flows.insert(
            flow_id,
            Flow::Copy(Box::new(CopyFlow {
                pause: None,
                resumable: target.partial.is_some(),
                progress_id: flow_id.as_transfer_id(),
                source_agent_id: target.source_agent_id.clone(),
                dest_agent_id: target.dest_agent_id.clone(),
                content_kind: target.content_kind,
                then,
                phase: CopyPhase::Remote(Box::new(RemoteCopy {
                    source,
                    dest,
                    stage: RemoteStage::AwaitingDestination {
                        source_command: match &target.source_rev {
                            // History streams a file or a plain tar, matching the upload kind.
                            Some(rev) => Command::GitDownload(request::GitDownload {
                                path: target.source_path.clone(),
                                rev: rev.clone(),
                                include_root: false,
                            }),
                            None => {
                                let mut command = target
                                    .content_kind
                                    .download_command(target.source_path.clone());
                                if let Command::RawDownload(raw) = &mut command {
                                    raw.range_start =
                                        target.partial.as_ref().map(|partial| partial.offset);
                                    raw.expected_identity = target.source_identity.clone();
                                }
                                command
                            }
                        },
                    },
                    source_finished: false,
                })),
            })),
        );
        (target.dest_agent_id.clone(), queued)
    }

    /// Stops a copy's data path and forgets its stream state on both agents.
    pub(crate) fn release_copy(&mut self, flow: &CopyFlow, release: CopyRelease) {
        match &flow.phase {
            CopyPhase::Remote(remote) => {
                self.release_remote_copy(
                    &flow.source_agent_id,
                    &flow.dest_agent_id,
                    remote,
                    release,
                );
            }
            // Hashing holds no staging, so stopping it never needs an acknowledgement.
            CopyPhase::Verifying(verification) => {
                for (agent_id, request_id) in pending_segment_hashes(flow, verification) {
                    let _ = self.cancel_on_agent(&agent_id, request_id, CancelReason::Canceled);
                }
            }
            CopyPhase::SettlingPartial { .. }
            | CopyPhase::Local { .. }
            | CopyPhase::DeletingSource { .. } => {}
        }
    }

    /// Stops both streams of a remote copy; a failure also cancels the destination worker,
    /// which discards its staging, and a source that is still producing.
    ///
    /// The agents' results for these cancels find no flow and are dropped, and a cancel for
    /// a worker that already answered is ignored by its agent.
    pub(crate) fn release_remote_copy(
        &mut self,
        source_agent_id: &AgentId,
        dest_agent_id: &AgentId,
        remote: &RemoteCopy,
        release: CopyRelease,
    ) {
        remote.dest.lease().stop();
        remote.source.stop();
        if matches!(release, CopyRelease::Fail | CopyRelease::SourceChanged) {
            let _ = self.cancel_on_agent(
                dest_agent_id,
                remote.dest_id(),
                if matches!(release, CopyRelease::SourceChanged) {
                    CancelReason::Canceled
                } else {
                    CancelReason::Disconnected
                },
            );
            let source_started = !matches!(remote.stage, RemoteStage::AwaitingDestination { .. });
            if source_started && !remote.source_finished {
                let _ = self.cancel_on_agent(
                    source_agent_id,
                    remote.source_id(),
                    CancelReason::Canceled,
                );
            }
        }
        if let Some(source) = self.agents.by_id.get(source_agent_id) {
            source.streams.close_inbound(remote.source_id());
        }
        if let Some(dest) = self.agents.by_id.get(dest_agent_id) {
            dest.streams.close_outbound(remote.dest_id());
        }
    }

    /// Removes a copy, releases its streams and records its terminal outcome.
    fn end_copy(&mut self, flow_id: FlowId, failure: Option<String>) {
        let Some(Flow::Copy(flow)) = self.flows.remove(flow_id) else {
            return;
        };
        match failure {
            Some(message) => {
                self.release_copy(&flow, CopyRelease::Fail);
                let message = if flow.keeps_partial() {
                    format!("{message}; partial kept")
                } else {
                    message
                };
                self.mark_transfer_errored(flow.progress_id, message);
            }
            None => self.release_copy(&flow, CopyRelease::Quiet),
        }
    }

    /// Starts the source download once the destination worker can receive its bytes.
    pub(crate) fn start_copy_source(
        &mut self,
        flow_id: FlowId,
        dest_agent_id: &AgentId,
        dest_request_id: RequestId,
    ) {
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return;
        };
        let CopyPhase::Remote(remote) = &mut flow.phase else {
            return;
        };
        if &flow.dest_agent_id != dest_agent_id || remote.dest_id() != dest_request_id {
            return;
        }
        // A cancel accepted before readiness already settled the never-started source.
        let RemoteStage::AwaitingDestination { .. } = remote.stage else {
            return;
        };
        let RemoteStage::AwaitingDestination { source_command } =
            std::mem::replace(&mut remote.stage, RemoteStage::Streaming)
        else {
            return;
        };
        let source_agent_id = flow.source_agent_id.clone();
        let source_id = remote.source_id();
        let queued = self
            .agents
            .by_id
            .get_mut(&source_agent_id)
            .is_some_and(|source| source.send_command(source_id, source_command));
        if !queued {
            self.end_copy(
                flow_id,
                Some("Source agent control queue is unavailable".to_string()),
            );
        }
    }

    /// Settles a copy's source download from its result.
    ///
    /// The result follows the source's data, so a successful source has handed the forwarder
    /// everything and the destination's result completes the copy. A failed source sent no
    /// `FIN`; closing its stream ends the forwarder, and the copy fails.
    fn finish_copy_source(&mut self, flow_id: FlowId, result: CommandOutcome) {
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return;
        };
        let CopyPhase::Remote(remote) = &mut flow.phase else {
            return;
        };
        remote.source_finished = true;
        let source_id = remote.source_id();
        let canceling = matches!(remote.stage, RemoteStage::Canceling { .. });
        if let Some(source) = self.agents.by_id.get(&flow.source_agent_id) {
            source.streams.close_inbound(source_id);
        }
        if canceling {
            // A finished or failed source holds nothing to clean up, so its result is its
            // cancel acknowledgement.
            self.acknowledge_copy_cancel(flow_id, source_id);
        } else if let CommandOutcome::Error(CommandError { kind, message }) = result {
            if kind == CommandErrorKind::SourceChanged {
                if let Some(Flow::Copy(flow)) = self.flows.remove(flow_id) {
                    self.release_copy(&flow, CopyRelease::SourceChanged);
                    self.mark_transfer_errored(flow.progress_id, message);
                }
            } else {
                self.end_copy(flow_id, Some(message));
            }
        }
    }

    /// Fails a copy whose source agent ignored its credit; ending the copy also cancels the
    /// source, which keeps producing although its stream is gone.
    pub(crate) fn fail_overflowing_copy_source(&mut self, flow_id: FlowId) {
        let Some(Flow::Copy(flow)) = self.flows.get(flow_id) else {
            return;
        };
        // While canceling the source was already told to stop, and its result acknowledges.
        if let CopyPhase::Remote(remote) = &flow.phase
            && !matches!(remote.stage, RemoteStage::Canceling { .. })
        {
            self.end_copy(
                flow_id,
                Some("Copy source exceeded the stream flow-control credit".to_string()),
            );
        }
    }

    /// Settles a copy from the final response of its destination, local or delete command.
    pub(crate) fn finish_copy_response(&mut self, flow_id: FlowId, response: RouteResponse) {
        let Some(Flow::Copy(flow)) = self.flows.get(flow_id) else {
            return;
        };
        let request_id = response.request_id;
        let agent_id = &response.agent_id;
        match &flow.phase {
            CopyPhase::Remote(remote)
                if remote.dest_id() == request_id && &flow.dest_agent_id == agent_id =>
            {
                self.finish_remote_destination(flow_id, response.result)
            }
            CopyPhase::Remote(remote)
                if remote.source_id() == request_id && &flow.source_agent_id == agent_id =>
            {
                self.finish_copy_source(flow_id, response.result)
            }
            CopyPhase::Verifying(verification)
                if verification.source.request_id == request_id
                    && &flow.source_agent_id == agent_id =>
            {
                self.finish_segment_hash(flow_id, true, response.result)
            }
            CopyPhase::Verifying(verification)
                if verification.dest.request_id == request_id
                    && &flow.dest_agent_id == agent_id =>
            {
                self.finish_segment_hash(flow_id, false, response.result)
            }
            CopyPhase::SettlingPartial {
                request_id: settling,
                ..
            } if *settling == request_id && &flow.dest_agent_id == agent_id => {
                self.finish_partial_settlement(flow_id, response.result)
            }
            CopyPhase::Local { request_id: local }
                if *local == request_id && &flow.source_agent_id == agent_id =>
            {
                self.finish_local_copy(flow_id, response.result)
            }
            CopyPhase::DeletingSource { request_id: delete }
                if *delete == request_id && &flow.source_agent_id == agent_id =>
            {
                self.finish_source_deletion(flow_id, response.result)
            }
            _ => log!(
                Level::Warning,
                "Unexpected copy response: agent_id={}, request_id={}",
                agent_id,
                request_id
            ),
        }
    }

    /// Settles a remote copy from its destination's final response.
    fn finish_remote_destination(&mut self, flow_id: FlowId, result: CommandOutcome) {
        let Some(Flow::Copy(flow)) = self.flows.get(flow_id) else {
            return;
        };
        let CopyPhase::Remote(remote) = &flow.phase else {
            return;
        };
        let canceling = matches!(remote.stage, RemoteStage::Canceling { .. });
        let dest_id = remote.dest_id();
        let progress_id = flow.progress_id;
        let is_move = flow.is_move();
        let content_kind = flow.content_kind;
        if flow.pause.is_some()
            && !result
                .failure()
                .is_some_and(|failure| failure.kind == CommandErrorKind::Paused)
        {
            let message = result.failure().map_or(
                "Pause did not preserve the partial".to_string(),
                |failure| failure.message.clone(),
            );
            if let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id)
                && let Some(reply) = flow.pause.take()
            {
                let _ = reply.send(Err(message.clone()));
            }
            self.end_copy(flow_id, Some(message));
            return;
        }
        match result {
            CommandOutcome::Ok(_) if is_move && !canceling => self.begin_source_deletion(flow_id),
            CommandOutcome::Ok(_) if is_move => {
                log!(
                    Level::Debug,
                    "Smart move destination completed while canceling; preserving source: public_request_id={}, request_id={}",
                    progress_id,
                    dest_id
                );
                // Cancellation before source deletion preserves the source even if the
                // destination publication won.
                self.acknowledge_copy_cancel(flow_id, dest_id);
            }
            CommandOutcome::Error(_) if canceling => {
                self.acknowledge_copy_cancel(flow_id, dest_id);
            }
            CommandOutcome::Error(CommandError { message, .. }) => {
                self.end_copy(flow_id, Some(message))
            }
            CommandOutcome::Ok(_) => {
                // Tar copies have no known size up front; the forwarded bytes are the total.
                let total = match content_kind {
                    CopyContentKind::TarDirectory => self.transferred_bytes(progress_id),
                    CopyContentKind::RawFile => None,
                };
                self.end_copy(flow_id, None);
                self.mark_copy_transfer_completed(progress_id, total);
            }
        }
    }

    /// Settles an agent-local copy or move from its single command result.
    fn finish_local_copy(&mut self, flow_id: FlowId, result: CommandOutcome) {
        let Some(Flow::Copy(flow)) = self.flows.remove(flow_id) else {
            return;
        };
        let progress_id = flow.progress_id;
        if let Some(reply) = flow.pause {
            if result
                .failure()
                .is_some_and(|failure| failure.kind == CommandErrorKind::Paused)
            {
                self.forget_paused_transfer(progress_id);
                let _ = reply.send(Ok(()));
            } else {
                let message = result.failure().map_or(
                    "Pause did not preserve the partial".to_string(),
                    |failure| failure.message.clone(),
                );
                self.mark_transfer_errored(progress_id, message.clone());
                let _ = reply.send(Err(message));
            }
            return;
        }
        let canceling = matches!(
            self.progress
                .entries
                .get(&progress_id)
                .map(|entry| &entry.state),
            Some(TransferProgressState::Canceling)
        );
        // Directory copies have no known size up front; the counted bytes are the total.
        let tar_total = match flow.content_kind {
            CopyContentKind::TarDirectory => self.transferred_bytes(progress_id),
            CopyContentKind::RawFile => None,
        };
        let atomic = if flow.is_move() {
            request::LocalMove::decode(result).map(|response| Some(response.atomic))
        } else if flow.content_kind == CopyContentKind::TarDirectory {
            request::LocalCopyDirectory::decode(result).map(|()| None)
        } else {
            request::LocalCopyFile::decode(result).map(|()| None)
        };
        match atomic {
            Err(DecodeError::Failed(_)) if canceling => self.mark_transfer_canceled(progress_id),
            Err(DecodeError::Failed(error)) => {
                log_command_failure!(
                    error,
                    "{} command failed: public_request_id={}",
                    if flow.is_move() {
                        "Smart move"
                    } else {
                        "Local copy"
                    },
                    progress_id
                );
                self.mark_transfer_errored(progress_id, error.message);
            }
            Err(DecodeError::Malformed(error)) => {
                log!(
                    Level::Warning,
                    "Malformed local copy result: public_request_id={}, error={}",
                    progress_id,
                    error
                );
                self.mark_transfer_errored(
                    progress_id,
                    "Unexpected copy completion response".to_string(),
                );
            }
            Ok(atomic) => {
                if let Some(atomic) = atomic {
                    log!(
                        Level::Debug,
                        "Smart move local completion: public_request_id={}, atomic={}",
                        progress_id,
                        atomic
                    );
                    if let Some(entry) = self.progress.entries.get_mut(&progress_id) {
                        // Copy/delete and cross-agent completions never take this branch.
                        entry.atomic = atomic;
                    }
                }
                self.mark_copy_transfer_completed(progress_id, tar_total);
            }
        }
    }

    /// Records one side's cleanup acknowledgement of a canceled remote copy; the copy settles
    /// as canceled only once both temp-owning workers released their staging.
    pub(crate) fn acknowledge_copy_cancel(&mut self, flow_id: FlowId, request_id: RequestId) {
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return;
        };
        let CopyPhase::Remote(remote) = &mut flow.phase else {
            return;
        };
        let (source_id, dest_id) = (remote.source_id(), remote.dest_id());
        let RemoteStage::Canceling {
            source_acked,
            dest_acked,
        } = &mut remote.stage
        else {
            return;
        };
        if request_id == source_id {
            *source_acked = true;
        } else if request_id == dest_id {
            *dest_acked = true;
        }
        if *source_acked && *dest_acked {
            let progress_id = flow.progress_id;
            let pause = flow.pause.take();
            self.end_copy(flow_id, None);
            if let Some(reply) = pause {
                self.forget_paused_transfer(progress_id);
                let _ = reply.send(Ok(()));
            } else {
                self.mark_transfer_canceled(progress_id);
            }
        }
    }

    /// Sends cancellation to every worker of a copy after its row became `Canceling`.
    pub(crate) fn cancel_copy(&mut self, flow_id: FlowId) -> Result<(), CancelPublicTransferError> {
        let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) else {
            return Err(CancelPublicTransferError::NotFound);
        };
        if matches!(flow.phase, CopyPhase::Verifying(_)) {
            self.settle_verifying_partial(flow_id, None);
            return Ok(());
        }
        let targets = match &mut flow.phase {
            CopyPhase::Remote(remote) => {
                let mut targets = vec![(flow.dest_agent_id.clone(), remote.dest_id())];
                // No source worker exists before readiness, and a finished source already
                // released its worker, so cancellation itself is their cleanup.
                let source_acked = remote.source_finished
                    || matches!(remote.stage, RemoteStage::AwaitingDestination { .. });
                if !source_acked {
                    targets.push((flow.source_agent_id.clone(), remote.source_id()));
                }
                remote.stage = RemoteStage::Canceling {
                    source_acked,
                    dest_acked: false,
                };
                targets
            }
            // Pause and cancel are both already settling the partial.
            CopyPhase::Verifying(_) | CopyPhase::SettlingPartial { .. } => return Ok(()),
            CopyPhase::Local { request_id } => vec![(flow.source_agent_id.clone(), *request_id)],
            CopyPhase::DeletingSource { .. } => {
                return Err(CancelPublicTransferError::NotCancelable);
            }
        };
        // Destination cancellation carries the disposition; source workers ignore it.
        let reason = if flow.pause.is_some() {
            CancelReason::Paused
        } else {
            CancelReason::Canceled
        };
        for (agent_id, request_id) in targets {
            // A lost connection settles its side of the copy through agent-loss cleanup.
            let _ = self.cancel_on_agent(&agent_id, request_id, reason);
        }
        Ok(())
    }

    /// Pause uses cancellation ownership but keeps its reply until durable destination cleanup.
    pub(crate) fn pause_transfer(
        &mut self,
        transfer_id: TransferId,
        reply: RouterReply<Result<(), String>>,
    ) {
        let eligible = self
            .progress
            .entries
            .get(&transfer_id)
            .is_some_and(|entry| {
                entry.cancelable
                    && entry.pausable
                    && matches!(entry.state, TransferProgressState::Active)
            });
        let flow_id = self.flows.find_by_progress(transfer_id).filter(|flow_id| {
            matches!(
                self.flows.get(*flow_id),
                Some(Flow::Copy(flow)) if flow.resumable && flow.pause.is_none()
            )
        });
        let (true, Some(flow_id)) = (eligible, flow_id) else {
            let _ = reply.send(Err("Transfer cannot be paused".into()));
            return;
        };
        if let Some(Flow::Copy(flow)) = self.flows.get_mut(flow_id) {
            flow.pause = Some(reply);
        }
        self.mark_transfer_canceling(transfer_id);
        let _ = self.cancel_copy(flow_id);
    }

    /// Removes a paused transfer entirely; the destination partial is now its only record.
    fn forget_paused_transfer(&mut self, transfer_id: TransferId) {
        self.progress.entries.remove(&transfer_id);
        self.progress.terminal_observers.remove(&transfer_id);
        self.notify_transfer_refresh_immediately();
    }

    /// Applies prefix verification progress of an agent-local resumable copy.
    ///
    /// The first report also marks the copy pausable: only the worker knows whether a local
    /// move publishes by rename or stages through a partial.
    pub(crate) fn update_local_verification(
        &mut self,
        agent_id: &AgentId,
        request_id: RequestId,
        bytes: u64,
        verifying: bool,
    ) {
        let Some(flow_id) = self.flows.id_for(agent_id, request_id) else {
            return;
        };
        let Some(Flow::Copy(flow)) = self.flows.get(flow_id) else {
            return;
        };
        if !matches!(flow.phase, CopyPhase::Local { .. }) {
            return;
        }
        let Some(entry) = self.progress.entries.get_mut(&flow.progress_id) else {
            return;
        };
        entry.pausable = entry.cancelable && matches!(entry.state, TransferProgressState::Active);
        entry.verifying = verifying;
        entry.transferred_bytes = bytes;
        if !verifying {
            entry.resumed_bytes = bytes;
        }
        self.notify_transfer_refresh();
    }

    /// Applies agent-reported progress of an agent-local copy.
    pub(crate) fn update_copy_progress(
        &mut self,
        flow_id: FlowId,
        request: TransferProgressUpdateRequest,
    ) {
        let Some(Flow::Copy(flow)) = self.flows.get(flow_id) else {
            return;
        };
        let CopyPhase::Local { request_id } = flow.phase else {
            return;
        };
        if flow.source_agent_id != request.agent_id || request_id != request.request_id {
            log!(
                Level::Warning,
                "Copy progress update agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                flow.progress_id,
                flow.source_agent_id,
                request.agent_id
            );
            return;
        }
        let progress_id = flow.progress_id;
        self.set_copy_progress(progress_id, request.transferred_bytes, request.total_bytes);
    }
}

/// Segment hashes of a verification that were requested but not answered yet.
fn pending_segment_hashes(
    flow: &CopyFlow,
    verification: &PrefixVerification,
) -> Vec<(AgentId, RequestId)> {
    [
        (&flow.source_agent_id, &verification.source),
        (&flow.dest_agent_id, &verification.dest),
    ]
    .into_iter()
    .filter(|(_, segment)| segment.digest.is_none())
    .map(|(agent_id, segment)| (agent_id.clone(), segment.request_id))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::super::super::messages::RegisterAgentRequest;
    use super::super::super::state::AgentConnection;
    use super::super::super::streams::{AgentLink, ConnectionStreams};
    use super::*;
    use crate::actors::lanes::ControlLanes;
    use redoor_protocol::wire::ServerToAgent;
    use redoor_protocol::wire::stream::StreamChunk;
    use tokio::sync::mpsc;

    /// Builds one agent connection with an observable bulk lane.
    fn agent(name: &str) -> (ConnectionStreams, AgentLink, mpsc::Receiver<StreamChunk>) {
        let agent = redoor_core::test_support::test_agent_id(name);
        let (lanes, receivers) = ControlLanes::bounded(16, 16);
        (
            ConnectionStreams::new(agent.clone()),
            AgentLink::new(lanes),
            receivers.bulk,
        )
    }

    /// Builds one source data frame.
    fn frame(request_id: RequestId, is_last: bool) -> StreamChunk {
        StreamChunk::data(request_id, vec![3; 8], is_last)
    }

    /// A stalled destination stalls only its own copy: the source agent's reader keeps
    /// accepting frames for other streams while the copy waits for destination credit.
    #[tokio::test]
    async fn slow_destination_does_not_block_source_reader() {
        let (source_streams, source_link, _source_lane) = agent("source");
        let (dest_streams, dest_link, mut dest_lane) = agent("dest");
        let source = StreamLease::new(RequestId::new(1), source_link.clone(), 0);
        let receiver = source_streams.open_inbound(source.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        let dest = OutboundStream::new(
            StreamLease::new(RequestId::new(2), dest_link, 0),
            dest_streams.open_outbound(
                RequestId::new(2),
                STREAM_CREDIT_WINDOW_FRAMES,
                OutboundStart::FullWindow,
            ),
            false,
        );
        let forwarder = tokio::spawn(
            CopyForwarder {
                source: receiver,
                dest: dest.clone(),
            }
            .run(),
        );
        let mut other = source_streams.open_inbound(
            StreamLease::new(RequestId::new(3), source_link, 0),
            STREAM_CREDIT_WINDOW_FRAMES,
        );
        // The destination never grants credit, so only its window can be forwarded. The
        // one-slot lane is drained as frames arrive, so only credit limits the forwarder.
        let mut forwarded = 0;
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES * 2 {
            assert!(
                source_streams
                    .deliver(frame(RequestId::new(1), false))
                    .is_none()
            );
            for _ in 0..4 {
                tokio::task::yield_now().await;
                while dest_lane.try_recv().is_ok() {
                    forwarded += 1;
                }
            }
        }
        // Unrelated streams of the source agent are still served by the same reader.
        source_streams.deliver(frame(RequestId::new(3), false));
        assert_eq!(
            other.recv().await.unwrap().unwrap().request_id,
            RequestId::new(3)
        );
        // The destination's credit window bounds what the forwarder pushed to it.
        assert_eq!(forwarded, STREAM_CREDIT_WINDOW_FRAMES as usize);
        // Stopping the copy releases a forwarder stuck on credit.
        dest.lease().stop();
        forwarder.await.unwrap();
        // The forwarder sends no error frame; the router cancels the destination worker.
        assert!(dest_lane.try_recv().is_err());
    }

    /// The forwarder relays the final frame and stops.
    #[tokio::test]
    async fn forwarder_relays_last_frame() {
        let (source_streams, source_link, _source_lane) = agent("source");
        let (dest_streams, dest_link, mut dest_lane) = agent("dest");
        let receiver = source_streams.open_inbound(
            StreamLease::new(RequestId::new(1), source_link, 0),
            STREAM_CREDIT_WINDOW_FRAMES,
        );
        let dest = OutboundStream::new(
            StreamLease::new(RequestId::new(2), dest_link, 0),
            dest_streams.open_outbound(
                RequestId::new(2),
                STREAM_CREDIT_WINDOW_FRAMES,
                OutboundStart::FullWindow,
            ),
            false,
        );
        let forwarder = tokio::spawn(
            CopyForwarder {
                source: receiver,
                dest: dest.clone(),
            }
            .run(),
        );
        source_streams.deliver(frame(RequestId::new(1), false));
        // FIN is not a router event: the source's result settles it.
        assert!(
            source_streams
                .deliver(frame(RequestId::new(1), true))
                .is_none()
        );
        let frames = [
            dest_lane.recv().await.unwrap(),
            dest_lane.recv().await.unwrap(),
        ];
        forwarder.await.unwrap();
        // Frames are relabeled for the destination stream and the last one stays terminal.
        assert_eq!(frames.len(), 2);
        assert!(
            frames
                .iter()
                .all(|frame| frame.request_id == RequestId::new(2))
        );
        assert!(frames[1].is_last);
        // Forwarded bytes are the copy's progress.
        assert_eq!(dest.lease().bytes(), 16);
    }

    /// A copy canceled after its source already finished must settle once the destination
    /// acknowledges, instead of waiting for a source acknowledgement that can never come.
    #[tokio::test]
    async fn cancel_after_source_finished_settles_on_destination_ack() {
        let mut state = RouterState::new(tokio::spawn(async {}));
        let flow_id = RequestId::new(70);
        let (dest_id, source_id) = (RequestId::new(71), RequestId::new(72));
        state.record_copy_start(CopyStartContext {
            request_id: flow_id.as_transfer_id(),
            source_agent_id: redoor_core::test_support::test_agent_id("source"),
            source_path: "/source".into(),
            dest_agent_id: redoor_core::test_support::test_agent_id("dest"),
            dest_path: "/dest".into(),
            total_bytes: 8,
            direction: TransferDirection::Copy,
        });
        let detached = |id| StreamLease::new(id, AgentLink::new(ControlLanes::bounded(1, 1).0), 0);
        state.flows.insert(
            flow_id,
            Flow::Copy(Box::new(CopyFlow {
                pause: None,
                resumable: false,
                progress_id: flow_id.as_transfer_id(),
                source_agent_id: redoor_core::test_support::test_agent_id("source"),
                dest_agent_id: redoor_core::test_support::test_agent_id("dest"),
                content_kind: CopyContentKind::RawFile,
                then: None,
                phase: CopyPhase::Remote(Box::new(RemoteCopy {
                    source: detached(source_id),
                    dest: OutboundStream::new(
                        detached(dest_id),
                        redoor_core::stream_credit::CreditGate::default(),
                        false,
                    ),
                    stage: RemoteStage::Streaming,
                    source_finished: true,
                })),
            })),
        );
        assert!(
            state
                .cancel_public_transfer(flow_id.as_transfer_id())
                .is_ok()
        );
        state.finish_copy_response(
            flow_id,
            RouteResponse {
                agent_id: redoor_core::test_support::test_agent_id("dest"),
                socket_id: redoor_protocol::ids::SocketId::new(),
                request_id: dest_id,
                result: CommandOutcome::error(
                    redoor_protocol::wire::command::CommandErrorKind::InvalidInput,
                    "Upload canceled by server",
                ),
            },
        );
        // The destination's cleanup is the last acknowledgement a finished source needs.
        assert!(matches!(
            state.progress.entries[&flow_id.as_transfer_id()].state,
            TransferProgressState::Canceled
        ));
        assert!(
            state
                .flows
                .id_for(&redoor_core::test_support::test_agent_id("dest"), dest_id)
                .is_none()
        );
        state.ui.refresh_check_task.abort();
    }

    /// A source that fails ends without FIN; its error result fails the copy and cancels
    /// the destination worker so it discards its staging instead of publishing a partial file.
    #[tokio::test]
    async fn failed_source_cancels_the_destination() {
        let mut state = RouterState::new(tokio::spawn(async {}));
        let mut lanes = Vec::new();
        for name in ["source", "dest"] {
            let agent = redoor_core::test_support::test_agent_id(name);
            let (agent_lanes, receivers) = ControlLanes::bounded(4, 4);
            state.agents.by_id.insert(
                agent.clone(),
                AgentConnection::from_register_request(RegisterAgentRequest::for_test(
                    &agent,
                    agent_lanes,
                    ConnectionStreams::new(agent.clone()),
                )),
            );
            lanes.push(receivers);
        }
        let flow_id = RequestId::new(80);
        let (dest_id, source_id) = (RequestId::new(81), RequestId::new(82));
        state.record_copy_start(CopyStartContext {
            request_id: flow_id.as_transfer_id(),
            source_agent_id: redoor_core::test_support::test_agent_id("source"),
            source_path: "/source".into(),
            dest_agent_id: redoor_core::test_support::test_agent_id("dest"),
            dest_path: "/dest".into(),
            total_bytes: 8,
            direction: TransferDirection::Copy,
        });
        let link =
            |name: &str| state.agents.by_id[&redoor_core::test_support::test_agent_id(name)].link();
        let (source_link, dest_link) = (link("source"), link("dest"));
        state.flows.insert(
            flow_id,
            Flow::Copy(Box::new(CopyFlow {
                pause: None,
                resumable: false,
                progress_id: flow_id.as_transfer_id(),
                source_agent_id: redoor_core::test_support::test_agent_id("source"),
                dest_agent_id: redoor_core::test_support::test_agent_id("dest"),
                content_kind: CopyContentKind::RawFile,
                then: None,
                phase: CopyPhase::Remote(Box::new(RemoteCopy {
                    source: StreamLease::new(source_id, source_link, 0),
                    dest: OutboundStream::new(
                        StreamLease::new(dest_id, dest_link, 0),
                        redoor_core::stream_credit::CreditGate::default(),
                        false,
                    ),
                    stage: RemoteStage::Streaming,
                    source_finished: false,
                })),
            })),
        );
        state.finish_copy_response(
            flow_id,
            RouteResponse {
                agent_id: redoor_core::test_support::test_agent_id("source"),
                socket_id: redoor_protocol::ids::SocketId::new(),
                request_id: source_id,
                result: CommandOutcome::error(
                    redoor_protocol::wire::command::CommandErrorKind::Internal,
                    "Failed to read file: boom",
                ),
            },
        );
        // The destination worker is told to stop; its staging must never be published.
        assert!(matches!(
            lanes[1].priority.try_recv(),
            Ok(ServerToAgent::Cancel { id, reason: CancelReason::Disconnected }) if id == dest_id
        ));
        // The source already answered, so it is not canceled again.
        assert!(lanes[0].priority.try_recv().is_err());
        let entry = &state.progress.entries[&flow_id.as_transfer_id()];
        // The copy fails with the source's own reason.
        assert!(matches!(entry.state, TransferProgressState::Errored));
        assert_eq!(entry.error.as_deref(), Some("Failed to read file: boom"));
        state.ui.refresh_check_task.abort();
    }
}
