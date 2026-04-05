use super::state::CopyContentKind;
use crate::commands::{Command, CommandResult, TransferProgressListResponse, UiEvent};
use crate::types::{ChunkIndex, RequestId, TransferId};
use axum::extract::ws::Message as WsMessage;
use ractor::RpcReplyPort;

/// Payload for registering one websocket-backed agent session with the router.
pub struct RegisterAgentRequest {
    /// Stable agent identifier used as the router registry key.
    pub agent_id: String,
    /// Human-readable agent name shown in the UI.
    pub agent_name: String,
    /// Unique websocket session identifier for this connection.
    pub socket_id: String,
    /// Unbounded control-message lane for websocket text frames.
    pub outgoing_text: tokio::sync::mpsc::UnboundedSender<WsMessage>,
    /// Bounded binary-message lane for websocket streaming frames.
    pub outgoing_binary: tokio::sync::mpsc::Sender<WsMessage>,
    /// Operating system string reported by the agent.
    pub os: String,
    /// CPU architecture string reported by the agent.
    pub arch: String,
    /// Hostname reported by the agent.
    pub hostname: String,
    /// Username reported by the agent.
    pub username: String,
}

/// Final command response routed back from an agent to the original caller.
pub struct RouteResponse {
    /// Agent that produced the response.
    pub agent_id: String,
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
    pub agent_id: String,
    /// One-shot command to run on the agent.
    pub command: Command,
    /// Reply port that receives the final command result.
    pub reply: RpcReplyPort<CommandResult>,
}

/// Routes one inbound streaming chunk from an agent into the matching transfer flow.
pub struct RouteStreamChunkRequest {
    /// Agent that sent the chunk.
    pub agent_id: String,
    /// Parsed stream chunk received from the websocket binary lane.
    pub chunk: crate::streaming::StreamChunk,
    /// Reply port used to acknowledge chunk handling back to the session actor.
    pub reply: RpcReplyPort<()>,
}

/// Completes one bounded direct-download chunk forward after the REST receiver accepts it.
pub struct FinishDownloadChunkRoute {
    /// Agent that produced the download chunk.
    pub agent_id: String,
    /// Internal transfer request id for the direct download.
    pub request_id: RequestId,
    /// Chunk index used for completion logging.
    pub chunk_index: ChunkIndex,
    /// Whether this chunk terminates the stream successfully.
    pub is_last: bool,
    /// Surfaced error if the incoming chunk represented an error frame.
    pub error_message: Option<String>,
    /// Whether the bounded send to the REST consumer succeeded.
    pub send_succeeded: bool,
    /// Reply port that must be completed only after downstream acceptance is known.
    pub reply: RpcReplyPort<()>,
}

/// Completes one bounded direct-upload chunk forward after the agent binary lane accepts it.
pub struct FinishUploadChunkRoute {
    /// Agent that should receive the upload chunk.
    pub agent_id: String,
    /// Internal transfer request id for the direct upload.
    pub request_id: RequestId,
    /// Number of payload bytes in the forwarded chunk.
    pub bytes: u64,
    /// Whether the forwarded chunk was an error frame.
    pub is_error: bool,
    /// Whether the bounded send to the agent succeeded.
    pub send_succeeded: bool,
    /// Reply port that completes the REST-side chunk handoff.
    pub reply: RpcReplyPort<Result<(), String>>,
}

/// Completes one remote-copy chunk forward after all derived destination frames are queued.
pub struct FinishCopyChunkRoute {
    /// Source agent that originally sent the copy chunk.
    pub source_agent_id: String,
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
    pub reply: RpcReplyPort<()>,
}

/// Starts a direct download-style streaming command for a REST caller.
pub struct ExecuteStreamRequest {
    /// Target agent that should execute the download-style command.
    pub agent_id: String,
    /// Streaming command to run on the agent.
    pub command: Command,
    /// Path used for transfer progress reporting.
    pub path: String,
    /// Expected total byte count used for progress reporting.
    pub total_bytes: u64,
    /// Reply port that confirms whether the stream started successfully.
    pub reply: RpcReplyPort<Result<(), String>>,
    /// Bounded sink that receives streamed chunks for the REST caller.
    pub chunk_sender: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
}

/// Starts a direct upload stream and returns the allocated internal request id.
pub struct StartUploadRequest {
    /// Target agent that should receive the upload.
    pub agent_id: String,
    /// Streaming upload command to run on the agent.
    pub command: Command,
    /// Path used for progress reporting.
    pub path: String,
    /// Expected total byte count used for progress reporting.
    pub total_bytes: u64,
    /// Completion channel for the final upload result.
    pub completion_sender: tokio::sync::oneshot::Sender<Result<CommandResult, String>>,
    /// Reply port that returns the allocated internal request id.
    pub reply: RpcReplyPort<Result<RequestId, String>>,
}

/// Forwards one upload chunk from the REST layer to the target agent.
pub struct SendStreamChunkRequest {
    /// Agent that should receive the chunk.
    pub agent_id: String,
    /// Internal request id of the active upload stream.
    pub request_id: RequestId,
    /// Chunk payload to forward over the websocket binary lane.
    pub chunk: crate::streaming::StreamChunk,
    /// Reply port that completes once downstream acceptance is known.
    pub reply: RpcReplyPort<Result<(), String>>,
}

/// Starts a local or remote copy operation managed by the router.
pub struct StartCopyRequest {
    /// Source agent that provides the file or directory contents.
    pub source_agent_id: String,
    /// Source path to copy from.
    pub source_path: String,
    /// Destination agent that receives the copied contents.
    pub dest_agent_id: String,
    /// Destination path to copy to.
    pub dest_path: String,
    /// Expected total byte count used for progress reporting.
    pub total_bytes: u64,
    /// Copy mode determining command/result mapping and payload kind.
    pub content_kind: CopyContentKind,
    /// Reply port that returns the public transfer id.
    pub reply: RpcReplyPort<Result<TransferId, String>>,
}

/// Progress notification emitted by an agent for copy-style transfers.
pub struct TransferProgressUpdateRequest {
    /// Agent that emitted the progress update.
    pub agent_id: String,
    /// Internal request id the update belongs to.
    pub request_id: RequestId,
    /// Latest transferred byte count reported by the agent.
    pub transferred_bytes: u64,
    /// Updated total byte count if the agent learned it later.
    pub total_bytes: Option<u64>,
}

pub enum RouterMsg {
    RegisterAgent(RegisterAgentRequest),
    UnregisterAgent {
        agent_id: String,
    },
    RouteResponse(RouteResponse),
    GetAgentList {
        reply: RpcReplyPort<std::collections::HashMap<String, String>>,
    },
    GetTransferProgress {
        reply: RpcReplyPort<TransferProgressListResponse>,
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
        agent_id: String,
        request_id: RequestId,
    },
    StartCopyRest(StartCopyRequest),
    TransferProgressUpdate(TransferProgressUpdateRequest),
    CheckPendingUiRefresh,
}
