mod agents;
mod cleanup;
mod messages;
mod progress;
mod state;
mod transfers;
mod ui;

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
use ractor::{Actor, ActorProcessingErr, ActorRef};
use state::{CopyExecution, RouterState};

/// Central command router actor (singleton).
pub struct RouterActor;

impl RouterActor {
    /// Checks whether an inbound stream chunk belongs to a remote copy flow.
    fn is_remote_copy_stream(state: &RouterState, request_id: RequestId) -> bool {
        state
            .copies
            .public_id_for_internal(request_id)
            .and_then(|public_request_id| state.copies.by_public_id.get(&public_request_id))
            .map(|copy_request| {
                matches!(copy_request.execution, CopyExecution::RemoteStream { .. })
            })
            .unwrap_or(false)
    }

    /// Routes a final agent command response to one-shot, copy, or upload handlers.
    fn route_response(state: &mut RouterState, response: RouteResponse) {
        if let Some((reply, stored_agent_id)) = state
            .pending_rest
            .by_request_id
            .remove(&response.request_id)
        {
            let result_to_send = match (&response.result, state.agents.by_id.get(&stored_agent_id))
            {
                (CommandResult::GetAgentDetails(details), Some(agent_info)) => {
                    // Fill response fields that only the router knows from registration time.
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
}

impl Actor for RouterActor {
    type Msg = RouterMsg;
    type State = RouterState;
    type Arguments = ();

    /// Initializes router state and starts the periodic UI refresh checker.
    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        _args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        log!(Level::Info, "RouterActor started");
        Ok(RouterState::new(ui::start_refresh_check_task(myself)))
    }

    /// Stops the periodic UI refresh checker when the router shuts down.
    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        state.ui.refresh_check_task.abort();
        Ok(())
    }

    /// Dispatches each router message to the focused domain module that owns it.
    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            RouterMsg::RegisterAgent(request) => {
                agents::register(state, request);
            }
            RouterMsg::UnregisterAgent { agent_id } => {
                log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
                state.agents.by_id.remove(&agent_id);
                ui::notify_refresh(state);
                cleanup::cleanup_agent_requests(state, &myself, &agent_id).await;
            }
            RouterMsg::RouteResponse(response) => {
                Self::route_response(state, response);
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
                if Self::is_remote_copy_stream(state, request.chunk.request_id) {
                    transfers::copy::route_chunk(state, &myself, request);
                } else {
                    transfers::download::route_chunk(state, &myself, request);
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
                transfers::upload::route_chunk(state, &myself, request);
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Command;
    use crate::streaming::{StreamChunk, StreamPayloadKind};
    use crate::types::AgentId;
    use axum::extract::ws::Message as WsMessage;
    use ractor::call_t;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::{Duration, timeout};

    #[tokio::test]
    async fn slow_upload_send_does_not_block_unrelated_router_work() {
        crate::logging::init(None);

        let (router_ref, _handle) = RouterActor::spawn(None, RouterActor, ())
            .await
            .expect("router spawned");

        let (text_tx, _text_rx) = mpsc::unbounded_channel::<WsMessage>();
        let (binary_tx, mut binary_rx) = mpsc::channel::<WsMessage>(1);

        router_ref
            .cast(RouterMsg::RegisterAgent(RegisterAgentRequest {
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
            .expect("agent registered");

        let (completion_tx, _completion_rx) = oneshot::channel();
        let request_id = call_t!(
            &router_ref,
            |reply| RouterMsg::StartUploadStreamRest(StartUploadRequest {
                agent_id: AgentId::from("agent-1"),
                command: Command::RawUpload {
                    path: "/tmp/file.bin".to_string(),
                },
                path: "/tmp/file.bin".to_string(),
                total_bytes: 32,
                completion_sender: completion_tx,
                reply,
            }),
            1_000
        )
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
        call_t!(
            &router_ref,
            |reply| RouterMsg::SendStreamChunkToAgent(SendStreamChunkRequest {
                agent_id: AgentId::from("agent-1"),
                request_id,
                chunk: first_chunk,
                reply,
            }),
            1_000
        )
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
            call_t!(
                &router_ref_for_chunk,
                |reply| RouterMsg::SendStreamChunkToAgent(SendStreamChunkRequest {
                    agent_id: AgentId::from("agent-1"),
                    request_id,
                    chunk: second_chunk,
                    reply,
                }),
                5_000
            )
        });

        tokio::task::yield_now().await;

        let router_ref_for_list = router_ref.clone();
        let list_agents = timeout(Duration::from_millis(250), async move {
            call_t!(
                &router_ref_for_list,
                |reply| RouterMsg::GetAgentList { reply },
                1_000
            )
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

        let _ = router_ref.stop(None);
    }
}
