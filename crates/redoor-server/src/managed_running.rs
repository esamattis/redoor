//! Which managed devices the user wants running, kept across server restarts.
//!
//! Managed agents are daemons that outlive the server. A restarted server that started every
//! device dormant would reject each surviving daemon as `stopped`, which ends it and its
//! shells, and would never rebuild an SSH tunnel. So Start and Retry start record the device
//! here, Stop, delete and configuration changes remove it, and startup starts the listed
//! devices again before the listener accepts connections.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use redoor_core::log;
use redoor_protocol::wire::log::Level;
use serde::{Deserialize, Serialize};

/// File name inside the server's data directory.
const FILE_NAME: &str = "managed-running.json";

/// The persisted document.
#[derive(Default, Serialize, Deserialize)]
struct Document {
    /// Device ids (supervisor keys) of the desired-running managed devices.
    running: BTreeSet<String>,
}

/// The desired-running set and its file.
///
/// Every change rewrites the whole (tiny) file with a rename, so a crash never leaves a
/// half-written list. The async mutex serializes writers, so the file always ends with the
/// latest set.
#[derive(Clone)]
pub(crate) struct DesiredRunningStore {
    /// `<data_dir>/managed-running.json`.
    path: PathBuf,
    /// The current set, held while it is written.
    running: Arc<tokio::sync::Mutex<BTreeSet<String>>>,
}

impl DesiredRunningStore {
    /// Loads the set from `data_dir`; a missing or unreadable file means nothing runs, which
    /// is the safe answer: the user starts devices again.
    pub(crate) async fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE_NAME);
        let running = match tokio::fs::read(&path).await {
            Ok(bytes) => match serde_json::from_slice::<Document>(&bytes) {
                Ok(document) => document.running,
                Err(error) => {
                    log!(
                        Level::Warning,
                        "Ignoring an unreadable desired-running list: path={}, error={}",
                        path.display(),
                        error
                    );
                    BTreeSet::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(error) => {
                log!(
                    Level::Warning,
                    "Failed to read the desired-running list: path={}, error={}",
                    path.display(),
                    error
                );
                BTreeSet::new()
            }
        };
        Self {
            path,
            running: Arc::new(tokio::sync::Mutex::new(running)),
        }
    }

    /// The listed device keys.
    pub(crate) async fn listed(&self) -> Vec<String> {
        self.running.lock().await.iter().cloned().collect()
    }

    /// Records `key` as desired-running.
    pub(crate) async fn add(&self, key: &str) {
        self.update(|running| running.insert(key.to_string())).await;
    }

    /// Records `key` as stopped.
    pub(crate) async fn remove(&self, key: &str) {
        self.update(|running| running.remove(key)).await;
    }

    /// Keeps only the keys `keep` accepts, dropping devices that are no longer configured.
    pub(crate) async fn retain(&self, keep: impl Fn(&str) -> bool) {
        self.update(|running| {
            let before = running.len();
            running.retain(|key| keep(key));
            running.len() != before
        })
        .await;
    }

    /// Applies `change` and writes the file when it reports a change.
    ///
    /// A failed write is logged rather than returned: the device's state in memory is
    /// already right, and only the next server start would miss the change.
    async fn update(&self, change: impl FnOnce(&mut BTreeSet<String>) -> bool) {
        let mut running = self.running.lock().await;
        if !change(&mut running) {
            return;
        }
        let document = Document {
            running: running.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&document).expect("the list serializes");
        if let Some(parent) = self.path.parent()
            && let Err(error) = tokio::fs::create_dir_all(parent).await
        {
            log!(
                Level::Warning,
                "Failed to create the directory of the desired-running list: path={}, error={}",
                parent.display(),
                error
            );
            return;
        }
        if let Err(error) = crate::ssh::keys::write_atomically(&self.path, &bytes, 0o600).await {
            log!(
                Level::Warning,
                "Failed to save the desired-running list: path={}, error={}",
                self.path.display(),
                error
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The set survives a reload, which is what a server restart does.
    #[tokio::test]
    async fn changes_survive_a_reload() {
        let directory = redoor_core::test_support::TempDir::create();
        let store = DesiredRunningStore::load(directory.path()).await;
        store.add("dev_a").await;
        store.add("dev_b").await;
        store.remove("dev_a").await;

        let reloaded = DesiredRunningStore::load(directory.path()).await;
        // A started device stays listed; a stopped one is gone.
        assert_eq!(reloaded.listed().await, vec!["dev_b".to_string()]);

        reloaded.retain(|key| key != "dev_b").await;
        // Devices removed from the config are dropped on the next write.
        assert!(
            DesiredRunningStore::load(directory.path())
                .await
                .listed()
                .await
                .is_empty()
        );
    }

    /// A damaged file starts nothing instead of failing the server.
    #[tokio::test]
    async fn unreadable_file_lists_nothing() {
        let directory = redoor_core::test_support::TempDir::create();
        tokio::fs::write(directory.path().join(FILE_NAME), b"not json")
            .await
            .unwrap();
        // Starting nothing is safe: the user can start the devices again.
        assert!(
            DesiredRunningStore::load(directory.path())
                .await
                .listed()
                .await
                .is_empty()
        );
    }
}
