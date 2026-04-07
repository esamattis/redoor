use super::super::RouterError;
use super::super::RouterHandle;
use super::super::cleanup;
use super::super::messages::{
    FinishCopyChunkRoute, RouteStreamChunkRequest, RouterMsg, StartCopyRequest,
    TransferProgressUpdateRequest,
};
use super::super::progress::{self, CopyStartContext};
use super::super::state::{CopyExecution, CopyRequest, DirectDownload, DirectUpload, RouterState};
use crate::commands::{Command, CommandResult};
use crate::log;
use crate::logging::Level;
use crate::streaming::StreamChunkFrameRequest;
use crate::types::Message;
use crate::types::{AgentId, ChunkIndex, RequestId, TransferId};

/// Reframes one source chunk into destination-sized frames and forwards them incrementally.
pub(crate) async fn send_framed_copy_chunk(
    agent_connection: &super::super::state::AgentConnection,
    chunk_index: &mut ChunkIndex,
    request: StreamChunkFrameRequest<'_>,
) -> (usize, bool) {
    let mut frames =
        crate::streaming::StreamChunkFrames::new(request.starting_chunk_index(*chunk_index));
    let mut emitted = 0usize;
    let mut send_succeeded = true;

    while let Some(chunk) = frames.next() {
        emitted += 1;
        if !agent_connection.send_binary(chunk.to_bytes()).await {
            send_succeeded = false;
            break;
        }
    }

    *chunk_index = frames.next_chunk_index();
    (emitted, send_succeeded)
}

/// Removes all router bookkeeping associated with one logical copy request.
pub(crate) fn cleanup_copy_tracking(state: &mut RouterState, public_request_id: TransferId) {
    if let Some(copy_request) = state.copies.by_public_id.remove(&public_request_id) {
        match copy_request.execution {
            CopyExecution::RemoteStream {
                source_request_id,
                dest_request_id,
                ..
            } => {
                state
                    .copies
                    .public_id_by_internal_request
                    .remove(&source_request_id);
                state
                    .copies
                    .public_id_by_internal_request
                    .remove(&dest_request_id);
                state.streams.downloads.remove(&source_request_id);
                state.streams.uploads.remove(&dest_request_id);
            }
            CopyExecution::LocalAgent { request_id, .. } => {
                state
                    .copies
                    .public_id_by_internal_request
                    .remove(&request_id);
                state.streams.uploads.remove(&request_id);
            }
        }
    }
}

/// Sends an error frame to the destination side of a remote copy so it can terminate cleanly.
pub(crate) fn abort_copy_upload(
    state: &mut RouterState,
    public_request_id: TransferId,
    error_message: String,
) -> Result<(), RouterError> {
    let Some(copy_request) = state.copies.by_public_id.get_mut(&public_request_id) else {
        return Err(RouterError::CopyStreamNotFound {
            request_id: public_request_id.to_string(),
        });
    };

    let CopyExecution::RemoteStream {
        dest_request_id,
        next_chunk_index,
        ..
    } = &mut copy_request.execution
    else {
        return Ok(());
    };

    let Some(agent_connection) = state.agents.by_id.get(&copy_request.dest_agent_id).cloned()
    else {
        return Err(RouterError::AgentNotFound {
            agent_id: copy_request.dest_agent_id.to_string(),
        });
    };

    let dest_request_id = *dest_request_id;
    let starting_chunk_index = *next_chunk_index;
    let payload_kind = copy_request.content_kind.payload_kind();

    tokio::spawn(async move {
        let mut next_chunk_index = starting_chunk_index;
        let _ = send_framed_copy_chunk(
            &agent_connection,
            &mut next_chunk_index,
            StreamChunkFrameRequest::new(dest_request_id, error_message.as_bytes())
                .payload_kind(payload_kind)
                .is_error(true),
        )
        .await;
    });

    Ok(())
}

/// Starts either a local-agent copy or a remote streamed copy between agents.
pub(crate) fn start(state: &mut RouterState, request: StartCopyRequest) {
    let source_agent_connection = state.agents.by_id.get(&request.source_agent_id).cloned();
    let dest_agent_connection = state.agents.by_id.get(&request.dest_agent_id).cloned();

    match (source_agent_connection, dest_agent_connection) {
        (Some(source_agent_connection), Some(dest_agent_connection)) => {
            let public_request_id = state.next_id().as_transfer_id();

            progress::record_copy_start(
                state,
                CopyStartContext {
                    request_id: public_request_id,
                    source_agent_id: request.source_agent_id.clone(),
                    source_path: request.source_path.clone(),
                    dest_agent_id: request.dest_agent_id.clone(),
                    dest_path: request.dest_path.clone(),
                    total_bytes: request.total_bytes,
                },
            );

            if request.source_agent_id == request.dest_agent_id {
                let local_request_id = state.next_id();

                state
                    .copies
                    .public_id_by_internal_request
                    .insert(local_request_id, public_request_id);
                state.copies.by_public_id.insert(
                    public_request_id,
                    CopyRequest {
                        source_agent_id: request.source_agent_id.clone(),
                        dest_agent_id: request.dest_agent_id.clone(),
                        execution: CopyExecution::LocalAgent {
                            agent_id: request.source_agent_id.clone(),
                            request_id: local_request_id,
                        },
                        content_kind: request.content_kind,
                    },
                );
                state.streams.uploads.insert(
                    local_request_id,
                    DirectUpload {
                        agent_id: request.source_agent_id.clone(),
                        completion_sender: None,
                        canceled_by_rest: false,
                    },
                );

                let command = match request.content_kind {
                    super::super::state::CopyContentKind::RawFile => Command::LocalCopyFile {
                        source_path: request.source_path.clone(),
                        dest_path: request.dest_path.clone(),
                    },
                    super::super::state::CopyContentKind::TarDirectory => {
                        Command::LocalCopyDirectory {
                            source_path: request.source_path.clone(),
                            dest_path: request.dest_path.clone(),
                        }
                    }
                };

                source_agent_connection.send_message(Message::Command {
                    agent_id: request.source_agent_id,
                    request_id: local_request_id,
                    command,
                });

                let _ = request.reply.send(Ok(public_request_id));
                return;
            }

            let dest_request_id = state.next_id();
            let source_request_id = state.next_id();

            state
                .copies
                .public_id_by_internal_request
                .insert(source_request_id, public_request_id);
            state
                .copies
                .public_id_by_internal_request
                .insert(dest_request_id, public_request_id);
            state.copies.by_public_id.insert(
                public_request_id,
                CopyRequest {
                    source_agent_id: request.source_agent_id.clone(),
                    dest_agent_id: request.dest_agent_id.clone(),
                    execution: CopyExecution::RemoteStream {
                        source_request_id,
                        dest_request_id,
                        next_chunk_index: ChunkIndex::new(0),
                    },
                    content_kind: request.content_kind,
                },
            );

            state.streams.downloads.insert(
                source_request_id,
                DirectDownload {
                    agent_id: request.source_agent_id.clone(),
                    chunk_sender: tokio::sync::mpsc::channel(1).0,
                    canceled_by_rest: false,
                },
            );
            state.streams.uploads.insert(
                dest_request_id,
                DirectUpload {
                    agent_id: request.dest_agent_id.clone(),
                    completion_sender: None,
                    canceled_by_rest: false,
                },
            );

            dest_agent_connection.send_message(Message::Command {
                agent_id: request.dest_agent_id.clone(),
                request_id: dest_request_id,
                command: request
                    .content_kind
                    .upload_command(request.dest_path.clone()),
            });
            source_agent_connection.send_message(Message::Command {
                agent_id: request.source_agent_id.clone(),
                request_id: source_request_id,
                command: request.content_kind.download_command(request.source_path),
            });

            let _ = request.reply.send(Ok(public_request_id));
        }
        (None, _) => {
            let _ = request.reply.send(Err(RouterError::AgentNotFound {
                agent_id: request.source_agent_id.to_string(),
            }));
        }
        (_, None) => {
            let _ = request.reply.send(Err(RouterError::AgentNotFound {
                agent_id: request.dest_agent_id.to_string(),
            }));
        }
    }
}

/// Forwards one remote-copy source chunk to the destination agent incrementally.
pub(crate) fn route_chunk(
    state: &mut RouterState,
    myself: &RouterHandle,
    request: RouteStreamChunkRequest,
) {
    let agent_id = request.agent_id;
    let chunk = request.chunk;
    let reply = request.reply;
    let Some(public_request_id) = state.copies.public_id_for_internal(chunk.request_id) else {
        let _ = reply.send(());
        return;
    };

    let (source_agent_id, dest_agent_id, dest_request_id, mut chunk_index, content_kind) = {
        let Some(copy_request) = state.copies.by_public_id.get_mut(&public_request_id) else {
            let _ = reply.send(());
            return;
        };

        let CopyExecution::RemoteStream {
            source_request_id,
            dest_request_id,
            next_chunk_index,
        } = &mut copy_request.execution
        else {
            let _ = reply.send(());
            return;
        };

        if chunk.request_id != *source_request_id {
            let _ = reply.send(());
            return;
        }

        (
            copy_request.source_agent_id.clone(),
            copy_request.dest_agent_id.clone(),
            *dest_request_id,
            *next_chunk_index,
            copy_request.content_kind,
        )
    };

    if source_agent_id != agent_id {
        log!(
            Level::Warning,
            "Copy source agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
            public_request_id,
            source_agent_id,
            agent_id
        );
        let _ = reply.send(());
        return;
    }

    let Some(dest_agent_connection) = state.agents.by_id.get(&dest_agent_id).cloned() else {
        progress::mark_transfer_errored(
            state,
            public_request_id,
            format!("Agent not found: {}", dest_agent_id),
        );
        cleanup_copy_tracking(state, public_request_id);
        let _ = reply.send(());
        return;
    };

    if chunk.is_error {
        let error_message = if chunk.data.is_empty() {
            "Copy download failed on agent".to_string()
        } else {
            String::from_utf8_lossy(&chunk.data).to_string()
        };

        let _ = abort_copy_upload(state, public_request_id, error_message.clone());
        progress::mark_transfer_errored(state, public_request_id, error_message);
        cleanup_copy_tracking(state, public_request_id);
        let _ = reply.send(());
        return;
    }

    if chunk.payload_kind != content_kind.payload_kind() {
        let error_message = format!(
            "Copy payload kind mismatch: expected {:?}, got {:?}",
            content_kind.payload_kind(),
            chunk.payload_kind
        );
        let _ = abort_copy_upload(state, public_request_id, error_message.clone());
        progress::mark_transfer_errored(state, public_request_id, error_message);
        cleanup_copy_tracking(state, public_request_id);
        let _ = reply.send(());
        return;
    }

    let bytes = chunk.data.len() as u64;
    let source_request_id = chunk.request_id;
    let payload_kind = chunk.payload_kind;
    let is_last = chunk.is_last;
    let chunk_data = chunk.data;
    let myself = myself.clone();

    tokio::spawn(async move {
        let (_, send_succeeded) = send_framed_copy_chunk(
            &dest_agent_connection,
            &mut chunk_index,
            StreamChunkFrameRequest::new(dest_request_id, &chunk_data)
                .payload_kind(payload_kind)
                .is_last(is_last),
        )
        .await;

        let send_result = myself.send(RouterMsg::FinishRoutedCopyChunk(FinishCopyChunkRoute {
            source_agent_id: agent_id,
            public_request_id,
            source_request_id,
            dest_request_id,
            next_chunk_index: chunk_index,
            bytes,
            send_succeeded,
            reply,
        }));

        if let Err(tokio::sync::mpsc::error::SendError(message)) = send_result {
            if let RouterMsg::FinishRoutedCopyChunk(route) = message {
                let _ = route.reply.send(());
            }
        }
    });
}

/// Finalizes one remote-copy chunk after all destination frames have been queued.
pub(crate) fn finish_routed_chunk(state: &mut RouterState, route: &FinishCopyChunkRoute) {
    let Some(copy_request) = state.copies.by_public_id.get_mut(&route.public_request_id) else {
        return;
    };

    let CopyExecution::RemoteStream {
        source_request_id: stored_source_request_id,
        dest_request_id: stored_dest_request_id,
        next_chunk_index: stored_next_chunk_index,
    } = &mut copy_request.execution
    else {
        return;
    };

    if copy_request.source_agent_id != route.source_agent_id
        || *stored_source_request_id != route.source_request_id
        || *stored_dest_request_id != route.dest_request_id
    {
        log!(
            Level::Warning,
            "Copy completion mismatch while finishing routed chunk: request_id={}, expected_source_agent_id={}, actual_source_agent_id={}",
            route.public_request_id,
            copy_request.source_agent_id,
            route.source_agent_id
        );
        return;
    }

    if !route.send_succeeded {
        cleanup::cancel_transfer(
            state,
            route.source_request_id,
            route.source_agent_id.clone(),
        );
        progress::mark_transfer_errored(
            state,
            route.public_request_id,
            "Failed to forward copy chunk to destination agent".to_string(),
        );
        cleanup_copy_tracking(state, route.public_request_id);
        return;
    }

    *stored_next_chunk_index = route.next_chunk_index;

    if route.bytes > 0 {
        progress::increment_bytes(state, route.public_request_id, route.bytes);
    }
}

/// Handles the final command response that completes a local or remote copy.
pub(crate) fn finish_transfer(
    state: &mut RouterState,
    agent_id: AgentId,
    request_id: RequestId,
    result: CommandResult,
) -> bool {
    let Some(public_request_id) = state.copies.public_id_for_internal(request_id) else {
        return false;
    };

    let Some(copy_request) = state.copies.by_public_id.get(&public_request_id) else {
        return false;
    };

    let is_expected_completion = match &copy_request.execution {
        CopyExecution::RemoteStream {
            dest_request_id, ..
        } => *dest_request_id == request_id && copy_request.dest_agent_id == agent_id,
        CopyExecution::LocalAgent {
            agent_id: expected_agent_id,
            request_id: expected_request_id,
        } => *expected_request_id == request_id && expected_agent_id == &agent_id,
    };

    if !is_expected_completion {
        return false;
    }

    match result {
        CommandResult::Error { message, .. } => {
            progress::mark_transfer_errored(state, public_request_id, message);
        }
        CommandResult::LocalCopyFile
            if copy_request.content_kind == super::super::state::CopyContentKind::RawFile =>
        {
            progress::mark_copy_transfer_completed(state, public_request_id, None);
        }
        CommandResult::LocalCopyDirectory
            if copy_request.content_kind == super::super::state::CopyContentKind::TarDirectory =>
        {
            let total_bytes = progress::transferred_bytes(state, public_request_id);
            progress::mark_copy_transfer_completed(state, public_request_id, total_bytes);
        }
        /* <CODEREVIEW>
        Remote directory copies also land in this branch via `TarUpload`, but their `total_bytes`
        starts at 0 and is never replaced with the streamed byte count. `mark_copy_transfer_completed`
        then snaps `transferred_bytes` back to `total_bytes`, so a successful remote directory copy
        finishes as `Completed` with 0 bytes transferred and loses the progress accumulated while the
        tar stream was being forwarded.
        </CODEREVIEW> */
        other if copy_request.content_kind.completion_matches(&other) => {
            progress::mark_copy_transfer_completed(state, public_request_id, None);
        }
        other => {
            log!(
                Level::Warning,
                "Unexpected copy completion response: agent_id={}, request_id={}, result={:?}",
                agent_id,
                request_id,
                other
            );
            progress::mark_transfer_errored(
                state,
                public_request_id,
                "Unexpected copy completion response".to_string(),
            );
        }
    }

    cleanup_copy_tracking(state, public_request_id);
    true
}

/// Applies agent-reported progress updates for local-agent copy operations.
pub(crate) fn update_progress(state: &mut RouterState, request: TransferProgressUpdateRequest) {
    let Some(public_request_id) = state.copies.public_id_for_internal(request.request_id) else {
        return;
    };

    let Some(copy_request) = state.copies.by_public_id.get(&public_request_id) else {
        return;
    };

    let CopyExecution::LocalAgent {
        agent_id: expected_agent_id,
        request_id: expected_request_id,
    } = &copy_request.execution
    else {
        return;
    };

    if expected_agent_id != &request.agent_id || *expected_request_id != request.request_id {
        log!(
            Level::Warning,
            "Copy progress update agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
            public_request_id,
            expected_agent_id,
            request.agent_id
        );
        return;
    }

    progress::set_copy_progress(
        state,
        public_request_id,
        request.transferred_bytes,
        request.total_bytes,
    );
}
