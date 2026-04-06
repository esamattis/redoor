mod agents;
mod cleanup;
mod error;
mod messages;
mod progress;
mod state;
mod transfers;
mod ui;

pub use error::RouterError;
pub use messages::{
    ExecuteCommandRequest, ExecuteStreamRequest, RegisterAgentRequest, RegisterUiSubscriberRequest,
    RouteResponse, RouteStreamChunkRequest, RouterMsg, SendStreamChunkRequest, StartCopyRequest,
    StartUploadRequest, TransferProgressUpdateRequest,
};
pub use state::CopyContentKind;

use crate::commands::CommandResult;
use crate::log;
use crate::logging::Level;
use crate::types::RequestId;
use state::{CopyExecution, RouterState};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

/// Bounded router mailbox size keeps actor-style ownership while making queueing semantics explicit.
const ROUTER_MAILBOX_CAPACITY: usize = 256;

/// Lightweight handle used by REST handlers, websocket tasks, and background jobs to talk to the router task.
#[derive(Clone)]
pub struct RouterHandle {
    sender: mpsc::Sender<RouterMsg>,
}

impl RouterHandle {
    /// Queues one fire-and-forget router message while preserving mailbox backpressure.
    pub async fn send(&self, message: RouterMsg) -> Result<(), mpsc::error::SendError<RouterMsg>> {
        self.sender.send(message).await
    }

    /// Tries to queue one router message without waiting, which is useful from drop handlers.
    pub fn try_send(&self, message: RouterMsg) -> Result<(), mpsc::error::TrySendError<RouterMsg>> {
        self.sender.try_send(message)
    }

    /// Queues one router message from synchronous code by spawning the send onto the current runtime when possible.
    pub fn send_detached(&self, message: RouterMsg) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let sender = self.sender.clone();
            handle.spawn(async move {
                let _ = sender.send(message).await;
            });
            return;
        }

        let _ = self.sender.try_send(message);
    }

    /// Sends one request-reply router message and waits for the typed reply with timeout protection.
    pub async fn call<T, F>(
        &self,
        build_message: F,
        timeout: Duration,
    ) -> Result<T, RouterCallError>
    where
        F: FnOnce(oneshot::Sender<T>) -> RouterMsg,
    {
        let (reply_sender, reply_receiver) = oneshot::channel();
        self.sender
            .send(build_message(reply_sender))
            .await
            .map_err(|_| RouterCallError::RouterStopped)?;

        match tokio::time::timeout(timeout, reply_receiver).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(RouterCallError::ReplyDropped),
            Err(_) => Err(RouterCallError::Timeout),
        }
    }
}

/// Structured request-reply failure keeps router call sites readable after removing the framework RPC helper.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum RouterCallError {
    /// The router task stopped before the message could be queued or replied to.
    #[error("router stopped")]
    RouterStopped,
    /// The router did not answer before the caller's deadline.
    #[error("router call timed out")]
    Timeout,
    /// The router dropped the reply channel without sending a value.
    #[error("router reply dropped")]
    ReplyDropped,
}

/// Returned by [`start`] so callers can keep the shared handle and optionally await router shutdown in tests.
pub struct RouterRuntime {
    /// Shared handle used to send messages into the router task.
    pub handle: RouterHandle,
    /// Join handle for the router event loop.
    pub task: tokio::task::JoinHandle<()>,
}

/// Starts the singleton router task that owns all router state.
pub fn start() -> RouterRuntime {
    let (sender, receiver) = mpsc::channel(ROUTER_MAILBOX_CAPACITY);
    let handle = RouterHandle { sender };
    let task = tokio::spawn(run_router(handle.clone(), receiver));
    RouterRuntime { handle, task }
}

/// Checks whether an inbound stream chunk belongs to a remote copy flow.
fn is_remote_copy_stream(state: &RouterState, request_id: RequestId) -> bool {
    state
        .copies
        .public_id_for_internal(request_id)
        .and_then(|public_request_id| state.copies.by_public_id.get(&public_request_id))
        .map(|copy_request| matches!(copy_request.execution, CopyExecution::RemoteStream { .. }))
        .unwrap_or(false)
}

/// Routes a final agent command response to one-shot, copy, or upload handlers.
fn route_response(state: &mut RouterState, response: RouteResponse) {
    if let Some((reply, stored_agent_id)) = state
        .pending_rest
        .by_request_id
        .remove(&response.request_id)
    {
        let result_to_send = match (&response.result, state.agents.by_id.get(&stored_agent_id)) {
            (CommandResult::GetAgentDetails(details), Some(agent_info)) => {
                // These fields come from router-owned registration data rather than the agent command response.
                let mut details = details.clone();
                details.id = stored_agent_id.clone();
                details.name = agent_info.agent_name.clone();
                details.connected_at = agent_info.connected_at;
                CommandResult::GetAgentDetails(details)
            }
            _ => response.result.clone(),
        };

        let _ = reply.send(result_to_send);
        return;
    }

    if transfers::copy::finish_transfer(
        state,
        response.agent_id.clone(),
        response.request_id,
        response.result.clone(),
    ) {
        return;
    }

    transfers::upload::finish_transfer(
        state,
        response.agent_id,
        response.request_id,
        response.result,
    );
}

/// Runs the router event loop so one task remains the single owner of router state.
async fn run_router(handle: RouterHandle, mut receiver: mpsc::Receiver<RouterMsg>) {
    log!(Level::Info, "Router task started");
    let mut state = RouterState::new(ui::start_refresh_check_task(handle.clone()));

    while let Some(message) = receiver.recv().await {
        handle_message(&handle, &mut state, message).await;
    }

    state.ui.refresh_check_task.abort();
    log!(Level::Info, "Router task stopped");
}

/// Dispatches one router message to the focused domain module that owns it.
async fn handle_message(handle: &RouterHandle, state: &mut RouterState, message: RouterMsg) {
    match message {
        RouterMsg::RegisterAgent(request) => {
            agents::register(state, request);
        }
        RouterMsg::UnregisterAgent { agent_id } => {
            log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
            state.agents.by_id.remove(&agent_id);
            ui::notify_refresh(state);
            cleanup::cleanup_agent_requests(state, &agent_id).await;
        }
        RouterMsg::RouteResponse(response) => {
            route_response(state, response);
        }
        RouterMsg::GetAgentList { reply } => {
            let _ = reply.send(agents::list_agents(state));
        }
        RouterMsg::GetTransferProgress { reply } => {
            let _ = reply.send(progress::list_transfer_progress(state));
        }
        RouterMsg::RegisterUiSubscriber(request) => {
            ui::register_subscriber(state, request);
        }
        RouterMsg::UnregisterUiSubscriber { subscriber_id } => {
            ui::unregister_subscriber(state, &subscriber_id);
        }
        RouterMsg::ExecuteCommandRest(request) => {
            agents::execute_command_rest(state, request);
        }
        RouterMsg::RouteStreamChunk(request) => {
            if is_remote_copy_stream(state, request.chunk.request_id) {
                transfers::copy::route_chunk(state, handle, request);
            } else {
                transfers::download::route_chunk(state, handle, request);
            }
        }
        RouterMsg::FinishRoutedDownloadChunk(route) => {
            transfers::download::finish_routed_chunk(state, &route);
            let _ = route.reply.send(());
        }
        RouterMsg::FinishRoutedUploadChunk(route) => {
            let result = transfers::upload::finish_routed_chunk(state, &route);
            let _ = route.reply.send(result);
        }
        RouterMsg::FinishRoutedCopyChunk(route) => {
            transfers::copy::finish_routed_chunk(state, &route);
            let _ = route.reply.send(());
        }
        RouterMsg::ExecuteStreamCommandRest(request) => {
            transfers::download::start(state, request);
        }
        RouterMsg::StartUploadStreamRest(request) => {
            transfers::upload::start(state, request);
        }
        RouterMsg::SendStreamChunkToAgent(request) => {
            transfers::upload::route_chunk(state, handle, request);
        }
        RouterMsg::CancelTransfer {
            agent_id,
            request_id,
        } => {
            cleanup::cancel_transfer(state, request_id, agent_id);
        }
        RouterMsg::StartCopyRest(request) => {
            transfers::copy::start(state, request);
        }
        RouterMsg::TransferProgressUpdate(request) => {
            transfers::copy::update_progress(state, request);
        }
        RouterMsg::CheckPendingUiRefresh => {
            ui::check_pending_refresh(state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Command;
    use crate::streaming::{StreamChunk, StreamPayloadKind};
    use crate::types::AgentId;
    use axum::extract::ws::Message as WsMessage;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::{Duration, timeout};

    /// Verifies one blocked binary forward does not stop unrelated router requests from completing.
    #[tokio::test]
    async fn slow_upload_send_does_not_block_unrelated_router_work() {
        crate::logging::init(None);

        let runtime = start();
        let router_ref = runtime.handle.clone();

        let (text_tx, _text_rx) = mpsc::unbounded_channel::<WsMessage>();
        let (binary_tx, mut binary_rx) = mpsc::channel::<WsMessage>(1);

        router_ref
            .send(RouterMsg::RegisterAgent(RegisterAgentRequest {
                agent_id: AgentId::from("agent-1"),
                agent_name: "agent-1".to_string(),
                socket_id: "socket-1".to_string(),
                outgoing_text: text_tx,
                outgoing_binary: binary_tx,
                os: "macos".to_string(),
                arch: "arm64".to_string(),
                hostname: "host".to_string(),
                username: "user".to_string(),
            }))
            .await
            .expect("agent registered");

        let (completion_tx, _completion_rx) = oneshot::channel();
        let request_id = router_ref
            .call(
                |reply| {
                    RouterMsg::StartUploadStreamRest(StartUploadRequest {
                        agent_id: AgentId::from("agent-1"),
                        command: Command::RawUpload {
                            path: "/tmp/file.bin".to_string(),
                        },
                        path: "/tmp/file.bin".to_string(),
                        total_bytes: 32,
                        completion_sender: completion_tx,
                        reply,
                    })
                },
                Duration::from_millis(1_000),
            )
            .await
            .expect("upload start rpc succeeded")
            .expect("upload start accepted");

        // Holding the first queued binary frame keeps the bounded lane full so the
        // second forwarded chunk must wait in the background task instead of the router.
        let first_chunk = StreamChunk {
            request_id,
            chunk_index: crate::types::ChunkIndex::new(0),
            is_last: false,
            is_error: false,
            payload_kind: StreamPayloadKind::RawFile,
            data: vec![1, 2, 3, 4],
        };
        router_ref
            .call(
                |reply| {
                    RouterMsg::SendStreamChunkToAgent(SendStreamChunkRequest {
                        agent_id: AgentId::from("agent-1"),
                        request_id,
                        chunk: first_chunk,
                        reply,
                    })
                },
                Duration::from_millis(1_000),
            )
            .await
            .expect("first chunk rpc succeeded")
            .expect("first chunk accepted");

        let second_chunk = StreamChunk {
            request_id,
            chunk_index: crate::types::ChunkIndex::new(1),
            is_last: false,
            is_error: false,
            payload_kind: StreamPayloadKind::RawFile,
            data: vec![5, 6, 7, 8],
        };

        let router_ref_for_chunk = router_ref.clone();
        let blocked_chunk = tokio::spawn(async move {
            router_ref_for_chunk
                .call(
                    |reply| {
                        RouterMsg::SendStreamChunkToAgent(SendStreamChunkRequest {
                            agent_id: AgentId::from("agent-1"),
                            request_id,
                            chunk: second_chunk,
                            reply,
                        })
                    },
                    Duration::from_millis(5_000),
                )
                .await
        });

        tokio::task::yield_now().await;

        let router_ref_for_list = router_ref.clone();
        let list_agents = timeout(Duration::from_millis(250), async move {
            router_ref_for_list
                .call(
                    |reply| RouterMsg::GetAgentList { reply },
                    Duration::from_millis(1_000),
                )
                .await
        })
        .await
        .expect("agent list should not wait for blocked binary send")
        .expect("agent list rpc succeeded");

        // Returning promptly here proves the router event loop stayed responsive
        // even though one upload chunk was still waiting for binary backpressure.
        assert_eq!(
            list_agents.get(&AgentId::from("agent-1")),
            Some(&"agent-1".to_string())
        );

        let first_frame = binary_rx.recv().await.expect("first binary frame queued");
        assert!(
            matches!(first_frame, WsMessage::Binary(_)),
            "the first queued frame should be the upload chunk we intentionally used to fill the lane"
        );

        let blocked_result = timeout(Duration::from_secs(1), blocked_chunk)
            .await
            .expect("second chunk should complete after freeing binary capacity")
            .expect("second chunk task joined")
            .expect("second chunk rpc succeeded");
        assert!(
            blocked_result.is_ok(),
            "the queued upload chunk should still succeed once the binary lane has capacity again"
        );

        drop(router_ref);
        runtime.task.abort();
    }
}
