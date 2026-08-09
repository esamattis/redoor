//! Local managed-agent child process launcher.

use super::{LocalAgentConfig, bootstrap::default_local_agent_name};
use redoor::{Level, log};
use std::{path::Path, process::Stdio};
use tokio::process::Command;

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
        .arg("--app-name")
        .arg(crate::app_name::app_name()?)
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
        let log_path = Path::new(log);
        if let Some(parent) = log_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                format!(
                    "failed to create local agent log directory '{}': {}",
                    parent.display(),
                    e
                )
            })?;
        }
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .await
            .map_err(|e| format!("failed to open local agent log file '{}': {}", log, e))?;
        let file_for_stderr = file.try_clone().await.map_err(|e| {
            format!(
                "failed to clone local agent log file handle '{}': {}",
                log, e
            )
        })?;
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
    let child = command.spawn().map_err(|e| {
        format!(
            "failed to spawn local agent binary '{}': {}",
            bin.display(),
            e
        )
    })?;
    Ok(child)
}
