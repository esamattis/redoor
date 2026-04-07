mod agents;
mod cleanup;
mod error;
mod messages;
mod progress;
mod router;
mod transfers;
mod ui;

pub use error::RouterError;
pub use messages::{
    ExecuteCommandRequest, ExecuteStreamRequest, RegisterAgentRequest, RegisterUiSubscriberRequest,
    RouteResponse, RouteStreamChunkRequest, RouterMsg, SendStreamChunkRequest, StartCopyRequest,
    StartUploadRequest, TransferProgressUpdateRequest,
};
pub use router::CopyContentKind;

use router::Router;
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
    #[allow(clippy::result_large_err)]
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
    let router = Router::new(ui::start_refresh_check_task(router_handle.clone()));
    let task_handle = tokio::spawn(router.run(receiver, router_handle.clone()));
    (router_handle, task_handle)
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
