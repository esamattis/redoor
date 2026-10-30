//! The router actor: the single owner of agent registrations and in-flight work.
//!
//! The router admits work, tracks each flow's lifecycle and handles cancellation and agent
//! loss. Payload bytes never pass through it: they flow over the data path in [`streams`],
//! and only terminal events come back. Every handler is synchronous, so one slow peer can
//! never make the mailbox wait (enforced crate-wide by `clippy::unused_async`).

mod agents;
mod cleanup;
mod duplicate_ids;
mod error;
mod flows;
mod messages;
mod output;
mod progress;
mod state;
mod streams;
mod transfers;
mod ui;

pub use error::RouterError;
pub use messages::{
    AgentListEntry, ApplyManagedLifecycleRequest, CancelPublicTransferError,
    CommitDirectUploadRequest, CopyTarget, ExecuteCommandRequest, ExecuteStreamRequest, LogStream,
    OpenAgentLogStreamRequest, OpenTerminalRequest, OutboundFailure, OutboundFailureReason,
    OutputStreamTracking, RegisterAgentRequest, RegisterManagedAgentRequest,
    RegisterUiSubscriberRequest, RegistrationRejection, ResumeVerification, RouteResponse,
    RouteTransferReadyRequest, RouterMsg, StartCopyRequest, StartUploadRequest, TerminalStream,
    TransferProgressUpdateRequest, UnregisterManagedAgentRequest, UploadStartOutcome,
};
pub use state::CopyContentKind;
pub use state::CopyOperation;
pub use state::RequestIds;
pub use streams::{ConnectionStreams, OutboundError, OutboundStream, OutputReceiver};

use flows::Flow;
use redoor_core::log;
use redoor_protocol::ids::{AgentId, RequestId, SocketId, UnixTimestampSeconds};
use redoor_protocol::wire::log::Level;
use state::RouterState;
use streams::CreditViolation;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Duration;

/// Control-plane messages only; payload frames never use this mailbox.
const ROUTER_MAILBOX_CAPACITY: usize = 1024;
/// Upper bound for one router reply. Handlers answer synchronously, so only a wedged or
/// shut-down router comes close; agent work is bounded separately by its call deadline.
pub const ROUTER_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// Shared sender used to interact with the single-owner router task.
#[derive(Clone, Debug)]
pub struct RouterHandle {
    sender: mpsc::Sender<RouterMsg>,
    request_ids: RequestIds,
}

impl RouterHandle {
    /// Creates a new handle from the router mailbox sender.
    pub(super) fn new(sender: mpsc::Sender<RouterMsg>) -> Self {
        Self {
            sender,
            request_ids: RequestIds::default(),
        }
    }

    /// Allocates a request id from the router's own sequence, so a caller can name a command
    /// (and later abandon it) before the router has seen the message.
    pub fn next_request_id(&self) -> RequestId {
        self.request_ids.next()
    }

    /// Queues one router message without waiting, for synchronous contexts only.
    ///
    /// A full mailbox is reported as [`RouterSendError::Full`] instead of being folded into the
    /// shutdown error, so callers cannot mistake dropped work for a stopped router. Async
    /// contexts must use [`RouterHandle::send_async`], which waits for capacity instead.
    pub fn send(&self, message: RouterMsg) -> Result<(), RouterSendError> {
        self.sender.try_send(message).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => RouterSendError::Full,
            mpsc::error::TrySendError::Closed(_) => RouterSendError::Stopped,
        })
    }

    /// Queues one router message, waiting for mailbox capacity when necessary.
    pub async fn send_async(&self, message: RouterMsg) -> Result<(), RouterSendError> {
        self.sender
            .send(message)
            .await
            .map_err(|_| RouterSendError::Stopped)
    }

    /// Runs one request/reply interaction against the router task.
    ///
    /// `build` receives the one-shot sender that the router-side handler must use to
    /// deliver the reply for this request. The closure packages that sender into the
    /// appropriate `RouterMsg` variant together with any request-specific payload, which
    /// keeps the caller from having to construct and manage the reply channel manually.
    /// Every router handler answers synchronously, so one shared [`ROUTER_REPLY_TIMEOUT`]
    /// only guards against a wedged router; waits on agents use their own call deadlines.
    /// A reply the router still owns after a timeout is pruned by its periodic tick.
    pub async fn request<T, F>(&self, build: F) -> Result<T, RouterCallError>
    where
        T: Send + 'static,
        F: FnOnce(oneshot::Sender<T>) -> RouterMsg,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_async(build(reply_tx))
            .await
            .map_err(|_| RouterCallError::RouterStopped)?;

        match tokio::time::timeout(ROUTER_REPLY_TIMEOUT, reply_rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(RouterCallError::RouterStopped),
            Err(_) => Err(RouterCallError::TimedOut),
        }
    }

    /// Runs a request/reply interaction whose operation has no bounded completion time.
    pub async fn request_unbounded<T, F>(&self, build: F) -> Result<T, RouterCallError>
    where
        T: Send + 'static,
        F: FnOnce(oneshot::Sender<T>) -> RouterMsg,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_async(build(reply_tx))
            .await
            .map_err(|_| RouterCallError::RouterStopped)?;
        reply_rx.await.map_err(|_| RouterCallError::RouterStopped)
    }
}

/// Closes one terminal or log stream when its bridge ends, however it ends.
///
/// The router then forgets the stream and cancels it on the agent, so a browser that leaves
/// always stops its PTY or log relay and frees the connection's stream slot.
pub struct StreamCloseGuard {
    router: RouterHandle,
    agent_id: AgentId,
    stream: redoor_protocol::ids::RequestId,
}

impl StreamCloseGuard {
    /// Arms the guard for `stream` of `agent_id`.
    pub fn new(
        router: RouterHandle,
        agent_id: AgentId,
        stream: redoor_protocol::ids::RequestId,
    ) -> Self {
        Self {
            router,
            agent_id,
            stream,
        }
    }
}

impl Drop for StreamCloseGuard {
    /// Queues the close without waiting; a full mailbox hands it to a task so it is not lost.
    fn drop(&mut self) {
        let message = RouterMsg::CloseStream {
            agent_id: self.agent_id.clone(),
            stream: self.stream,
        };
        if let Err(RouterSendError::Full) = self.router.send(message) {
            let router = self.router.clone();
            let (agent_id, stream) = (self.agent_id.clone(), self.stream);
            tokio::spawn(async move {
                let _ = router
                    .send_async(RouterMsg::CloseStream { agent_id, stream })
                    .await;
            });
        }
    }
}

/// Why a router message was not queued; a full mailbox must never look like a stopped router.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RouterSendError {
    /// The bounded mailbox had no capacity for a non-waiting send; the message was not queued.
    #[error("router mailbox is full")]
    Full,
    /// The router task has stopped and will never process the message.
    #[error("router has stopped")]
    Stopped,
}

/// Distinguishes request timeouts from router shutdown so callers can report the failure cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RouterCallError {
    /// The router did not answer within [`ROUTER_REPLY_TIMEOUT`], so it is wedged or overloaded.
    #[error("router did not answer in time")]
    TimedOut,
    /// The router task has stopped, so the request can never be answered.
    #[error("router has stopped")]
    RouterStopped,
}

/// Spawns the router task and returns its handle plus join handle.
pub fn spawn_router() -> (RouterHandle, tokio::task::JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel::<RouterMsg>(ROUTER_MAILBOX_CAPACITY);
    let router_handle = RouterHandle::new(sender);
    let state = RouterState::with_request_ids(
        ui::start_refresh_check_task(router_handle.clone()),
        router_handle.request_ids.clone(),
    );
    let task_handle = tokio::spawn(state.run(receiver));
    (router_handle, task_handle)
}

impl RouterState {
    /// Admits an agent-originated frame only from the agent's current control session.
    ///
    /// Request ids are guessable sequence numbers, so a frame is only trusted when the
    /// session that delivered it is the one registered for the agent it names; the flow
    /// handlers then check that this agent owns the request.
    fn accepts_agent_frame(&self, agent_id: &AgentId, socket_id: &SocketId, what: &str) -> bool {
        let current = self.agents.is_current_session(agent_id, socket_id);
        if !current {
            log!(
                Level::Warning,
                "Ignoring agent {} from a session that does not own the agent: agent_id={}, socket_id={}",
                what,
                agent_id,
                socket_id
            );
        }
        current
    }

    /// Routes an agent's final command response to the flow that owns its request id.
    ///
    /// The result is always the last frame of a request and follows its stream data on the
    /// connection, so flows settle on it alone: by now the consumer has every byte.
    fn route_response(&mut self, response: RouteResponse) {
        if let Some(connection) = self.agents.by_id.get_mut(&response.agent_id) {
            connection.settle_request(response.request_id);
        }
        let Some(flow_id) = self.flows.id_for(&response.agent_id, response.request_id) else {
            // Expected for results of work the router already settled, such as a copy source
            // finishing after its destination or a worker canceled by a failed copy.
            log!(
                Level::Debug,
                "No pending response found for request_id={}",
                response.request_id
            );
            return;
        };
        match self.flows.get(flow_id) {
            Some(Flow::Command(_)) => self.finish_command(flow_id, response),
            Some(Flow::Output(_)) => self.finish_output_response(flow_id, response),
            Some(Flow::Upload(_)) => {
                // Terminal transitions record the bytes the data path counted so far.
                self.sync_progress();
                self.finish_upload_response(flow_id, response);
            }
            Some(Flow::Copy(_)) => {
                self.sync_progress();
                self.finish_copy_response(flow_id, response);
            }
            None => {}
        }
    }

    /// Fails the flow of a stream whose agent ignored its credit; the connection reader
    /// already stopped routing the stream.
    fn route_credit_violation(&mut self, violation: CreditViolation) {
        let Some(flow_id) = self.flows.id_for(&violation.agent_id, violation.request_id) else {
            return;
        };
        log!(
            Level::Warning,
            "Agent stream exceeded flow-control credit: agent_id={}, request_id={}",
            violation.agent_id,
            violation.request_id
        );
        self.sync_progress();
        match self.flows.get(flow_id) {
            Some(Flow::Output(_)) => self.fail_overflowing_output(flow_id),
            Some(Flow::Copy(_)) => self.fail_overflowing_copy_source(flow_id),
            Some(Flow::Command(_) | Flow::Upload(_)) | None => {}
        }
    }

    /// Routes the canceled results of commands withdrawn before they were written, including
    /// any that settling them withdrew in turn.
    fn route_local_results(&mut self) {
        while let Some(response) = self.local_results.pop() {
            self.route_response(response);
        }
    }

    /// Applies an agent's progress report to the download or local copy it belongs to.
    fn route_progress_update(&mut self, request: TransferProgressUpdateRequest) {
        let Some(flow_id) = self.flows.id_for(&request.agent_id, request.request_id) else {
            return;
        };
        match self.flows.get(flow_id) {
            // Downloads publish a discovered tar total; byte counts come from the data path.
            Some(Flow::Output(_)) => {
                self.update_download_total(flow_id, &request.agent_id, request.total_bytes)
            }
            Some(Flow::Copy(_)) => self.update_copy_progress(flow_id, request),
            Some(Flow::Command(_) | Flow::Upload(_)) | None => {}
        }
    }

    /// Periodic maintenance: prunes abandoned replies, publishes progress counted by the data
    /// path (throttled as UI refreshes), expires history and releases trailing refreshes.
    fn tick(&mut self) {
        for command in self.flows.prune_abandoned_commands() {
            self.cancel_abandoned(&command);
        }
        if self.sync_progress() {
            self.notify_transfer_refresh();
        }
        if self
            .progress
            .prune_history_if_due(UnixTimestampSeconds::new(
                jiff::Timestamp::now().as_second(),
            ))
        {
            self.notify_transfer_refresh();
        }
        self.check_pending_refresh();
        self.expire_duplicate_ids();
    }

    /// Handles one message; every handler is synchronous so the mailbox never waits on a peer.
    fn handle(&mut self, message: RouterMsg) {
        self.dispatch(message);
        self.route_local_results();
    }

    /// Runs the handler of one message.
    fn dispatch(&mut self, message: RouterMsg) {
        match message {
            RouterMsg::RegisterAgent(request) => self.register_agent(*request),
            RouterMsg::RegisterManagedAgent(request) => self.register_managed(request),
            RouterMsg::UnregisterManagedAgent(request) => self.unregister_managed(request),
            RouterMsg::ApplyManagedLifecycle(request) => self.apply_managed_lifecycle(request),
            RouterMsg::UnregisterAgent {
                agent_id,
                socket_id,
            } => self.unregister_agent(agent_id, socket_id),
            RouterMsg::RouteResponse(response) => {
                if self.accepts_agent_frame(&response.agent_id, &response.socket_id, "response") {
                    self.route_response(response)
                }
            }
            RouterMsg::RouteTransferReady(request) => {
                if self.accepts_agent_frame(&request.agent_id, &request.socket_id, "readiness") {
                    self.mark_transfer_ready(request.agent_id, request.request_id)
                }
            }
            RouterMsg::GetAgentList { reply } => {
                let _ = reply.send(self.list_agents());
            }
            RouterMsg::ResolveDevice { value, reply } => {
                let _ = reply.send(self.resolve_device(&value));
            }
            RouterMsg::ReserveName {
                agent_id,
                name,
                reply,
            } => {
                let _ = reply.send(self.reserve_name(agent_id, name));
            }
            RouterMsg::ReleaseName { agent_id } => {
                self.agents.reserved_names.remove(&agent_id);
            }
            RouterMsg::GetTransferProgress { reply } => {
                self.sync_progress();
                let _ = reply.send(self.list_transfer_progress());
            }
            RouterMsg::RegisterUiSubscriber(request) => self.register_subscriber(request),
            RouterMsg::UnregisterUiSubscriber { subscriber_id } => {
                self.unregister_subscriber(&subscriber_id)
            }
            RouterMsg::ExecuteCommandRest(request) => self.execute_command_rest(request),
            RouterMsg::CreditViolated(violation) => self.route_credit_violation(violation),
            RouterMsg::OutboundStreamFailed(failure) => self.fail_outbound_stream(failure),
            RouterMsg::ExecuteStreamCommandRest(request) => self.start_output(request),
            RouterMsg::StartUploadStreamRest(request) => self.start_upload(request),
            RouterMsg::CommitDirectUpload(request) => self.commit_edit(request),
            RouterMsg::BeginUploadPublication {
                agent_id,
                socket_id,
                request_id,
            } => {
                if self.accepts_agent_frame(&agent_id, &socket_id, "publication request") {
                    self.begin_upload_publication(agent_id, request_id)
                }
            }
            RouterMsg::CancelTransfer {
                agent_id,
                request_id,
            } => self.cancel_transfer(request_id, agent_id),
            RouterMsg::AbandonCommand {
                agent_id,
                request_id,
            } => self.abandon_command(request_id, &agent_id),
            RouterMsg::LocalVerification {
                agent_id,
                request_id,
                bytes,
                verifying,
            } => self.update_local_verification(&agent_id, request_id, bytes, verifying),
            RouterMsg::PauseTransfer { transfer_id, reply } => {
                self.pause_transfer(transfer_id, reply)
            }
            RouterMsg::CancelPublicTransfer { transfer_id, reply } => {
                let _ = reply.send(self.cancel_public_transfer(transfer_id));
            }
            RouterMsg::CancelExecution {
                agent_id,
                request_id,
                reply,
            } => {
                let _ = reply.send(self.cancel_execution(request_id, agent_id));
            }
            RouterMsg::StartCopyRest(request) => self.start_copy(request),
            RouterMsg::TransferProgressUpdate(request) => {
                if self.accepts_agent_frame(&request.agent_id, &request.socket_id, "progress") {
                    self.route_progress_update(request)
                }
            }
            RouterMsg::OpenTerminal(request) => self.open_terminal(request),
            RouterMsg::OpenAgentLogStream(request) => self.open_log_stream(request),
            RouterMsg::CloseStream { agent_id, stream } => self.close_stream(&agent_id, stream),
            RouterMsg::CheckPendingUiRefresh => self.tick(),
            RouterMsg::Shutdown => {}
        }
    }

    /// Runs the router event loop so all correlated routing state stays single-owner.
    async fn run(mut self, mut receiver: mpsc::Receiver<RouterMsg>) {
        log!(Level::Info, "Router task started");
        while let Some(message) = receiver.recv().await {
            if matches!(message, RouterMsg::Shutdown) {
                break;
            }
            self.handle(message);
        }
        self.ui.refresh_check_task.abort();
        log!(Level::Info, "Router task stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::lanes::ControlLanes;
    use crate::actors::router::messages::AgentListEntry;
    use redoor_protocol::ids::RequestId;
    use redoor_protocol::wire::command::Command;
    use redoor_protocol::wire::exec::ExecRequest;
    use redoor_protocol::wire::request;
    use redoor_protocol::wire::request::CommandOutcome;
    use redoor_protocol::wire::stream::{STREAM_CREDIT_WINDOW_FRAMES, StreamChunk};
    use tokio::sync::{mpsc, oneshot, watch};
    use tokio::time::{Duration, timeout};

    /// A full mailbox and a stopped router are different failures and must stay distinguishable.
    #[tokio::test]
    async fn send_distinguishes_full_mailbox_from_stopped_router() {
        let (sender, receiver) = mpsc::channel(1);
        let handle = RouterHandle::new(sender);
        handle
            .send(RouterMsg::CheckPendingUiRefresh)
            .expect("first message fits the mailbox");
        // Saturation must not be reported as shutdown, or callers would drop live work silently.
        assert_eq!(
            handle.send(RouterMsg::CheckPendingUiRefresh),
            Err(RouterSendError::Full)
        );
        drop(receiver);
        // Only a closed mailbox means the router can never process the message.
        assert_eq!(
            handle.send(RouterMsg::CheckPendingUiRefresh),
            Err(RouterSendError::Stopped)
        );
        // Waiting sends report the same typed shutdown error.
        assert_eq!(
            handle.send_async(RouterMsg::CheckPendingUiRefresh).await,
            Err(RouterSendError::Stopped)
        );
    }

    /// Reads the next typed control frame queued for the fake agent.
    async fn next_control(
        lane: &mut mpsc::Receiver<redoor_protocol::wire::ServerToAgent>,
    ) -> redoor_protocol::wire::ServerToAgent {
        lane.recv().await.expect("control frame queued")
    }

    /// Reads the next command the writer would send, claiming its write ticket.
    async fn next_command(
        lane: &mut mpsc::Receiver<crate::actors::lanes::QueuedCommand>,
    ) -> redoor_protocol::wire::ServerToAgent {
        let queued = lane.recv().await.expect("command queued");
        if let Some(ticket) = queued.ticket {
            assert!(ticket.mark_written());
        }
        queued.frame
    }

    /// Builds one agent frame for an inbound stream.
    fn agent_frame(request_id: RequestId, is_last: bool, data: Vec<u8>) -> StreamChunk {
        StreamChunk::data(request_id, data, is_last)
    }

    #[tokio::test]
    async fn slow_upload_send_does_not_block_unrelated_router_work() {
        let (router_ref, router_task) = spawn_router();

        let (lanes, receivers) = ControlLanes::bounded(64, 16);
        let (mut text_rx, mut priority_rx, mut binary_rx) =
            (receivers.commands, receivers.priority, receivers.bulk);
        let agent_id = redoor_core::test_support::test_agent_id("agent-1");
        // Every stream is credited, so the reader never waits on any stream's consumer.
        let streams = ConnectionStreams::new(agent_id.clone());

        let mut registration = RegisterAgentRequest::for_test(&agent_id, lanes, streams.clone());
        registration.agent_name = "agent-1".to_string();
        let socket_id = registration.socket_id.clone();
        router_ref
            .send_async(RouterMsg::RegisterAgent(Box::new(registration)))
            .await
            .expect("agent registered");

        // The welcome is always the first frame the agent reads.
        assert!(matches!(
            next_control(&mut priority_rx).await,
            redoor_protocol::wire::ServerToAgent::Welcome { .. }
        ));
        let (completion_tx, completion_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let router_for_start = router_ref.clone();
        let upload_start = tokio::spawn(async move {
            router_for_start
                .request(|reply| {
                    RouterMsg::StartUploadStreamRest(StartUploadRequest {
                        agent_id: redoor_core::test_support::test_agent_id("agent-1"),
                        command: Command::EditFile(request::EditFile {
                            path: "/tmp/file.bin".to_string(),
                        }),
                        path: "/tmp/file.bin".to_string(),
                        total_bytes: 8,
                        completion_sender: completion_tx,
                        ready_sender: ready_tx,
                        reply,
                    })
                })
                .await
        });
        let request_id = match next_command(&mut text_rx).await {
            redoor_protocol::wire::ServerToAgent::Command { id, .. } => id,
            other => panic!("unexpected control message: {other:?}"),
        };
        let upload = upload_start
            .await
            .expect("upload start task joined")
            .expect("upload start rpc succeeded")
            .expect("upload start accepted");
        // Request id is available before readiness so cancel can be armed early.
        assert_eq!(upload.request_id(), request_id);
        // The agent's first credit grant is its readiness, which the session reports.
        assert!(streams.grant_outbound(request_id, STREAM_CREDIT_WINDOW_FRAMES));
        router_ref
            .send_async(RouterMsg::RouteTransferReady(RouteTransferReadyRequest {
                agent_id: agent_id.clone(),
                socket_id: socket_id.clone(),
                request_id,
            }))
            .await
            .expect("upload readiness queued");
        match ready_rx
            .await
            .expect("upload readiness delivered")
            .expect("upload readiness accepted")
        {
            UploadStartOutcome::Ready => {}
            UploadStartOutcome::Finished(result) => {
                panic!("upload start finished before ready: {result:#?}")
            }
        };

        // Holding the first queued binary frame keeps the bounded lane full so the second
        // chunk must wait in its producer, which never involves the router.
        let upload_frame = |data| StreamChunk::data(request_id, data, false);
        upload
            .send(upload_frame(vec![1, 2, 3, 4]))
            .await
            .expect("first chunk accepted");
        let blocked_chunk = tokio::spawn({
            let upload = upload.clone();
            let frame = upload_frame(vec![5, 6, 7, 8]);
            async move { upload.send(frame).await }
        });
        tokio::task::yield_now().await;

        let list_agents = timeout(Duration::from_millis(250), async {
            router_ref
                .request(|reply| RouterMsg::GetAgentList { reply })
                .await
        })
        .await
        .expect("agent list should not wait for blocked binary send")
        .expect("agent list rpc succeeded");

        // The retained identity is the one this session registered.
        assert_eq!(
            list_agents[0]
                .identity
                .as_ref()
                .map(|identity| identity.default_directory.as_str()),
            Some("/tmp")
        );
        // Returning promptly proves the router stayed responsive while one upload chunk was
        // still waiting for binary backpressure. The list snapshot must carry the immutable
        // default so tabs need no details request.
        assert_eq!(
            list_agents,
            vec![AgentListEntry {
                id: agent_id.clone(),
                name: "agent-1".to_string(),
                default_directory: Some("/tmp".to_string()),
                managed: false,
                configuration_editable: false,
                ssh_target: None,
                status: redoor_protocol::api::agents::AgentConnectionStatus::Connected,
                connected_at: list_agents[0].connected_at,
                connection_id: list_agents[0].connection_id.clone(),
                last_seen_at: None,
                connection_issue: None,
                provisioning_status: Vec::new(),
                identity: list_agents[0].identity.clone(),
                capabilities: redoor_protocol::wire::registration::AgentCapabilities {
                    supports_native_open: true,
                    supports_trash: true,
                    supports_move_to_trash: true,
                },
                duplicate_id: None,
            }]
        );

        // A download whose consumer never reads must not stall other streams of this agent.
        let _stalled_download = router_ref
            .request(|reply| {
                RouterMsg::ExecuteStreamCommandRest(ExecuteStreamRequest {
                    agent_id: agent_id.clone(),
                    command: Command::RawDownload(request::RawDownload {
                        expected_identity: None,
                        path: "/tmp/big.bin".to_string(),
                        range_start: None,
                        range_end: None,
                    }),
                    tracking: OutputStreamTracking::Download {
                        path: "/tmp/big.bin".to_string(),
                        total_bytes: 1 << 30,
                        full_size: Some(1 << 30),
                        resume_offset: None,
                    },
                    reply,
                })
            })
            .await
            .expect("download admission rpc succeeded")
            .expect("download admitted");
        let download_id = match next_command(&mut text_rx).await {
            redoor_protocol::wire::ServerToAgent::Command { id, .. } => id,
            other => panic!("unexpected control message: {other:?}"),
        };
        let (terminal, _terminal_rx) = watch::channel(None);
        let mut exec_output = router_ref
            .request(|reply| {
                RouterMsg::ExecuteStreamCommandRest(ExecuteStreamRequest {
                    agent_id: agent_id.clone(),
                    command: Command::Exec(request::Exec {
                        request: ExecRequest {
                            argv: vec!["true".into()],
                            cwd: None,
                            env: Default::default(),
                            timeout_ms: None,
                        },
                    }),
                    tracking: OutputStreamTracking::Execution { terminal },
                    reply,
                })
            })
            .await
            .expect("exec admission rpc succeeded")
            .expect("exec admitted");
        let _ = next_command(&mut text_rx).await;
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES {
            // The connection reader hands frames to the stalled download without waiting.
            // Delivery is synchronous, so a stalled consumer can never block the reader.
            let routed = streams.deliver(agent_frame(download_id, false, vec![0; 1024]));
            assert!(routed.is_none());
        }
        // Exec output is not queued behind the stalled download.
        assert!(
            streams
                .deliver(agent_frame(exec_output.request_id(), true, Vec::new()))
                .is_none()
        );
        // The exec consumer receives its output although the download consumer never read.
        assert!(
            exec_output
                .recv()
                .await
                .is_some_and(|item| item.is_ok_and(|chunk| chunk.is_last))
        );

        let first_frame = binary_rx.recv().await.expect("first binary frame queued");
        assert_eq!(
            first_frame.data,
            vec![1, 2, 3, 4],
            "the first queued frame should be the upload chunk we intentionally used to fill the lane"
        );

        let blocked_result = timeout(Duration::from_secs(1), blocked_chunk)
            .await
            .expect("second chunk should complete after freeing binary capacity")
            .expect("second chunk task joined");
        assert!(
            blocked_result.is_ok(),
            "the queued upload chunk should still succeed once the binary lane has capacity again"
        );

        let (commit_reply, commit_response) = oneshot::channel();
        router_ref
            .send_async(RouterMsg::CommitDirectUpload(CommitDirectUploadRequest {
                agent_id: agent_id.clone(),
                request_id,
                chunk: StreamChunk::data(request_id, Vec::new(), true),
                reply: commit_reply,
            }))
            .await
            .expect("edit commit ownership queued");
        // Simulate the HTTP task disappearing immediately after the mailbox accepted ownership.
        drop(commit_response);

        let progress = router_ref
            .request(|reply| RouterMsg::GetTransferProgress { reply })
            .await
            .expect("live edit progress query succeeded");
        let live_edit = progress
            .transfers
            .iter()
            .find(|transfer| transfer.request_id == request_id.as_transfer_id())
            .expect("live edit progress retained while terminal delivery is blocked");
        // This observes the actual boundary window, not merely the completed terminal row.
        assert!(matches!(
            live_edit.state,
            redoor_protocol::api::transfers::TransferProgressState::Active
        ));
        // Terminal ownership must disable cancellation before the blocked binary send completes.
        assert!(!live_edit.cancelable);
        // Bytes accepted by the agent's lane are reported without any per-chunk router message.
        assert_eq!(live_edit.transferred_bytes, 8);

        let second_frame = binary_rx.recv().await.expect("second binary frame queued");
        // Draining the held data frame gives the router-owned terminal send lane capacity.
        assert_eq!(second_frame.data, vec![5, 6, 7, 8]);
        let terminal = timeout(Duration::from_secs(1), binary_rx.recv())
            .await
            .expect("router-owned terminal should not depend on the dropped HTTP task")
            .expect("terminal binary frame queued");
        // Empty last-frame delivery proves the router retained terminal ownership after caller drop.
        assert!(terminal.is_last && terminal.data.is_empty());

        router_ref
            .send_async(RouterMsg::RouteResponse(RouteResponse {
                agent_id: agent_id.clone(),
                socket_id: socket_id.clone(),
                request_id,
                result: CommandOutcome::Ok(serde_json::Value::Null),
            }))
            .await
            .expect("edit completion queued");
        // Final response must still reach the upload owner and release router transfer state.
        assert!(matches!(
            completion_rx.await.expect("edit completion delivered"),
            Ok(CommandOutcome::Ok(serde_json::Value::Null))
        ));
        let progress = router_ref
            .request(|reply| RouterMsg::GetTransferProgress { reply })
            .await
            .expect("completed edit progress query succeeded");
        let completed_edit = progress
            .transfers
            .iter()
            .find(|transfer| transfer.request_id == request_id.as_transfer_id())
            .expect("completed edit remains in transfer history");
        // Completion after caller loss proves no active non-cancelable router transfer was stranded.
        assert!(matches!(
            completed_edit.state,
            redoor_protocol::api::transfers::TransferProgressState::Completed
        ));

        router_ref
            .send_async(RouterMsg::Shutdown)
            .await
            .expect("router shutdown queued");
        router_task.await.expect("router task joined");
    }
}
