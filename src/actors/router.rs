use crate::actors::session::SessionMsg;
use crate::commands::{
    Command, CommandResult, TransferDirection, TransferProgressEntry, TransferProgressListResponse,
    TransferProgressState, UiEvent,
};
use crate::log;
use crate::logging::Level;
use crate::types::Message;
use ractor::{Actor, ActorProcessingErr, ActorRef, RpcReplyPort};
use std::collections::HashMap;

/// Central command router actor (singleton).
///
/// `RouterActor` acts as the hub between the REST API and connected agents.
/// It maintains a registry of all connected agents (each identified by an
/// `AgentInfo` that includes a handle back to the agent's `SessionActor`),
/// and correlates outgoing commands with incoming responses using request IDs.
///
/// When the REST API wants to execute a command on an agent, it sends an
/// `ExecuteCommandRest` message here. The router looks up the target agent's
/// `SessionActor` reference and forwards the command over the WebSocket.
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

/// Internal state for the [`RouterActor`].
///
/// Tracks all connected agents and maps in-flight request IDs to their
/// corresponding REST reply ports (for both one-shot and streaming responses).
pub struct RouterState {
    agents: HashMap<String, AgentInfo>,
    rest_pending_responses: HashMap<u64, (RpcReplyPort<CommandResult>, String)>,
    transfers: HashMap<u64, TransferRequest>,
    transfer_progress: HashMap<u64, TransferProgressEntry>,
    ui_subscribers: HashMap<String, tokio::sync::mpsc::UnboundedSender<UiEvent>>,
    next_request_id: u64,
}

/// Metadata about a connected agent, cached at registration time.
///
/// Stored in the router's agent registry and used to route commands to the
/// correct [`SessionActor`] via `session_ref`, as well as to enrich
/// responses with registration-time metadata (e.g. `connected_at`, `agent_name`).
#[derive(Clone, Debug)]
pub struct AgentInfo {
    pub agent_name: String,
    pub socket_id: String,
    pub session_ref: ActorRef<SessionMsg>,
    pub connected_at: i64,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub username: String,
}

impl RouterState {
    fn next_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
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
        session_ref: ActorRef<SessionMsg>,
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
        request_id: u64,
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
        reply: RpcReplyPort<Result<u64, String>>,
    },
    /// Forward a binary upload chunk from the REST API to the target agent session.
    SendStreamChunkToAgent {
        agent_id: String,
        request_id: u64,
        chunk: crate::streaming::StreamChunk,
        reply: RpcReplyPort<Result<(), String>>,
    },
}

impl RouterActor {
    fn record_download_start(
        state: &mut RouterState,
        request_id: u64,
        agent_id: String,
        path: String,
        total_bytes: u64,
        chunk_sender: tokio::sync::mpsc::UnboundedSender<crate::streaming::StreamChunk>,
    ) {
        state.transfer_progress.insert(
            request_id,
            TransferProgressEntry {
                request_id,
                agent_id: agent_id.clone(),
                path,
                direction: TransferDirection::Download,
                total_bytes,
                transferred_bytes: 0,
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
        request_id: u64,
        agent_id: String,
        path: String,
        total_bytes: u64,
        completion_sender: tokio::sync::oneshot::Sender<Result<CommandResult, String>>,
    ) {
        state.transfer_progress.insert(
            request_id,
            TransferProgressEntry {
                request_id,
                agent_id: agent_id.clone(),
                path,
                direction: TransferDirection::Upload,
                total_bytes,
                transferred_bytes: 0,
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

    fn increment_download_progress(state: &mut RouterState, request_id: u64, bytes: u64) {
        if let Some(progress) = state.transfer_progress.get_mut(&request_id) {
            progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
            progress.error = None;
        }
    }

    fn increment_upload_progress(state: &mut RouterState, request_id: u64, bytes: u64) {
        if let Some(progress) = state.transfer_progress.get_mut(&request_id) {
            progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
            progress.error = None;
        }
    }

    fn mark_transfer_completed(state: &mut RouterState, request_id: u64) {
        if let Some(progress) = state.transfer_progress.get_mut(&request_id) {
            progress.state = TransferProgressState::Completed;
            progress.transferred_bytes = progress.total_bytes;
            progress.error = None;
        }
    }

    fn mark_transfer_errored(state: &mut RouterState, request_id: u64, error_message: String) {
        if let Some(progress) = state.transfer_progress.get_mut(&request_id) {
            progress.state = TransferProgressState::Errored;
            progress.error = Some(error_message);
        }
    }

    fn list_transfer_progress(state: &RouterState) -> TransferProgressListResponse {
        let mut transfers: Vec<_> = state.transfer_progress.values().cloned().collect();
        transfers.sort_by(|left, right| right.request_id.cmp(&left.request_id));
        TransferProgressListResponse { transfers }
    }

    fn notify_ui_refresh(state: &mut RouterState) {
        Self::broadcast_ui_event(state, UiEvent::Refresh);
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
        agent_id: String,
        chunk: crate::streaming::StreamChunk,
    ) {
        let request_id = chunk.request_id;

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
            Self::increment_download_progress(state, request_id, chunk.data.len() as u64);
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
                request_id,
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
            Self::mark_transfer_errored(state, request_id, error_message);
        } else if chunk.is_last {
            Self::mark_transfer_completed(state, request_id);
        }

        if chunk.is_last || chunk.is_error {
            state.transfers.remove(&request_id);
            Self::notify_ui_refresh(state);
            log!(
                Level::Info,
                "Streaming complete: agent_id={}, request_id={}, total_chunks={}, is_error={}",
                agent_id,
                request_id,
                chunk.chunk_index + 1,
                chunk.is_error
            );
        }
    }

    fn finish_upload_transfer(
        state: &mut RouterState,
        agent_id: String,
        request_id: u64,
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
                Self::mark_transfer_completed(state, request_id);
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
                Self::mark_transfer_errored(state, request_id, message.clone());
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
                    request_id,
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

    fn cleanup_agent_requests(state: &mut RouterState, agent_id: &str) {
        let orphaned_oneshot: Vec<u64> = state
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

        let orphaned_transfers: Vec<u64> = state
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
                        Self::mark_transfer_errored(state, *request_id, disconnect_message.clone());
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
                        Self::mark_transfer_errored(state, *request_id, disconnect_message.clone());
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

        if !orphaned_transfers.is_empty() {
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
        _myself: ActorRef<Self::Msg>,
        _args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        log!(Level::Info, "RouterActor started");
        Ok(RouterState {
            agents: HashMap::new(),
            rest_pending_responses: HashMap::new(),
            transfers: HashMap::new(),
            transfer_progress: HashMap::new(),
            ui_subscribers: HashMap::new(),
            next_request_id: 1,
        })
    }

    async fn handle(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            RouterMsg::RegisterAgent {
                agent_id,
                agent_name,
                socket_id,
                session_ref,
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
                    let _ = session_ref.cast(SessionMsg::OutgoingMessage(Message::Error {
                        message: format!("Agent with name '{}' already connected", agent_name),
                    }));
                    return Ok(());
                }

                log!(
                    Level::Info,
                    "Agent registered: agent_id={}, agent_name={}, socket_id={}",
                    agent_id,
                    agent_name,
                    socket_id
                );
                let connected_at = chrono::Utc::now().timestamp();
                state.agents.insert(
                    agent_id.clone(),
                    AgentInfo {
                        agent_name,
                        socket_id,
                        session_ref,
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

                Self::cleanup_agent_requests(state, &agent_id);
            }
            RouterMsg::RouteResponse {
                agent_id,
                request_id,
                result,
            } => {
                if let Some((reply, stored_agent_id)) =
                    state.rest_pending_responses.remove(&request_id)
                {
                    log!(
                        Level::Info,
                        "Routing REST response: agent_id={}, request_id={}, result={:?}",
                        agent_id,
                        request_id,
                        result
                    );

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
                    // RouteResponse is used for any final CommandResult coming back from an agent,
                    // not only for one-shot REST commands. Uploads stream their payload as binary
                    // chunks, but the final success/error still arrives as a CommandResult keyed by
                    // the same request_id, so if there is no pending REST reply this may still be
                    // the completion of an in-flight upload transfer.
                    Self::finish_upload_transfer(state, agent_id, request_id, result);
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
            RouterMsg::ExecuteCommandRest {
                agent_id,
                command,
                reply,
            } => {
                let request_id = state.next_id();

                log!(
                    Level::Info,
                    "Routing REST command: agent_id={}, request_id={}, command={:?}",
                    agent_id,
                    request_id,
                    command
                );
                if let Some(agent_info) = state.agents.get(&agent_id) {
                    state
                        .rest_pending_responses
                        .insert(request_id, (reply, agent_id.clone()));
                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));
                } else {
                    let _ = reply.send(CommandResult::Error {
                        message: format!("Agent not found: {}", agent_id),
                    });
                }
            }
            RouterMsg::RouteStreamChunk { agent_id, chunk } => {
                Self::route_download_chunk(state, agent_id, chunk);
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
                        request_id,
                        agent_id.clone(),
                        path,
                        total_bytes,
                        chunk_sender,
                    );

                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));
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
                        request_id,
                        agent_id.clone(),
                        path,
                        total_bytes,
                        completion_sender,
                    );

                    let _ = agent_info.session_ref.cast(SessionMsg::OutgoingMessage(
                        Message::Command {
                            agent_id: agent_id.clone(),
                            request_id,
                            command,
                        },
                    ));
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
                        Self::increment_upload_progress(state, request_id, chunk.data.len() as u64);
                    }

                    if chunk.is_error {
                        let error_message = if chunk.data.is_empty() {
                            "Upload aborted by server".to_string()
                        } else {
                            String::from_utf8_lossy(&chunk.data).to_string()
                        };
                        Self::mark_transfer_errored(state, request_id, error_message);
                    }

                    let _ = agent_info
                        .session_ref
                        .cast(SessionMsg::OutgoingBinary(chunk.to_bytes()));
                    let _ = reply.send(Ok(()));
                } else {
                    Self::mark_transfer_errored(
                        state,
                        request_id,
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
        }
        Ok(())
    }
}
