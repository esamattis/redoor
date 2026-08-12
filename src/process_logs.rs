//! Prints configured server, standalone-agent, and relay log files without buffering them.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use tokio::process::Command;

use crate::process_control::ProcessSlot;

/// Process role whose configured file log should be displayed.
#[derive(Clone, Copy)]
pub(crate) enum LogRole {
    /// Resolve the log from `REDOOR_SERVER_LOG` or `[server].log`.
    Server,
    /// Resolve the log from `REDOOR_AGENT_LOG` or `[agent].log`.
    Agent,
}

impl LogRole {
    /// Maps log display to the shared process-slot identity for default paths.
    fn process_slot(self) -> ProcessSlot {
        match self {
            Self::Server => ProcessSlot::Server,
            Self::Agent => ProcessSlot::Agent,
        }
    }
}

/// Resolves the configured path and streams its last lines through the platform `tail` tool.
pub(crate) async fn run(
    role: LogRole,
    config: Option<String>,
    explicit_log: Option<String>,
    lines: usize,
) -> Result<()> {
    let log_path = match explicit_log.filter(|path| !path.trim().is_empty()) {
        Some(path) => path,
        None => configured_log_path(role, config).await?,
    };

    let status = Command::new("tail")
        .arg("-n")
        .arg(lines.to_string())
        .arg(&log_path)
        .status()
        .await
        .with_context(|| format!("Failed to print log file '{log_path}' with tail"))?;
    if status.success() {
        Ok(())
    } else {
        bail!("tail failed for log file '{log_path}' with {status}")
    }
}

/// Loads the conventional or explicit TOML and returns the selected role's log path.
async fn configured_log_path(role: LogRole, config: Option<String>) -> Result<String> {
    let config_path = match config {
        Some(path) => PathBuf::from(path),
        None => crate::config::default_config_path()?,
    };
    let parsed = crate::config::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config file '{}'", config_path.display()))?;
    let configured = match role {
        LogRole::Server => parsed.server.and_then(|section| section.log),
        LogRole::Agent => parsed.agent.and_then(|section| section.log),
    };
    match configured {
        Some(path) if !path.trim().is_empty() => Ok(path),
        _ => crate::config::default_process_log_path(role.process_slot()),
    }
}

/// Streams one named relay log, preferring immutable runtime metadata over mutable TOML.
pub(crate) async fn run_relay(id: &str, config: Option<String>, lines: usize) -> Result<()> {
    let pid_path = crate::process_control::relay_pid_path(id)?;
    let log = match crate::process_control::read_relay_metadata(&pid_path).await {
        Some(metadata) => metadata.log,
        None => {
            let config_path = match config {
                Some(path) => PathBuf::from(path),
                None => crate::config::default_config_path()?,
            };
            let parsed = crate::config::parse_config_file(&config_path.to_string_lossy()).await?;
            let relay = crate::config::require_relay(&parsed, id)?;
            match relay.agent.log.clone() {
                Some(log) => log,
                None => crate::config::default_relay_log_path(id)?,
            }
        }
    };
    let status = Command::new("tail")
        .arg("-n")
        .arg(lines.to_string())
        .arg(&log)
        .status()
        .await
        .with_context(|| format!("Failed to print log file '{log}' with tail"))?;
    if status.success() {
        Ok(())
    } else {
        bail!("tail failed for log file '{log}' with {status}")
    }
}
