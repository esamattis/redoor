use super::messages::{RouteResponse, RouterMsg};
use super::{RouterError, RouterHandle, agents, cleanup, progress, transfers, ui};
use crate::commands::{Command, CommandResult, TransferProgressEntry};
use crate::log;
use crate::logging::Level;
use crate::streaming::{StreamChunk, StreamPayloadKind};
use crate::types::{AgentId, ChunkIndex, RequestId, SocketId, TransferId, UnixTimestampSeconds};
use axum::extract::ws::Message as WsMessage;
use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
/// Registration metadata and websocket send handles for one connected agent.
pub struct AgentConnection {
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
    pub(crate) by_id: HashMap<AgentId, AgentConnection>,
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

/// Aggregate router internals split into domain-specific registries and stores.
pub struct Router {
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

impl Router {
    /// Constructs a fresh router with the background UI refresh task attached.
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

    /// Checks whether an inbound stream chunk belongs to a remote copy flow.
    pub(crate) fn is_remote_copy_stream(&self, request_id: RequestId) -> bool {
        self.copies
            .public_id_for_internal(request_id)
            .and_then(|public_request_id| self.copies.by_public_id.get(&public_request_id))
            .map(|copy_request| {
                matches!(copy_request.execution, CopyExecution::RemoteStream { .. })
            })
            .unwrap_or(false)
    }

    /// Routes a final agent command response to the REST, copy, or upload owner.
    pub(crate) fn route_response(&mut self, response: RouteResponse) {
        if let Some((reply, stored_agent_id)) =
            self.pending_rest.by_request_id.remove(&response.request_id)
        {
            let result_to_send = match (&response.result, self.agents.by_id.get(&stored_agent_id)) {
                (CommandResult::GetAgentDetails(details), Some(agent_connection)) => {
                    // Registration owns the connection-scoped identity fields, so the
                    // router rewrites them from its authoritative registry snapshot.
                    let mut details = details.clone();
                    details.id = stored_agent_id.clone();
                    details.name = agent_connection.agent_name.clone();
                    details.connected_at = agent_connection.connected_at;
                    details.os = agent_connection.os.clone();
                    details.arch = agent_connection.arch.clone();
                    details.hostname = agent_connection.hostname.clone();
                    details.username = agent_connection.username.clone();
                    CommandResult::GetAgentDetails(details)
                }
                _ => response.result.clone(),
            };

            let _ = reply.send(result_to_send);
            return;
        }

        if transfers::copy::finish_transfer(
            self,
            response.agent_id.clone(),
            response.request_id,
            response.result.clone(),
        ) {
            return;
        }

        transfers::upload::finish_transfer(
            self,
            response.agent_id,
            response.request_id,
            response.result,
        );
    }

    /// Runs the router event loop so all correlated routing state stays single-owner.
    pub(crate) async fn run(
        mut self,
        mut receiver: mpsc::Receiver<RouterMsg>,
        router_handle: RouterHandle,
    ) {
        log!(Level::Info, "Router task started");

        while let Some(message) = receiver.recv().await {
            match message {
                RouterMsg::RegisterAgent(request) => {
                    agents::register(&mut self, request);
                }
                RouterMsg::UnregisterAgent { agent_id } => {
                    log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
                    self.agents.by_id.remove(&agent_id);
                    ui::notify_refresh(&mut self);
                    cleanup::cleanup_agent_requests(&mut self, &agent_id).await;
                }
                RouterMsg::RouteResponse(response) => {
                    self.route_response(response);
                }
                RouterMsg::GetAgentList { reply } => {
                    let _ = reply.send(agents::list_agents(&self));
                }
                RouterMsg::GetTransferProgress { reply } => {
                    let _ = reply.send(progress::list_transfer_progress(&self));
                }
                RouterMsg::RegisterUiSubscriber(request) => {
                    ui::register_subscriber(&mut self, request);
                }
                RouterMsg::UnregisterUiSubscriber { subscriber_id } => {
                    ui::unregister_subscriber(&mut self, &subscriber_id);
                }
                RouterMsg::ExecuteCommandRest(request) => {
                    agents::execute_command_rest(&mut self, request);
                }
                RouterMsg::RouteStreamChunk(request) => {
                    if self.is_remote_copy_stream(request.chunk.request_id) {
                        transfers::copy::route_chunk(&mut self, &router_handle, request);
                    } else {
                        transfers::download::route_chunk(&mut self, &router_handle, request);
                    }
                }
                RouterMsg::FinishRoutedDownloadChunk(route) => {
                    transfers::download::finish_routed_chunk(&mut self, &route);
                    let _ = route.reply.send(());
                }
                RouterMsg::FinishRoutedUploadChunk(route) => {
                    let result = transfers::upload::finish_routed_chunk(&mut self, &route);
                    let _ = route.reply.send(result);
                }
                RouterMsg::FinishRoutedCopyChunk(route) => {
                    transfers::copy::finish_routed_chunk(&mut self, &route);
                    let _ = route.reply.send(());
                }
                RouterMsg::ExecuteStreamCommandRest(request) => {
                    transfers::download::start(&mut self, request);
                }
                RouterMsg::StartUploadStreamRest(request) => {
                    transfers::upload::start(&mut self, request);
                }
                RouterMsg::SendStreamChunkToAgent(request) => {
                    transfers::upload::route_chunk(&mut self, &router_handle, request);
                }
                RouterMsg::CancelTransfer {
                    agent_id,
                    request_id,
                } => {
                    cleanup::cancel_transfer(&mut self, request_id, agent_id);
                }
                RouterMsg::StartCopyRest(request) => {
                    transfers::copy::start(&mut self, request);
                }
                RouterMsg::TransferProgressUpdate(request) => {
                    transfers::copy::update_progress(&mut self, request);
                }
                RouterMsg::CheckPendingUiRefresh => {
                    ui::check_pending_refresh(&mut self);
                }
                RouterMsg::Shutdown => {
                    break;
                }
            }
        }

        self.ui.refresh_check_task.abort();
        log!(Level::Info, "Router task stopped");
    }
}
