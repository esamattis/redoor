use super::RouterError;
use crate::commands::{
    AgentConnectionStatus, BinaryIdentity, Command, CommandResult, TransferProgressEntry,
};
use crate::log_registry::LogRegistry;
use crate::streaming::{StreamChunk, StreamPayloadKind};
use crate::terminal_registry::TerminalRegistry;
use crate::types::{AgentId, ChunkIndex, RequestId, SocketId, TransferId, UnixTimestampSeconds};
use axum::extract::ws::Message as WsMessage;
use std::collections::HashMap;
use std::time::Instant;

/// Bounded payload transport attached to one authoritative control connection.
#[derive(Clone, Debug)]
pub struct TransferConnection {
    /// Distinguishes the current transfer socket from stale teardown events.
    pub socket_id: SocketId,
    /// Keeps a slow transfer peer from causing unbounded payload buffering.
    pub outgoing_binary: tokio::sync::mpsc::Sender<WsMessage>,
    /// Lets control or transfer replacement stop both socket halves promptly.
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone, Debug)]
/// Registration metadata and control websocket handle for one connected agent.
pub struct AgentConnection {
    /// Stable identity used in transfer readiness errors and routing logs.
    pub agent_id: AgentId,
    /// Human-readable name shown in the UI.
    pub agent_name: String,
    /// Unique websocket session identifier for logging.
    pub socket_id: SocketId,
    /// Unbounded control-message lane for websocket text frames.
    pub outgoing_text: tokio::sync::mpsc::UnboundedSender<WsMessage>,
    /// Secret accepted only while this control connection remains authoritative.
    pub transfer_token: String,
    /// Payload transport may be absent briefly while the agent reconnects it.
    pub transfer: Option<TransferConnection>,
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
    /// Immutable absolute directory selected at agent startup for UI navigation.
    pub default_directory: String,
    /// Compile-time identity reported by the agent at registration.
    pub binary: BinaryIdentity,
}

/// Retained UI inventory record for an agent seen during this server process.
#[derive(Clone, Debug)]
pub struct KnownAgent {
    /// Stable route and management identifier.
    pub id: AgentId,
    /// Human-readable effective agent name.
    pub name: String,
    /// Latest authoritative or configured default directory.
    pub default_directory: Option<String>,
    /// Distinguishes TOML-owned supervisors from observation-only external agents.
    pub managed: bool,
    /// Current public lifecycle state.
    pub status: AgentConnectionStatus,
    /// Timestamp for the current authoritative connection only.
    pub connected_at: Option<UnixTimestampSeconds>,
    /// Server-observed teardown time retained after disconnect.
    pub last_seen_at: Option<UnixTimestampSeconds>,
    /// Latest managed spawn, exit, or registration issue.
    pub connection_issue: Option<String>,
    /// Guards the inventory against stale socket teardown.
    pub socket_id: Option<SocketId>,
    /// Last registered binary identity, retained after disconnect for list warnings.
    pub binary: Option<BinaryIdentity>,
}

#[derive(Default)]
/// Keeps live routing separate from the retained all-agent inventory.
pub struct AgentRegistry {
    /// Connected agents addressable by their stable agent id.
    pub(crate) by_id: HashMap<AgentId, AgentConnection>,
    /// All agents known during this server process lifetime.
    pub(crate) known_by_id: HashMap<AgentId, KnownAgent>,
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
    /// Delays the HTTP body producer until the upload worker exists on the other socket.
    ///
    /// When setup fails before readiness, this carries `UploadStartOutcome::Finished`
    /// so the HTTP layer can reuse the completion status mapping instead of a generic 500.
    /// Dropped receivers mean the HTTP caller is gone and the upload must be canceled.
    pub(crate) ready_sender: Option<
        tokio::sync::oneshot::Sender<Result<super::messages::UploadStartOutcome, RouterError>>,
    >,
    /// Records the cross-socket setup barrier for routing and diagnostics.
    pub(crate) ready: bool,
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
    /// Defers source production until the destination upload worker acknowledges readiness.
    pub(crate) pending_source_command: Option<Command>,
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
    /// Pending dedicated terminal setups cleaned when authoritative agents leave.
    pub(crate) terminal_registry: TerminalRegistry,
    /// Pending dedicated log setups cleaned when authoritative agents leave.
    pub(crate) log_registry: LogRegistry,
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
    pub(crate) fn new(
        ui_refresh_check_task: tokio::task::JoinHandle<()>,
        terminal_registry: TerminalRegistry,
        log_registry: LogRegistry,
    ) -> Self {
        Self {
            terminal_registry,
            log_registry,
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
