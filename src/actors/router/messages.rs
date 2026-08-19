use super::RouterError;
use super::state::CopyContentKind;
use crate::commands::{
    AgentConnectionStatus, BinaryIdentity, Command, CommandResult, TransferProgressListResponse,
    UiEvent,
};
use crate::log_protocol::LogStreamId;
use crate::terminal_protocol::{TerminalId, TerminalSize};
use crate::types::{AgentId, ChunkIndex, RequestId, SocketId, TransferId, UnixTimestampSeconds};
use crate::watchdog::WatchdogSnapshot;
use axum::extract::ws::Message as WsMessage;

/// One-shot reply port used by router request/reply messages.
pub type RouterReply<T> = tokio::sync::oneshot::Sender<T>;

/// Payload for registering one websocket-backed agent session with the router.
pub struct RegisterAgentRequest {
    /// Stable agent identifier used as the router registry key.
    pub agent_id: AgentId,
    /// Human-readable agent name shown in the UI.
    pub agent_name: String,
    /// Unique websocket session identifier for this connection.
    pub socket_id: SocketId,
    /// Unbounded control-message lane for websocket text frames.
    pub outgoing_text: tokio::sync::mpsc::UnboundedSender<WsMessage>,
    /// Operating system string reported by the agent.
    pub os: String,
    /// CPU architecture string reported by the agent.
    pub arch: String,
    /// Hostname reported by the agent.
    pub hostname: String,
    /// Username reported by the agent.
    pub username: String,
    /// Immutable absolute directory the UI opens for this agent.
    pub default_directory: String,
    /// Compile-time identity of the connecting agent binary.
    pub binary: BinaryIdentity,
    /// Advertises support for replacing the executable through `SelfExec`.
    pub supports_self_exec: bool,
    /// Advertises access to a graphical desktop and platform path launcher.
    pub supports_native_open: bool,
    /// Lets the router reject a managed registration whose shutdown won after socket parsing.
    pub watchdog: Option<crate::watchdog::WatchdogHandle>,
}

/// Retained inventory projection used by REST, tabs, and management controls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentListEntry {
    /// Stable agent identifier used in routes.
    pub id: AgentId,
    /// Human-readable agent name shown in tabs.
    pub name: String,
    /// Latest known or configured default directory.
    pub default_directory: Option<String>,
    /// Indicates whether the server owns a TOML supervisor for this id.
    pub managed: bool,
    /// Whether this retained entry can be changed through the SSH configuration API.
    pub configuration_editable: bool,
    /// Configured SSH destination when this inventory row is SSH-backed.
    pub ssh_target: Option<String>,
    /// Current public lifecycle state.
    pub status: AgentConnectionStatus,
    /// Start of the current authoritative connection.
    pub connected_at: Option<UnixTimestampSeconds>,
    /// Current socket generation so clients can distinguish fast reconnects.
    pub connection_id: Option<SocketId>,
    /// End of the most recent authoritative connection.
    pub last_seen_at: Option<UnixTimestampSeconds>,
    /// Latest managed lifecycle diagnostic.
    pub connection_issue: Option<String>,
    /// Binary identity from the latest registration when one has occurred.
    pub binary: Option<BinaryIdentity>,
    /// Latest registration's explicit support for replacement-path self-exec.
    pub supports_self_exec: bool,
    /// Latest registration's access to a graphical desktop path launcher.
    pub supports_native_open: bool,
}

/// Registers a configured entry before any process can be started.
pub struct RegisterManagedAgentRequest {
    /// Effective name is also the stable id for pre-connection routes.
    pub agent_id: AgentId,
    /// Configured directory may be absent for an SSH target.
    pub default_directory: Option<String>,
    /// Distinguishes SSH-backed entries supported by the managed-agent form from local entries.
    pub configuration_editable: bool,
    /// Configured SSH destination copied into inventory so list clients can label remotes.
    pub ssh_target: Option<String>,
    /// Acknowledges inventory visibility before HTTP serving begins.
    pub reply: RouterReply<()>,
}

/// Removes a stopped managed record after its TOML entry and supervisor are gone.
pub struct UnregisterManagedAgentRequest {
    /// Selects the retained inventory row that must disappear with the supervisor.
    pub agent_id: AgentId,
    /// Acknowledges cleanup so HTTP delete/replace can return only after inventory is gone.
    pub reply: RouterReply<()>,
}

/// Applies asynchronous supervisor state without waiting in the router task.
pub struct ApplyManagedLifecycleRequest {
    /// Selects the configured inventory record to update.
    pub agent_id: AgentId,
    /// Contains only small control-plane state, never process output.
    pub snapshot: WatchdogSnapshot,
    /// Allows control endpoints to wait until inventory and socket cleanup are consistent.
    pub reply: Option<RouterReply<()>>,
}

/// Requests that a payload socket attach to the current control connection.
pub struct RegisterTransferConnectionRequest {
    /// Agent identity submitted by the transfer handshake.
    pub agent_id: AgentId,
    /// Session-scoped secret submitted by the transfer handshake.
    pub token: String,
    /// Unique socket identity used to reject stale teardown.
    pub socket_id: SocketId,
    /// Bounded lane used only for binary stream frames.
    pub outgoing_binary: tokio::sync::mpsc::Sender<WsMessage>,
    /// Stops an older or control-orphaned transfer task promptly.
    pub shutdown: tokio::sync::watch::Sender<bool>,
    /// Confirms that router state owns the connection before payload is accepted.
    pub reply: RouterReply<Result<(), RouterError>>,
}

/// Confirms destination upload setup before payload producers are allowed to run.
pub struct RouteTransferReadyRequest {
    /// Agent that registered the destination-side upload worker.
    pub agent_id: AgentId,
    /// Upload request whose bounded worker channel is now available.
    pub request_id: RequestId,
}

/// Final command response routed back from an agent to the original caller.
pub struct RouteResponse {
    /// Agent that produced the response.
    pub agent_id: AgentId,
    /// Internal request id used to correlate the response.
    pub request_id: RequestId,
    /// Final command result returned by the agent.
    pub result: CommandResult,
}

/// Registers one UI event stream that should receive router refresh events.
pub struct RegisterUiSubscriberRequest {
    /// Unique subscriber identifier used for later unregistering.
    pub subscriber_id: String,
    /// Event sink that receives UI refresh notifications.
    pub sender: tokio::sync::mpsc::UnboundedSender<UiEvent>,
}

/// Executes a one-shot command on an agent and replies with its final result.
pub struct ExecuteCommandRequest {
    /// Target agent that should execute the command.
    pub agent_id: AgentId,
    /// One-shot command to run on the agent.
    pub command: Command,
    /// Reply port that receives the final command result.
    pub reply: RouterReply<CommandResult>,
}

/// Routes one inbound streaming chunk from an agent into the matching transfer flow.
pub struct RouteStreamChunkRequest {
    /// Agent that sent the chunk.
    pub agent_id: AgentId,
    /// Parsed stream chunk received from the websocket binary lane.
    pub chunk: crate::streaming::StreamChunk,
    /// Reply port used to acknowledge chunk handling back to the session actor.
    pub reply: RouterReply<()>,
}

/// Completes one bounded direct-download chunk forward after the REST receiver accepts it.
pub struct FinishDownloadChunkRoute {
    /// Agent that produced the download chunk.
    pub agent_id: AgentId,
    /// Internal transfer request id for the direct download.
    pub request_id: RequestId,
    /// Chunk index used for completion logging.
    pub chunk_index: ChunkIndex,
    /// Whether this chunk terminates the stream successfully.
    pub is_last: bool,
    /// Number of payload bytes accepted by the REST-facing stream.
    pub bytes: u64,
    /// Surfaced error if the incoming chunk represented an error frame.
    pub error_message: Option<String>,
    /// Whether the bounded send to the REST consumer succeeded.
    pub send_succeeded: bool,
    /// Reply port that must be completed only after downstream acceptance is known.
    pub reply: RouterReply<()>,
}

/// Completes one bounded direct-upload chunk forward after the agent binary lane accepts it.
pub struct FinishUploadChunkRoute {
    /// Agent that should receive the upload chunk.
    pub agent_id: AgentId,
    /// Internal transfer request id for the direct upload.
    pub request_id: RequestId,
    /// Number of payload bytes in the forwarded chunk.
    pub bytes: u64,
    /// Whether the forwarded chunk was an error frame.
    pub is_error: bool,
    /// Whether the bounded send to the agent succeeded.
    pub send_succeeded: bool,
    /// Reply port that completes the REST-side chunk handoff.
    pub reply: RouterReply<Result<(), RouterError>>,
}

/// Completes one remote-copy chunk forward after all derived destination frames are queued.
pub struct FinishCopyChunkRoute {
    /// Source agent that originally sent the copy chunk.
    pub source_agent_id: AgentId,
    /// Public transfer id exposed for the logical copy operation.
    pub public_request_id: TransferId,
    /// Internal request id for the source-side download stream.
    pub source_request_id: RequestId,
    /// Internal request id for the destination-side upload stream.
    pub dest_request_id: RequestId,
    /// Next chunk index to use when reframing future destination chunks.
    pub next_chunk_index: ChunkIndex,
    /// Number of source payload bytes accounted for by this chunk.
    pub bytes: u64,
    /// Whether all derived destination frames were queued successfully.
    pub send_succeeded: bool,
    /// Reply port that acknowledges the source chunk back to the session actor.
    pub reply: RouterReply<()>,
}

/// Starts a direct download-style streaming command for a REST caller.
pub struct ExecuteStreamRequest {
    /// Target agent that should execute the download-style command.
    pub agent_id: AgentId,
    /// Streaming command to run on the agent.
    pub command: Command,
    /// Path used for transfer progress reporting.
    pub path: String,
    /// Expected total byte count used for progress reporting.
    pub total_bytes: u64,
    /// Full file size used to recognize a continuation after client-side range resume.
    pub full_size: Option<u64>,
    /// Starting file offset for a range request that may continue a canceled download.
    pub resume_offset: Option<u64>,
    /// Reply port that returns the allocated request id so the consumer can cancel on drop.
    pub reply: RouterReply<Result<RequestId, RouterError>>,
    /// Bounded sink that receives streamed chunks for the REST caller.
    pub chunk_sender: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
}

/// Outcome of waiting for an upload destination to become ready.
///
/// The request id is returned immediately from start so HTTP can arm cancellation
/// before this barrier. Init failures finish before `TransferReady`, so readiness
/// must still carry the same completion payload the HTTP handler maps to status
/// codes (permission denied -> 403, missing path -> 404, etc.).
#[derive(Debug)]
pub enum UploadStartOutcome {
    /// Destination worker exists; HTTP may begin forwarding the request body.
    Ready,
    /// Transfer ended before readiness; boxed so the ready path stays small.
    Finished(Box<Result<CommandResult, RouterError>>),
}

/// Starts a direct upload stream and returns the allocated internal request id.
pub struct StartUploadRequest {
    /// Target agent that should receive the upload.
    pub agent_id: AgentId,
    /// Streaming upload command to run on the agent.
    pub command: Command,
    /// Path used for progress reporting.
    pub path: String,
    /// Expected total byte count used for progress reporting.
    pub total_bytes: u64,
    /// Completion channel for the final upload result.
    pub completion_sender: tokio::sync::oneshot::Sender<Result<CommandResult, RouterError>>,
    /// Released once the destination worker is ready, or with early setup failure.
    ///
    /// Kept separate from `reply` so HTTP can arm cancel with the request id
    /// before blocking on this barrier.
    pub ready_sender: tokio::sync::oneshot::Sender<Result<UploadStartOutcome, RouterError>>,
    /// Immediate reply with the allocated request id (or start rejection).
    pub reply: RouterReply<Result<RequestId, RouterError>>,
}

/// Forwards one upload chunk from the REST layer to the target agent.
pub struct SendStreamChunkRequest {
    /// Agent that should receive the chunk.
    pub agent_id: AgentId,
    /// Internal request id of the active upload stream.
    pub request_id: RequestId,
    /// Chunk payload to forward over the websocket binary lane.
    pub chunk: crate::streaming::StreamChunk,
    /// Reply port that completes once downstream acceptance is known.
    pub reply: RouterReply<Result<(), RouterError>>,
}

/// Starts a local or remote copy operation managed by the router.
pub struct StartCopyRequest {
    /// Source agent that provides the file or directory contents.
    pub source_agent_id: AgentId,
    /// Source path to copy from.
    pub source_path: String,
    /// Destination agent that receives the copied contents.
    pub dest_agent_id: AgentId,
    /// Destination path to copy to.
    pub dest_path: String,
    /// Expected total byte count used for progress reporting.
    pub total_bytes: u64,
    /// Copy mode determining command/result mapping and payload kind.
    pub content_kind: CopyContentKind,
    /// Controls replacement when the destination path already exists.
    pub on_existing: crate::commands::CopyExistingMode,
    /// Selects whether copy completion is final or followed by source deletion.
    pub operation: super::state::CopyOperation,
    /// Prevents move cleanup from deleting a replacement created while copying.
    pub source_identity: Option<crate::commands::MoveSourceIdentity>,
    /// Reply port that returns the public transfer id.
    pub reply: RouterReply<Result<TransferId, RouterError>>,
}

/// Progress notification emitted by an agent for copy-style transfers.
pub struct TransferProgressUpdateRequest {
    /// Agent that emitted the progress update.
    pub agent_id: AgentId,
    /// Internal request id the update belongs to.
    pub request_id: RequestId,
    /// Latest transferred byte count reported by the agent.
    pub transferred_bytes: u64,
    /// Updated total byte count if the agent learned it later.
    pub total_bytes: Option<u64>,
}

/// Requests a connected agent to establish one dedicated terminal socket.
pub struct OpenTerminalRequest {
    pub agent_id: AgentId,
    pub terminal_id: TerminalId,
    pub token: String,
    pub size: TerminalSize,
    pub cwd: String,
    pub reply: RouterReply<Result<(), RouterError>>,
}

/// Requests a connected agent to establish one dedicated log socket.
pub struct OpenAgentLogStreamRequest {
    pub agent_id: AgentId,
    pub log_stream_id: LogStreamId,
    pub token: String,
    pub reply: RouterReply<Result<(), RouterError>>,
}

/// Enumerates router work so live streams and lifecycle controls share explicit lanes.
pub enum RouterMsg {
    RegisterAgent(RegisterAgentRequest),
    RegisterTransferConnection(RegisterTransferConnectionRequest),
    UnregisterTransferConnection {
        agent_id: AgentId,
        /// Prevents a replaced transfer socket from clearing its successor.
        socket_id: SocketId,
    },
    RegisterManagedAgent(RegisterManagedAgentRequest),
    UnregisterManagedAgent(UnregisterManagedAgentRequest),
    ApplyManagedLifecycle(ApplyManagedLifecycleRequest),
    UnregisterAgent {
        agent_id: AgentId,
        /// Identifies which websocket session is unregistering so a stale
        /// session cannot accidentally remove a replacement connection that
        /// took over the same agent name.
        socket_id: SocketId,
    },
    RouteResponse(RouteResponse),
    RouteTransferReady(RouteTransferReadyRequest),
    GetAgentList {
        reply: RouterReply<Vec<AgentListEntry>>,
    },
    GetTransferProgress {
        reply: RouterReply<TransferProgressListResponse>,
    },
    RegisterUiSubscriber(RegisterUiSubscriberRequest),
    UnregisterUiSubscriber {
        subscriber_id: String,
    },
    ExecuteCommandRest(ExecuteCommandRequest),
    RouteStreamChunk(RouteStreamChunkRequest),
    FinishRoutedDownloadChunk(FinishDownloadChunkRoute),
    FinishRoutedUploadChunk(FinishUploadChunkRoute),
    FinishRoutedCopyChunk(FinishCopyChunkRoute),
    ExecuteStreamCommandRest(ExecuteStreamRequest),
    StartUploadStreamRest(StartUploadRequest),
    SendStreamChunkToAgent(SendStreamChunkRequest),
    CancelTransfer {
        agent_id: AgentId,
        request_id: RequestId,
    },
    StartCopyRest(StartCopyRequest),
    TransferProgressUpdate(TransferProgressUpdateRequest),
    OpenTerminal(OpenTerminalRequest),
    OpenAgentLogStream(OpenAgentLogStreamRequest),
    CheckPendingUiRefresh,
    Shutdown,
}
