//! Shared bounded output transport; only filesystem streams participate in transfer progress.

use super::super::RouterError;
use super::super::RouterHandle;
use super::super::messages::{
    ExecuteStreamRequest, FinishOutputChunkRoute, OutputStreamTracking, RouteStreamChunkRequest,
    RouterMsg, TransferProgressUpdateRequest,
};
use super::super::progress::{self, DownloadStartContext};
use super::super::state::{DirectOutputKind, DirectOutputStream, RouterState};
use super::super::ui;
use crate::commands::{TransferDirection, TransferProgressState};
use crate::log;
use crate::logging::Level;
use crate::types::Message;

/// Converts pre-worker rejections into stream failure instead of leaving HTTP consumers waiting forever.
pub(crate) fn finish_rejected(
    state: &mut RouterState,
    response: &super::super::messages::RouteResponse,
) -> bool {
    let crate::commands::CommandResult::Error { message, .. } = &response.result else {
        return false;
    };
    if !state
        .streams
        .outputs
        .get(&response.request_id)
        .is_some_and(|stream| stream.agent_id == response.agent_id)
    {
        return false;
    }
    let Some(stream) = state.streams.outputs.remove(&response.request_id) else {
        return false;
    };
    if let Some(id) = stream.progress_id {
        progress::mark_transfer_errored(state, id, message.clone());
        ui::notify_transfer_refresh(state);
    }
    if let Some(sender) = stream.chunk_sender {
        let chunk = crate::streaming::StreamChunk {
            request_id: response.request_id,
            chunk_index: crate::types::ChunkIndex::new(0),
            is_last: true,
            is_error: true,
            payload_kind: crate::streaming::StreamPayloadKind::RawFile,
            data: message.as_bytes().to_vec(),
        };
        // Waiting for a saturated consumer here would block unrelated control commands.
        tokio::spawn(async move {
            let _ = sender.send(chunk).await;
        });
    }
    true
}

/// Applies a download-only total discovered after the stream already started.
///
/// Copy updates stay on their overwrite path. Returning false lets the router
/// fall through when this request is not an active or terminal download.
pub(crate) fn update_progress(
    state: &mut RouterState,
    request: &TransferProgressUpdateRequest,
) -> bool {
    let Some(progress_id) = state
        .streams
        .outputs
        .get(&request.request_id)
        .and_then(|transfer| {
            (transfer.agent_id == request.agent_id).then_some(transfer.progress_id)
        })
        .flatten()
    else {
        return false;
    };

    let Some(progress) = state.progress.entries.get(&progress_id) else {
        return false;
    };
    if progress.agent_id != request.agent_id {
        return false;
    }
    if !matches!(progress.direction, TransferDirection::Download) {
        return false;
    }
    if !matches!(progress.state, TransferProgressState::Active) {
        return true;
    }
    let Some(total_bytes) = request.total_bytes else {
        return true;
    };
    progress::set_download_total(state, progress_id, total_bytes);
    true
}

/// Registers shared output transport and creates progress only for filesystem downloads.
pub(crate) fn start(state: &mut RouterState, request: ExecuteStreamRequest) {
    let request_id = state.next_id();

    log!(
        Level::Info,
        "Routing REST streaming command: agent_id={}, request_id={}, command={:?}",
        request.agent_id,
        request_id,
        request.command.summary()
    );

    if let Some(agent_connection) = state.agents.by_id.get(&request.agent_id).cloned() {
        if let Err(error) = agent_connection.transfer_connection() {
            log!(
                Level::Warning,
                "Transfer unavailable for download: agent_id={}",
                request.agent_id
            );
            let _ = request.reply.send(Err(error));
            return;
        }
        if !agent_connection.send_message(Message::Command {
            agent_id: request.agent_id.clone(),
            request_id,
            command: request.command,
        }) {
            let _ = request.reply.send(Err(RouterError::ControlQueueFull {
                agent_id: request.agent_id.to_string(),
            }));
            return;
        }
        let (kind, progress_id) = match request.tracking {
            OutputStreamTracking::Download {
                path,
                total_bytes,
                full_size,
                resume_offset,
            } => (
                DirectOutputKind::File,
                Some(progress::record_download_start(
                    state,
                    DownloadStartContext {
                        request_id,
                        agent_id: request.agent_id.clone(),
                        path,
                        total_bytes,
                        full_size,
                        resume_offset,
                    },
                )),
            ),
            OutputStreamTracking::Execution => (DirectOutputKind::Execution, None),
        };
        state.streams.outputs.insert(
            request_id,
            DirectOutputStream {
                kind,
                agent_id: request.agent_id,
                chunk_sender: Some(request.chunk_sender),
                rest_cancel_sender: request.rest_cancel_sender,
                progress_id,
                canceled_by_rest: false,
            },
        );

        let _ = request.reply.send(Ok(request_id));
    } else {
        log!(
            Level::Warning,
            "Agent not found for streaming command: agent_id={}",
            request.agent_id
        );
        let _ = request.reply.send(Err(RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        }));
    }
}

/// Forwards bounded output without coupling process events to file-transfer progress.
pub(crate) fn route_chunk(
    state: &mut RouterState,
    myself: &RouterHandle,
    request: RouteStreamChunkRequest,
) {
    let agent_id = request.agent_id;
    let chunk = request.chunk;
    let reply = request.reply;
    let request_id = chunk.request_id;
    let chunk_sender = match state.streams.outputs.get(&request_id) {
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
                    if let Some(transfer_id) = transfer.progress_id
                        && matches!(
                            state
                                .progress
                                .entries
                                .get(&transfer_id)
                                .map(|entry| &entry.state),
                            Some(crate::commands::TransferProgressState::Canceling)
                        )
                    {
                        progress::mark_transfer_canceled(state, transfer_id);
                    }
                    state.streams.outputs.remove(&request_id);
                }
                let _ = reply.send(());
                return;
            }
            let Some(chunk_sender) = transfer.chunk_sender.clone() else {
                let _ = reply.send(());
                return;
            };
            chunk_sender
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
    let bytes = chunk.data.len() as u64;

    let myself = myself.clone();
    tokio::spawn(async move {
        let send_succeeded = chunk_sender.send(chunk).await.is_ok();
        let send_result = myself.send(RouterMsg::FinishRoutedOutputChunk(FinishOutputChunkRoute {
            agent_id,
            request_id,
            chunk_index,
            is_last,
            bytes,
            error_message,
            send_succeeded,
            reply,
        }));
        if let Err(tokio::sync::mpsc::error::SendError(message)) = send_result
            && let RouterMsg::FinishRoutedOutputChunk(route) = message
        {
            let _ = route.reply.send(());
        }
    });
}

/// Settles output transport after downstream acceptance, updating file progress only when present.
pub(crate) fn finish_routed_chunk(state: &mut RouterState, route: &FinishOutputChunkRoute) {
    let is_error = route.error_message.is_some();

    if !route.send_succeeded {
        let cancellation = match state.streams.outputs.get_mut(&route.request_id) {
            Some(transfer) => {
                if transfer.agent_id != route.agent_id {
                    log!(
                        Level::Warning,
                        "Streaming agent mismatch while finishing chunk send: request_id={}, expected_agent_id={}, actual_agent_id={}",
                        route.request_id,
                        transfer.agent_id,
                        route.agent_id
                    );
                    return;
                }
                if transfer.canceled_by_rest {
                    return;
                }
                transfer.canceled_by_rest = true;
                Some(transfer.progress_id)
            }
            None => {
                return;
            }
        };

        if let Some(progress_id) = cancellation {
            log!(
                Level::Warning,
                "Failed to send chunk to REST stream: request_id={}",
                route.request_id
            );
            if let Some(transfer_id) = progress_id {
                progress::mark_transfer_errored(
                    state,
                    transfer_id,
                    "Download canceled by client".to_string(),
                );
                ui::notify_transfer_refresh(state);
            }
            if let Some(agent_connection) = state.agents.by_id.get(&route.agent_id) {
                log!(
                    Level::Info,
                    "Sending download cancel to agent: agent_id={}, request_id={}",
                    route.agent_id,
                    route.request_id
                );
                agent_connection.send_priority_message(Message::CancelTransfer {
                    request_id: route.request_id,
                });
            }
        }
        return;
    }

    let has_matching_transfer = matches!(
        state.streams.outputs.get(&route.request_id),
        Some(transfer) if transfer.agent_id == route.agent_id
    );

    if !has_matching_transfer {
        return;
    }

    let transfer_id = state
        .streams
        .outputs
        .get(&route.request_id)
        .and_then(|transfer| transfer.progress_id);

    if let Some(transfer_id) = transfer_id {
        if !is_error {
            progress::increment_bytes(state, transfer_id, route.bytes);
        }
        if let Some(error_message) = &route.error_message {
            progress::mark_transfer_errored(state, transfer_id, error_message.clone());
        } else if route.is_last {
            progress::mark_transfer_completed(state, transfer_id);
        }
    }

    if route.is_last || is_error {
        state.streams.outputs.remove(&route.request_id);
        if transfer_id.is_some() {
            ui::notify_transfer_refresh(state);
        }
        log!(
            Level::Info,
            "Streaming complete: agent_id={}, request_id={}, total_chunks={}, is_error={}",
            route.agent_id,
            route.request_id,
            route.chunk_index.display_number(),
            is_error
        );
    }
}
