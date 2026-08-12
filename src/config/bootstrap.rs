//! Host-derived paths and first-run configuration bootstrap.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Conventional config path for the current process privileges.
///
/// Root loads `/etc/<app-name>/config.toml` so system units and admin installs
/// share one file; non-root uses the matching directory under `~/.config`.
pub(crate) fn default_config_path() -> Result<PathBuf> {
    let app_name = crate::app_name::app_name()?;
    if effective_uid_is_root() {
        return Ok(PathBuf::from("/etc").join(app_name).join("config.toml"));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; pass --config with a config.toml path")?;
    Ok(home.join(".config").join(app_name).join("config.toml"))
}

/// Conventional directory for process log files under the current privileges.
///
/// Root uses `/var/log/<app-name>` so system units share a writable location;
/// non-root keeps logs in the matching per-application data directory.
pub(crate) fn default_log_directory() -> Result<PathBuf> {
    if effective_uid_is_root() {
        return Ok(PathBuf::from("/var/log").join(crate::app_name::app_name()?));
    }
    crate::app_name::user_data_directory()
}

/// Default persistent log for a process slot when no CLI, environment, or TOML path is set.
pub(crate) fn default_process_log_path(
    slot: crate::process_control::ProcessSlot,
) -> Result<String> {
    Ok(default_log_directory()?
        .join(format!("{}.log", slot.file_stem()))
        .display()
        .to_string())
}

/// Default persistent server log used when no CLI, environment, or TOML path is set.
pub(crate) fn default_server_log_path() -> Result<String> {
    default_process_log_path(crate::process_control::ProcessSlot::Server)
}

/// Default persistent standalone-agent log used when no explicit path is set.
pub(crate) fn default_agent_log_path() -> Result<String> {
    default_process_log_path(crate::process_control::ProcessSlot::Agent)
}

/// Default persistent SSH-relay log uses its stable ID to avoid cross-relay output mixing.
pub(crate) fn default_relay_log_path(id: &str) -> Result<String> {
    Ok(default_log_directory()?
        .join("relays")
        .join(format!("{id}.log"))
        .display()
        .to_string())
}

/// Whether the process effective UID is root (system-install / privileged path).
fn effective_uid_is_root() -> bool {
    #[cfg(unix)]
    {
        nix::unistd::Uid::effective().is_root()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Generates a high-entropy secret for bootstrap agent tokens.
fn generate_secret() -> String {
    use argon2::password_hash::rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Renders the minimal starter config written only by `redoor server` on first run.
///
/// Matches the README shape: top-level token, commented listener options, PAM or
/// demo credentials, and one managed local agent so a fresh install is demoable.
fn default_config_content(agent_token: &str) -> String {
    let agent_token = toml_edit::Value::from(agent_token).to_string();
    #[cfg(target_os = "linux")]
    let credentials = concat!(
        "# Web UI login. On Linux, omit both to use PAM (system user).\n",
        "# username = \"admin\"\n",
        "# password = \"long-private-password\"\n",
    );
    #[cfg(not(target_os = "linux"))]
    let credentials = concat!("username = \"redoor\"\n", "password = \"changeme\"\n",);
    #[cfg(target_os = "linux")]
    let header = "# A random agent_token was generated on first start.\n# Browser login uses PAM with your Linux account credentials.";
    #[cfg(not(target_os = "linux"))]
    let header = "# A random agent_token was generated on first start.\n# Browser login uses username redoor and password changeme.";
    format!(
        r#"# Redoor configuration
{header}
# agent_token is the shared secret between the server and agents.

agent_token = {agent_token}

[server]
{credentials}
# port = 3000
# bind = "0.0.0.0" # default 127.0.0.1
# cookie_secure = false # set true behind HTTPS

[[agents]]
# local agent that runs on the same computer as the server
local = true
name = "local"
"#
    )
}

/// Bootstrap secrets printed once when a starter config is created.
pub(crate) struct CreatedDefaultConfig {
    /// Present only when the starter config embeds a dedicated login password.
    pub(crate) password: Option<String>,
    pub(crate) agent_token: String,
}

/// Creates the conventional server config with a random token without overwriting an existing file.
///
/// Only `redoor server` should call this so first-run secrets and the local agent
/// entry appear from a single, intentional entry point.
pub(crate) async fn create_default_config_if_missing(
    path: &Path,
) -> Result<Option<CreatedDefaultConfig>> {
    if tokio::fs::try_exists(path).await? {
        return Ok(None);
    }

    let agent_token = generate_secret();
    // Non-Linux embeds fixed demo credentials because PAM is unavailable there.
    let password: Option<String> = {
        #[cfg(target_os = "linux")]
        {
            None
        }
        #[cfg(not(target_os = "linux"))]
        {
            Some("changeme".to_string())
        }
    };
    let parent = path
        .parent()
        .with_context(|| format!("Default config path '{}' has no parent", path.display()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("Failed to create config directory '{}'", parent.display()))?;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = match options.open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to create default config '{}'", path.display()));
        }
    };
    let content = default_config_content(&agent_token);
    file.write_all(content.as_bytes())
        .await
        .with_context(|| format!("Failed to write default config '{}'", path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("Failed to sync default config '{}'", path.display()))?;
    Ok(Some(CreatedDefaultConfig {
        password,
        agent_token,
    }))
}

/// Returns the default agent name for a local entry: the system hostname.
/// Using the hostname (rather than e.g. `"local"`) means multiple servers on
/// different machines each spawn a local agent with a distinct, meaningful
/// name without the operator having to configure it. The supervisor imports
/// this helper so its registry key matches the name the spawned agent uses.
pub(crate) fn default_local_agent_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "local".to_string())
}
