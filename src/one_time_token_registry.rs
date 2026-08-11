use crate::types::AgentId;
use std::{
    collections::HashMap,
    ops::Range,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

/// Retains streamed coverage so interrupted requests can continue using the same token.
#[derive(Default)]
struct TokenEntry {
    /// File size associated with the current coverage; a changed file starts over.
    file_size: Option<u64>,
    /// Merged, non-overlapping half-open byte ranges handed to HTTP responses.
    downloaded_ranges: Vec<Range<u64>>,
}

/// Keeps the registry field readable while preserving exact agent-and-path token grouping.
type TokenEntries = HashMap<(AgentId, String), HashMap<Uuid, TokenEntry>>;

/// Process-local one-time download tokens grouped by their exact agent and absolute path.
#[derive(Clone, Default)]
pub struct OneTimeTokenRegistry {
    inner: Arc<Mutex<TokenEntries>>,
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
            .insert(token, TokenEntry::default());
        token
    }

    /// Lists only outstanding tokens for the exact agent and path in stable string order.
    pub fn list(&self, agent_id: &AgentId, absolute_path: &str) -> Vec<String> {
        let mut tokens = self
            .inner
            .lock()
            .expect("one-time token registry mutex poisoned")
            .get(&(agent_id.clone(), absolute_path.to_string()))
            .map(|tokens| tokens.keys().map(Uuid::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        tokens.sort_unstable();
        tokens
    }

    /// Checks exact token scope without consuming it so interrupted HTTP requests can retry.
    pub fn contains(&self, agent_id: &AgentId, absolute_path: &str, token: &Uuid) -> bool {
        self.inner
            .lock()
            .expect("one-time token registry mutex poisoned")
            .get(&(agent_id.clone(), absolute_path.to_string()))
            .is_some_and(|tokens| tokens.contains_key(token))
    }

    /// Adds delivered coverage and atomically removes the token only once the whole file is covered.
    pub fn record_downloaded_range(
        &self,
        agent_id: &AgentId,
        absolute_path: &str,
        token: &Uuid,
        downloaded_range: Range<u64>,
        file_size: u64,
    ) -> bool {
        if downloaded_range.start > downloaded_range.end || downloaded_range.end > file_size {
            return false;
        }

        let key = (agent_id.clone(), absolute_path.to_string());
        let mut entries = self
            .inner
            .lock()
            .expect("one-time token registry mutex poisoned");
        let Some(tokens) = entries.get_mut(&key) else {
            return false;
        };
        let Some(entry) = tokens.get_mut(token) else {
            return false;
        };

        if entry.file_size != Some(file_size) {
            entry.file_size = Some(file_size);
            entry.downloaded_ranges.clear();
        }
        entry.downloaded_ranges.push(downloaded_range);
        entry
            .downloaded_ranges
            .sort_unstable_by_key(|range| range.start);

        let mut merged_ranges: Vec<Range<u64>> = Vec::new();
        for range in entry.downloaded_ranges.drain(..) {
            if let Some(previous) = merged_ranges.last_mut()
                && range.start <= previous.end
            {
                previous.end = previous.end.max(range.end);
            } else {
                merged_ranges.push(range);
            }
        }
        entry.downloaded_ranges = merged_ranges;

        let fully_downloaded = file_size == 0
            || matches!(entry.downloaded_ranges.as_slice(), [range] if range.start == 0 && range.end == file_size);
        if !fully_downloaded {
            return false;
        }

        tokens.remove(token);
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

    /// Verifies each exact key can retain multiple independently completed tokens.
    #[test]
    fn supports_multiple_tokens_and_removes_completed_tokens() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let first = registry.create(agent_id.clone(), "/tmp/file".to_string());
        let second = registry.create(agent_id.clone(), "/tmp/file".to_string());

        // Both generated UUIDs remain outstanding until their individual use.
        assert_eq!(registry.list(&agent_id, "/tmp/file").len(), 2);
        // Completing one token leaves the other token available for a later request.
        assert!(registry.record_downloaded_range(&agent_id, "/tmp/file", &first, 0..4, 4));
        assert_eq!(
            registry.list(&agent_id, "/tmp/file"),
            vec![second.to_string()]
        );
        // A completed token cannot authorize a second request.
        assert!(!registry.contains(&agent_id, "/tmp/file", &first));
        // The final completed token removes the empty key from observable state.
        assert!(registry.record_downloaded_range(&agent_id, "/tmp/file", &second, 0..4, 4));
        assert!(registry.list(&agent_id, "/tmp/file").is_empty());
    }

    /// Verifies mismatched attempts cannot consume a legitimate token.
    #[test]
    fn failed_matches_preserve_the_valid_token() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let token = registry.create(agent_id.clone(), "/tmp/file".to_string());

        // Matching the UUID against another path must not authorize access.
        assert!(!registry.contains(&agent_id, "/tmp/other", &token));
        // Matching the UUID against another agent must not authorize access.
        assert!(!registry.contains(&AgentId::from("agent-2"), "/tmp/file", &token));
        // The correctly bound request remains authorized after failed attempts.
        assert!(registry.contains(&agent_id, "/tmp/file", &token));
    }

    /// Verifies disjoint retries consume the token only after covering the whole file.
    #[test]
    fn merges_retry_ranges_before_consuming_token() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let token = registry.create(agent_id.clone(), "/tmp/file".to_string());

        // A suffix alone must not consume a token or imply that its prefix was downloaded.
        assert!(!registry.record_downloaded_range(&agent_id, "/tmp/file", &token, 4..10, 10));
        assert!(registry.contains(&agent_id, "/tmp/file", &token));
        // Completing the missing prefix makes the merged coverage span the full file.
        assert!(registry.record_downloaded_range(&agent_id, "/tmp/file", &token, 0..4, 10));
        assert!(!registry.contains(&agent_id, "/tmp/file", &token));
    }

    /// Verifies concurrent full responses cannot both complete the same one-time token.
    #[test]
    fn concurrent_completion_has_one_winner() {
        let registry = OneTimeTokenRegistry::new();
        let agent_id = AgentId::from("agent-1");
        let token = registry.create(agent_id.clone(), "/tmp/file".to_string());
        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let registry = registry.clone();
                let agent_id = agent_id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.record_downloaded_range(&agent_id, "/tmp/file", &token, 0..4, 4)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let successes = handles
            .into_iter()
            .map(|handle| handle.join().expect("consumer thread must complete"))
            .filter(|consumed| *consumed)
            .count();

        // Holding coverage and removal under one lock permits exactly one winner.
        assert_eq!(successes, 1);
        // The winning request removes the token from registry memory.
        assert!(registry.list(&agent_id, "/tmp/file").is_empty());
    }
}
