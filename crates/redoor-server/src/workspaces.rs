//! Per-user workspace storage: accounts (`account.json`), managed devices (`agents.json`),
//! layout version marker (`layout-version`), and the `(owner, AgentId)` runtime key.
//!
//! Every user's server-owned data lives under `<data_dir>/users/<dir>/` (mode 0700, files
//! 0600), reusing [`crate::http::user_state::user_directory`] so password and OIDC logins
//! with the same canonical username share one workspace.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use redoor_core::config::{AgentConfig, LocalAgentConfig, SshBackedAgentConfig};
use redoor_core::paths::AppPaths;
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::agent_auth::{AgentTokenKey, HandshakeNonce};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::http::user_state::{
    prepare_data_directory, prepare_user_directory, user_directory, write_private_file_atomically,
};

/// File at `<data_dir>/layout-version` marking a data directory initialized in or migrated to
/// the per-user workspace layout.
pub(crate) const LAYOUT_VERSION_FILE: &str = "layout-version";
/// Current on-disk data directory layout version (2 = per-user workspaces).
pub(crate) const CURRENT_LAYOUT_VERSION: u32 = 2;
/// File name of a user's account metadata and agent token.
const ACCOUNT_FILE: &str = "account.json";
/// File name of a user's managed device list.
const AGENTS_FILE: &str = "agents.json";
/// Schema version for `account.json`.
const ACCOUNT_DOCUMENT_VERSION: u32 = 1;
/// Schema version for `agents.json`.
const AGENTS_DOCUMENT_VERSION: u32 = 1;
/// Directory containing per-user workspace subdirectories.
const USERS_DIR: &str = "users";

/// Runtime identifier for a device owned by a specific user.
///
/// Keying router connections, inventory, flows, watchdogs, and held SSH keys by `(owner, id)`
/// lets two users share device names like `local` or `laptop` and prevents a standalone agent
/// whose token is reassigned to another user from colliding on its `agent-id`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AgentKey {
    /// Canonical username of the workspace that owns this device.
    pub owner: String,
    /// Stable device id (`dev_...`).
    pub id: AgentId,
}

impl AgentKey {
    /// Combines a canonical workspace owner and a device id into one runtime key.
    pub fn new(owner: impl Into<String>, id: AgentId) -> Self {
        Self {
            owner: owner.into(),
            id,
        }
    }

    /// Canonical username of the owning workspace.
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// Stable device id.
    pub fn id(&self) -> &AgentId {
        &self.id
    }

    /// Collision-free lookup key for [`crate::watchdog::WatchdogRegistry`].
    ///
    /// Using a NUL separator guarantees two `(owner, id)` pairs can never collide even when
    /// an OIDC username contains `/` or other punctuation.
    pub(crate) fn watchdog_key(&self) -> String {
        format!("{}\0{}", self.owner, self.id)
    }
}

impl fmt::Display for AgentKey {
    /// Formats as `<owner>/<id>` for logs and diagnostics.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.owner, self.id)
    }
}

/// Checks whether `<data_dir>/layout-version` is already present.
pub(crate) async fn has_layout_version(data_dir: &Path) -> Result<bool> {
    Ok(tokio::fs::try_exists(data_dir.join(LAYOUT_VERSION_FILE)).await?)
}

/// Writes `<data_dir>/layout-version` atomically so subsequent starts skip legacy detection.
pub(crate) async fn write_layout_version(paths: &AppPaths) -> Result<()> {
    let data_dir = prepare_data_directory(paths).await?;
    let content = format!("{CURRENT_LAYOUT_VERSION}\n");
    write_private_file_atomically(
        &data_dir.join(".layout-version.tmp"),
        &data_dir.join(LAYOUT_VERSION_FILE),
        content.as_bytes(),
    )
    .await
    .with_context(|| format!("Failed to write {LAYOUT_VERSION_FILE}"))
}

/// Persisted `<user_dir>/account.json` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccountDocument {
    version: u32,
    /// Canonical username, stored inside the file so startup can recover it even when the
    /// directory name is `~<sha256>` (e.g. an OIDC email address).
    username: String,
    /// Per-user secret agents present during the `/api/v1/agent/ws` HMAC handshake.
    agent_token: String,
}

/// In-memory entry for one user's account and precomputed HMAC key.
#[derive(Clone)]
struct AccountEntry {
    username: String,
    agent_token: String,
    key: AgentTokenKey,
}

impl AccountEntry {
    /// Precomputes the HMAC key once so `/api/v1/agent/ws` checks do not re-derive it.
    fn new(username: String, agent_token: String) -> Self {
        let key = AgentTokenKey::new(&agent_token);
        Self {
            username,
            agent_token,
            key,
        }
    }
}

/// In-memory registry and disk persistence for per-user `account.json` files.
#[derive(Clone)]
pub(crate) struct UserAccountStore {
    paths: AppPaths,
    accounts: Arc<RwLock<HashMap<String, AccountEntry>>>,
    write_lock: Arc<Mutex<()>>,
}

impl UserAccountStore {
    /// Creates an empty store backed by `paths`, without reading disk yet.
    pub(crate) fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            accounts: Arc::default(),
            write_lock: Arc::default(),
        }
    }

    /// Scans `<data_dir>/users/*/account.json` at startup so existing standalone and managed
    /// agents can authenticate immediately without waiting for their user to open the UI.
    pub(crate) async fn load_all(paths: AppPaths) -> Result<Self> {
        let store = Self::new(paths.clone());
        let users_dir = paths.data_dir()?.join(USERS_DIR);
        let mut entries = match tokio::fs::read_dir(&users_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(store),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Failed to read '{}'", users_dir.display()));
            }
        };
        let mut loaded = HashMap::new();
        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            if !file_type.is_dir() {
                continue;
            }
            let account_path = entry.path().join(ACCOUNT_FILE);
            match tokio::fs::read(&account_path).await {
                Ok(bytes) => {
                    let doc: AccountDocument = serde_json::from_slice(&bytes)
                        .with_context(|| format!("Failed to parse '{}'", account_path.display()))?;
                    anyhow::ensure!(
                        doc.version == ACCOUNT_DOCUMENT_VERSION,
                        "Unsupported account.json version {} in '{}'",
                        doc.version,
                        account_path.display()
                    );
                    anyhow::ensure!(
                        !doc.username.is_empty() && !doc.agent_token.is_empty(),
                        "Invalid empty username or agent_token in '{}'",
                        account_path.display()
                    );
                    loaded.insert(
                        doc.username.clone(),
                        AccountEntry::new(doc.username, doc.agent_token),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("Failed to read '{}'", account_path.display()));
                }
            }
        }
        *store.accounts.write().await = loaded;
        Ok(store)
    }

    /// Returns the user's `agent_token`, creating and persisting `account.json` on first use.
    pub(crate) async fn ensure_agent_token(&self, username: &str) -> Result<String> {
        if let Some(entry) = self.accounts.read().await.get(username) {
            return Ok(entry.agent_token.clone());
        }
        let _guard = self.write_lock.lock().await;
        if let Some(entry) = self.accounts.read().await.get(username) {
            return Ok(entry.agent_token.clone());
        }
        // Check disk in case the file was written before or outside the current map.
        let directory = prepare_user_directory(&self.paths, username).await?;
        let path = directory.join(ACCOUNT_FILE);
        let token = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let doc: AccountDocument = serde_json::from_slice(&bytes)
                    .with_context(|| format!("Failed to parse '{}'", path.display()))?;
                doc.agent_token
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let token = redoor_core::config::generate_agent_token()?;
                write_account_file(&directory, username, &token).await?;
                token
            }
            Err(error) => {
                return Err(error).with_context(|| format!("Failed to read '{}'", path.display()));
            }
        };
        self.accounts.write().await.insert(
            username.to_string(),
            AccountEntry::new(username.to_string(), token.clone()),
        );
        Ok(token)
    }

    /// Persists an account with a specific `agent_token` (used by first-run bootstrap and
    /// first-use migration) and loads it into memory.
    pub(crate) async fn set_account_token(
        &self,
        username: &str,
        agent_token: String,
    ) -> Result<()> {
        let _guard = self.write_lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        write_account_file(&directory, username, &agent_token).await?;
        self.accounts.write().await.insert(
            username.to_string(),
            AccountEntry::new(username.to_string(), agent_token),
        );
        Ok(())
    }

    /// Returns the known usernames loaded in memory.
    pub(crate) async fn usernames(&self) -> Vec<String> {
        self.accounts.read().await.keys().cloned().collect()
    }

    /// Verifies an agent upgrade HMAC proof against every registered user's `AgentTokenKey`,
    /// returning the owning username and key when a proof matches.
    pub(crate) async fn authenticate_upgrade(
        &self,
        nonce: &HandshakeNonce,
        proof: &str,
    ) -> Option<(String, AgentTokenKey)> {
        let accounts = self.accounts.read().await;
        for entry in accounts.values() {
            if entry.key.upgrade_proof(nonce).matches(proof) {
                return Some((entry.username.clone(), entry.key.clone()));
            }
        }
        None
    }
}

/// Writes `<user_dir>/account.json` atomically with mode 0600.
async fn write_account_file(directory: &Path, username: &str, agent_token: &str) -> Result<()> {
    let doc = AccountDocument {
        version: ACCOUNT_DOCUMENT_VERSION,
        username: username.to_string(),
        agent_token: agent_token.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&doc)?;
    write_private_file_atomically(
        &directory.join(".account.json.tmp"),
        &directory.join(ACCOUNT_FILE),
        &bytes,
    )
    .await
    .with_context(|| {
        format!(
            "Failed to write '{}'",
            directory.join(ACCOUNT_FILE).display()
        )
    })
}

/// Persisted `<user_dir>/agents.json` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentsDocument {
    version: u32,
    agents: Vec<AgentConfig>,
}

/// Server-owned store for per-user `<user_dir>/agents.json` files.
#[derive(Clone)]
pub(crate) struct UserAgentsStore {
    paths: AppPaths,
    /// Serializes read-modify-write updates so concurrent device edits never clobber each other.
    lock: Arc<Mutex<()>>,
}

impl UserAgentsStore {
    /// Creates a store backed by `paths`.
    pub(crate) fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            lock: Arc::default(),
        }
    }

    /// Path of `username`'s `agents.json`.
    fn agents_path(&self, username: &str) -> Result<PathBuf> {
        Ok(user_directory(&self.paths, username)?.join(AGENTS_FILE))
    }

    /// Reads all managed devices for `username`; a missing file means no managed devices.
    pub(crate) async fn list(&self, username: &str) -> Result<Vec<AgentConfig>> {
        let path = self.agents_path(username)?;
        read_agents_file(&path).await
    }

    /// Reads managed devices for every user known in `accounts`, used at startup to register
    /// every user's watchdogs and inventory.
    pub(crate) async fn load_all(
        &self,
        usernames: &[String],
    ) -> Result<Vec<(String, Vec<AgentConfig>)>> {
        let mut all = Vec::with_capacity(usernames.len());
        for username in usernames {
            let agents = self.list(username).await?;
            if !agents.is_empty() {
                all.push((username.clone(), agents));
            }
        }
        Ok(all)
    }

    /// Replaces `username`'s entire `agents.json` (used by bootstrap and migration).
    pub(crate) async fn write_all(&self, username: &str, agents: &[AgentConfig]) -> Result<()> {
        let _guard = self.lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        write_agents_file(&directory, agents).await
    }

    /// Appends one SSH-backed device to `username`'s `agents.json`.
    pub(crate) async fn append_ssh(
        &self,
        username: &str,
        config: SshBackedAgentConfig,
    ) -> Result<()> {
        let _guard = self.lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        let mut agents = read_agents_file(&directory.join(AGENTS_FILE)).await?;
        agents.push(AgentConfig::SshBacked(config));
        write_agents_file(&directory, &agents).await
    }

    /// Appends one local device to `username`'s `agents.json`.
    pub(crate) async fn append_local(
        &self,
        username: &str,
        config: LocalAgentConfig,
    ) -> Result<()> {
        let _guard = self.lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        let mut agents = read_agents_file(&directory.join(AGENTS_FILE)).await?;
        agents.push(AgentConfig::Local(config));
        write_agents_file(&directory, &agents).await
    }

    /// Replaces or removes the SSH-backed device with `agent_id` in `username`'s `agents.json`.
    pub(crate) async fn edit_ssh(
        &self,
        username: &str,
        agent_id: &AgentId,
        replacement: Option<SshBackedAgentConfig>,
    ) -> Result<bool> {
        let _guard = self.lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        let mut agents = read_agents_file(&directory.join(AGENTS_FILE)).await?;
        let Some(position) = agents.iter().position(
            |entry| matches!(entry, AgentConfig::SshBacked(c) if c.id.as_ref() == Some(agent_id)),
        ) else {
            return Ok(false);
        };
        match replacement {
            Some(config) => agents[position] = AgentConfig::SshBacked(config),
            None => {
                agents.remove(position);
            }
        }
        write_agents_file(&directory, &agents).await?;
        Ok(true)
    }

    /// Replaces or removes the local device with `agent_id` in `username`'s `agents.json`.
    pub(crate) async fn edit_local(
        &self,
        username: &str,
        agent_id: &AgentId,
        replacement: Option<LocalAgentConfig>,
    ) -> Result<bool> {
        let _guard = self.lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        let mut agents = read_agents_file(&directory.join(AGENTS_FILE)).await?;
        let Some(position) = agents.iter().position(
            |entry| matches!(entry, AgentConfig::Local(c) if c.id.as_ref() == Some(agent_id)),
        ) else {
            return Ok(false);
        };
        match replacement {
            Some(config) => agents[position] = AgentConfig::Local(config),
            None => {
                agents.remove(position);
            }
        }
        write_agents_file(&directory, &agents).await?;
        Ok(true)
    }

    /// Updates `terminal_env` for `agent_id` in `username`'s `agents.json` without touching
    /// any other field.
    pub(crate) async fn set_terminal_env(
        &self,
        username: &str,
        agent_id: &AgentId,
        terminal_env: BTreeMap<String, String>,
    ) -> Result<bool> {
        let _guard = self.lock.lock().await;
        let directory = prepare_user_directory(&self.paths, username).await?;
        let mut agents = read_agents_file(&directory.join(AGENTS_FILE)).await?;
        let Some(entry) = agents.iter_mut().find(|entry| entry.id() == Some(agent_id)) else {
            return Ok(false);
        };
        match entry {
            AgentConfig::SshBacked(config) => config.terminal_env = terminal_env,
            AgentConfig::Local(config) => config.terminal_env = terminal_env,
        }
        write_agents_file(&directory, &agents).await?;
        Ok(true)
    }
}

/// Reads `<user_dir>/agents.json`, returning an empty list when the file does not exist.
async fn read_agents_file(path: &Path) -> Result<Vec<AgentConfig>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let doc: AgentsDocument = serde_json::from_slice(&bytes)
                .with_context(|| format!("Failed to parse '{}'", path.display()))?;
            anyhow::ensure!(
                doc.version == AGENTS_DOCUMENT_VERSION,
                "Unsupported agents.json version {} in '{}'",
                doc.version,
                path.display()
            );
            Ok(doc.agents)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("Failed to read '{}'", path.display())),
    }
}

/// Writes `<user_dir>/agents.json` atomically with mode 0600.
async fn write_agents_file(directory: &Path, agents: &[AgentConfig]) -> Result<()> {
    let doc = AgentsDocument {
        version: AGENTS_DOCUMENT_VERSION,
        agents: agents.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&doc)?;
    write_private_file_atomically(
        &directory.join(".agents.json.tmp"),
        &directory.join(AGENTS_FILE),
        &bytes,
    )
    .await
    .with_context(|| {
        format!(
            "Failed to write '{}'",
            directory.join(AGENTS_FILE).display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;

    /// Verifies `account.json` round-trips for both plain usernames and hashed OIDC names,
    /// and that HMAC upgrade proofs route to the right owner.
    #[tokio::test]
    async fn account_store_loads_hashed_and_plain_users_and_authenticates_proofs() {
        let dir = TempDir::create();
        let paths = AppPaths::for_home("redoor-test", dir.path());
        let store = UserAccountStore::new(paths.clone());

        let alice_token = store.ensure_agent_token("alice").await.unwrap();
        let oidc_token = store.ensure_agent_token("bob@example.com").await.unwrap();
        // Repeated calls return the same secret.
        assert_eq!(
            store.ensure_agent_token("alice").await.unwrap(),
            alice_token
        );
        assert_ne!(alice_token, oidc_token);

        let reloaded = UserAccountStore::load_all(paths).await.unwrap();
        let nonce = HandshakeNonce::generate();
        let alice_proof = AgentTokenKey::new(&alice_token).upgrade_proof(&nonce);
        let bob_proof = AgentTokenKey::new(&oidc_token).upgrade_proof(&nonce);

        // Each user's proof resolves back to their canonical username.
        assert_eq!(
            reloaded
                .authenticate_upgrade(&nonce, alice_proof.as_str())
                .await
                .map(|(owner, _)| owner),
            Some("alice".to_string())
        );
        assert_eq!(
            reloaded
                .authenticate_upgrade(&nonce, bob_proof.as_str())
                .await
                .map(|(owner, _)| owner),
            Some("bob@example.com".to_string())
        );
        // An unknown token is rejected.
        let wrong_proof = AgentTokenKey::new("wrong").upgrade_proof(&nonce);
        assert!(
            reloaded
                .authenticate_upgrade(&nonce, wrong_proof.as_str())
                .await
                .is_none()
        );
    }

    /// Verifies per-user `agents.json` CRUD stays isolated between users.
    #[tokio::test]
    async fn agents_store_isolates_devices_per_user() {
        let dir = TempDir::create();
        let paths = AppPaths::for_home("redoor-test", dir.path());
        let store = UserAgentsStore::new(paths);

        let alice_id = AgentId::generate();
        let bob_id = AgentId::generate();
        store
            .append_local(
                "alice",
                LocalAgentConfig {
                    id: Some(alice_id.clone()),
                    name: Some("laptop".to_string()),
                    home: None,
                    terminal_env: BTreeMap::new(),
                },
            )
            .await
            .unwrap();
        store
            .append_local(
                "bob",
                LocalAgentConfig {
                    id: Some(bob_id.clone()),
                    name: Some("laptop".to_string()),
                    home: None,
                    terminal_env: BTreeMap::new(),
                },
            )
            .await
            .unwrap();

        assert_eq!(store.list("alice").await.unwrap().len(), 1);
        assert_eq!(store.list("bob").await.unwrap().len(), 1);
        assert_eq!(store.list("alice").await.unwrap()[0].id(), Some(&alice_id));
        assert_eq!(store.list("bob").await.unwrap()[0].id(), Some(&bob_id));
    }
}
