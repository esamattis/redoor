use super::RouterError;
use super::router::{DirectDownload, DirectUpload, Router};
use super::ui;
use crate::commands::{
    CopyEndpoint, TransferDirection, TransferProgressEntry, TransferProgressListResponse,
    TransferProgressState,
};
use crate::types::{AgentId, RequestId, TransferId, UnixTimestampSeconds};

/// Inputs needed to register a new direct download in progress tracking.
pub(crate) struct DownloadStartContext {
    /// Internal request id of the direct download stream.
    pub(crate) request_id: RequestId,
    /// Agent producing the download stream.
    pub(crate) agent_id: AgentId,
    /// Path shown in progress listings.
    pub(crate) path: String,
    /// Expected total byte count for the transfer.
    pub(crate) total_bytes: u64,
    /// Bounded sink that receives streamed chunks for the REST caller.
    pub(crate) chunk_sender: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
}

/// Inputs needed to register a new direct upload in progress tracking.
pub(crate) struct UploadStartContext {
    /// Internal request id of the direct upload stream.
    pub(crate) request_id: RequestId,
    /// Agent receiving the upload stream.
    pub(crate) agent_id: AgentId,
    /// Path shown in progress listings.
    pub(crate) path: String,
    /// Expected total byte count for the transfer.
    pub(crate) total_bytes: u64,
    /// Final completion channel for the upload result.
    pub(crate) completion_sender:
        tokio::sync::oneshot::Sender<Result<crate::commands::CommandResult, RouterError>>,
}

/// Inputs needed to register a new copy transfer in progress tracking.
pub(crate) struct CopyStartContext {
    /// Public transfer id for the logical copy.
    pub(crate) request_id: TransferId,
    /// Source agent shown in progress listings.
    pub(crate) source_agent_id: AgentId,
    /// Source path shown in progress listings.
    pub(crate) source_path: String,
    /// Destination agent shown in progress listings.
    pub(crate) dest_agent_id: AgentId,
    /// Destination path shown in progress listings.
    pub(crate) dest_path: String,
    /// Expected total byte count for the copy.
    pub(crate) total_bytes: u64,
}

/// Creates a progress entry and direct-download state for a newly started download.
pub(crate) fn record_download_start(router: &mut Router, context: DownloadStartContext) {
    let transfer_id = context.request_id.as_transfer_id();
    let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    router.progress.entries.insert(
        transfer_id,
        TransferProgressEntry {
            request_id: transfer_id,
            agent_id: context.agent_id.clone(),
            path: context.path,
            source: None,
            dest: None,
            direction: TransferDirection::Download,
            total_bytes: context.total_bytes,
            transferred_bytes: 0,
            started_at: now,
            ended_at: None,
            state: TransferProgressState::Active,
            error: None,
        },
    );
    router.streams.downloads.insert(
        context.request_id,
        DirectDownload {
            agent_id: context.agent_id,
            chunk_sender: context.chunk_sender,
            canceled_by_rest: false,
        },
    );
    ui::notify_refresh(router);
}

/// Creates a progress entry and direct-upload state for a newly started upload.
pub(crate) fn record_upload_start(router: &mut Router, context: UploadStartContext) {
    let transfer_id = context.request_id.as_transfer_id();
    let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    router.progress.entries.insert(
        transfer_id,
        TransferProgressEntry {
            request_id: transfer_id,
            agent_id: context.agent_id.clone(),
            path: context.path,
            source: None,
            dest: None,
            direction: TransferDirection::Upload,
            total_bytes: context.total_bytes,
            transferred_bytes: 0,
            started_at: now,
            ended_at: None,
            state: TransferProgressState::Active,
            error: None,
        },
    );
    router.streams.uploads.insert(
        context.request_id,
        DirectUpload {
            agent_id: context.agent_id,
            completion_sender: Some(context.completion_sender),
            canceled_by_rest: false,
        },
    );
    ui::notify_refresh(router);
}

/// Creates a progress entry for a newly started logical copy transfer.
pub(crate) fn record_copy_start(router: &mut Router, context: CopyStartContext) {
    let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    router.progress.entries.insert(
        context.request_id,
        TransferProgressEntry {
            request_id: context.request_id,
            agent_id: context.dest_agent_id.clone(),
            path: context.dest_path.clone(),
            source: Some(CopyEndpoint {
                agent: context.source_agent_id,
                path: context.source_path,
            }),
            dest: Some(CopyEndpoint {
                agent: context.dest_agent_id,
                path: context.dest_path,
            }),
            direction: TransferDirection::Copy,
            total_bytes: context.total_bytes,
            transferred_bytes: 0,
            started_at: now,
            ended_at: None,
            state: TransferProgressState::Active,
            error: None,
        },
    );
    ui::notify_refresh(router);
}

/// Adds transferred bytes to an existing progress entry and clears stale errors.
pub(crate) fn increment_bytes(router: &mut Router, transfer_id: TransferId, bytes: u64) {
    let mut updated = false;
    if let Some(progress) = router.progress.entries.get_mut(&transfer_id) {
        progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
        progress.error = None;
        updated = true;
    }
    if updated {
        ui::notify_refresh(router);
    }
}

/// Replaces copy progress counts with the latest agent-reported values.
pub(crate) fn set_copy_progress(
    router: &mut Router,
    transfer_id: TransferId,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
) {
    let mut updated = false;
    if let Some(progress) = router.progress.entries.get_mut(&transfer_id) {
        progress.transferred_bytes = transferred_bytes;
        if let Some(total_bytes) = total_bytes {
            progress.total_bytes = total_bytes;
        }
        progress.error = None;
        updated = true;
    }

    if updated {
        ui::notify_refresh(router);
    }
}

/// Marks a transfer as completed and snaps transferred bytes to the total.
pub(crate) fn mark_transfer_completed(router: &mut Router, transfer_id: TransferId) {
    let mut updated = false;
    if let Some(progress) = router.progress.entries.get_mut(&transfer_id) {
        progress.state = TransferProgressState::Completed;
        progress.transferred_bytes = progress.total_bytes;
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = None;
        updated = true;
    }
    if updated {
        ui::notify_refresh_immediately(router);
    }
}

/// Marks a copy as completed, optionally updating its final total byte count first.
pub(crate) fn mark_copy_transfer_completed(
    router: &mut Router,
    transfer_id: TransferId,
    total_bytes: Option<u64>,
) {
    let mut updated = false;
    if let Some(progress) = router.progress.entries.get_mut(&transfer_id) {
        if let Some(total_bytes) = total_bytes {
            progress.total_bytes = total_bytes;
        }
        progress.state = TransferProgressState::Completed;
        progress.transferred_bytes = progress.total_bytes;
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = None;
        updated = true;
    }
    if updated {
        ui::notify_refresh_immediately(router);
    }
}

/// Marks a transfer as failed and stores the surfaced error message.
pub(crate) fn mark_transfer_errored(
    router: &mut Router,
    transfer_id: TransferId,
    error_message: String,
) {
    let mut updated = false;
    if let Some(progress) = router.progress.entries.get_mut(&transfer_id) {
        progress.state = TransferProgressState::Errored;
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = Some(error_message);
        updated = true;
    }
    if updated {
        ui::notify_refresh_immediately(router);
    }
}

/// Reads the currently recorded transferred byte count for one progress entry.
pub(crate) fn transferred_bytes(router: &Router, transfer_id: TransferId) -> Option<u64> {
    router
        .progress
        .entries
        .get(&transfer_id)
        .map(|progress| progress.transferred_bytes)
}

/// Returns all progress entries sorted newest-first for REST and UI consumers.
pub(crate) fn list_transfer_progress(router: &Router) -> TransferProgressListResponse {
    let mut transfers: Vec<_> = router.progress.entries.values().cloned().collect();
    transfers.sort_by(|left, right| right.request_id.cmp(&left.request_id));
    TransferProgressListResponse { transfers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{TransferDirection, TransferProgressState, UiEvent};
    use std::time::Instant;

    #[tokio::test]
    async fn terminal_progress_updates_bypass_ui_refresh_throttle() {
        let refresh_check_task = tokio::spawn(async {});
        let mut router = Router::new(refresh_check_task);
        let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        router.ui.subscribers.insert("ui-1".to_string(), ui_tx);

        let transfer_id = TransferId::new(7);
        router.progress.entries.insert(
            transfer_id,
            TransferProgressEntry {
                request_id: transfer_id,
                agent_id: AgentId::from("agent-1"),
                path: "/tmp/file.bin".to_string(),
                source: None,
                dest: None,
                direction: TransferDirection::Download,
                total_bytes: 16,
                transferred_bytes: 4,
                started_at: UnixTimestampSeconds::new(1),
                ended_at: None,
                state: TransferProgressState::Active,
                error: None,
            },
        );

        ui::notify_refresh(&mut router);
        let first_event = ui_rx
            .recv()
            .await
            .expect("initial refresh should reach subscribers");
        assert!(
            matches!(first_event, UiEvent::Refresh),
            "the setup refresh should confirm the subscriber wiring before the terminal-state assertion"
        );

        router.ui.refresh_pending = true;
        router.ui.last_refresh_sent_at = Some(Instant::now());

        mark_transfer_completed(&mut router, transfer_id);

        let terminal_event = ui_rx
            .recv()
            .await
            .expect("completed transfers should trigger an immediate refresh");
        assert!(
            matches!(terminal_event, UiEvent::Refresh),
            "terminal transfer updates should bypass the normal refresh throttle so the UI reflects completion immediately"
        );
        assert!(
            !router.ui.refresh_pending,
            "the immediate terminal refresh should clear any older trailing refresh instead of leaving a stale refresh queued"
        );

        let progress_entry = router
            .progress
            .entries
            .get(&transfer_id)
            .expect("completed transfer should remain in progress storage");
        assert!(
            matches!(progress_entry.state, TransferProgressState::Completed),
            "the refresh should correspond to a terminal completed progress entry"
        );

        router.ui.refresh_check_task.abort();
    }
}
