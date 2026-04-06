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
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, error::Elapsed};

/// The router mailbox stays explicit so call paths can choose bounded or unbounded behavior.
const ROUTER_MAILBOX_CAPACITY: usize = 1024;

/// Shared sender used to interact with the single-owner router task.
#[derive(Clone, Debug)]
pub struct RouterHandle {
    sender: mpsc::Sender<RouterMsg>,
}

impl RouterHandle {
    /// Creates a new handle from the router mailbox sender.
    fn new(sender: mpsc::Sender<RouterMsg>) -> Self {
        Self { sender }
    }

    /// Queues one fire-and-forget router message.
    pub fn send(&self, message: RouterMsg) -> Result<(), mpsc::error::SendError<RouterMsg>> {
        self.sender.try_send(message).map_err(|error| match error {
            mpsc::error::TrySendError::Closed(message)
            | mpsc::error::TrySendError::Full(message) => mpsc::error::SendError(message),
        })
    }

    /// Queues one router message, waiting for mailbox capacity when necessary.
    pub async fn send_async(
        &self,
        message: RouterMsg,
    ) -> Result<(), mpsc::error::SendError<RouterMsg>> {
        self.sender.send(message).await
    }

    /// Runs one request/reply interaction against the router task with a timeout.
    ///
    /// `build` receives the one-shot sender that the router-side handler must use to
    /// deliver the reply for this request. The closure packages that sender into the
    /// appropriate `RouterMsg` variant together with any request-specific payload, which
    /// keeps the caller from having to construct and manage the reply channel manually.
    pub async fn request<T, F>(&self, timeout_ms: u64, build: F) -> Result<T, RouterCallError>
    where
        T: Send + 'static,
        F: FnOnce(oneshot::Sender<T>) -> RouterMsg,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_async(build(reply_tx))
            .await
            .map_err(|_| RouterCallError::RouterStopped)?;

        match tokio::time::timeout(Duration::from_millis(timeout_ms), reply_rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(RouterCallError::RouterStopped),
            Err(error) => Err(RouterCallError::TimedOut(error)),
        }
    }
}

/// Stable error type used by server code that previously relied on `call_t!`.
#[derive(Debug)]
pub enum RouterCallError {
    TimedOut(Elapsed),
    RouterStopped,
}

/// Spawns the router task and returns its handle plus join handle.
pub fn spawn_router() -> (RouterHandle, tokio::task::JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel::<RouterMsg>(ROUTER_MAILBOX_CAPACITY);
    let router_handle = RouterHandle::new(sender);
    let task_handle = tokio::spawn(run_router(receiver, router_handle.clone()));
    (router_handle, task_handle)
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
            (CommandResult::GetAgentDetails(details), Some(agent_connection)) => {
                // Registration owns the connection-scoped identity fields, so the
                // router rewrites them from its authoritative registry snapshot.
                let mut details = details.clone();
                details.id = stored_agent_id.clone();
                details.name = agent_connection.agent_name.clone();
                details.connected_at = agent_connection.connected_at;
                details.os = agent_connection.os.clone();
                details.arch = agent_connection.arch.clone();
                details.hostname = agent_connection.hostname.clone();
                details.username = agent_connection.username.clone();
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

/// Runs the router event loop so all correlated routing state stays single-owner.
async fn run_router(mut receiver: mpsc::Receiver<RouterMsg>, router_handle: RouterHandle) {
    log!(Level::Info, "Router task started");
    let mut state = RouterState::new(ui::start_refresh_check_task(router_handle.clone()));

    while let Some(message) = receiver.recv().await {
        match message {
            RouterMsg::RegisterAgent(request) => {
                agents::register(&mut state, request);
            }
            RouterMsg::UnregisterAgent { agent_id } => {
                log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
                state.agents.by_id.remove(&agent_id);
                ui::notify_refresh(&mut state);
                cleanup::cleanup_agent_requests(&mut state, &agent_id).await;
            }
            RouterMsg::RouteResponse(response) => {
                route_response(&mut state, response);
            }
            RouterMsg::GetAgentList { reply } => {
                let _ = reply.send(agents::list_agents(&state));
            }
            RouterMsg::GetTransferProgress { reply } => {
                let _ = reply.send(progress::list_transfer_progress(&state));
            }
            RouterMsg::RegisterUiSubscriber(request) => {
                ui::register_subscriber(&mut state, request);
            }
            RouterMsg::UnregisterUiSubscriber { subscriber_id } => {
                ui::unregister_subscriber(&mut state, &subscriber_id);
            }
            RouterMsg::ExecuteCommandRest(request) => {
                agents::execute_command_rest(&mut state, request);
            }
            RouterMsg::RouteStreamChunk(request) => {
                if is_remote_copy_stream(&state, request.chunk.request_id) {
                    transfers::copy::route_chunk(&mut state, &router_handle, request);
                } else {
                    transfers::download::route_chunk(&mut state, &router_handle, request);
                }
            }
            RouterMsg::FinishRoutedDownloadChunk(route) => {
                transfers::download::finish_routed_chunk(&mut state, &route);
                let _ = route.reply.send(());
            }
            RouterMsg::FinishRoutedUploadChunk(route) => {
                let result = transfers::upload::finish_routed_chunk(&mut state, &route);
                let _ = route.reply.send(result);
            }
            RouterMsg::FinishRoutedCopyChunk(route) => {
                transfers::copy::finish_routed_chunk(&mut state, &route);
                let _ = route.reply.send(());
            }
            RouterMsg::ExecuteStreamCommandRest(request) => {
                transfers::download::start(&mut state, request);
            }
            RouterMsg::StartUploadStreamRest(request) => {
                transfers::upload::start(&mut state, request);
            }
            RouterMsg::SendStreamChunkToAgent(request) => {
                transfers::upload::route_chunk(&mut state, &router_handle, request);
            }
            RouterMsg::CancelTransfer {
                agent_id,
                request_id,
            } => {
                cleanup::cancel_transfer(&mut state, request_id, agent_id);
            }
            RouterMsg::StartCopyRest(request) => {
                transfers::copy::start(&mut state, request);
            }
            RouterMsg::TransferProgressUpdate(request) => {
                transfers::copy::update_progress(&mut state, request);
            }
            RouterMsg::CheckPendingUiRefresh => {
                ui::check_pending_refresh(&mut state);
            }
            RouterMsg::Shutdown => {
                break;
            }
        }
    }

    state.ui.refresh_check_task.abort();
    log!(Level::Info, "Router task stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Command;
    use crate::streaming::{StreamChunk, StreamPayloadKind};
    use crate::types::{AgentId, SocketId};
    use axum::extract::ws::Message as WsMessage;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::{Duration, timeout};
    use uuid::Uuid;

    #[tokio::test]
    async fn slow_upload_send_does_not_block_unrelated_router_work() {
        crate::logging::init(None);

        let (router_ref, router_task) = spawn_router();

        let (text_tx, _text_rx) = mpsc::unbounded_channel::<WsMessage>();
        let (binary_tx, mut binary_rx) = mpsc::channel::<WsMessage>(1);

        router_ref
            .send(RouterMsg::RegisterAgent(RegisterAgentRequest {
                agent_id: AgentId::from("agent-1"),
                agent_name: "agent-1".to_string(),
                socket_id: SocketId::from(Uuid::from_u128(1)),
                outgoing_text: text_tx,
                outgoing_binary: binary_tx,
                os: "macos".to_string(),
                arch: "arm64".to_string(),
                hostname: "host".to_string(),
                username: "user".to_string(),
            }))
            .expect("agent registered");

        let (completion_tx, _completion_rx) = oneshot::channel();
        let request_id = router_ref
            .request(1_000, |reply| {
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
            })
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
            .request(1_000, |reply| {
                RouterMsg::SendStreamChunkToAgent(SendStreamChunkRequest {
                    agent_id: AgentId::from("agent-1"),
                    request_id,
                    chunk: first_chunk,
                    reply,
                })
            })
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
                .request(5_000, |reply| {
                    RouterMsg::SendStreamChunkToAgent(SendStreamChunkRequest {
                        agent_id: AgentId::from("agent-1"),
                        request_id,
                        chunk: second_chunk,
                        reply,
                    })
                })
                .await
        });

        tokio::task::yield_now().await;

        let router_ref_for_list = router_ref.clone();
        let list_agents = timeout(Duration::from_millis(250), async move {
            router_ref_for_list
                .request(1_000, |reply| RouterMsg::GetAgentList { reply })
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

        router_ref
            .send(RouterMsg::Shutdown)
            .expect("router shutdown queued");
        router_task.await.expect("router task joined");
    }
}
