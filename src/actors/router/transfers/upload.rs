use super::super::RouterError;
use super::super::RouterHandle;
use super::super::cleanup;
use super::super::messages::{
    CommitDirectUploadRequest, FinishUploadChunkRoute, RouterMsg, SendStreamChunkRequest,
    StartUploadRequest, UploadStartOutcome,
};
use super::super::progress::{self, UploadStartContext};
use super::super::state::{DirectUploadKind, RouterState};
use super::super::ui;
use crate::commands::CommandResult;
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message};

/// Starts a direct upload stream and records its progress entry.
///
/// Returns the request id immediately so the HTTP layer can arm cancellation
/// before waiting for destination readiness on a separate channel.
pub(crate) fn start(state: &mut RouterState, request: StartUploadRequest) {
    let request_id = state.next_id();
    let Some(kind) = DirectUploadKind::from_command(&request.command) else {
        let _ = request.reply.send(Err(RouterError::UnexpectedResponseType {
            operation: "starting direct upload command",
        }));
        return;
    };

    log!(
        Level::Info,
        "Routing REST upload command: agent_id={}, request_id={}, command={:?}",
        request.agent_id,
        request_id,
        request.command
    );

    if let Some(agent_connection) = state.agents.by_id.get(&request.agent_id).cloned() {
        if let Err(error) = agent_connection.transfer_connection() {
            log!(
                Level::Warning,
                "Transfer unavailable for upload: agent_id={}",
                request.agent_id
            );
            let _ = request.reply.send(Err(error));
            return;
        }
        if request.reply.is_closed() {
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
        progress::record_upload_start(
            state,
            UploadStartContext {
                request_id,
                agent_id: request.agent_id.clone(),
                path: request.path,
                total_bytes: request.total_bytes,
                completion_sender: request.completion_sender,
                ready_sender: request.ready_sender,
                kind,
            },
        );

        // Caller abandoned the RPC after admission; tear down local state and
        // use the reserved lane so the agent does not retain a temp-file worker.
        if request.reply.send(Ok(request_id)).is_err() {
            if state.streams.uploads.remove(&request_id).is_some() {
                progress::mark_transfer_errored(
                    state,
                    request_id.as_transfer_id(),
                    "Upload stream canceled by client".to_string(),
                );
                ui::notify_transfer_refresh(state);
            }
            let _ = agent_connection.send_priority_message(Message::CancelTransfer { request_id });
        }
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

/// Publishes the edit boundary and transfers terminal delivery to router-owned work.
pub(crate) fn commit(
    state: &mut RouterState,
    myself: &RouterHandle,
    request: CommitDirectUploadRequest,
) {
    let result = validate_commit(state, &request);
    if let Err(error) = result {
        cleanup::cancel_transfer(state, request.request_id, request.agent_id);
        let _ = request.reply.send(Err(error));
        return;
    }

    let progress = state
        .progress
        .entries
        .get_mut(&request.request_id.as_transfer_id())
        .expect("validated edit upload has progress state");
    progress.cancelable = false;
    ui::notify_transfer_refresh_immediately(state);
    route_chunk(
        state,
        myself,
        SendStreamChunkRequest {
            agent_id: request.agent_id,
            request_id: request.request_id,
            chunk: request.chunk,
            reply: request.reply,
        },
    );
}

/// Validates that only the matching live edit can cross the irreversible boundary.
fn validate_commit(
    state: &RouterState,
    request: &CommitDirectUploadRequest,
) -> Result<(), RouterError> {
    let Some(upload) = state.streams.uploads.get(&request.request_id) else {
        return Err(RouterError::StreamNotFound {
            agent_id: request.agent_id.to_string(),
            request_id: request.request_id.to_string(),
        });
    };
    if upload.agent_id != request.agent_id {
        return Err(RouterError::StreamNotFound {
            agent_id: request.agent_id.to_string(),
            request_id: request.request_id.to_string(),
        });
    }
    if upload.kind != DirectUploadKind::EditFile {
        return Err(RouterError::UnexpectedResponseType {
            operation: "beginning edit commit",
        });
    }
    if upload.canceled_by_rest {
        return Err(RouterError::ClientCanceledUpload);
    }

    if request.chunk.request_id != request.request_id
        || !request.chunk.is_last
        || request.chunk.is_error
        || request.chunk.payload_kind != crate::streaming::StreamPayloadKind::RawFile
        || !request.chunk.data.is_empty()
    {
        return Err(RouterError::UnexpectedResponseType {
            operation: "routing edit commit terminal",
        });
    }

    if !state
        .progress
        .entries
        .contains_key(&request.request_id.as_transfer_id())
    {
        return Err(RouterError::StreamNotFound {
            agent_id: request.agent_id.to_string(),
            request_id: request.request_id.to_string(),
        });
    }
    Ok(())
}

/// Releases direct producers only after the destination worker confirms cross-socket readiness.
pub(crate) fn mark_ready(
    state: &mut RouterState,
    agent_id: AgentId,
    request_id: crate::types::RequestId,
) {
    let Some(upload) = state.streams.uploads.get_mut(&request_id) else {
        return;
    };
    if upload.agent_id != agent_id || upload.ready {
        return;
    }
    upload.ready = true;
    let ready_sender = upload.ready_sender.take();

    // A dropped readiness receiver means no body producer remains; cancel so
    // the agent does not keep a temporary-file worker forever.
    if let Some(ready_sender) = ready_sender
        && ready_sender.send(Ok(UploadStartOutcome::Ready)).is_err()
    {
        cleanup::cancel_transfer(state, request_id, agent_id);
        return;
    }

    super::copy::start_source_after_destination_ready(state, agent_id, request_id);
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
        let transfer_connection = match agent_connection.transfer_connection() {
            Ok(connection) => connection,
            Err(error) => {
                fail_upload_route(
                    state,
                    &request.agent_id,
                    request.request_id,
                    error.to_string(),
                );
                let _ = request.reply.send(Err(error));
                return;
            }
        };
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
            let send_succeeded = transfer_connection.send_binary(payload).await;
            let send_result =
                myself.send(RouterMsg::FinishRoutedUploadChunk(FinishUploadChunkRoute {
                    agent_id,
                    request_id,
                    bytes,
                    is_error,
                    send_succeeded,
                    reply,
                }));

            if let Err(tokio::sync::mpsc::error::SendError(message)) = send_result
                && let RouterMsg::FinishRoutedUploadChunk(route) = message
            {
                let _ = route.reply.send(Err(RouterError::RouterStopped {
                    operation: "upload chunk forwarding",
                }));
            }
        });
    } else {
        let error = RouterError::AgentNotFound {
            agent_id: request.agent_id.to_string(),
        };
        fail_upload_route(
            state,
            &request.agent_id,
            request.request_id,
            error.to_string(),
        );
        log!(
            Level::Warning,
            "Agent not found for forwarded upload chunk: agent_id={}, request_id={}",
            request.agent_id,
            request.request_id
        );
        let _ = request.reply.send(Err(error));
    }
}

/// Settles routing failure and ensures any still-connected destination worker is canceled.
fn fail_upload_route(
    state: &mut RouterState,
    agent_id: &AgentId,
    request_id: crate::types::RequestId,
    error_message: String,
) {
    let should_cancel = state
        .streams
        .uploads
        .get_mut(&request_id)
        .is_some_and(|upload| {
            if upload.agent_id != *agent_id || upload.canceled_by_rest {
                return false;
            }
            upload.canceled_by_rest = true;
            true
        });
    progress::mark_transfer_errored(state, request_id.as_transfer_id(), error_message);
    if !should_cancel {
        return;
    }
    if let Some(connection) = state.agents.by_id.get(agent_id) {
        if !connection.send_priority_message(Message::CancelTransfer { request_id }) {
            connection.send_message(Message::CancelTransfer { request_id });
        }
    } else {
        // No control owner remains that could acknowledge cancellation, so local ownership ends now.
        state.streams.uploads.remove(&request_id);
        ui::notify_transfer_refresh(state);
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
        let error = RouterError::UploadForwardFailed {
            agent_id: route.agent_id.to_string(),
            request_id: route.request_id.to_string(),
        };
        fail_upload_route(state, &route.agent_id, route.request_id, error.to_string());

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
            (
                transfer.canceled_by_rest,
                transfer.explicitly_canceled,
                transfer.kind,
                transfer.completion_sender.take(),
                transfer.ready_sender.take(),
            )
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

    let (canceled_by_rest, explicitly_canceled, kind, completion_sender, ready_sender) =
        transfer_state;

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
        if explicitly_canceled && kind.completion_matches(&result) {
            // A destination publication acknowledged before cancel processing remains completed.
            progress::mark_transfer_completed(state, request_id.as_transfer_id());
        } else if explicitly_canceled {
            progress::mark_transfer_canceled(state, request_id.as_transfer_id());
        }
        state.streams.uploads.remove(&request_id);
        ui::notify_transfer_refresh(state);

        if let Some(sender) = completion_sender {
            let _ = sender.send(Err(RouterError::ClientCanceledUpload));
        }
        if let Some(sender) = ready_sender {
            let _ = sender.send(Err(RouterError::ClientCanceledUpload));
        }
        return;
    }

    let completion_result = match &result {
        completion if kind.completion_matches(completion) => {
            progress::mark_transfer_completed(state, request_id.as_transfer_id());
            log!(
                Level::Info,
                "Routing upload completion response: agent_id={}, request_id={}, result={:?}",
                agent_id,
                request_id,
                completion
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
    ui::notify_transfer_refresh(state);

    if let Some(sender) = ready_sender {
        // HTTP is still blocked on readiness when setup fails before TransferReady.
        // Deliver the real completion here so permission/missing-path errors keep
        // their established status mapping instead of becoming a generic 500.
        let _ = sender.send(Ok(UploadStartOutcome::Finished(Box::new(
            completion_result,
        ))));
    } else if let Some(sender) = completion_sender {
        let _ = sender.send(completion_result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{Command, TransferProgressState};
    use crate::types::RequestId;

    /// Builds isolated router state for direct-write transition tests.
    fn router_state() -> RouterState {
        RouterState::new(
            tokio::spawn(async {}),
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        )
    }

    /// Registers one direct write and returns the receiver used by its REST producer.
    fn record_direct_write(
        state: &mut RouterState,
        request_id: RequestId,
        kind: DirectUploadKind,
    ) -> tokio::sync::oneshot::Receiver<Result<CommandResult, RouterError>> {
        let (completion_sender, completion_receiver) = tokio::sync::oneshot::channel();
        let (ready_sender, _ready_receiver) = tokio::sync::oneshot::channel();
        progress::record_upload_start(
            state,
            UploadStartContext {
                request_id,
                agent_id: AgentId::from("agent-1"),
                path: "/tmp/file.txt".to_string(),
                total_bytes: 4,
                completion_sender,
                ready_sender,
                kind,
            },
        );
        completion_receiver
    }

    #[test]
    fn direct_write_kinds_accept_only_their_own_success_result() {
        // Raw uploads must accept only replacement-upload completion.
        assert!(DirectUploadKind::RawUpload.completion_matches(&CommandResult::RawUpload));
        // Tar uploads must not accept an editor completion on their shared transport.
        assert!(!DirectUploadKind::TarUpload.completion_matches(&CommandResult::EditFile));
        // File edits must accept only the dedicated inode-rewrite completion.
        assert!(DirectUploadKind::EditFile.completion_matches(&CommandResult::EditFile));
        // File edits must reject raw-upload success so the REST endpoint cannot report false success.
        assert!(!DirectUploadKind::EditFile.completion_matches(&CommandResult::RawUpload));
    }

    #[tokio::test]
    async fn commit_validation_accepts_only_live_edit_terminals() {
        let mut state = router_state();
        let edit_id = RequestId::new(41);
        let _edit_completion = record_direct_write(&mut state, edit_id, DirectUploadKind::EditFile);
        let (edit_reply, _edit_reply_receiver) = tokio::sync::oneshot::channel();
        let edit_request = CommitDirectUploadRequest {
            agent_id: AgentId::from("agent-1"),
            request_id: edit_id,
            chunk: crate::streaming::StreamChunk {
                request_id: edit_id,
                chunk_index: crate::types::ChunkIndex::new(1),
                is_last: true,
                is_error: false,
                payload_kind: crate::streaming::StreamPayloadKind::RawFile,
                data: Vec::new(),
            },
            reply: edit_reply,
        };

        let edit_result = validate_commit(&state, &edit_request);

        // A matching empty terminal is the only frame allowed to authorize an edit commit.
        assert!(edit_result.is_ok());

        let upload_id = RequestId::new(42);
        let _upload_completion =
            record_direct_write(&mut state, upload_id, DirectUploadKind::RawUpload);
        let (upload_reply, _upload_reply_receiver) = tokio::sync::oneshot::channel();
        let upload_request = CommitDirectUploadRequest {
            agent_id: AgentId::from("agent-1"),
            request_id: upload_id,
            chunk: crate::streaming::StreamChunk {
                request_id: upload_id,
                chunk_index: crate::types::ChunkIndex::new(1),
                is_last: true,
                is_error: false,
                payload_kind: crate::streaming::StreamPayloadKind::RawFile,
                data: Vec::new(),
            },
            reply: upload_reply,
        };

        let upload_result = validate_commit(&state, &upload_request);

        // Replacement uploads do not use the editor's non-atomic commit transition.
        assert!(matches!(
            upload_result,
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        // Validation alone must not publish a boundary before terminal routing is owned.
        assert!(
            state
                .progress
                .entries
                .get(&upload_id.as_transfer_id())
                .unwrap()
                .cancelable
        );

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn mismatched_edit_completion_errors_the_transfer_and_rest_request() {
        crate::logging::init(None).await.unwrap();
        let mut state = router_state();
        let request_id = RequestId::new(43);
        let completion_receiver =
            record_direct_write(&mut state, request_id, DirectUploadKind::EditFile);
        state
            .streams
            .uploads
            .get_mut(&request_id)
            .unwrap()
            .ready_sender
            .take();

        finish_transfer(
            &mut state,
            AgentId::from("agent-1"),
            request_id,
            CommandResult::RawUpload,
        );
        let completion = completion_receiver.await.unwrap();

        // A raw-upload response cannot satisfy the dedicated editor REST request.
        assert!(matches!(
            completion,
            Err(RouterError::UnexpectedResponseType { .. })
        ));
        // Protocol mismatches remain visible in transfer history as errors.
        assert!(matches!(
            state
                .progress
                .entries
                .get(&request_id.as_transfer_id())
                .unwrap()
                .state,
            TransferProgressState::Errored
        ));
        // Terminal mismatch handling must release direct-stream ownership.
        assert!(!state.streams.uploads.contains_key(&request_id));

        state.ui.refresh_check_task.abort();
    }

    #[test]
    fn edit_commands_select_edit_progress_semantics() {
        let command = Command::EditFile {
            path: "/tmp/file.txt".to_string(),
        };

        let kind = DirectUploadKind::from_command(&command).unwrap();

        // The wire command must retain edit identity throughout shared upload transport.
        assert_eq!(kind, DirectUploadKind::EditFile);
        // Public progress must distinguish inode rewrites from replacement uploads.
        assert!(matches!(
            kind.direction(),
            crate::commands::TransferDirection::Edit
        ));
    }
}
