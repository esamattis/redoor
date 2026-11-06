//! Bounded memory of agents that failed protocol negotiation.
//!
//! An agent whose protocol version differs from the server's is refused during the websocket
//! upgrade and never registers, so without this list it would be invisible everywhere except
//! the server log.

use redoor_protocol::ids::UnixTimestampMillis;
use redoor_protocol::wire::handshake::ProtocolMismatchAttempt;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

/// How many recent attempts are kept; a misconfigured agent retries forever, so the list must
/// not grow with it.
const MAX_ATTEMPTS: usize = 20;

/// Recent protocol-mismatched connection attempts, shared by the upgrade handlers and REST.
#[derive(Clone, Default)]
pub(crate) struct ProtocolMismatches {
    attempts: Arc<Mutex<VecDeque<ProtocolMismatchAttempt>>>,
}

impl ProtocolMismatches {
    /// Records one rejected attempt.
    ///
    /// A repeat from the same host (IP address and forwarded client) and version replaces the
    /// older entry, so one agent's retry loop does not push every other agent out of the list.
    /// The forwarded client is part of the key because behind a reverse proxy every agent
    /// shares the proxy's address and would otherwise collapse into one entry.
    pub(crate) fn record(
        &self,
        remote_address: String,
        forwarded_for: Option<String>,
        agent_version: Option<String>,
        offered_protocols: Vec<String>,
    ) {
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        attempts.retain(|attempt| {
            attempt.remote_address != remote_address
                || attempt.forwarded_for != forwarded_for
                || attempt.agent_version != agent_version
        });
        attempts.push_front(ProtocolMismatchAttempt {
            at: UnixTimestampMillis::now(),
            remote_address,
            forwarded_for,
            agent_version,
            offered_protocols,
        });
        attempts.truncate(MAX_ATTEMPTS);
    }

    /// The recorded attempts, newest first.
    pub(crate) fn list(&self) -> Vec<ProtocolMismatchAttempt> {
        self.attempts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the list stays bounded and a retrying agent occupies a single entry.
    #[test]
    fn list_is_bounded_and_deduplicates_retries() {
        let mismatches = ProtocolMismatches::default();
        for _ in 0..3 {
            mismatches.record("10.0.0.1:1".into(), None, Some("1.0.0".into()), Vec::new());
        }
        // A reconnect loop from one agent must not flood the list.
        assert_eq!(mismatches.list().len(), 1);
        for index in 0..(MAX_ATTEMPTS + 5) {
            mismatches.record(format!("10.0.1.{index}:1"), None, None, Vec::new());
        }
        let attempts = mismatches.list();
        // Unbounded growth would let any client exhaust server memory.
        assert_eq!(attempts.len(), MAX_ATTEMPTS);
        // The newest attempt is shown first.
        assert_eq!(
            attempts[0].remote_address,
            format!("10.0.1.{}:1", MAX_ATTEMPTS + 4)
        );
    }

    /// Verifies agents behind one reverse proxy stay separate entries.
    #[test]
    fn agents_behind_a_proxy_are_kept_apart() {
        let mismatches = ProtocolMismatches::default();
        for client in ["203.0.113.5", "203.0.113.6"] {
            mismatches.record(
                "10.87.1.10".into(),
                Some(client.into()),
                Some("1.0.0".into()),
                Vec::new(),
            );
        }
        // Every agent shares the proxy's address, so only the forwarded client tells them
        // apart; merging them would hide all but one outdated agent.
        assert_eq!(mismatches.list().len(), 2);
    }
}
