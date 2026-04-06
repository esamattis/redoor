use super::RouterError;
use crate::commands::{Command, CommandResult, TransferProgressEntry};
use crate::streaming::{StreamChunk, StreamPayloadKind};
use crate::types::{AgentId, ChunkIndex, RequestId, SocketId, TransferId, UnixTimestampSeconds};
use axum::extract::ws::Message as WsMessage;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Clone, Debug)]
/// Registration metadata and websocket send handles for one connected agent.
pub struct AgentInfo {
    /// Human-readable name shown in the UI.
    pub agent_name: String,
    /// Unique websocket session identifier for logging.
    pub socket_id: SocketId,
    /// Unbounded control-message lane for websocket text frames.
    pub outgoing_text: tokio::sync::mpsc::UnboundedSender<WsMessage>,
    /// Bounded binary-message lane for websocket streaming frames.
    pub outgoing_binary: tokio::sync::mpsc::Sender<WsMessage>,
    /// Registration timestamp stored by the router.
    pub connected_at: UnixTimestampSeconds,
    /// Operating system string reported at registration time.
    pub os: String,
    /// CPU architecture string reported at registration time.
    pub arch: String,
    /// Hostname reported at registration time.
    pub hostname: String,
    /// Username reported at registration time.
    pub username: String,
}

#[derive(Default)]
/// Registry of currently connected agents keyed by agent id.
pub struct AgentRegistry {
    /// Connected agents addressable by their stable agent id.
    pub(crate) by_id: HashMap<AgentId, AgentInfo>,
}

#[derive(Default)]
/// Pending one-shot REST replies waiting for a final command response.
pub struct PendingRestReplies {
    /// Reply ports plus owning agent ids keyed by internal request id.
    pub(crate) by_request_id:
        HashMap<RequestId, (tokio::sync::oneshot::Sender<CommandResult>, AgentId)>,
}

/// State tracked for one direct download stream flowing from agent to REST.
pub struct DirectDownload {
    /// Agent currently producing this stream.
    pub(crate) agent_id: AgentId,
    /// Bounded REST-facing sink that receives forwarded chunks.
    pub(crate) chunk_sender: tokio::sync::mpsc::Sender<StreamChunk>,
    /// Whether REST-side teardown already triggered cancellation for this
    /// upload, used to suppress duplicate forwarding and duplicate completion.
    pub(crate) canceled_by_rest: bool,
}

/// State tracked for one direct upload stream flowing from REST to agent.
pub struct DirectUpload {
    /// Agent currently receiving this upload.
    pub(crate) agent_id: AgentId,
    /// Optional final-result channel for REST uploads that expect completion.
    pub(crate) completion_sender:
        Option<tokio::sync::oneshot::Sender<Result<CommandResult, RouterError>>>,
    /// Whether the REST side has already requested cancellation.
    pub(crate) canceled_by_rest: bool,
}

#[derive(Default)]
/// Active direct upload and download streams keyed by internal request id.
pub struct StreamTransferRegistry {
    /// Direct download streams keyed by the router-generated request id.
    pub(crate) downloads: HashMap<RequestId, DirectDownload>,
    /// Direct upload streams keyed by the router-generated request id.
    pub(crate) uploads: HashMap<RequestId, DirectUpload>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyContentKind {
    RawFile,
    TarDirectory,
}

impl CopyContentKind {
    /// Builds the destination-side upload command for this copy mode.
    pub(crate) fn upload_command(self, path: String) -> Command {
        match self {
            Self::RawFile => Command::RawUpload { path },
            Self::TarDirectory => Command::TarUpload { path },
        }
    }

    /// Builds the source-side download command for this copy mode.
    pub(crate) fn download_command(self, path: String) -> Command {
        match self {
            Self::RawFile => Command::RawDownload {
                path,
                range_start: None,
                range_end: None,
            },
            Self::TarDirectory => Command::TarDownload { path },
        }
    }

    /// Maps the copy mode to the expected streaming payload kind.
    pub(crate) fn payload_kind(self) -> StreamPayloadKind {
        match self {
            Self::RawFile => StreamPayloadKind::RawFile,
            Self::TarDirectory => StreamPayloadKind::Tar,
        }
    }

    /// Checks whether a final command result matches this copy mode.
    pub(crate) fn completion_matches(self, result: &CommandResult) -> bool {
        match self {
            Self::RawFile => matches!(result, CommandResult::RawUpload),
            Self::TarDirectory => matches!(result, CommandResult::TarUpload),
        }
    }
}

pub(crate) enum CopyExecution {
    RemoteStream {
        source_request_id: RequestId,
        dest_request_id: RequestId,
        next_chunk_index: ChunkIndex,
    },
    LocalAgent {
        agent_id: AgentId,
        request_id: RequestId,
    },
}

/// Bookkeeping for one logical copy request managed by the router.
pub(crate) struct CopyRequest {
    /// Agent providing the source contents.
    pub(crate) source_agent_id: AgentId,
    /// Agent receiving the copied contents.
    pub(crate) dest_agent_id: AgentId,
    /// Execution mode and internal request ids for this copy.
    pub(crate) execution: CopyExecution,
    /// Streaming/content mode for command and payload validation.
    pub(crate) content_kind: CopyContentKind,
}

#[derive(Default)]
/// Copy transfer lookups keyed by public ids and internal per-agent request ids.
pub struct CopyRegistry {
    /// Logical copy requests keyed by the public transfer id.
    pub(crate) by_public_id: HashMap<TransferId, CopyRequest>,
    /// Reverse lookup from internal per-agent request id to public transfer id.
    pub(crate) public_id_by_internal_request: HashMap<RequestId, TransferId>,
}

impl CopyRegistry {
    /// Looks up the public copy id associated with one internal request id.
    pub(crate) fn public_id_for_internal(&self, request_id: RequestId) -> Option<TransferId> {
        self.public_id_by_internal_request.get(&request_id).copied()
    }
}

#[derive(Default)]
/// Stored transfer progress snapshots exposed to REST and UI readers.
pub struct TransferProgressStore {
    /// Progress entries keyed by their public transfer id.
    pub(crate) entries: HashMap<TransferId, TransferProgressEntry>,
}

/// UI subscriber state and throttled refresh scheduling owned by the router.
pub struct UiState {
    /// Connected UI subscribers keyed by subscriber id.
    pub(crate) subscribers:
        HashMap<String, tokio::sync::mpsc::UnboundedSender<crate::commands::UiEvent>>,
    /// Timestamp of the most recently broadcast refresh event.
    pub(crate) last_refresh_sent_at: Option<Instant>,
    /// Whether a trailing refresh still needs to be delivered.
    pub(crate) refresh_pending: bool,
    /// Periodic task that checks when throttled refreshes become due.
    pub(crate) refresh_check_task: tokio::task::JoinHandle<()>,
}

/// Aggregate router state split into domain-specific registries and stores.
pub struct RouterState {
    /// Connected-agent registry used for all routing decisions.
    pub(crate) agents: AgentRegistry,
    /// Pending one-shot REST replies awaiting final agent responses.
    pub(crate) pending_rest: PendingRestReplies,
    /// Active direct upload and download stream state.
    pub(crate) streams: StreamTransferRegistry,
    /// Copy-specific bookkeeping and internal/public id mappings.
    pub(crate) copies: CopyRegistry,
    /// Transfer progress entries exposed to REST and UI consumers.
    pub(crate) progress: TransferProgressStore,
    /// UI refresh throttling and subscriber fanout state.
    pub(crate) ui: UiState,
    /// Monotonic counter used to allocate the next internal request id.
    pub(crate) next_request_id: RequestId,
}

impl RouterState {
    /// Constructs a fresh router state with the background UI refresh task attached.
    pub(crate) fn new(ui_refresh_check_task: tokio::task::JoinHandle<()>) -> Self {
        Self {
            agents: AgentRegistry::default(),
            pending_rest: PendingRestReplies::default(),
            streams: StreamTransferRegistry::default(),
            copies: CopyRegistry::default(),
            progress: TransferProgressStore::default(),
            ui: UiState {
                subscribers: HashMap::new(),
                last_refresh_sent_at: None,
                refresh_pending: false,
                refresh_check_task: ui_refresh_check_task,
            },
            next_request_id: RequestId::new(1),
        }
    }

    /// Allocates the next internal router request id.
    pub(crate) fn next_id(&mut self) -> RequestId {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.next();
        id
    }
}
