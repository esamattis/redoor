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
//! `remote_port:destination_host:destination_port`. SSH listens on
//! `remote_port` on the remote host and asks the local SSH client to connect to
//! the destination. Managed agents use the local redoor server, while
//! standalone `redoor ssh --route host:port` uses a server reachable from the
//! machine running the command. The remote agent is given
//! `ws://localhost:<remote_port>/ws`, so what looks like a local WebSocket
//! connection to the agent actually reaches the server through that tunnel.
//!
//! The agent token is not included in either process's command-line arguments.
//! The local process writes it as the first line of SSH stdin; a small remote
//! shell preamble reads it, exports it as `REDOOR_AGENT_TOKEN`, and `exec`s the
//! agent so it inherits the secret only through its environment. Remaining
//! stdin is then forwarded normally.
//!
//! Both standalone and TOML-managed launches select a random dynamic remote
//! port for each SSH spawn attempt. `ExitOnForwardFailure=yes` makes SSH exit
//! when that port is already occupied. Managed agents let the watchdog retry;
//! standalone launches detect that specific bind failure and retry locally
//! without supervising an agent after it has started.

mod provision;
mod transport;

use std::str::FromStr;

use clap::Args;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use redoor::{Level, log};

use provision::{default_remote_bin, ensure_remote_binary, sniff_remote};
use transport::{SshHost, SshRunOptions};

/// Starts a redoor agent on an SSH host that cannot reach the redoor server
/// directly, routing its plain WebSocket connection through this machine.
///
/// The machine running this command must be able to reach both the SSH target
/// and `--route`. Redoor provisions the agent binary on the SSH target, opens a
/// reverse tunnel from a random dynamic port there to `HOST:PORT` here, and
/// keeps the SSH session attached until it exits.
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
    /// Redoor server destination reached from the machine running this command,
    /// formatted as `HOST:PORT` or `[IPv6]:PORT`. A random dynamic port on the
    /// SSH target forwards to this destination. Only plain WebSocket backends
    /// are supported; do not include a `ws://` scheme.
    #[arg(long)]
    pub(crate) route: SshRoute,
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

/// Host and port reached from the local SSH client for a standalone route.
/// Keeping this separate from the SSH target avoids implying that the remote
/// Linux host must be able to resolve or connect to the redoor server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SshRoute {
    /// Destination hostname or IP address, stored without IPv6 brackets.
    host: String,
    /// Destination port where the plain redoor WebSocket server is listening.
    port: u16,
}

impl FromStr for SshRoute {
    type Err = String;

    /// Parses a route while requiring brackets around IPv6 addresses so the
    /// final port separator remains unambiguous to both Clap and OpenSSH.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.contains("://") {
            return Err("route must be HOST:PORT without a ws:// scheme".to_string());
        }
        let (host, port) = if let Some(bracketed) = value.strip_prefix('[') {
            bracketed
                .split_once("]:")
                .ok_or_else(|| "IPv6 route must use [ADDRESS]:PORT".to_string())?
        } else {
            let (host, port) = value
                .rsplit_once(':')
                .ok_or_else(|| "route must use HOST:PORT".to_string())?;
            if host.contains(':') {
                return Err("IPv6 route must use [ADDRESS]:PORT".to_string());
            }
            (host, port)
        };
        if host.is_empty() || host.chars().any(char::is_whitespace) {
            return Err("route host must not be empty or contain whitespace".to_string());
        }
        let port = port
            .parse::<u16>()
            .map_err(|_| "route port must be an integer from 1 to 65535".to_string())?;
        if port == 0 {
            return Err("route port must be an integer from 1 to 65535".to_string());
        }
        Ok(Self {
            host: host.to_string(),
            port,
        })
    }
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
/// Reverse port forwarding (`-R`) makes the SSH target listen on a random
/// dynamic port and asks the local SSH client to connect to `--route`. The
/// agent uses `ws://localhost:<random-port>/ws` on the SSH target, so it does
/// not need direct network access to the routed server. Stdio is inherited so
/// the user can observe agent logs while this command owns the SSH session.
pub(crate) async fn run(args: SshArgs) -> Result<(), Box<dyn std::error::Error>> {
    let route = args.route;
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
    start_ssh_agent(config, route, &args.token).await
}

/// Remembers the last random remote port so every retry necessarily chooses a
/// different candidate while sharing the same policy across launcher types.
#[derive(Clone, Default)]
struct RandomRemotePort {
    /// Atomic state keeps cloned prepared agents coordinated across spawn calls.
    previous: std::sync::Arc<std::sync::atomic::AtomicU16>,
}

impl RandomRemotePort {
    /// Chooses the next IANA dynamic/private port and records it for the retry.
    fn next(&self) -> u16 {
        let previous = self.previous.load(std::sync::atomic::Ordering::Relaxed);
        let port = random_remote_port(previous);
        self.previous
            .store(port, std::sync::atomic::Ordering::Relaxed);
        port
    }
}

/// Resolved values for one ssh-backed agent: the prepared host and the
/// ssh argv to run. Launchers use the shared random spawn method to start a
/// fresh child without re-sniffing the host or re-uploading the binary.
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
    /// Destination host reached from the machine running the SSH client.
    destination_host: String,
    /// Destination server port reached from the machine running the SSH client.
    destination_port: u16,
    options: SshRunOptions,
    /// Shares random-port selection between standalone and managed launches.
    random_remote_port: RandomRemotePort,
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

    /// Starts an agent through a fresh random remote port and returns both the
    /// selected port and child so each launcher can apply its lifecycle policy.
    async fn spawn_random(&self) -> Result<(u16, tokio::process::Child), std::io::Error> {
        let remote_port = self.random_remote_port.next();
        log!(
            Level::Info,
            "Starting SSH tunnel: remote_port={}, destination={}:{}",
            remote_port,
            self.destination_host,
            self.destination_port
        );
        let child = self.spawn(remote_port).await?;
        Ok((remote_port, child))
    }

    /// Starts a TOML-managed agent with the shared random-port policy while
    /// leaving retries and stale-session handling to the server watchdog.
    pub(crate) async fn spawn_managed(&self) -> Result<tokio::process::Child, std::io::Error> {
        let (_, child) = self.spawn_random().await?;
        Ok(child)
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
        let options = self.options.clone().with_reverse_forward(
            remote_port,
            self.destination_host.clone(),
            self.destination_port,
        );
        (remote_argv, options)
    }
}

/// Chooses an IANA dynamic/private port and excludes the immediately previous
/// choice so every managed or standalone retry uses a new tunnel endpoint.
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
    prepare_ssh_agent_for_destination(
        config,
        "localhost".to_string(),
        redoor_port,
        agent_token,
        false,
    )
    .await
}

/// Prepares an SSH agent whose reverse tunnel terminates at a destination
/// reached from the local SSH client rather than necessarily at localhost.
async fn prepare_ssh_agent_for_destination(
    config: &SshAgentConfig,
    destination_host: String,
    destination_port: u16,
    agent_token: &str,
    monitor_forward_failure: bool,
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

    // The reverse forward is added for each spawn because both standalone and
    // TOML-managed launches choose a fresh remote port for every attempt.
    let mut options = SshRunOptions::default().with_secret_env("REDOOR_AGENT_TOKEN", agent_token);
    if let Some(log) = &config.log {
        options = options.with_log_file(log);
    }
    if monitor_forward_failure {
        options = options.with_piped_stderr();
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
        destination_host,
        destination_port,
        options,
        random_remote_port: RandomRemotePort::default(),
    })
}

/// Number of random ports a standalone launch tries before surfacing a remote
/// bind failure instead of risking an unbounded startup loop.
const STANDALONE_FORWARD_BIND_ATTEMPTS: usize = 10;

/// Stable fragment emitted by OpenSSH when `ExitOnForwardFailure` rejects a
/// remote listener, independent of the particular port that was occupied.
const REMOTE_FORWARD_FAILURE_MESSAGE: &[u8] = b"remote port forwarding failed for listen port";

/// Incrementally detects OpenSSH's forwarding failure across fixed-size stderr
/// chunks without retaining an unbounded agent log line in memory.
#[derive(Default)]
struct ForwardFailureDetector {
    /// Keeps only enough bytes to detect a message split between two chunks.
    tail: Vec<u8>,
}

impl ForwardFailureDetector {
    /// Observes one stderr chunk and reports whether it completes the known
    /// OpenSSH failure phrase, comparing ASCII output case-insensitively.
    fn observe(&mut self, chunk: &[u8]) -> bool {
        let mut searchable = Vec::with_capacity(self.tail.len() + chunk.len());
        searchable.extend_from_slice(&self.tail);
        searchable.extend_from_slice(chunk);
        searchable.make_ascii_lowercase();
        let found = searchable
            .windows(REMOTE_FORWARD_FAILURE_MESSAGE.len())
            .any(|window| window == REMOTE_FORWARD_FAILURE_MESSAGE);
        let retained = REMOTE_FORWARD_FAILURE_MESSAGE
            .len()
            .saturating_sub(1)
            .min(searchable.len());
        self.tail.clear();
        self.tail
            .extend_from_slice(&searchable[searchable.len() - retained..]);
        found
    }
}

/// Copies piped SSH stderr to the standalone command's terminal while sending
/// whether OpenSSH reported that its random remote listener could not bind.
fn monitor_forward_failure<R>(mut input: R) -> tokio::sync::oneshot::Receiver<bool>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut sender = Some(sender);
        let mut detector = ForwardFailureDetector::default();
        let mut output = tokio::io::stderr();
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match input.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = &buffer[..read];
                    let _ = output.write_all(chunk).await;
                    if sender.is_some() && detector.observe(chunk) {
                        let _ = sender.take().expect("sender checked above").send(true);
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(sender) = sender {
            let _ = sender.send(false);
        }
    });
    receiver
}

/// Runs one standalone random-port attempt to completion and distinguishes an
/// initial OpenSSH bind failure from the eventual exit of a started agent.
async fn run_standalone_attempt(
    prepared: &PreparedSshAgent,
) -> Result<(u16, std::process::ExitStatus, bool), Box<dyn std::error::Error>> {
    let (remote_port, mut child) = prepared.spawn_random().await?;
    let stderr = child.stderr.take().ok_or_else(|| {
        std::io::Error::other("standalone SSH stderr was not piped for forward monitoring")
    })?;
    let forward_failed = monitor_forward_failure(stderr).await.unwrap_or(false);
    let status = child.wait().await?;
    Ok((remote_port, status, forward_failed))
}

/// Retries only random remote-listener collisions; once SSH starts without
/// that error, its eventual exit is returned directly instead of being watched.
async fn run_standalone_random(
    prepared: &PreparedSshAgent,
) -> Result<(), Box<dyn std::error::Error>> {
    for attempt in 1..=STANDALONE_FORWARD_BIND_ATTEMPTS {
        let (remote_port, status, forward_failed) = run_standalone_attempt(prepared).await?;
        if !forward_failed {
            return ssh_exit_result(status);
        }
        if attempt == STANDALONE_FORWARD_BIND_ATTEMPTS {
            return Err(format!(
                "ssh could not bind a random remote port after {} attempts; last port was {}",
                STANDALONE_FORWARD_BIND_ATTEMPTS, remote_port
            )
            .into());
        }
        log!(
            Level::Warning,
            "SSH remote port was occupied, retrying: remote_port={}, attempt={}/{}",
            remote_port,
            attempt,
            STANDALONE_FORWARD_BIND_ATTEMPTS
        );
    }
    unreachable!("standalone SSH retry loop always returns");
}

/// Converts the final SSH status into the command's existing success/error
/// contract without applying any restart behavior after a successful bind.
fn ssh_exit_result(status: std::process::ExitStatus) -> Result<(), Box<dyn std::error::Error>> {
    if !status.success() {
        return Err(format!(
            "ssh agent exited with status {}",
            status.code().unwrap_or(-1)
        )
        .into());
    }
    Ok(())
}

/// Standalone implementation for `redoor ssh`: probes the remote host,
/// installs the redoor binary if missing, then runs an agent through a reverse
/// forward to the requested destination. It retries occupied random listener
/// ports but intentionally does not supervise or restart a started agent.
///
/// Returns an error rather than exiting directly so the CLI boundary remains
/// responsible for presenting the failure and choosing the process status.
pub(crate) async fn start_ssh_agent(
    config: SshAgentConfig,
    route: SshRoute,
    agent_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let prepared =
        prepare_ssh_agent_for_destination(&config, route.host, route.port, agent_token, true)
            .await?;
    run_standalone_random(&prepared).await
}

#[cfg(test)]
mod tests {
    use super::random_remote_port;

    /// Verifies forwarding failures are recognized even when the fixed-size
    /// stderr reader splits OpenSSH's message across chunks.
    #[test]
    fn detects_split_remote_forward_failure() {
        let mut detector = super::ForwardFailureDetector::default();

        // A partial phrase must not trigger a retry before OpenSSH reports the failure.
        assert!(!detector.observe(b"Warning: remote port forward"));
        // Completing the phrase across the next chunk must identify the occupied port.
        assert!(detector.observe(b"ing failed for listen port 52000\n"));
    }

    /// Verifies cloned prepared-agent state cannot immediately reuse the port
    /// selected by another launcher attempt.
    #[test]
    fn random_port_state_is_shared_across_clones() {
        let ports = super::RandomRemotePort::default();
        let cloned = ports.clone();
        let first = ports.next();
        let second = cloned.next();

        // Shared retry state must force the next attempt onto a different endpoint.
        assert_ne!(first, second);
        // Both launcher types must stay inside the IANA dynamic/private range.
        assert!((49152..=65535).contains(&second));
    }

    /// Verifies DNS routes preserve the destination independently of the port
    /// exposed to the agent on the SSH target.
    #[test]
    fn parses_hostname_route() {
        let route = "redoor.example:4000"
            .parse::<super::SshRoute>()
            .expect("hostname route should parse");

        // The SSH client must resolve the exact host supplied by the operator.
        assert_eq!(route.host, "redoor.example");
        // The destination port may differ from the remote listener port.
        assert_eq!(route.port, 4000);
    }

    /// Verifies bracketed IPv6 routes are accepted without retaining syntax
    /// brackets in the destination model.
    #[test]
    fn parses_bracketed_ipv6_route() {
        let route = "[2001:db8::10]:4000"
            .parse::<super::SshRoute>()
            .expect("bracketed IPv6 route should parse");

        // Transport formatting adds brackets itself, so the model stores only the address.
        assert_eq!(route.host, "2001:db8::10");
        // IPv6 routes use the same validated destination-port representation.
        assert_eq!(route.port, 4000);
    }

    /// Verifies routes reject URL syntax because this mode deliberately
    /// supports only a plain WebSocket destination rather than WSS URLs.
    #[test]
    fn rejects_route_with_websocket_scheme() {
        let error = "ws://redoor.example:4000"
            .parse::<super::SshRoute>()
            .expect_err("route URL should be rejected");

        // A focused error keeps users from assuming URL schemes are supported.
        assert!(error.contains("without a ws:// scheme"));
    }

    /// Verifies raw IPv6 is rejected so the destination port cannot be parsed
    /// ambiguously from an address containing multiple colons.
    #[test]
    fn rejects_unbracketed_ipv6_route() {
        let error = "2001:db8::10:4000"
            .parse::<super::SshRoute>()
            .expect_err("unbracketed IPv6 route should be rejected");

        // The correction tells operators exactly how to make the route unambiguous.
        assert!(error.contains("[ADDRESS]:PORT"));
    }

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
