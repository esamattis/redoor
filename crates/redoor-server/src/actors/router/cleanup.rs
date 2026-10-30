//! Cancellation of flows and the cleanup that follows losing an agent's connection.

use super::RouterError;
use super::agents::CancelDelivery;
use super::flows::{Flow, FlowId, OutputKind, OutputPhase, UploadPhase};
use super::messages::{CancelPublicTransferError, RouteResponse};
use super::state::RouterState;
use super::transfers::copy::CopyRelease;
use redoor_core::log;
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::request::{CommandError, CommandOutcome};
use redoor_protocol::{
    api::transfers::{CancelTransferResponse, CancelTransferStatus, TransferProgressState},
    ids::{AgentId, RequestId, TransferId},
    wire::command::CommandErrorKind,
};

impl RouterState {
    /// Resolves a public transfer id and admits its cancellation on the priority lanes.
    pub(crate) fn cancel_public_transfer(
        &mut self,
        transfer_id: TransferId,
    ) -> Result<CancelTransferResponse, CancelPublicTransferError> {
        self.sync_progress();
        let entry = self
            .progress
            .entries
            .get(&transfer_id)
            .ok_or(CancelPublicTransferError::NotFound)?;
        let status = match entry.state {
            TransferProgressState::Canceling => Some(CancelTransferStatus::AlreadyCanceling),
            TransferProgressState::Canceled => Some(CancelTransferStatus::AlreadyCanceled),
            TransferProgressState::Active if entry.cancelable => None,
            TransferProgressState::Active
            | TransferProgressState::Errored
            | TransferProgressState::Completed => {
                return Err(CancelPublicTransferError::NotCancelable);
            }
        };
        if let Some(status) = status {
            return Ok(CancelTransferResponse {
                transfer_id,
                status,
            });
        }
        match self
            .flows
            .find_by_progress(transfer_id)
            .and_then(|id| self.flows.get(id).map(|flow| (id, flow)))
        {
            Some((flow_id, Flow::Output(_))) => {
                // Downloads admit remote cleanup before changing history or stopping the body,
                // so a failed admission stays retryable.
                self.request_output_cancel(flow_id)
                    .map_err(CancelPublicTransferError::Delivery)?;
                self.mark_transfer_canceling(transfer_id);
            }
            Some((flow_id, Flow::Copy(_))) => {
                self.mark_transfer_canceling(transfer_id);
                self.cancel_copy(flow_id)?;
            }
            Some((flow_id, Flow::Upload(_))) => {
                self.mark_transfer_canceling(transfer_id);
                self.cancel_upload(flow_id, true);
            }
            Some((_, Flow::Command(_))) | None => {
                // An active row without live ownership can only be a just-completed race.
                self.mark_transfer_canceling(transfer_id);
                self.mark_transfer_canceled(transfer_id);
            }
        }
        Ok(CancelTransferResponse {
            transfer_id,
            status: CancelTransferStatus::Accepted,
        })
    }

    /// Cancels an upload; explicit cancels also answer the waiting HTTP producer right away.
    fn cancel_upload(&mut self, flow_id: FlowId, explicit: bool) {
        let Some(Flow::Upload(upload)) = self.flows.get_mut(flow_id) else {
            return;
        };
        if matches!(upload.phase, UploadPhase::Canceling { .. }) {
            return;
        }
        upload.phase = UploadPhase::Canceling { explicit };
        upload.stream.lease().stop();
        if explicit {
            if let Some(sender) = upload.completion.take() {
                let _ = sender.send(Err(RouterError::ClientCanceledUpload));
            }
            if let Some(sender) = upload.ready.take() {
                let _ = sender.send(Err(RouterError::ClientCanceledUpload));
            }
        }
        let (agent_id, request_id) = (upload.agent_id.clone(), upload.request_id);
        log!(
            Level::Info,
            "Sending upload cancel to agent: agent_id={}, request_id={}",
            agent_id,
            request_id
        );
        // A closed lane means the connection is gone, and its teardown settles the upload.
        let _ = self.cancel_on_agent(
            &agent_id,
            request_id,
            redoor_protocol::wire::partials::CancelReason::Canceled,
        );
    }

    /// Stops request `request_id` on `agent_id`.
    ///
    /// A command withdrawn before it was written is answered here with a canceled result,
    /// since the agent never saw it; it is routed after the current message like an agent's
    /// result. Otherwise the agent's own result acknowledges the cancel. Returns the task
    /// retaining a cancel that waits for lane capacity, so the caller can abort it once the
    /// cancel became pointless.
    pub(crate) fn cancel_on_agent(
        &mut self,
        agent_id: &AgentId,
        request_id: RequestId,
        reason: redoor_protocol::wire::partials::CancelReason,
    ) -> Result<Option<tokio::task::JoinHandle<()>>, RouterError> {
        let connection =
            self.agents
                .by_id
                .get_mut(agent_id)
                .ok_or_else(|| RouterError::AgentNotFound {
                    agent_id: agent_id.to_string(),
                })?;
        match connection.cancel_request(request_id, reason)? {
            CancelDelivery::Sent(retained) => Ok(retained),
            CancelDelivery::Withdrawn => {
                self.local_results.push(RouteResponse {
                    agent_id: agent_id.clone(),
                    socket_id: connection.socket_id.clone(),
                    request_id,
                    result: CommandOutcome::error(
                        CommandErrorKind::Canceled,
                        "Canceled before it was sent to the agent",
                    ),
                });
                Ok(None)
            }
        }
    }

    /// Cancels an execution through its own resource, independently of file history.
    pub(crate) fn cancel_execution(
        &mut self,
        request_id: RequestId,
        agent_id: AgentId,
    ) -> Result<bool, RouterError> {
        let Some(flow_id) = self.flows.id_for(&agent_id, request_id) else {
            return Ok(false);
        };
        let Some(Flow::Output(flow)) = self.flows.get(flow_id) else {
            return Ok(false);
        };
        if flow.agent_id != agent_id || !matches!(flow.kind, OutputKind::Execution { .. }) {
            return Ok(false);
        }
        self.request_output_cancel(flow_id)?;
        Ok(true)
    }

    /// Cancels a download or upload whose HTTP side went away (body dropped, producer gone).
    /// One-shot commands are abandoned through `RouterMsg::AbandonCommand` instead.
    ///
    /// Copies are canceled only through their public id because both agents must settle.
    pub(crate) fn cancel_transfer(&mut self, request_id: RequestId, agent_id: AgentId) {
        let Some(flow_id) = self.flows.id_for(&agent_id, request_id) else {
            log!(
                Level::Warning,
                "Transfer not found for cancel request: request_id={}",
                request_id
            );
            return;
        };
        let (owner, canceling, progress_id) = match self.flows.get(flow_id) {
            Some(Flow::Output(flow)) => (
                flow.agent_id.clone(),
                matches!(flow.phase, OutputPhase::Canceling { .. }),
                match flow.kind {
                    OutputKind::Download { progress_id, .. } => Some(progress_id),
                    OutputKind::Execution { .. } => None,
                },
            ),
            // Past the commit or publication boundary the agent finishes regardless, and its
            // result records the real outcome; a departed client must not mark it failed.
            Some(Flow::Upload(flow)) => (
                flow.agent_id.clone(),
                matches!(
                    flow.phase,
                    UploadPhase::Canceling { .. }
                        | UploadPhase::Publishing
                        | UploadPhase::Committing
                ),
                Some(request_id.as_transfer_id()),
            ),
            Some(Flow::Command(_)) | Some(Flow::Copy(_)) | None => return,
        };
        if owner != agent_id {
            log!(
                Level::Warning,
                "Transfer cancel agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                request_id,
                owner,
                agent_id
            );
            return;
        }
        if canceling {
            return;
        }
        // Capture the bytes the consumer really received before the row stops tracking them,
        // so a client retry can resume from the right offset.
        self.sync_progress();
        match self.flows.get(flow_id) {
            Some(Flow::Output(_)) => {
                if self.request_output_cancel(flow_id).is_err() {
                    return;
                }
                // The client already stopped consuming, so the download ends now.
                if let Some(progress_id) = progress_id {
                    self.mark_transfer_errored(
                        progress_id,
                        "Download canceled by client".to_string(),
                    );
                }
            }
            Some(Flow::Upload(_)) => {
                // Settle now even though the agent's cleanup acknowledgement arrives later.
                if let Some(progress_id) = progress_id {
                    self.mark_transfer_errored(
                        progress_id,
                        "Upload stream canceled by client".to_string(),
                    );
                }
                self.cancel_upload(flow_id, false);
            }
            _ => {}
        }
    }

    /// Fails every flow that cannot continue without the lost connection, in one pass over
    /// the flow table, and settles each one exactly once.
    pub(crate) fn fail_agent_flows(&mut self, agent_id: &AgentId) {
        self.sync_progress();
        let lost = self.flows.extract_if(|flow| flow.involves(agent_id));
        if lost.is_empty() {
            return;
        }
        let reason = format!("Agent disconnected: {agent_id}");
        let mut transfers = 0usize;
        for (_, flow) in lost {
            if !matches!(flow, Flow::Command(_)) {
                transfers += 1;
            }
            self.settle_lost_flow(agent_id, flow, &reason);
        }
        if transfers > 0 {
            log!(
                Level::Warning,
                "Agent loss cleanup: agent_id={}, transfers={}, reason={}",
                agent_id,
                transfers,
                reason
            );
            self.notify_transfer_refresh();
        }
    }

    /// Settles one flow removed because its agent went away.
    fn settle_lost_flow(&mut self, agent_id: &AgentId, flow: Flow, reason: &str) {
        match flow {
            Flow::Command(command) => {
                log!(
                    Level::Warning,
                    "Cleaning up orphaned pending response: request_id={}, agent_id={}",
                    command.request_id,
                    agent_id
                );
                let _ = command.reply.send(CommandOutcome::error(
                    CommandErrorKind::Internal,
                    format!("Agent disconnected: {agent_id}"),
                ));
            }
            Flow::Output(output) => {
                log!(
                    Level::Warning,
                    "Cleaning up orphaned output stream: request_id={}, agent_id={}",
                    output.request_id,
                    agent_id
                );
                if let Some(connection) = self.agents.by_id.get(&output.agent_id) {
                    connection.streams.close_inbound(output.request_id);
                }
                output
                    .lease
                    .fail(CommandError::new(CommandErrorKind::Internal, reason));
                if let OutputKind::Download { progress_id, .. } = output.kind {
                    self.settle_lost_transfer(progress_id, reason);
                }
            }
            Flow::Upload(mut upload) => {
                log!(
                    Level::Warning,
                    "Cleaning up orphaned upload stream: request_id={}, agent_id={}",
                    upload.request_id,
                    agent_id
                );
                self.release_upload(&upload);
                self.settle_lost_transfer(upload.request_id.as_transfer_id(), reason);
                let error = RouterError::AgentNotFound {
                    agent_id: agent_id.to_string(),
                };
                if let Some(sender) = upload.completion.take() {
                    let _ = sender.send(Err(error.clone()));
                }
                if let Some(sender) = upload.ready.take() {
                    let _ = sender.send(Err(error));
                }
            }
            Flow::Copy(mut copy) => {
                self.release_copy(&copy, CopyRelease::Fail);
                let message = if copy.keeps_partial() {
                    format!("{reason}; partial kept")
                } else {
                    reason.to_string()
                };
                if let Some(reply) = copy.pause.take() {
                    // Connection loss cannot acknowledge that the paused bytes are durable.
                    let _ = reply.send(Err(message.clone()));
                    self.mark_transfer_errored(copy.progress_id, message);
                } else {
                    self.settle_lost_transfer(copy.progress_id, &message);
                }
            }
        }
    }

    /// Preserves an accepted cancellation when teardown releases the remaining ownership.
    fn settle_lost_transfer(&mut self, transfer_id: TransferId, reason: &str) {
        if matches!(
            self.progress
                .entries
                .get(&transfer_id)
                .map(|entry| &entry.state),
            Some(TransferProgressState::Canceling)
        ) {
            self.mark_transfer_canceled(transfer_id);
        } else {
            self.mark_transfer_errored(transfer_id, reason.to_string());
        }
    }
}
