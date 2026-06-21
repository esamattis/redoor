//! Parses the `--agents agents.toml` file and spawns one ssh-backed agent
//! per `[[agents]]` entry as a background task when the server starts.
//!
//! This lets a redoor server automatically bring up a fleet of ssh agents on
//! startup instead of requiring the operator to run one `redoor ssh` command
//! per host in separate terminals.

use anyhow::{Context, Result, bail};
use redoor::{Level, log};
use toml_edit::Document;

use crate::ssh::{SshAgentConfig, start_ssh_agent};

/// Reads and validates the agents toml file, returning one [`SshAgentConfig`]
/// per `[[agents]]` entry.
///
/// Uses `toml_edit` (instead of the `toml` crate) so future server-side
/// rewriting of the file — for example adding an agent via a REST endpoint —
/// can preserve comments, whitespace and formatting without re-serializing the
/// whole document from scratch. Parsing with the immutable `Document` is
/// enough for the read path; it can be upgraded to `DocumentMut` via
/// `into_mut()` when editing support is added.
pub(crate) fn parse_agents_file(path: &str) -> Result<Vec<SshAgentConfig>> {
    let content = std::fs::read_to_string(path)
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
        // `target` is the only required field: without a host there is nothing
        // to ssh to. All other fields are explicit per-entry settings that the
        // operator must declare so a missing field is surfaced as an error
        // rather than silently falling back to a default the operator may not
        // have intended.
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

        configs.push(SshAgentConfig {
            username,
            ssh_port,
            name,
            remote_bin,
            target,
        });
    }
    Ok(configs)
}

/// Spawns one tokio task per `[[agents]]` entry. Each task runs the full
/// `redoor ssh` lifecycle (sniff, install, reverse-forward) against the
/// server's `redoor_port`.
///
/// Errors in individual agents are logged but do not abort the server or the
/// other agents, so one unreachable host does not take down the whole fleet.
/// The function returns synchronously (without waiting for the ssh agents to
/// connect) so the server can proceed to `axum::serve` immediately; the ssh
/// setup latency would otherwise block the server from accepting connections
/// from agents that are already running.
pub(crate) async fn spawn_ssh_agents(path: &str, redoor_port: u16) -> Result<()> {
    let configs = parse_agents_file(path)?;
    log!(
        Level::Info,
        "Starting {} ssh agent(s) from '{}'",
        configs.len(),
        path
    );
    for config in configs {
        // Clone the target/name up front so the task can log which host failed
        // even after `config` has been moved into `start_ssh_agent`.
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that all optional fields fall back to their defaults when
    /// omitted, so a minimal agents file with only a `target` is valid.
    /// `ssh_port` defaults to 22 when missing.
    #[test]
    fn test_parse_agents_file_minimal_entry() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\ntarget = \"user@example.com\"\n").unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 1, "exactly one agent entry should be parsed");
        let agent = &configs[0];
        assert_eq!(agent.target, "user@example.com");
        // ssh_port defaults to 22 when not specified, matching `redoor ssh`.
        assert_eq!(agent.ssh_port, 22);
        // username, name and remote_bin are None so start_ssh_agent can derive them.
        assert!(agent.username.is_none());
        assert!(agent.name.is_none());
        assert!(agent.remote_bin.is_none());
    }

    /// Verifies that every supported field is read from the toml file so
    /// operators can override the defaults per agent.
    #[test]
    fn test_parse_agents_file_full_entry() {
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

[[agents]]
target = "web-1"
"#;
        std::fs::write(&temp, content).unwrap();

        let configs = parse_agents_file(temp.to_str().unwrap()).unwrap();
        std::fs::remove_file(&temp).ok();

        assert_eq!(configs.len(), 2, "both entries should be parsed");
        let first = &configs[0];
        assert_eq!(first.target, "prod-db");
        assert_eq!(first.username.as_deref(), Some("deploy"));
        assert_eq!(first.ssh_port, 2222);
        assert_eq!(first.name.as_deref(), Some("db-agent"));
        assert_eq!(first.remote_bin.as_deref(), Some("/usr/local/bin/redoor"));

        // The second entry only has a target, confirming ssh_port defaults to 22
        // when omitted while the first entry overrides it explicitly.
        let second = &configs[1];
        assert_eq!(second.target, "web-1");
        assert_eq!(second.ssh_port, 22);
    }

    /// Verifies that a missing `agents` key is rejected rather than silently
    /// producing an empty agent list, so the operator notices a typo in the
    /// file structure immediately at server startup.
    #[test]
    fn test_parse_agents_file_rejects_missing_agents_key() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-key-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "port = 3000\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap());
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "a file without [[agents]] should be rejected"
        );
    }

    /// Verifies that an entry without a `target` is rejected so the parser
    /// fails fast on an incomplete entry instead of producing an agent with
    /// nothing to connect to.
    #[test]
    fn test_parse_agents_file_rejects_entry_without_target() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-no-target-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\nname = \"no-target\"\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap());
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "an entry without a target should be rejected"
        );
    }

    /// Verifies that a present-but-non-integer `ssh_port` is rejected rather
    /// than silently falling back to 22, so a typo like a string value is
    /// surfaced as an explicit operator error.
    #[test]
    fn test_parse_agents_file_rejects_non_integer_ssh_port() {
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

        let result = parse_agents_file(temp.to_str().unwrap());
        std::fs::remove_file(&temp).ok();

        assert!(result.is_err(), "a non-integer ssh_port should be rejected");
    }

    /// Verifies that an out-of-range `ssh_port` is rejected rather than
    /// silently truncating, so the operator gets a clear error for a typo.
    #[test]
    fn test_parse_agents_file_rejects_out_of_range_port() {
        let temp = std::env::temp_dir().join(format!(
            "redoor-agents-test-bad-port-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "[[agents]]\ntarget = \"host\"\nssh_port = 99999\n").unwrap();

        let result = parse_agents_file(temp.to_str().unwrap());
        std::fs::remove_file(&temp).ok();

        assert!(
            result.is_err(),
            "an out-of-range ssh_port should be rejected"
        );
    }
}
