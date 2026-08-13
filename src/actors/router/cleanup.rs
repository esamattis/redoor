use super::RouterError;
use super::progress;
use super::state::{CopyExecution, RouterState};
use super::transfers::copy;
use super::ui;
use crate::commands::{CommandErrorKind, CommandResult};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};

/// Cleans up all router-owned state associated with a disconnected agent.
pub(crate) async fn cleanup_agent_requests(state: &mut RouterState, agent_id: &AgentId) {
    let orphaned_oneshot: Vec<_> = state
        .pending_rest
        .by_request_id
        .iter()
        .filter(|(_, (_, pending_agent_id))| pending_agent_id == agent_id)
        .map(|(request_id, _)| *request_id)
        .collect();

    for request_id in &orphaned_oneshot {
        if let Some((reply, _)) = state.pending_rest.by_request_id.remove(request_id) {
            log!(
                Level::Warning,
                "Cleaning up orphaned pending response: request_id={}, agent_id={}",
                request_id,
                agent_id
            );
            let _ = reply.send(CommandResult::error(
                CommandErrorKind::Internal,
                format!("Agent disconnected: {}", agent_id),
            ));
        }
    }

    let orphaned_copy_ids: Vec<_> = state
        .copies
        .by_public_id
        .iter()
        .filter(|(_, copy_request)| match &copy_request.execution {
            CopyExecution::RemoteStream { .. } => {
                &copy_request.source_agent_id == agent_id || &copy_request.dest_agent_id == agent_id
            }
            CopyExecution::LocalAgent {
                agent_id: local_agent_id,
                ..
            } => local_agent_id == agent_id,
        })
        .map(|(request_id, _)| *request_id)
        .collect();

    for request_id in &orphaned_copy_ids {
        let _ = copy::abort_copy_upload(
            state,
            *request_id,
            format!("Agent disconnected: {}", agent_id),
        );
        progress::mark_transfer_errored(
            state,
            *request_id,
            format!("Agent disconnected: {}", agent_id),
        );
        copy::cleanup_copy_tracking(state, *request_id);
    }

    let orphaned_downloads: Vec<_> = state
        .streams
        .downloads
        .iter()
        .filter(|(_, transfer)| &transfer.agent_id == agent_id)
        .map(|(request_id, _)| *request_id)
        .collect();
    let orphaned_uploads: Vec<_> = state
        .streams
        .uploads
        .iter()
        .filter(|(_, transfer)| &transfer.agent_id == agent_id)
        .map(|(request_id, _)| *request_id)
        .collect();

    for request_id in &orphaned_downloads {
        if let Some(transfer) = state.streams.downloads.remove(request_id) {
            let disconnect_message = format!("Agent disconnected: {}", agent_id);
            progress::mark_transfer_errored(
                state,
                transfer
                    .progress_id
                    .unwrap_or_else(|| request_id.as_transfer_id()),
                disconnect_message,
            );
            log!(
                Level::Warning,
                "Cleaning up orphaned download stream: request_id={}, agent_id={}",
                request_id,
                agent_id
            );
        }
    }

    for request_id in &orphaned_uploads {
        if let Some(transfer) = state.streams.uploads.remove(request_id) {
            let disconnect_message = format!("Agent disconnected: {}", agent_id);
            progress::mark_transfer_errored(
                state,
                request_id.as_transfer_id(),
                disconnect_message.clone(),
            );
            log!(
                Level::Warning,
                "Cleaning up orphaned upload stream: request_id={}, agent_id={}",
                request_id,
                agent_id
            );
            if let Some(sender) = transfer.completion_sender {
                let _ = sender.send(Err(RouterError::AgentNotFound {
                    agent_id: agent_id.to_string(),
                }));
            }
            if let Some(sender) = transfer.ready_sender {
                let _ = sender.send(Err(RouterError::AgentNotFound {
                    agent_id: agent_id.to_string(),
                }));
            }
        }
    }

    if !orphaned_downloads.is_empty()
        || !orphaned_uploads.is_empty()
        || !orphaned_copy_ids.is_empty()
    {
        ui::notify_transfer_refresh(state);
    }
}

/// Fails only flows that require payload transport while preserving control-plane work.
pub(crate) async fn cleanup_agent_transfer_requests(
    state: &mut RouterState,
    agent_id: &AgentId,
    reason: String,
) {
    let remote_copy_ids: Vec<_> = state
        .copies
        .by_public_id
        .iter()
        .filter(|(_, request)| {
            matches!(request.execution, CopyExecution::RemoteStream { .. })
                && (&request.source_agent_id == agent_id || &request.dest_agent_id == agent_id)
        })
        .map(|(request_id, _)| *request_id)
        .collect();

    for public_request_id in &remote_copy_ids {
        let copy_sides = state
            .copies
            .by_public_id
            .get(public_request_id)
            .and_then(|request| match request.execution {
                CopyExecution::RemoteStream {
                    source_request_id, ..
                } => Some((
                    request.source_agent_id.clone(),
                    request.dest_agent_id.clone(),
                    source_request_id,
                )),
                CopyExecution::LocalAgent { .. } => None,
            });
        if let Some((source_agent_id, dest_agent_id, source_request_id)) = copy_sides {
            if &source_agent_id == agent_id {
                let _ = copy::abort_copy_upload(state, *public_request_id, reason.clone());
            }
            if &dest_agent_id == agent_id
                && let Some(source) = state.agents.by_id.get(&source_agent_id)
            {
                source.send_message(Message::CancelTransfer {
                    request_id: source_request_id,
                });
            }
        }
        progress::mark_transfer_errored(state, *public_request_id, reason.clone());
        copy::cleanup_copy_tracking(state, *public_request_id);
    }

    let download_ids: Vec<_> = state
        .streams
        .downloads
        .iter()
        .filter(|(_, transfer)| &transfer.agent_id == agent_id)
        .map(|(request_id, _)| *request_id)
        .collect();
    for request_id in &download_ids {
        if let Some(transfer) = state.streams.downloads.remove(request_id) {
            progress::mark_transfer_errored(
                state,
                transfer
                    .progress_id
                    .unwrap_or_else(|| request_id.as_transfer_id()),
                reason.clone(),
            );
        }
    }

    let upload_ids: Vec<_> = state
        .streams
        .uploads
        .iter()
        .filter(|(_, transfer)| &transfer.agent_id == agent_id)
        .map(|(request_id, _)| *request_id)
        .collect();
    for request_id in &upload_ids {
        if let Some(transfer) = state.streams.uploads.remove(request_id) {
            progress::mark_transfer_errored(state, request_id.as_transfer_id(), reason.clone());
            if let Some(sender) = transfer.completion_sender {
                let _ = sender.send(Err(RouterError::TransferConnectionUnavailable {
                    agent_id: agent_id.to_string(),
                }));
            }
            if let Some(sender) = transfer.ready_sender {
                let _ = sender.send(Err(RouterError::TransferConnectionUnavailable {
                    agent_id: agent_id.to_string(),
                }));
            }
        }
    }

    if !remote_copy_ids.is_empty() || !download_ids.is_empty() || !upload_ids.is_empty() {
        log!(
            Level::Warning,
            "Transfer connection cleanup: agent_id={}, downloads={}, uploads={}, copies={}",
            agent_id,
            download_ids.len(),
            upload_ids.len(),
            remote_copy_ids.len()
        );
        ui::notify_transfer_refresh(state);
    }
}

/// Marks a direct upload or download as canceled by REST and forwards cancel.
///
/// This is used both for explicit REST-side cancellation and implicit request
/// teardown such as a disconnected upload or download client.
pub(crate) fn cancel_transfer(
    state: &mut RouterState,
    request_id: crate::types::RequestId,
    agent_id: AgentId,
) {
    match state.streams.downloads.get_mut(&request_id) {
        Some(transfer) => {
            if transfer.agent_id != agent_id {
                log!(
                    Level::Warning,
                    "Transfer cancel agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
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
            let progress_id = transfer
                .progress_id
                .unwrap_or_else(|| request_id.as_transfer_id());
            if let Some(agent_connection) = state.agents.by_id.get(&agent_id) {
                agent_connection.send_message(Message::CancelTransfer { request_id });
            }
            // Downloads report cancellation immediately because the client has
            // already stopped consuming the stream at this point.
            progress::mark_transfer_errored(
                state,
                progress_id,
                "Download canceled by client".to_string(),
            );
        }
        None => match state.streams.uploads.get_mut(&request_id) {
            Some(transfer) => {
                if transfer.agent_id != agent_id {
                    log!(
                        Level::Warning,
                        "Transfer cancel agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
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
                // Uploads follow the same rule: once the HTTP request is gone,
                // progress should settle into a terminal canceled state even if
                // the agent's cleanup ack arrives slightly later.
                progress::mark_transfer_errored(
                    state,
                    request_id.as_transfer_id(),
                    "Upload stream canceled by client".to_string(),
                );
                if let Some(agent_connection) = state.agents.by_id.get(&agent_id) {
                    log!(
                        Level::Info,
                        "Sending upload cancel to agent: agent_id={}, request_id={}",
                        agent_id,
                        request_id
                    );
                    agent_connection.send_message(Message::CancelTransfer { request_id });
                }
            }
            None => {
                log!(
                    Level::Warning,
                    "Transfer not found for cancel request: request_id={}",
                    request_id
                );
            }
        },
    }
}
