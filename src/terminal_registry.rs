use crate::terminal_protocol::TerminalId;
use crate::types::AgentId;
use axum::extract::ws::WebSocket;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use thiserror::Error;
use tokio::sync::oneshot;

const MAX_PENDING_TERMINALS: usize = 64;
const MAX_PENDING_TERMINALS_PER_AGENT: usize = 8;

/// One not-yet-paired tunnel created by a browser connection.
struct PendingTerminal {
    agent_id: AgentId,
    token: String,
    agent_socket_sender: oneshot::Sender<WebSocket>,
}

/// Reports a rejected pending-terminal registration without exposing secrets.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RegisterTerminalError {
    #[error("terminal identifier is already pending")]
    Duplicate,
    #[error("too many terminal connections are pending")]
    LimitReached,
}

/// Reports why a dedicated agent socket could not consume a rendezvous entry.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AttachTerminalError {
    #[error("terminal is not pending")]
    NotFound,
    #[error("terminal authentication failed")]
    AuthenticationFailed,
    #[error("browser terminal connection ended")]
    BrowserDisconnected,
}

/// Short-lived, process-local state pairing browser and dedicated agent sockets.
#[derive(Clone, Default)]
pub struct TerminalRegistry {
    inner: Arc<Mutex<HashMap<TerminalId, PendingTerminal>>>,
}

impl TerminalRegistry {
    /// Creates an empty rendezvous registry shared by router and HTTP handlers.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one bounded pending setup before the agent receives its token.
    pub fn register_pending(
        &self,
        terminal_id: TerminalId,
        agent_id: AgentId,
        token: String,
        agent_socket_sender: oneshot::Sender<WebSocket>,
    ) -> Result<(), RegisterTerminalError> {
        let mut entries = self.inner.lock().expect("terminal registry mutex poisoned");
        if entries.contains_key(&terminal_id) {
            return Err(RegisterTerminalError::Duplicate);
        }
        let agent_pending = entries
            .values()
            .filter(|entry| entry.agent_id == agent_id)
            .count();
        if entries.len() >= MAX_PENDING_TERMINALS
            || agent_pending >= MAX_PENDING_TERMINALS_PER_AGENT
        {
            return Err(RegisterTerminalError::LimitReached);
        }
        entries.insert(
            terminal_id,
            PendingTerminal {
                agent_id,
                token,
                agent_socket_sender,
            },
        );
        Ok(())
    }

    /// Atomically validates and consumes a one-time token before handing off the socket.
    pub fn attach_agent(
        &self,
        terminal_id: &TerminalId,
        token: &str,
        socket: WebSocket,
    ) -> Result<(), AttachTerminalError> {
        let sender = self.take_authenticated_sender(terminal_id, token)?;
        sender
            .send(socket)
            .map_err(|_| AttachTerminalError::BrowserDisconnected)
    }

    /// Consumes an authenticated entry without holding the registry lock during handoff.
    fn take_authenticated_sender(
        &self,
        terminal_id: &TerminalId,
        token: &str,
    ) -> Result<oneshot::Sender<WebSocket>, AttachTerminalError> {
        let sender = {
            let mut entries = self.inner.lock().expect("terminal registry mutex poisoned");
            let Some(entry) = entries.get(terminal_id) else {
                return Err(AttachTerminalError::NotFound);
            };
            if entry.token != token {
                return Err(AttachTerminalError::AuthenticationFailed);
            }
            entries
                .remove(terminal_id)
                .expect("checked terminal entry")
                .agent_socket_sender
        };
        Ok(sender)
    }

    /// Removes one setup when its browser disconnects or times out.
    pub fn remove_pending(&self, terminal_id: &TerminalId) {
        self.inner
            .lock()
            .expect("terminal registry mutex poisoned")
            .remove(terminal_id);
    }

    /// Removes every unpaired setup whose authoritative control agent disconnected.
    pub fn remove_agent_pending(&self, agent_id: &AgentId) {
        self.inner
            .lock()
            .expect("terminal registry mutex poisoned")
            .retain(|_, entry| &entry.agent_id != agent_id);
    }

    /// Counts entries only for focused leak and single-use tests.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("terminal registry mutex poisoned")
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn terminal(value: u128) -> TerminalId {
        TerminalId(Uuid::from_u128(value))
    }

    #[test]
    fn token_is_single_use_and_wrong_token_does_not_consume_entry() {
        let registry = TerminalRegistry::new();
        let (sender, _receiver) = oneshot::channel();
        registry
            .register_pending(
                terminal(1),
                AgentId::from("agent-1"),
                "correct".to_string(),
                sender,
            )
            .unwrap();
        // A guessed token must not consume the legitimate browser rendezvous.
        assert_eq!(
            registry
                .take_authenticated_sender(&terminal(1), "wrong")
                .unwrap_err(),
            AttachTerminalError::AuthenticationFailed
        );
        // The pending entry remains available after a failed authentication attempt.
        assert_eq!(registry.len(), 1);
        // The correct token consumes the entry exactly once.
        assert!(
            registry
                .take_authenticated_sender(&terminal(1), "correct")
                .is_ok()
        );
        // A duplicate agent attach cannot reuse the consumed secret.
        assert_eq!(
            registry
                .take_authenticated_sender(&terminal(1), "correct")
                .unwrap_err(),
            AttachTerminalError::NotFound
        );
    }

    #[test]
    fn agent_cleanup_only_removes_its_pending_entries() {
        let registry = TerminalRegistry::new();
        for (id, agent) in [(1, "agent-1"), (2, "agent-1"), (3, "agent-2")] {
            let (sender, _receiver) = oneshot::channel();
            registry
                .register_pending(
                    terminal(id),
                    AgentId::from(agent),
                    format!("token-{id}"),
                    sender,
                )
                .unwrap();
        }
        registry.remove_agent_pending(&AgentId::from("agent-1"));
        // Disconnect cleanup removes every setup owned by the departed agent.
        assert_eq!(registry.len(), 1);
        // Another connected agent's setup remains pairable.
        assert!(
            registry
                .take_authenticated_sender(&terminal(3), "token-3")
                .is_ok()
        );
    }
}
