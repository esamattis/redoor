//! Starts redoor agents on remote hosts and connects them back to the local
//! server through SSH reverse forwarding.
//!
//! # How SSH agent spawning works
//!
//! Preparation and spawning are separate so TOML-managed agents can restart
//! cheaply. Preparation probes the remote operating system and architecture,
//! installs a compatible redoor binary when the operator did not provide one,
//! and stores the settings needed for subsequent launches.
//!
//! Each launch starts `ssh` with a reverse forward shaped like
//! `remote_port:localhost:server_port`. SSH listens on `remote_port` on the
//! remote host and carries traffic back to the redoor server's local port. The
//! remote agent is given `ws://localhost:<remote_port>/ws`, so what looks like
//! a local WebSocket connection to the agent actually reaches the server
//! through that tunnel.
//!
//! The agent token is not included in either process's command-line arguments.
//! The local process writes it as the first line of SSH stdin; a small remote
//! shell preamble reads it, exports it as `REDOOR_AGENT_TOKEN`, and `exec`s the
//! agent so it inherits the secret only through its environment. Remaining
//! stdin is then forwarded normally.
//!
//! Standalone `redoor ssh` uses the requested redoor port on both sides of the
//! tunnel. TOML-managed agents instead select a random dynamic remote port for
//! every watchdog spawn attempt. `ExitOnForwardFailure=yes` makes SSH exit when
//! that port is already occupied, allowing the watchdog to retry with a new
//! random port while reusing the prepared host and binary.

mod provision;
mod transport;

use clap::Args;

use redoor::{Level, log};

use provision::{default_remote_bin, ensure_remote_binary, sniff_remote};
use transport::{SshHost, SshRunOptions};

/// Arguments for `redoor ssh`.
///
/// Mirrors the familiar `ssh` invocation (`-l user -p port user@host`) while
/// adding a redoor port option that controls both the local server port that
/// is forwarded and the remote tunnel port the agent connects to, so callers
/// can override the default 3000 without repeating themselves on both sides
/// of the tunnel.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct SshArgs {
    /// SSH login username. Forwarded to ssh via `-l`. Optional so that
    /// ssh config (`~/.ssh/config`) or the `user@host` target syntax can
    /// supply the username instead.
    #[arg(short = 'l')]
    pub(crate) username: Option<String>,
    /// SSH server port. Forwarded to ssh via `-p`.
    #[arg(short = 'p', default_value_t = 22)]
    pub(crate) ssh_port: u16,
    /// Redoor server port running on the local machine that is forwarded to
    /// the remote host. The agent on the remote host connects to
    /// `ws://localhost:<port>/ws` which tunnels back to the local server.
    #[arg(long, env = "REDOOR_PORT", default_value_t = 3000)]
    pub(crate) redoor_port: u16,
    /// Name the remote agent registers with on the server. Defaults to the
    /// host portion of the ssh target so multiple ssh agents are naturally
    /// distinguishable without requiring an explicit name.
    #[arg(long)]
    pub(crate) name: Option<String>,
    /// Shared secret from top-level `agent_token` so the remote agent can register.
    #[arg(long, env = "REDOOR_AGENT_TOKEN")]
    pub(crate) token: String,
    /// Path to the redoor binary on the remote host. Defaults to the
    /// XDG data layout (`${XDG_DATA_HOME:-$HOME/.local/share}/<app-name>/binaries/<version>/redoor`).
    #[arg(long, env = "REDOOR_REMOTE_BIN")]
    pub(crate) remote_bin: Option<String>,
    /// Default directory the remote agent publishes for UI tab navigation.
    #[arg(short = 'd', long)]
    pub(crate) dir: Option<String>,
    /// Remote ssh target in `user@host` form. Kept positional to mirror the
    /// standard ssh CLI usage so existing muscle memory transfers.
    pub(crate) target: String,
}

/// Derives a default agent name from the ssh target by stripping any
/// `user@` prefix so the name reflects the host being connected to.
pub(crate) fn default_agent_name(target: &str) -> String {
    target.rsplit('@').next().unwrap_or(target).to_string()
}

/// Configuration for one ssh-backed agent, independent of any specific CLI
/// surface so both `redoor ssh` and `redoor server --agents` can construct it
/// without depending on clap.
///
/// `remote_bin` is optional so callers that want the versioned default
/// (`${XDG_DATA_HOME:-$HOME/.local/share}/<app-name>/binaries/<version>/redoor`)
/// don't have to compute it themselves;
/// `start_ssh_agent` fills it in when `None`.
#[derive(Debug, Clone)]
pub(crate) struct SshAgentConfig {
    /// SSH login username. Forwarded to ssh via `-l`. When `None`, ssh config
    /// or the `user@host` target syntax supplies the username.
    pub(crate) username: Option<String>,
    /// SSH server port. Forwarded to ssh via `-p`.
    pub(crate) ssh_port: u16,
    /// Name the remote agent registers with on the server. When `None`,
    /// defaults to the host portion of `target`.
    pub(crate) name: Option<String>,
    /// Path to the redoor binary on the remote host. When `None`, defaults to
    /// the versioned install layout.
    pub(crate) remote_bin: Option<String>,
    /// Default UI directory; when absent the remote launch cwd is published.
    pub(crate) dir: Option<String>,
    /// Remote ssh target in `user@host` form.
    pub(crate) target: String,
    /// Optional local log file path. When set, the ssh process's
    /// stdout/stderr is redirected to this file so the remote agent's
    /// logs (forwarded through ssh) are captured locally. The file is
    /// opened in append mode so agent restarts accumulate logs.
    pub(crate) log: Option<String>,
}

/// Spawns `ssh` with reverse port forwarding and starts a redoor agent on
/// the remote host.
///
/// Reverse port forwarding (`-R`) is used because the redoor server is
/// running on the local machine and the agent is on the remote host. `-R`
/// makes the remote host listen on `<redoor_port>` and tunnel connections
/// back to `localhost:<redoor_port>` on the local machine where the server
/// is listening. The agent then connects to `ws://localhost:<redoor_port>/ws`
/// on the remote host, which reaches the local server through the tunnel.
/// Stdio is inherited so the user can observe agent logs and interact with
/// the remote shell when needed.
pub(crate) async fn run(args: SshArgs) -> Result<(), Box<dyn std::error::Error>> {
    let config = SshAgentConfig {
        username: args.username,
        ssh_port: args.ssh_port,
        name: args.name,
        // Keep None distinct so provisioning knows whether it may manage the default path.
        remote_bin: args.remote_bin,
        dir: args.dir,
        target: args.target,
        log: None,
    };
    start_ssh_agent(config, args.redoor_port, &args.token).await
}

/// Resolved values for one ssh-backed agent: the prepared host and the
/// ssh argv to run. The supervisor uses [`PreparedSshAgent::spawn`] to
/// start a fresh ssh child for every restart cycle without re-sniffing
/// the host or re-uploading the binary.
#[derive(Clone)]
pub(crate) struct PreparedSshAgent {
    host: SshHost,
    /// Agent registration name; used to kill orphaned remote processes that
    /// would otherwise reconnect through a new reverse tunnel and steal this
    /// name from the freshly spawned agent.
    agent_name: String,
    /// Root CLI namespace passed explicitly so the remote process matches the server.
    app_name: String,
    remote_bin: String,
    dir: Option<String>,
    local_port: u16,
    options: SshRunOptions,
    /// Remembers the previous managed tunnel port so a retry after an occupied
    /// port cannot immediately choose the same unusable endpoint again.
    previous_random_port: std::sync::Arc<std::sync::atomic::AtomicU16>,
}

impl PreparedSshAgent {
    /// Spawns the long-running ssh child for this agent. The returned
    /// `Child` is owned by the caller (the supervisor) so it can wait
    /// for normal exit or kill it when the WebSocket goes stale.
    pub(crate) async fn spawn(
        &self,
        remote_port: u16,
    ) -> Result<tokio::process::Child, std::io::Error> {
        let (remote_argv, options) = self.launch_settings(remote_port);
        let argv_refs: Vec<&str> = remote_argv.iter().map(String::as_str).collect();
        self.host
            .spawn(&self.remote_bin, &argv_refs, &options)
            .await
    }

    /// Starts a TOML-managed agent through a fresh random remote port. SSH's
    /// `ExitOnForwardFailure` makes an occupied port terminate this child; the
    /// watchdog then invokes this method again and receives a different port.
    pub(crate) async fn spawn_managed(&self) -> Result<tokio::process::Child, std::io::Error> {
        let previous = self
            .previous_random_port
            .load(std::sync::atomic::Ordering::Relaxed);
        let remote_port = random_remote_port(previous);
        self.previous_random_port
            .store(remote_port, std::sync::atomic::Ordering::Relaxed);
        log!(
            Level::Info,
            "Starting managed SSH tunnel: remote_port={}, local_port={}",
            remote_port,
            self.local_port
        );
        self.spawn(remote_port).await
    }

    /// Builds the matching remote agent argv and reverse-forward options so the
    /// agent always connects to the random port SSH actually requested.
    fn launch_settings(&self, remote_port: u16) -> (Vec<String>, SshRunOptions) {
        let mut remote_argv = vec![
            "--app-name".to_string(),
            self.app_name.clone(),
            "agent".to_string(),
            format!("ws://localhost:{remote_port}/ws"),
            "--name".to_string(),
            self.agent_name.clone(),
        ];
        if let Some(dir) = &self.dir {
            remote_argv.push("-d".to_string());
            remote_argv.push(dir.clone());
        }
        let options = self
            .options
            .clone()
            .with_reverse_forward(remote_port, self.local_port);
        (remote_argv, options)
    }
}

/// Chooses an IANA dynamic/private port and excludes the immediately previous
/// choice so a managed watchdog retry always attempts a new tunnel endpoint.
fn random_remote_port(previous: u16) -> u16 {
    loop {
        let port = fastrand::u16(49152..=65535);
        if port != previous {
            return port;
        }
    }
}

/// One-time setup for an ssh-backed agent: resolves the remote binary
/// path, sniffs the host, installs the binary if missing, and computes
/// the run-time options. After this returns successfully, the binary is
/// in place and the host is ready to run the agent. The supervisor
/// loops [`PreparedSshAgent::spawn`] calls against the returned struct
/// so it doesn't re-sniff / re-upload on every restart.
pub(crate) async fn prepare_ssh_agent(
    config: &SshAgentConfig,
    redoor_port: u16,
    agent_token: &str,
) -> Result<PreparedSshAgent, Box<dyn std::error::Error>> {
    let remote_bin = match config.remote_bin.clone() {
        Some(remote_bin) => remote_bin,
        None => default_remote_bin()?,
    };
    let agent_name = config
        .name
        .clone()
        .unwrap_or_else(|| default_agent_name(&config.target));
    let host = SshHost::new(config.target.clone())
        .username(config.username.clone())
        .ssh_port(config.ssh_port);

    // Sniff the remote host before starting the agent so we can install the
    // redoor binary on first contact. Without this, a fresh remote host
    // would just fail with "command not found" and the user would have to
    // install the binary manually, which defeats the purpose of `redoor ssh`.
    //
    // When the user supplied their own `remote_bin`, we trust it as-is:
    // probing and (re)installing would clobber a binary the operator
    // intentionally placed at that path. Auto-install may redirect debug
    // uploads to the dedicated `debug` path instead of the versioned default.
    let remote_bin = if config.remote_bin.is_none() {
        let sniff = sniff_remote(&host, &remote_bin).await?;
        ensure_remote_binary(&host, &remote_bin, &sniff).await?
    } else {
        remote_bin
    };

    // The reverse forward is added for each spawn because TOML-managed agents
    // choose a fresh remote port on every watchdog attempt.
    let mut options = SshRunOptions::default().with_secret_env("REDOOR_AGENT_TOKEN", agent_token);
    if let Some(log) = &config.log {
        options = options.with_log_file(log);
    }

    log!(
        Level::Info,
        "Prepared redoor agent on remote host: name={}, remote_bin={}, dir={:?}, log={:?}",
        agent_name,
        remote_bin,
        config.dir,
        config.log,
    );

    Ok(PreparedSshAgent {
        host,
        agent_name,
        app_name: crate::app_name::app_name()?,
        remote_bin,
        dir: config.dir.clone(),
        local_port: redoor_port,
        options,
        previous_random_port: std::sync::Arc::new(std::sync::atomic::AtomicU16::new(0)),
    })
}

/// Core implementation shared by `redoor ssh` and `redoor server --agents`:
/// probes the remote host, installs the redoor binary if missing, then runs
/// a redoor agent on the remote host with a reverse port forward back to
/// `redoor_port` on the local machine. The function blocks until the ssh
/// process exits.
///
/// Returns an error (rather than calling `process::exit`) so the server can
/// log per-agent failures without taking down the whole process when one
/// host is unreachable.
pub(crate) async fn start_ssh_agent(
    config: SshAgentConfig,
    redoor_port: u16,
    agent_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let prepared = prepare_ssh_agent(&config, redoor_port, agent_token).await?;
    let mut child = prepared.spawn(redoor_port).await?;
    let status = child.wait().await?;
    if !status.success() {
        return Err(format!(
            "ssh agent exited with status {}",
            status.code().unwrap_or(-1)
        )
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::random_remote_port;

    /// Verifies managed tunnel ports stay in the dynamic/private range and a
    /// retry cannot repeat the port that just failed to bind.
    #[test]
    fn random_remote_port_uses_new_dynamic_port() {
        let first = random_remote_port(0);
        let second = random_remote_port(first);

        // Dynamic ports avoid commonly configured services on the remote host.
        assert!((49152..=65535).contains(&first));
        // A failed forward must retry with a genuinely new remote endpoint.
        assert_ne!(second, first);
        // Every retry must remain inside the dynamic/private range.
        assert!((49152..=65535).contains(&second));
    }
}
