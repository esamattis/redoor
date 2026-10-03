use super::RouterError;
use super::state::{DirectUpload, DirectUploadKind, RouterState, TransferProgressStore};
use super::ui;
use crate::commands::{
    CopyEndpoint, TransferDirection, TransferProgressEntry, TransferProgressListResponse,
    TransferProgressState,
};
use crate::types::{AgentId, RequestId, TransferId, UnixTimestampSeconds};

/// Recent history stays useful without growing with the server lifetime.
const MAX_TERMINAL_HISTORY: usize = 1000;
/// Old terminal rows expire even when fewer than the count limit have accumulated.
const TERMINAL_HISTORY_TTL_SECONDS: i64 = 3600;
/// Canceled downloads need the same continuation window as range restart matching.
const DOWNLOAD_RESUME_WINDOW_SECONDS: i64 = 60;
/// Maintenance uses the existing router tick without scanning history four times a second.
const HISTORY_PRUNE_INTERVAL_SECONDS: i64 = 60;

impl TransferProgressStore {
    /// Bounds terminal history while leaving live workers and recent resumable downloads intact.
    ///
    /// Resumable downloads may temporarily exceed the count cap for their 60-second
    /// continuation window. Active and canceling transfers are never history victims.
    pub(crate) fn prune_terminal_history(&mut self, now: UnixTimestampSeconds) -> bool {
        let previous_len = self.entries.len();
        self.last_pruned_at = Some(now);
        let mut candidates = Vec::new();
        self.entries.retain(|id, entry| {
            if matches!(
                entry.state,
                TransferProgressState::Active | TransferProgressState::Canceling
            ) {
                return true;
            }
            let ended_at = entry.ended_at.unwrap_or(entry.started_at);
            let age = now.0.saturating_sub(ended_at.0);
            if matches!(entry.direction, TransferDirection::Download)
                && matches!(entry.state, TransferProgressState::Errored)
                && entry.error.as_deref() == Some("Download canceled by client")
                && age <= DOWNLOAD_RESUME_WINDOW_SECONDS
            {
                return true;
            }
            if age >= TERMINAL_HISTORY_TTL_SECONDS {
                return false;
            }
            candidates.push((ended_at, *id));
            true
        });
        candidates.sort_unstable_by_key(|(ended_at, id)| (ended_at.0, *id));
        let excess = candidates.len().saturating_sub(MAX_TERMINAL_HISTORY);
        for (_, id) in candidates.iter().take(excess) {
            self.entries.remove(id);
        }
        self.predicted_download_totals
            .retain(|id| self.entries.contains_key(id));
        // Shrinking releases hash-table buckets after a burst of protected resumable rows.
        self.entries
            .shrink_to(self.entries.len().max(MAX_TERMINAL_HISTORY));
        self.predicted_download_totals
            .shrink_to(self.predicted_download_totals.len());
        self.entries.len() != previous_len
    }

    /// Idle servers must also release expired rows after the resume window closes.
    pub(crate) fn prune_history_if_due(&mut self, now: UnixTimestampSeconds) -> bool {
        if self
            .last_pruned_at
            .is_some_and(|last| now.0.saturating_sub(last.0) < HISTORY_PRUNE_INTERVAL_SECONDS)
        {
            return false;
        }
        let previous_len = self.entries.len();
        self.prune_terminal_history(now);
        self.entries.len() != previous_len
    }
}

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
    /// Full file size used to validate a range continuation candidate.
    pub(crate) full_size: Option<u64>,
    /// Starting file offset when this request may resume a canceled download.
    pub(crate) resume_offset: Option<u64>,
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
    /// Readiness acknowledgement held until the destination worker is ready.
    pub(crate) ready_sender:
        tokio::sync::oneshot::Sender<Result<super::messages::UploadStartOutcome, RouterError>>,
    /// Controls completion matching and the public transfer direction.
    pub(crate) kind: DirectUploadKind,
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
    /// Public direction keeps moves distinct while they reuse copy transport.
    pub(crate) direction: TransferDirection,
}

/// Records file progress without taking ownership of the underlying output transport.
pub(crate) fn record_download_start(
    state: &mut RouterState,
    context: DownloadStartContext,
) -> TransferId {
    let transfer_id = context.request_id.as_transfer_id();
    let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    let restart_offset = context
        .full_size
        .map(|_| context.resume_offset.unwrap_or(0));
    let resumed_transfer_id = restart_offset.and_then(|restart_offset| {
        let full_size = context.full_size?;
        state
            .progress
            .entries
            .values()
            .filter(|entry| {
                entry.agent_id == context.agent_id
                    && entry.path == context.path
                    && matches!(entry.direction, TransferDirection::Download)
                    && matches!(entry.state, TransferProgressState::Errored)
                    && entry.error.as_deref() == Some("Download canceled by client")
                    && entry.total_bytes == full_size
                    && entry.ended_at.is_some_and(|ended_at| {
                        now.0.saturating_sub(ended_at.0) <= DOWNLOAD_RESUME_WINDOW_SECONDS
                    })
                    && (context.resume_offset.is_none()
                        || (entry.transferred_bytes >= restart_offset
                            && entry.transferred_bytes - restart_offset
                                <= crate::streaming::MAX_TRANSFER_FRAME_PAYLOAD_BYTES as u64))
            })
            .max_by_key(|entry| entry.request_id)
            .map(|entry| entry.request_id)
    });
    let progress_id = resumed_transfer_id.unwrap_or(transfer_id);

    if let Some(restart_offset) = restart_offset
        && let Some(progress) =
            resumed_transfer_id.and_then(|progress_id| state.progress.entries.get_mut(&progress_id))
    {
        // A client retry may restart the full request or overlap one queued frame with a range.
        progress.transferred_bytes = restart_offset;
        progress.state = TransferProgressState::Active;
        progress.cancelable = true;
        progress.ended_at = None;
        progress.error = None;
    } else {
        state.progress.entries.insert(
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
                cancelable: true,
                error: None,
                atomic: false,
            },
        );
    }
    // Transfer creation must reach the persistent UI bar before progress-update throttling begins.
    ui::notify_transfer_refresh_immediately(state);
    progress_id
}

/// Creates a progress entry and direct-upload state for a newly started upload.
pub(crate) fn record_upload_start(state: &mut RouterState, context: UploadStartContext) {
    let transfer_id = context.request_id.as_transfer_id();
    let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    state.progress.entries.insert(
        transfer_id,
        TransferProgressEntry {
            request_id: transfer_id,
            agent_id: context.agent_id.clone(),
            path: context.path,
            source: None,
            dest: None,
            direction: context.kind.direction(),
            total_bytes: context.total_bytes,
            transferred_bytes: 0,
            started_at: now,
            ended_at: None,
            state: TransferProgressState::Active,
            cancelable: true,
            error: None,
            atomic: false,
        },
    );
    state.streams.uploads.insert(
        context.request_id,
        DirectUpload {
            agent_id: context.agent_id,
            completion_sender: Some(context.completion_sender),
            ready_sender: Some(context.ready_sender),
            ready: false,
            canceled_by_rest: false,
            explicitly_canceled: false,
            kind: context.kind,
        },
    );
    // Transfer creation must reach the persistent UI bar before progress-update throttling begins.
    ui::notify_transfer_refresh_immediately(state);
}

/// Creates a progress entry for a newly started logical copy transfer.
pub(crate) fn record_copy_start(state: &mut RouterState, context: CopyStartContext) {
    let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
    state.progress.entries.insert(
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
            direction: context.direction,
            total_bytes: context.total_bytes,
            transferred_bytes: 0,
            started_at: now,
            ended_at: None,
            state: TransferProgressState::Active,
            cancelable: true,
            error: None,
            atomic: false,
        },
    );
    // Transfer creation must reach the persistent UI bar before progress-update throttling begins.
    ui::notify_transfer_refresh_immediately(state);
}

/// Adds transferred bytes to an existing progress entry and clears stale errors.
pub(crate) fn increment_bytes(state: &mut RouterState, transfer_id: TransferId, bytes: u64) {
    let mut updated = false;
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
        progress.error = None;
        updated = true;
    }
    if updated {
        ui::notify_transfer_refresh(state);
    }
}

/// Replaces copy progress counts with the latest agent-reported values.
pub(crate) fn set_copy_progress(
    state: &mut RouterState,
    transfer_id: TransferId,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
) {
    let mut updated = false;
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        progress.transferred_bytes = transferred_bytes;
        if let Some(total_bytes) = total_bytes {
            progress.total_bytes = total_bytes;
        }
        progress.error = None;
        updated = true;
    }

    if updated {
        ui::notify_transfer_refresh(state);
    }
}

/// Records a later-discovered download total without rewriting counted bytes.
///
/// Directory archives start with `total_bytes=0` and learn the tar size from a
/// metadata walk. Chunk `increment_bytes` remains the source of transferred counts.
pub(crate) fn set_download_total(
    state: &mut RouterState,
    transfer_id: TransferId,
    total_bytes: u64,
) {
    let mut updated = false;
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        if !matches!(progress.direction, TransferDirection::Download) {
            return;
        }
        if !matches!(progress.state, TransferProgressState::Active) {
            return;
        }
        progress.total_bytes = total_bytes;
        state.progress.predicted_download_totals.insert(transfer_id);
        updated = true;
    }
    if updated {
        ui::notify_transfer_refresh(state);
    }
}

/// Marks a transfer as completed and aligns transferred/total byte counts.
///
/// Unknown totals promote the counted stream size so the row does not reset to
/// zero. Known-size files still snap transferred to the planned total. A later
/// directory prediction that disagrees keeps the counted tar bytes so completed
/// UI does not display a stale archive estimate.
pub(crate) fn mark_transfer_completed(state: &mut RouterState, transfer_id: TransferId) {
    let mut updated = false;
    let mut routes_changed = false;
    let had_predicted_download_total = state
        .progress
        .predicted_download_totals
        .remove(&transfer_id);
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        progress.state = TransferProgressState::Completed;
        progress.cancelable = false;
        if progress.total_bytes == 0
            || (had_predicted_download_total && progress.transferred_bytes != progress.total_bytes)
        {
            progress.total_bytes = progress.transferred_bytes;
        } else {
            progress.transferred_bytes = progress.total_bytes;
        }
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = None;
        updated = true;
        routes_changed = matches!(
            progress.direction,
            TransferDirection::Upload | TransferDirection::Edit
        );
    }
    if updated {
        state
            .progress
            .prune_terminal_history(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        ui::notify_transfer_refresh_immediately(state);
        if routes_changed {
            ui::notify_routes_changed(state);
        }
    }
}

/// Marks a copy as completed, optionally updating its final total byte count first.
pub(crate) fn mark_copy_transfer_completed(
    state: &mut RouterState,
    transfer_id: TransferId,
    total_bytes: Option<u64>,
) {
    let mut updated = false;
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        if let Some(total_bytes) = total_bytes {
            progress.total_bytes = total_bytes;
        }
        progress.state = TransferProgressState::Completed;
        progress.cancelable = false;
        progress.transferred_bytes = progress.total_bytes;
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = None;
        updated = true;
    }
    if updated {
        state
            .progress
            .prune_terminal_history(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        ui::notify_transfer_refresh_immediately(state);
        ui::notify_routes_changed(state);
    }
}

/// Marks a transfer as failed and stores the surfaced error message.
pub(crate) fn mark_transfer_errored(
    state: &mut RouterState,
    transfer_id: TransferId,
    error_message: String,
) {
    let mut updated = false;
    let mut routes_changed = false;
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        // An edit becomes non-cancelable immediately before terminal delivery authorizes rewrite.
        routes_changed =
            matches!(progress.direction, TransferDirection::Edit) && !progress.cancelable;
        progress.state = TransferProgressState::Errored;
        progress.cancelable = false;
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = Some(error_message);
        state
            .progress
            .predicted_download_totals
            .remove(&transfer_id);
        updated = true;
    }
    if updated {
        state
            .progress
            .prune_terminal_history(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        ui::notify_transfer_refresh_immediately(state);
        if routes_changed {
            ui::notify_routes_changed(state);
        }
    }
}

/// Publishes cancellation intent before control messages are sent to transfer workers.
pub(crate) fn mark_transfer_canceling(state: &mut RouterState, transfer_id: TransferId) {
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        progress.state = TransferProgressState::Canceling;
        progress.cancelable = false;
        progress.error = None;
        ui::notify_transfer_refresh_immediately(state);
    }
}

/// Settles an acknowledged cancellation without discarding partial byte progress.
pub(crate) fn mark_transfer_canceled(state: &mut RouterState, transfer_id: TransferId) {
    if let Some(progress) = state.progress.entries.get_mut(&transfer_id) {
        progress.state = TransferProgressState::Canceled;
        progress.cancelable = false;
        progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        progress.error = None;
        state
            .progress
            .predicted_download_totals
            .remove(&transfer_id);
        state
            .progress
            .prune_terminal_history(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
        ui::notify_transfer_refresh_immediately(state);
    }
}

/// Reads the currently recorded transferred byte count for one progress entry.
pub(crate) fn transferred_bytes(state: &RouterState, transfer_id: TransferId) -> Option<u64> {
    state
        .progress
        .entries
        .get(&transfer_id)
        .map(|progress| progress.transferred_bytes)
}

/// Returns all progress entries sorted newest-first for REST and UI consumers.
pub(crate) fn list_transfer_progress(state: &RouterState) -> TransferProgressListResponse {
    let mut transfers: Vec<_> = state.progress.entries.values().cloned().collect();
    transfers.sort_by_key(|transfer| std::cmp::Reverse(transfer.request_id));
    TransferProgressListResponse { transfers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{TransferDirection, TransferProgressState, UiEvent};
    use std::time::Instant;

    /// Builds explicit terminal timestamps so history retention tests need no wall-clock waits.
    fn terminal_entry(id: u64, ended_at: i64) -> TransferProgressEntry {
        let mut entry = download_progress_entry(
            TransferId::new(id),
            4096,
            2048,
            TransferProgressState::Completed,
        );
        entry.ended_at = Some(UnixTimestampSeconds::new(ended_at));
        entry
    }

    /// Mixed transfer domains must share one history budget while in-flight rows remain owned.
    #[test]
    fn terminal_history_bounds_mixed_rows_and_preserves_live_transfers() {
        let mut store = TransferProgressStore::default();
        for id in 1..=2000 {
            let mut entry = terminal_entry(id, 9000 + id as i64);
            entry.direction = match id % 5 {
                0 => TransferDirection::Download,
                1 => TransferDirection::Upload,
                2 => TransferDirection::Edit,
                3 => TransferDirection::Copy,
                _ => TransferDirection::Move,
            };
            entry.state = match id % 3 {
                0 => TransferProgressState::Completed,
                1 => TransferProgressState::Canceled,
                _ => TransferProgressState::Errored,
            };
            store.entries.insert(entry.request_id, entry);
        }
        for (id, state) in [
            (2001, TransferProgressState::Active),
            (2002, TransferProgressState::Canceling),
        ] {
            let mut entry = terminal_entry(id, 1);
            entry.state = state;
            entry.ended_at = None;
            store.entries.insert(entry.request_id, entry);
        }
        store.predicted_download_totals.insert(TransferId::new(1));
        store
            .predicted_download_totals
            .insert(TransferId::new(2001));

        assert!(
            store.prune_terminal_history(UnixTimestampSeconds::new(11000)),
            "a long server lifetime must discard excess finished transfers"
        );
        assert_eq!(
            store.entries.len(),
            MAX_TERMINAL_HISTORY + 2,
            "live worker rows must not consume or be evicted by the terminal history budget"
        );
        assert!(
            !store.entries.contains_key(&TransferId::new(1000)),
            "the oldest finished rows must be evicted first"
        );
        assert!(
            store.entries.contains_key(&TransferId::new(1001)),
            "the newest thousand finished rows must remain available to REST readers"
        );
        assert!(
            store.entries.contains_key(&TransferId::new(2001))
                && store.entries.contains_key(&TransferId::new(2002)),
            "active and canceling transfers remain addressable even when their timestamps are old"
        );
        assert_eq!(
            store.predicted_download_totals.len(),
            1,
            "auxiliary totals must not keep keys for evicted history"
        );
    }

    /// Idle maintenance expires rows and ends temporary overflow after resume protection lapses.
    #[test]
    fn idle_pruning_releases_expired_history_and_resume_overflow() {
        let mut store = TransferProgressStore::default();
        for id in 1..=2000 {
            let mut entry = terminal_entry(id, 10000);
            entry.state = TransferProgressState::Errored;
            entry.error = Some("Download canceled by client".to_string());
            store.entries.insert(entry.request_id, entry);
        }
        store.prune_terminal_history(UnixTimestampSeconds::new(10060));
        assert_eq!(
            store.entries.len(),
            2000,
            "the inclusive 60-second continuation window must survive count pressure"
        );
        assert!(
            !store.prune_history_if_due(UnixTimestampSeconds::new(10061)),
            "the periodic UI tick must not rescan all history every 250 milliseconds"
        );
        assert!(
            store.prune_history_if_due(UnixTimestampSeconds::new(10120)),
            "the existing periodic task must remove overflow even without new transfers"
        );
        assert_eq!(
            store.entries.len(),
            MAX_TERMINAL_HISTORY,
            "expired resume protection must return history to its normal count budget"
        );
        assert!(
            store.prune_history_if_due(UnixTimestampSeconds::new(13600)),
            "terminal rows must expire at their one-hour TTL even below the count cap"
        );
        assert!(
            store.entries.is_empty(),
            "idle servers must release all expired history"
        );
        assert!(
            store.entries.capacity() < 2000,
            "pruning must release oversized hash-table buckets after a burst"
        );
    }

    /// Pruning must preserve logical download identity for the existing client retry workflow.
    #[tokio::test]
    async fn recent_download_resumes_after_history_pruning() {
        let mut state = RouterState::new(
            tokio::spawn(async {}),
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let now = chrono::Utc::now().timestamp();
        for id in 1..=1500 {
            state
                .progress
                .entries
                .insert(TransferId::new(id), terminal_entry(id, now - 120));
        }
        let mut entry = terminal_entry(1501, now);
        entry.state = TransferProgressState::Errored;
        entry.error = Some("Download canceled by client".to_string());
        state.progress.entries.insert(entry.request_id, entry);
        state
            .progress
            .prune_terminal_history(UnixTimestampSeconds::new(now));

        let progress_id = record_download_start(
            &mut state,
            DownloadStartContext {
                request_id: RequestId::new(2000),
                agent_id: AgentId::from("agent-1"),
                path: "/tmp/archive".to_string(),
                total_bytes: 2048,
                full_size: Some(4096),
                resume_offset: Some(2048),
            },
        );
        assert_eq!(
            progress_id,
            TransferId::new(1501),
            "history pressure must not turn a resumed download into a duplicate logical transfer"
        );
        let resumed = &state.progress.entries[&progress_id];
        assert!(
            matches!(resumed.state, TransferProgressState::Active) && resumed.ended_at.is_none(),
            "a resumed row must leave terminal retention and remain protected as active"
        );
        state
            .progress
            .prune_terminal_history(UnixTimestampSeconds::new(now + 3600));
        assert_eq!(
            state.progress.entries.len(),
            1,
            "resumed workers must survive TTL cleanup after all other finished rows expire"
        );
        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn transfer_start_bypasses_ui_refresh_throttle() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert("ui-1".to_string(), ui_tx);
        state.ui.refresh_pending = true;
        state.ui.last_refresh_sent_at = Some(Instant::now());

        record_copy_start(
            &mut state,
            CopyStartContext {
                request_id: TransferId::new(8),
                source_agent_id: AgentId::from("agent-1"),
                source_path: "/tmp/source.bin".to_string(),
                dest_agent_id: AgentId::from("agent-2"),
                dest_path: "/tmp/destination.bin".to_string(),
                total_bytes: 16,
                direction: TransferDirection::Copy,
            },
        );

        let start_event = ui_rx
            .recv()
            .await
            .expect("new transfers should trigger an immediate refresh");
        assert!(
            matches!(start_event, UiEvent::TransfersChanged),
            "transfer creation should bypass the throttle so the persistent UI bar updates immediately"
        );
        assert!(
            !state.ui.refresh_pending,
            "an immediate start refresh should replace any older pending refresh"
        );

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn agent_refresh_does_not_consume_transfer_throttle() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert("ui-1".to_string(), ui_tx);

        ui::notify_agents_changed(&mut state);

        let agent_event = ui_rx
            .recv()
            .await
            .expect("agent changes should reach UI subscribers");
        assert!(
            matches!(agent_event, UiEvent::AgentsChanged),
            "agent changes should identify the affected cache domain"
        );
        assert!(
            state.ui.last_refresh_sent_at.is_none(),
            "agent events should not delay the next transfer progress event"
        );

        ui::notify_transfer_refresh(&mut state);
        let transfer_event = ui_rx
            .recv()
            .await
            .expect("the first transfer change should remain immediate");
        assert!(
            matches!(transfer_event, UiEvent::TransfersChanged),
            "transfer changes should identify the affected cache domain"
        );

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn terminal_progress_updates_bypass_ui_refresh_throttle() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert("ui-1".to_string(), ui_tx);

        let transfer_id = TransferId::new(7);
        state.progress.entries.insert(
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
                cancelable: true,
                error: None,
                atomic: false,
            },
        );

        ui::notify_transfer_refresh(&mut state);
        let first_event = ui_rx
            .recv()
            .await
            .expect("initial refresh should reach subscribers");
        assert!(
            matches!(first_event, UiEvent::TransfersChanged),
            "the setup refresh should confirm the subscriber wiring before the terminal-state assertion"
        );

        state.ui.refresh_pending = true;
        state.ui.last_refresh_sent_at = Some(Instant::now());

        mark_transfer_completed(&mut state, transfer_id);

        let terminal_event = ui_rx
            .recv()
            .await
            .expect("completed transfers should trigger an immediate refresh");
        assert!(
            matches!(terminal_event, UiEvent::TransfersChanged),
            "terminal transfer updates should bypass the normal refresh throttle so the UI reflects completion immediately"
        );
        assert!(
            !state.ui.refresh_pending,
            "the immediate terminal refresh should clear any older trailing refresh instead of leaving a stale refresh queued"
        );

        let progress_entry = state
            .progress
            .entries
            .get(&transfer_id)
            .expect("completed transfer should remain in progress storage");
        assert!(
            matches!(progress_entry.state, TransferProgressState::Completed),
            "the refresh should correspond to a terminal completed progress entry"
        );
        assert_eq!(
            progress_entry.transferred_bytes, 16,
            "known-size file downloads still snap transferred to the planned total"
        );
        assert_eq!(
            progress_entry.total_bytes, 16,
            "a partial last-chunk count must not rewrite a known file size"
        );

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn completed_edits_refresh_browser_routes() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert("ui-1".to_string(), ui_tx);
        let transfer_id = TransferId::new(10);
        state.progress.entries.insert(
            transfer_id,
            TransferProgressEntry {
                request_id: transfer_id,
                agent_id: AgentId::from("agent-1"),
                path: "/tmp/file.txt".to_string(),
                source: None,
                dest: None,
                direction: TransferDirection::Edit,
                total_bytes: 4,
                transferred_bytes: 4,
                started_at: UnixTimestampSeconds::new(1),
                ended_at: None,
                state: TransferProgressState::Active,
                cancelable: false,
                error: None,
                atomic: false,
            },
        );

        mark_transfer_completed(&mut state, transfer_id);

        // Completion must immediately refresh transfer state before route consumers reload data.
        assert!(matches!(
            ui_rx.recv().await,
            Some(UiEvent::TransfersChanged)
        ));
        // An inode rewrite changes visible file metadata/content and must invalidate browser routes.
        assert!(matches!(ui_rx.recv().await, Some(UiEvent::RoutesChanged)));

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn errored_edits_after_commit_refresh_browser_routes() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert("ui-1".to_string(), ui_tx);
        let transfer_id = TransferId::new(11);
        state.progress.entries.insert(
            transfer_id,
            TransferProgressEntry {
                request_id: transfer_id,
                agent_id: AgentId::from("agent-1"),
                path: "/tmp/file.txt".to_string(),
                source: None,
                dest: None,
                direction: TransferDirection::Edit,
                total_bytes: 4,
                transferred_bytes: 4,
                started_at: UnixTimestampSeconds::new(1),
                ended_at: None,
                state: TransferProgressState::Active,
                cancelable: false,
                error: None,
                atomic: false,
            },
        );

        mark_transfer_errored(
            &mut state,
            transfer_id,
            "commit failed after truncation".to_string(),
        );

        // Error state remains immediately visible in the persistent transfer UI.
        assert!(matches!(
            ui_rx.recv().await,
            Some(UiEvent::TransfersChanged)
        ));
        // A non-cancelable edit may have changed bytes, so browser data must be invalidated.
        assert!(matches!(ui_rx.recv().await, Some(UiEvent::RoutesChanged)));

        state.ui.refresh_check_task.abort();
    }

    fn download_progress_entry(
        transfer_id: TransferId,
        total_bytes: u64,
        transferred_bytes: u64,
        state: TransferProgressState,
    ) -> TransferProgressEntry {
        let cancelable = matches!(state, TransferProgressState::Active);
        TransferProgressEntry {
            request_id: transfer_id,
            agent_id: AgentId::from("agent-1"),
            path: "/tmp/archive".to_string(),
            source: None,
            dest: None,
            direction: TransferDirection::Download,
            total_bytes,
            transferred_bytes,
            started_at: UnixTimestampSeconds::new(1),
            ended_at: None,
            state,
            cancelable,
            error: None,
            atomic: false,
        }
    }

    #[tokio::test]
    async fn download_total_leaves_counted_bytes_alone() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let transfer_id = TransferId::new(11);
        state.progress.entries.insert(
            transfer_id,
            download_progress_entry(transfer_id, 0, 4096, TransferProgressState::Active),
        );

        set_download_total(&mut state, transfer_id, 8192);

        let progress = state
            .progress
            .entries
            .get(&transfer_id)
            .expect("active download should keep its progress row");
        assert_eq!(
            progress.total_bytes, 8192,
            "the metadata walk should publish the predicted tar size once it is known"
        );
        assert_eq!(
            progress.transferred_bytes, 4096,
            "download totals must not overwrite bytes already counted from tar chunks"
        );

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn late_download_total_is_ignored_after_completion() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let transfer_id = TransferId::new(12);
        state.progress.entries.insert(
            transfer_id,
            download_progress_entry(transfer_id, 2048, 2048, TransferProgressState::Completed),
        );

        set_download_total(&mut state, transfer_id, 9999);

        let progress = state
            .progress
            .entries
            .get(&transfer_id)
            .expect("completed download should remain listed");
        assert_eq!(
            progress.total_bytes, 2048,
            "a walk that finishes after the transfer must not rewrite the completed total"
        );
        assert_eq!(
            progress.transferred_bytes, 2048,
            "late totals must also leave the counted completion bytes untouched"
        );

        state.ui.refresh_check_task.abort();
    }

    #[tokio::test]
    async fn mismatched_download_prediction_keeps_counted_bytes() {
        let refresh_check_task = tokio::spawn(async {});
        let mut state = RouterState::new(
            refresh_check_task,
            crate::terminal_registry::TerminalRegistry::new(),
            crate::log_registry::LogRegistry::new(),
        );
        let transfer_id = TransferId::new(13);
        state.progress.entries.insert(
            transfer_id,
            download_progress_entry(transfer_id, 0, 4096, TransferProgressState::Active),
        );
        set_download_total(&mut state, transfer_id, 5000);

        mark_transfer_completed(&mut state, transfer_id);

        let progress = state
            .progress
            .entries
            .get(&transfer_id)
            .expect("completed download should remain listed");
        assert_eq!(
            progress.transferred_bytes, 4096,
            "tree changes must keep the counted tar bytes instead of snapping to the prediction"
        );
        assert_eq!(
            progress.total_bytes, 4096,
            "completed UI reads the total, so a stale prediction must be replaced by the counted size"
        );

        state.ui.refresh_check_task.abort();
    }
}
