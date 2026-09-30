//! Bounded agent output transport shared by filesystem and process resources.

use super::{
    RouterError, RouterHandle, cleanup,
    messages::{
        ExecuteStreamRequest, FinishOutputChunkRoute, OutputStreamTracking, RouteResponse,
        RouteStreamChunkRequest, RouterMsg,
    },
    progress,
    state::{DirectOutputStream, OutputOwner, RouterState},
    transfers::download,
};
use crate::{
    commands::{Command, CommandResult},
    exec_protocol::ExecEvent,
    streaming::{StreamChunk, StreamPayloadKind},
    types::{ChunkIndex, Message},
};

impl DirectOutputStream {
    /// Retains one priority enqueue per live REST stream, releasing payload backpressure only after admission.
    pub(crate) fn request_cancel(
        &mut self,
        connection: &super::state::AgentConnection,
        request_id: crate::types::RequestId,
    ) -> Result<(), RouterError> {
        if self.canceled_by_rest {
            return Ok(());
        }
        if matches!(self.owner, OutputOwner::CopySource { .. }) {
            return Err(RouterError::ControlQueueFull {
                agent_id: self.agent_id.to_string(),
            });
        }
        let json = serde_json::to_string(&Message::CancelTransfer { request_id })
            .expect("Cancellation contains only a request id");
        let frame = axum::extract::ws::Message::Text(json.into());
        match connection.outgoing_priority.try_send(frame) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                return Err(RouterError::ControlQueueFull {
                    agent_id: self.agent_id.to_string(),
                });
            }
            Err(tokio::sync::mpsc::error::TrySendError::Full(frame)) => {
                let priority = connection.outgoing_priority.clone();
                self.cancellation_delivery = Some(tokio::spawn(async move {
                    // Closure after admission is settled by connection teardown; saturation retains intent.
                    let _ = priority.send(frame).await;
                }));
            }
        }
        self.canceled_by_rest = true;
        self.forwarding_stop.send_replace(true);
        if let Some(sink) = self.owner.sink_mut() {
            sink.take();
        }
        Ok(())
    }
}

/// Validates command ownership before admission so process output cannot acquire file history.
pub(crate) fn start(state: &mut RouterState, request: ExecuteStreamRequest) {
    let valid = matches!(
        (&request.command, &request.tracking),
        (Command::Exec { .. }, OutputStreamTracking::Execution { .. })
            | (
                Command::RawDownload { .. } | Command::TarDownload { .. },
                OutputStreamTracking::Download { .. }
            )
    );
    if !valid {
        let _ = request.reply.send(Err(RouterError::UnexpectedResponseType {
            operation: "registering output command ownership",
        }));
        return;
    }
    let id = state.next_id();
    let Some(connection) = state.agents.by_id.get(&request.agent_id).cloned() else {
        let _ = request.reply.send(Err(RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        }));
        return;
    };
    if let Err(error) = connection.transfer_connection() {
        let _ = request.reply.send(Err(error));
        return;
    }
    if !connection.send_message(Message::Command {
        agent_id: request.agent_id.clone(),
        request_id: id,
        command: request.command,
    }) {
        let _ = request.reply.send(Err(RouterError::ControlQueueFull {
            agent_id: request.agent_id.to_string(),
        }));
        return;
    }
    let owner = match request.tracking {
        OutputStreamTracking::Download {
            path,
            total_bytes,
            full_size,
            resume_offset,
        } => download::register(
            state,
            progress::DownloadStartContext {
                request_id: id,
                agent_id: request.agent_id.clone(),
                path,
                total_bytes,
                full_size,
                resume_offset,
            },
            request.chunk_sender,
        ),
        OutputStreamTracking::Execution { terminal } => OutputOwner::Execution {
            sink: Some(request.chunk_sender),
            terminal,
        },
    };
    state.streams.outputs.insert(
        id,
        DirectOutputStream {
            owner,
            agent_id: request.agent_id.clone(),
            rest_cancel_sender: request.rest_cancel_sender,
            canceled_by_rest: false,
            cancellation_delivery: None,
            forwarding_stop: tokio::sync::watch::channel(false).0,
        },
    );
    if request.reply.send(Ok(id)).is_err() {
        cleanup::cancel_transfer(state, id, request.agent_id);
    }
}

/// Independent control responses carry the actual terminal event when the payload lane is blocked.
pub(crate) fn finish_response(state: &mut RouterState, response: &RouteResponse) -> bool {
    let Some(stream) = state
        .streams
        .outputs
        .get_mut(&response.request_id)
        .filter(|stream| stream.agent_id == response.agent_id)
    else {
        return false;
    };
    if let OutputOwner::Execution { terminal, .. } = &stream.owner {
        let event = match &response.result {
            CommandResult::Exec { event } => event.clone(),
            CommandResult::Error { message, .. } => ExecEvent::Error {
                message: message.clone(),
            },
            _ => return false,
        };
        terminal.send_replace(Some(event));
        state.streams.outputs.remove(&response.request_id);
        return true;
    }
    let CommandResult::Error { message, .. } = &response.result else {
        return false;
    };
    if let Some(id) = stream.owner.download_id() {
        download::reject(state, id, message.clone());
    }
    let mut stream = state.streams.outputs.remove(&response.request_id).unwrap();
    if let Some(sink) = stream.owner.sink_mut().and_then(Option::take) {
        let chunk = StreamChunk {
            request_id: response.request_id,
            chunk_index: ChunkIndex::new(0),
            is_last: true,
            is_error: true,
            payload_kind: StreamPayloadKind::RawFile,
            data: message.as_bytes().to_vec(),
        };
        tokio::spawn(async move {
            let _ = sink.send(chunk).await;
        });
    }
    true
}

/// Keeps downstream waits outside the actor, while canceled terminal events bypass saturated sinks.
pub(crate) fn route_chunk(
    state: &mut RouterState,
    myself: &RouterHandle,
    request: RouteStreamChunkRequest,
) {
    let id = request.chunk.request_id;
    let Some(stream) = state
        .streams
        .outputs
        .get_mut(&id)
        .filter(|stream| stream.agent_id == request.agent_id)
    else {
        let _ = request.reply.send(());
        return;
    };
    if stream.canceled_by_rest {
        if request.chunk.is_last || request.chunk.is_error {
            if let OutputOwner::Execution { terminal, .. } = &stream.owner {
                let event = serde_json::from_slice::<ExecEvent>(&request.chunk.data)
                    .unwrap_or_else(|error| ExecEvent::Error {
                        message: format!("Invalid execution acknowledgement: {error}"),
                    });
                terminal.send_replace(Some(event));
            }
            if let Some(id) = stream.owner.download_id() {
                download::acknowledge_cancel(state, id);
            }
            state.streams.outputs.remove(&id);
        }
        let _ = request.reply.send(());
        return;
    }
    let Some(sink) = stream.owner.sink_mut().and_then(|sink| sink.clone()) else {
        let _ = request.reply.send(());
        return;
    };
    let mut stop = stream.forwarding_stop.subscribe();
    let chunk = request.chunk;
    let execution_terminal =
        if chunk.is_last && matches!(stream.owner, OutputOwner::Execution { .. }) {
            Some(
                serde_json::from_slice::<ExecEvent>(&chunk.data).unwrap_or_else(|error| {
                    ExecEvent::Error {
                        message: format!("Invalid execution acknowledgement: {error}"),
                    }
                }),
            )
        } else {
            None
        };
    let mut route = FinishOutputChunkRoute {
        execution_terminal,
        agent_id: request.agent_id,
        request_id: id,
        chunk_index: chunk.chunk_index,
        is_last: chunk.is_last,
        bytes: chunk.data.len() as u64,
        error_message: chunk
            .is_error
            .then(|| String::from_utf8_lossy(&chunk.data).to_string()),
        send_succeeded: false,
        reply: request.reply,
    };
    let myself = myself.clone();
    tokio::spawn(async move {
        route.send_succeeded = tokio::select! {
            biased;
            _ = stop.changed() => false,
            result = sink.send(chunk) => result.is_ok(),
        };
        // A saturated mailbox must not strand the websocket reader's per-chunk barrier.
        if let Err(error) = myself
            .send_async(RouterMsg::FinishRoutedOutputChunk(route))
            .await
            && let RouterMsg::FinishRoutedOutputChunk(route) = error.0
        {
            let _ = route.reply.send(());
        }
    });
}

/// Settles accepted chunks without letting late forwarding completions overwrite cancellation.
pub(crate) fn finish_routed_chunk(state: &mut RouterState, route: &FinishOutputChunkRoute) {
    let Some(stream) = state
        .streams
        .outputs
        .get(&route.request_id)
        .filter(|stream| stream.agent_id == route.agent_id)
    else {
        return;
    };
    if stream.canceled_by_rest {
        if let Some(event) = &route.execution_terminal {
            if let OutputOwner::Execution { terminal, .. } = &stream.owner {
                terminal.send_replace(Some(event.clone()));
            }
            state.streams.outputs.remove(&route.request_id);
        } else if route.is_last || route.error_message.is_some() {
            if let Some(id) = stream.owner.download_id() {
                download::acknowledge_cancel(state, id);
            }
            state.streams.outputs.remove(&route.request_id);
        }
        return;
    }
    if !route.send_succeeded {
        if let Some(event) = &route.execution_terminal {
            if let OutputOwner::Execution { terminal, .. } = &stream.owner {
                terminal.send_replace(Some(event.clone()));
            }
            state.streams.outputs.remove(&route.request_id);
            return;
        }
        cleanup::cancel_transfer(state, route.request_id, route.agent_id.clone());
        return;
    }
    if let Some(id) = stream.owner.download_id() {
        download::finish_chunk(state, id, route);
    }
    if route.is_last || route.error_message.is_some() {
        state.streams.outputs.remove(&route.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        log_registry::LogRegistry,
        terminal_registry::TerminalRegistry,
        types::{AgentId, RequestId, SocketId},
    };
    use futures_util::FutureExt;
    use tokio::sync::{mpsc, oneshot, watch};

    /// Keeps lane receivers alive so tests can exercise real admission pressure and acknowledgements.
    struct Fixture {
        state: RouterState,
        commands: mpsc::Receiver<axum::extract::ws::Message>,
        priority: mpsc::Receiver<axum::extract::ws::Message>,
        output: mpsc::Receiver<StreamChunk>,
        terminal: watch::Receiver<Option<ExecEvent>>,
        id: RequestId,
        agent: AgentId,
    }

    impl Fixture {
        /// A single-slot control lane makes saturation deterministic without timers or a network peer.
        async fn new() -> Self {
            crate::logging::init(None).await.unwrap();
            let mut state = RouterState::new(
                tokio::spawn(std::future::pending()),
                TerminalRegistry::new(),
                LogRegistry::new(),
            );
            let agent = AgentId::from("output-test");
            let (commands, command_receiver) = mpsc::channel(1);
            let (priority, priority_receiver) = mpsc::channel(1);
            let connection = super::super::state::AgentConnection::from_register_request(
                super::super::messages::RegisterAgentRequest {
                    agent_id: agent.clone(),
                    agent_name: "test".into(),
                    socket_id: SocketId::new(),
                    outgoing_commands: commands,
                    outgoing_priority: priority,
                    os: "linux".into(),
                    arch: "test".into(),
                    hostname: "test".into(),
                    username: "test".into(),
                    default_directory: "/tmp".into(),
                    binary: crate::commands::current_binary_identity(),
                    supports_self_exec: false,
                    supports_native_open: false,
                    supports_trash: false,
                    supports_move_to_trash: false,
                    uid: None,
                    is_root: false,
                    watchdog: None,
                    watchdog_attempt_generation: None,
                },
            );
            state.agents.by_id.insert(agent.clone(), connection);
            let (sink, output) = mpsc::channel(1);
            let (terminal_sender, terminal) = watch::channel(None);
            let id = state.next_id();
            state.streams.outputs.insert(
                id,
                DirectOutputStream {
                    agent_id: agent.clone(),
                    owner: OutputOwner::Execution {
                        sink: Some(sink),
                        terminal: terminal_sender,
                    },
                    rest_cancel_sender: None,
                    canceled_by_rest: false,
                    cancellation_delivery: None,
                    forwarding_stop: watch::channel(false).0,
                },
            );
            Self {
                state,
                commands: command_receiver,
                priority: priority_receiver,
                output,
                terminal,
                id,
                agent,
            }
        }

        /// Polls the exact resource-specific cancellation path used by DELETE.
        fn cancel(&mut self) -> Result<bool, RouterError> {
            cleanup::cancel_execution(&mut self.state, self.id, self.agent.clone())
        }

        /// Terminal frames must represent real agent cleanup rather than a local cancellation request.
        fn terminal_chunk(&self, event: ExecEvent) -> RouteStreamChunkRequest {
            RouteStreamChunkRequest {
                agent_id: self.agent.clone(),
                chunk: StreamChunk {
                    request_id: self.id,
                    chunk_index: ChunkIndex::new(0),
                    is_last: true,
                    is_error: false,
                    payload_kind: StreamPayloadKind::RawFile,
                    data: serde_json::to_vec(&event).unwrap(),
                },
                reply: oneshot::channel().0,
            }
        }
    }

    /// Both full lanes must retain one cancellation intent, with no fabricated termination event.
    #[tokio::test]
    async fn saturated_lanes_retain_cancel_without_acknowledging_termination() {
        let mut fixture = Fixture::new().await;
        let connection = &fixture.state.agents.by_id[&fixture.agent];
        connection
            .outgoing_commands
            .try_send(axum::extract::ws::Message::Text("occupied".into()))
            .unwrap();
        connection
            .outgoing_priority
            .try_send(axum::extract::ws::Message::Text("occupied".into()))
            .unwrap();
        // Saturation accepts retained intent; repeated DELETE must not enqueue another task.
        assert_eq!(fixture.cancel(), Ok(true));
        assert_eq!(fixture.cancel(), Ok(true));
        assert!(
            fixture.state.streams.outputs[&fixture.id]
                .cancellation_delivery
                .is_some()
        );
        assert!(fixture.terminal.borrow().is_none());
        assert!(!fixture.terminal.has_changed().unwrap());
        // Releasing priority capacity delivers cancellation even while ordinary commands remain full.
        fixture.priority.recv().await.unwrap();
        let frame = fixture.priority.recv().await.unwrap();
        let axum::extract::ws::Message::Text(json) = frame else {
            panic!("Expected cancel frame");
        };
        assert!(
            matches!(serde_json::from_str::<Message>(&json).unwrap(), Message::CancelTransfer { request_id } if request_id == fixture.id)
        );
        assert!(fixture.priority.try_recv().is_err());
        assert!(fixture.commands.try_recv().is_ok());
        // The agent's terminal frame confirms cleanup before a canceled NDJSON event and ownership removal.
        let (sender, _receiver) = mpsc::channel(1);
        let request = fixture.terminal_chunk(ExecEvent::Canceled);
        route_chunk(&mut fixture.state, &RouterHandle::new(sender), request);
        assert!(matches!(
            &*fixture.terminal.borrow(),
            Some(ExecEvent::Canceled)
        ));
        assert!(!fixture.state.streams.outputs.contains_key(&fixture.id));
        assert!(fixture.state.progress.entries.is_empty());
    }

    /// Failed admission must leave the sink and flags untouched so a caller can retry.
    #[tokio::test]
    async fn closed_priority_lane_rejects_without_losing_retry() {
        let mut fixture = Fixture::new().await;
        fixture.priority.close();
        // Failure cannot close output or pretend the process has stopped.
        assert!(fixture.cancel().is_err());
        let stream = &fixture.state.streams.outputs[&fixture.id];
        assert!(!stream.canceled_by_rest);
        assert!(matches!(
            &stream.owner,
            OutputOwner::Execution { sink: Some(_), .. }
        ));
        assert!(fixture.output.recv().now_or_never().is_none());
        assert!(fixture.terminal.borrow().is_none());
        let (priority, mut receiver) = mpsc::channel(1);
        fixture
            .state
            .agents
            .by_id
            .get_mut(&fixture.agent)
            .unwrap()
            .outgoing_priority = priority;
        // The same execution remains cancelable once delivery is available again.
        assert_eq!(fixture.cancel(), Ok(true));
        assert!(receiver.recv().await.is_some());
        assert!(fixture.terminal.borrow().is_none());
    }

    /// Cancellation must release the transfer-reader barrier even when REST and router mailboxes are full.
    #[tokio::test]
    async fn cancel_releases_blocked_output_and_retains_forwarding_completion() {
        let mut fixture = Fixture::new().await;
        let mut request = fixture.terminal_chunk(ExecEvent::Stdout { data: vec![1] });
        request.chunk.is_last = false;
        if let OutputOwner::Execution {
            sink: Some(sink), ..
        } = &fixture.state.streams.outputs[&fixture.id].owner
        {
            sink.try_send(request.chunk.clone()).unwrap();
        }
        let (reply, reply_receiver) = oneshot::channel();
        request.reply = reply;
        let (sender, mut receiver) = mpsc::channel(1);
        sender.try_send(RouterMsg::PruneClosedPendingRest).unwrap();
        route_chunk(&mut fixture.state, &RouterHandle::new(sender), request);
        // Releasing a blocked send must not require the HTTP consumer to read another byte.
        assert_eq!(fixture.cancel(), Ok(true));
        receiver.recv().await.unwrap();
        let message = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let RouterMsg::FinishRoutedOutputChunk(route) = message else {
            panic!("Expected retained forwarding completion");
        };
        // The router completion survives mailbox saturation and acknowledges the websocket reader.
        assert!(!route.send_succeeded);
        finish_routed_chunk(&mut fixture.state, &route);
        route.reply.send(()).unwrap();
        reply_receiver.await.unwrap();
        assert!(fixture.terminal.borrow().is_none());
        assert!(fixture.state.streams.outputs.contains_key(&fixture.id));
    }

    /// Failed direct-download admission must not strand history or close the caller's consumer.
    #[tokio::test]
    async fn download_cancel_rejection_preserves_active_history_and_http_body() {
        let mut fixture = Fixture::new().await;
        let (sink, _output) = mpsc::channel(1);
        let owner = download::register(
            &mut fixture.state,
            progress::DownloadStartContext {
                request_id: fixture.id,
                agent_id: fixture.agent.clone(),
                path: "/download".into(),
                total_bytes: 10,
                full_size: None,
                resume_offset: None,
            },
            sink,
        );
        let progress_id = owner.download_id().unwrap();
        let (cancel, rest_cancel) = watch::channel(false);
        let stream = fixture.state.streams.outputs.get_mut(&fixture.id).unwrap();
        stream.owner = owner;
        stream.rest_cancel_sender = Some(cancel);
        fixture.priority.close();
        // Closed control must reject before creating an unretryable Canceling row or stopping REST.
        assert!(matches!(
            cleanup::cancel_public_transfer(&mut fixture.state, progress_id),
            Err(super::super::messages::CancelPublicTransferError::Delivery(
                _
            ))
        ));
        assert!(matches!(
            fixture.state.progress.entries[&progress_id].state,
            crate::commands::TransferProgressState::Active
        ));
        assert!(!*rest_cancel.borrow());
        assert!(!fixture.state.streams.outputs[&fixture.id].canceled_by_rest);
        assert!(matches!(
            fixture.state.streams.outputs[&fixture.id].owner,
            OutputOwner::Download { sink: Some(_), .. }
        ));
        let (priority, mut receiver) = mpsc::channel(1);
        fixture
            .state
            .agents
            .by_id
            .get_mut(&fixture.agent)
            .unwrap()
            .outgoing_priority = priority;
        // A retry must admit remote cleanup and only then wake REST and publish Canceling.
        assert!(cleanup::cancel_public_transfer(&mut fixture.state, progress_id).is_ok());
        assert!(receiver.recv().await.is_some());
        assert!(*rest_cancel.borrow());
        assert!(matches!(
            fixture.state.progress.entries[&progress_id].state,
            crate::commands::TransferProgressState::Canceling
        ));
    }

    /// Bad tracking metadata must be rejected before either remote work or file history is admitted.
    #[tokio::test]
    async fn command_tracking_mismatch_is_rejected_before_admission() {
        let mut fixture = Fixture::new().await;
        let (reply, receiver) = oneshot::channel();
        let (sink, _output) = mpsc::channel(1);
        start(
            &mut fixture.state,
            ExecuteStreamRequest {
                agent_id: fixture.agent.clone(),
                command: Command::Exec {
                    request: crate::exec_protocol::ExecRequest {
                        argv: vec!["true".into()],
                        cwd: None,
                        env: Default::default(),
                        timeout_ms: None,
                    },
                },
                tracking: OutputStreamTracking::Download {
                    path: "/fake".into(),
                    total_bytes: 0,
                    full_size: None,
                    resume_offset: None,
                },
                reply,
                chunk_sender: sink,
                rest_cancel_sender: None,
            },
        );
        // Mismatched resource metadata cannot fabricate progress or send a command.
        assert!(matches!(
            receiver.await.unwrap(),
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        assert!(fixture.commands.try_recv().is_err());
        assert!(fixture.state.progress.entries.is_empty());
    }

    /// Independent acknowledgements preserve normal-completion races instead of inventing cancellation.
    #[tokio::test]
    async fn command_fallback_preserves_actual_terminal_outcome() {
        for event in [
            ExecEvent::Canceled,
            ExecEvent::Exit {
                code: Some(0),
                signal: None,
            },
        ] {
            let mut fixture = Fixture::new().await;
            assert_eq!(fixture.cancel(), Ok(true)); // Admission alone is deliberately not termination.
            assert!(fixture.terminal.borrow().is_none());
            let response = RouteResponse {
                agent_id: fixture.agent.clone(),
                request_id: fixture.id,
                result: CommandResult::Exec {
                    event: event.clone(),
                },
            };
            // Control fallback is authoritative even if no terminal payload could be forwarded.
            assert!(finish_response(&mut fixture.state, &response));
            assert_eq!(
                serde_json::to_value(fixture.terminal.borrow().clone()).unwrap(),
                serde_json::to_value(Some(event)).unwrap()
            );
            assert!(!fixture.state.streams.outputs.contains_key(&fixture.id));
        }
    }

    /// A terminal frame already waiting for downstream capacity must still settle a cancellation race.
    #[tokio::test]
    async fn terminal_forwarding_race_retains_normal_exit() {
        let mut fixture = Fixture::new().await;
        assert_eq!(fixture.cancel(), Ok(true)); // Simulate DELETE winning before the forwarding completion message.
        let event = ExecEvent::Exit {
            code: Some(7),
            signal: None,
        };
        let route = FinishOutputChunkRoute {
            execution_terminal: Some(event.clone()),
            agent_id: fixture.agent.clone(),
            request_id: fixture.id,
            chunk_index: ChunkIndex::new(0),
            is_last: true,
            bytes: 0,
            error_message: None,
            send_succeeded: false,
            reply: oneshot::channel().0,
        };
        finish_routed_chunk(&mut fixture.state, &route);
        // Already-acknowledged exit wins over a late cancellation request, even if local forwarding stopped.
        assert!(matches!(
            &*fixture.terminal.borrow(),
            Some(ExecEvent::Exit { code: Some(7), .. })
        ));
        assert!(!fixture.state.streams.outputs.contains_key(&fixture.id));
    }

    /// File history and copy destinations belong to different resources despite sharing request ids.
    #[tokio::test]
    async fn download_and_copy_ownership_cannot_be_canceled_as_execution() {
        let mut fixture = Fixture::new().await;
        let resumed_id = crate::types::TransferId::new(99);
        let (sink, _receiver) = mpsc::channel(1);
        fixture
            .state
            .streams
            .outputs
            .get_mut(&fixture.id)
            .unwrap()
            .owner = OutputOwner::Download {
            progress_id: resumed_id,
            sink: Some(sink),
        };
        // Resumed downloads own their previous history id and cannot enter execution cancellation.
        assert_eq!(
            fixture.state.streams.outputs[&fixture.id]
                .owner
                .download_id(),
            Some(resumed_id)
        );
        assert_eq!(fixture.cancel(), Ok(false));
        fixture
            .state
            .streams
            .outputs
            .get_mut(&fixture.id)
            .unwrap()
            .owner = OutputOwner::CopySource {
            copy_id: resumed_id,
        };
        // A copy source has neither REST output nor independent download history and must settle both copy sides.
        assert!(
            fixture
                .state
                .streams
                .outputs
                .get_mut(&fixture.id)
                .unwrap()
                .owner
                .sink_mut()
                .is_none()
        );
        assert_eq!(fixture.cancel(), Ok(false));
        cleanup::cancel_transfer(&mut fixture.state, fixture.id, fixture.agent.clone());
        assert!(!fixture.state.streams.outputs[&fixture.id].canceled_by_rest);
        assert!(fixture.priority.try_recv().is_err());
    }
}
