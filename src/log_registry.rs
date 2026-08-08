use crate::{log_protocol::LogStreamId, types::AgentId};
use axum::extract::ws::WebSocket;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use thiserror::Error;
use tokio::sync::{oneshot, watch};

const MAX_PENDING_LOG_STREAMS: usize = 64;
const MAX_PENDING_LOG_STREAMS_PER_AGENT: usize = 8;

/// Holds one browser-owned socket handoff until its requested agent authenticates.
struct PendingLogStream {
    agent_id: AgentId,
    token: String,
    agent_socket_sender: oneshot::Sender<WebSocket>,
    agent_disconnect_sender: watch::Sender<bool>,
}

/// Retains only server-side cancellation after socket ownership moves into the relay.
struct ActiveLogStream {
    agent_id: AgentId,
    agent_disconnect_sender: watch::Sender<bool>,
}

/// Reports a rejected pending-log registration without exposing identifiers or secrets.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RegisterLogStreamError {
    /// Prevents ambiguous ownership if an identifier is accidentally reused.
    #[error("log stream identifier is already pending")]
    Duplicate,
    /// Bounds setup resources globally and per agent before any dedicated socket exists.
    #[error("too many log streams are pending")]
    LimitReached,
}

/// Reports why a dedicated agent socket could not consume a rendezvous entry.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AttachLogStreamError {
    /// Rejects stale or fabricated stream identifiers without revealing pending entries.
    #[error("log stream is not pending")]
    NotFound,
    /// Preserves the real browser rendezvous when an attacker guesses a wrong token.
    #[error("log stream authentication failed")]
    AuthenticationFailed,
    /// Drops a late agent socket after the owning browser has already departed.
    #[error("browser log connection ended")]
    BrowserDisconnected,
}

/// Keeps pending-to-active transitions atomic against authoritative agent cleanup.
#[derive(Default)]
struct LogRegistryState {
    pending: HashMap<LogStreamId, PendingLogStream>,
    active: HashMap<LogStreamId, ActiveLogStream>,
}

/// Short-lived process-local state pairing browser and dedicated agent log sockets.
#[derive(Clone, Default)]
pub struct LogRegistry {
    inner: Arc<Mutex<LogRegistryState>>,
}

impl LogRegistry {
    /// Creates an empty rendezvous registry shared by router and HTTP handlers.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one bounded pending setup before its one-time token reaches the agent.
    pub fn register_pending(
        &self,
        log_stream_id: LogStreamId,
        agent_id: AgentId,
        token: String,
        agent_socket_sender: oneshot::Sender<WebSocket>,
    ) -> Result<watch::Receiver<bool>, RegisterLogStreamError> {
        let mut state = self.inner.lock().expect("log registry mutex poisoned");
        if state.pending.contains_key(&log_stream_id) || state.active.contains_key(&log_stream_id) {
            return Err(RegisterLogStreamError::Duplicate);
        }
        let agent_pending = state
            .pending
            .values()
            .filter(|entry| entry.agent_id == agent_id)
            .count();
        if state.pending.len() >= MAX_PENDING_LOG_STREAMS
            || agent_pending >= MAX_PENDING_LOG_STREAMS_PER_AGENT
        {
            return Err(RegisterLogStreamError::LimitReached);
        }
        let (agent_disconnect_sender, agent_disconnect_receiver) = watch::channel(false);
        state.pending.insert(
            log_stream_id,
            PendingLogStream {
                agent_id,
                token,
                agent_socket_sender,
                agent_disconnect_sender,
            },
        );
        Ok(agent_disconnect_receiver)
    }

    /// Authenticates and hands off a dedicated socket without retaining it in the registry.
    pub fn attach_agent(
        &self,
        log_stream_id: &LogStreamId,
        token: &str,
        socket: WebSocket,
    ) -> Result<(), AttachLogStreamError> {
        let sender = self.activate_authenticated_sender(log_stream_id, token)?;
        if sender.send(socket).is_err() {
            self.remove(log_stream_id);
            return Err(AttachLogStreamError::BrowserDisconnected);
        }
        Ok(())
    }

    /// Consumes an authenticated entry without holding the registry lock during socket handoff.
    fn activate_authenticated_sender(
        &self,
        log_stream_id: &LogStreamId,
        token: &str,
    ) -> Result<oneshot::Sender<WebSocket>, AttachLogStreamError> {
        let mut state = self.inner.lock().expect("log registry mutex poisoned");
        let Some(entry) = state.pending.get(log_stream_id) else {
            return Err(AttachLogStreamError::NotFound);
        };
        if entry.token != token {
            return Err(AttachLogStreamError::AuthenticationFailed);
        }
        let pending = state
            .pending
            .remove(log_stream_id)
            .expect("checked log stream entry");
        state.active.insert(
            log_stream_id.clone(),
            ActiveLogStream {
                agent_id: pending.agent_id,
                agent_disconnect_sender: pending.agent_disconnect_sender,
            },
        );
        Ok(pending.agent_socket_sender)
    }

    /// Removes either setup phase and signals a paired relay before releasing its handle.
    pub fn remove(&self, log_stream_id: &LogStreamId) {
        let active = {
            let mut state = self.inner.lock().expect("log registry mutex poisoned");
            state.pending.remove(log_stream_id);
            state.active.remove(log_stream_id)
        };
        if let Some(active) = active {
            let _ = active.agent_disconnect_sender.send(true);
        }
    }

    /// Removes pending setups and cancels paired relays for one authoritative agent connection.
    pub fn remove_agent(&self, agent_id: &AgentId) {
        let mut state = self.inner.lock().expect("log registry mutex poisoned");
        state.pending.retain(|_, entry| &entry.agent_id != agent_id);
        state.active.retain(|_, entry| {
            if &entry.agent_id != agent_id {
                return true;
            }
            let _ = entry.agent_disconnect_sender.send(true);
            false
        });
    }

    /// Counts pending entries only for focused setup leak and limit tests.
    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.inner
            .lock()
            .expect("log registry mutex poisoned")
            .pending
            .len()
    }

    /// Counts paired cancellation handles only for focused authoritative cleanup tests.
    #[cfg(test)]
    pub fn active_len(&self) -> usize {
        self.inner
            .lock()
            .expect("log registry mutex poisoned")
            .active
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// Creates deterministic identifiers so registry tests can target exact entries.
    fn stream(value: u128) -> LogStreamId {
        LogStreamId(Uuid::from_u128(value))
    }

    /// Registers a pending entry while retaining its browser receiver for lifecycle control.
    fn register(
        registry: &LogRegistry,
        id: u128,
        agent: &str,
    ) -> (oneshot::Receiver<WebSocket>, watch::Receiver<bool>) {
        let (sender, receiver) = oneshot::channel();
        let disconnect = registry
            .register_pending(
                stream(id),
                AgentId::from(agent),
                format!("token-{id}"),
                sender,
            )
            .expect("test pending stream should register");
        (receiver, disconnect)
    }

    /// Protects one-time authentication without allowing guesses to destroy valid setup state.
    #[test]
    fn token_is_single_use_and_wrong_token_preserves_entry() {
        let registry = LogRegistry::new();
        let (_receiver, _disconnect) = register(&registry, 1, "agent-1");
        // A guessed token must not consume the legitimate browser rendezvous.
        assert_eq!(
            registry
                .activate_authenticated_sender(&stream(1), "wrong")
                .unwrap_err(),
            AttachLogStreamError::AuthenticationFailed
        );
        // The valid pending entry remains after failed authentication.
        assert_eq!(registry.pending_len(), 1);
        // Correct possession consumes the token exactly once and begins active tracking.
        assert!(
            registry
                .activate_authenticated_sender(&stream(1), "token-1")
                .is_ok()
        );
        // A second attach cannot replay the consumed secret.
        assert_eq!(
            registry
                .activate_authenticated_sender(&stream(1), "token-1")
                .unwrap_err(),
            AttachLogStreamError::NotFound
        );
    }

    /// Protects immediate browser-owned and agent-owned pending cleanup.
    #[test]
    fn cleanup_removes_only_the_requested_owners() {
        let registry = LogRegistry::new();
        let (_first, _first_disconnect) = register(&registry, 1, "agent-1");
        let (_second, _second_disconnect) = register(&registry, 2, "agent-1");
        let (_other, _other_disconnect) = register(&registry, 3, "agent-2");
        registry.remove(&stream(1));
        // Browser teardown removes its one setup without waiting for timeout.
        assert_eq!(registry.pending_len(), 2);
        registry.remove_agent(&AgentId::from("agent-1"));
        // Control disconnect removes every remaining setup for only that agent.
        assert_eq!(registry.pending_len(), 1);
        // Another authoritative agent's rendezvous remains usable.
        assert!(
            registry
                .activate_authenticated_sender(&stream(3), "token-3")
                .is_ok()
        );
    }

    /// Protects authoritative cleanup after authentication has moved a setup into paired state.
    #[test]
    fn authoritative_agent_cleanup_cancels_paired_relays() {
        let registry = LogRegistry::new();
        let (_socket_receiver, disconnect) = register(&registry, 1, "agent-1");
        let _socket_sender = registry
            .activate_authenticated_sender(&stream(1), "token-1")
            .expect("valid authentication should activate the relay");
        // Authentication must move ownership out of pending state without losing cleanup tracking.
        assert_eq!(registry.pending_len(), 0);
        // Exactly one lightweight active cancellation handle must remain for the paired relay.
        assert_eq!(registry.active_len(), 1);

        registry.remove_agent(&AgentId::from("agent-1"));

        // Authoritative disconnect must synchronously signal the paired browser relay.
        assert!(*disconnect.borrow());
        // Cleanup must release active registry capacity immediately rather than waiting for timeout.
        assert_eq!(registry.active_len(), 0);
    }

    /// Protects the per-agent cap before one browser can monopolize global pending capacity.
    #[test]
    fn enforces_per_agent_pending_limit() {
        let registry = LogRegistry::new();
        let mut receivers = Vec::new();
        for id in 0..MAX_PENDING_LOG_STREAMS_PER_AGENT as u128 {
            receivers.push(register(&registry, id, "agent-1"));
        }
        let (sender, _receiver) = oneshot::channel();
        let result = registry.register_pending(
            stream(100),
            AgentId::from("agent-1"),
            "extra".to_string(),
            sender,
        );
        // The ninth pending setup for one agent must be rejected even below the global cap.
        assert!(matches!(result, Err(RegisterLogStreamError::LimitReached)));
        // Rejection must not leak an additional map entry.
        assert_eq!(registry.pending_len(), MAX_PENDING_LOG_STREAMS_PER_AGENT);
        drop(receivers);
    }

    /// Protects the process-wide cap across many distinct agents.
    #[test]
    fn enforces_global_pending_limit() {
        let registry = LogRegistry::new();
        let mut receivers = Vec::new();
        for id in 0..MAX_PENDING_LOG_STREAMS as u128 {
            receivers.push(register(&registry, id, &format!("agent-{id}")));
        }
        let (sender, _receiver) = oneshot::channel();
        let result = registry.register_pending(
            stream(1000),
            AgentId::from("extra-agent"),
            "extra".to_string(),
            sender,
        );
        // The global cap prevents pending browser sockets from growing without bound.
        assert!(matches!(result, Err(RegisterLogStreamError::LimitReached)));
        // Rejection keeps the registry at its documented maximum.
        assert_eq!(registry.pending_len(), MAX_PENDING_LOG_STREAMS);
        drop(receivers);
    }
}
