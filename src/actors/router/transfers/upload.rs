use super::super::RouterError;
use super::super::RouterHandle;
use super::super::messages::{
    FinishUploadChunkRoute, RouterMsg, SendStreamChunkRequest, StartUploadRequest,
};
use super::super::progress::{self, UploadStartContext};
use super::super::state::RouterState;
use super::super::ui;
use crate::commands::CommandResult;
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};

/// Starts a direct upload stream and records its progress entry.
pub(crate) fn start(state: &mut RouterState, request: StartUploadRequest) {
    let request_id = state.next_id();

    log!(
        Level::Info,
        "Routing REST upload command: agent_id={}, request_id={}, command={:?}",
        request.agent_id,
        request_id,
        request.command
    );

    if let Some(agent_connection) = state.agents.by_id.get(&request.agent_id).cloned() {
        progress::record_upload_start(
            state,
            UploadStartContext {
                request_id,
                agent_id: request.agent_id.clone(),
                path: request.path,
                total_bytes: request.total_bytes,
                completion_sender: request.completion_sender,
            },
        );

        agent_connection.send_message(Message::Command {
            agent_id: request.agent_id,
            request_id,
            command: request.command,
        });
        let _ = request.reply.send(Ok(request_id));
    } else {
        log!(
            Level::Warning,
            "Agent not found for upload command: agent_id={}",
            request.agent_id
        );
        let _ = request.reply.send(Err(RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        }));
    }
}

/// Forwards one REST upload chunk to the target agent's bounded binary lane.
pub(crate) fn route_chunk(
    state: &mut RouterState,
    myself: &RouterHandle,
    request: SendStreamChunkRequest,
) {
    let transfer = match state.streams.uploads.get(&request.request_id) {
        Some(transfer) => transfer,
        None => {
            log!(
                Level::Warning,
                "Upload stream not found for forwarded chunk: agent_id={}, request_id={}",
                request.agent_id,
                request.request_id
            );
            let _ = request.reply.send(Err(RouterError::StreamNotFound {
                agent_id: request.agent_id.to_string(),
                request_id: request.request_id.to_string(),
            }));
            return;
        }
    };

    if transfer.agent_id != request.agent_id {
        log!(
            Level::Warning,
            "Upload response agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
            request.request_id,
            transfer.agent_id,
            request.agent_id
        );
        let _ = request.reply.send(Err(RouterError::StreamNotFound {
            agent_id: request.agent_id.to_string(),
            request_id: request.request_id.to_string(),
        }));
        return;
    }

    if transfer.canceled_by_rest {
        // Once REST has canceled the upload, later body frames should be
        // rejected instead of reviving the transfer state.
        let _ = request.reply.send(Err(RouterError::ClientCanceledUpload));
        return;
    }

    if let Some(agent_connection) = state.agents.by_id.get(&request.agent_id).cloned() {
        let bytes = request.chunk.data.len() as u64;
        let is_error = request.chunk.is_error;
        let payload = request.chunk.to_bytes();
        let request_id = request.request_id;
        let agent_id = request.agent_id;
        let reply = request.reply;
        let myself = myself.clone();

        if is_error {
            let error_message = if request.chunk.data.is_empty() {
                "Upload aborted by server".to_string()
            } else {
                String::from_utf8_lossy(&request.chunk.data).to_string()
            };
            progress::mark_transfer_errored(state, request_id.as_transfer_id(), error_message);
        }

        tokio::spawn(async move {
            let send_succeeded = agent_connection.send_binary(payload).await;
            let send_result =
                myself.send(RouterMsg::FinishRoutedUploadChunk(FinishUploadChunkRoute {
                    agent_id,
                    request_id,
                    bytes,
                    is_error,
                    send_succeeded,
                    reply,
                }));

            if let Err(tokio::sync::mpsc::error::SendError(message)) = send_result {
                if let RouterMsg::FinishRoutedUploadChunk(route) = message {
                    let _ = route.reply.send(Err(RouterError::RouterStopped {
                        operation: "upload chunk forwarding",
                    }));
                }
            }
        });
    } else {
        progress::mark_transfer_errored(
            state,
            request.request_id.as_transfer_id(),
            format!("Agent not found: {}", request.agent_id),
        );
        log!(
            Level::Warning,
            "Agent not found for forwarded upload chunk: agent_id={}, request_id={}",
            request.agent_id,
            request.request_id
        );
        let _ = request.reply.send(Err(RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        }));
    }
}

/// Finalizes one upload chunk after the downstream binary send completes.
pub(crate) fn finish_routed_chunk(
    state: &mut RouterState,
    route: &FinishUploadChunkRoute,
) -> Result<(), RouterError> {
    match state.streams.uploads.get(&route.request_id) {
        Some(transfer) => {
            if transfer.agent_id != route.agent_id {
                return Err(RouterError::StreamNotFound {
                    agent_id: route.agent_id.to_string(),
                    request_id: route.request_id.to_string(),
                });
            }

            if transfer.canceled_by_rest {
                return Ok(());
            }
        }
        None => {
            return Err(RouterError::StreamNotFound {
                agent_id: route.agent_id.to_string(),
                request_id: route.request_id.to_string(),
            });
        }
    }

    if !route.send_succeeded {
        let should_cancel_agent = match state.streams.uploads.get_mut(&route.request_id) {
            Some(transfer) => {
                if transfer.agent_id != route.agent_id {
                    return Err(RouterError::StreamNotFound {
                        agent_id: route.agent_id.to_string(),
                        request_id: route.request_id.to_string(),
                    });
                }

                if transfer.canceled_by_rest {
                    return Ok(());
                }

                // The router could not push a chunk into the agent's bounded
                // websocket lane, so the agent-side upload worker must be told
                // to discard its temp output.
                transfer.canceled_by_rest = true;
                true
            }
            None => {
                return Err(RouterError::StreamNotFound {
                    agent_id: route.agent_id.to_string(),
                    request_id: route.request_id.to_string(),
                });
            }
        };

        let error = RouterError::UploadForwardFailed {
            agent_id: route.agent_id.to_string(),
            request_id: route.request_id.to_string(),
        };

        progress::mark_transfer_errored(
            state,
            route.request_id.as_transfer_id(),
            error.to_string(),
        );

        if should_cancel_agent {
            if let Some(agent_connection) = state.agents.by_id.get(&route.agent_id) {
                log!(
                    Level::Info,
                    "Sending upload cancel to agent: agent_id={}, request_id={}",
                    route.agent_id,
                    route.request_id
                );
                agent_connection.send_message(Message::CancelTransfer {
                    request_id: route.request_id,
                });
            }
        }

        return Err(error);
    }

    if !route.is_error {
        progress::increment_bytes(state, route.request_id.as_transfer_id(), route.bytes);
    }

    Ok(())
}

/// Handles the final command response that completes a direct upload stream.
pub(crate) fn finish_transfer(
    state: &mut RouterState,
    agent_id: AgentId,
    request_id: crate::types::RequestId,
    result: CommandResult,
) {
    let transfer_state = match state.streams.uploads.get_mut(&request_id) {
        Some(transfer) => {
            if transfer.agent_id != agent_id {
                log!(
                    Level::Warning,
                    "Upload response agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                    request_id,
                    transfer.agent_id,
                    agent_id
                );
                return;
            }
            (transfer.canceled_by_rest, transfer.completion_sender.take())
        }
        None => {
            if state.streams.downloads.contains_key(&request_id) {
                log!(
                    Level::Warning,
                    "Received command response for download transfer: request_id={}, result={:?}",
                    request_id,
                    result
                );
            } else {
                log!(
                    Level::Warning,
                    "No pending response found for request_id={}",
                    request_id
                );
            }
            return;
        }
    };

    let (canceled_by_rest, completion_sender) = transfer_state;

    if canceled_by_rest {
        // After REST has already gone away, the agent response only acts as a
        // cleanup ack. The user-visible error stays the standardized cancel
        // message stored when cancellation was initiated.
        log!(
            Level::Info,
            "Received canceled upload ack from agent: agent_id={}, request_id={}, is_error={}",
            agent_id,
            request_id,
            matches!(result, CommandResult::Error { .. })
        );
        state.streams.uploads.remove(&request_id);
        ui::notify_refresh(state);

        if let Some(sender) = completion_sender {
            let _ = sender.send(Err(RouterError::ClientCanceledUpload));
        }
        return;
    }

    let completion_result = match &result {
        CommandResult::RawUpload => {
            progress::mark_transfer_completed(state, request_id.as_transfer_id());
            log!(
                Level::Info,
                "Routing upload completion response: agent_id={}, request_id={}, result={:?}",
                agent_id,
                request_id,
                result
            );
            Ok(result)
        }
        CommandResult::Error { message, .. } => {
            progress::mark_transfer_errored(state, request_id.as_transfer_id(), message.clone());
            log!(
                Level::Info,
                "Routing upload error response: agent_id={}, request_id={}, message={}",
                agent_id,
                request_id,
                message
            );
            Ok(result)
        }
        _ => {
            progress::mark_transfer_errored(
                state,
                request_id.as_transfer_id(),
                "Unexpected upload response type".to_string(),
            );
            log!(
                Level::Warning,
                "Unexpected upload response type: agent_id={}, request_id={}, result={:?}",
                agent_id,
                request_id,
                result
            );
            Err(RouterError::UnexpectedResponseType {
                operation: "handling upload completion response",
            })
        }
    };

    state.streams.uploads.remove(&request_id);
    ui::notify_refresh(state);

    if let Some(sender) = completion_sender {
        let _ = sender.send(completion_result);
    }
}
