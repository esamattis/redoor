//! Starts redoor agents on remote hosts and connects them back to the local
//! server through SSH reverse forwarding.
//!
//! # How SSH-backed agent spawning works
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
//! a named standalone relay uses a server reachable from the
//! machine running the command. The remote agent is given
//! `ws://localhost:<remote_port>/ws`, so what looks like a local WebSocket
//! connection to the agent actually reaches the server through that tunnel.
//! Standalone WSS routes retain the real server authority for TLS and HTTP but
//! open their TCP connections through the same random localhost tunnel port.
//!
//! The agent token is not included in either process's command-line arguments.
//! The local process writes it as the first line of SSH stdin; a small remote
//! shell preamble reads it, exports it as `REDOOR_AGENT_TOKEN`, and `exec`s the
//! agent so it inherits the secret only through its environment. Remaining
//! stdin is then forwarded normally.
//!
//! Optional `password` values are delivered through OpenSSH `SSH_ASKPASS` by
//! re-executing this binary. That keeps the secret off argv and off the SSH
//! stdin already used for tokens, sniff scripts, and uploads.
//!
//! Both standalone and TOML-managed launches select a random dynamic remote
//! port for each SSH spawn attempt. `ExitOnForwardFailure=yes` makes SSH exit
//! when that port is already occupied. Managed agents let the watchdog retry;
//! standalone launches detect that specific bind failure and retry locally
//! without supervising an agent after it has started.

pub(crate) mod askpass;
mod provision;
mod transport;

use std::path::PathBuf;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use redoor::{Level, log};

use crate::server_address::ServerAddress;
use provision::{default_remote_bin, ensure_remote_binary, sniff_remote};
use redoor::watchdog::ProvisioningStatusSink;
use transport::{SshHost, SshRunOptions};

/// Derives a default agent name from the ssh target by stripping any
/// `user@` prefix so the name reflects the host being connected to.
pub(crate) fn default_agent_name(target: &str) -> String {
    target.rsplit('@').next().unwrap_or(target).to_string()
}

/// Configuration for one SSH-backed agent, independent of any specific CLI
/// surface so both `redoor agent relay` and `redoor server --agents` can construct it
/// without depending on clap.
///
/// `remote_bin` is optional so callers that want the versioned default
/// (`${XDG_DATA_HOME:-$HOME/.local/share}/<app-name>/binaries/<version>/redoor`)
/// don't have to compute it themselves;
/// `start_relay` fills it in when `None`.
#[derive(Clone)]
pub(crate) struct SshBackedAgentConfig {
    /// SSH login username. Forwarded to ssh via `-l`. When `None`, ssh config
    /// or the `user@host` target syntax supplies the username.
    pub(crate) username: Option<String>,
    /// SSH server port override. `None` preserves the port resolved by OpenSSH
    /// from its host configuration or built-in default.
    pub(crate) ssh_port: Option<u16>,
    /// Name the remote agent registers with on the server. When `None`,
    /// defaults to the host portion of `target`.
    pub(crate) name: Option<String>,
    /// Path to the redoor binary on the remote host. When `None`, defaults to
    /// the versioned install layout.
    pub(crate) remote_bin: Option<String>,
    /// Default UI home directory; when absent the remote process user's home is published.
    pub(crate) home: Option<String>,
    /// Remote ssh target in `user@host` form.
    pub(crate) target: String,
    /// Optional local log file path. When set, the ssh process's
    /// stdout/stderr is redirected to this file so the remote agent's
    /// logs (forwarded through ssh) are captured locally. The file is
    /// opened in append mode so agent restarts accumulate logs.
    pub(crate) log: Option<String>,
    /// Optional SSH login password. When set, OpenSSH is given `SSH_ASKPASS`
    /// pointing at this binary so password auth can run without a TTY or
    /// stealing the stdin used for tokens and uploads.
    pub(crate) password: Option<String>,
}

impl std::fmt::Debug for SshBackedAgentConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshBackedAgentConfig")
            .field("username", &self.username)
            .field("ssh_port", &self.ssh_port)
            .field("name", &self.name)
            .field("remote_bin", &self.remote_bin)
            .field("home", &self.home)
            .field("target", &self.target)
            .field("log", &self.log)
            .field("password", &self.password.as_ref().map(|_| "***"))
            .finish()
    }
}

/// Spawns `ssh` with reverse port forwarding and starts a redoor agent on
/// the remote host.
///
/// Reverse port forwarding (`-R`) makes the SSH target listen on a random
/// dynamic port and asks the local SSH client to connect to `--server`. Plain
/// routes use the tunnel URL directly. WSS routes connect TCP through that same
/// tunnel while retaining the route hostname for TLS and HTTP. Stdio is
/// inherited so the user can observe agent logs while this command owns the SSH session.
pub(crate) async fn run_relay(
    relay: crate::config::RelayConfig,
    token: String,
    agent_app_name: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let server = relay.server.parse::<ServerAddress>()?;
    if relay.insecure && !server.is_secure() {
        return Err("relay insecure = true requires an https:// or wss:// server URL".into());
    }
    if relay.insecure {
        eprintln!(
            "WARNING: relay insecure = true disables TLS certificate verification for the routed server"
        );
    }
    let log = relay
        .agent
        .log
        .clone()
        .expect("relay startup resolves a log path");
    redoor::logging::init(Some(log.clone())).await?;
    start_relay(
        relay.agent,
        server,
        &token,
        relay.insecure,
        relay.binary_source,
        agent_app_name,
    )
    .await
}

/// Remembers the last random remote port so every retry necessarily chooses a
/// different candidate while sharing the same policy across launcher types.
#[derive(Clone, Default)]
struct RandomRemotePort {
    /// Atomic state keeps cloned prepared agents coordinated across spawn calls.
    previous: std::sync::Arc<std::sync::atomic::AtomicU16>,
}

/// WSS-only launch settings that preserve server identity across the localhost tunnel.
#[derive(Clone)]
struct SecureRelayServer {
    /// Logical authority retained in the URL for TLS SNI and HTTP Host handling.
    authority: String,
    /// Whether the remote agent should deliberately skip certificate verification.
    insecure: bool,
}

/// Optional preparation controls used only when a standalone relay differs from managed SSH.
#[derive(Default)]
struct RelayPreparationOptions<'a> {
    /// Enables OpenSSH forwarding-failure inspection for standalone retry behavior.
    monitor_forward_failure: bool,
    /// Retains TLS server identity while transport connects through the tunnel.
    secure_server: Option<SecureRelayServer>,
    /// Forces an operator-selected local binary onto the remote host.
    binary_source: Option<&'a std::path::Path>,
    /// Isolates a standalone relay's remote PID and application data namespace.
    agent_app_name: Option<String>,
}

impl RandomRemotePort {
    /// Chooses the next IANA dynamic/private port and records it for the retry.
    fn next(&self) -> u16 {
        let previous = self.previous.load(std::sync::atomic::Ordering::Relaxed);
        let port = random_remote_port(previous);
        log!(
            Level::Debug,
            "Selected random remote port: previous={}, next={}, range=49152..=65535",
            previous,
            port
        );
        self.previous
            .store(port, std::sync::atomic::Ordering::Relaxed);
        port
    }
}

/// Resolved values for one SSH-backed agent: the prepared host and the
/// ssh argv to run. Launchers use the shared random spawn method to start a
/// fresh child without re-sniffing the host or re-uploading the binary.
#[derive(Clone)]
pub(crate) struct PreparedSshBackedAgent {
    host: SshHost,
    /// Agent registration name; used to kill orphaned remote processes that
    /// would otherwise reconnect through a new reverse tunnel and steal this
    /// name from the freshly spawned agent.
    agent_name: String,
    /// Root CLI namespace passed explicitly so the remote process matches the server.
    app_name: String,
    remote_bin: String,
    home: Option<String>,
    /// Destination host reached from the machine running the SSH client.
    destination_host: String,
    /// Destination server port reached from the machine running the SSH client.
    destination_port: u16,
    options: SshRunOptions,
    /// Shares random-port selection between standalone and managed launches.
    random_remote_port: RandomRemotePort,
    /// Relay WSS identity; absent for plain and server-managed SSH-backed agents.
    secure_server: Option<SecureRelayServer>,
}

impl PreparedSshBackedAgent {
    /// Spawns the long-running ssh child for this agent. The returned
    /// `Child` is owned by the caller (the supervisor) so it can wait
    /// for normal exit or kill it when the WebSocket goes stale.
    pub(crate) async fn spawn(
        &self,
        remote_port: u16,
    ) -> Result<tokio::process::Child, std::io::Error> {
        log!(
            Level::Debug,
            "Prepared SSH spawn requested: target={}, remote_bin={}, remote_port={}, agent_name={}, app_name={}, destination={}:{}",
            self.host.target(),
            self.remote_bin,
            remote_port,
            self.agent_name,
            self.app_name,
            self.destination_host,
            self.destination_port
        );
        let (remote_argv, options) = self.launch_settings(remote_port);
        let argv_refs: Vec<&str> = remote_argv.iter().map(String::as_str).collect();
        log!(
            Level::Debug,
            "Prepared SSH spawn launching: target={}, remote_bin={}, remote_argv={:?}, reverse_forwards={}, has_log_file={}, managed_agent={}, compressed={}, pipe_stderr={}",
            self.host.target(),
            self.remote_bin,
            argv_refs,
            options.reverse_forwards.len(),
            options.log_file.is_some(),
            options.managed_agent,
            options.compressed,
            options.pipe_stderr
        );
        let result = self
            .host
            .spawn(&self.remote_bin, &argv_refs, &options)
            .await;
        match &result {
            Ok(child) => log!(
                Level::Debug,
                "Prepared SSH spawn succeeded: target={}, remote_port={}, child_id={:?}",
                self.host.target(),
                remote_port,
                child.id()
            ),
            Err(error) => log!(
                Level::Error,
                "Prepared SSH spawn failed: target={}, remote_port={}, error={:#}",
                self.host.target(),
                remote_port,
                error
            ),
        }
        result
    }

    /// Starts an agent through a fresh random remote port and returns both the
    /// selected port and child so each launcher can apply its lifecycle policy.
    async fn spawn_random(
        &self,
        status: &ProvisioningStatusSink,
    ) -> Result<(u16, tokio::process::Child), std::io::Error> {
        let remote_port = self.random_remote_port.next();
        log!(
            Level::Debug,
            "Standalone SSH spawn_random selected port: target={}, remote_port={}, remote_bin={}, agent_name={}",
            self.host.target(),
            remote_port,
            self.remote_bin,
            self.agent_name
        );
        status.report(format!("Spawning the remote binary at {}", self.remote_bin));
        log!(
            Level::Info,
            "Spawning SSH-backed redoor agent: target={}, ssh_server_port={}, name={}, remote_bin={}, random_remote_port={}, destination={}:{}",
            self.host.target(),
            self.host.server_port_label(),
            self.agent_name,
            self.remote_bin,
            remote_port,
            self.destination_host,
            self.destination_port
        );
        let child = self.spawn(remote_port).await?;
        log!(
            Level::Debug,
            "Standalone SSH spawn_random completed: target={}, remote_port={}, child_id={:?}",
            self.host.target(),
            remote_port,
            child.id()
        );
        Ok((remote_port, child))
    }

    /// Starts a TOML-managed agent with the shared random-port policy while
    /// leaving retries and stale-session handling to the server watchdog.
    pub(crate) async fn spawn_managed(
        &self,
        status: &ProvisioningStatusSink,
    ) -> Result<tokio::process::Child, std::io::Error> {
        let remote_port = self.random_remote_port.next();
        log!(
            Level::Debug,
            "Managed SSH spawn_managed selected port: target={}, ssh_server_port={}, remote_port={}, remote_bin={}, agent_name={}, app_name={}, home={:?}, destination={}:{}, secure_server={:?}",
            self.host.target(),
            self.host.server_port_label(),
            remote_port,
            self.remote_bin,
            self.agent_name,
            self.app_name,
            self.home,
            self.destination_host,
            self.destination_port,
            self.secure_server.as_ref().map(|s| &s.authority)
        );
        status.report(format!("Spawning the remote binary at {}", self.remote_bin));
        log!(
            Level::Info,
            "Spawning SSH-backed redoor agent: target={}, ssh_server_port={}, name={}, remote_bin={}, random_remote_port={}, destination={}:{}",
            self.host.target(),
            self.host.server_port_label(),
            self.agent_name,
            self.remote_bin,
            remote_port,
            self.destination_host,
            self.destination_port
        );
        let (remote_argv, options) = self.launch_settings(remote_port);
        log!(
            Level::Debug,
            "Managed SSH launch settings: target={}, remote_port={}, remote_bin={}, remote_argv={:?}, log_file={:?}, managed_agent=true",
            self.host.target(),
            remote_port,
            self.remote_bin,
            remote_argv,
            options.log_file
        );
        let mut options = options.with_managed_agent();
        if options.log_file().is_none() {
            // The watchdog drains this bounded stream into connection_issue so
            // OpenSSH failures do not collapse into an unexplained status 255.
            options = options.with_piped_stderr();
        }
        let argv_refs: Vec<&str> = remote_argv.iter().map(String::as_str).collect();
        let result = self
            .host
            .spawn(&self.remote_bin, &argv_refs, &options)
            .await;
        match &result {
            Ok(child) => log!(
                Level::Debug,
                "Managed SSH spawn_managed succeeded: target={}, remote_port={}, child_id={:?}",
                self.host.target(),
                remote_port,
                child.id()
            ),
            Err(error) => log!(
                Level::Error,
                "Managed SSH spawn_managed failed: target={}, remote_port={}, error={:#}",
                self.host.target(),
                remote_port,
                error
            ),
        }
        result
    }

    /// Builds the matching remote agent argv and reverse-forward options so the
    /// agent always connects to the random port SSH actually requested.
    fn launch_settings(&self, remote_port: u16) -> (Vec<String>, SshRunOptions) {
        let server_url = match &self.secure_server {
            Some(server) => format!("wss://{}/ws", server.authority),
            None => format!("ws://localhost:{remote_port}/ws"),
        };
        let mut remote_argv = vec![
            "--app-name".to_string(),
            self.app_name.clone(),
            "agent".to_string(),
            server_url.clone(),
            "--exit-on-stdin-eof".to_string(),
            "--name".to_string(),
            self.agent_name.clone(),
        ];
        if let Some(server) = &self.secure_server {
            remote_argv.push("--connect-address".to_string());
            remote_argv.push(format!("localhost:{remote_port}"));
            if server.insecure {
                remote_argv.push("--insecure-tls".to_string());
            }
        }
        if let Some(home) = &self.home {
            remote_argv.push("--home".to_string());
            remote_argv.push(home.clone());
        }
        log!(
            Level::Debug,
            "Built SSH launch settings: target={}, remote_port={}, server_url={}, remote_bin={}, app_name={}, agent_name={}, home={:?}, destination={}:{}, secure_server={:?}, remote_argv={:?}",
            self.host.target(),
            remote_port,
            server_url,
            self.remote_bin,
            self.app_name,
            self.agent_name,
            self.home,
            self.destination_host,
            self.destination_port,
            self.secure_server.as_ref().map(|s| &s.authority),
            remote_argv
        );
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

/// One-time setup for an SSH-backed agent: resolves the remote binary
/// path, sniffs the host, installs the binary if missing, and computes
/// the run-time options. After this returns successfully, the binary is
/// in place and the host is ready to run the agent. The supervisor
/// loops [`PreparedSshBackedAgent::spawn`] calls against the returned struct
/// so it doesn't re-sniff / re-upload on every restart.
pub(crate) async fn prepare_ssh_backed_agent(
    config: &SshBackedAgentConfig,
    redoor_port: u16,
    agent_token: &str,
    status: &ProvisioningStatusSink,
) -> Result<PreparedSshBackedAgent, Box<dyn std::error::Error>> {
    log!(
        Level::Debug,
        "Preparing managed SSH agent: target={}, ssh_server_port={}, name={:?}, remote_bin={:?}, home={:?}, log={:?}, username={:?}, destination=localhost:{}, has_password={}, has_binary_source=false",
        config.target,
        config
            .ssh_port
            .map(|port| port.to_string())
            .unwrap_or_else(|| "ssh-config".to_string()),
        config.name,
        config.remote_bin,
        config.home,
        config.log,
        config.username,
        redoor_port,
        config.password.is_some()
    );
    let start = std::time::Instant::now();
    let result = prepare_ssh_backed_agent_for_destination(
        config,
        "localhost".to_string(),
        redoor_port,
        agent_token,
        RelayPreparationOptions::default(),
        status,
    )
    .await;
    match &result {
        Ok(prepared) => log!(
            Level::Debug,
            "Managed SSH prepare completed: target={}, elapsed={:?}, remote_bin={}, agent_name={}, app_name={}, destination={}:{}",
            config.target,
            start.elapsed(),
            prepared.remote_bin,
            prepared.agent_name,
            prepared.app_name,
            prepared.destination_host,
            prepared.destination_port
        ),
        Err(error) => log!(
            Level::Error,
            "Managed SSH prepare failed: target={}, elapsed={:?}, error={:#}",
            config.target,
            start.elapsed(),
            error
        ),
    }
    result
}

/// Prepares an SSH-backed agent whose reverse tunnel terminates at a destination
/// reached from the local SSH client rather than necessarily at localhost.
async fn prepare_ssh_backed_agent_for_destination(
    config: &SshBackedAgentConfig,
    destination_host: String,
    destination_port: u16,
    agent_token: &str,
    preparation: RelayPreparationOptions<'_>,
    status: &ProvisioningStatusSink,
) -> Result<PreparedSshBackedAgent, Box<dyn std::error::Error>> {
    let prepare_start = std::time::Instant::now();
    log!(
        Level::Debug,
        "SSH prepare for destination started: target={}, ssh_server_port={}, name={:?}, destination={}:{}, has_password={}, monitor_forward_failure={}, has_binary_source={}, has_secure_server={}, agent_app_name={:?}",
        config.target,
        config
            .ssh_port
            .map(|port| port.to_string())
            .unwrap_or_else(|| "ssh-config".to_string()),
        config.name,
        destination_host,
        destination_port,
        config.password.is_some(),
        preparation.monitor_forward_failure,
        preparation.binary_source.is_some(),
        preparation.secure_server.is_some(),
        preparation.agent_app_name
    );
    let remote_bin = match config.remote_bin.clone() {
        Some(remote_bin) => {
            log!(
                Level::Debug,
                "SSH prepare using operator remote_bin: target={}, remote_bin={}",
                config.target,
                remote_bin
            );
            remote_bin
        }
        None => {
            let default = default_remote_bin()?;
            log!(
                Level::Debug,
                "SSH prepare resolved default remote_bin: target={}, remote_bin={}",
                config.target,
                default
            );
            default
        }
    };
    let agent_name = config
        .name
        .clone()
        .unwrap_or_else(|| default_agent_name(&config.target));
    let host = SshHost::new(config.target.clone())
        .username(config.username.clone())
        .ssh_port(config.ssh_port)
        .password(config.password.clone());

    // Sniff the remote host before starting the agent so we can install the
    // redoor binary on first contact. Without this, a fresh remote host
    // would just fail with "command not found" and the user would have to
    // install the binary manually, which defeats the purpose of `redoor agent relay`.
    //
    // When the user supplied their own `remote_bin`, we trust it as-is:
    // probing and (re)installing would clobber a binary the operator
    // intentionally placed at that path. Auto-install may redirect debug
    // uploads to the dedicated `debug` path instead of the versioned default.
    let remote_bin = if let Some(binary_source) = preparation.binary_source {
        log!(
            Level::Debug,
            "SSH prepare force-upload path: target={}, binary_source={}, remote_bin={}, elapsed={:?}",
            config.target,
            binary_source.display(),
            remote_bin,
            prepare_start.elapsed()
        );
        let remote_bin =
            provision::force_upload_binary(&host, binary_source, &remote_bin, status).await?;
        log!(
            Level::Info,
            "Force-uploading operator-provided binary before relay: target={}, binary_source={}, remote_bin={}",
            config.target,
            binary_source.display(),
            remote_bin
        );
        log!(
            Level::Debug,
            "SSH prepare force-upload completed: target={}, remote_bin={}, elapsed={:?}",
            config.target,
            remote_bin,
            prepare_start.elapsed()
        );
        remote_bin
    } else if config.remote_bin.is_none() {
        status.report("Sniffing the SSH target");
        log!(
            Level::Info,
            "Sniffing SSH target before relay: target={}, ssh_server_port={}",
            config.target,
            host.server_port_label()
        );
        log!(
            Level::Debug,
            "SSH prepare sniff started: target={}, ssh_server_port={}, remote_bin={}, elapsed={:?}",
            config.target,
            host.server_port_label(),
            remote_bin,
            prepare_start.elapsed()
        );
        let sniff_start = std::time::Instant::now();
        let sniff = sniff_remote(&host, &remote_bin).await?;
        log!(
            Level::Debug,
            "SSH prepare sniff completed: target={}, elapsed={:?}, os={}, arch={}, version='{}', sha1sum='{}', resolved_remote_bin={}",
            config.target,
            sniff_start.elapsed(),
            sniff.os,
            sniff.arch,
            sniff.version_output,
            sniff.sha1sum,
            sniff.remote_bin
        );
        status.report(sniff.status_message());
        let ensure_start = std::time::Instant::now();
        log!(
            Level::Debug,
            "SSH prepare ensure_remote_binary started: target={}, remote_bin={}, elapsed={:?}",
            config.target,
            sniff.remote_bin,
            prepare_start.elapsed()
        );
        let ensured = ensure_remote_binary(&host, &sniff, status).await?;
        log!(
            Level::Debug,
            "SSH prepare ensure_remote_binary completed: target={}, remote_bin={}, elapsed={:?}, total_prepare_elapsed={:?}",
            config.target,
            ensured,
            ensure_start.elapsed(),
            prepare_start.elapsed()
        );
        ensured
    } else {
        status.report(format!(
            "Using operator-provided remote binary at {remote_bin}"
        ));
        log!(
            Level::Info,
            "Using operator-provided remote binary without sniffing or provisioning: target={}, remote_bin={}",
            config.target,
            remote_bin
        );
        log!(
            Level::Debug,
            "SSH prepare skipped sniff/provision for operator remote_bin: target={}, remote_bin={}, elapsed={:?}",
            config.target,
            remote_bin,
            prepare_start.elapsed()
        );
        remote_bin
    };

    // The reverse forward is added for each spawn because both standalone and
    // TOML-managed launches choose a fresh remote port for every attempt.
    let mut options = SshRunOptions::default().with_secret_env("REDOOR_AGENT_TOKEN", agent_token);
    if let Some(log) = &config.log {
        log!(
            Level::Debug,
            "SSH prepare configuring log file: target={}, log_file={}",
            config.target,
            log
        );
        options = options.with_log_file(log);
    }
    if preparation.monitor_forward_failure {
        log!(
            Level::Debug,
            "SSH prepare enabling piped stderr for forward failure monitoring: target={}",
            config.target
        );
        options = options.with_piped_stderr();
    }

    log!(
        Level::Info,
        "Prepared redoor agent on remote host: name={}, remote_bin={}, home={:?}, log={:?}",
        agent_name,
        remote_bin,
        config.home,
        config.log,
    );
    log!(
        Level::Debug,
        "SSH prepare finished: target={}, agent_name={}, remote_bin={}, home={:?}, log={:?}, destination={}:{}, secure_server={:?}, agent_app_name={:?}, total_elapsed={:?}",
        config.target,
        agent_name,
        remote_bin,
        config.home,
        config.log,
        destination_host,
        destination_port,
        preparation.secure_server.as_ref().map(|s| &s.authority),
        preparation.agent_app_name,
        prepare_start.elapsed()
    );

    Ok(PreparedSshBackedAgent {
        host,
        agent_name,
        app_name: match preparation.agent_app_name {
            Some(app_name) => app_name,
            None => crate::app_name::app_name()?,
        },
        remote_bin,
        home: config.home.clone(),
        destination_host,
        destination_port,
        options,
        random_remote_port: RandomRemotePort::default(),
        secure_server: preparation.secure_server,
    })
}

/// Initial delay keeps transient SSH failures responsive without spinning.
const RELAY_INITIAL_BACKOFF: std::time::Duration = std::time::Duration::from_secs(1);
/// Maximum delay bounds how long a persistent relay remains unavailable between attempts.
const RELAY_MAX_BACKOFF: std::time::Duration = std::time::Duration::from_secs(30);
/// A long-lived SSH session proves the route is healthy enough to reset retry escalation.
const RELAY_STABLE_RUNTIME: std::time::Duration = std::time::Duration::from_secs(30);

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
fn monitor_forward_failure<R>(
    mut input: R,
    log_path: Option<String>,
) -> tokio::sync::oneshot::Receiver<bool>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut sender = Some(sender);
        let mut detector = ForwardFailureDetector::default();
        let mut output = tokio::io::stderr();
        let mut log_file = match log_path {
            Some(path) => tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
                .ok(),
            None => None,
        };
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match input.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = &buffer[..read];
                    let _ = output.write_all(chunk).await;
                    if let Some(log_file) = &mut log_file {
                        let _ = log_file.write_all(chunk).await;
                    }
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
async fn run_relay_attempt(
    prepared: &PreparedSshBackedAgent,
) -> Result<(u16, std::process::ExitStatus, bool), Box<dyn std::error::Error>> {
    let (remote_port, mut child) = prepared
        .spawn_random(&ProvisioningStatusSink::noop())
        .await?;
    let stderr = child.stderr.take().ok_or_else(|| {
        std::io::Error::other("standalone SSH stderr was not piped for forward monitoring")
    })?;
    let forward_failed = monitor_forward_failure(stderr, prepared.options.log_file().cloned())
        .await
        .unwrap_or(false);
    let status = child.wait().await?;
    Ok((remote_port, status, forward_failed))
}

/// Standalone implementation for `redoor agent relay`: probes the remote host,
/// installs the redoor binary if missing, then persistently supervises an agent
/// through a reverse forward to the requested destination.
///
/// Preparation is retried until the SSH host becomes available. Once prepared,
/// every SSH exit or random remote-port collision starts a fresh session without
/// repeating provisioning. Foreground and daemon launches both use this loop.
pub(crate) async fn start_relay(
    config: SshBackedAgentConfig,
    server: ServerAddress,
    agent_token: &str,
    insecure: bool,
    binary_source: Option<PathBuf>,
    agent_app_name: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let secure_server = server.is_secure().then(|| SecureRelayServer {
        authority: server.authority(),
        insecure,
    });
    let destination_host = server.host().to_string();
    let destination_port = server.port();
    let mut prepared = None;
    let mut backoff = RELAY_INITIAL_BACKOFF;
    loop {
        if prepared.is_none() {
            match prepare_ssh_backed_agent_for_destination(
                &config,
                destination_host.clone(),
                destination_port,
                agent_token,
                RelayPreparationOptions {
                    monitor_forward_failure: true,
                    secure_server: secure_server.clone(),
                    binary_source: binary_source.as_deref(),
                    agent_app_name: Some(agent_app_name.clone()),
                },
                &ProvisioningStatusSink::noop(),
            )
            .await
            {
                Ok(value) => prepared = Some(value),
                Err(error) => {
                    log!(Level::Error, "Relay preparation failed: {error:#}");
                    wait_for_relay_retry(backoff).await;
                    backoff = (backoff * 2).min(RELAY_MAX_BACKOFF);
                    continue;
                }
            }
        }

        let started = std::time::Instant::now();
        let attempt = run_relay_attempt(prepared.as_ref().expect("relay prepared above")).await;
        match attempt {
            Ok((remote_port, status, true)) => log!(
                Level::Warning,
                "SSH remote port was occupied; relay will retry: remote_port={remote_port}, status={status}"
            ),
            Ok((remote_port, status, false)) => log!(
                Level::Warning,
                "Relay SSH session exited; relay will retry: remote_port={remote_port}, status={status}"
            ),
            Err(error) => log!(
                Level::Error,
                "Relay SSH attempt failed; relay will retry: {error:#}"
            ),
        }
        if started.elapsed() >= RELAY_STABLE_RUNTIME {
            backoff = RELAY_INITIAL_BACKOFF;
        }
        wait_for_relay_retry(backoff).await;
        backoff = (backoff * 2).min(RELAY_MAX_BACKOFF);
    }
}

/// Waits between failed relay attempts so unavailable SSH hosts do not consume a CPU core.
async fn wait_for_relay_retry(backoff: std::time::Duration) {
    log!(Level::Info, "Relay retry scheduled: backoff={backoff:?}");
    tokio::time::sleep(backoff).await;
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

    /// Verifies URL servers preserve the destination independently of the port
    /// exposed to the agent on the SSH target.
    #[test]
    fn parses_hostname_server_url() {
        let server = "http://redoor.example:4000"
            .parse::<crate::server_address::ServerAddress>()
            .expect("hostname server URL should parse");

        // The SSH client must resolve the exact host supplied by the operator.
        assert_eq!(server.host(), "redoor.example");
        // The destination port may differ from the remote listener port.
        assert_eq!(server.port(), 4000);
        // http:// selects plain WebSocket routing through the tunnel.
        assert!(!server.is_secure());
    }

    /// Verifies https/wss schemes select secure tunnel routing without a separate flag.
    #[test]
    fn parses_secure_server_url() {
        let server = "https://redoor.example.com"
            .parse::<crate::server_address::ServerAddress>()
            .expect("https server URL should parse");

        assert!(server.is_secure());
        assert_eq!(server.port(), 443);
        assert_eq!(server.authority(), "redoor.example.com:443");
    }

    /// Verifies bracketed IPv6 servers are accepted without retaining syntax
    /// brackets in the destination model.
    #[test]
    fn parses_bracketed_ipv6_server_url() {
        let server = "ws://[2001:db8::10]:4000"
            .parse::<crate::server_address::ServerAddress>()
            .expect("bracketed IPv6 server URL should parse");

        // Transport formatting adds brackets itself, so the model stores only the address.
        assert_eq!(server.host(), "2001:db8::10");
        // IPv6 servers use the same validated destination-port representation.
        assert_eq!(server.port(), 4000);
    }

    /// Verifies bare host:port is rejected so relay matches the agent URL contract.
    #[test]
    fn rejects_server_without_url_scheme() {
        let error = "redoor.example:4000"
            .parse::<crate::server_address::ServerAddress>()
            .expect_err("bare host:port should be rejected");

        // A focused error steers operators toward the shared URL forms.
        assert!(error.contains("http") || error.contains("ws") || error.contains("URL"));
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

    /// Builds prepared state without touching an SSH host so launch argv can be checked directly.
    fn prepared_agent(
        secure_server: Option<super::SecureRelayServer>,
    ) -> super::PreparedSshBackedAgent {
        super::PreparedSshBackedAgent {
            host: super::SshHost::new("user@target".to_string()),
            agent_name: "target".to_string(),
            app_name: "redoor".to_string(),
            remote_bin: "/tmp/redoor".to_string(),
            home: None,
            destination_host: "redoor.example".to_string(),
            destination_port: 443,
            options: super::SshRunOptions::default(),
            random_remote_port: super::RandomRemotePort::default(),
            secure_server,
        }
    }

    /// Keeps existing plain routes pointed directly at the random tunnel listener.
    #[test]
    fn plain_launch_uses_random_tunnel_url() {
        let prepared = prepared_agent(None);
        let (argv, _options) = prepared.launch_settings(52123);

        // Plain routing must retain its existing URL and avoid hidden TLS routing flags.
        assert!(argv.iter().any(|value| value == "ws://localhost:52123/ws"));
        // SSH channel EOF must stop the remote process instead of leaving its PID lock held.
        assert!(argv.iter().any(|value| value == "--exit-on-stdin-eof"));
        assert!(!argv.iter().any(|value| value == "--connect-address"));
        assert!(!argv.iter().any(|value| value == "--insecure-tls"));
    }

    /// Keeps WSS server identity stable while retries change only the physical tunnel endpoint.
    #[test]
    fn secure_launch_separates_authority_from_tunnel() {
        let prepared = prepared_agent(Some(super::SecureRelayServer {
            authority: "redoor.example:443".to_string(),
            insecure: true,
        }));
        let (first_argv, _options) = prepared.launch_settings(52123);
        let (second_argv, _options) = prepared.launch_settings(52124);

        // The logical URL supplies both SNI and WebSocket authority across tunnel retries.
        assert!(
            first_argv
                .iter()
                .any(|value| value == "wss://redoor.example:443/ws")
        );
        assert!(
            second_argv
                .iter()
                .any(|value| value == "wss://redoor.example:443/ws")
        );
        // Each retry must direct TCP to the newly selected remote SSH listener.
        assert!(first_argv.iter().any(|value| value == "localhost:52123"));
        assert!(second_argv.iter().any(|value| value == "localhost:52124"));
        // The explicit insecure choice must be propagated without exposing the agent token.
        assert!(first_argv.iter().any(|value| value == "--insecure-tls"));
        assert!(!first_argv.iter().any(|value| value == "secret"));
    }
}
