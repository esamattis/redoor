//! Shared TOML config used by both the server and the standalone agent.
//!
//! Top-level `agent_token` is the shared registration secret. Optional
//! `[server]` holds listener and browser-auth settings; optional `[agent]`
//! holds standalone agent connection settings; optional `[[agents]]` lists
//! server-managed local/SSH agents. Server mode requires `[server]`; agent
//! mode resolves required fields from CLI > env > config > default.

use anyhow::{Context, Result, bail};
use redoor::{Level, log};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use sysinfo::System;
use tokio::{io::AsyncWriteExt, process::Command};
use toml_edit::Document;

/// Conventional config path for the current process privileges.
///
/// Root loads `/etc/redoor/config.toml` so system units and admin installs share
/// one file; non-root uses the XDG-style home path under `~/.config/redoor`.
pub(crate) fn default_config_path() -> Result<PathBuf> {
    if effective_uid_is_root() {
        return Ok(PathBuf::from("/etc/redoor/config.toml"));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; pass --config with a config.toml path")?;
    Ok(home.join(".config/redoor/config.toml"))
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

/// Shorthand for the [`Document`] type produced by [`Document::parse`], whose
/// key storage is borrowed from the parsed source. Used in helper signatures
/// so we don't have to spell out the generic parameter on every function.
type ParsedDocument<'a> = Document<&'a String>;

use crate::ssh::SshAgentConfig;

/// Looks up the effective OS account off the async runtime because passwd databases may block.
#[cfg(not(target_os = "linux"))]
async fn current_process_username() -> Result<String> {
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

/// Optional standalone `[agent]` values written into a starter config.
struct DefaultAgentSection<'a> {
    ws_address: &'a str,
    name: &'a str,
}

/// Renders a complete starter config while keeping optional settings discoverable but disabled.
///
/// On Linux, username/password are omitted so the server authenticates via the
/// process owner's system account (PAM). Elsewhere both are required and generated.
/// When `agent` is set, an active `[agent]` table is written so `redoor agent`
/// can start from the file alone (systemd agent setup).
fn default_config_content(
    username: Option<&str>,
    password: Option<&str>,
    agent_token: &str,
    agent_token_was_generated: bool,
    agent: Option<DefaultAgentSection<'_>>,
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
    let header = match (
        username.is_some(),
        agent_token_was_generated,
        agent.is_some(),
    ) {
        (_, _, true) => {
            "# agent_token was supplied during agent setup.\n# [agent] is fully set so `redoor agent` needs no CLI flags."
        }
        (true, true, false) => "# A random password and agent_token were generated on first start.",
        (true, false, false) => {
            "# A random browser password was generated; agent_token was supplied during setup."
        }
        (false, true, false) => {
            "# A random agent_token was generated on first start.\n# Browser login uses the process owner's system username/password (Linux PAM)."
        }
        (false, false, false) => {
            "# agent_token was supplied during setup.\n# Browser login uses the process owner's system username/password (Linux PAM)."
        }
    };
    let for_standalone_agent = agent.is_some();
    let agent_block = match agent {
        Some(agent) => {
            let ws_address = toml_edit::Value::from(agent.ws_address).to_string();
            let name = toml_edit::Value::from(agent.name).to_string();
            format!(
                r#"[agent]
ws_address = {ws_address}
name = {name}
# dir = "/home/local-user"
# log = "log/agent.log"
"#
            )
        }
        None => {
            r#"# Standalone agent settings. Uncomment for `redoor agent` / systemd --mode agent.
# [agent]
# ws_address = "ws://127.0.0.1:3000/ws"
# name = "local"
# dir = "/home/local-user"
# log = "log/agent.log"
"#
            .to_string()
        }
    };
    let server_block = if for_standalone_agent {
        // Agent-only hosts do not need a [server] table.
        String::new()
    } else {
        format!(
            r#"[server]
{credentials}# port = 3000
# bind = "127.0.0.1"
# cookie_secure = false
# log = "log/server.log"

"#
        )
    };
    let managed_agents = if for_standalone_agent {
        String::new()
    } else {
        r#"# SSH-backed agent example. Remove `# ` from this block to enable it.
# [[agents]]
# target = "user@example.com"
# local = false
# username = "remote-user"
# ssh_port = 22
# name = "remote-agent"
# remote_bin = "~/.local/redoor/<version>/redoor"
# dir = "/home/remote-user"
# log = "log/remote-agent.log"

# Local agent example. Remove `# ` from this block to enable it.
# [[agents]]
# local = true
# name = "local-agent"
# dir = "/home/local-user"
# log = "log/local-agent.log"
"#
        .to_string()
    };
    format!(
        r#"# Redoor configuration (shared by server and agent).
{header}
# agent_token is top-level because both processes need the same secret.
# Bind defaults to loopback; set bind = "0.0.0.0" only when intentionally exposing the server.

agent_token = {agent_token}

{server_block}{agent_block}
{managed_agents}"#
    )
}

/// Bootstrap secrets printed once when a starter config is created.
pub(crate) struct CreatedDefaultConfig {
    /// Present only when the starter config embeds a dedicated login password.
    pub(crate) password: Option<String>,
    pub(crate) agent_token: String,
}

/// Creates the conventional config with a random token without overwriting an existing file.
pub(crate) async fn create_default_config_if_missing(
    path: &Path,
) -> Result<Option<CreatedDefaultConfig>> {
    create_default_config_if_missing_with_token(path, None).await
}

/// Creates the conventional config with an optional caller-supplied agent token.
///
/// Systemd agent setup uses the supplied-token path because an agent must share
/// the secret from its server, while ordinary server bootstrap generates one.
/// When `for_standalone_agent` is true, the starter file includes a complete
/// `[agent]` table and omits `[server]` so agent-only hosts need no server keys.
pub(crate) async fn create_default_config_if_missing_with_token(
    path: &Path,
    agent_token: Option<&str>,
) -> Result<Option<CreatedDefaultConfig>> {
    create_default_config_if_missing_with_options(path, agent_token, false).await
}

/// Like [`create_default_config_if_missing_with_token`], optionally writing a
/// fully configured standalone `[agent]` section for systemd agent install.
pub(crate) async fn create_default_config_if_missing_with_options(
    path: &Path,
    agent_token: Option<&str>,
    for_standalone_agent: bool,
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
    // Agent-only starters skip browser credentials; server starters still need
    // them on non-Linux where PAM is unavailable.
    let (username, password): (Option<String>, Option<String>) = if for_standalone_agent {
        (None, None)
    } else {
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
    let agent_name_owned = if for_standalone_agent {
        Some(default_local_agent_name())
    } else {
        None
    };
    let agent_section = agent_name_owned.as_ref().map(|name| DefaultAgentSection {
        ws_address: "ws://localhost:3000/ws",
        name,
    });
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
        agent_section,
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

/// Configuration for one local agent, parsed from the agents toml.
///
/// Mirrors the subset of [`crate::ssh::SshAgentConfig`] fields that make
/// sense for an in-process agent: a display name, an optional UI default
/// directory, and an optional log file. The server reuses its own binary
/// (via `std::env::current_exe`) to start the agent, so no binary path
/// needs to be configured.
#[derive(Debug, Clone)]
pub(crate) struct LocalAgentConfig {
    /// Name the local agent registers with on the server. When `None`,
    /// defaults to the system hostname so multiple local agents on
    /// different machines are naturally distinguishable.
    pub(crate) name: Option<String>,
    /// Default directory the spawned agent publishes for UI tab navigation.
    pub(crate) dir: Option<String>,
    /// Log file path. When set, the spawned `redoor agent` process's
    /// stdout/stderr is redirected (append mode) to this file. When
    /// `None`, stdio is inherited so the agent's logs appear in the
    /// server's terminal.
    pub(crate) log: Option<String>,
}

/// One configured agent entry from the agents toml. The variant decides
/// whether the server can start an ssh-wrapped agent or a plain local one,
/// so the dispatcher in `register_agents` can pick the right transport
/// without inspecting the per-variant fields itself.
#[derive(Debug, Clone)]
pub(crate) enum AgentConfig {
    Ssh(SshAgentConfig),
    Local(LocalAgentConfig),
}

/// Parsed `[server]` table with optional listener and browser-auth overrides.
///
/// `username`/`password` are optional as a pair: both set uses config credentials;
/// both absent uses Linux PAM for the process owner (rejected on non-Linux).
/// The shared `agent_token` lives at the document root, not here.
#[derive(Debug, Clone, Default)]
pub(crate) struct ServerSection {
    pub(crate) port: Option<u16>,
    pub(crate) bind: Option<String>,
    pub(crate) log: Option<String>,
    pub(crate) username: Option<String>,
    pub(crate) password: Option<String>,
    /// When true, session cookies are marked `Secure` for HTTPS deployments.
    pub(crate) cookie_secure: bool,
}

/// Parsed `[agent]` table for a standalone `redoor agent` process.
///
/// All fields are optional in the file so CLI and env can supply missing
/// values; agent startup requires `ws_address`, `name`, and top-level
/// `agent_token` after applying CLI > env > config > default precedence.
#[derive(Debug, Clone, Default)]
pub(crate) struct AgentSection {
    pub(crate) ws_address: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) dir: Option<String>,
    pub(crate) log: Option<String>,
}

/// Full parsed config file shared by server and agent processes.
#[derive(Debug, Clone)]
pub(crate) struct RedoorConfig {
    /// Shared secret agents present when registering over `/ws`.
    pub(crate) agent_token: String,
    /// Present when the file configures a server process.
    pub(crate) server: Option<ServerSection>,
    /// Present when the file configures a standalone agent process.
    pub(crate) agent: Option<AgentSection>,
    /// Server-managed local/SSH agents (server mode only).
    pub(crate) agents: Vec<AgentConfig>,
}

/// Reads and validates the shared config file used by both server and agent.
///
/// Top-level non-empty `agent_token` is always required. `[server]`, `[agent]`,
/// and `[[agents]]` are optional at parse time; each process validates the
/// sections it needs after applying CLI/env overrides.
///
/// Uses `toml_edit` (instead of the `toml` crate) so future server-side
/// rewriting of the file — for example adding an agent via a REST endpoint —
/// can preserve comments, whitespace and formatting without re-serializing the
/// whole document from scratch. Parsing with the immutable `Document` is
/// enough for the read path; it can be upgraded to `DocumentMut` via
/// `into_mut()` when editing support is added.
pub(crate) async fn parse_config_file(path: &str) -> Result<RedoorConfig> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read config file '{}'", path))?;
    let doc = Document::parse(&content)
        .map_err(|e| anyhow::anyhow!("Failed to parse config file '{}': {}", path, e))?;

    // Reject unknown root keys so typos are not silently ignored.
    const KNOWN_ROOT_KEYS: [&str; 4] = ["agent_token", "server", "agent", "agents"];
    for (key, _) in doc.iter() {
        if !KNOWN_ROOT_KEYS.contains(&key) {
            bail!(
                "unknown top-level key '{}' in config file; expected one of: {}",
                key,
                KNOWN_ROOT_KEYS.join(", ")
            );
        }
    }

    let agent_token = doc
        .get("agent_token")
        .and_then(|item| item.as_str())
        .filter(|value| !value.is_empty())
        .with_context(
            || "agent_token must be a non-empty string at the top level of the config file",
        )?
        .to_string();

    let server = parse_server_section(&doc)?;
    let agent = parse_agent_section(&doc)?;
    let agents = parse_agents_array(&doc, path)?;

    Ok(RedoorConfig {
        agent_token,
        server,
        agent,
        agents,
    })
}

/// Returns the `[server]` section or a clear error for server-only entry points.
pub(crate) fn require_server_section(config: &RedoorConfig) -> Result<&ServerSection> {
    config
        .server
        .as_ref()
        .with_context(|| "config file must contain a [server] table")
}

/// Returns whether `[agent]` supplies every field a bare `redoor agent` needs.
///
/// Used by systemd agent setup so the unit can omit CLI flags safely.
pub(crate) fn standalone_agent_is_fully_configured(config: &RedoorConfig) -> bool {
    let Some(agent) = config.agent.as_ref() else {
        return false;
    };
    !config.agent_token.is_empty()
        && agent
            .ws_address
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        && agent.name.as_ref().is_some_and(|value| !value.is_empty())
}

/// Parses optional login credentials and listener settings from `[server]`.
///
/// Returns `Ok(None)` when the table is absent so agent-only configs stay valid.
fn parse_server_section(doc: &ParsedDocument<'_>) -> Result<Option<ServerSection>> {
    let Some(table) = doc.get("server").and_then(|item| item.as_table()) else {
        return Ok(None);
    };

    // Reject unknown keys so a misspelled setting is surfaced immediately
    // instead of silently falling back to a default the operator didn't mean.
    // agent_token moved to the document root; keep rejecting it here with a
    // pointer so existing files fail with an actionable message.
    const KNOWN_KEYS: [&str; 6] = [
        "port",
        "bind",
        "log",
        "username",
        "password",
        "cookie_secure",
    ];
    for (key, _) in table.iter() {
        if key == "agent_token" {
            bail!(
                "server.agent_token is no longer valid; move agent_token to the top level of the config file"
            );
        }
        if !KNOWN_KEYS.contains(&key) {
            bail!(
                "unknown key 'server.{}' in config file; expected one of: {}",
                key,
                KNOWN_KEYS.join(", ")
            );
        }
    }

    let port = match table.get("port") {
        None => None,
        Some(item) => {
            let raw = item
                .as_integer()
                .with_context(|| "server.port must be an integer")?;
            Some(
                u16::try_from(raw)
                    .with_context(|| format!("server.port '{}' does not fit in a u16", raw))?,
            )
        }
    };

    let bind = table
        .get("bind")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    let log = table
        .get("log")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());
    let username = match table.get("username") {
        None => None,
        Some(item) => {
            let value = item
                .as_str()
                .with_context(|| "server.username must be a string")?
                .to_string();
            if value.is_empty() {
                bail!("server.username must be a non-empty string when set");
            }
            Some(value)
        }
    };
    let password = match table.get("password") {
        None => None,
        Some(item) => {
            let value = item
                .as_str()
                .with_context(|| "server.password must be a string")?
                .to_string();
            if value.is_empty() {
                bail!("server.password must be a non-empty string when set");
            }
            Some(value)
        }
    };
    // Require the pair together so a half-configured file cannot silently fall
    // back to system auth while still embedding one of the secrets.
    match (&username, &password) {
        (Some(_), Some(_)) | (None, None) => {}
        (Some(_), None) => {
            bail!("server.password is required when server.username is set")
        }
        (None, Some(_)) => {
            bail!("server.username is required when server.password is set")
        }
    }
    #[cfg(not(target_os = "linux"))]
    if username.is_none() {
        bail!(
            "server.username and server.password are required on this platform; \
             system-account (PAM) login is only supported on Linux"
        );
    }
    let cookie_secure = match table.get("cookie_secure") {
        None => false,
        Some(item) => item
            .as_bool()
            .with_context(|| "server.cookie_secure must be a boolean")?,
    };

    Ok(Some(ServerSection {
        port,
        bind,
        log,
        username,
        password,
        cookie_secure,
    }))
}

/// Parses optional standalone agent settings from `[agent]`.
fn parse_agent_section(doc: &ParsedDocument<'_>) -> Result<Option<AgentSection>> {
    let Some(table) = doc.get("agent").and_then(|item| item.as_table()) else {
        return Ok(None);
    };

    const KNOWN_KEYS: [&str; 4] = ["ws_address", "name", "dir", "log"];
    for (key, _) in table.iter() {
        if !KNOWN_KEYS.contains(&key) {
            bail!(
                "unknown key 'agent.{}' in config file; expected one of: {}",
                key,
                KNOWN_KEYS.join(", ")
            );
        }
    }

    let non_empty_string = |key: &str| -> Result<Option<String>> {
        match table.get(key) {
            None => Ok(None),
            Some(item) => {
                let value = item
                    .as_str()
                    .with_context(|| format!("agent.{key} must be a string"))?
                    .to_string();
                if value.is_empty() {
                    bail!("agent.{key} must be a non-empty string when set");
                }
                Ok(Some(value))
            }
        }
    };

    Ok(Some(AgentSection {
        ws_address: non_empty_string("ws_address")?,
        name: non_empty_string("name")?,
        dir: non_empty_string("dir")?,
        log: non_empty_string("log")?,
    }))
}

/// Parses optional managed agents so authentication-only servers remain valid.
fn parse_agents_array(doc: &ParsedDocument<'_>, _path: &str) -> Result<Vec<AgentConfig>> {
    let Some(agents) = doc.get("agents").and_then(|item| item.as_array_of_tables()) else {
        return Ok(Vec::new());
    };

    let mut configs = Vec::new();
    for (index, entry) in agents.iter().enumerate() {
        // The `local` flag selects between ssh and local. We default to
        // `false` so an existing ssh-style entry keeps working unchanged.
        let local = entry
            .get("local")
            .and_then(|item| item.as_bool())
            .unwrap_or(false);

        if local {
            configs.push(parse_local_entry(index, entry)?);
        } else {
            configs.push(AgentConfig::Ssh(parse_ssh_entry(index, entry)?));
        }
    }
    Ok(configs)
}

/// Parses one ssh-style `[[agents]]` entry. `target` is the only required
/// field: without a host there is nothing to ssh to. All other fields are
/// explicit per-entry settings that the operator must declare so a missing
/// field is surfaced as an error rather than silently falling back to a
/// default the operator may not have intended. `dir` is shared with the
/// local variant so an operator can mirror a UI default directory across both
/// kinds of agents without duplicating logic.
fn parse_ssh_entry(index: usize, entry: &toml_edit::Table) -> Result<SshAgentConfig> {
    let target = entry
        .get("target")
        .and_then(|item| item.as_str())
        .with_context(|| format!("agents entry #{} is missing a 'target' string", index))?
        .to_string();

    let username = entry
        .get("username")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    let ssh_port = match entry.get("ssh_port") {
        None => 22,
        Some(item) => {
            let raw = item.as_integer().with_context(|| {
                format!("agents entry #{} 'ssh_port' must be an integer", index)
            })?;
            u16::try_from(raw).with_context(|| {
                format!(
                    "ssh_port '{}' in agents entry #{} does not fit in a u16",
                    raw, index
                )
            })?
        }
    };

    let name = entry
        .get("name")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    let remote_bin = entry
        .get("remote_bin")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    let dir = entry
        .get("dir")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    let log = entry
        .get("log")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    Ok(SshAgentConfig {
        username,
        ssh_port,
        name,
        remote_bin,
        dir,
        target,
        log,
    })
}

/// Parses one local `[[agents]]` entry. No ssh-specific fields are allowed
/// because local agents speak the websocket protocol directly and would
/// never use them. `name`, `dir`, and `log` are all optional and fall back
/// to the agent's own defaults (hostname, current dir, stdio logging).
fn parse_local_entry(index: usize, entry: &toml_edit::Table) -> Result<AgentConfig> {
    // Reject ssh-specific fields so an operator who pastes an ssh entry and
    // just adds `local = true` gets a clear error rather than a confusing
    // "agent started but never connected" failure later.
    if entry.get("target").and_then(|item| item.as_str()).is_some() {
        bail!(
            "agents entry #{} has both 'local = true' and a 'target'; \
             local agents do not use ssh, remove 'target'",
            index
        );
    }
    if entry
        .get("username")
        .and_then(|item| item.as_str())
        .is_some()
    {
        bail!(
            "agents entry #{} has 'username' which only applies to ssh agents (local = true); \
             remove 'username'",
            index
        );
    }
    if entry.get("ssh_port").is_some() {
        bail!(
            "agents entry #{} has 'ssh_port' which only applies to ssh agents (local = true); \
             remove 'ssh_port'",
            index
        );
    }
    if entry
        .get("remote_bin")
        .and_then(|item| item.as_str())
        .is_some()
    {
        bail!(
            "agents entry #{} has 'remote_bin' which only applies to ssh agents (local = true); \
             remove 'remote_bin'",
            index
        );
    }

    let name = entry
        .get("name")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());
    let dir = entry
        .get("dir")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());
    let log = entry
        .get("log")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    Ok(AgentConfig::Local(LocalAgentConfig { name, dir, log }))
}

/// Returns the default agent name for a local entry: the system hostname.
/// Using the hostname (rather than e.g. `"local"`) means multiple servers on
/// different machines each spawn a local agent with a distinct, meaningful
/// name without the operator having to configure it. The supervisor in
/// [`super::watchdog`] imports this helper so the key it registers in the
/// [`crate::watchdog::WatchdogRegistry`] matches the name the spawned
/// agent actually uses.
pub(crate) fn default_local_agent_name() -> String {
    System::host_name().unwrap_or_else(|| "local".to_string())
}

/// Spawns `redoor agent` as a local child process and returns the running
/// [`tokio::process::Child`] so the watchdog supervisor can wait for it or
/// kill it when the WebSocket goes stale.
///
/// The child reuses the server's own binary (via `std::env::current_exe`),
/// which is always present because the server itself was launched from it.
/// This avoids requiring the operator to keep two binaries in sync or
/// configure a path. Stdio is inherited so agent logs appear in the same
/// terminal as the server logs unless `--log` is set in the toml.
pub(crate) async fn spawn_local_agent(
    config: &LocalAgentConfig,
    redoor_port: u16,
    agent_token: &str,
) -> Result<tokio::process::Child, Box<dyn std::error::Error>> {
    let name = config.name.clone().unwrap_or_else(default_local_agent_name);
    let ws_url = format!("ws://localhost:{}/ws", redoor_port);

    let bin = std::env::current_exe()
        .map_err(|e| format!("Failed to determine redoor binary path: {}", e))?;

    let mut command = Command::new(&bin);
    command
        .arg("agent")
        .arg(&ws_url)
        .arg("--name")
        .arg(&name)
        .arg("--token")
        .arg(agent_token);

    if let Some(dir) = &config.dir {
        command.arg("-d").arg(dir);
    }

    command.stdin(Stdio::inherit());

    if let Some(log) = &config.log {
        // Redirect the child's stdout/stderr into the log file instead of
        // passing --log to the agent. The agent writes to stdout/stderr
        // and the OS redirect captures it, avoiding double-writes that
        // would happen if both --log and a redirect were used.
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .await?;
        let file_for_stderr = file.try_clone().await?;
        command.stdout(Stdio::from(file.into_std().await));
        command.stderr(Stdio::from(file_for_stderr.into_std().await));
    } else {
        command.stdout(Stdio::inherit());
        command.stderr(Stdio::inherit());
    }

    log!(
        Level::Info,
        "Starting local redoor agent: name={}, ws_url={}, bin={}, log={:?}",
        name,
        ws_url,
        bin.display(),
        config.log,
    );

    // Ensure the agent process is killed if the supervisor task is
    // dropped (e.g. on server shutdown), preventing the `redoor agent`
    // child from being orphaned. `kill_on_drop` sends SIGKILL.
    command.kill_on_drop(true);
    let child = command.spawn()?;
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Adds required top-level token and server credentials without obscuring each test's payload.
    fn write_test_config(path: &std::path::Path, content: impl AsRef<str>) -> std::io::Result<()> {
        let content = content.as_ref();
        let token_line = "agent_token = \"test-agent-token\"\n";
        let credentials = "username = \"test-user\"\npassword = \"test-password\"\n";
        let server_header = "[server]\n";
        let with_server = if content.contains(server_header) {
            content.replacen(server_header, &format!("{server_header}{credentials}"), 1)
        } else {
            format!(
                r#"[server]
{credentials}
{content}"#
            )
        };
        let complete = if with_server.contains("agent_token") {
            with_server
        } else {
            format!("{token_line}\n{with_server}")
        };
        std::fs::write(path, complete)
    }

    /// Verifies that all optional fields fall back to their defaults when
    /// omitted, so a minimal agents file with only a `target` is valid.
    /// `ssh_port` defaults to 22 when missing.
    #[tokio::test]
    async fn test_parse_config_file_minimal_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_test_config(
            &temp,
            r#"[[agents]]
target = "user@example.com"
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(
            config.agents.len(),
            1,
            "exactly one agent entry should be parsed"
        );
        let agent = match &config.agents[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(agent.target, "user@example.com");
        // ssh_port defaults to 22 when not specified, matching `redoor ssh`.
        assert_eq!(agent.ssh_port, 22);
        // username, name, remote_bin and dir are None so start_ssh_agent can
        // derive them (default name from target, default remote_bin from
        // versioned layout, default dir from the remote shell's cwd).
        assert!(agent.username.is_none());
        assert!(agent.name.is_none());
        assert!(agent.remote_bin.is_none());
        assert!(agent.dir.is_none());
        assert!(agent.log.is_none(), "log should be None when not specified");
    }

    /// Verifies that every supported field is read from the toml file so
    /// operators can override the defaults per agent.
    #[tokio::test]
    async fn test_parse_config_file_full_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-full-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[[agents]]
target = "prod-db"
username = "deploy"
ssh_port = 2222
name = "db-agent"
remote_bin = "/usr/local/bin/redoor"
dir = "/srv/app"
log = "log/db-agent.log"

[[agents]]
target = "web-1"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(config.agents.len(), 2, "both entries should be parsed");
        let first = match &config.agents[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(first.target, "prod-db");
        assert_eq!(first.username.as_deref(), Some("deploy"));
        assert_eq!(first.ssh_port, 2222);
        assert_eq!(first.name.as_deref(), Some("db-agent"));
        assert_eq!(first.remote_bin.as_deref(), Some("/usr/local/bin/redoor"));
        assert_eq!(first.dir.as_deref(), Some("/srv/app"));
        assert_eq!(first.log.as_deref(), Some("log/db-agent.log"));

        // The second entry only has a target, confirming ssh_port defaults to 22
        // when omitted while the first entry overrides it explicitly.
        let second = match &config.agents[1] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(second.target, "web-1");
        assert_eq!(second.ssh_port, 22);
    }

    /// Verifies that credentials-only configuration can run without managed agents.
    #[tokio::test]
    async fn test_parse_config_file_accepts_missing_agents_key() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-key-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_test_config(&temp, "port = 3000\n").unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert!(
            config.agents.is_empty(),
            "a credentials-only server should not require managed agents"
        );
    }

    /// Verifies that an entry without a `target` is rejected so the parser
    /// fails fast on an incomplete entry instead of producing an agent with
    /// nothing to connect to.
    #[tokio::test]
    async fn test_parse_config_file_rejects_entry_without_target() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-target-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_test_config(
            &temp,
            r#"[[agents]]
name = "no-target"
"#,
        )
        .unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "an entry without a target should be rejected"
        );
    }

    /// Verifies that a present-but-non-integer `ssh_port` is rejected rather
    /// than silently falling back to 22, so a typo like a string value is
    /// surfaced as an explicit operator error.
    #[tokio::test]
    async fn test_parse_config_file_rejects_non_integer_ssh_port() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-type-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"[[agents]]
target = "host"
ssh_port = "not-a-port"
"#,
        )
        .unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(result.is_err(), "a non-integer ssh_port should be rejected");
    }

    /// Verifies that an out-of-range `ssh_port` is rejected rather than
    /// silently truncating, so the operator gets a clear error for a typo.
    #[tokio::test]
    async fn test_parse_config_file_rejects_out_of_range_port() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-port-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_test_config(
            &temp,
            r#"[[agents]]
target = "host"
ssh_port = 99999
"#,
        )
        .unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "an out-of-range ssh_port should be rejected"
        );
    }

    /// Verifies that a `local = true` entry without any other fields parses
    /// into a [`AgentConfig::Local`] with all optional fields `None`, so the
    /// runtime can fall back to its own defaults (hostname, current dir,
    /// inherited stdio).
    #[tokio::test]
    async fn test_parse_config_file_minimal_local_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-local-min-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_test_config(
            &temp,
            r#"[[agents]]
local = true
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(
            config.agents.len(),
            1,
            "exactly one agent entry should be parsed"
        );
        let agent = match &config.agents[0] {
            AgentConfig::Local(config) => config,
            AgentConfig::Ssh(_) => panic!("entry with `local = true` should be local"),
        };
        assert!(
            agent.name.is_none(),
            "name should be None so the runtime defaults to hostname"
        );
        assert!(agent.dir.is_none(), "dir should be None by default");
        assert!(agent.log.is_none(), "log should be None by default");
    }

    /// Verifies that every supported local field is read from the toml file
    /// so operators can override the defaults per agent.
    #[tokio::test]
    async fn test_parse_config_file_full_local_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-local-full-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[[agents]]
local = true
name = "my-local"
dir = "/var/work"
log = "/var/log/my-local.log"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(
            config.agents.len(),
            1,
            "exactly one agent entry should be parsed"
        );
        let agent = match &config.agents[0] {
            AgentConfig::Local(config) => config,
            AgentConfig::Ssh(_) => panic!("entry with `local = true` should be local"),
        };
        assert_eq!(agent.name.as_deref(), Some("my-local"));
        assert_eq!(agent.dir.as_deref(), Some("/var/work"));
        assert_eq!(agent.log.as_deref(), Some("/var/log/my-local.log"));
    }

    /// Verifies that a single agents file can mix ssh and local entries,
    /// parsing each into the correct variant, so an operator can manage
    /// remote hosts and a local agent from the same file.
    #[tokio::test]
    async fn test_parse_config_file_mixed_entries() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-mixed-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[[agents]]
target = "remote-1"

[[agents]]
local = true
name = "local-1"

[[agents]]
target = "remote-2"
name = "web-agent"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(config.agents.len(), 3, "all three entries should be parsed");

        let first = match &config.agents[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("first entry has no `local = true`"),
        };
        assert_eq!(first.target, "remote-1");

        let second = match &config.agents[1] {
            AgentConfig::Local(config) => config,
            AgentConfig::Ssh(_) => panic!("second entry has `local = true`"),
        };
        assert_eq!(second.name.as_deref(), Some("local-1"));

        let third = match &config.agents[2] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("third entry has no `local = true`"),
        };
        assert_eq!(third.target, "remote-2");
        assert_eq!(third.name.as_deref(), Some("web-agent"));
    }

    /// Verifies that an entry with `local = true` AND a `target` is rejected
    /// so the operator gets a clear error instead of a silently misconfigured
    /// agent that the dispatcher would then ignore the `target` for.
    #[tokio::test]
    async fn test_parse_config_file_rejects_local_with_target() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-local-target-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_test_config(
            &temp,
            r#"[[agents]]
local = true
target = "host"
"#,
        )
        .unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        let error = result.expect_err("local + target should be rejected");
        // The error should mention both fields so the operator immediately
        // sees which fields conflict.
        assert!(
            error.to_string().contains("local") && error.to_string().contains("target"),
            "error should mention both 'local' and 'target': {}",
            error
        );
    }

    /// Verifies that ssh-only fields on a local entry are rejected with a
    /// field-specific error, so an operator who pastes an ssh entry and
    /// just adds `local = true` gets a clear pointer to each mis-placed
    /// field rather than a single vague "config error".
    #[tokio::test]
    async fn test_parse_config_file_rejects_local_with_ssh_fields() {
        for field in ["username", "ssh_port", "remote_bin"] {
            let temp = std::env::temp_dir().join(format!(
                "redoor-agents-test-local-ssh-{}-{}.toml",
                field,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            write_test_config(
                &temp,
                format!(
                    r#"[[agents]]
local = true
{field} = "x"
"#
                ),
            )
            .unwrap();

            let result = parse_config_file(temp.to_str().unwrap()).await;
            std::fs::remove_file(&temp).ok();

            let error = result.expect_err(&format!("local + {} should be rejected", field));
            assert!(
                error.to_string().contains(field),
                "error should mention '{}': {}",
                field,
                error
            );
        }
    }

    /// Verifies that a `dir` on an ssh entry is accepted and forwarded into
    /// the [`SshAgentConfig`] so an operator can pin a remote agent's cwd to
    /// a project tree, mirroring the same option on local agents.
    #[tokio::test]
    async fn test_parse_config_file_ssh_entry_with_dir() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-ssh-dir-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[[agents]]
target = "prod-db"
dir = "/var/www/app"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(
            config.agents.len(),
            1,
            "exactly one agent entry should be parsed"
        );
        let agent = match &config.agents[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(
            agent.dir.as_deref(),
            Some("/var/www/app"),
            "dir should be read from the toml entry"
        );
    }

    /// Verifies that a `log` on an ssh entry is accepted and forwarded into
    /// the SshAgentConfig so the operator can capture a remote agent's
    /// forwarded stdout/stderr into a local log file.
    #[tokio::test]
    async fn test_parse_config_file_ssh_entry_with_log() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-ssh-log-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[[agents]]
target = "prod-db"
log = "log/prod-db.log"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(config.agents.len(), 1);
        let agent = match &config.agents[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(
            agent.log.as_deref(),
            Some("log/prod-db.log"),
            "log should be read from the ssh toml entry"
        );
    }

    /// Verifies agent-only configs may omit `[server]` while still requiring the top-level token.
    #[tokio::test]
    async fn test_parse_config_file_allows_missing_server_section() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-server-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"agent_token = "test-agent-token"

[agent]
ws_address = "ws://127.0.0.1:3000/ws"
name = "edge"
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert!(
            config.server.is_none(),
            "agent-only hosts should not need a [server] table"
        );
        assert!(
            require_server_section(&config).is_err(),
            "server entry points must still reject agent-only configs"
        );
        assert!(
            standalone_agent_is_fully_configured(&config),
            "complete [agent] + token should satisfy bare agent startup"
        );
    }

    /// Verifies omitting the shared top-level token fails for every process role.
    #[tokio::test]
    async fn test_parse_config_file_rejects_missing_agent_token() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-token-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"[server]
username = "test-user"
password = "test-password"
"#,
        )
        .unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(result.is_err(), "top-level agent_token must be required");
    }

    /// Verifies that all three [server] fields are read from the file so
    /// operators can pin the whole server surface from one config file.
    #[tokio::test]
    async fn test_parse_config_file_reads_server_section() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-server-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[server]
port = 4000
bind = "127.0.0.1"
log = "/tmp/x"

[[agents]]
target = "host"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        let server = config.server.expect("[server] should be present");
        assert_eq!(server.port, Some(4000));
        assert_eq!(server.bind.as_deref(), Some("127.0.0.1"));
        assert_eq!(server.log.as_deref(), Some("/tmp/x"));
        assert_eq!(config.agent_token, "test-agent-token");
    }

    /// Verifies that an unknown key in [server] is rejected so a typo is surfaced
    /// at startup instead of silently being ignored.
    #[tokio::test]
    async fn test_parse_config_file_rejects_unknown_server_key() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-server-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[server]
post = 3000

[[agents]]
target = "host"
"#;
        write_test_config(&temp, content).unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "an unknown [server] key should be rejected"
        );
        assert!(result.unwrap_err().to_string().contains("post"));
    }

    /// Verifies that an out-of-range port in [server] is rejected so the
    /// operator gets a clear error for a typo, mirroring the existing
    /// ssh_port range test.
    #[tokio::test]
    async fn test_parse_config_file_rejects_out_of_range_server_port() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-server-port-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"
[server]
port = 99999

[[agents]]
target = "host"
"#;
        write_test_config(&temp, content).unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "an out-of-range server.port should be rejected"
        );
    }

    /// Verifies first startup creates a complete, parseable config and later startups preserve it.
    #[tokio::test]
    async fn test_create_default_config_if_missing() {
        let directory = std::env::temp_dir().join(format!(
            "redoor-default-config-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("nested/config.toml");

        let created = create_default_config_if_missing(&path).await.unwrap();
        let content = tokio::fs::read_to_string(&path).await.unwrap();
        let config = parse_config_file(path.to_str().unwrap()).await.unwrap();

        let bootstrap = created.expect("a missing conventional config should be created");
        assert_eq!(
            config.agent_token, bootstrap.agent_token,
            "the generated agent_token should match the one-time printed secret"
        );
        assert!(
            bootstrap.agent_token.len() >= 32,
            "bootstrap agent_token must be high entropy"
        );
        let server = config
            .server
            .as_ref()
            .expect("server bootstrap must write a [server] table");

        #[cfg(target_os = "linux")]
        {
            // Linux starter configs omit credentials so login uses PAM.
            assert!(
                server.username.is_none() && server.password.is_none(),
                "Linux default config should omit username/password for PAM login"
            );
            assert!(
                bootstrap.password.is_none(),
                "Linux bootstrap should not print a generated password"
            );
            assert!(
                content.contains("system username/password") || content.contains("PAM"),
                "Linux starter config should document PAM login"
            );
        }
        #[cfg(not(target_os = "linux"))]
        {
            let expected_username = current_process_username().await.unwrap();
            assert_eq!(
                server.username.as_deref(),
                Some(expected_username.as_str()),
                "the generated login should use the effective process account"
            );
            assert_eq!(
                server.password.as_ref(),
                bootstrap.password.as_ref(),
                "the generated login should use the one-time printed password"
            );
            let password = bootstrap
                .password
                .as_ref()
                .expect("non-Linux bootstrap must generate a password");
            assert!(
                password.len() >= 32,
                "bootstrap password must be high entropy"
            );
            assert_ne!(
                password, &bootstrap.agent_token,
                "password and agent_token must be independent secrets"
            );
        }

        for option in [
            "agent_token =",
            "# port =",
            "# bind =",
            "# cookie_secure =",
            "# log =",
            "# [agent]",
            "# ws_address =",
            "# target =",
            "# local =",
            "# username = \"remote-user\"",
            "# ssh_port =",
            "# name =",
            "# remote_bin =",
            "# dir =",
        ] {
            assert!(
                content.contains(option),
                "the starter config should document option {option}"
            );
        }

        let created_again = create_default_config_if_missing(&path).await.unwrap();
        let unchanged = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(
            created_again.is_none(),
            "an existing config must never be overwritten by startup"
        );
        assert_eq!(
            unchanged, content,
            "checking an existing config must leave every byte unchanged"
        );

        tokio::fs::remove_dir_all(directory).await.ok();
    }

    /// Verifies agent setup can seed a complete standalone config with the server's token.
    #[tokio::test]
    async fn test_create_default_config_with_supplied_agent_token() {
        let directory = std::env::temp_dir().join(format!(
            "redoor-agent-default-config-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("config.toml");

        let created =
            create_default_config_if_missing_with_options(&path, Some("shared-token"), true)
                .await
                .unwrap()
                .expect("a missing agent config should be created");
        let config = parse_config_file(path.to_str().unwrap()).await.unwrap();

        assert_eq!(
            created.agent_token, "shared-token",
            "the bootstrap result should report the supplied shared token"
        );
        assert_eq!(
            config.agent_token, "shared-token",
            "the shared parser should recover the supplied token from the common config"
        );
        assert!(
            config.server.is_none(),
            "standalone agent bootstrap should omit [server]"
        );
        assert!(
            standalone_agent_is_fully_configured(&config),
            "standalone agent bootstrap must be runnable without CLI flags"
        );

        tokio::fs::remove_dir_all(directory).await.ok();
    }

    /// Verifies nested agent_token under [server] fails with a migration hint.
    #[tokio::test]
    async fn test_parse_config_file_rejects_server_agent_token() {
        let path = std::env::temp_dir().join(format!(
            "redoor-agent-token-legacy-test-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::write(&path, "[server]\nagent_token = \"legacy-token\"\n")
            .await
            .unwrap();

        let result = parse_config_file(path.to_str().unwrap()).await;
        tokio::fs::remove_file(&path).await.ok();

        let error = result
            .expect_err("legacy server.agent_token must be rejected")
            .to_string();
        assert!(
            error.contains("top level"),
            "error should tell operators to move agent_token to the top level: {error}"
        );
    }

    /// Verifies the shared parser reads a complete [agent] table.
    #[tokio::test]
    async fn test_parse_config_file_reads_agent_section() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-agent-section-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"agent_token = "test-agent-token"

[agent]
ws_address = "wss://example.com/ws"
name = "edge"
dir = "/var/app"
log = "log/agent.log"
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        let agent = config.agent.expect("[agent] should be present");
        assert_eq!(agent.ws_address.as_deref(), Some("wss://example.com/ws"));
        assert_eq!(agent.name.as_deref(), Some("edge"));
        assert_eq!(agent.dir.as_deref(), Some("/var/app"));
        assert_eq!(agent.log.as_deref(), Some("log/agent.log"));
    }

    /// Verifies Linux accepts a credentials-free [server] table for PAM login.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn test_parse_config_file_allows_missing_credentials_on_linux() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-pam-creds-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"agent_token = "test-agent-token"

[server]
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        let server = config.server.expect("[server] should be present");
        assert!(
            server.username.is_none() && server.password.is_none(),
            "omitted credentials should parse as None for PAM mode"
        );
        assert_eq!(config.agent_token, "test-agent-token");
    }

    /// Verifies a half-specified credential pair is rejected instead of mixed auth modes.
    #[tokio::test]
    async fn test_parse_config_file_rejects_partial_credentials() {
        for content in [
            r#"agent_token = "test-agent-token"

[server]
username = "only-user"
"#,
            r#"agent_token = "test-agent-token"

[server]
password = "only-password"
"#,
        ] {
            let temp = std::env::temp_dir().join(format!(
                "redoor-agents-test-partial-creds-{}.toml",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::write(&temp, content).unwrap();
            let result = parse_config_file(temp.to_str().unwrap()).await;
            std::fs::remove_file(&temp).ok();
            assert!(
                result.is_err(),
                "username and password must be provided together"
            );
        }
    }
}
