//! Local managed-agent child process launcher.

use super::{LocalAgentConfig, bootstrap::default_local_agent_name};
use crate::log;
use redoor_protocol::wire::log::Level;
use std::process::Stdio;
use tokio::process::Command;

/// How server-managed agents reach this server's own listener.
///
/// Managed agents always connect to `localhost`, directly or through an SSH reverse tunnel, so
/// the certificate of a TLS listener can never match the name they connect with (and a
/// self-signed one is not trusted anyway). They skip certificate verification instead: the
/// traffic never leaves the machine before it enters the tunnel, exactly like the plain
/// `ws://localhost` connection used without TLS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalServerEndpoint {
    /// Listener port of this server.
    pub port: u16,
    /// Whether the listener serves HTTPS, so agents must use `wss://`.
    pub tls: bool,
}

impl LocalServerEndpoint {
    /// Host and port agents put in their URL: the TLS server name and HTTP `Host` they send.
    pub fn authority(&self) -> String {
        format!("localhost:{}", self.port)
    }

    /// Agent WebSocket URL of a local agent, which reaches the listener directly.
    fn agent_ws_url(&self) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!(
            "{scheme}://{}{}",
            self.authority(),
            redoor_protocol::wire::handshake::AGENT_WS_PATH
        )
    }
}

/// Spawns `redoor agent` as a local child process and returns the running
/// [`tokio::process::Child`] so the watchdog supervisor can wait for it or
/// kill it when the WebSocket goes stale.
///
/// The child reuses the server's own binary (via [`crate::executable::current`]),
/// which is always present because the server itself was launched from it, and
/// after `redoor upgrade` is the upgraded file the restarted server will run too.
/// This avoids requiring the operator to keep two binaries in sync or
/// configure a path. Stdio is inherited so agent logs appear in the same
/// terminal as the server logs unless `log` is set in the toml, in which case
/// stdout and stderr are piped for the caller to forward into that file.
///
/// Failures are I/O errors whose message already names the failing step and path, so the
/// watchdog can show them to the browser unchanged.
pub async fn spawn_local_agent(
    config: &LocalAgentConfig,
    app_name: &str,
    server: LocalServerEndpoint,
    agent_token: &str,
) -> std::io::Result<tokio::process::Child> {
    let name = config.name.clone().unwrap_or_else(default_local_agent_name);
    // The server owns managed ids; startup assigned one to every entry before spawning.
    let agent_id = config.id.as_ref().ok_or_else(|| {
        std::io::Error::other(format!(
            "local agent '{name}' has no device id in the config"
        ))
    })?;
    let ws_url = server.agent_ws_url();

    let bin = crate::executable::current()
        .map_err(|e| with_context(e, "Failed to determine redoor binary path"))?;

    let mut command = Command::new(&bin);
    command
        .env_remove(crate::process::DETACHED_ENV)
        .env(crate::process::MANAGED_AGENT_ENV, "1")
        .arg("--app-name")
        .arg(app_name)
        .arg("agent")
        .arg(&ws_url)
        .arg("--log-format")
        .arg("line")
        .arg("--name")
        .arg(&name)
        .arg("--agent-id")
        .arg(agent_id.as_str())
        .arg("--token")
        .arg(agent_token);

    if let Some(home) = &config.home {
        command.arg("--home").arg(home);
    }
    if server.tls {
        command.arg("--insecure-tls");
    }

    command.stdin(Stdio::inherit());

    if config.log.is_some() {
        // Pipe the child's output so the watchdog forwards it into the size-bounded log
        // file. A descriptor inherited straight into the file could not be kept under its
        // limit, and passing --log instead would duplicate every line through stdout.
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
    } else {
        command.stdout(Stdio::inherit());
        command.stderr(Stdio::inherit());
    }

    log!(
        Level::Info,
        "Starting local redoor agent: name={}, agent_id={}, ws_url={}, bin={}, log={:?}",
        name,
        agent_id,
        ws_url,
        bin.display(),
        config.log,
    );

    // Ensure the agent process is killed if the supervisor task is
    // dropped (e.g. on server shutdown), preventing the `redoor agent`
    // child from being orphaned. `kill_on_drop` sends SIGKILL.
    command.kill_on_drop(true);
    command.spawn().map_err(|e| {
        with_context(
            e,
            &format!("failed to spawn local agent binary '{}'", bin.display()),
        )
    })
}

/// Prefixes an I/O error with the failed step while keeping its kind for callers.
fn with_context(error: std::io::Error, context: &str) -> std::io::Error {
    std::io::Error::new(error.kind(), format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::LocalServerEndpoint;

    /// A TLS listener must be reached with `wss://`, or the agent would speak plain HTTP to it.
    #[test]
    fn agent_url_follows_listener_tls() {
        let plain = LocalServerEndpoint {
            port: 7666,
            tls: false,
        };
        let tls = LocalServerEndpoint { tls: true, ..plain };
        // Without TLS the URL is unchanged from before built-in HTTPS existed.
        assert_eq!(plain.agent_ws_url(), "ws://localhost:7666/api/v1/agent/ws");
        // With TLS only the scheme changes; the agent still connects to loopback.
        assert_eq!(tls.agent_ws_url(), "wss://localhost:7666/api/v1/agent/ws");
    }
}
