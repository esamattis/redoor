//! Every terminal session of the server, looked up by id from REST and the attach socket.

use super::TerminalsChangedNotifier;
use super::session::{
    TerminalInput, TerminalIo, TerminalOutput, TerminalSessionHandle, spawn_session,
};
use crate::actors::lanes::ControlLanes;
use crate::actors::router::{
    OpenTerminalRequest, OutboundStream, OutputReceiver, RouterError, RouterHandle, RouterMsg,
    StreamCloseGuard, TerminalStream,
};
use bytes::Bytes;
use redoor_protocol::{
    api::terminals::{CreateTerminalSessionRequest, TerminalSessionInfo, TerminalSessionStatus},
    ids::{AgentId, RequestId, TerminalSessionId, UnixTimestampMillis},
    wire::{ServerToAgent, request::CommandError, stream::StreamChunk, terminal::TerminalSize},
};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Sessions kept at once, running or exited. Running ones are also capped per agent by the
/// router; this bounds exited ones, which keep their final screen until their tab closes.
pub(crate) const MAX_TERMINAL_SESSIONS: usize = 64;

/// Why a session could not be created; every case is a conflict the user can resolve.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CreateSessionError {
    #[error("Too many terminals are open on this agent")]
    AgentLimit,
    #[error("Too many terminal sessions are open; close some terminal tabs")]
    ServerLimit,
    #[error("Agent is not connected")]
    NotConnected,
}

/// Cheap-to-clone handle to the server's sessions. The lock is never held across `.await`.
#[derive(Clone)]
pub(crate) struct TerminalRegistry {
    sessions: Arc<Mutex<RegistryState>>,
    router: RouterHandle,
    notifier: TerminalsChangedNotifier,
}

/// The sessions and the counter that orders them.
#[derive(Default)]
struct RegistryState {
    sessions: HashMap<TerminalSessionId, RegistryEntry>,
    next_sequence: u64,
}

/// One session plus its creation order, which listing preserves.
struct RegistryEntry {
    sequence: u64,
    handle: TerminalSessionHandle,
}

impl TerminalRegistry {
    /// Creates an empty registry whose sessions open streams through `router`.
    pub(crate) fn new(router: RouterHandle) -> Self {
        Self {
            sessions: Arc::default(),
            notifier: TerminalsChangedNotifier::new(router.clone()),
            router,
        }
    }

    /// Locks the table, tolerating poison because every operation leaves it valid.
    fn state(&self) -> MutexGuard<'_, RegistryState> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens a terminal stream on the agent and starts a session for it.
    ///
    /// Waits only for the router to allocate the stream, not for the PTY, so a full agent
    /// is an error here instead of a dead tab, and the session is registered before the
    /// caller answers, so a list fetched after the reply already contains it.
    pub(crate) async fn create(
        &self,
        agent_id: AgentId,
        request: CreateTerminalSessionRequest,
    ) -> Result<TerminalSessionInfo, CreateSessionError> {
        if self.state().sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(CreateSessionError::ServerLimit);
        }
        let opened = self
            .router
            .request(|reply| {
                RouterMsg::OpenTerminal(OpenTerminalRequest {
                    agent_id: agent_id.clone(),
                    size: request.size,
                    cwd: request.cwd.clone(),
                    reply,
                })
            })
            .await;
        let terminal = match opened {
            Ok(Ok(terminal)) => terminal,
            Ok(Err(RouterError::StreamLimitReached { .. })) => {
                return Err(CreateSessionError::AgentLimit);
            }
            _ => return Err(CreateSessionError::NotConnected),
        };
        let info = TerminalSessionInfo {
            id: TerminalSessionId::new(),
            agent_id: agent_id.clone(),
            cwd: request.cwd,
            title: request.title,
            number: request.number,
            created_at: UnixTimestampMillis::now(),
            status: TerminalSessionStatus::Starting,
            attached: false,
        };
        let handle = spawn_session(
            info.clone(),
            request.size,
            router_io(&self.router, agent_id, terminal),
            self.notifier.clone(),
        );
        {
            let mut state = self.state();
            let sequence = state.next_sequence;
            state.next_sequence += 1;
            state
                .sessions
                .insert(info.id, RegistryEntry { sequence, handle });
        }
        self.notifier.publish();
        Ok(info)
    }

    /// Every session, in creation order.
    pub(crate) fn list(&self) -> Vec<TerminalSessionInfo> {
        let state = self.state();
        let mut entries = state.sessions.values().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.sequence);
        entries.iter().map(|entry| entry.handle.info()).collect()
    }

    /// The session to attach to, if it exists.
    pub(crate) fn get(&self, id: TerminalSessionId) -> Option<TerminalSessionHandle> {
        self.state()
            .sessions
            .get(&id)
            .map(|entry| entry.handle.clone())
    }

    /// Ends and forgets a session; returns whether it existed. Answers once the attached
    /// viewer was told and the agent stream released.
    pub(crate) async fn close(&self, id: TerminalSessionId) -> bool {
        let removed = self.state().sessions.remove(&id);
        let Some(entry) = removed else {
            return false;
        };
        entry.handle.close().await;
        self.notifier.publish();
        true
    }
}

/// Adapts the router's terminal stream to the session's input and output sides.
fn router_io(
    router: &RouterHandle,
    agent_id: AgentId,
    terminal: TerminalStream,
) -> TerminalIo<OutputReceiver, RouterTerminalInput> {
    let close = StreamCloseGuard::new(router.clone(), agent_id, terminal.stream);
    let TerminalStream {
        stream,
        output,
        input,
        events,
    } = terminal;
    TerminalIo {
        output,
        input: RouterTerminalInput {
            stream,
            lanes: input.lease().link.lanes().clone(),
            input,
        },
        events,
        close: Some(close),
    }
}

impl TerminalOutput for OutputReceiver {
    fn recv(&mut self) -> impl Future<Output = Option<Result<StreamChunk, CommandError>>> + Send {
        OutputReceiver::recv(self)
    }
}

/// The input side of a router terminal stream.
#[derive(Clone)]
pub(crate) struct RouterTerminalInput {
    stream: RequestId,
    /// Keystrokes, credited with the terminal window on the interactive lane.
    input: OutboundStream,
    /// Resizes travel as priority control frames, ahead of queued input.
    lanes: ControlLanes,
}

impl TerminalInput for RouterTerminalInput {
    async fn send(&self, bytes: Bytes) -> Result<(), ()> {
        self.input.send_data(&bytes, false).await.map_err(|_| ())
    }

    fn resize(&self, size: TerminalSize) {
        let resize = ServerToAgent::TerminalResize {
            stream: self.stream,
            size,
        };
        self.lanes.try_priority_or_command(resize);
    }
}
