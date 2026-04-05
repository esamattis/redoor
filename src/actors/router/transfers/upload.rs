use super::super::agents;
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
use ractor::ActorRef;

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

    if let Some(agent_info) = state.agents.by_id.get(&request.agent_id).cloned() {
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

        agents::send_agent_message(
            &agent_info,
            Message::Command {
                agent_id: request.agent_id,
                request_id,
                command: request.command,
            },
        );
        let _ = request.reply.send(Ok(request_id));
    } else {
        log!(
            Level::Warning,
            "Agent not found for upload command: agent_id={}",
            request.agent_id
        );
        let _ = request
            .reply
            .send(Err(format!("Agent not found: {}", request.agent_id)));
    }
}

/// Forwards one REST upload chunk to the target agent's bounded binary lane.
pub(crate) fn route_chunk(
    state: &mut RouterState,
    myself: &ActorRef<RouterMsg>,
    request: SendStreamChunkRequest,
) {
    let has_matching_upload = matches!(
        state.streams.uploads.get(&request.request_id),
        Some(transfer) if transfer.agent_id == request.agent_id
    );

    if !has_matching_upload {
        log!(
            Level::Warning,
            "Upload stream not found for forwarded chunk: agent_id={}, request_id={}",
            request.agent_id,
            request.request_id
        );
        let _ = request.reply.send(Err(format!(
            "Upload stream not found: agent_id={}, request_id={}",
            request.agent_id, request.request_id
        )));
    } else if let Some(agent_info) = state.agents.by_id.get(&request.agent_id).cloned() {
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
            let send_succeeded = agents::send_agent_binary(&agent_info, payload).await;
            let send_result =
                myself.cast(RouterMsg::FinishRoutedUploadChunk(FinishUploadChunkRoute {
                    agent_id,
                    request_id,
                    bytes,
                    is_error,
                    send_succeeded,
                    reply,
                }));

            if let Err(ractor::MessagingErr::SendErr(message)) = send_result {
                if let RouterMsg::FinishRoutedUploadChunk(route) = message {
                    let _ = route.reply.send(Err(
                        "Router stopped before upload chunk forwarding completed".to_string(),
                    ));
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
        let _ = request
            .reply
            .send(Err(format!("Agent not found: {}", request.agent_id)));
    }
}

/// Finalizes one upload chunk after the downstream binary send completes.
pub(crate) fn finish_routed_chunk(
    state: &mut RouterState,
    agent_id: AgentId,
    request_id: crate::types::RequestId,
    bytes: u64,
    is_error: bool,
    send_succeeded: bool,
) -> Result<(), String> {
    let has_matching_upload = matches!(
        state.streams.uploads.get(&request_id),
        Some(transfer) if transfer.agent_id == agent_id
    );

    if !has_matching_upload {
        return Err(format!(
            "Upload stream not found: agent_id={}, request_id={}",
            agent_id, request_id
        ));
    }

    if !send_succeeded {
        let error_message = format!(
            "Failed to forward upload chunk to agent: agent_id={}, request_id={}",
            agent_id, request_id
        );

        progress::mark_transfer_errored(state, request_id.as_transfer_id(), error_message.clone());

        let completion_sender = state
            .streams
            .uploads
            .remove(&request_id)
            .and_then(|transfer| transfer.completion_sender);

        ui::notify_refresh(state);

        if let Some(sender) = completion_sender {
            let _ = sender.send(Err(error_message.clone()));
        }

        return Err(error_message);
    }

    if !is_error {
        progress::increment_bytes(state, request_id.as_transfer_id(), bytes);
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
    let completion_sender = match state.streams.uploads.get_mut(&request_id) {
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
            transfer.completion_sender.take()
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
        CommandResult::Error { message } => {
            progress::mark_transfer_errored(state, request_id.as_transfer_id(), message.clone());
            log!(
                Level::Info,
                "Routing upload error response: agent_id={}, request_id={}, message={}",
                agent_id,
                request_id,
                message
            );
            Err(message.clone())
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
            Err("Unexpected upload response type".to_string())
        }
    };

    state.streams.uploads.remove(&request_id);
    ui::notify_refresh(state);

    if let Some(sender) = completion_sender {
        let _ = sender.send(completion_result);
    }
}
