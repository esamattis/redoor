//! The server's saved index of terminal sessions.
//!
//! Shells run in the agents and survive a server restart, but a restarted server only hears
//! about them once each agent has reconnected. Browsers reload their session list right after
//! the restart and would drop every tab they cannot find, so the index is saved and loaded
//! again: the tabs stay, and attaching works as soon as the agent is back.

use redoor_core::log;
use redoor_protocol::{
    ids::{AgentId, TerminalSessionId},
    wire::{log::Level, terminal::TerminalSessionRecord},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::sync::watch;

/// File name of the index in the server data directory.
const STORE_FILE: &str = "terminal-sessions.json";

/// One session as saved: the agent's record and which agent runs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredSession {
    pub(crate) agent_id: AgentId,
    #[serde(flatten)]
    pub(crate) record: TerminalSessionRecord,
    /// The agent no longer runs the session; the record only explains how it ended.
    #[serde(default)]
    pub(crate) orphaned: bool,
}

/// A session closed while its agent was away; the agent is told when it reconnects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingClose {
    pub(crate) agent_id: AgentId,
    pub(crate) id: TerminalSessionId,
}

/// Everything the index saves.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredSessions {
    pub(crate) sessions: Vec<StoredSession>,
    pub(crate) pending_closes: Vec<PendingClose>,
}

/// Writes the latest index in the background, so saving never waits inside a request or the
/// agent session loop, and a burst of changes ends in one write of the newest state.
#[derive(Clone)]
pub(crate) struct SessionStore {
    latest: std::sync::Arc<watch::Sender<StoredSessions>>,
}

impl SessionStore {
    /// Loads the index from `data_dir` and starts the writer. An unreadable index is logged
    /// and replaced, because losing it only loses tabs, never a shell.
    pub(crate) async fn open(data_dir: PathBuf) -> (Self, StoredSessions) {
        let path = data_dir.join(STORE_FILE);
        let stored = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                log!(
                    Level::Warning,
                    "Ignoring unreadable terminal session index {}: {error}",
                    path.display()
                );
                StoredSessions::default()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredSessions::default(),
            Err(error) => {
                log!(
                    Level::Warning,
                    "Failed to read terminal session index {}: {error}",
                    path.display()
                );
                StoredSessions::default()
            }
        };
        let (latest, changes) = watch::channel(stored.clone());
        tokio::spawn(write_changes(path, changes));
        (
            Self {
                latest: std::sync::Arc::new(latest),
            },
            stored,
        )
    }

    /// A store that saves nothing, for tests.
    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self {
            latest: std::sync::Arc::new(watch::channel(StoredSessions::default()).0),
        }
    }

    /// Queues `sessions` to be saved; a newer call before the write replaces it.
    pub(crate) fn save(&self, sessions: StoredSessions) {
        self.latest.send_if_modified(|latest| {
            let changed = *latest != sessions;
            *latest = sessions;
            changed
        });
    }
}

/// Saves each new version of the index until the store is dropped.
async fn write_changes(path: PathBuf, mut changes: watch::Receiver<StoredSessions>) {
    while changes.changed().await.is_ok() {
        let sessions = changes.borrow_and_update().clone();
        let result = match serde_json::to_vec_pretty(&sessions) {
            Ok(bytes) => crate::ssh::keys::write_atomically(&path, &bytes, 0o600).await,
            Err(error) => Err(std::io::Error::other(error)),
        };
        if let Err(error) = result {
            log!(
                Level::Warning,
                "Failed to save terminal session index {}: {error}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
    use redoor_protocol::{api::terminals::TerminalSessionStatus, ids::UnixTimestampMillis};

    /// A saved index comes back after a restart, which is what keeps the tabs.
    #[tokio::test]
    async fn saved_sessions_load_again() {
        let dir = TempDir::create();
        let (store, loaded) = SessionStore::open(dir.path().to_path_buf()).await;
        // A first start has nothing saved.
        assert_eq!(loaded, StoredSessions::default());
        let saved = StoredSessions {
            sessions: vec![StoredSession {
                agent_id: redoor_core::test_support::test_agent_id("agent"),
                record: TerminalSessionRecord {
                    id: TerminalSessionId::new(),
                    cwd: "/".to_string(),
                    title: "agent 1".to_string(),
                    number: 1,
                    created_at: UnixTimestampMillis::now(),
                    status: TerminalSessionStatus::Running,
                },
                orphaned: false,
            }],
            pending_closes: Vec::new(),
        };
        store.save(saved.clone());
        let path = dir.path().join(STORE_FILE);
        loop {
            if let Ok(bytes) = tokio::fs::read(&path).await
                && serde_json::from_slice::<StoredSessions>(&bytes)
                    .ok()
                    .as_ref()
                    == Some(&saved)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        let (_store, reloaded) = SessionStore::open(dir.path().to_path_buf()).await;
        // The restarted server lists the same sessions before any agent reconnects.
        assert_eq!(reloaded, saved);
    }
}
