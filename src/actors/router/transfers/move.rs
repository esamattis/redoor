use super::super::progress;
use super::super::state::{CopyContentKind, CopyExecution, CopyOperation, RouterState};
use super::copy::cleanup_copy_tracking;
use crate::commands::{Command, CommandResult, MoveSourceIdentity};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message, RequestId, TransferId};

/// Builds the agent-local command while the copy module supplies only shared transport startup.
pub(super) fn local_command(request: &super::super::messages::StartCopyRequest) -> Command {
    Command::LocalMove {
        source_path: request.source_path.clone(),
        dest_path: request.dest_path.clone(),
        source_is_directory: request.content_kind == CopyContentKind::TarDirectory,
        expected_identity: request
            .source_identity
            .clone()
            .expect("move requests must carry the source identity captured at preflight"),
        on_existing: request.on_existing,
    }
}

/// Handles completion phases that are specific to logical move transfers.
pub(crate) fn finish_transfer(
    state: &mut RouterState,
    agent_id: AgentId,
    request_id: RequestId,
    result: CommandResult,
) -> bool {
    let Some(public_request_id) = state.copies.public_id_for_internal(request_id) else {
        return false;
    };
    let Some(move_request) = state.copies.by_public_id.get(&public_request_id) else {
        return false;
    };
    if move_request.operation != CopyOperation::Move {
        return false;
    }

    let is_expected_completion = match &move_request.execution {
        CopyExecution::RemoteStream {
            dest_request_id, ..
        } => *dest_request_id == request_id && move_request.dest_agent_id == agent_id,
        CopyExecution::LocalAgent {
            agent_id: expected_agent_id,
            request_id: expected_request_id,
        }
        | CopyExecution::DeletingMoveSource {
            agent_id: expected_agent_id,
            request_id: expected_request_id,
        } => *expected_request_id == request_id && expected_agent_id == &agent_id,
    };
    if !is_expected_completion {
        return false;
    }

    let deleting_source = matches!(
        move_request.execution,
        CopyExecution::DeletingMoveSource { .. }
    );
    let destination_completed = matches!(
        move_request.execution,
        CopyExecution::RemoteStream { dest_request_id, .. } if dest_request_id == request_id
    ) && move_request.content_kind.completion_matches(&result);
    if destination_completed {
        let source_agent_id = move_request.source_agent_id.clone();
        let source_path = move_request.source_path.clone();
        let source_identity = move_request
            .source_identity
            .clone()
            .expect("remote moves must retain their source identity");
        let final_total_bytes =
            final_total_bytes(state, public_request_id, move_request.content_kind);
        begin_source_deletion(
            state,
            public_request_id,
            source_agent_id,
            source_path,
            source_identity,
            final_total_bytes,
        );
        return true;
    }

    match result {
        CommandResult::Error { message, .. } => {
            progress::mark_transfer_errored(state, public_request_id, message);
        }
        CommandResult::RawDelete if deleting_source => {
            progress::mark_copy_transfer_completed(state, public_request_id, None);
        }
        CommandResult::LocalMove { atomic } => {
            if let Some(entry) = state.progress.entries.get_mut(&public_request_id) {
                // Copy/delete and cross-agent completions never take this arm, so they stay false.
                entry.atomic = atomic;
            }
            let total_bytes =
                final_total_bytes(state, public_request_id, move_request.content_kind);
            progress::mark_copy_transfer_completed(state, public_request_id, total_bytes);
        }
        other => {
            log!(
                Level::Warning,
                "Unexpected move completion response: agent_id={}, request_id={}, result={:?}",
                agent_id,
                request_id,
                other
            );
            progress::mark_transfer_errored(
                state,
                public_request_id,
                "Unexpected move completion response".to_string(),
            );
        }
    }

    cleanup_copy_tracking(state, public_request_id);
    true
}

/// Uses observed stream bytes as the final size for directory moves whose tar size was unknown.
fn final_total_bytes(
    state: &RouterState,
    public_request_id: TransferId,
    content_kind: CopyContentKind,
) -> Option<u64> {
    match content_kind {
        CopyContentKind::TarDirectory => progress::transferred_bytes(state, public_request_id),
        CopyContentKind::RawFile => None,
    }
}

/// Replaces streaming bookkeeping with one control command that deletes the copied source.
fn begin_source_deletion(
    state: &mut RouterState,
    public_request_id: TransferId,
    source_agent_id: AgentId,
    source_path: String,
    source_identity: MoveSourceIdentity,
    final_total_bytes: Option<u64>,
) {
    let delete_request_id = state.next_id();
    if let Some(move_request) = state.copies.by_public_id.get_mut(&public_request_id) {
        if let CopyExecution::RemoteStream {
            source_request_id,
            dest_request_id,
            ..
        } = move_request.execution
        {
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
        move_request.execution = CopyExecution::DeletingMoveSource {
            agent_id: source_agent_id.clone(),
            request_id: delete_request_id,
        };
    }
    state
        .copies
        .public_id_by_internal_request
        .insert(delete_request_id, public_request_id);
    if let Some(total_bytes) = final_total_bytes
        && let Some(entry) = state.progress.entries.get_mut(&public_request_id)
    {
        entry.total_bytes = total_bytes;
    }
    let command_queued = state
        .agents
        .by_id
        .get(&source_agent_id)
        .is_some_and(|source_agent| {
            source_agent.send_message(Message::Command {
                agent_id: source_agent_id,
                request_id: delete_request_id,
                command: Command::DeleteMoveSource {
                    path: source_path,
                    expected_identity: source_identity,
                },
            })
        });
    if !command_queued {
        progress::mark_transfer_errored(
            state,
            public_request_id,
            "Source agent unavailable before move deletion".to_string(),
        );
        cleanup_copy_tracking(state, public_request_id);
    }
}
