use crate::commands::{
    Command, CommandResult, CopyEndpoint, TransferDirection, TransferProgressEntry,
    TransferProgressListResponse, TransferProgressState, UiEvent,
};
use crate::log;
use crate::logging::Level;
use crate::streaming::StreamPayloadKind;
use crate::types::{ChunkIndex, Message, RequestId, TransferId, UnixTimestampSeconds};
use axum::extract::ws::Message as WsMessage;
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Central command router actor (singleton).
///
/// `RouterActor` acts as the hub between the REST API and connected agents.
/// It maintains a registry of all connected agents (each identified by an
/// `AgentInfo` that includes a handle back to the agent's `SessionActor`),
/// and correlates outgoing commands with incoming responses using request IDs.
///
/// When the REST API wants to execute a command on an agent, it sends an
/// `ExecuteCommandRest` message here. The router looks up the target agent's
/// WebSocket send channels and forwards the command over the live connection.
/// When the agent responds, the router matches the response's `request_id`
/// to the waiting REST reply port and completes the round-trip.
pub struct RouterActor;

enum TransferRequest {
    Download {
        agent_id: String,
        chunk_sender: tokio::sync::mpsc::UnboundedSender<crate::streaming::StreamChunk>,
    },
    Upload {
        agent_id: String,
        completion_sender: Option<tokio::sync::oneshot::Sender<Result<CommandResult, String>>>,
    },
}

/// Describes which streaming mode a logical copy transfer is using.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyContentKind {
    RawFile,
    TarDirectory,
}

impl CopyContentKind {
    fn upload_command(self, path: String) -> Command {
        match self {
            Self::RawFile => Command::RawUpload { path },
            Self::TarDirectory => Command::TarUpload { path },
        }
    }

    fn download_command(self, path: String) -> Command {
        match self {
            Self::RawFile => Command::RawDownload {
                path,
                range_start: None,
                range_end: None,
            },
            Self::TarDirectory => Command::TarDownload { path },
        }
    }

    fn payload_kind(self) -> StreamPayloadKind {
        match self {
            Self::RawFile => StreamPayloadKind::RawFile,
            Self::TarDirectory => StreamPayloadKind::Tar,
        }
    }

    fn completion_matches(self, result: &CommandResult) -> bool {
        match self {
            Self::RawFile => matches!(result, CommandResult::RawUpload),
            Self::TarDirectory => matches!(result, CommandResult::TarUpload),
        }
    }
}

enum CopyExecution {
    RemoteStream {
        source_request_id: RequestId,
        dest_request_id: RequestId,
        next_chunk_index: ChunkIndex,
    },
    LocalAgent {
        agent_id: String,
        request_id: RequestId,
    },
}

struct CopyRequest {
    source_agent_id: String,
    dest_agent_id: String,
    execution: CopyExecution,
    /// Tracks whether the copy forwards raw file bytes or tar stream bytes.
    content_kind: CopyContentKind,
}

/// Internal state for the [`RouterActor`].
///
/// Tracks all connected agents and maps in-flight request IDs to their
/// corresponding REST reply ports (for both one-shot and streaming responses).
pub struct RouterState {
    /// Connected agents keyed by `agent_id`, used to route commands to the
    /// correct live session.
    ///
    /// A live session is the currently active in-memory connection to that
    /// agent's `SessionActor`, representing the open WebSocket-backed actor
    /// that can immediately receive routed commands and send responses back.
    agents: HashMap<String, AgentInfo>,

    /// Pending REST command responses keyed by router-generated `request_id`.
    ///
    /// Stores the reply port to complete once the agent responds, together with
    /// the target `agent_id` for cleanup if that agent disconnects mid-request.
    rest_pending_responses: HashMap<RequestId, (RpcReplyPort<CommandResult>, String)>,

    /// Active upload/download transfer requests keyed by internal router request ID.
    ///
    /// The entry keeps the transfer-specific state needed to stream chunks or
    /// complete the transfer when the remote agent finishes.
    transfers: HashMap<RequestId, TransferRequest>,

    /// Transfer progress snapshots keyed by public transfer ID for REST/UI reads.
    transfer_progress: HashMap<TransferId, TransferProgressEntry>,

    /// Active copy operations keyed by the public copy request ID exposed outside
    /// the router.
    copy_requests_by_public_id: HashMap<TransferId, CopyRequest>,

    /// Reverse lookup from internal per-agent request IDs to the public copy
    /// request ID so copy-related responses can be correlated back to one copy job.
    copy_request_ids_by_internal_request: HashMap<RequestId, TransferId>,

    /// Active UI event subscribers keyed by subscriber ID.
    ///
    /// Each sender is used to push real-time router events to one connected UI
    /// consumer.
    ui_subscribers: HashMap<String, tokio::sync::mpsc::UnboundedSender<UiEvent>>,

    /// Monotonically increasing counter used to allocate new router request IDs.
    next_request_id: RequestId,

    /// Timestamp of the most recent UI refresh event broadcast to subscribers.
    last_ui_refresh_sent_at: Option<Instant>,

    /// Whether a refresh happened during the current throttle window and still
    /// needs to be delivered as a trailing refresh event.
    ui_refresh_pending: bool,

    /// Background task that periodically checks whether a throttled trailing UI
    /// refresh can now be delivered.
    ui_refresh_check_task: tokio::task::JoinHandle<()>,
}

/// Metadata about a connected agent, cached at registration time.
///
/// Stored in the router's agent registry and used to route commands directly to
/// the connection's prioritized WebSocket send channels, as well as to enrich
/// responses with registration-time metadata (e.g. `connected_at`, `agent_name`).
#[derive(Clone, Debug)]
pub struct AgentInfo {
    pub agent_name: String,
    pub socket_id: String,
    pub outgoing_text: tokio::sync::mpsc::UnboundedSender<WsMessage>,
    pub outgoing_binary: tokio::sync::mpsc::UnboundedSender<WsMessage>,
    pub connected_at: UnixTimestampSeconds,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub username: String,
}

impl RouterState {
    fn next_id(&mut self) -> RequestId {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.next();
        id
    }
}

impl TransferRequest {
    fn agent_id(&self) -> &str {
        match self {
            Self::Download { agent_id, .. } | Self::Upload { agent_id, .. } => agent_id,
        }
    }
}

/// Messages accepted by the [`RouterActor`].
pub enum RouterMsg {
    /// An agent has connected and identified itself; add it to the registry.
    RegisterAgent {
        agent_id: String,
        agent_name: String,
        socket_id: String,
        outgoing_text: tokio::sync::mpsc::UnboundedSender<WsMessage>,
        outgoing_binary: tokio::sync::mpsc::UnboundedSender<WsMessage>,
        os: String,
        arch: String,
        hostname: String,
        username: String,
    },
    /// An agent has disconnected; remove it from the registry.
    UnregisterAgent {
        agent_id: String,
    },
    /// An agent sent a command response; match it to the pending REST reply port.
    RouteResponse {
        agent_id: String,
        request_id: RequestId,
        result: CommandResult,
    },
    /// Request the list of currently connected agents (used by the REST API).
    GetAgentList {
        reply: RpcReplyPort<HashMap<String, String>>,
    },
    GetTransferProgress {
        reply: RpcReplyPort<TransferProgressListResponse>,
    },
    RegisterUiSubscriber {
        subscriber_id: String,
        sender: tokio::sync::mpsc::UnboundedSender<UiEvent>,
    },
    UnregisterUiSubscriber {
        subscriber_id: String,
    },
    /// Execute a one-shot command on an agent, initiated from the REST API.
    ExecuteCommandRest {
        agent_id: String,
        command: Command,
        reply: RpcReplyPort<CommandResult>,
    },
    /// An agent sent a streaming chunk; forward it to the waiting REST stream sender.
    RouteStreamChunk {
        agent_id: String,
        chunk: crate::streaming::StreamChunk,
    },
    /// Execute a streaming command on an agent, initiated from the REST API.
    ExecuteStreamCommandRest {
        agent_id: String,
        command: Command,
        path: String,
        total_bytes: u64,
        reply: RpcReplyPort<Result<(), String>>,
        chunk_sender: tokio::sync::mpsc::UnboundedSender<crate::streaming::StreamChunk>,
    },
    /// Start a streamed upload command on an agent and return the allocated request id.
    StartUploadStreamRest {
        agent_id: String,
        command: Command,
        path: String,
        total_bytes: u64,
        completion_sender: tokio::sync::oneshot::Sender<Result<CommandResult, String>>,
        reply: RpcReplyPort<Result<RequestId, String>>,
    },
    /// Forward a binary upload chunk from the REST API to the target agent session.
    SendStreamChunkToAgent {
        agent_id: String,
        request_id: RequestId,
        chunk: crate::streaming::StreamChunk,
        reply: RpcReplyPort<Result<(), String>>,
    },
    StartCopyRest {
        source_agent_id: String,
        source_path: String,
        dest_agent_id: String,
        dest_path: String,
        total_bytes: u64,
        content_kind: CopyContentKind,
        reply: RpcReplyPort<Result<TransferId, String>>,
    },
    TransferProgressUpdate {
        agent_id: String,
        request_id: RequestId,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    },
    /// Internal message used by the scheduler loop to check whether a
    /// throttled trailing UI refresh event is now due.
    CheckPendingUiRefresh,
}

impl RouterActor {
    fn send_agent_message(agent_info: &AgentInfo, message: Message) {
        match serde_json::to_string(&message) {
            Ok(json) => {
                if agent_info
                    .outgoing_text
                    .send(WsMessage::Text(json.into()))
                    .is_err()
                {
                    log!(
                        Level::Warning,
                        "Failed to queue text message for agent: socket_id={}",
                        agent_info.socket_id
                    );
                }
            }
            Err(error) => {
                log!(
                    Level::Error,
                    "Failed to serialize message for agent: socket_id={}, error={}",
                    agent_info.socket_id,
                    error
                );
            }
        }
    }

    fn send_agent_binary(agent_info: &AgentInfo, bytes: Vec<u8>) {
        if agent_info
            .outgoing_binary
            .send(WsMessage::Binary(bytes.into()))
            .is_err()
        {
            log!(
                Level::Warning,
                "Failed to queue binary message for agent: socket_id={}",
                agent_info.socket_id
            );
        }
    }

    fn record_download_start(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        request_id: RequestId,
        agent_id: String,
        path: String,
        total_bytes: u64,
        chunk_sender: tokio::sync::mpsc::UnboundedSender<crate::streaming::StreamChunk>,
    ) {
        let transfer_id = request_id.as_transfer_id();
        let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
        state.transfer_progress.insert(
            transfer_id,
            TransferProgressEntry {
                request_id: transfer_id,
                agent_id: agent_id.clone(),
                path,
                source: None,
                dest: None,
                direction: TransferDirection::Download,
                total_bytes,
                transferred_bytes: 0,
                started_at: now,
                ended_at: None,
                state: TransferProgressState::Active,
                error: None,
            },
        );
        state.transfers.insert(
            request_id,
            TransferRequest::Download {
                agent_id,
                chunk_sender,
            },
        );
        Self::notify_ui_refresh(state);
    }

    fn record_upload_start(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        request_id: RequestId,
        agent_id: String,
        path: String,
        total_bytes: u64,
        completion_sender: tokio::sync::oneshot::Sender<Result<CommandResult, String>>,
    ) {
        let transfer_id = request_id.as_transfer_id();
        let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
        state.transfer_progress.insert(
            transfer_id,
            TransferProgressEntry {
                request_id: transfer_id,
                agent_id: agent_id.clone(),
                path,
                source: None,
                dest: None,
                direction: TransferDirection::Upload,
                total_bytes,
                transferred_bytes: 0,
                started_at: now,
                ended_at: None,
                state: TransferProgressState::Active,
                error: None,
            },
        );
        state.transfers.insert(
            request_id,
            TransferRequest::Upload {
                agent_id,
                completion_sender: Some(completion_sender),
            },
        );
        Self::notify_ui_refresh(state);
    }

    fn increment_download_progress(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        transfer_id: TransferId,
        bytes: u64,
    ) {
        let mut updated = false;
        if let Some(progress) = state.transfer_progress.get_mut(&transfer_id) {
            progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
            progress.error = None;
            updated = true;
        }
        if updated {
            Self::notify_ui_refresh(state);
        }
    }

    fn increment_upload_progress(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        transfer_id: TransferId,
        bytes: u64,
    ) {
        let mut updated = false;
        if let Some(progress) = state.transfer_progress.get_mut(&transfer_id) {
            progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
            progress.error = None;
            updated = true;
        }
        if updated {
            Self::notify_ui_refresh(state);
        }
    }

    fn mark_transfer_completed(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        transfer_id: TransferId,
    ) {
        let mut updated = false;
        if let Some(progress) = state.transfer_progress.get_mut(&transfer_id) {
            progress.state = TransferProgressState::Completed;
            progress.transferred_bytes = progress.total_bytes;
            progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
            progress.error = None;
            updated = true;
        }
        if updated {
            Self::notify_ui_refresh(state);
        }
    }

    fn mark_copy_transfer_completed(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        transfer_id: TransferId,
        total_bytes: Option<u64>,
    ) {
        let mut updated = false;
        if let Some(progress) = state.transfer_progress.get_mut(&transfer_id) {
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
            Self::notify_ui_refresh(state);
        }
    }

    fn mark_transfer_errored(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        transfer_id: TransferId,
        error_message: String,
    ) {
        let mut updated = false;
        if let Some(progress) = state.transfer_progress.get_mut(&transfer_id) {
            progress.state = TransferProgressState::Errored;
            progress.ended_at = Some(UnixTimestampSeconds::new(chrono::Utc::now().timestamp()));
            progress.error = Some(error_message);
            updated = true;
        }
        if updated {
            Self::notify_ui_refresh(state);
        }
    }

    fn record_copy_start(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        request_id: TransferId,
        source_agent_id: String,
        source_path: String,
        dest_agent_id: String,
        dest_path: String,
        total_bytes: u64,
    ) {
        let now = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
        state.transfer_progress.insert(
            request_id,
            TransferProgressEntry {
                request_id,
                agent_id: dest_agent_id.clone(),
                path: dest_path.clone(),
                source: Some(CopyEndpoint {
                    agent: source_agent_id,
                    path: source_path,
                }),
                dest: Some(CopyEndpoint {
                    agent: dest_agent_id,
                    path: dest_path,
                }),
                direction: TransferDirection::Copy,
                total_bytes,
                transferred_bytes: 0,
                started_at: now,
                ended_at: None,
                state: TransferProgressState::Active,
                error: None,
            },
        );
        Self::notify_ui_refresh(state);
    }

    fn cleanup_copy_tracking(state: &mut RouterState, public_request_id: TransferId) {
        if let Some(copy_request) = state.copy_requests_by_public_id.remove(&public_request_id) {
            match copy_request.execution {
                CopyExecution::RemoteStream {
                    source_request_id,
                    dest_request_id,
                    ..
                } => {
                    state
                        .copy_request_ids_by_internal_request
                        .remove(&source_request_id);
                    state
                        .copy_request_ids_by_internal_request
                        .remove(&dest_request_id);
                    state.transfers.remove(&source_request_id);
                    state.transfers.remove(&dest_request_id);
                }
                CopyExecution::LocalAgent { request_id, .. } => {
                    state
                        .copy_request_ids_by_internal_request
                        .remove(&request_id);
                    state.transfers.remove(&request_id);
                }
            }
        }
    }

    fn abort_copy_upload(
        state: &mut RouterState,
        public_request_id: TransferId,
        error_message: String,
    ) -> Result<(), String> {
        let Some(copy_request) = state.copy_requests_by_public_id.get_mut(&public_request_id)
        else {
            return Err(format!(
                "Copy stream not found: request_id={}",
                public_request_id
            ));
        };

        let CopyExecution::RemoteStream {
            dest_request_id,
            next_chunk_index,
            ..
        } = &mut copy_request.execution
        else {
            return Ok(());
        };

        let Some(agent_info) = state.agents.get(&copy_request.dest_agent_id).cloned() else {
            return Err(format!("Agent not found: {}", copy_request.dest_agent_id));
        };

        let abort_chunk = crate::streaming::StreamChunk {
            request_id: *dest_request_id,
            chunk_index: *next_chunk_index,
            is_last: true,
            is_error: true,
            payload_kind: copy_request.content_kind.payload_kind(),
            data: error_message.into_bytes(),
        };
        *next_chunk_index = next_chunk_index.saturating_next_index();
        Self::send_agent_binary(&agent_info, abort_chunk.to_bytes());
        Ok(())
    }

    fn route_copy_chunk(
        state: &mut RouterState,
        myself: &ActorRef<RouterMsg>,
        agent_id: String,
        chunk: crate::streaming::StreamChunk,
    ) {
        let Some(public_request_id) = state
            .copy_request_ids_by_internal_request
            .get(&chunk.request_id)
            .copied()
        else {
            return;
        };

        let (source_agent_id, dest_agent_id, dest_request_id, chunk_index, content_kind) = {
            let Some(copy_request) = state.copy_requests_by_public_id.get_mut(&public_request_id)
            else {
                return;
            };

            let CopyExecution::RemoteStream {
                source_request_id,
                dest_request_id,
                next_chunk_index,
            } = &mut copy_request.execution
            else {
                return;
            };

            if chunk.request_id != *source_request_id {
                return;
            }

            let chunk_index = *next_chunk_index;
            *next_chunk_index = next_chunk_index.saturating_next_index();

            (
                copy_request.source_agent_id.clone(),
                copy_request.dest_agent_id.clone(),
                *dest_request_id,
                chunk_index,
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
            return;
        }

        let Some(dest_agent_info) = state.agents.get(&dest_agent_id).cloned() else {
            Self::mark_transfer_errored(
                state,
                myself,
                public_request_id,
                format!("Agent not found: {}", dest_agent_id),
            );
            Self::cleanup_copy_tracking(state, public_request_id);
            return;
        };

        if chunk.is_error {
            let error_message = if chunk.data.is_empty() {
                "Copy download failed on agent".to_string()
            } else {
                String::from_utf8_lossy(&chunk.data).to_string()
            };

            let _ = Self::abort_copy_upload(state, public_request_id, error_message.clone());
            Self::mark_transfer_errored(state, myself, public_request_id, error_message);
            Self::cleanup_copy_tracking(state, public_request_id);
            return;
        }

        if chunk.payload_kind != content_kind.payload_kind() {
            let error_message = format!(
                "Copy payload kind mismatch: expected {:?}, got {:?}",
                content_kind.payload_kind(),
                chunk.payload_kind
            );
            let _ = Self::abort_copy_upload(state, public_request_id, error_message.clone());
            Self::mark_transfer_errored(state, myself, public_request_id, error_message);
            Self::cleanup_copy_tracking(state, public_request_id);
            return;
        }

        let forwarded_chunk = crate::streaming::StreamChunk {
            request_id: dest_request_id,
            chunk_index,
            is_last: chunk.is_last,
            is_error: false,
            payload_kind: chunk.payload_kind,
            data: chunk.data,
        };

        let bytes = forwarded_chunk.data.len() as u64;
        Self::send_agent_binary(&dest_agent_info, forwarded_chunk.to_bytes());

        if bytes > 0 {
            Self::increment_download_progress(state, myself, public_request_id, bytes);
        }
    }

    fn finish_copy_transfer(
        state: &mut RouterState,
        myself: &ActorRef<RouterMsg>,
        agent_id: String,
        request_id: RequestId,
        result: CommandResult,
    ) -> bool {
        let Some(public_request_id) = state
            .copy_request_ids_by_internal_request
            .get(&request_id)
            .copied()
        else {
            return false;
        };

        let Some(copy_request) = state.copy_requests_by_public_id.get(&public_request_id) else {
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
            CommandResult::Error { message } => {
                Self::mark_transfer_errored(state, myself, public_request_id, message);
            }
            CommandResult::LocalCopyFile
                if copy_request.content_kind == CopyContentKind::RawFile =>
            {
                Self::mark_copy_transfer_completed(state, myself, public_request_id, None);
            }
            CommandResult::LocalCopyDirectory
                if copy_request.content_kind == CopyContentKind::TarDirectory =>
            {
                let total_bytes = state
                    .transfer_progress
                    .get(&public_request_id)
                    .map(|progress| progress.transferred_bytes);
                Self::mark_copy_transfer_completed(state, myself, public_request_id, total_bytes);
            }
            other if copy_request.content_kind.completion_matches(&other) => {
                Self::mark_copy_transfer_completed(state, myself, public_request_id, None);
            }
            other => {
                log!(
                    Level::Warning,
                    "Unexpected copy completion response: agent_id={}, request_id={}, result={:?}",
                    agent_id,
                    request_id,
                    other
                );
                Self::mark_transfer_errored(
                    state,
                    myself,
                    public_request_id,
                    "Unexpected copy completion response".to_string(),
                );
            }
        }

        Self::cleanup_copy_tracking(state, public_request_id);
        true
    }

    fn update_copy_progress(
        state: &mut RouterState,
        _myself: &ActorRef<RouterMsg>,
        agent_id: String,
        request_id: RequestId,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        let Some(public_request_id) = state
            .copy_request_ids_by_internal_request
            .get(&request_id)
            .copied()
        else {
            return;
        };

        let Some(copy_request) = state.copy_requests_by_public_id.get(&public_request_id) else {
            return;
        };

        let CopyExecution::LocalAgent {
            agent_id: expected_agent_id,
            request_id: expected_request_id,
        } = &copy_request.execution
        else {
            return;
        };

        if expected_agent_id != &agent_id || *expected_request_id != request_id {
            log!(
                Level::Warning,
                "Copy progress update agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                public_request_id,
                expected_agent_id,
                agent_id
            );
            return;
        }

        let mut updated = false;
        if let Some(progress) = state.transfer_progress.get_mut(&public_request_id) {
            progress.transferred_bytes = transferred_bytes;
            if let Some(total_bytes) = total_bytes {
                progress.total_bytes = total_bytes;
            }
            progress.error = None;
            updated = true;
        }

        if updated {
            Self::notify_ui_refresh(state);
        }
    }

    fn list_transfer_progress(state: &RouterState) -> TransferProgressListResponse {
        let mut transfers: Vec<_> = state.transfer_progress.values().cloned().collect();
        transfers.sort_by(|left, right| right.request_id.cmp(&left.request_id));
        TransferProgressListResponse { transfers }
    }

    const UI_REFRESH_THROTTLE_WINDOW: Duration = Duration::from_secs(5);
    const UI_REFRESH_CHECK_INTERVAL: Duration = Duration::from_millis(250);

    fn notify_ui_refresh(state: &mut RouterState) {
        let now = Instant::now();

        match state.last_ui_refresh_sent_at {
            None => {
                Self::broadcast_ui_event(state, UiEvent::Refresh);
                state.last_ui_refresh_sent_at = Some(now);
                state.ui_refresh_pending = false;
            }
            Some(last_sent_at) => {
                let elapsed = now.saturating_duration_since(last_sent_at);

                if elapsed >= Self::UI_REFRESH_THROTTLE_WINDOW {
                    Self::broadcast_ui_event(state, UiEvent::Refresh);
                    state.last_ui_refresh_sent_at = Some(now);
                    state.ui_refresh_pending = false;
                } else {
                    state.ui_refresh_pending = true;
                }
            }
        }
    }

    fn check_pending_ui_refresh(state: &mut RouterState) {
        if !state.ui_refresh_pending {
            return;
        }

        let now = Instant::now();
        let Some(last_sent_at) = state.last_ui_refresh_sent_at else {
            Self::broadcast_ui_event(state, UiEvent::Refresh);
            state.last_ui_refresh_sent_at = Some(now);
            state.ui_refresh_pending = false;
            return;
        };

        let elapsed = now.saturating_duration_since(last_sent_at);
        if elapsed >= Self::UI_REFRESH_THROTTLE_WINDOW {
            Self::broadcast_ui_event(state, UiEvent::Refresh);
            state.last_ui_refresh_sent_at = Some(now);
            state.ui_refresh_pending = false;
        }
    }

    fn broadcast_ui_event(state: &mut RouterState, event: UiEvent) {
        state.ui_subscribers.retain(|subscriber_id, sender| {
            if sender.send(event.clone()).is_ok() {
                true
            } else {
                log!(
                    Level::Warning,
                    "Removing closed UI subscriber: subscriber_id={}",
                    subscriber_id
                );
                false
            }
        });
    }

    fn route_download_chunk(
        state: &mut RouterState,
        myself: &ActorRef<RouterMsg>,
        agent_id: String,
        chunk: crate::streaming::StreamChunk,
    ) {
        let request_id = chunk.request_id;
        let transfer_id = request_id.as_transfer_id();

        let chunk_sender = match state.transfers.get(&request_id) {
            Some(TransferRequest::Download {
                agent_id: stored_agent_id,
                chunk_sender,
            }) => {
                if stored_agent_id != &agent_id {
                    log!(
                        Level::Warning,
                        "Streaming agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                        request_id,
                        stored_agent_id,
                        agent_id
                    );
                    return;
                }
                chunk_sender.clone()
            }
            Some(TransferRequest::Upload { .. }) => {
                log!(
                    Level::Warning,
                    "Received stream chunk for upload transfer: request_id={}",
                    request_id
                );
                return;
            }
            None => {
                log!(
                    Level::Warning,
                    "No streaming response found for request_id={}",
                    request_id
                );
                return;
            }
        };

        if !chunk.is_error {
            Self::increment_download_progress(state, myself, transfer_id, chunk.data.len() as u64);
        }

        // This send only forwards an already-received agent chunk into the REST
        // response body stream. An error here does not mean the agent-side file
        // read failed. It means the HTTP response body receiver was already
        // dropped on the server side, typically because the client stopped
        // consuming the response or disconnected while the download was in
        // flight.
        if let Err(_error) = chunk_sender.send(chunk.clone()) {
            log!(
                Level::Warning,
                "Failed to send chunk to REST stream: request_id={}",
                request_id
            );
            Self::mark_transfer_errored(
                state,
                myself,
                transfer_id,
                "REST stream receiver dropped before download completed".to_string(),
            );
            state.transfers.remove(&request_id);
            Self::notify_ui_refresh(state);
            return;
        }

        if chunk.is_error {
            let error_message = if chunk.data.is_empty() {
                "Download failed on agent".to_string()
            } else {
                String::from_utf8_lossy(&chunk.data).to_string()
            };
            Self::mark_transfer_errored(state, myself, transfer_id, error_message);
        } else if chunk.is_last {
            Self::mark_transfer_completed(state, myself, transfer_id);
        }

        if chunk.is_last || chunk.is_error {
            state.transfers.remove(&request_id);
            Self::notify_ui_refresh(state);
            log!(
                Level::Info,
                "Streaming complete: agent_id={}, request_id={}, total_chunks={}, is_error={}",
                agent_id,
                request_id,
                chunk.chunk_index.display_number(),
                chunk.is_error
            );
        }
    }

    fn finish_upload_transfer(
        state: &mut RouterState,
        myself: &ActorRef<RouterMsg>,
        agent_id: String,
        request_id: RequestId,
        result: CommandResult,
    ) {
        let completion_sender = match state.transfers.get_mut(&request_id) {
            Some(TransferRequest::Upload {
                agent_id: stored_agent_id,
                completion_sender,
            }) => {
                if stored_agent_id != &agent_id {
                    log!(
                        Level::Warning,
                        "Upload response agent mismatch: request_id={}, expected_agent_id={}, actual_agent_id={}",
                        request_id,
                        stored_agent_id,
                        agent_id
                    );
                    return;
                }
                completion_sender.take()
            }
            Some(TransferRequest::Download { .. }) => {
                log!(
                    Level::Warning,
                    "Received command response for download transfer: request_id={}, result={:?}",
                    request_id,
                    result
                );
                return;
            }
            None => {
                log!(
                    Level::Warning,
                    "No pending response found for request_id={}",
                    request_id
                );
                return;
            }
        };

        let completion_result = match &result {
            CommandResult::RawUpload => {
                Self::mark_transfer_completed(state, myself, request_id.as_transfer_id());
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
                Self::mark_transfer_errored(
                    state,
                    myself,
                    request_id.as_transfer_id(),
                    message.clone(),
                );
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
                Self::mark_transfer_errored(
                    state,
                    myself,
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

        state.transfers.remove(&request_id);
        Self::notify_ui_refresh(state);

        if let Some(sender) = completion_sender {
            let _ = sender.send(completion_result);
        }
    }

    fn cleanup_agent_requests(
        state: &mut RouterState,
        myself: &ActorRef<RouterMsg>,
        agent_id: &str,
    ) {
        let orphaned_oneshot: Vec<RequestId> = state
            .rest_pending_responses
            .iter()
            .filter(|(_, (_, pending_agent_id))| pending_agent_id == agent_id)
            .map(|(request_id, _)| *request_id)
            .collect();

        for request_id in &orphaned_oneshot {
            if let Some((reply, _)) = state.rest_pending_responses.remove(request_id) {
                log!(
                    Level::Warning,
                    "Cleaning up orphaned pending response: request_id={}, agent_id={}",
                    request_id,
                    agent_id
                );
                let _ = reply.send(CommandResult::Error {
                    message: format!("Agent disconnected: {}", agent_id),
                });
            }
        }

        let orphaned_copy_ids: Vec<TransferId> = state
            .copy_requests_by_public_id
            .iter()
            .filter(|(_, copy_request)| match &copy_request.execution {
                CopyExecution::RemoteStream { .. } => {
                    copy_request.source_agent_id == agent_id
                        || copy_request.dest_agent_id == agent_id
                }
                CopyExecution::LocalAgent {
                    agent_id: local_agent_id,
                    ..
                } => local_agent_id == agent_id,
            })
            .map(|(request_id, _)| *request_id)
            .collect();

        for request_id in &orphaned_copy_ids {
            let _ = Self::abort_copy_upload(
                state,
                *request_id,
                format!("Agent disconnected: {}", agent_id),
            );
            Self::mark_transfer_errored(
                state,
                myself,
                *request_id,
                format!("Agent disconnected: {}", agent_id),
            );
            Self::cleanup_copy_tracking(state, *request_id);
        }

        let orphaned_transfers: Vec<RequestId> = state
            .transfers
            .iter()
            .filter(|(_, transfer)| transfer.agent_id() == agent_id)
            .map(|(request_id, _)| *request_id)
            .collect();

        for request_id in &orphaned_transfers {
            if let Some(transfer) = state.transfers.remove(request_id) {
                let disconnect_message = format!("Agent disconnected: {}", agent_id);
                match transfer {
                    TransferRequest::Download { .. } => {
                        Self::mark_transfer_errored(
                            state,
                            myself,
                            request_id.as_transfer_id(),
                            disconnect_message.clone(),
                        );
                        log!(
                            Level::Warning,
                            "Cleaning up orphaned download stream: request_id={}, agent_id={}",
                            request_id,
                            agent_id
                        );
                    }
                    TransferRequest::Upload {
                        completion_sender, ..
                    } => {
                        Self::mark_transfer_errored(
                            state,
                            myself,
                            request_id.as_transfer_id(),
                            disconnect_message.clone(),
                        );
                        log!(
                            Level::Warning,
                            "Cleaning up orphaned upload stream: request_id={}, agent_id={}",
                            request_id,
                            agent_id
                        );
                        if let Some(sender) = completion_sender {
                            let _ = sender.send(Err(disconnect_message.clone()));
                        }
                    }
                }
            }
        }

        if !orphaned_transfers.is_empty() || !orphaned_copy_ids.is_empty() {
            Self::notify_ui_refresh(state);
        }
    }
}

impl Actor for RouterActor {
    type Msg = RouterMsg;
    type State = RouterState;
    type Arguments = ();

    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        _args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        log!(Level::Info, "RouterActor started");
        let router_ref = myself.clone();
        let ui_refresh_check_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Self::UI_REFRESH_CHECK_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;
                if router_ref.cast(RouterMsg::CheckPendingUiRefresh).is_err() {
                    break;
                }
            }
        });

        Ok(RouterState {
            agents: HashMap::new(),
            rest_pending_responses: HashMap::new(),
            transfers: HashMap::new(),
            transfer_progress: HashMap::new(),
            copy_requests_by_public_id: HashMap::new(),
            copy_request_ids_by_internal_request: HashMap::new(),
            ui_subscribers: HashMap::new(),
            next_request_id: RequestId::new(1),
            last_ui_refresh_sent_at: None,
            ui_refresh_pending: false,
            ui_refresh_check_task,
        })
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        state.ui_refresh_check_task.abort();
        Ok(())
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            RouterMsg::RegisterAgent {
                agent_id,
                agent_name,
                socket_id,
                outgoing_text,
                outgoing_binary,
                os,
                arch,
                hostname,
                username,
            } => {
                let duplicate_name = state
                    .agents
                    .values()
                    .any(|info| info.agent_name == agent_name);

                if duplicate_name {
                    log!(
                        Level::Error,
                        "Agent with name '{}' already registered, rejecting connection",
                        agent_name
                    );
                    let duplicate_error = Message::Error {
                        message: format!("Agent with name '{}' already connected", agent_name),
                    };
                    let duplicate_agent_info = AgentInfo {
                        agent_name: agent_name.clone(),
                        socket_id,
                        outgoing_text,
                        outgoing_binary,
                        connected_at: UnixTimestampSeconds::new(chrono::Utc::now().timestamp()),
                        os,
                        arch,
                        hostname,
                        username,
                    };
                    Self::send_agent_message(&duplicate_agent_info, duplicate_error);
                    return Ok(());
                }

                log!(
                    Level::Info,
                    "Agent registered: agent_id={}, agent_name={}, socket_id={}",
                    agent_id,
                    agent_name,
                    socket_id
                );
                let connected_at = UnixTimestampSeconds::new(chrono::Utc::now().timestamp());
                state.agents.insert(
                    agent_id.clone(),
                    AgentInfo {
                        agent_name,
                        socket_id,
                        outgoing_text,
                        outgoing_binary,
                        connected_at,
                        os,
                        arch,
                        hostname,
                        username,
                    },
                );
                Self::notify_ui_refresh(state);
            }
            RouterMsg::UnregisterAgent { agent_id } => {
                log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
                state.agents.remove(&agent_id);
                Self::notify_ui_refresh(state);

                Self::cleanup_agent_requests(state, &myself, &agent_id);
            }
            RouterMsg::RouteResponse {
                agent_id,
                request_id,
                result,
            } => {
                if let Some((reply, stored_agent_id)) =
                    state.rest_pending_responses.remove(&request_id)
                {
                    let result_to_send = match (&result, state.agents.get(&stored_agent_id)) {
                        (CommandResult::GetAgentDetails(details), Some(agent_info)) => {
                            // Agent returns runtime data (pid, cwd, load averages, system uptime, os, arch, hostname, username)
                            // but doesn't have access to registration metadata (id, name, connected_at) stored in router cache
                            // Fill in these fields from cached registration data before returning to REST API caller
                            let mut details = details.clone();
                            details.id = stored_agent_id.clone();
                            details.name = agent_info.agent_name.clone();
                            details.connected_at = agent_info.connected_at;
                            CommandResult::GetAgentDetails(details)
                        }
                        _ => result.clone(),
                    };

                    let _ = reply.send(result_to_send);
                } else {
                    if Self::finish_copy_transfer(
                        state,
                        &myself,
                        agent_id.clone(),
                        request_id,
                        result.clone(),
                    ) {
                        return Ok(());
                    }
                    // RouteResponse is used for any final CommandResult coming back from an agent,
                    // not only for one-shot REST commands. Uploads stream their payload as binary
                    // chunks, but the final success/error still arrives as a CommandResult keyed by
                    // the same request_id, so if there is no pending REST reply this may still be
                    // the completion of an in-flight upload transfer.
                    Self::finish_upload_transfer(state, &myself, agent_id, request_id, result);
                }
            }
            RouterMsg::GetAgentList { reply } => {
                let agents: HashMap<String, String> = state
                    .agents
                    .iter()
                    .map(|(id, info)| (id.clone(), info.agent_name.clone()))
                    .collect();
                let _ = reply.send(agents);
            }
            RouterMsg::GetTransferProgress { reply } => {
                let _ = reply.send(Self::list_transfer_progress(state));
            }
            RouterMsg::TransferProgressUpdate {
                agent_id,
                request_id,
                transferred_bytes,
                total_bytes,
            } => {
                Self::update_copy_progress(
                    state,
                    &myself,
                    agent_id,
                    request_id,
                    transferred_bytes,
                    total_bytes,
                );
            }
            RouterMsg::RegisterUiSubscriber {
                subscriber_id,
                sender,
            } => {
                log!(
                    Level::Info,
                    "UI subscriber registered: subscriber_id={}",
                    subscriber_id
                );
                state.ui_subscribers.insert(subscriber_id, sender);
            }
            RouterMsg::UnregisterUiSubscriber { subscriber_id } => {
                log!(
                    Level::Info,
                    "UI subscriber unregistered: subscriber_id={}",
                    subscriber_id
                );
                state.ui_subscribers.remove(&subscriber_id);
            }
            RouterMsg::CheckPendingUiRefresh => {
                Self::check_pending_ui_refresh(state);
            }
            RouterMsg::ExecuteCommandRest {
                agent_id,
                command,
                reply,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Trace,
                    "Routing REST command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );
                if let Some(agent_info) = state.agents.get(&agent_id) {
                    state
                        .rest_pending_responses
                        .insert(request_id, (reply, agent_id.clone()));
                    Self::send_agent_message(
                        agent_info,
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    );
                } else {
                    let _ = reply.send(CommandResult::Error {
                        message: format!("Agent not found: {}", agent_id),
                    });
                }
            }
            RouterMsg::RouteStreamChunk { agent_id, chunk } => {
                let is_remote_copy_stream = state
                    .copy_request_ids_by_internal_request
                    .get(&chunk.request_id)
                    .and_then(|public_request_id| {
                        state.copy_requests_by_public_id.get(public_request_id)
                    })
                    .map(|copy_request| {
                        matches!(copy_request.execution, CopyExecution::RemoteStream { .. })
                    })
                    .unwrap_or(false);

                if is_remote_copy_stream {
                    Self::route_copy_chunk(state, &myself, agent_id, chunk);
                } else {
                    Self::route_download_chunk(state, &myself, agent_id, chunk);
                }
            }
            RouterMsg::ExecuteStreamCommandRest {
                agent_id,
                command,
                path,
                total_bytes,
                reply,
                chunk_sender,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Info,
                    "Routing REST streaming command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );

                if let Some(agent_info) = state.agents.get(&agent_id).cloned() {
                    Self::record_download_start(
                        state,
                        &myself,
                        request_id,
                        agent_id.clone(),
                        path.clone(),
                        total_bytes,
                        chunk_sender,
                    );

                    Self::send_agent_message(
                        &agent_info,
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    );
                    let _ = reply.send(Ok(()));
                } else {
                    log!(
                        Level::Warning,
                        "Agent not found for streaming command: agent_id={}",
                        agent_id
                    );
                    let _ = reply.send(Err(format!("Agent not found: {}", agent_id)));
                }
            }
            RouterMsg::StartUploadStreamRest {
                agent_id,
                command,
                path,
                total_bytes,
                completion_sender,
                reply,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Info,
                    "Routing REST upload command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );

                if let Some(agent_info) = state.agents.get(&agent_id).cloned() {
                    Self::record_upload_start(
                        state,
                        &myself,
                        request_id,
                        agent_id.clone(),
                        path.clone(),
                        total_bytes,
                        completion_sender,
                    );

                    Self::send_agent_message(
                        &agent_info,
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    );
                    let _ = reply.send(Ok(request_id));
                } else {
                    log!(
                        Level::Warning,
                        "Agent not found for upload command: agent_id={}",
                        agent_id
                    );
                    let _ = reply.send(Err(format!("Agent not found: {}", agent_id)));
                }
            }
            RouterMsg::SendStreamChunkToAgent {
                agent_id,
                request_id,
                chunk,
                reply,
            } => {
                let has_matching_upload = matches!(
                    state.transfers.get(&request_id),
                    Some(TransferRequest::Upload {
                        agent_id: stored_agent_id,
                        ..
                    }) if stored_agent_id == &agent_id
                );

                if !has_matching_upload {
                    log!(
                        Level::Warning,
                        "Upload stream not found for forwarded chunk: agent_id={}, request_id={}",
                        agent_id,
                        request_id
                    );
                    let _ = reply.send(Err(format!(
                        "Upload stream not found: agent_id={}, request_id={}",
                        agent_id, request_id
                    )));
                } else if let Some(agent_info) = state.agents.get(&agent_id).cloned() {
                    if !chunk.is_error {
                        Self::increment_upload_progress(
                            state,
                            &myself,
                            request_id.as_transfer_id(),
                            chunk.data.len() as u64,
                        );
                    }

                    if chunk.is_error {
                        let error_message = if chunk.data.is_empty() {
                            "Upload aborted by server".to_string()
                        } else {
                            String::from_utf8_lossy(&chunk.data).to_string()
                        };
                        Self::mark_transfer_errored(
                            state,
                            &myself,
                            request_id.as_transfer_id(),
                            error_message,
                        );
                    }

                    Self::send_agent_binary(&agent_info, chunk.to_bytes());
                    let _ = reply.send(Ok(()));
                } else {
                    Self::mark_transfer_errored(
                        state,
                        &myself,
                        request_id.as_transfer_id(),
                        format!("Agent not found: {}", agent_id),
                    );
                    log!(
                        Level::Warning,
                        "Agent not found for forwarded upload chunk: agent_id={}, request_id={}",
                        agent_id,
                        request_id
                    );
                    let _ = reply.send(Err(format!("Agent not found: {}", agent_id)));
                }
            }
            RouterMsg::StartCopyRest {
                source_agent_id,
                source_path,
                dest_agent_id,
                dest_path,
                total_bytes,
                content_kind,
                reply,
            } => {
                let source_agent_info = state.agents.get(&source_agent_id).cloned();
                let dest_agent_info = state.agents.get(&dest_agent_id).cloned();

                match (source_agent_info, dest_agent_info) {
                    (Some(source_agent_info), Some(dest_agent_info)) => {
                        let public_request_id = state.next_id().as_transfer_id();

                        Self::record_copy_start(
                            state,
                            &myself,
                            public_request_id,
                            source_agent_id.clone(),
                            source_path.clone(),
                            dest_agent_id.clone(),
                            dest_path.clone(),
                            total_bytes,
                        );

                        if source_agent_id == dest_agent_id {
                            let local_request_id = state.next_id();

                            state
                                .copy_request_ids_by_internal_request
                                .insert(local_request_id, public_request_id);
                            state.copy_requests_by_public_id.insert(
                                public_request_id,
                                CopyRequest {
                                    source_agent_id: source_agent_id.clone(),
                                    dest_agent_id: dest_agent_id.clone(),
                                    execution: CopyExecution::LocalAgent {
                                        agent_id: source_agent_id.clone(),
                                        request_id: local_request_id,
                                    },
                                    content_kind,
                                },
                            );
                            state.transfers.insert(
                                local_request_id,
                                TransferRequest::Upload {
                                    agent_id: source_agent_id.clone(),
                                    completion_sender: None,
                                },
                            );

                            let command = match content_kind {
                                CopyContentKind::RawFile => Command::LocalCopyFile {
                                    source_path: source_path.clone(),
                                    dest_path: dest_path.clone(),
                                },
                                CopyContentKind::TarDirectory => Command::LocalCopyDirectory {
                                    source_path: source_path.clone(),
                                    dest_path: dest_path.clone(),
                                },
                            };

                            let _ =
                                Self::send_agent_message(
                                    &source_agent_info,
                                    Message::Command {
                                        agent_id: source_agent_id.clone(),
                                        request_id: local_request_id,
                                        command,
                                    },
                                );

                            let _ = reply.send(Ok(public_request_id));
                            return Ok(());
                        }

                        let dest_request_id = state.next_id();
                        let source_request_id = state.next_id();

                        state
                            .copy_request_ids_by_internal_request
                            .insert(source_request_id, public_request_id);
                        state
                            .copy_request_ids_by_internal_request
                            .insert(dest_request_id, public_request_id);
                        state.copy_requests_by_public_id.insert(
                            public_request_id,
                            CopyRequest {
                                source_agent_id: source_agent_id.clone(),
                                dest_agent_id: dest_agent_id.clone(),
                                execution: CopyExecution::RemoteStream {
                                    source_request_id,
                                    dest_request_id,
                                    next_chunk_index: ChunkIndex::new(0),
                                },
                                content_kind,
                            },
                        );

                        state.transfers.insert(
                            source_request_id,
                            TransferRequest::Download {
                                agent_id: source_agent_id.clone(),
                                chunk_sender: tokio::sync::mpsc::unbounded_channel().0,
                            },
                        );
                        state.transfers.insert(
                            dest_request_id,
                            TransferRequest::Upload {
                                agent_id: dest_agent_id.clone(),
                                completion_sender: None,
                            },
                        );

                        Self::send_agent_message(
                            &dest_agent_info,
                            Message::Command {
                                agent_id: dest_agent_id.clone(),
                                request_id: dest_request_id,
                                command: content_kind.upload_command(dest_path.clone()),
                            },
                        );
                        Self::send_agent_message(
                            &source_agent_info,
                            Message::Command {
                                agent_id: source_agent_id.clone(),
                                request_id: source_request_id,
                                command: content_kind.download_command(source_path),
                            },
                        );

                        let _ = reply.send(Ok(public_request_id));
                    }
                    (None, _) => {
                        let _ = reply.send(Err(format!("Agent not found: {}", source_agent_id)));
                    }
                    (_, None) => {
                        let _ = reply.send(Err(format!("Agent not found: {}", dest_agent_id)));
                    }
                }
            }
        }
        Ok(())
    }
}
