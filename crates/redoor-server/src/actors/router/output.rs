//! Agent-to-consumer output streams: file downloads (with transfer history), exec output and
//! search matches.
//!
//! The router admits the stream and opens its inbound slot; frames then flow from the
//! connection reader to the consumer's [`OutputReceiver`](super::streams::OutputReceiver)
//! directly. The router sees the stream again only for its result, which the agent sends after
//! the stream's data, for a credit violation, or for cancellation.

use super::RouterError;
use super::flows::{Flow, FlowId, OutputFlow, OutputKind, OutputPhase};
use super::messages::{ExecuteStreamRequest, OutputStreamTracking, RouteResponse};
use super::progress::DownloadStartContext;
use super::state::RouterState;
use super::streams::{CREDIT_VIOLATION, StreamLease};
use redoor_protocol::wire::request::{
    self, AgentRequest, CommandError, CommandOutcome, DecodeError,
};
use redoor_protocol::{
    api::transfers::TransferProgressState,
    wire::{
        command::CommandErrorKind, exec::ExecEvent, policy::CommandLane,
        stream::STREAM_CREDIT_WINDOW_FRAMES,
    },
};
use std::sync::atomic::Ordering;

/// The exec event a result reports; a failure still ends the execution visibly.
fn exec_event(result: CommandOutcome) -> ExecEvent {
    match request::Exec::decode(result) {
        Ok(event) => event,
        Err(DecodeError::Failed(CommandError {
            kind: CommandErrorKind::Canceled,
            ..
        })) => ExecEvent::Canceled,
        Err(DecodeError::Failed(CommandError { message, .. })) => ExecEvent::Error { message },
        Err(DecodeError::Malformed(error)) => ExecEvent::Error {
            message: format!("Malformed execution result: {error}"),
        },
    }
}

impl RouterState {
    /// Admits an exec, search or download stream.
    ///
    /// Ownership is validated from the command policy before anything is admitted, so process
    /// output and search matches can never acquire file history. The inbound slot opens before
    /// the command is queued, so no frame can arrive unroutable.
    pub(crate) fn start_output(&mut self, request: ExecuteStreamRequest) {
        let ExecuteStreamRequest {
            agent_id,
            command,
            tracking,
            reply,
        } = request;
        if command.policy().lane != CommandLane::Output || !tracking.fits(&command) {
            let _ = reply.send(Err(RouterError::UnexpectedResponseType {
                operation: "registering output command ownership",
            }));
            return;
        }
        let id = self.next_id();
        let Some(connection) = self.agents.by_id.get_mut(&agent_id) else {
            let _ = reply.send(Err(RouterError::AgentNotFound {
                agent_id: agent_id.to_string(),
            }));
            return;
        };
        let lease = StreamLease::new(id, connection.link(), 0);
        let receiver = connection
            .streams
            .open_inbound(lease.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        if !connection.send_command(id, command) {
            connection.streams.close_inbound(id);
            let _ = reply.send(Err(RouterError::ControlQueueFull {
                agent_id: agent_id.to_string(),
            }));
            return;
        }
        let kind = match tracking {
            OutputStreamTracking::Download {
                path,
                total_bytes,
                full_size,
                resume_offset,
            } => {
                let progress_id = self.record_download_start(DownloadStartContext {
                    request_id: id,
                    agent_id: agent_id.clone(),
                    path,
                    total_bytes,
                    full_size,
                    resume_offset,
                });
                let base_bytes = self.transferred_bytes(progress_id).unwrap_or(0);
                // No frame is drained before the consumer receives its receiver below.
                lease.bytes.store(base_bytes, Ordering::Relaxed);
                OutputKind::Download {
                    progress_id,
                    base_bytes,
                }
            }
            OutputStreamTracking::Execution { terminal } => OutputKind::Execution { terminal },
            OutputStreamTracking::Events => OutputKind::Events,
        };
        self.flows.insert(
            id,
            Flow::Output(OutputFlow {
                request_id: id,
                agent_id: agent_id.clone(),
                kind,
                lease,
                phase: OutputPhase::Streaming,
            }),
        );
        if reply.send(Ok(receiver)).is_err() {
            self.cancel_transfer(id, agent_id);
        }
    }

    /// Fails an output stream whose agent ignored its credit and stops the agent's worker,
    /// whose result then only acknowledges the cancel.
    pub(crate) fn fail_overflowing_output(&mut self, flow_id: FlowId) {
        let Some(Flow::Output(flow)) = self.flows.get(flow_id) else {
            return;
        };
        if matches!(flow.phase, OutputPhase::Canceling { .. }) {
            return;
        }
        flow.lease.fail(CommandError::new(
            CommandErrorKind::Internal,
            CREDIT_VIOLATION,
        ));
        if let OutputKind::Download { progress_id, .. } = flow.kind {
            self.mark_transfer_errored(progress_id, CREDIT_VIOLATION.to_string());
            self.notify_transfer_refresh();
        }
        // The worker may still be producing although its stream is gone.
        let _ = self.request_output_cancel(flow_id);
    }

    /// Explicit file cancellation becomes terminal only when the agent released its worker.
    pub(crate) fn acknowledge_download_cancel(
        &mut self,
        progress_id: redoor_protocol::ids::TransferId,
    ) {
        if matches!(
            self.progress
                .entries
                .get(&progress_id)
                .map(|entry| &entry.state),
            Some(TransferProgressState::Canceling)
        ) {
            self.mark_transfer_canceled(progress_id);
            self.notify_transfer_refresh();
        }
    }

    /// Settles an output stream from its result.
    ///
    /// The result follows the stream's data, so the consumer already has every frame: a
    /// success is final, and an error stops the stream after its queued frames with the
    /// agent's message. While canceling, the result only acknowledges the cancel.
    pub(crate) fn finish_output_response(&mut self, flow_id: FlowId, response: RouteResponse) {
        let Some(Flow::Output(flow)) = self.flows.get(flow_id) else {
            return;
        };
        if flow.agent_id != response.agent_id {
            return;
        }
        let Some(Flow::Output(flow)) = self.flows.remove(flow_id) else {
            return;
        };
        let canceling = matches!(flow.phase, OutputPhase::Canceling { .. });
        match &flow.kind {
            OutputKind::Execution { terminal } => {
                terminal.send_replace(Some(exec_event(response.result)));
            }
            OutputKind::Download { progress_id, .. } if canceling => {
                self.acknowledge_download_cancel(*progress_id);
            }
            OutputKind::Download { progress_id, .. } => {
                let progress_id = *progress_id;
                match response.result {
                    CommandOutcome::Error(error) => {
                        self.mark_transfer_errored(progress_id, error.message.clone());
                        flow.lease.fail(error);
                    }
                    _ => self.complete_download(&flow, progress_id),
                }
                self.notify_transfer_refresh();
            }
            OutputKind::Events if canceling => {}
            // An event stream's summary (a search's `done` line) is already queued as data, so
            // only a failure needs the consumer's attention: it ends the stream after the
            // events it has.
            OutputKind::Events => {
                if let CommandOutcome::Error(error) = response.result {
                    flow.lease.fail(error);
                }
            }
        }
        if let Some(connection) = self.agents.by_id.get(&flow.agent_id) {
            // Store a typed failure before closing the queue, or a concurrent consumer
            // could observe EOF before the error explaining why no FIN arrived.
            connection.streams.close_inbound(flow.request_id);
        }
    }

    /// Records a download whose agent finished streaming it.
    fn complete_download(
        &mut self,
        flow: &OutputFlow,
        progress_id: redoor_protocol::ids::TransferId,
    ) {
        let OutputKind::Download { base_bytes, .. } = flow.kind else {
            return;
        };
        if let Some(entry) = self.progress.entries.get_mut(&progress_id)
            && matches!(entry.state, TransferProgressState::Active)
        {
            // Count everything queued for the consumer, not just what it drained yet, so
            // unknown-size archives complete with their full size.
            entry.transferred_bytes = base_bytes.saturating_add(flow.lease.received());
        }
        self.mark_transfer_completed(progress_id);
    }

    /// Admits cancellation of an output stream on the agent, then stops its data path.
    /// Failed admission leaves the stream untouched so the caller can retry.
    pub(crate) fn request_output_cancel(&mut self, flow_id: FlowId) -> Result<(), RouterError> {
        let Some(Flow::Output(flow)) = self.flows.get(flow_id) else {
            return Ok(());
        };
        if matches!(flow.phase, OutputPhase::Canceling { .. }) {
            return Ok(());
        }
        let (agent_id, request_id) = (flow.agent_id.clone(), flow.request_id);
        let retained_delivery = self.cancel_on_agent(
            &agent_id,
            request_id,
            redoor_protocol::wire::partials::CancelReason::Canceled,
        )?;
        if let Some(Flow::Output(flow)) = self.flows.get_mut(flow_id) {
            flow.phase = OutputPhase::Canceling { retained_delivery };
            flow.lease.stop();
        }
        Ok(())
    }

    /// Applies a late-discovered archive total to the download that owns its history row.
    pub(crate) fn update_download_total(
        &mut self,
        flow_id: FlowId,
        agent_id: &redoor_protocol::ids::AgentId,
        total_bytes: Option<u64>,
    ) {
        let Some(Flow::Output(flow)) = self.flows.get(flow_id) else {
            return;
        };
        let OutputKind::Download { progress_id, .. } = flow.kind else {
            return;
        };
        if &flow.agent_id != agent_id {
            return;
        }
        if let Some(total) = total_bytes {
            self.set_download_total(progress_id, total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::RouterMsg;
    use super::super::messages::RegisterAgentRequest;
    use super::super::state::AgentConnection;
    use super::super::streams::{ConnectionStreams, OutputReceiver};
    use super::*;
    use crate::actors::lanes::{ControlLanes, QueuedCommand};
    use redoor_protocol::ids::{AgentId, RequestId};
    use redoor_protocol::wire::ServerToAgent;
    use redoor_protocol::wire::command::Command;
    use redoor_protocol::wire::stream::StreamChunk;
    use tokio::sync::{mpsc, oneshot, watch};

    /// Keeps lane receivers alive so tests can exercise real admission pressure.
    struct Fixture {
        state: RouterState,
        commands: mpsc::Receiver<QueuedCommand>,
        priority: mpsc::Receiver<ServerToAgent>,
        streams: ConnectionStreams,
        agent: AgentId,
    }

    impl Fixture {
        /// Single-slot control lanes make saturation deterministic without a network peer.
        fn new() -> Self {
            let mut state = RouterState::new(tokio::spawn(std::future::pending()));
            let agent = redoor_core::test_support::test_agent_id("output-test");
            let (lanes, receivers) = ControlLanes::bounded(1, 1);
            let streams = ConnectionStreams::new(agent.clone());
            let connection = AgentConnection::from_register_request(
                RegisterAgentRequest::for_test(&agent, lanes, streams.clone()),
            );
            state.agents.by_id.insert(agent.clone(), connection);
            Self {
                state,
                commands: receivers.commands,
                priority: receivers.priority,
                streams,
                agent,
            }
        }

        /// Admits an output stream through the real start path, leaving its command queued.
        async fn admit(
            &mut self,
            command: Command,
            tracking: OutputStreamTracking,
        ) -> Result<OutputReceiver, RouterError> {
            let (reply, receiver) = oneshot::channel();
            self.state.start_output(ExecuteStreamRequest {
                agent_id: self.agent.clone(),
                command,
                tracking,
                reply,
            });
            receiver.await.unwrap()
        }

        /// Admits an output stream and lets the writer take its command, as if it reached
        /// the socket; this also frees the single-slot lane again.
        async fn start(
            &mut self,
            command: Command,
            tracking: OutputStreamTracking,
        ) -> Result<OutputReceiver, RouterError> {
            let result = self.admit(command, tracking).await;
            if let Ok(QueuedCommand {
                ticket: Some(ticket),
                ..
            }) = self.commands.try_recv()
            {
                assert!(ticket.mark_written());
            }
            result
        }

        /// The exec command used by every execution test.
        fn exec_command() -> Command {
            Command::Exec(request::Exec {
                request: redoor_protocol::wire::exec::ExecRequest {
                    argv: vec!["true".into()],
                    cwd: None,
                    env: Default::default(),
                    timeout_ms: None,
                },
            })
        }

        /// Starts an execution and returns its consumer plus the independent terminal lane.
        async fn exec(&mut self) -> (OutputReceiver, watch::Receiver<Option<ExecEvent>>) {
            let (terminal, terminal_receiver) = watch::channel(None);
            let receiver = self
                .start(
                    Self::exec_command(),
                    OutputStreamTracking::Execution { terminal },
                )
                .await
                .unwrap();
            (receiver, terminal_receiver)
        }

        /// Exact resource-specific cancellation path used by DELETE.
        fn cancel(&mut self, id: RequestId) -> Result<bool, RouterError> {
            self.state.cancel_execution(id, self.agent.clone())
        }

        /// Delivers one agent frame through the connection reader's routing.
        fn deliver(&mut self, id: RequestId, is_last: bool, data: Vec<u8>) {
            if let Some(violation) = self.streams.deliver(StreamChunk {
                request_id: id,
                is_last,
                data: data.into(),
            }) {
                self.state.handle(RouterMsg::CreditViolated(violation));
            }
        }

        /// Delivers the agent's result for `id` through the router.
        fn respond(&mut self, id: RequestId, result: CommandOutcome) {
            let socket_id = self.state.agents.by_id[&self.agent].socket_id.clone();
            self.state.handle(RouterMsg::RouteResponse(RouteResponse {
                agent_id: self.agent.clone(),
                socket_id,
                request_id: id,
                result,
            }));
        }
    }

    /// Both full lanes must retain one cancellation intent, with no fabricated termination.
    #[tokio::test]
    async fn saturated_lanes_retain_cancel_without_acknowledging_termination() {
        let mut fixture = Fixture::new();
        let (mut output, terminal) = fixture.exec().await;
        let id = output.request_id();
        let connection = &fixture.state.agents.by_id[&fixture.agent];
        let occupied = || ServerToAgent::Evicted {
            message: "occupied".to_string(),
        };
        assert!(connection.lanes.try_command(occupied()));
        assert!(connection.lanes.try_priority(occupied()));
        // Saturation accepts retained intent; repeated DELETE must not enqueue another task.
        assert_eq!(fixture.cancel(id), Ok(true));
        assert_eq!(fixture.cancel(id), Ok(true));
        assert!(terminal.borrow().is_none());
        // Releasing priority capacity delivers cancellation while ordinary commands stay full.
        fixture.priority.recv().await.unwrap();
        assert!(matches!(
            fixture.priority.recv().await,
            Some(ServerToAgent::Cancel { id: request_id, reason: redoor_protocol::wire::partials::CancelReason::Canceled }) if request_id == id
        ));
        assert!(fixture.priority.try_recv().is_err());
        // The stopped stream ends for the consumer without waiting for more output.
        assert!(output.recv().await.is_none());
        // The agent's result confirms cleanup before ownership is released.
        fixture.respond(id, request::Exec::encode(Ok(ExecEvent::Canceled)));
        assert!(matches!(&*terminal.borrow(), Some(ExecEvent::Canceled)));
        assert!(fixture.state.flows.id_for(&fixture.agent, id).is_none());
    }

    /// A cancel must never overtake its command, so a command still in the queue is
    /// withdrawn: nothing reaches the wire and the router answers it as canceled itself.
    #[tokio::test]
    async fn cancel_of_unsent_command_is_withdrawn_without_wire_traffic() {
        let mut fixture = Fixture::new();
        let (terminal, terminal_receiver) = watch::channel(None);
        let output = fixture
            .admit(
                Fixture::exec_command(),
                OutputStreamTracking::Execution { terminal },
            )
            .await
            .unwrap();
        let id = output.request_id();
        assert_eq!(fixture.cancel(id), Ok(true));
        fixture.state.route_local_results();
        // No cancel frame is queued, because the agent will never know this id.
        assert!(fixture.priority.try_recv().is_err());
        let queued = fixture.commands.try_recv().unwrap();
        // The writer skips the withdrawn command instead of writing it.
        assert!(!queued.ticket.unwrap().mark_written());
        // The execution still ends, with a canceled outcome and no flow left behind.
        assert!(matches!(
            &*terminal_receiver.borrow(),
            Some(ExecEvent::Canceled)
        ));
        assert!(fixture.state.flows.id_for(&fixture.agent, id).is_none());
    }

    /// Failed admission must leave the stream untouched so a caller can retry.
    #[tokio::test]
    async fn closed_priority_lane_rejects_without_losing_retry() {
        let mut fixture = Fixture::new();
        let (_output, terminal) = fixture.exec().await;
        let id = _output.request_id();
        fixture.priority.close();
        // Failure cannot stop output or pretend the process has stopped.
        assert!(fixture.cancel(id).is_err());
        assert!(matches!(
            fixture.state.flows.get(id),
            Some(Flow::Output(OutputFlow {
                phase: OutputPhase::Streaming,
                ..
            }))
        ));
        assert!(terminal.borrow().is_none());
        let (lanes, mut receivers) = ControlLanes::bounded(1, 1);
        fixture
            .state
            .agents
            .by_id
            .get_mut(&fixture.agent)
            .unwrap()
            .lanes = lanes;
        // The same execution remains cancelable once delivery is available again.
        assert_eq!(fixture.cancel(id), Ok(true));
        assert!(matches!(
            receivers.priority.recv().await,
            Some(ServerToAgent::Cancel { id: request_id, reason: redoor_protocol::wire::partials::CancelReason::Canceled }) if request_id == id
        ));
    }

    /// Output queued before a cancel is still drained, then the consumer sees the end.
    #[tokio::test]
    async fn cancel_keeps_queued_output_and_releases_consumer() {
        let mut fixture = Fixture::new();
        let (mut output, _terminal) = fixture.exec().await;
        let id = output.request_id();
        fixture.deliver(id, false, b"queued".to_vec());
        assert_eq!(fixture.cancel(id), Ok(true));
        // Accepted output is not discarded by cancellation.
        assert_eq!(output.recv().await.unwrap().unwrap().data, &b"queued"[..]);
        // Releasing a waiting consumer must not require another agent frame.
        assert!(output.recv().await.is_none());
    }

    /// Bad tracking metadata is rejected before remote work or file history is admitted.
    #[tokio::test]
    async fn command_tracking_mismatch_is_rejected_before_admission() {
        let mut fixture = Fixture::new();
        let result = fixture
            .start(
                Fixture::exec_command(),
                OutputStreamTracking::Download {
                    path: "/fake".into(),
                    total_bytes: 0,
                    full_size: None,
                    resume_offset: None,
                },
            )
            .await;
        // Mismatched resource metadata cannot fabricate progress or send a command.
        assert!(matches!(
            result,
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        assert!(fixture.state.progress.entries.is_empty());
    }

    /// The result after a cancel carries the actual outcome, not an invented cancellation:
    /// an exit the agent reached first wins over the cancel.
    #[tokio::test]
    async fn result_after_cancel_reports_the_actual_outcome() {
        for event in [
            ExecEvent::Canceled,
            ExecEvent::Exit {
                code: Some(7),
                signal: None,
            },
        ] {
            let mut fixture = Fixture::new();
            let (_output, terminal) = fixture.exec().await;
            let id = _output.request_id();
            // Admission alone is deliberately not termination.
            assert_eq!(fixture.cancel(id), Ok(true));
            assert!(terminal.borrow().is_none());
            fixture.respond(id, request::Exec::encode(Ok(event.clone())));
            // The result is authoritative even though the stopped consumer saw no frames.
            assert_eq!(
                serde_json::to_value(terminal.borrow().clone()).unwrap(),
                serde_json::to_value(Some(event)).unwrap()
            );
            assert!(fixture.state.flows.id_for(&fixture.agent, id).is_none());
        }
    }

    /// Starts a tar download of `/dir`.
    async fn tar_download(fixture: &mut Fixture) -> OutputReceiver {
        fixture
            .start(
                Command::TarDownload(request::TarDownload {
                    path: "/dir".into(),
                    include_root: true,
                }),
                OutputStreamTracking::Download {
                    path: "/dir".into(),
                    total_bytes: 0,
                    full_size: None,
                    resume_offset: None,
                },
            )
            .await
            .unwrap()
    }

    /// Downloads complete on their result with every byte the reader queued, and
    /// cancellation of a download is not reachable through the execution endpoint.
    #[tokio::test]
    async fn download_completion_counts_queued_bytes_and_is_not_an_execution() {
        let mut fixture = Fixture::new();
        let output = tar_download(&mut fixture).await;
        let id = output.request_id();
        // File history belongs to downloads only; DELETE /exec must not reach it.
        assert_eq!(fixture.cancel(id), Ok(false));
        fixture.deliver(id, false, vec![1; 10]);
        fixture.deliver(id, true, vec![1; 5]);
        let entry = &fixture.state.progress.entries[&id.as_transfer_id()];
        // FIN alone is not completion; the result that follows it is.
        assert!(matches!(entry.state, TransferProgressState::Active));
        fixture.respond(id, CommandOutcome::Ok(serde_json::Value::Null));
        let entry = &fixture.state.progress.entries[&id.as_transfer_id()];
        // Unknown-size archives complete with every queued byte even before they are drained.
        assert!(matches!(entry.state, TransferProgressState::Completed));
        assert_eq!(entry.total_bytes, 15);
    }

    /// A download that fails mid-stream ends without FIN; its consumer gets the data sent
    /// before the failure and then the agent's message, never a silently short file.
    #[tokio::test]
    async fn failed_download_delivers_data_then_the_error() {
        let mut fixture = Fixture::new();
        let mut output = tar_download(&mut fixture).await;
        let id = output.request_id();
        fixture.deliver(id, false, b"partial".to_vec());
        fixture.respond(
            id,
            CommandOutcome::error(CommandErrorKind::Internal, "disk gone"),
        );
        assert_eq!(output.recv().await.unwrap().unwrap().data, &b"partial"[..]);
        // The failure arrives after the data, as on the wire.
        assert_eq!(
            output.recv().await,
            Some(Err(CommandError::new(
                CommandErrorKind::Internal,
                "disk gone"
            )))
        );
        let entry = &fixture.state.progress.entries[&id.as_transfer_id()];
        // The history row carries the agent's reason.
        assert!(matches!(entry.state, TransferProgressState::Errored));
        assert_eq!(entry.error.as_deref(), Some("disk gone"));
    }

    /// The path search used by the search stream tests.
    fn file_search() -> Command {
        Command::FileSearch(request::FileSearch {
            path: "/tmp".into(),
            query: "q".into(),
            timeout_seconds: 5,
            include_hidden: false,
            respect_gitignore: true,
            case_sensitivity: Default::default(),
            directories_only: false,
        })
    }

    /// A search that fails mid-stream ends after the matches it sent with the agent's
    /// error, and it never creates a transfer history row.
    #[tokio::test]
    async fn failing_search_stream_delivers_matches_then_the_error() {
        let mut fixture = Fixture::new();
        let mut output = fixture
            .start(file_search(), OutputStreamTracking::Events)
            .await
            .unwrap();
        let id = output.request_id();
        fixture.deliver(id, false, b"{\"type\":\"match\"}\n".to_vec());
        fixture.respond(
            id,
            request::FileSearch::encode(Err(CommandError::new(
                CommandErrorKind::Internal,
                "disk gone",
            ))),
        );
        // The matches queued before the failure still reach the consumer.
        assert_eq!(
            output.recv().await.unwrap().unwrap().data,
            &b"{\"type\":\"match\"}\n"[..]
        );
        // The failure follows them instead of an end that looks complete.
        assert_eq!(
            output.recv().await,
            Some(Err(CommandError::new(
                CommandErrorKind::Internal,
                "disk gone"
            )))
        );
        // Searches are not transfers, so they never show up in the transfer history.
        assert!(fixture.state.progress.entries.is_empty());
        // The result settled the flow.
        assert!(fixture.state.flows.id_for(&fixture.agent, id).is_none());
    }

    /// A finished search ends with its own `FIN` and a plain success result.
    #[tokio::test]
    async fn finished_search_stream_ends_without_an_error() {
        let mut fixture = Fixture::new();
        let mut output = fixture
            .start(file_search(), OutputStreamTracking::Events)
            .await
            .unwrap();
        let id = output.request_id();
        fixture.deliver(id, true, b"{\"type\":\"done\"}\n".to_vec());
        fixture.respond(id, request::FileSearch::encode(Ok(())));
        // The final frame, carrying `done`, completes the stream.
        assert!(output.recv().await.unwrap().unwrap().is_last);
        // Nothing follows it, not even an error.
        assert!(output.recv().await.is_none());
    }

    /// Search tracking only fits search commands, and searches only take search tracking.
    #[tokio::test]
    async fn search_tracking_must_match_a_search_command() {
        let mut fixture = Fixture::new();
        let exec_as_search = fixture
            .start(Fixture::exec_command(), OutputStreamTracking::Events)
            .await;
        let search_as_download = fixture
            .start(
                file_search(),
                OutputStreamTracking::Download {
                    path: "/tmp".into(),
                    total_bytes: 0,
                    full_size: None,
                    resume_offset: None,
                },
            )
            .await;
        // Process output must keep its terminal lane, and matches must never become a
        // download with a history row.
        assert!(matches!(
            exec_as_search,
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        assert!(matches!(
            search_as_download,
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        assert!(fixture.state.progress.entries.is_empty());
    }

    /// A credit violation fails only the violating stream and stops its agent worker.
    #[tokio::test]
    async fn credit_overflow_fails_stream_and_cancels_worker() {
        let mut fixture = Fixture::new();
        // Room for the cancel and the credit grants the drained frames return.
        let (lanes, receivers) = ControlLanes::bounded(1, 16);
        fixture
            .state
            .agents
            .by_id
            .get_mut(&fixture.agent)
            .unwrap()
            .lanes = lanes;
        fixture.commands = receivers.commands;
        fixture.priority = receivers.priority;
        let (mut output, _terminal) = fixture.exec().await;
        let id = output.request_id();
        for _ in 0..=redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES + 1 {
            fixture.deliver(id, false, b"x".to_vec());
        }
        // The worker is told to stop because its frames are no longer routed.
        assert!(matches!(
            fixture.priority.try_recv(),
            Ok(ServerToAgent::Cancel { id: request_id, reason: redoor_protocol::wire::partials::CancelReason::Canceled }) if request_id == id
        ));
        let mut last = None;
        while let Some(item) = output.recv().await {
            last = Some(item);
        }
        // The consumer ends with an error instead of a silently truncated stream.
        assert!(last.is_some_and(|item| item.is_err()));
    }
}
