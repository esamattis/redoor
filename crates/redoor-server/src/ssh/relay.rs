//! `redoor agent relay start`: keeps one SSH-launched agent connected to a server.
//!
//! The relay prepares the target once (retrying until the host is reachable), then
//! relaunches the SSH session whenever it exits, each time on a fresh random reverse
//! port. OpenSSH's forwarding failure for an occupied port is detected on stderr so it
//! is reported as such rather than as an unexplained exit.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use redoor_core::config::{RelayConfig, SshBackedAgentConfig};
use redoor_core::paths::AppPaths;
use redoor_core::rotating_log::RotatingLogFile;
use redoor_core::server_address::ServerAddress;
use redoor_core::{log, log_error};
use redoor_protocol::wire::log::Level;

use super::ProvisionContext;
use super::prepare::{
    Preparation, PreparedSshBackedAgent, RelayOptions, SecureRelayServer, TunnelDestination,
};
use crate::watchdog::ProvisioningStatusSink;

/// Initial delay keeps transient SSH failures responsive without spinning.
const RELAY_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
/// Maximum delay bounds how long a persistent relay remains unavailable between attempts.
const RELAY_MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A long-lived SSH session proves the route is healthy enough to reset retry escalation.
const RELAY_STABLE_RUNTIME: Duration = Duration::from_secs(30);

/// Stable fragment emitted by OpenSSH when `ExitOnForwardFailure` rejects a
/// remote listener, independent of the particular port that was occupied.
const REMOTE_FORWARD_FAILURE_MESSAGE: &[u8] = b"remote port forwarding failed for listen port";

/// Validates a configured relay, starts its log and runs it until the process is stopped.
///
/// Reverse port forwarding (`-R`) makes the SSH target listen on a random dynamic port
/// and asks the local SSH client to connect to the server. Plain routes use the tunnel
/// URL directly; WSS routes connect TCP through the tunnel while retaining the route
/// hostname for TLS and HTTP. Only returns on a startup error.
pub async fn run_relay(
    relay: RelayConfig,
    token: String,
    agent_app_name: String,
    paths: AppPaths,
) -> Result<()> {
    let server = relay
        .server
        .parse::<ServerAddress>()
        .map_err(anyhow::Error::msg)
        .with_context(|| format!("invalid server in relay '{}'", relay.id))?;
    if relay.insecure && !server.is_secure() {
        bail!("relay insecure = true requires an https:// or wss:// server URL");
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
        .context("relay startup must resolve a log path")?;
    let provision = ProvisionContext {
        app_name: paths.app_name().to_string(),
        // Relays never have managed keys or pins: they belong to no account.
        ssh_keys: crate::ssh::keys::SshKeyStore::for_data_dir(&paths.data_dir()?),
        held_ssh_keys: Default::default(),
        default_account: None,
        binaries: crate::binaries::BinaryCache::new(paths),
        log_max_size: relay.log_max_size,
        // Filled on the first preparation that uploads the local debug build.
        local_build: Default::default(),
    };
    redoor_core::logging::init(Some(provision.log_file(&log))).await?;
    // Caught from now on, so `redoor upgrade` restarts the relay instead of killing it.
    let mut reexec_requests = redoor_core::process::listen_for_reexec()
        .context("Failed to listen for the upgrade re-exec signal")?;
    let relay = Relay {
        secure_server: server.is_secure().then(|| SecureRelayServer {
            authority: server.authority(),
            insecure: relay.insecure,
        }),
        destination: TunnelDestination {
            host: server.host().to_string(),
            port: server.port(),
        },
        config: relay.agent,
        binary_source: relay.binary_source,
        agent_app_name,
        token,
        provision,
        backoff: Backoff::default(),
    };
    tokio::select! {
        result = relay.run() => return result,
        _ = reexec_requests.recv() => {}
    }
    // The relay future is dropped by now, and `kill_on_drop` stopped its SSH session, so the
    // restarted relay does not race an orphaned tunnel for the remote agent.
    eprintln!("Re-exec signal received; restarting relay");
    redoor_core::process::reexec_current_process()
}

/// One running relay: its target, where the tunnel ends, and the retry state.
struct Relay {
    /// SSH target settings shared with server-managed agents.
    config: SshBackedAgentConfig,
    /// Where the reverse tunnel ends, as reached from this machine.
    destination: TunnelDestination,
    /// TLS identity kept in the agent URL for `wss://` servers.
    secure_server: Option<SecureRelayServer>,
    /// Local binary uploaded before the first launch, when configured.
    binary_source: Option<PathBuf>,
    /// Remote namespace isolating this relay's agent state.
    agent_app_name: String,
    /// Agent registration secret.
    token: String,
    /// Local namespace and release cache used during preparation.
    provision: ProvisionContext,
    /// Delay before the next attempt.
    backoff: Backoff,
}

/// How one SSH session ended.
enum AttemptOutcome {
    /// OpenSSH could not bind the random remote port (another listener owns it).
    PortOccupied {
        remote_port: u16,
        status: std::process::ExitStatus,
    },
    /// The session ran and exited for any other reason.
    Exited {
        remote_port: u16,
        status: std::process::ExitStatus,
    },
}

/// Exit status of `sh` when the `exec`ed program does not exist; OpenSSH passes the
/// remote command's status through.
const EXIT_COMMAND_NOT_FOUND: i32 = 127;

impl AttemptOutcome {
    /// Whether the remote shell could not find the prepared binary. Another provision
    /// in the same namespace can upload a newer debug build and remove the old
    /// `debug-<hash>` directory, so the relay must prepare again instead of retrying the
    /// deleted path forever.
    fn binary_missing(&self) -> bool {
        matches!(self, Self::Exited { status, .. } if status.code() == Some(EXIT_COMMAND_NOT_FOUND))
    }
}

impl Relay {
    /// Prepares until it succeeds, then relaunches the SSH session forever.
    ///
    /// Preparation is repeated only when the prepared binary has disappeared: provisioning
    /// is the slow part and the installed binary otherwise stays valid across reconnects.
    async fn run(mut self) -> Result<()> {
        let mut prepared = self.prepare_until_ready().await;
        loop {
            let started = Instant::now();
            let outcome = Self::run_attempt(&prepared).await;
            let binary_missing = outcome.as_ref().is_ok_and(AttemptOutcome::binary_missing);
            match outcome {
                Ok(AttemptOutcome::PortOccupied {
                    remote_port,
                    status,
                }) => log!(
                    Level::Warning,
                    "SSH remote port was occupied; relay will retry: remote_port={remote_port}, status={status}"
                ),
                Ok(AttemptOutcome::Exited {
                    remote_port,
                    status,
                }) => log!(
                    Level::Warning,
                    "Relay SSH session exited; relay will retry: remote_port={remote_port}, status={status}"
                ),
                Err(error) => log_error!(
                    anyhow::Error::new(error),
                    "Relay SSH attempt failed; relay will retry"
                ),
            }
            if started.elapsed() >= RELAY_STABLE_RUNTIME {
                self.backoff.reset();
            }
            self.backoff.wait().await;
            if binary_missing {
                log!(
                    Level::Warning,
                    "Relay binary is missing on the remote host; preparing again: remote_bin={}",
                    prepared.remote_bin
                );
                prepared = self.prepare_until_ready().await;
            }
        }
    }

    /// Retries preparation with backoff until the target is reachable and provisioned.
    async fn prepare_until_ready(&mut self) -> PreparedSshBackedAgent {
        loop {
            match self.prepare().await {
                Ok(prepared) => return prepared,
                Err(error) => {
                    log_error!(anyhow::Error::new(error), "Relay preparation failed");
                    self.backoff.wait().await;
                }
            }
        }
    }

    /// Runs one preparation with the relay-specific options.
    async fn prepare(&self) -> Result<PreparedSshBackedAgent, super::ProvisionError> {
        Preparation {
            config: &self.config,
            destination: self.destination.clone(),
            agent_token: &self.token,
            relay: RelayOptions {
                monitor_forward_failure: true,
                secure_server: self.secure_server.clone(),
                binary_source: self.binary_source.as_deref(),
                agent_app_name: Some(self.agent_app_name.clone()),
            },
            provision: &self.provision,
            status: &ProvisioningStatusSink::noop(),
        }
        .run()
        .await
    }

    /// Runs one random-port SSH session to completion and classifies how it ended.
    ///
    /// The logs are opened before spawning so an unwritable log fails the attempt instead
    /// of leaving SSH blocked on an undrained stdout pipe.
    async fn run_attempt(prepared: &PreparedSshBackedAgent) -> std::io::Result<AttemptOutcome> {
        let (stdout_log, stderr_log) = match prepared.options.log_file() {
            Some(spec) => (Some(spec.open().await?), Some(spec.open().await?)),
            None => (None, None),
        };
        let (remote_port, mut child) = prepared.spawn_random().await?;
        if let Some(log_file) = stdout_log {
            let stdout = child.stdout.take();
            tokio::spawn(log_file.forward_child_output(
                stdout,
                None::<tokio::process::ChildStderr>,
                0,
            ));
        }
        let stderr = child.stderr.take().ok_or_else(|| {
            std::io::Error::other("standalone SSH stderr was not piped for forward monitoring")
        })?;
        let forward_failed = monitor_forward_failure(stderr, stderr_log)
            .await
            .unwrap_or(false);
        let status = child.wait().await?;
        Ok(if forward_failed {
            AttemptOutcome::PortOccupied {
                remote_port,
                status,
            }
        } else {
            AttemptOutcome::Exited {
                remote_port,
                status,
            }
        })
    }
}

/// Exponential retry delay shared by preparation and relaunch.
struct Backoff {
    /// Delay used by the next `wait`.
    current: Duration,
}

impl Default for Backoff {
    /// Starts at the shortest delay so the first retry is quick.
    fn default() -> Self {
        Self {
            current: RELAY_INITIAL_BACKOFF,
        }
    }
}

impl Backoff {
    /// Returns to the shortest delay after a session proved the route healthy.
    fn reset(&mut self) {
        self.current = RELAY_INITIAL_BACKOFF;
    }

    /// Returns the delay to wait now and doubles the next one up to the cap.
    fn advance(&mut self) -> Duration {
        let delay = self.current;
        self.current = (self.current * 2).min(RELAY_MAX_BACKOFF);
        delay
    }

    /// Waits so unavailable SSH hosts do not consume a CPU core.
    async fn wait(&mut self) {
        let delay = self.advance();
        log!(Level::Info, "Relay retry scheduled: backoff={delay:?}");
        tokio::time::sleep(delay).await;
    }
}

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

/// Copies piped SSH stderr to the relay's terminal and log while reporting whether
/// OpenSSH said its random remote listener could not bind.
fn monitor_forward_failure<R>(
    mut input: R,
    mut log_file: Option<RotatingLogFile>,
) -> tokio::sync::oneshot::Receiver<bool>
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
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let chunk = &buffer[..read];
                    let _ = output.write_all(chunk).await;
                    if let Some(log_file) = &mut log_file {
                        let _ = log_file.write_message(chunk).await;
                    }
                    if detector.observe(chunk)
                        && let Some(sender) = sender.take()
                    {
                        let _ = sender.send(true);
                    }
                }
            }
        }
        if let Some(sender) = sender {
            let _ = sender.send(false);
        }
    });
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    /// Only the shell's "not found" status triggers a new preparation, so ordinary
    /// session exits keep reusing the prepared binary.
    #[test]
    fn binary_missing_only_for_command_not_found() {
        let exited = |code: i32| AttemptOutcome::Exited {
            remote_port: 52000,
            status: std::process::ExitStatus::from_raw(code << 8),
        };
        // A deleted `debug-<hash>` binary makes `exec` fail with 127 and must re-prepare.
        assert!(exited(EXIT_COMMAND_NOT_FOUND).binary_missing());
        // A normal disconnect or crash must not re-provision on every reconnect.
        assert!(!exited(255).binary_missing());
        // An occupied port is a forwarding problem, not a missing binary.
        assert!(
            !AttemptOutcome::PortOccupied {
                remote_port: 52000,
                status: std::process::ExitStatus::from_raw(EXIT_COMMAND_NOT_FOUND << 8),
            }
            .binary_missing()
        );
    }

    /// Verifies forwarding failures are recognized even when the fixed-size
    /// stderr reader splits OpenSSH's message across chunks.
    #[test]
    fn detects_split_remote_forward_failure() {
        let mut detector = ForwardFailureDetector::default();

        // A partial phrase must not trigger a retry before OpenSSH reports the failure.
        assert!(!detector.observe(b"Warning: remote port forward"));
        // Completing the phrase across the next chunk must identify the occupied port.
        assert!(detector.observe(b"ing failed for listen port 52000\n"));
    }

    /// The delay doubles per failure, stays capped, and resets after a healthy session.
    #[test]
    fn backoff_doubles_caps_and_resets() {
        let mut backoff = Backoff::default();
        // Consecutive failures wait progressively longer.
        assert_eq!(backoff.advance(), Duration::from_secs(1));
        assert_eq!(backoff.advance(), Duration::from_secs(2));
        for _ in 0..10 {
            backoff.advance();
        }
        // Repeated failures must never wait longer than the documented maximum.
        assert_eq!(backoff.advance(), RELAY_MAX_BACKOFF);
        backoff.reset();
        // A stable session makes the next failure retry quickly again.
        assert_eq!(backoff.current, RELAY_INITIAL_BACKOFF);
    }
}
