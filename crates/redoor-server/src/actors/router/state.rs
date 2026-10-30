//! Router-owned state: live agent connections, retained agent inventory and flow tables.

use super::flows::FlowTable;
use super::messages::RouteResponse;
use super::streams::ConnectionStreams;
use crate::actors::lanes::{CommandTicket, ControlLanes};
use redoor_protocol::ids::{AgentId, RequestId, SocketId, TransferId, UnixTimestampSeconds};
use redoor_protocol::wire::request;
use redoor_protocol::{
    api::{agents::AgentConnectionStatus, transfers::TransferProgressEntry},
    wire::{
        command::Command,
        registration::{AgentCapabilities, AgentIdentity},
    },
};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// Registration metadata and the connection handle of one connected agent.
///
/// Not `Clone`: it owns the write tickets of its queued commands, and a copy would split them.
#[derive(Debug)]
pub struct AgentConnection {
    /// Stable identity used in transfer readiness errors and routing logs.
    pub agent_id: AgentId,
    /// Human-readable name shown in the UI.
    pub agent_name: String,
    /// Unique websocket session identifier for logging.
    pub socket_id: SocketId,
    /// Command lane (admission-controlled), priority lane (cancels, lifecycle) and the data
    /// lanes of the connection.
    pub lanes: ControlLanes,
    /// Registration timestamp stored by the router.
    pub connected_at: UnixTimestampSeconds,
    /// Platform, account, start directory and binary announced by this session.
    pub identity: AgentIdentity,
    /// Platform-dependent features announced by this session.
    pub capabilities: AgentCapabilities,
    /// Payload stream routing shared with the connection's session.
    pub streams: ConnectionStreams,
    /// The session's inbound-traffic clock; tells whether this connection is still healthy
    /// when another `hello` claims the same id.
    pub activity: crate::actors::activity::ConnectionActivity,
    /// Open terminal streams, bounded per connection.
    pub terminals: HashSet<RequestId>,
    /// Open log streams, bounded per connection.
    pub log_streams: HashSet<RequestId>,
    /// Write tickets of queued commands and stream opens, so a cancel can withdraw work the
    /// agent has not seen instead of sending a `cancel` that could overtake it.
    pub(crate) tickets: HashMap<RequestId, CommandTicket>,
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
    /// Whether this entry is SSH-backed and supported by the configuration editor.
    pub configuration_editable: bool,
    /// Configured SSH destination retained so list projections need no TOML reread.
    pub ssh_target: Option<String>,
    /// Current public lifecycle state.
    pub status: AgentConnectionStatus,
    /// Timestamp for the current authoritative connection only.
    pub connected_at: Option<UnixTimestampSeconds>,
    /// Server-observed teardown time retained after disconnect.
    pub last_seen_at: Option<UnixTimestampSeconds>,
    /// Latest managed spawn, exit, or registration issue.
    pub connection_issue: Option<String>,
    /// Sticky SSH start steps for the current watchdog cycle.
    pub provisioning_status: Vec<redoor_protocol::api::agents::ProvisioningStatusMessage>,
    /// Guards the inventory against stale socket teardown.
    pub socket_id: Option<SocketId>,
    /// Last registered identity, retained after disconnect for list warnings and gating.
    pub identity: Option<AgentIdentity>,
    /// Last advertised capabilities, retained after disconnect like the identity.
    pub capabilities: AgentCapabilities,
    /// Active warning that several machines use this device's id.
    pub duplicate_id: Option<redoor_protocol::api::agents::DuplicateIdWarning>,
}

impl KnownAgent {
    /// A retained record for an agent that has never registered in this server process.
    pub(crate) fn unregistered(
        id: AgentId,
        default_directory: Option<String>,
        status: AgentConnectionStatus,
    ) -> Self {
        Self {
            name: id.to_string(),
            id,
            default_directory,
            managed: false,
            configuration_editable: false,
            ssh_target: None,
            status,
            connected_at: None,
            last_seen_at: None,
            connection_issue: None,
            provisioning_status: Vec::new(),
            socket_id: None,
            identity: None,
            capabilities: AgentCapabilities::default(),
            duplicate_id: None,
        }
    }
}

#[derive(Default)]
/// Keeps live routing separate from the retained all-agent inventory.
pub struct AgentRegistry {
    /// Connected agents addressable by their stable agent id.
    pub(crate) by_id: HashMap<AgentId, AgentConnection>,
    /// All agents known during this server process lifetime.
    pub(crate) known_by_id: HashMap<AgentId, KnownAgent>,
    /// Recent takeovers of healthy connections per id, kept only while they can still add
    /// up to a duplicate-id conflict or one is active.
    pub(crate) takeovers: HashMap<AgentId, super::duplicate_ids::TakeoverHistory>,
    /// Names claimed by managed devices that are being created or renamed, by device id.
    /// The config edit stops the agent and rewrites the file before the inventory row
    /// carries the new name, so without a reservation a standalone agent could take the
    /// name in between and leave two devices with it.
    pub(crate) reserved_names: HashMap<AgentId, String>,
}

impl AgentRegistry {
    /// Whether `socket_id` is the live control session of `agent_id`.
    ///
    /// Agent-originated frames (results, readiness, progress, publication requests) may only
    /// drive flows when they arrive on the session that currently owns the agent; a replaced
    /// session's late frames and frames from sessions that never registered are ignored.
    pub(crate) fn is_current_session(&self, agent_id: &AgentId, socket_id: &SocketId) -> bool {
        self.by_id
            .get(agent_id)
            .is_some_and(|connection| &connection.socket_id == socket_id)
    }
}

/// Whether a copy streams one file or a directory archive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyContentKind {
    RawFile,
    TarDirectory,
}

impl CopyContentKind {
    /// Builds the destination-side upload command for this copy mode.
    pub(crate) fn upload_command(
        self,
        path: String,
        on_existing: redoor_protocol::api::transfers::CopyExistingMode,
    ) -> Command {
        match self {
            Self::RawFile => Command::RawUpload(request::RawUpload {
                partial: None,
                path,
                on_existing,
                ownership: redoor_protocol::api::files::CreationOwnershipOptions::default(),
                executable: false,
            }),
            Self::TarDirectory => Command::TarUpload(request::TarUpload { path, on_existing }),
        }
    }

    /// Builds the source-side download command for this copy mode.
    pub(crate) fn download_command(self, path: String) -> Command {
        match self {
            Self::RawFile => Command::RawDownload(request::RawDownload {
                expected_identity: None,
                path,
                range_start: None,
                range_end: None,
            }),
            // Copies extract directly into the requested destination, so they must not add
            // the source directory name as another destination path component.
            Self::TarDirectory => Command::TarDownload(request::TarDownload {
                path,
                include_root: false,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Distinguishes copy transport used for copy from copy transport used for move.
pub enum CopyOperation {
    Copy,
    Move,
}

impl CopyOperation {
    /// Lowercase name used in logs.
    pub fn label(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
        }
    }

    /// Capitalized name used at the start of user-facing messages.
    pub fn title(self) -> &'static str {
        match self {
            Self::Copy => "Copy",
            Self::Move => "Move",
        }
    }
}

#[derive(Default)]
/// Stored transfer progress snapshots exposed to REST and UI readers.
pub struct TransferProgressStore {
    /// Progress entries keyed by their public transfer id.
    pub(crate) entries: HashMap<TransferId, TransferProgressEntry>,
    /// One-shot terminal observers retain acknowledgements after public history is pruned.
    pub(crate) terminal_observers:
        HashMap<TransferId, tokio::sync::watch::Sender<Option<TransferProgressEntry>>>,
    /// Last maintenance pass avoids scanning history on every UI tick.
    pub(crate) last_pruned_at: Option<UnixTimestampSeconds>,
    /// Downloads that received a later-discovered archive total.
    ///
    /// Completion must keep counted tar bytes when that prediction disagrees,
    /// instead of snapping transferred to a known-size file plan.
    pub(crate) predicted_download_totals: HashSet<TransferId>,
}

/// UI subscriber state and throttled refresh scheduling owned by the router.
pub struct UiState {
    /// Connected UI subscribers keyed by subscriber id.
    pub(crate) subscribers: HashMap<
        String,
        tokio::sync::mpsc::UnboundedSender<redoor_protocol::api::ui_events::UiEvent>,
    >,
    /// Timestamp of the most recently broadcast refresh event.
    pub(crate) last_refresh_sent_at: Option<Instant>,
    /// Whether a trailing refresh still needs to be delivered.
    pub(crate) refresh_pending: bool,
    /// Periodic task that checks when throttled refreshes become due.
    pub(crate) refresh_check_task: tokio::task::JoinHandle<()>,
}

/// Lock-free request id sequence shared by the router and its handles.
///
/// Callers that must cancel a command they just queued need its id before the router has
/// processed the message; drawing from the router's own sequence keeps every id unique across
/// commands, streams, uploads and copies.
#[derive(Clone, Debug)]
pub struct RequestIds {
    next: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl Default for RequestIds {
    /// Starts at 1 so 0 never names a real request.
    fn default() -> Self {
        Self {
            next: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
        }
    }
}

impl RequestIds {
    /// Allocates the next unused request id.
    pub fn next(&self) -> RequestId {
        RequestId::new(self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }
}

/// Aggregate router state split into domain-specific registries and stores.
pub struct RouterState {
    /// Connected-agent registry used for all routing decisions.
    pub(crate) agents: AgentRegistry,
    /// Every in-flight command, stream, upload and copy.
    pub(crate) flows: FlowTable,
    /// Transfer progress entries exposed to REST and UI consumers.
    pub(crate) progress: TransferProgressStore,
    /// UI refresh throttling and subscriber fanout state.
    pub(crate) ui: UiState,
    /// Allocator shared with [`super::RouterHandle`], so ids a caller picks before sending
    /// and ids the router picks internally never collide.
    pub(crate) request_ids: RequestIds,
    /// Canceled results of commands withdrawn before they were written. They are routed
    /// after the current message, like a result from the agent would be, so no handler sees
    /// its flow settle in the middle of its own cancel.
    pub(crate) local_results: Vec<RouteResponse>,
}

impl RouterState {
    /// Constructs a fresh router state with the background UI refresh task attached.
    #[cfg(test)]
    pub(crate) fn new(ui_refresh_check_task: tokio::task::JoinHandle<()>) -> Self {
        Self::with_request_ids(ui_refresh_check_task, RequestIds::default())
    }

    /// Constructs a router state that draws request ids from `request_ids`, the allocator its
    /// handle hands to clients that need an id before the router sees their message.
    pub(crate) fn with_request_ids(
        ui_refresh_check_task: tokio::task::JoinHandle<()>,
        request_ids: RequestIds,
    ) -> Self {
        Self {
            agents: AgentRegistry::default(),
            flows: FlowTable::default(),
            progress: TransferProgressStore::default(),
            ui: UiState {
                subscribers: HashMap::new(),
                last_refresh_sent_at: None,
                refresh_pending: false,
                refresh_check_task: ui_refresh_check_task,
            },
            request_ids,
            local_results: Vec::new(),
        }
    }

    /// Allocates the next internal router request id.
    pub(crate) fn next_id(&mut self) -> RequestId {
        self.request_ids.next()
    }
}
