//! Shared TOML config used by the server, standalone agent, and service installers.
//!
//! Top-level `agent_token` is the shared registration secret. Optional
//! `[server]` holds listener and browser-auth settings; optional `[agent]`
//! holds standalone agent connection settings; optional `[[agents]]` lists
//! server-managed local/SSH-backed agents; optional `[[relays]]` lists independently
//! started SSH relays. Server mode requires `[server]`; agent
//! mode resolves required fields from CLI > env > config > default.

mod bootstrap;
mod edit;
mod import;
mod local_agent;

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use toml_edit::Document;

#[cfg(target_os = "linux")]
pub(crate) use bootstrap::default_log_directory;
pub(crate) use bootstrap::{
    create_default_config_if_missing, default_agent_log_path, default_config_path,
    default_local_agent_name, default_process_log_path, default_relay_log_path,
    default_server_log_path,
};
pub(crate) use edit::append_ssh_agent;
pub(crate) use import::import_agent_config_from_stdin;
pub(crate) use local_agent::spawn_local_agent;

/// Shorthand for the [`Document`] type produced by [`Document::parse`], whose
/// key storage is borrowed from the parsed source. Used in helper signatures
/// so we don't have to spell out the generic parameter on every function.
type ParsedDocument<'a> = Document<&'a String>;

use crate::ssh::SshBackedAgentConfig;

/// Configuration for one local agent, parsed from the agents toml.
///
/// Mirrors the subset of [`crate::ssh::SshBackedAgentConfig`] fields that make
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
    /// Home directory the spawned agent publishes for UI tab navigation.
    pub(crate) home: Option<String>,
    /// Log file path. When set, the spawned `redoor agent` process's
    /// stdout/stderr is redirected (append mode) to this file. When
    /// `None`, stdio is inherited so the agent's logs appear in the
    /// server's terminal.
    pub(crate) log: Option<String>,
}

/// One configured agent entry from the agents toml. The variant decides
/// whether the server can start an SSH-backed agent or a plain local one,
/// so the dispatcher in `register_agents` can pick the right transport
/// without inspecting the per-variant fields itself.
#[derive(Debug, Clone)]
pub(crate) enum AgentConfig {
    SshBacked(SshBackedAgentConfig),
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
/// values; agent startup requires `server` and top-level `agent_token`
/// after applying CLI > env > config > default precedence. The name defaults
/// to the computer hostname.
#[derive(Debug, Clone, Default)]
pub(crate) struct AgentSection {
    /// Redoor server URL (`http(s)://` or `ws(s)://`); path optional and forced to `/ws`.
    pub(crate) server: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) home: Option<String>,
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
    /// Server-managed local/SSH-backed agents (server mode only).
    pub(crate) agents: Vec<AgentConfig>,
    /// Named SSH relays that operators start and stop independently.
    pub(crate) relays: Vec<RelayConfig>,
}

/// Configuration for one independently managed SSH relay.
#[derive(Debug, Clone)]
pub(crate) struct RelayConfig {
    /// Stable local identity used for lifecycle commands and runtime files.
    pub(crate) id: String,
    /// Redoor server URL reached from the machine running the relay.
    pub(crate) server: String,
    /// Whether routed TLS certificate verification is intentionally disabled.
    pub(crate) insecure: bool,
    /// Optional local binary that is uploaded before starting the remote agent.
    pub(crate) binary_source: Option<PathBuf>,
    /// Optional remote process namespace; defaults to one derived from the local app and relay ID.
    pub(crate) agent_app_name: Option<String>,
    /// SSH-backed agent settings shared with server-managed agents.
    pub(crate) agent: SshBackedAgentConfig,
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
    const KNOWN_ROOT_KEYS: [&str; 5] = ["agent_token", "server", "agent", "agents", "relays"];
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
    let relays = parse_relays_array(&doc)?;

    Ok(RedoorConfig {
        agent_token,
        server,
        agent,
        agents,
        relays,
    })
}

/// Returns the named relay or an actionable error listing the missing identity.
pub(crate) fn require_relay<'a>(config: &'a RedoorConfig, id: &str) -> Result<&'a RelayConfig> {
    config
        .relays
        .iter()
        .find(|relay| relay.id == id)
        .with_context(|| format!("relay '{id}' is not configured"))
}

/// Restricts login names to one portable path component so account files cannot escape the data dir.
pub(crate) fn parse_server_username(value: &str) -> Result<String, String> {
    if value.is_empty() || value == "." || value == ".." {
        return Err("server.username must not be empty, '.' or '..'".to_string());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "server.username may contain only ASCII letters, numbers, '.', '_' and '-'".to_string(),
        );
    }
    Ok(value.to_string())
}

/// Restricts relay IDs to safe, portable runtime-file components.
pub(crate) fn parse_relay_id(value: &str) -> Result<String, String> {
    if value.is_empty() || value == "." || value == ".." {
        return Err("relay ID must not be empty, '.' or '..'".to_string());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "relay ID may contain only ASCII letters, numbers, '.', '_' and '-'".to_string(),
        );
    }
    Ok(value.to_string())
}

/// Returns the `[server]` section or a clear error for server-only entry points.
pub(crate) fn require_server_section(config: &RedoorConfig) -> Result<&ServerSection> {
    config
        .server
        .as_ref()
        .with_context(|| "config file must contain a [server] table")
}

/// Returns whether `[agent]` supplies every configured field a bare `redoor agent` needs.
///
/// The name may be omitted because agent startup uses the computer hostname.
/// Used by systemd agent setup so the unit can omit CLI flags safely.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn standalone_agent_is_fully_configured(config: &RedoorConfig) -> bool {
    let Some(agent) = config.agent.as_ref() else {
        return false;
    };
    !config.agent_token.is_empty() && agent.server.as_ref().is_some_and(|value| !value.is_empty())
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
                .with_context(|| "server.username must be a string")?;
            Some(parse_server_username(value).map_err(anyhow::Error::msg)?)
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

    // `ws_address` remains accepted so existing agent configs keep working.
    const KNOWN_KEYS: [&str; 6] = ["server", "ws_address", "name", "home", "dir", "log"];
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

    let server = non_empty_string("server")?;
    let legacy_ws_address = non_empty_string("ws_address")?;
    let server = match (server, legacy_ws_address) {
        (Some(_), Some(_)) => {
            bail!("agent.server and agent.ws_address cannot both be set; use agent.server")
        }
        (Some(server), None) => Some(server),
        // Prefer the new key name in memory while still loading legacy files.
        (None, Some(ws_address)) => Some(ws_address),
        (None, None) => None,
    };

    let home = aliased_string(&non_empty_string, "agent", "home", "dir")?;

    Ok(Some(AgentSection {
        server,
        name: non_empty_string("name")?,
        home,
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
            configs.push(AgentConfig::SshBacked(parse_ssh_backed_entry(
                index, entry,
            )?));
        }
    }
    Ok(configs)
}

/// Parses named relays separately from server-managed agents because their lifecycle is manual.
fn parse_relays_array(doc: &ParsedDocument<'_>) -> Result<Vec<RelayConfig>> {
    let Some(relays) = doc.get("relays").and_then(|item| item.as_array_of_tables()) else {
        return Ok(Vec::new());
    };
    let mut configs = Vec::new();
    for (index, entry) in relays.iter().enumerate() {
        const KNOWN_KEYS: [&str; 12] = [
            "id",
            "target",
            "server",
            "username",
            "ssh_port",
            "name",
            "remote_bin",
            "binary_source",
            "home",
            "log",
            "insecure",
            "agent_app_name",
        ];
        for (key, _) in entry.iter() {
            if !KNOWN_KEYS.contains(&key) {
                bail!(
                    "unknown key 'relays[{}].{}' in config file; expected one of: {}",
                    index,
                    key,
                    KNOWN_KEYS.join(", ")
                );
            }
        }
        let string = |key: &str, required: bool| -> Result<Option<String>> {
            let Some(item) = entry.get(key) else {
                if required {
                    bail!("relays entry #{} is missing a '{}' string", index, key);
                }
                return Ok(None);
            };
            let value = item
                .as_str()
                .with_context(|| format!("relays entry #{} '{}' must be a string", index, key))?;
            if value.trim().is_empty() {
                bail!("relays entry #{} '{}' must be non-empty", index, key);
            }
            Ok(Some(value.to_string()))
        };
        let id = parse_relay_id(&string("id", true)?.expect("required relay ID"))
            .map_err(anyhow::Error::msg)?;
        if configs.iter().any(|relay: &RelayConfig| relay.id == id) {
            bail!("duplicate relay ID '{id}'");
        }
        let target = string("target", true)?.expect("required relay target");
        let server = string("server", true)?.expect("required relay server");
        let server_address = server
            .parse::<crate::server_address::ServerAddress>()
            .map_err(|error| anyhow::anyhow!("invalid server in relay '{id}': {error}"))?;
        let ssh_port = match entry.get("ssh_port") {
            None => None,
            Some(item) => {
                let raw = item.as_integer().with_context(|| {
                    format!("relays entry #{} 'ssh_port' must be an integer", index)
                })?;
                Some(u16::try_from(raw).with_context(|| {
                    format!(
                        "ssh_port '{raw}' in relays entry #{} does not fit in a u16",
                        index
                    )
                })?)
            }
        };
        let insecure = match entry.get("insecure") {
            None => false,
            Some(item) => item
                .as_bool()
                .with_context(|| format!("relays entry #{} 'insecure' must be a boolean", index))?,
        };
        if insecure && !server_address.is_secure() {
            bail!("relay '{id}' insecure = true requires an https:// or wss:// server URL");
        }
        let agent_app_name = string("agent_app_name", false)?
            .map(|value| crate::app_name::parse_app_name(&value))
            .transpose()
            .map_err(anyhow::Error::msg)?;
        configs.push(RelayConfig {
            id,
            server,
            insecure,
            binary_source: string("binary_source", false)?.map(PathBuf::from),
            agent_app_name,
            agent: SshBackedAgentConfig {
                username: string("username", false)?,
                ssh_port,
                name: string("name", false)?,
                remote_bin: string("remote_bin", false)?,
                home: string("home", false)?,
                target,
                log: string("log", false)?,
            },
        });
    }
    Ok(configs)
}

/// Parses one ssh-style `[[agents]]` entry. `target` is the only required
/// field: without a host there is nothing to ssh to. All other fields are
/// explicit per-entry settings that the operator must declare so a missing
/// field is surfaced as an error rather than silently falling back to a
/// default the operator may not have intended. `home` is shared with the
/// local variant so an operator can mirror a UI default directory across both
/// kinds of agents without duplicating logic.
fn parse_ssh_backed_entry(index: usize, entry: &toml_edit::Table) -> Result<SshBackedAgentConfig> {
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
        None => None,
        Some(item) => {
            let raw = item.as_integer().with_context(|| {
                format!("agents entry #{} 'ssh_port' must be an integer", index)
            })?;
            Some(u16::try_from(raw).with_context(|| {
                format!(
                    "ssh_port '{}' in agents entry #{} does not fit in a u16",
                    raw, index
                )
            })?)
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

    let home = aliased_table_string(entry, index, "home", "dir")?;

    let log = entry
        .get("log")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    Ok(SshBackedAgentConfig {
        username,
        ssh_port,
        name,
        remote_bin,
        home,
        target,
        log,
    })
}

/// Parses one local `[[agents]]` entry. No ssh-specific fields are allowed
/// because local agents speak the websocket protocol directly and would
/// never use them. `name`, `home`, and `log` are all optional and fall back
/// to the agent's own defaults (hostname, process user home, stdio logging).
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
            "agents entry #{} has 'username' which only applies to SSH-backed agents (local = true); \
             remove 'username'",
            index
        );
    }
    if entry.get("ssh_port").is_some() {
        bail!(
            "agents entry #{} has 'ssh_port' which only applies to SSH-backed agents (local = true); \
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
            "agents entry #{} has 'remote_bin' which only applies to SSH-backed agents (local = true); \
             remove 'remote_bin'",
            index
        );
    }

    let name = entry
        .get("name")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());
    let home = aliased_table_string(entry, index, "home", "dir")?;
    let log = entry
        .get("log")
        .and_then(|item| item.as_str())
        .map(|s| s.to_string());

    Ok(AgentConfig::Local(LocalAgentConfig { name, home, log }))
}

/// Reads a renamed standalone setting while rejecting ambiguous old-and-new input.
fn aliased_string(
    read: &impl Fn(&str) -> Result<Option<String>>,
    section: &str,
    key: &str,
    legacy_key: &str,
) -> Result<Option<String>> {
    match (read(key)?, read(legacy_key)?) {
        (Some(_), Some(_)) => bail!(
            "{section}.{key} and {section}.{legacy_key} cannot both be set; use {section}.{key}"
        ),
        (Some(value), None) | (None, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

/// Reads a renamed managed-agent setting while rejecting ambiguous old-and-new input.
fn aliased_table_string(
    entry: &toml_edit::Table,
    index: usize,
    key: &str,
    legacy_key: &str,
) -> Result<Option<String>> {
    let value = entry.get(key).and_then(|item| item.as_str());
    let legacy_value = entry.get(legacy_key).and_then(|item| item.as_str());
    match (value, legacy_value) {
        (Some(_), Some(_)) => bail!(
            "agents entry #{} has both '{}' and '{}'; use '{}'",
            index,
            key,
            legacy_key,
            key
        ),
        (Some(value), None) | (None, Some(value)) => Ok(Some(value.to_string())),
        (None, None) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ensures login names stay inside the same allowlist used for on-disk account directories.
    #[test]
    fn parse_server_username_allows_portable_path_components() {
        for valid in ["test-user", "alice", "user.name", "user_1"] {
            assert_eq!(
                parse_server_username(valid).as_deref(),
                Ok(valid),
                "a portable login name should be accepted: {valid}"
            );
        }
        for invalid in [
            "",
            ".",
            "..",
            "alice/bob",
            "alice\\bob",
            "al\0ice",
            "user name",
            "user@host",
            "ålice",
        ] {
            assert!(
                parse_server_username(invalid).is_err(),
                "a non-portable login name should be rejected: {invalid:?}"
            );
        }
    }

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

    /// Verifies that all optional fields remain unset when omitted so OpenSSH
    /// can apply host-specific configuration for a minimal target-only entry.
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
            AgentConfig::SshBacked(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be SSH-backed"),
        };
        assert_eq!(agent.target, "user@example.com");
        // An omitted port must defer to OpenSSH host configuration rather than force port 22.
        assert_eq!(agent.ssh_port, None);
        // username, name, remote_bin and home are None so the SSH launcher can
        // derive them (default name from target, default remote_bin from
        // versioned layout, default home from the remote process user).
        assert!(agent.username.is_none());
        assert!(agent.name.is_none());
        assert!(agent.remote_bin.is_none());
        assert!(agent.home.is_none());
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
home = "/srv/app"
log = "log/db-agent.log"

[[agents]]
target = "web-1"
"#;
        write_test_config(&temp, content).unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(config.agents.len(), 2, "both entries should be parsed");
        let first = match &config.agents[0] {
            AgentConfig::SshBacked(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be SSH-backed"),
        };
        assert_eq!(first.target, "prod-db");
        assert_eq!(first.username.as_deref(), Some("deploy"));
        assert_eq!(first.ssh_port, Some(2222));
        assert_eq!(first.name.as_deref(), Some("db-agent"));
        assert_eq!(first.remote_bin.as_deref(), Some("/usr/local/bin/redoor"));
        assert_eq!(first.home.as_deref(), Some("/srv/app"));
        assert_eq!(first.log.as_deref(), Some("log/db-agent.log"));

        // The second entry defers to OpenSSH while the first overrides its port explicitly.
        let second = match &config.agents[1] {
            AgentConfig::SshBacked(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be SSH-backed"),
        };
        assert_eq!(second.target, "web-1");
        assert_eq!(second.ssh_port, None);
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
    /// runtime can fall back to its own defaults (hostname, process user home,
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
            AgentConfig::SshBacked(_) => panic!("entry with `local = true` should be local"),
        };
        assert!(
            agent.name.is_none(),
            "name should be None so the runtime defaults to hostname"
        );
        assert!(agent.home.is_none(), "home should be None by default");
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
home = "/var/work"
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
            AgentConfig::SshBacked(_) => panic!("entry with `local = true` should be local"),
        };
        assert_eq!(agent.name.as_deref(), Some("my-local"));
        assert_eq!(agent.home.as_deref(), Some("/var/work"));
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
            AgentConfig::SshBacked(config) => config,
            AgentConfig::Local(_) => panic!("first entry has no `local = true`"),
        };
        assert_eq!(first.target, "remote-1");

        let second = match &config.agents[1] {
            AgentConfig::Local(config) => config,
            AgentConfig::SshBacked(_) => panic!("second entry has `local = true`"),
        };
        assert_eq!(second.name.as_deref(), Some("local-1"));

        let third = match &config.agents[2] {
            AgentConfig::SshBacked(config) => config,
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

    /// Keeps existing managed-agent configs working after the home rename.
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
            AgentConfig::SshBacked(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be SSH-backed"),
        };
        assert_eq!(
            agent.home.as_deref(),
            Some("/var/www/app"),
            "legacy dir should populate home"
        );
    }

    /// Verifies that a `log` on an ssh entry is accepted and forwarded into
    /// the SshBackedAgentConfig so the operator can capture a remote agent's
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
            AgentConfig::SshBacked(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be SSH-backed"),
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
server = "http://127.0.0.1:3000"
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
            "[agent] server + token should satisfy bare startup without a name"
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

    /// Verifies first startup creates a minimal, parseable demo config and later startups preserve it.
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
        assert!(
            config.agent.is_none(),
            "minimal starter config is server-only; standalone [agent] is not required for demo"
        );

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
                content.contains("# username =") && content.contains("# password ="),
                "Linux starter config should leave username/password commented"
            );
            assert!(
                content.contains("PAM"),
                "Linux starter config should document PAM login"
            );
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(
                server.username.as_deref(),
                Some("redoor"),
                "macOS demo login should use the fixed redoor username"
            );
            assert_eq!(
                server.password.as_deref(),
                Some("changeme"),
                "macOS demo login should use the fixed changeme password"
            );
            assert_eq!(
                bootstrap.password.as_deref(),
                Some("changeme"),
                "bootstrap should report the fixed demo password once"
            );
        }

        assert!(
            server.log.is_none(),
            "starter config should rely on conventional runtime log paths"
        );
        let local_agent = config.agents.iter().find_map(|entry| match entry {
            AgentConfig::Local(config) => Some(config),
            AgentConfig::SshBacked(_) => None,
        });
        let local_agent =
            local_agent.expect("starter config must include a managed local [[agents]] entry");
        assert_eq!(
            local_agent.name.as_deref(),
            Some("local"),
            "demo local agent should use the README name"
        );
        assert!(
            local_agent.log.is_none(),
            "starter managed agents should inherit output unless a log is configured"
        );
        for option in [
            "agent_token =",
            "# port = 3000",
            "# bind = \"0.0.0.0\" # default 127.0.0.1",
            "# cookie_secure = false",
            "local = true",
            "name = \"local\"",
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
server = "https://example.com"
name = "edge"
home = "/var/app"
log = "log/agent.log"
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        let agent = config.agent.expect("[agent] should be present");
        assert_eq!(agent.server.as_deref(), Some("https://example.com"));
        assert_eq!(agent.name.as_deref(), Some("edge"));
        assert_eq!(agent.home.as_deref(), Some("/var/app"));
        assert_eq!(agent.log.as_deref(), Some("log/agent.log"));
    }

    /// Keeps existing agent configs working after the `server` rename.
    #[tokio::test]
    async fn test_parse_config_file_accepts_legacy_ws_address() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-legacy-ws-address-{}.toml",
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
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        let agent = config.agent.as_ref().expect("[agent] should be present");
        // Legacy key maps into the same field so resolve/start paths stay single-keyed.
        assert_eq!(agent.server.as_deref(), Some("wss://example.com/ws"));
        assert!(
            standalone_agent_is_fully_configured(&config),
            "legacy ws_address must still satisfy standalone agent setup checks"
        );
    }

    /// Prevents ambiguous configs that set both the new and legacy server keys.
    #[tokio::test]
    async fn test_parse_config_file_rejects_server_and_ws_address() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-both-server-keys-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"agent_token = "test-agent-token"

[agent]
server = "https://example.com"
ws_address = "wss://example.com/ws"
"#,
        )
        .unwrap();

        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        let error = result
            .expect_err("both server keys must be rejected")
            .to_string();
        assert!(
            error.contains("server") && error.contains("ws_address"),
            "error should name both keys: {error}"
        );
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

    /// Rejects login names that would escape `users/<username>/` before the server starts.
    #[tokio::test]
    async fn test_parse_config_file_rejects_unsafe_username() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-unsafe-username-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"agent_token = "test-agent-token"

[server]
username = "alice/../bob"
password = "test-password"
"#,
        )
        .unwrap();
        let result = parse_config_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();
        assert!(
            result.is_err(),
            "a path-escaping server.username must not parse"
        );
        assert!(
            format!("{:#}", result.unwrap_err())
                .contains("server.username may contain only ASCII letters"),
            "operators should see the allowlist rule rather than a later filesystem error"
        );
    }

    /// Reads the complete named-relay schema into the shared SSH transport model.
    #[tokio::test]
    async fn test_parse_config_file_reads_named_relays() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-relays-test-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            r#"agent_token = "test-agent-token"

[[relays]]
id = "production"
target = "user@example.com"
server = "https://redoor.example.com"
username = "deploy"
ssh_port = 2200
name = "production-agent"
agent_app_name = "redoor-production-agent"
remote_bin = "/opt/redoor"
binary_source = "/tmp/redoor"
home = "/srv/app"
log = "/tmp/relay.log"
insecure = true
"#,
        )
        .unwrap();

        let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();
        let relay = require_relay(&config, "production").unwrap();
        // Identity and connection fields prove lifecycle and transport settings stay associated.
        assert_eq!(relay.id, "production");
        assert_eq!(relay.agent.target, "user@example.com");
        assert_eq!(relay.agent.ssh_port, Some(2200));
        assert!(relay.insecure);
        assert_eq!(
            relay.agent_app_name.as_deref(),
            Some("redoor-production-agent")
        );
        assert_eq!(
            relay.binary_source.as_deref(),
            Some(std::path::Path::new("/tmp/redoor"))
        );
    }

    /// Rejects duplicate or path-like IDs before they can alias one runtime file.
    #[tokio::test]
    async fn test_parse_config_file_rejects_unsafe_and_duplicate_relay_ids() {
        for content in [
            r#"agent_token = "test-agent-token"
[[relays]]
id = "../production"
target = "example.com"
server = "http://redoor.example.com"
"#,
            r#"agent_token = "test-agent-token"
[[relays]]
id = "production"
target = "one.example.com"
server = "http://redoor.example.com"
[[relays]]
id = "production"
target = "two.example.com"
server = "http://redoor.example.com"
"#,
        ] {
            let temp = std::env::temp_dir().join(format!(
                "redoor-invalid-relays-test-{}.toml",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::write(&temp, content).unwrap();
            let result = parse_config_file(temp.to_str().unwrap()).await;
            std::fs::remove_file(&temp).ok();
            // Invalid identities must fail before any process or PID file is created.
            assert!(result.is_err());
        }
    }
}
