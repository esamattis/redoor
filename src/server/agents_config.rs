//! Parses the `--agents agents.toml` file and spawns one agent per
//! `[[agents]]` entry as a background task when the server starts.
//!
//! Each entry is either an ssh-backed agent (default, identified by `target`)
//! or a local agent (`local = true`) that the server launches as a plain
//! `redoor agent` child process without any ssh wrapping. Mixing the two
//! types in one file is supported so a single server can manage remote hosts
//! and a local agent from the same configuration.

use anyhow::{Context, Result, bail};
use redoor::{Level, log};
use std::process::Stdio;
use sysinfo::System;
use tokio::process::Command;
use toml_edit::Document;

use crate::ssh::{SshAgentConfig, start_ssh_agent};

/// Configuration for one local agent, parsed from the agents toml.
///
/// Mirrors the subset of [`crate::ssh::SshAgentConfig`] fields that make
/// sense for an in-process agent: a display name, an optional working
/// directory, and an optional log file. The server reuses its own binary
/// (via `std::env::current_exe`) to start the agent, so no binary path
/// needs to be configured.
#[derive(Debug, Clone)]
pub(crate) struct LocalAgentConfig {
    /// Name the local agent registers with on the server. When `None`,
    /// defaults to the system hostname so multiple local agents on
    /// different machines are naturally distinguishable.
    pub(crate) name: Option<String>,
    /// Working directory the spawned `redoor agent` switches into via
    /// its `-d/--dir` flag, mirroring the operator's `redoor agent -d`.
    pub(crate) dir: Option<String>,
    /// Log file path passed to the spawned `redoor agent` via `--log`.
    /// When `None`, the agent inherits stdio so its logs appear in the
    /// server's terminal.
    pub(crate) log: Option<String>,
}

/// One configured agent entry from the agents toml. The variant decides
/// whether the server spawns an ssh-wrapped agent or a plain local one,
/// so the dispatcher in [`spawn_agents`] can pick the right transport
/// without inspecting the per-variant fields itself.
#[derive(Debug, Clone)]
pub(crate) enum AgentConfig {
    Ssh(SshAgentConfig),
    Local(LocalAgentConfig),
}

/// Reads and validates the agents toml file, returning one [`AgentConfig`]
/// per `[[agents]]` entry. Entries with `local = true` become [`AgentConfig::Local`];
/// all others are parsed as ssh agents and require a `target` field.
///
/// Uses `toml_edit` (instead of the `toml` crate) so future server-side
/// rewriting of the file — for example adding an agent via a REST endpoint —
/// can preserve comments, whitespace and formatting without re-serializing the
/// whole document from scratch. Parsing with the immutable `Document` is
/// enough for the read path; it can be upgraded to `DocumentMut` via
/// `into_mut()` when editing support is added.
pub(crate) async fn parse_agents_file(path: &str) -> Result<Vec<AgentConfig>> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read agents file '{}'", path))?;
    let doc = Document::parse(&content)
        .map_err(|e| anyhow::anyhow!("Failed to parse agents file '{}': {}", path, e))?;

    let agents = doc
        .get("agents")
        .and_then(|item| item.as_array_of_tables())
        .with_context(|| {
            format!(
                "agents file '{}' must contain a [[agents]] array of tables",
                path
            )
        })?;

    if agents.is_empty() {
        bail!("agents file '{}' contains no [[agents]] entries", path);
    }

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
/// local variant so an operator can mirror a working directory across both
/// kinds of agents without duplicating logic.
fn parse_ssh_entry(index: usize, entry: &toml_edit::Table) -> Result<SshAgentConfig> {
    // Reject local-only fields so an operator who confuses the two variants
    // gets a clear error pointing at the specific mis-placed field, instead
    // of silently ignoring it.
    if entry.get("log").and_then(|item| item.as_str()).is_some() {
        bail!(
            "agents entry #{} has 'log' which only applies to local agents (local = true); \
             remove 'log' or set 'local = true'",
            index
        );
    }

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

    Ok(SshAgentConfig {
        username,
        ssh_port,
        name,
        remote_bin,
        dir,
        target,
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
/// name without the operator having to configure it.
fn default_local_agent_name() -> String {
    System::host_name().unwrap_or_else(|| "local".to_string())
}

/// Spawns one tokio task per `[[agents]]` entry. Each task runs the full
/// `redoor ssh` lifecycle (sniff, install, reverse-forward) against the
/// server's `redoor_port`, or — for `local = true` entries — runs a plain
/// `redoor agent` child process that connects to the same server.
///
/// Errors in individual agents are logged but do not abort the server or the
/// other agents, so one unreachable host does not take down the whole fleet.
/// The function returns synchronously (without waiting for the agents to
/// connect) so the server can proceed to `axum::serve` immediately; the
/// agent setup latency would otherwise block the server from accepting
/// connections from agents that are already running.
pub(crate) async fn spawn_agents(path: &str, redoor_port: u16) -> Result<()> {
    let configs = parse_agents_file(path).await?;
    log!(
        Level::Info,
        "Starting {} agent(s) from '{}'",
        configs.len(),
        path
    );
    for config in configs {
        match config {
            AgentConfig::Ssh(config) => {
                // Clone the target/name up front so the task can log which
                // host failed even after `config` has been moved into
                // `start_ssh_agent`.
                let target = config.target.clone();
                let name = config.name.clone();
                tokio::spawn(async move {
                    log!(
                        Level::Info,
                        "Ssh agent task started: target={}, name={:?}",
                        target,
                        name
                    );
                    if let Err(error) = start_ssh_agent(config, redoor_port).await {
                        log!(
                            Level::Error,
                            "Ssh agent failed (target={}): {}",
                            target,
                            error
                        );
                    }
                });
            }
            AgentConfig::Local(config) => {
                let name = config.name.clone();
                tokio::spawn(async move {
                    log!(Level::Info, "Local agent task started: name={:?}", name);
                    if let Err(error) = start_local_agent(config, redoor_port).await {
                        log!(
                            Level::Error,
                            "Local agent failed (name={:?}): {}",
                            name,
                            error
                        );
                    }
                });
            }
        }
    }
    Ok(())
}

/// Spawns `redoor agent` as a local child process and waits for it to exit.
/// Returns an error (rather than calling `process::exit`) so the server can
/// log per-agent failures without taking down the whole process when one
/// local agent crashes or is killed.
///
/// The child reuses the server's own binary (via `std::env::current_exe`),
/// which is always present because the server itself was launched from it.
/// This avoids requiring the operator to keep two binaries in sync or
/// configure a path. Stdio is inherited so agent logs appear in the same
/// terminal as the server logs unless `--log` is set in the toml.
async fn start_local_agent(
    config: LocalAgentConfig,
    redoor_port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let name = config.name.unwrap_or_else(default_local_agent_name);
    let ws_url = format!("ws://localhost:{}/ws", redoor_port);

    let bin = std::env::current_exe()
        .map_err(|e| format!("Failed to determine redoor binary path: {}", e))?;

    let mut command = Command::new(&bin);
    command.arg("agent").arg(&ws_url).arg("--name").arg(&name);

    if let Some(dir) = &config.dir {
        command.arg("-d").arg(dir);
    }
    if let Some(log) = &config.log {
        command.arg("--log").arg(log);
    }

    // Inherit stdio so the local agent's logs appear in the same terminal
    // as the server logs, unless the operator redirected them via `--log`.
    command.stdin(Stdio::inherit());
    command.stdout(Stdio::inherit());
    command.stderr(Stdio::inherit());

    log!(
        Level::Info,
        "Starting local redoor agent: name={}, ws_url={}, bin={}",
        name,
        ws_url,
        bin.display()
    );

    let status = command.status().await?;
    if !status.success() {
        return Err(format!(
            "local agent exited with status {}",
            status.code().unwrap_or(-1)
        )
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that all optional fields fall back to their defaults when
    /// omitted, so a minimal agents file with only a `target` is valid.
    /// `ssh_port` defaults to 22 when missing.
    #[tokio::test]
    async fn test_parse_agents_file_minimal_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\ntarget = \"user@example.com\"\n").unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 1, "exactly one agent entry should be parsed");
        let agent = match &configs[0] {
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
    }

    /// Verifies that every supported field is read from the toml file so
    /// operators can override the defaults per agent.
    #[tokio::test]
    async fn test_parse_agents_file_full_entry() {
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

[[agents]]
target = "web-1"
"#;
        std::fs::write(&temp, content).unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 2, "both entries should be parsed");
        let first = match &configs[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(first.target, "prod-db");
        assert_eq!(first.username.as_deref(), Some("deploy"));
        assert_eq!(first.ssh_port, 2222);
        assert_eq!(first.name.as_deref(), Some("db-agent"));
        assert_eq!(first.remote_bin.as_deref(), Some("/usr/local/bin/redoor"));
        assert_eq!(first.dir.as_deref(), Some("/srv/app"));

        // The second entry only has a target, confirming ssh_port defaults to 22
        // when omitted while the first entry overrides it explicitly.
        let second = match &configs[1] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(second.target, "web-1");
        assert_eq!(second.ssh_port, 22);
    }

    /// Verifies that a missing `agents` key is rejected rather than silently
    /// producing an empty agent list, so the operator notices a typo in the
    /// file structure immediately at server startup.
    #[tokio::test]
    async fn test_parse_agents_file_rejects_missing_agents_key() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-key-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "port = 3000\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "a file without [[agents]] should be rejected"
        );
    }

    /// Verifies that an entry without a `target` is rejected so the parser
    /// fails fast on an incomplete entry instead of producing an agent with
    /// nothing to connect to.
    #[tokio::test]
    async fn test_parse_agents_file_rejects_entry_without_target() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-target-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\nname = \"no-target\"\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap()).await;
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
    async fn test_parse_agents_file_rejects_non_integer_ssh_port() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-type-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            "[[agents]]\ntarget = \"host\"\nssh_port = \"not-a-port\"\n",
        )
        .unwrap();

        let result = parse_agents_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        assert!(result.is_err(), "a non-integer ssh_port should be rejected");
    }

    /// Verifies that an out-of-range `ssh_port` is rejected rather than
    /// silently truncating, so the operator gets a clear error for a typo.
    #[tokio::test]
    async fn test_parse_agents_file_rejects_out_of_range_port() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-port-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\ntarget = \"host\"\nssh_port = 99999\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap()).await;
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
    async fn test_parse_agents_file_minimal_local_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-local-min-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\nlocal = true\n").unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 1, "exactly one agent entry should be parsed");
        let agent = match &configs[0] {
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
    async fn test_parse_agents_file_full_local_entry() {
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
        std::fs::write(&temp, content).unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 1, "exactly one agent entry should be parsed");
        let agent = match &configs[0] {
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
    async fn test_parse_agents_file_mixed_entries() {
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
        std::fs::write(&temp, content).unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 3, "all three entries should be parsed");

        let first = match &configs[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("first entry has no `local = true`"),
        };
        assert_eq!(first.target, "remote-1");

        let second = match &configs[1] {
            AgentConfig::Local(config) => config,
            AgentConfig::Ssh(_) => panic!("second entry has `local = true`"),
        };
        assert_eq!(second.name.as_deref(), Some("local-1"));

        let third = match &configs[2] {
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
    async fn test_parse_agents_file_rejects_local_with_target() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-local-target-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\nlocal = true\ntarget = \"host\"\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap()).await;
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
    async fn test_parse_agents_file_rejects_local_with_ssh_fields() {
        for field in ["username", "ssh_port", "remote_bin"] {
            let temp = std::env::temp_dir().join(format!(
                "redoor-agents-test-local-ssh-{}-{}.toml",
                field,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::write(
                &temp,
                format!("[[agents]]\nlocal = true\n{} = \"x\"\n", field),
            )
            .unwrap();

            let result = parse_agents_file(temp.to_str().unwrap()).await;
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

    /// Verifies that local-only fields on an ssh entry are rejected with a
    /// field-specific error, mirroring the symmetric `local + ssh_field`
    /// test. Catches the case where an operator adds `local = true` to a
    /// previously working ssh entry without removing the ssh-only fields.
    /// `dir` is intentionally absent from this list because it is shared
    /// between both variants (see [`test_parse_agents_file_ssh_entry_with_dir`]).
    #[tokio::test]
    async fn test_parse_agents_file_rejects_ssh_with_log() {
        let field = "log";
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-ssh-local-{}-{}.toml",
            field,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &temp,
            format!("[[agents]]\ntarget = \"host\"\n{} = \"/tmp/x\"\n", field),
        )
        .unwrap();

        let result = parse_agents_file(temp.to_str().unwrap()).await;
        std::fs::remove_file(&temp).ok();

        let error = result.expect_err(&format!("ssh + {} should be rejected", field));
        assert!(
            error.to_string().contains(field),
            "error should mention '{}': {}",
            field,
            error
        );
    }

    /// Verifies that a `dir` on an ssh entry is accepted and forwarded into
    /// the [`SshAgentConfig`] so an operator can pin a remote agent's cwd to
    /// a project tree, mirroring the same option on local agents.
    #[tokio::test]
    async fn test_parse_agents_file_ssh_entry_with_dir() {
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
        std::fs::write(&temp, content).unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).await.unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 1, "exactly one agent entry should be parsed");
        let agent = match &configs[0] {
            AgentConfig::Ssh(config) => config,
            AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
        };
        assert_eq!(
            agent.dir.as_deref(),
            Some("/var/www/app"),
            "dir should be read from the toml entry"
        );
    }
}
