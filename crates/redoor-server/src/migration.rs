//! First-use migration from global single-account layout to per-user workspaces.
//!
//! TEMPORARY MIGRATION: Detects legacy global server state (top-level `agent_token`,
//! `[[agents]]`, `<data_dir>/vault.json`, `<data_dir>/ssh/`, `<data_dir>/tokens/access-tokens.json`)
//! when `<data_dir>/layout-version` is absent, gates all normal traffic with `503 Service
//! Unavailable` until an operator signs in and confirms which user receives the legacy
//! workspace, then moves the data and activates it live without a restart. Can be removed
//! once all deployed servers have upgraded to layout version 2.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use redoor_core::config::{AgentConfig, RedoorConfig};
use redoor_core::log;
use redoor_protocol::api::migration::{
    ConfirmMigrationResponse, MigrationStatusResponse, MigrationSummary,
};
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::log::Level;
use tokio::sync::{Mutex, RwLock};

use crate::http::error::ApiError;
use crate::http::state::ServerState;
use crate::http::user_state::prepare_user_directory;
use crate::workspaces::{has_layout_version, write_layout_version};

/// File written before moving any legacy files so an interrupted migration can only be
/// resumed by the same user, never split across two accounts.
const MIGRATION_OWNER_FILE: &str = ".migration-owner";

/// Legacy global data captured at startup while migration is pending.
///
/// TEMPORARY MIGRATION: Held in memory until `POST /api/v1/migration/confirm` completes. Can
/// be removed after layout v2 adoption.
#[derive(Debug, Clone)]
pub(crate) struct PendingMigration {
    /// Legacy top-level `agent_token` from `config.toml`, if set.
    pub(crate) agent_token: Option<String>,
    /// Legacy `[[agents]]` entries from `config.toml`.
    pub(crate) agents: Vec<AgentConfig>,
    /// Whether `[agent]` or `[[relays]]` share `config.toml`, so `agent_token` must stay in it.
    pub(crate) keep_config_agent_token: bool,
    /// User who has already started migrating; prevents a retry from splitting files across
    /// two different workspaces.
    pub(crate) claimed_owner: Option<String>,
    /// Summary shown to the operator on the confirmation screen.
    pub(crate) summary: MigrationSummary,
}

/// Process-wide migration gate and execution lock.
///
/// TEMPORARY MIGRATION: Can be removed after layout v2 adoption.
#[derive(Clone, Default)]
pub(crate) struct MigrationState {
    pending: Arc<RwLock<Option<PendingMigration>>>,
    confirm_lock: Arc<Mutex<()>>,
}

impl MigrationState {
    /// Creates a migration state with an optional pending migration detected at startup.
    pub(crate) fn new(pending: Option<PendingMigration>) -> Self {
        Self {
            pending: Arc::new(RwLock::new(pending)),
            confirm_lock: Arc::default(),
        }
    }

    /// True while legacy global data awaits confirmation; gates normal API/WS/MCP traffic.
    pub(crate) async fn is_pending(&self) -> bool {
        self.pending.read().await.is_some()
    }

    /// Returns the `GET /api/v1/migration` status payload.
    pub(crate) async fn status(&self) -> MigrationStatusResponse {
        let guard = self.pending.read().await;
        match guard.as_ref() {
            Some(pending) => MigrationStatusResponse {
                pending: true,
                summary: Some(pending.summary.clone()),
            },
            None => MigrationStatusResponse {
                pending: false,
                summary: None,
            },
        }
    }

    /// Moves legacy global data into `username`'s workspace, cleans `config.toml`, writes
    /// `layout-version`, activates the migrated workspace live, and clears the gate.
    ///
    /// TEMPORARY MIGRATION: Can be removed after layout v2 adoption.
    pub(crate) async fn confirm(
        &self,
        state: &ServerState,
        username: &str,
    ) -> Result<ConfirmMigrationResponse, ApiError> {
        let _guard = self.confirm_lock.lock().await;
        let mut pending = {
            let guard = self.pending.read().await;
            let Some(pending) = guard.as_ref() else {
                return Err(ApiError::conflict("Migration has already completed"));
            };
            if let Some(claimed) = &pending.claimed_owner
                && claimed != username
            {
                return Err(ApiError::conflict(format!(
                    "Migration is already in progress for user '{claimed}'; sign in as '{claimed}' to finish it"
                )));
            }
            pending.clone()
        };

        let data_dir =
            state.runtime.paths.data_dir().map_err(|error| {
                ApiError::internal(format!("Failed to resolve data dir: {error}"))
            })?;
        let user_dir = prepare_user_directory(&state.runtime.paths, username)
            .await
            .map_err(|error| {
                ApiError::internal(format!("Failed to prepare user workspace: {error}"))
            })?;

        // Persist the claimed owner and pre-assigned device ids before moving any files so a
        // retry after a partial failure resumes into the exact same workspace with the same ids.
        for agent in &mut pending.agents {
            match agent {
                AgentConfig::Local(local) => {
                    if local.id.is_none() {
                        local.id = Some(AgentId::generate());
                    }
                }
                AgentConfig::SshBacked(ssh) => {
                    if ssh.id.is_none() {
                        ssh.id = Some(AgentId::generate());
                    }
                }
            }
        }
        pending.claimed_owner = Some(username.to_string());
        *self.pending.write().await = Some(pending.clone());
        let owner_marker = data_dir.join(MIGRATION_OWNER_FILE);
        crate::http::user_state::write_private_file_atomically(
            &data_dir.join(".migration-owner.tmp"),
            &owner_marker,
            username.as_bytes(),
        )
        .await
        .map_err(|error| {
            ApiError::internal(format!("Failed to record migration owner: {error}"))
        })?;
        let agents = pending.agents;

        // 1. Write `account.json`, preserving the legacy agent token when present.
        let agent_token = match pending.agent_token {
            Some(token) => token,
            None => redoor_core::config::generate_agent_token().map_err(|error| {
                ApiError::internal(format!("Failed to generate token: {error}"))
            })?,
        };
        state
            .accounts
            .set_account_token(username, agent_token)
            .await
            .map_err(|error| {
                ApiError::internal(format!("Failed to write migrated account.json: {error}"))
            })?;

        // 2. Write `agents.json` with all legacy managed devices and their ids.
        if !agents.is_empty() {
            state
                .user_agents
                .write_all(username, &agents)
                .await
                .map_err(|error| {
                    ApiError::internal(format!("Failed to write migrated agents.json: {error}"))
                })?;
        }

        // 3. Move legacy `vault.json` into `<user_dir>/vault.json`.
        let legacy_vault = data_dir.join("vault.json");
        if tokio::fs::try_exists(&legacy_vault).await.unwrap_or(false) {
            move_path(&legacy_vault, &user_dir.join("vault.json"))
                .await
                .map_err(|error| {
                    ApiError::internal(format!("Failed to move legacy vault.json: {error}"))
                })?;
        }

        // 4. Move legacy `ssh/` into `<user_dir>/ssh/`.
        let legacy_ssh = data_dir.join("ssh");
        if dir_has_entries(&legacy_ssh).await.unwrap_or(false) {
            move_directory_contents(&legacy_ssh, &user_dir.join("ssh"))
                .await
                .map_err(|error| {
                    ApiError::internal(format!("Failed to move legacy ssh directory: {error}"))
                })?;
            let _ = tokio::fs::remove_dir(&legacy_ssh).await;
        }

        // 5. Move legacy `tokens/access-tokens.json` into `<user_dir>/access-tokens.json`.
        let legacy_tokens_dir = data_dir.join("tokens");
        let legacy_tokens = legacy_tokens_dir.join("access-tokens.json");
        if tokio::fs::try_exists(&legacy_tokens).await.unwrap_or(false) {
            move_path(&legacy_tokens, &user_dir.join("access-tokens.json"))
                .await
                .map_err(|error| {
                    ApiError::internal(format!("Failed to move legacy access-tokens.json: {error}"))
                })?;
            let _ = tokio::fs::remove_dir(&legacy_tokens_dir).await;
        }

        // 6. Activate migrated access tokens and managed watchdogs/inventory live before
        // writing `layout-version` so an activation error remains retryable under the same owner.
        state.tokens.reload_user(username).await.map_err(|error| {
            ApiError::internal(format!("Failed to load migrated access tokens: {error}"))
        })?;
        state
            .launcher
            .register_all(
                username,
                &agents,
                &state.watchdog_registry,
                &state.router_ref,
            )
            .await
            .map_err(|error| {
                ApiError::internal(format!("Failed to register migrated devices: {error}"))
            })?;

        // 7. Write `<data_dir>/layout-version` = 2 and clear the pending gate before
        // best-effort `config.toml` cleanup so a read-only config mount (e.g. Docker `:ro`)
        // can never leave the server stuck in pending migration.
        write_layout_version(&state.runtime.paths)
            .await
            .map_err(|error| {
                ApiError::internal(format!("Failed to write layout-version: {error}"))
            })?;
        let _ = tokio::fs::remove_file(&owner_marker).await;
        *self.pending.write().await = None;

        // 8. Best-effort cleanup of legacy server fields from `config.toml`.
        let _config_guard = state.config_edit_lock.lock().await;
        if let Err(error) = redoor_core::config::remove_legacy_server_fields(
            &state.config_path,
            !pending.keep_config_agent_token,
        )
        .await
        {
            let fields = if pending.keep_config_agent_token {
                "the legacy [[agents]] entries"
            } else {
                "the top-level agent_token and [[agents]] entries"
            };
            log!(
                Level::Warning,
                "Migration succeeded, but could not remove legacy fields from '{}': {error}. You can remove {fields} manually.",
                state.config_path.display()
            );
        }
        drop(_config_guard);

        log!(
            Level::Info,
            "Migrated legacy workspace to user '{}': devices={}, has_vault={}, ssh_keys={}, access_tokens={}",
            username,
            pending.summary.managed_device_count,
            pending.summary.has_vault,
            pending.summary.ssh_key_count,
            pending.summary.access_token_count
        );

        Ok(ConfirmMigrationResponse {
            migrated_to: username.to_string(),
        })
    }
}

/// Inspects `data_dir` and the parsed `config.toml` at startup to decide whether first-use
/// migration is required.
///
/// TEMPORARY MIGRATION: Can be removed after layout v2 adoption.
pub(crate) async fn detect_pending_migration(
    data_dir: &Path,
    file: &RedoorConfig,
) -> Result<Option<PendingMigration>> {
    if has_layout_version(data_dir).await? {
        return Ok(None);
    }

    let has_vault = tokio::fs::try_exists(data_dir.join("vault.json")).await?;
    let ssh_key_count = count_subdirs(&data_dir.join("ssh")).await?;
    let access_token_count =
        count_legacy_access_tokens(&data_dir.join("tokens").join("access-tokens.json")).await?;
    let has_legacy_tokens_file =
        tokio::fs::try_exists(data_dir.join("tokens").join("access-tokens.json")).await?;

    let has_legacy_data = file.agent_token.is_some()
        || !file.agents.is_empty()
        || has_vault
        || ssh_key_count > 0
        || has_legacy_tokens_file;

    if !has_legacy_data {
        return Ok(None);
    }

    let managed_device_names = file
        .agents
        .iter()
        .map(AgentConfig::effective_name)
        .collect::<Vec<_>>();
    let summary = MigrationSummary {
        managed_device_count: file.agents.len(),
        managed_device_names,
        has_vault,
        ssh_key_count,
        access_token_count,
        agent_token: file.agent_token.clone(),
    };
    let claimed_owner = match tokio::fs::read_to_string(data_dir.join(MIGRATION_OWNER_FILE)).await {
        Ok(owner) if !owner.trim().is_empty() => Some(owner.trim().to_string()),
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "reading '{}'",
                    data_dir.join(MIGRATION_OWNER_FILE).display()
                )
            });
        }
    };
    Ok(Some(PendingMigration {
        agent_token: file.agent_token.clone(),
        agents: file.agents.clone(),
        keep_config_agent_token: file.agent.is_some() || !file.relays.is_empty(),
        claimed_owner,
        summary,
    }))
}

/// Counts subdirectories inside `dir`, returning 0 when `dir` does not exist.
async fn count_subdirs(dir: &Path) -> Result<usize> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error).with_context(|| format!("reading '{}'", dir.display())),
    };
    let mut count = 0;
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_dir() {
            count += 1;
        }
    }
    Ok(count)
}

/// Checks whether a directory exists and contains at least one entry.
async fn dir_has_entries(dir: &Path) -> Result<bool> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).with_context(|| format!("reading '{}'", dir.display())),
    };
    Ok(entries.next_entry().await?.is_some())
}

/// Counts tokens stored in a legacy `access-tokens.json` file.
async fn count_legacy_access_tokens(path: &Path) -> Result<usize> {
    #[derive(serde::Deserialize)]
    struct MinimalTokenFile {
        #[serde(default)]
        tokens: Vec<serde_json::Value>,
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let parsed: MinimalTokenFile = serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing '{}'", path.display()))?;
            Ok(parsed.tokens.len())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error).with_context(|| format!("reading '{}'", path.display())),
    }
}

/// Renames `src` to `dst`, setting 0600 permissions on unix.
async fn move_path(src: &Path, dst: &Path) -> Result<()> {
    tokio::fs::rename(src, dst)
        .await
        .with_context(|| format!("renaming '{}' to '{}'", src.display(), dst.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if tokio::fs::metadata(dst).await?.is_file() {
            tokio::fs::set_permissions(dst, std::fs::Permissions::from_mode(0o600)).await?;
        }
    }
    Ok(())
}

/// Moves every entry from `src_dir` into `dst_dir`, creating `dst_dir` with mode 0700.
async fn move_directory_contents(src_dir: &Path, dst_dir: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dst_dir).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(dst_dir, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let mut entries = tokio::fs::read_dir(src_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let target = dst_dir.join(entry.file_name());
        tokio::fs::rename(entry.path(), &target)
            .await
            .with_context(|| {
                format!(
                    "moving '{}' to '{}'",
                    entry.path().display(),
                    target.display()
                )
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::config::RedoorConfig;
    use redoor_core::paths::AppPaths;
    use redoor_core::test_support::TempDir;

    /// Parses a minimal `RedoorConfig` via the real TOML loader for migration detection tests.
    async fn parse_config(temp: &TempDir, raw: &str) -> RedoorConfig {
        let path = temp.path().join("config.toml");
        tokio::fs::write(&path, raw)
            .await
            .expect("write test config");
        redoor_core::config::parse_config_file(&path)
            .await
            .expect("valid test config")
    }

    /// Fresh installs with no legacy files and no layout-version must skip migration.
    #[tokio::test]
    async fn fresh_install_skips_migration() {
        let temp = TempDir::create();
        let paths = AppPaths::for_home("redoor-test", temp.path());
        let data_dir = paths.data_dir().unwrap();
        tokio::fs::create_dir_all(&data_dir).await.unwrap();

        let pending = detect_pending_migration(&data_dir, &parse_config(&temp, "").await)
            .await
            .unwrap();
        // No legacy config or data files exist, so the server should start normally.
        assert!(pending.is_none());
    }

    /// Already-migrated servers with layout-version = 2 must skip migration even if stray
    /// files exist.
    #[tokio::test]
    async fn layout_version_marker_skips_migration() {
        let temp = TempDir::create();
        let paths = AppPaths::for_home("redoor-test", temp.path());
        write_layout_version(&paths).await.unwrap();
        let data_dir = paths.data_dir().unwrap();

        let config = parse_config(&temp, "agent_token = \"legacy-token\"\n").await;
        let pending = detect_pending_migration(&data_dir, &config).await.unwrap();
        // Layout marker takes precedence so migrated servers never re-enter the gate.
        assert!(pending.is_none());
    }

    /// Legacy global data triggers pending migration and builds an accurate summary.
    #[tokio::test]
    async fn detects_legacy_data_and_builds_summary() {
        let temp = TempDir::create();
        let paths = AppPaths::for_home("redoor-test", temp.path());
        let data_dir = paths.data_dir().unwrap();
        tokio::fs::create_dir_all(data_dir.join("ssh").join("dev_one"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(data_dir.join("tokens"))
            .await
            .unwrap();
        tokio::fs::write(data_dir.join("vault.json"), b"{}")
            .await
            .unwrap();
        tokio::fs::write(
            data_dir.join("tokens").join("access-tokens.json"),
            br#"{"version":1,"tokens":[{"id":"t1"},{"id":"t2"}]}"#,
        )
        .await
        .unwrap();

        let config = parse_config(
            &temp,
            "agent_token = \"legacy-token\"

[[agents]]
local = true
name = \"laptop\"
",
        )
        .await;
        let pending = detect_pending_migration(&data_dir, &config)
            .await
            .unwrap()
            .expect("legacy data must trigger pending migration");
        // Summary reflects every legacy resource so the operator knows what will move.
        assert_eq!(pending.summary.managed_device_count, 1);
        assert_eq!(pending.summary.managed_device_names, vec!["laptop"]);
        assert!(pending.summary.has_vault);
        assert_eq!(pending.summary.ssh_key_count, 1);
        assert_eq!(pending.summary.access_token_count, 2);
        assert_eq!(pending.summary.agent_token.as_deref(), Some("legacy-token"));
        assert!(!pending.keep_config_agent_token);
    }
}
