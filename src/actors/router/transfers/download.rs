use super::super::agents;
use super::super::messages::{ExecuteStreamRequest, FinishDownloadChunkRoute, RouterMsg};
use super::super::progress::{self, DownloadStartContext};
use super::super::state::RouterState;
use super::super::ui;
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};
use ractor::ActorRef;
use ractor::RpcReplyPort;

/// Starts a direct download stream and records its progress entry.
pub(crate) fn start(state: &mut RouterState, request: ExecuteStreamRequest) {
    let request_id = state.next_id();

    log!(
        Level::Info,
        "Routing REST streaming command: agent_id={}, request_id={}, command={:?}",
        request.agent_id,
        request_id,
        request.command
    );

    if let Some(agent_info) = state.agents.by_id.get(&request.agent_id).cloned() {
        progress::record_download_start(
            state,
            DownloadStartContext {
                request_id,
                agent_id: request.agent_id.clone(),
                path: request.path,
                total_bytes: request.total_bytes,
                chunk_sender: request.chunk_sender,
            },
        );

        agents::send_agent_message(
            &agent_info,
            Message::Command {
                agent_id: request.agent_id,
                request_id,
                command: request.command,
            },
        );
        let _ = request.reply.send(Ok(()));
    } else {
        log!(
            Level::Warning,
            "Agent not found for streaming command: agent_id={}",
            request.agent_id
        );
        let _ = request
            .reply
            .send(Err(format!("Agent not found: {}", request.agent_id)));
    }
}

/// Forwards one inbound direct-download chunk to the waiting REST stream.
pub(crate) fn route_chunk(
    state: &mut RouterState,
    myself: &ActorRef<RouterMsg>,
    agent_id: AgentId,
    chunk: crate::streaming::StreamChunk,
    reply: RpcReplyPort<()>,
) {
    let request_id = chunk.request_id;
    let transfer_id = request_id.as_transfer_id();

    let chunk_sender = match state.streams.downloads.get(&request_id) {
        Some(transfer) => {
            if transfer.agent_id != agent_id {
                log!(
                    Level::Warning,
                    "Streaming agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                    request_id,
                    transfer.agent_id,
                    agent_id
                );
                let _ = reply.send(());
                return;
            }
            if transfer.canceled_by_rest {
                if chunk.is_last || chunk.is_error {
                    log!(
                        Level::Info,
                        "Received canceled download ack from agent: agent_id={}, request_id={}, is_error={}",
                        agent_id,
                        request_id,
                        chunk.is_error
                    );
                    state.streams.downloads.remove(&request_id);
                }
                let _ = reply.send(());
                return;
            }
            transfer.chunk_sender.clone()
        }
        None => {
            if state.streams.uploads.contains_key(&request_id) {
                log!(
                    Level::Warning,
                    "Received stream chunk for upload transfer: request_id={}",
                    request_id
                );
            } else {
                log!(
                    Level::Warning,
                    "No streaming response found for request_id={}",
                    request_id
                );
            }
            let _ = reply.send(());
            return;
        }
    };

    if !chunk.is_error {
        progress::increment_bytes(state, transfer_id, chunk.data.len() as u64);
    }

    let error_message = if chunk.is_error {
        Some(if chunk.data.is_empty() {
            "Download failed on agent".to_string()
        } else {
            String::from_utf8_lossy(&chunk.data).to_string()
        })
    } else {
        None
    };
    let chunk_index = chunk.chunk_index;
    let is_last = chunk.is_last;

    let myself = myself.clone();
    tokio::spawn(async move {
        let send_succeeded = chunk_sender.send(chunk).await.is_ok();
        let send_result = myself.cast(RouterMsg::FinishRoutedDownloadChunk(
            FinishDownloadChunkRoute {
                agent_id,
                request_id,
                chunk_index,
                is_last,
                error_message,
                send_succeeded,
                reply,
            },
        ));
        if let Err(ractor::MessagingErr::SendErr(message)) = send_result {
            if let RouterMsg::FinishRoutedDownloadChunk(route) = message {
                let _ = route.reply.send(());
            }
        }
    });
}

/// Finalizes one direct-download chunk after the REST-side bounded send completes.
pub(crate) fn finish_routed_chunk(
    state: &mut RouterState,
    agent_id: AgentId,
    request_id: crate::types::RequestId,
    chunk_index: crate::types::ChunkIndex,
    is_last: bool,
    error_message: Option<String>,
    send_succeeded: bool,
) {
    let transfer_id = request_id.as_transfer_id();
    let is_error = error_message.is_some();

    if !send_succeeded {
        let should_cancel_agent = match state.streams.downloads.get_mut(&request_id) {
            Some(transfer) => {
                if transfer.agent_id != agent_id {
                    log!(
                        Level::Warning,
                        "Streaming agent mismatch while finishing chunk send: request_id={}, expected_agent_id={}, actual_agent_id={}",
                        request_id,
                        transfer.agent_id,
                        agent_id
                    );
                    return;
                }
                if transfer.canceled_by_rest {
                    return;
                }
                transfer.canceled_by_rest = true;
                true
            }
            None => {
                return;
            }
        };

        if should_cancel_agent {
            log!(
                Level::Warning,
                "Failed to send chunk to REST stream: request_id={}",
                request_id
            );
            progress::mark_transfer_errored(
                state,
                transfer_id,
                "Download canceled by client".to_string(),
            );
            if let Some(agent_info) = state.agents.by_id.get(&agent_id) {
                log!(
                    Level::Info,
                    "Sending download cancel to agent: agent_id={}, request_id={}",
                    agent_id,
                    request_id
                );
                agents::send_agent_message(agent_info, Message::CancelTransfer { request_id });
            }
            ui::notify_refresh(state);
        }
        return;
    }

    let has_matching_transfer = matches!(
        state.streams.downloads.get(&request_id),
        Some(transfer) if transfer.agent_id == agent_id
    );

    if !has_matching_transfer {
        return;
    }

    if let Some(error_message) = error_message {
        progress::mark_transfer_errored(state, transfer_id, error_message);
    } else if is_last {
        progress::mark_transfer_completed(state, transfer_id);
    }

    if is_last || is_error {
        state.streams.downloads.remove(&request_id);
        ui::notify_refresh(state);
        log!(
            Level::Info,
            "Streaming complete: agent_id={}, request_id={}, total_chunks={}, is_error={}",
            agent_id,
            request_id,
            chunk_index.display_number(),
            is_error
        );
    }
}
