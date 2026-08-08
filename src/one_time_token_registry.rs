use crate::types::AgentId;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

/// Process-local one-time download tokens grouped by their exact agent and absolute path.
#[derive(Clone, Default)]
pub struct OneTimeTokenRegistry {
    inner: Arc<Mutex<HashMap<(AgentId, String), HashSet<Uuid>>>>,
}

impl OneTimeTokenRegistry {
    /// Creates an empty registry for one server process.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates another independently consumable token for the exact agent and path pair.
    pub fn create(&self, agent_id: AgentId, absolute_path: String) -> Uuid {
        debug_assert!(std::path::Path::new(&absolute_path).is_absolute());
        let token = Uuid::new_v4();
        self.inner
            .lock()
            .expect("one-time token registry mutex poisoned")
            .entry((agent_id, absolute_path))
            .or_default()
            .insert(token);
        token
    }

    /// Lists only outstanding tokens for the exact agent and path in stable string order.
    pub fn list(&self, agent_id: &AgentId, absolute_path: &str) -> Vec<String> {
        let mut tokens = self
            .inner
            .lock()
            .expect("one-time token registry mutex poisoned")
            .get(&(agent_id.clone(), absolute_path.to_string()))
            .map(|tokens| tokens.iter().map(Uuid::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        tokens.sort_unstable();
        tokens
    }

    /// Atomically consumes a matching UUID while preserving all tokens on mismatched attempts.
    pub fn consume(&self, agent_id: &AgentId, absolute_path: &str, token: &Uuid) -> bool {
        let key = (agent_id.clone(), absolute_path.to_string());
        let mut entries = self
            .inner
            .lock()
            .expect("one-time token registry mutex poisoned");
        let Some(tokens) = entries.get_mut(&key) else {
            return false;
        };
        if !tokens.remove(token) {
            return false;
        }
        if tokens.is_empty() {
            entries.remove(&key);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    /// Verifies each exact key can retain multiple independently consumable tokens.
    #[test]
    fn supports_multiple_tokens_and_removes_consumed_tokens() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let first = registry.create(agent_id.clone(), "/tmp/file".to_string());
        let second = registry.create(agent_id.clone(), "/tmp/file".to_string());

        // Both generated UUIDs remain outstanding until their individual use.
        assert_eq!(registry.list(&agent_id, "/tmp/file").len(), 2);
        // Consuming one token leaves the other token available for a later request.
        assert!(registry.consume(&agent_id, "/tmp/file", &first));
        assert_eq!(
            registry.list(&agent_id, "/tmp/file"),
            vec![second.to_string()]
        );
        // A consumed token cannot authorize a second request.
        assert!(!registry.consume(&agent_id, "/tmp/file", &first));
        // The final successful consumption removes the empty key from observable state.
        assert!(registry.consume(&agent_id, "/tmp/file", &second));
        assert!(registry.list(&agent_id, "/tmp/file").is_empty());
    }

    /// Verifies mismatched attempts cannot consume a legitimate token.
    #[test]
    fn failed_matches_preserve_the_valid_token() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let token = registry.create(agent_id.clone(), "/tmp/file".to_string());

        // Matching the UUID against another path must not affect the original key.
        assert!(!registry.consume(&agent_id, "/tmp/other", &token));
        // Matching the UUID against another agent must not affect the original key.
        assert!(!registry.consume(&AgentId::from("agent-2"), "/tmp/file", &token));
        // The correctly bound request can still consume the token after failed attempts.
        assert!(registry.consume(&agent_id, "/tmp/file", &token));
    }

    /// Verifies concurrent requests cannot both consume the same one-time token.
    #[test]
    fn concurrent_consumption_has_one_winner() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let token = registry.create(agent_id.clone(), "/tmp/file".to_string());
        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let registry = registry.clone();
                let agent_id = agent_id.clone();
                let token = token;
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.consume(&agent_id, "/tmp/file", &token)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let successes = handles
            .into_iter()
            .map(|handle| handle.join().expect("consumer thread must complete"))
            .filter(|consumed| *consumed)
            .count();

        // Holding validation and removal under one lock permits exactly one winner.
        assert_eq!(successes, 1);
        // The winning request removes the token from registry memory.
        assert!(registry.list(&agent_id, "/tmp/file").is_empty());
    }
}
