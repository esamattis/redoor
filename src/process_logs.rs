//! Prints configured server and standalone-agent log files without buffering them.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use tokio::process::Command;

/// Process role whose configured file log should be displayed.
#[derive(Clone, Copy)]
pub(crate) enum LogRole {
    /// Resolve the log from `REDOOR_SERVER_LOG` or `[server].log`.
    Server,
    /// Resolve the log from `REDOOR_AGENT_LOG` or `[agent].log`.
    Agent,
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
        None => crate::server::default_config_path()?,
    };
    let parsed = crate::server::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config file '{}'", config_path.display()))?;
    let configured = match role {
        LogRole::Server => parsed.server.and_then(|section| section.log),
        LogRole::Agent => parsed.agent.and_then(|section| section.log),
    };
    configured.with_context(|| {
        let section = match role {
            LogRole::Server => "[server].log or REDOOR_SERVER_LOG",
            LogRole::Agent => "[agent].log or REDOOR_AGENT_LOG",
        };
        format!(
            "No log file is configured for this process; set {section} (config: '{}')",
            config_path.display()
        )
    })
}
