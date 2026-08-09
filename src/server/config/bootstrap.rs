//! Host-derived paths and first-run configuration bootstrap.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use sysinfo::System;
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

/// Default persistent server log used when no CLI, environment, or TOML path is set.
pub(crate) fn default_server_log_path() -> Result<String> {
    Ok(default_log_directory()?
        .join("server.log")
        .display()
        .to_string())
}

/// Default persistent standalone-agent log used when no explicit path is set.
pub(crate) fn default_agent_log_path() -> Result<String> {
    Ok(default_log_directory()?
        .join("agent.log")
        .display()
        .to_string())
}

/// Default UI/workdir for a local agent: home for normal users, filesystem root for root.
///
/// Root installs often manage the whole host, so `/` is the useful starting point;
/// non-root should not escape the operator's home by default.
fn default_agent_dir() -> Result<String> {
    if effective_uid_is_root() {
        return Ok("/".to_string());
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot resolve the default agent directory")?;
    Ok(home.display().to_string())
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

/// Looks up the effective OS account off the async runtime because passwd databases may block.
#[cfg(not(target_os = "linux"))]
pub(super) async fn current_process_username() -> Result<String> {
    let uid = nix::unistd::Uid::current();
    let user = tokio::task::spawn_blocking(move || nix::unistd::User::from_uid(uid))
        .await
        .context("Failed to join current-user lookup task")??
        .with_context(|| format!("No system user exists for process UID {uid}"))?;
    Ok(user.name)
}

/// Generates a high-entropy secret for bootstrap passwords and agent tokens.
fn generate_secret() -> String {
    use argon2::password_hash::rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Paths and identity values baked into a starter config for the current host.
struct DefaultConfigPaths {
    agent_dir: String,
    agent_name: String,
    app_name: String,
}

/// Renders one shared starter config used by server bootstrap and systemd setup.
///
/// On Linux, username/password are omitted so the server authenticates via the
/// process owner's system account (PAM). Elsewhere both are required and generated.
/// The file always includes `[server]`, a runnable `[agent]`, and a managed local
/// `[[agents]]` entry so the same TOML works for either process role after edits.
fn default_config_content(
    username: Option<&str>,
    password: Option<&str>,
    agent_token: &str,
    agent_token_was_generated: bool,
    paths: &DefaultConfigPaths,
) -> String {
    let agent_token = toml_edit::Value::from(agent_token).to_string();
    let credentials = match (username, password) {
        (Some(username), Some(password)) => {
            let username = toml_edit::Value::from(username).to_string();
            let password = toml_edit::Value::from(password).to_string();
            format!("username = {username}\npassword = {password}\n")
        }
        _ => {
            // Linux PAM path: document the optional override without writing secrets.
            concat!(
                "# On Linux, omit username/password to log in with the process owner's\n",
                "# system account via PAM. Set both to use a dedicated redoor password instead.\n",
                "# username = \"admin\"\n",
                "# password = \"replace-with-a-long-private-password\"\n",
            )
            .to_string()
        }
    };
    let header = match (username.is_some(), agent_token_was_generated) {
        (true, true) => "# A random password and agent_token were generated on first start.",
        (true, false) => {
            "# A random browser password was generated; agent_token was supplied during setup."
        }
        (false, true) => {
            "# A random agent_token was generated on first start.\n# Browser login uses the process owner's system username/password (Linux PAM)."
        }
        (false, false) => {
            "# agent_token was supplied during setup.\n# Browser login uses the process owner's system username/password (Linux PAM)."
        }
    };
    let agent_dir = toml_edit::Value::from(paths.agent_dir.as_str()).to_string();
    let agent_name = toml_edit::Value::from(paths.agent_name.as_str()).to_string();
    let remote_bin = format!(
        "${{XDG_DATA_HOME:-$HOME/.local/share}}/{}/binaries/<version>/redoor",
        paths.app_name
    );
    format!(
        r#"# Redoor configuration (shared by server and agent).
{header}
# agent_token is top-level because both processes need the same secret.
# Bind defaults to loopback; set bind = "0.0.0.0" only when intentionally exposing the server.
# Review [agent] / [[agents]] before starting: defaults target this host's local server.

agent_token = {agent_token}

[server]
{credentials}# port = 3000
# bind = "127.0.0.1"
# cookie_secure = false

[agent]
ws_address = "ws://localhost:3000/ws"
name = {agent_name}
dir = {agent_dir}

# Server-managed local agent (spawned by `redoor server`).
[[agents]]
local = true
name = {agent_name}
dir = {agent_dir}

# SSH-backed agent example. Remove `# ` from this block to enable it.
# [[agents]]
# target = "user@example.com"
# local = false
# username = "remote-user"
# ssh_port = 22
# name = "remote-agent"
# remote_bin = "{remote_bin}"
# dir = "/home/remote-user"
# log = "log/remote-agent.log"
"#
    )
}

/// Bootstrap secrets printed once when a starter config is created.
pub(crate) struct CreatedDefaultConfig {
    /// Present only when the starter config embeds a dedicated login password.
    pub(crate) password: Option<String>,
    pub(crate) agent_token: String,
}

/// Creates the conventional shared config with a random token without overwriting an existing file.
pub(crate) async fn create_default_config_if_missing(
    path: &Path,
) -> Result<Option<CreatedDefaultConfig>> {
    create_default_config_if_missing_with_token(path, None).await
}

/// Creates the conventional shared config with an optional caller-supplied agent token.
///
/// Server bootstrap and systemd setup both write the same starter file so either
/// process role can use it after the operator reviews defaults.
pub(crate) async fn create_default_config_if_missing_with_token(
    path: &Path,
    agent_token: Option<&str>,
) -> Result<Option<CreatedDefaultConfig>> {
    if tokio::fs::try_exists(path).await? {
        return Ok(None);
    }

    if agent_token.is_some_and(str::is_empty) {
        bail!("agent token must not be empty");
    }
    let agent_token_was_generated = agent_token.is_none();
    let agent_token = agent_token
        .map(str::to_owned)
        .unwrap_or_else(generate_secret);
    // Non-Linux still needs embedded credentials because PAM is unavailable.
    let (username, password): (Option<String>, Option<String>) = {
        #[cfg(target_os = "linux")]
        {
            (None, None)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let username = current_process_username().await?;
            let password = generate_secret();
            (Some(username), Some(password))
        }
    };
    let paths = DefaultConfigPaths {
        agent_dir: default_agent_dir()?,
        agent_name: default_local_agent_name(),
        app_name: crate::app_name::app_name()?,
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
    let content = default_config_content(
        username.as_deref(),
        password.as_deref(),
        &agent_token,
        agent_token_was_generated,
        &paths,
    );
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
    System::host_name().unwrap_or_else(|| "local".to_string())
}
