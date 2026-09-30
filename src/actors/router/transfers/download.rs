//! Direct download progress policy stays separate from bounded output transport.

use super::super::{messages::TransferProgressUpdateRequest, progress, state::RouterState, ui};
use crate::commands::{TransferDirection, TransferProgressState};
use crate::types::TransferId;

/// Owns registration and resume selection so neutral transport never decides file-history policy.
pub(crate) fn register(
    state: &mut RouterState,
    context: progress::DownloadStartContext,
    sink: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
) -> super::super::state::OutputOwner {
    super::super::state::OutputOwner::Download {
        progress_id: progress::record_download_start(state, context),
        sink: Some(sink),
    }
}

/// File failures update both history and UI; process failures have neither of these policies.
pub(crate) fn reject(state: &mut RouterState, id: TransferId, message: String) {
    progress::mark_transfer_errored(state, id, message);
    ui::notify_transfer_refresh(state);
}

/// Explicit file cancellation becomes terminal only when the agent has released its worker.
pub(crate) fn acknowledge_cancel(state: &mut RouterState, id: TransferId) {
    if matches!(
        state.progress.entries.get(&id).map(|entry| &entry.state),
        Some(TransferProgressState::Canceling)
    ) {
        progress::mark_transfer_canceled(state, id);
        ui::notify_transfer_refresh(state);
    }
}

/// Applies late archive totals only to the direct download that owns this history row.
pub(crate) fn update_progress(
    state: &mut RouterState,
    request: &TransferProgressUpdateRequest,
) -> bool {
    let Some(id) = state
        .streams
        .outputs
        .get(&request.request_id)
        .filter(|stream| stream.agent_id == request.agent_id)
        .and_then(|stream| stream.owner.download_id())
    else {
        return false;
    };
    let Some(entry) = state.progress.entries.get(&id) else {
        return false;
    };
    if entry.agent_id != request.agent_id || !matches!(entry.direction, TransferDirection::Download)
    {
        return false;
    }
    if matches!(entry.state, TransferProgressState::Active)
        && let Some(total) = request.total_bytes
    {
        progress::set_download_total(state, id, total);
    }
    true
}

/// Accounts only accepted file bytes, preserving resumed transfer history and terminal refreshes.
pub(crate) fn finish_chunk(
    state: &mut RouterState,
    id: TransferId,
    route: &super::super::messages::FinishOutputChunkRoute,
) {
    if let Some(error) = &route.error_message {
        progress::mark_transfer_errored(state, id, error.clone());
    } else {
        progress::increment_bytes(state, id, route.bytes);
        if route.is_last {
            progress::mark_transfer_completed(state, id);
        }
    }
    if route.is_last || route.error_message.is_some() {
        ui::notify_transfer_refresh(state);
    }
}
