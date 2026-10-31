//! Builds and executes SSH commands without owning agent orchestration policy.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use zeroize::Zeroizing;

use redoor_core::bounded_tail::read_bounded_tail;
use redoor_core::log;
use redoor_core::rotating_log::LogFileSpec;
use redoor_protocol::wire::log::Level;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::keys::SshPrivateKey;
use super::ssh_agent::{SshAgentGuard, SshAgentSocket};

/// Caps browser-bound SSH diagnostics while retaining the final, usually actionable lines.
const MAX_SSH_DIAGNOSTIC_BYTES: usize = 8 * 1024;

/// Bounds how long OpenSSH may spend establishing its transport before a retry.
const SSH_CONNECT_TIMEOUT_SECONDS: u32 = 15;

/// One reverse forward: SSH listens on `remote_port` at the remote host and
/// asks the local SSH client to connect to `destination_host:destination_port`.
/// Keeping the destination explicit lets a relay machine route agent traffic
/// to a redoor server that the SSH target cannot reach directly.
#[derive(Clone)]
pub(super) struct ReverseForward {
    /// Port exposed on the SSH target for the remotely launched agent.
    remote_port: u16,
    /// Host reached from the machine running the local SSH client.
    destination_host: String,
    /// Port reached from the machine running the local SSH client.
    destination_port: u16,
}

impl ReverseForward {
    /// Formats this forward as an `ssh -R` argument, bracketing IPv6 destinations
    /// so OpenSSH does not confuse address colons with the port separator.
    fn to_ssh_spec(&self) -> String {
        let destination_host = if self.destination_host.contains(':') {
            format!("[{}]", self.destination_host)
        } else {
            self.destination_host.clone()
        };
        format!(
            "{}:{}:{}",
            self.remote_port, destination_host, self.destination_port
        )
    }
}

/// Options for [`SshHost::run`] that are orthogonal to the remote command,
/// such as reverse port forwards and whether ssh should compress its traffic.
#[derive(Clone, Default)]
pub(super) struct SshRunOptions {
    /// Reverse port forwards (`ssh -R`) to request on this connection.
    pub(super) reverse_forwards: Vec<ReverseForward>,
    /// When true, adds `-C` so ssh compresses its traffic. Useful for bulk
    /// transfers like binary uploads and the one-shot sniff command; left off
    /// for the long-running agent session which is mostly idle and would just
    /// burn CPU on compression.
    pub(super) compressed: bool,
    /// When set, the value is sent through ssh stdin and exported by a remote
    /// shell preamble so secrets never appear in either process's argv.
    pub(super) secret_env: Option<(String, String)>,
    /// When set, the ssh process's stdout and stderr are piped so their owner
    /// (the watchdog or the relay) forwards them into this size-bounded local
    /// file. Used only for the long-running agent run so sniff/upload
    /// diagnostics still go to the terminal.
    pub(super) log_file: Option<LogFileSpec>,
    /// Pipes stderr so a standalone launcher can detect an initial reverse
    /// forwarding bind failure while still copying agent logs to its terminal.
    pub(super) pipe_stderr: bool,
    /// Pipes stdout so [`SshHost::spawn_with_report`] can read the launch script's report
    /// before forwarding the rest to the log file or terminal itself.
    pipe_stdout: bool,
    /// Managed SSH agents must skip the remote singleton PID lock so sequential
    /// TOML-backed agents on one user can start after the previous session.
    pub(super) managed_agent: bool,
}

/// Selects where SSH output goes so forwarding diagnostics remain observable even
/// when ordinary remote output is persisted to a log file.
#[derive(Debug, PartialEq, Eq)]
enum OutputRoute {
    /// Both streams are piped; the owner forwards them into the log file and a relay
    /// monitor also inspects stderr for bind failures.
    LogFile,
    /// Stdout reaches the terminal while stderr is piped for the relay monitor or the
    /// watchdog's exit diagnostic.
    PipedStderr,
    /// Both streams reach the invoking terminal.
    Inherit,
}

/// A configured log needs both pipes, which also gives a relay monitor its stderr.
fn output_route(options: &SshRunOptions) -> OutputRoute {
    if options.log_file.is_some() {
        OutputRoute::LogFile
    } else if options.pipe_stderr {
        OutputRoute::PipedStderr
    } else {
        OutputRoute::Inherit
    }
}

impl SshRunOptions {
    /// Adds a reverse forward from `remote_port` on the SSH target to a
    /// destination reached by the local SSH client.
    pub(super) fn with_reverse_forward(
        mut self,
        remote_port: u16,
        destination_host: impl Into<String>,
        destination_port: u16,
    ) -> Self {
        self.reverse_forwards.push(ReverseForward {
            remote_port,
            destination_host: destination_host.into(),
            destination_port,
        });
        self
    }

    /// Enables ssh compression (`-C`) for this connection.
    pub(super) fn compressed(mut self) -> Self {
        self.compressed = true;
        self
    }

    /// Sends one secret environment value through stdin instead of exposing it
    /// in the local ssh or remote command process lists.
    pub(super) fn with_secret_env(
        mut self,
        name: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        self.secret_env = Some((name.into(), value.into()));
        self
    }

    /// Sets a local log file to redirect the ssh process's stdout/stderr into.
    pub(super) fn with_log_file(mut self, log_file: LogFileSpec) -> Self {
        self.log_file = Some(log_file);
        self
    }

    /// Marks the remote process as supervisor-owned so it does not take the user-wide agent lock.
    pub(super) fn with_managed_agent(mut self) -> Self {
        self.managed_agent = true;
        self
    }

    /// Pipes SSH stderr so the caller can distinguish a remote forwarding bind
    /// failure from the later lifecycle of a successfully started agent.
    pub(super) fn with_piped_stderr(mut self) -> Self {
        self.pipe_stderr = true;
        self
    }

    /// Exposes the configured log sink so a piped-stderr monitor can tee the
    /// stream that the SSH child can no longer write there directly.
    pub(super) fn log_file(&self) -> Option<&LogFileSpec> {
        self.log_file.as_ref()
    }
}

/// How OpenSSH decides whether to trust the key the device presents.
///
/// Each policy writes every host key option exactly once. OpenSSH keeps the first value it
/// sees for an option, so an unconditional default written earlier would silently win over a
/// stricter value written later.
#[derive(Clone)]
pub(super) enum HostKeyPolicy {
    /// Today's behavior for devices without a pinned key: accept and remember an unknown key
    /// in the user's known_hosts, refuse a changed one.
    TrustOnFirstUse,
    /// Enrollment step 1: record whatever key the device presents into a temporary file,
    /// isolated from every other source of trust so the key is always recorded.
    Probe {
        /// Temporary file the presented key is written to.
        known_hosts: PathBuf,
        /// Name the key is recorded under (the device id).
        alias: String,
    },
    /// Only the key in the device's pinned known_hosts file is accepted.
    Pinned(PinnedHostKey),
}

/// Where the pinned host key of one device lives and what it is.
#[derive(Clone)]
pub(super) struct PinnedHostKey {
    /// The device's own known_hosts file.
    pub(super) known_hosts: PathBuf,
    /// Name the key is looked up by (the device id), so the pin survives a target or port
    /// change that still reaches the same machine.
    pub(super) alias: String,
    /// Fingerprint of the pinned key, shown next to the presented one when they differ.
    pub(super) fingerprint: String,
}

/// Which credentials OpenSSH may use to log in.
#[derive(Clone)]
pub(super) enum AuthPolicy {
    /// The server user's own keys and ssh-agent, never prompting.
    Default,
    /// A login password answered by the askpass re-exec. Zeroized when dropped, because a
    /// typed enrollment password must not outlive the enrollment in memory.
    Password(Zeroizing<String>),
    /// No authentication at all; used by the host key probe, which must not send any
    /// credential to a host whose key the user has not confirmed yet.
    NoAuth,
    /// Only the redoor-managed key may be offered, and the user's config files are not read.
    /// The key stays in this process: `ssh` gets signatures from an in-process ssh-agent
    /// ([`super::ssh_agent`]) created for each `ssh` process.
    ManagedKey {
        /// The device's private key, decrypted or read from a plaintext file.
        key: Arc<SshPrivateKey>,
    },
}

/// Where `ssh` finds the in-process ssh-agent of one invocation.
pub(super) struct SshAgentPaths {
    /// The ssh-agent socket, passed as `IdentityAgent`.
    pub(super) socket: PathBuf,
    /// The public key file, passed as `IdentityFile`, so `ssh` offers only this key.
    pub(super) public_key: PathBuf,
}

/// An `ssh` command ready to spawn, with the ssh-agent socket a managed-key connection
/// authenticates through.
pub(super) struct SshCommand {
    /// The command itself.
    command: Command,
    /// The bound ssh-agent socket; it starts serving once the process exists, because only
    /// then is the pid known that the peer check expects.
    ssh_agent: Option<SshAgentSocket>,
}

impl std::fmt::Debug for SshCommand {
    /// The command's own form; the ssh-agent socket holds a key and is not printed.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.command.fmt(formatter)
    }
}

impl SshCommand {
    /// The command, for setting stdio before spawning and for logging its argv.
    fn command(&mut self) -> &mut Command {
        &mut self.command
    }

    /// Spawns `ssh` and starts its ssh-agent, if any. The guard ends the ssh-agent when
    /// dropped, so callers that wait for the process keep it until then; long-running
    /// spawns detach it and the ssh-agent ends after authentication on its own.
    fn spawn(&mut self) -> std::io::Result<(tokio::process::Child, Option<SshAgentGuard>)> {
        let child = self.command.spawn()?;
        let guard = self.ssh_agent.take().map(|socket| socket.serve(child.id()));
        Ok((child, guard))
    }
}

/// Represents an ssh reachable host and builds `ssh` invocations against it.
///
/// Encapsulates the ssh connection parameters (user, port, target) and the trust and
/// credential policies so the `run` method can stay focused on the remote command and its
/// options. The builder methods return `Self` by value so callers can chain configuration
/// fluently before awaiting [`SshHost::run`].
#[derive(Clone)]
pub(super) struct SshHost {
    username: Option<String>,
    /// An explicit override passed with `-p`; `None` lets OpenSSH resolve the
    /// port from its host configuration or built-in default.
    ssh_port: Option<u16>,
    target: String,
    /// How the device's host key is verified.
    host_key: HostKeyPolicy,
    /// Which credentials may be used.
    auth: AuthPolicy,
}

impl SshHost {
    /// Starts building an ssh connection to `target` (e.g. `user@host`).
    pub(super) fn new(target: String) -> Self {
        Self {
            username: None,
            ssh_port: None,
            target,
            host_key: HostKeyPolicy::TrustOnFirstUse,
            auth: AuthPolicy::Default,
        }
    }

    /// Starts from a device's target, username and port, with today's trust-on-first-use
    /// host keys and the server user's own credentials.
    pub(super) fn for_config(config: &redoor_core::config::SshBackedAgentConfig) -> Self {
        Self::new(config.target.clone())
            .username(config.username.clone())
            .ssh_port(config.ssh_port)
    }

    /// Sets the ssh login username (`ssh -l`).
    pub(super) fn username(mut self, username: Option<String>) -> Self {
        self.username = username;
        self
    }

    /// Sets an optional SSH server port override. Leaving it unset preserves
    /// host-specific ports from `~/.ssh/config` instead of forcing port 22.
    pub(super) fn ssh_port(mut self, port: Option<u16>) -> Self {
        self.ssh_port = port;
        self
    }

    /// Enables non-interactive password auth via a re-exec of this binary.
    pub(super) fn password(self, password: Option<String>) -> Self {
        match password {
            Some(password) => self.auth(AuthPolicy::Password(Zeroizing::new(password))),
            None => self.auth(AuthPolicy::Default),
        }
    }

    /// Selects how the host key is verified.
    pub(super) fn host_key(mut self, policy: HostKeyPolicy) -> Self {
        self.host_key = policy;
        self
    }

    /// Selects which credentials may be used.
    pub(super) fn auth(mut self, policy: AuthPolicy) -> Self {
        self.auth = policy;
        self
    }

    /// Exposes the SSH destination for lifecycle logs without duplicating it in
    /// higher-level prepared-agent state.
    pub(super) fn target(&self) -> &str {
        &self.target
    }

    /// Describes whether the SSH server port is explicitly overridden or left
    /// for OpenSSH configuration, keeping it distinct from the random tunnel port.
    pub(super) fn server_port_label(&self) -> String {
        self.ssh_port
            .map(|port| port.to_string())
            .unwrap_or_else(|| "ssh-config".to_string())
    }

    /// Spawns `ssh` to run the single-line POSIX `sh` script `command` on the remote
    /// host with `args` as its positional parameters (`"$@"`), applying the forwards and
    /// forwarding-failure behavior described by `options`. Output remains observable
    /// while secret-bearing agent sessions retain their stdin pipe until the SSH child
    /// exits.
    ///
    /// Returns the spawned child. Callers (the supervisor) own the child
    /// so they can wait for it or kill it when the WebSocket goes stale.
    pub(super) async fn spawn(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
    ) -> Result<tokio::process::Child, std::io::Error> {
        log!(
            Level::Debug,
            "SSH spawn requested: target={}, ssh_server_port={}, username={:?}, command={}, args={:?}, reverse_forwards={}, has_secret={}, log_file={:?}, managed_agent={}, pipe_stderr={}, compressed={}",
            self.target,
            self.server_port_label(),
            self.username,
            command,
            args,
            options.reverse_forwards.len(),
            options.secret_env.is_some(),
            options.log_file,
            options.managed_agent,
            options.pipe_stderr,
            options.compressed
        );
        let mut ssh = build_ssh_command(self, command, args, options).await?;

        log!(
            Level::Debug,
            "Spawning ssh command: target={}, argv={}",
            self.target,
            ssh_command_argv_debug(ssh.command())
        );

        // Ensure the ssh client is killed if the supervisor task is
        // dropped (e.g. on server shutdown), preventing the ssh
        // process from being orphaned. `kill_on_drop` sends SIGKILL.
        // Note: this only kills the local ssh client; the remote
        // `redoor agent` would need a separate shutdown signal.
        ssh.command().kill_on_drop(true);
        let (mut child, ssh_agent) = ssh.spawn().map_err(|error| {
            redoor_core::log_failure!(
                Level::Error,
                "SSH spawn failed to start child: target={}, command={}, error={:#}",
                self.target,
                command,
                error
            );
            error
        })?;
        // The caller owns the child, not this guard, so the ssh-agent ends on its own after
        // the authentication it exists for (or its lifetime, if ssh never gets that far).
        if let Some(ssh_agent) = ssh_agent {
            ssh_agent.detach();
        }
        log!(
            Level::Debug,
            "SSH spawn child created: target={}, command={}, child_id={:?}, has_secret={}",
            self.target,
            command,
            child.id(),
            options.secret_env.is_some()
        );
        if let Some((name, value)) = &options.secret_env {
            log!(
                Level::Debug,
                "SSH spawn writing secret env: target={}, env_name={}, command={}",
                self.target,
                name,
                command
            );
            write_secret_and_retain_stdin(&mut child, value).await?;
            log!(
                Level::Debug,
                "SSH spawn secret written and stdin retained: target={}, command={}",
                self.target,
                command
            );
        }
        Ok(child)
    }

    /// Runs the single-line POSIX `sh` script `command` on the remote host with `args` as
    /// its positional parameters, applying the forwards and forwarding-failure behavior
    /// described by `options`. Stdio is inherited so the user can observe remote output
    /// and interact with the process when needed.
    ///
    /// Returns the ssh exit status. Callers are responsible for translating
    /// a non-zero status into their own error handling.
    pub(super) async fn run(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
    ) -> Result<std::process::ExitStatus, std::io::Error> {
        log!(
            Level::Debug,
            "SSH run requested: target={}, ssh_server_port={}, username={:?}, command={}, args={:?}, reverse_forwards={}, has_secret={}, log_file={:?}, managed_agent={}, compressed={}",
            self.target,
            self.server_port_label(),
            self.username,
            command,
            args,
            options.reverse_forwards.len(),
            options.secret_env.is_some(),
            options.log_file,
            options.managed_agent,
            options.compressed
        );
        let mut ssh = build_ssh_command(self, command, args, options).await?;

        log!(
            Level::Debug,
            "Running ssh command: target={}, argv={}",
            self.target,
            ssh_command_argv_debug(ssh.command())
        );

        ssh.command().kill_on_drop(true);
        let start = std::time::Instant::now();
        let (mut child, _ssh_agent) = ssh.spawn()?;
        let status = child.wait().await?;
        log!(
            Level::Debug,
            "SSH run completed: target={}, command={}, exit_status={}, elapsed={:?}",
            self.target,
            command,
            status.code().unwrap_or(-1),
            start.elapsed()
        );
        Ok(status)
    }

    /// Streams a script to `sh -s` on the remote host and captures stdout.
    /// Sending the script through stdin keeps multiline probes readable and
    /// avoids embedding shell syntax in the SSH command argument. Stderr is
    /// captured so preparation failures can reach the lifecycle UI.
    pub(super) async fn run_script_captured(
        &self,
        stage: &str,
        script: &str,
        options: &SshRunOptions,
    ) -> Result<String, std::io::Error> {
        log!(
            Level::Debug,
            "SSH run_script_captured started: target={}, ssh_server_port={}, username={:?}, script_bytes={}, compressed={}, has_secret={}",
            self.target,
            self.server_port_label(),
            self.username,
            script.len(),
            options.compressed,
            options.secret_env.is_some()
        );
        // Streamed scripts may span lines, which a `sh -c` argument cannot for csh-family
        // login shells, so the wrapper only replaces itself with a stdin-reading shell.
        let mut ssh = build_ssh_command(self, "exec sh -s", &[], options).await?;
        ssh.command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        log!(
            Level::Debug,
            "Running ssh script through target={}, argv={}",
            self.target,
            ssh_command_argv_debug(ssh.command())
        );

        let start = std::time::Instant::now();
        let (mut child, _ssh_agent) = ssh.spawn().map_err(|error| {
            redoor_core::log_failure!(
                Level::Error,
                "SSH run_script_captured failed to spawn: target={}, error={:#}, elapsed={:?}",
                self.target,
                error,
                start.elapsed()
            );
            error
        })?;
        let mut stdin = child.stdin.take().expect("script requires piped ssh stdin");
        let stdout = child
            .stdout
            .take()
            .expect("script requires piped ssh stdout");
        let stderr = child
            .stderr
            .take()
            .expect("script requires piped ssh stderr");
        let stdout_handle = tokio::spawn(read_bounded_tail(stdout, MAX_SSH_DIAGNOSTIC_BYTES));
        let stderr_handle = tokio::spawn(read_bounded_tail(stderr, MAX_SSH_DIAGNOSTIC_BYTES));
        let write_result = stdin.write_all(script.as_bytes()).await;
        // Closing stdin tells the remote shell that the complete script has arrived.
        drop(stdin);

        let status = child.wait().await?;
        let stdout = join_diagnostic_reader(stdout_handle, "stdout").await?;
        let stderr = join_diagnostic_reader(stderr_handle, "stderr").await?;
        log!(
            Level::Debug,
            "SSH run_script_captured completed: target={}, exit_status={}, elapsed={:?}, stdout_bytes={}, stderr_bytes={}",
            self.target,
            status.code().unwrap_or(-1),
            start.elapsed(),
            stdout.len(),
            stderr.len()
        );
        if !status.success() {
            redoor_core::log_failure!(
                Level::Error,
                "SSH run_script_captured failed with non-zero status: target={}, stage={}, status={}, stderr='{}'",
                self.target,
                stage,
                status.code().unwrap_or(-1),
                sanitized_ssh_text(self, &stderr)
            );
            return Err(std::io::Error::other(format_ssh_failure(
                self, stage, status, &stderr,
            )));
        }
        write_result.map_err(|error| {
            std::io::Error::other(format!(
                "failed to stream script through ssh stdin: {error}"
            ))
        })?;
        let output = String::from_utf8_lossy(&stdout).to_string();
        log!(
            Level::Debug,
            "SSH run_script_captured succeeded: target={}, output_bytes={}, output_preview='{}'",
            self.target,
            output.len(),
            sanitized_ssh_text(self, &stdout)
                .chars()
                .take(200)
                .collect::<String>()
        );
        Ok(output)
    }

    /// Runs the single-line POSIX `sh` script `command` with stdin closed and stderr
    /// captured, and returns the exit status instead of turning a failure into an error.
    /// Used where a failing ssh is an expected answer: the host key probe always fails to
    /// authenticate, and enrollment tries several credentials in turn.
    pub(super) async fn output(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
    ) -> Result<SshOutput, std::io::Error> {
        let mut ssh = build_ssh_command(self, command, args, options).await?;
        ssh.command()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        log!(
            Level::Debug,
            "Running captured ssh command: target={}, argv={}",
            self.target,
            ssh_command_argv_debug(ssh.command())
        );
        let (mut child, _ssh_agent) = ssh.spawn()?;
        let stderr = child
            .stderr
            .take()
            .expect("output requires piped ssh stderr");
        let stderr_handle = tokio::spawn(read_bounded_tail(stderr, MAX_SSH_DIAGNOSTIC_BYTES));
        let status = child.wait().await?;
        Ok(SshOutput {
            status,
            stderr: join_diagnostic_reader(stderr_handle, "stderr").await?,
        })
    }

    /// Turns a failed [`SshHost::output`] into the same sanitized guidance other ssh
    /// failures get.
    pub(super) fn failure_message(&self, stage: &str, output: &SshOutput) -> String {
        format_ssh_failure(self, stage, output.status, &output.stderr)
    }

    /// Streams `local_path` into the stdin of the single-line `sh` script `command`, which
    /// writes it into place on the device. Streaming (rather than scp/sftp) never reads the
    /// whole binary into memory, and letting one script create the directory, write a temp
    /// file, mark it executable and rename it costs one SSH session instead of one each.
    ///
    /// Stderr is captured so remote failures (permission denied, disk full) become part of
    /// the returned error instead of a bare local Broken pipe.
    pub(super) async fn upload(
        &self,
        local_path: &Path,
        command: &str,
        stage: &str,
    ) -> Result<(), std::io::Error> {
        // Compress the upload stream so large binaries transfer faster over
        // slow uplinks. ssh compression is cheap and transparent here. Going through the
        // shared builder keeps the upload under the same host key and credential policies
        // as every other connection to the device.
        let options = SshRunOptions::default().compressed();
        let mut ssh = build_ssh_command(self, command, &[], &options).await?;

        // Capture stderr so prepare/watchdog logs include the remote reason
        // instead of only the local Broken pipe that follows an early remote exit.
        ssh.command()
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        log!(
            Level::Debug,
            "SSH upload starting: target={}, ssh_server_port={}, username={:?}, stage={}, local_path={}, argv={}",
            self.target,
            self.server_port_label(),
            self.username,
            stage,
            local_path.display(),
            ssh_command_argv_debug(ssh.command())
        );

        let upload_start = std::time::Instant::now();
        let mut file = tokio::fs::File::open(local_path).await.map_err(|error| {
            redoor_core::log_failure!(
                Level::Error,
                "SSH upload failed to open local file: target={}, stage={}, local_path={}, error={:#}",
                self.target,
                stage,
                local_path.display(),
                error
            );
            std::io::Error::other(format!(
                "failed to open '{}' for the {stage}: {error}",
                local_path.display()
            ))
        })?;
        let (mut child, _ssh_agent) = ssh.spawn().map_err(|error| {
            redoor_core::log_failure!(
                Level::Error,
                "SSH upload failed to spawn: target={}, stage={}, error={:#}",
                self.target,
                stage,
                error
            );
            error
        })?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        // Run the copy on a separate task so we can concurrently wait for
        // the child. If the remote script exits early (e.g. disk full), the
        // stdin pipe closes and the copy errors out; without the spawn we
        // would deadlock waiting on a write that never completes.
        let copy_handle = tokio::spawn(async move {
            tokio::io::copy(&mut file, &mut stdin).await?;
            // Drop stdin to send EOF so the remote `cat` flushes and exits.
            drop(stdin);
            Ok::<_, std::io::Error>(())
        });
        // Drain stderr while the child runs so a full pipe cannot block exit.
        let stderr_handle = tokio::spawn(read_bounded_tail(stderr, MAX_SSH_DIAGNOSTIC_BYTES));

        let status = child.wait().await?;
        let stderr_bytes = join_diagnostic_reader(stderr_handle, "stderr").await?;
        let stderr = sanitized_ssh_text(self, &stderr_bytes);
        let stderr_trim = stderr.trim();

        // Prefer remote failure details over the copy-task Broken pipe that
        // appears whenever the remote script exits before the local stream finishes.
        let copy_result = copy_handle
            .await
            .map_err(|e| std::io::Error::other(format!("copy task panicked: {e}")))?;

        if !status.success() {
            redoor_core::log_failure!(
                Level::Error,
                "SSH upload failed on the remote host: target={}, stage={}, exit_status={}, elapsed={:?}, stderr='{}'",
                self.target,
                stage,
                status.code().unwrap_or(-1),
                upload_start.elapsed(),
                stderr_trim
            );
            return Err(std::io::Error::other(format_ssh_failure(
                self,
                stage,
                status,
                &stderr_bytes,
            )));
        }

        copy_result.map_err(|e| {
            redoor_core::log_failure!(
                Level::Error,
                "SSH upload copy task failed: target={}, stage={}, error={:#}, elapsed={:?}",
                self.target,
                stage,
                e,
                upload_start.elapsed()
            );
            std::io::Error::other(format!(
                "failed while streaming '{}' for the {stage}: {:#}",
                local_path.display(),
                e
            ))
        })?;
        log!(
            Level::Debug,
            "SSH upload succeeded: target={}, stage={}, elapsed={:?}, stderr='{}'",
            self.target,
            stage,
            upload_start.elapsed(),
            stderr_trim
        );
        Ok(())
    }

    /// Spawns like [`SshHost::spawn`], but first reads the `lines` report lines the remote
    /// script prints on stdout before it `exec`s the long-running process. Reporting and
    /// starting in one session saves a separate SSH round-trip for the report.
    ///
    /// With a log file, the report is read without buffering ahead, so the rest of the
    /// output stays in the child's pipes for its owner to forward into the size-bounded
    /// log exactly like an ordinary spawn, keeping the exit diagnostic intact. Without one,
    /// the rest goes to the server's terminal. Stderr is piped until the report is
    /// complete, so when the session ends early, typically because SSH itself failed, the
    /// returned error carries OpenSSH's explanation even for agents with a log file.
    pub(super) async fn spawn_with_report(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
        lines: usize,
        stage: &str,
    ) -> Result<ReportedChild, std::io::Error> {
        let mut options = options.clone();
        options.pipe_stdout = true;
        let caller_pipes_stderr = options.pipe_stderr;
        options.pipe_stderr = true;
        let mut child = self.spawn(command, args, &options).await?;
        let mut stdout = child
            .stdout
            .take()
            .expect("report requires piped ssh stdout");
        let report = match read_report_lines(&mut stdout, lines).await {
            Ok(report) => report,
            Err(error) => {
                redoor_core::log_failure!(
                    Level::Error,
                    "SSH report could not be read: target={}, stage={}, error={:#}",
                    self.target,
                    stage,
                    error
                );
                // kill_on_drop stops the ssh client when the child is dropped here.
                return Err(std::io::Error::other(format!(
                    "failed to read the {stage} report from ssh: {error}"
                )));
            }
        };
        if report.len() < lines {
            return Err(self
                .report_cut_short(child, stage, &report, options.log_file.as_ref())
                .await);
        }
        if options.log_file.is_some() {
            // Both pipes go back to the child; the owner forwards them into the log.
            child.stdout = Some(stdout);
        } else {
            forward_output(stdout, OutputStream::Stdout);
            if !caller_pipes_stderr && let Some(stderr) = child.stderr.take() {
                // The caller expected stderr on the terminal, as an ordinary spawn would
                // have arranged.
                forward_output(stderr, OutputStream::Stderr);
            }
        }
        Ok(ReportedChild { child, report })
    }

    /// Explains a session that ended before its report was complete, using the ssh exit
    /// status and stderr. The stderr is also appended to the agent log file, if any, so
    /// the log holds the failure like it would for an ordinary spawn.
    async fn report_cut_short(
        &self,
        mut child: tokio::process::Child,
        stage: &str,
        report: &[String],
        log_file: Option<&LogFileSpec>,
    ) -> std::io::Error {
        let stderr = child
            .stderr
            .take()
            .expect("report requires piped ssh stderr");
        let (status, stderr) = tokio::join!(
            child.wait(),
            read_bounded_tail(stderr, MAX_SSH_DIAGNOSTIC_BYTES)
        );
        let stderr = stderr.unwrap_or_default();
        if let Some(log_file) = log_file
            && !stderr.is_empty()
        {
            append_to_log(log_file, &stderr).await;
        }
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                redoor_core::log_failure!(
                    Level::Error,
                    "SSH session ended before its report and could not be waited for: target={}, stage={}, error={:#}",
                    self.target,
                    stage,
                    error
                );
                return error;
            }
        };
        redoor_core::log_failure!(
            Level::Error,
            "SSH session ended before its report was complete: target={}, stage={}, exit_status={}, report_lines={:?}, stderr='{}'",
            self.target,
            stage,
            status.code().unwrap_or(-1),
            report,
            sanitized_ssh_text(self, &stderr)
        );
        std::io::Error::other(format_ssh_failure(self, stage, status, &stderr))
    }
}

/// A spawned remote process together with the report its launch script printed first.
pub(super) struct ReportedChild {
    /// The ssh client process, still running the remote process.
    pub(super) child: tokio::process::Child,
    /// The report lines, without line endings.
    pub(super) report: Vec<String>,
}

/// Upper bound for one report line, so a remote binary printing garbage cannot make the
/// server buffer an unbounded line.
const MAX_REPORT_LINE_BYTES: u64 = 4 * 1024;

/// Reads up to `lines` lines, stopping early at EOF. Lines are bounded and returned
/// without their line endings.
///
/// Reads one byte at a time so nothing after the report is consumed: the rest of the
/// output must stay in the pipe for whoever forwards it into the agent log. The report is
/// a handful of short lines, so the extra reads are negligible.
async fn read_report_lines(
    reader: &mut tokio::process::ChildStdout,
    lines: usize,
) -> Result<Vec<String>, std::io::Error> {
    use tokio::io::AsyncReadExt;

    let mut report = Vec::with_capacity(lines);
    let mut line = Vec::new();
    while report.len() < lines {
        let mut byte = [0_u8; 1];
        if reader.read(&mut byte).await? == 0 {
            break;
        }
        if byte[0] == b'\n' {
            let text = String::from_utf8_lossy(&line);
            report.push(text.trim_end_matches('\r').to_string());
            line.clear();
            continue;
        }
        if line.len() as u64 >= MAX_REPORT_LINE_BYTES {
            return Err(std::io::Error::other(format!(
                "report line {} is longer than {MAX_REPORT_LINE_BYTES} bytes",
                report.len() + 1
            )));
        }
        line.push(byte[0]);
    }
    Ok(report)
}

/// Appends `bytes` to the agent log file, logging instead of failing because the caller
/// is already reporting a more important error.
async fn append_to_log(log_file: &LogFileSpec, bytes: &[u8]) {
    let result = async { log_file.open().await?.write_message(bytes).await }.await;
    if let Err(error) = result {
        redoor_core::log_failure!(
            Level::Error,
            "Appending SSH diagnostics to the agent log failed: log_file={}, error={:#}",
            log_file.path.display(),
            error
        );
    }
}

/// Which of this process's streams a reported child's output goes to without a log file.
#[derive(Debug, Clone, Copy)]
enum OutputStream {
    /// The remote process's stdout.
    Stdout,
    /// The remote process's stderr.
    Stderr,
}

/// Copies the rest of a reported child's output to this process's matching stream, which
/// is where it goes for ordinary spawns without a log file. Draining it also keeps a full
/// pipe from blocking the remote process.
fn forward_output(
    mut reader: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    stream: OutputStream,
) {
    tokio::spawn(async move {
        let result = match stream {
            OutputStream::Stdout => tokio::io::copy(&mut reader, &mut tokio::io::stdout()).await,
            OutputStream::Stderr => tokio::io::copy(&mut reader, &mut tokio::io::stderr()).await,
        };
        if let Err(error) = result {
            redoor_core::log_failure!(
                Level::Error,
                "Forwarding remote agent output failed: stream={:?}, error={:#}",
                stream,
                error
            );
            // Keep draining so the remote process never blocks on a full pipe.
            let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
        }
    });
}

/// Captured result of [`SshHost::output`].
pub(super) struct SshOutput {
    /// Exit status of the ssh process; 255 means ssh itself failed.
    pub(super) status: std::process::ExitStatus,
    /// Bounded tail of ssh's and the remote command's stderr.
    pub(super) stderr: Vec<u8>,
}

/// Converts a diagnostic reader task into an I/O result with a useful stream name.
async fn join_diagnostic_reader(
    handle: tokio::task::JoinHandle<Result<Vec<u8>, std::io::Error>>,
    stream: &str,
) -> Result<Vec<u8>, std::io::Error> {
    handle
        .await
        .map_err(|error| std::io::Error::other(format!("{stream} task panicked: {error}")))?
}

/// Sends a secret first line while retaining the pipe so detached stdin cannot stop the agent.
async fn write_secret_and_retain_stdin(
    child: &mut tokio::process::Child,
    value: &str,
) -> Result<(), std::io::Error> {
    let mut child_stdin = child
        .stdin
        .take()
        .expect("secret environment requires piped ssh stdin");
    child_stdin.write_all(value.as_bytes()).await?;
    child_stdin.write_all(b"\n").await?;
    // The remote agent uses EOF to detect a lost SSH channel. Keeping this writer
    // with the child prevents `/dev/null` in daemon and service contexts from
    // looking like a disconnect immediately after the token preamble is consumed.
    child.stdin = Some(child_stdin);
    Ok(())
}

/// Builds the [`Command`] used by every ssh invocation: [`SshHost::run`],
/// [`SshHost::spawn`], scripts and uploads. Being the only place that creates an `ssh`
/// command means no connection can bypass the host key and credential policies.
async fn build_ssh_command(
    host: &SshHost,
    command: &str,
    args: &[&str],
    options: &SshRunOptions,
) -> Result<SshCommand, std::io::Error> {
    // Managed-key connections ignore the config files, so their routing is resolved first,
    // and they authenticate through their own in-process ssh-agent.
    let (routing, ssh_agent) = match &host.auth {
        AuthPolicy::ManagedKey { key } => (
            Some(ResolvedRouting::resolve(host).await?),
            Some(SshAgentSocket::bind(key.clone()).await?),
        ),
        _ => (None, None),
    };
    let ssh_agent_paths = ssh_agent.as_ref().map(|socket| SshAgentPaths {
        socket: socket.socket_path(),
        public_key: socket.public_key_path(),
    });
    let mut ssh = Command::new("ssh");
    ssh.args(ssh_argv(
        host,
        routing.as_ref(),
        ssh_agent_paths.as_ref(),
        command,
        args,
        options,
    ));
    if let AuthPolicy::Password(password) = &host.auth {
        apply_askpass_env(&mut ssh, password)?;
    }

    if options.secret_env.is_some() {
        ssh.stdin(Stdio::piped());
    } else {
        ssh.stdin(Stdio::inherit());
    }

    let route = output_route(options);
    // A report reader needs stdout piped even when the rest of the output reaches the
    // terminal; a log file needs both streams piped so their owner can forward them.
    if route == OutputRoute::LogFile || options.pipe_stdout {
        ssh.stdout(Stdio::piped());
    } else {
        ssh.stdout(Stdio::inherit());
    }
    if route == OutputRoute::Inherit {
        ssh.stderr(Stdio::inherit());
    } else {
        ssh.stderr(Stdio::piped());
    }

    log!(
        Level::Debug,
        "Built SSH command: target={}, ssh_server_port={}, command={}, args={:?}, argv={}, reverse_forwards={:?}, has_secret={}, log_file={:?}, managed_agent={}, pipe_stderr={}, compressed={}, output_route={:?}",
        host.target,
        host.server_port_label(),
        command,
        args,
        ssh_command_argv_debug(&ssh),
        options
            .reverse_forwards
            .iter()
            .map(|f| f.to_ssh_spec())
            .collect::<Vec<_>>(),
        options.secret_env.is_some(),
        options.log_file,
        options.managed_agent,
        options.pipe_stderr,
        options.compressed,
        output_route(options)
    );

    Ok(SshCommand {
        command: ssh,
        ssh_agent,
    })
}

/// Collects `-o Name=value` pairs so tests can assert every security relevant option is
/// emitted exactly once.
#[derive(Default)]
struct OptionWriter {
    /// Already rendered `-o` / value argument pairs, in emission order.
    args: Vec<String>,
}

impl OptionWriter {
    /// Emits one option. Callers emit each name once; OpenSSH would ignore a second value.
    fn set(&mut self, name: &str, value: impl std::fmt::Display) {
        self.args.push("-o".to_string());
        self.args.push(format!("{name}={value}"));
    }

    /// Emits an option whose value is a file path, quoted so whitespace does not split it and
    /// with `%` escaped because OpenSSH expands `%` tokens in these options.
    fn set_path(&mut self, name: &str, path: &Path) {
        self.set(name, quote_ssh_path(path));
    }
}

/// Quotes a path for an OpenSSH option value: OpenSSH splits option values on whitespace
/// unless quoted and expands `%` tokens in file options. The data dir can contain spaces,
/// for example on macOS.
fn quote_ssh_path(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

impl HostKeyPolicy {
    /// Writes this policy's host key options, each once.
    fn write_options(&self, options: &mut OptionWriter) {
        let (strict, known_hosts, alias) = match self {
            Self::TrustOnFirstUse => {
                // Managed SSH has no TTY for host-key prompts; accept-new still rejects changed keys.
                options.set("StrictHostKeyChecking", "accept-new");
                return;
            }
            Self::Probe { known_hosts, alias } => ("accept-new", known_hosts, alias),
            Self::Pinned(pinned) => ("yes", &pinned.known_hosts, &pinned.alias),
        };
        options.set("StrictHostKeyChecking", strict);
        options.set_path("UserKnownHostsFile", known_hosts);
        // Nothing outside the device's own file may vouch for (or hide) its host key.
        options.set("GlobalKnownHostsFile", "/dev/null");
        options.set("KnownHostsCommand", "none");
        options.set("VerifyHostKeyDNS", "no");
        // User config may exempt loopback destinations from all host key checks.
        options.set("NoHostAuthenticationForLocalhost", "no");
        // Diagnostics must use the same fingerprint format as the confirmation UI.
        options.set("FingerprintHash", "sha256");
        // The device must not be able to add keys to its own pin.
        options.set("UpdateHostKeys", "no");
        // Plain entries let redoor read the recorded key back, and no IP entries are added.
        options.set("HashKnownHosts", "no");
        options.set("CheckHostIP", "no");
        // Looked up by device id instead of host:port, so a target or port change that
        // reaches the same machine keeps matching and a different machine never does.
        options.set("HostKeyAlias", alias);
    }
}

impl AuthPolicy {
    /// Writes this policy's credential options, each once. A managed key needs the paths of
    /// its ssh-agent; without them no identity is offered at all, so the login fails closed.
    fn write_options(&self, options: &mut OptionWriter, ssh_agent: Option<&SshAgentPaths>) {
        match self {
            Self::Default => {
                // BatchMode prevents OpenSSH from reading a password or keyboard-interactive
                // answer from a terminal, so managed startup fails instead of hanging.
                options.set("BatchMode", "yes");
                options.set("NumberOfPasswordPrompts", 0);
            }
            Self::Password(_) => {
                // A second identical askpass answer cannot succeed, so fail on the first attempt.
                // Override host configuration that would otherwise disable askpass entirely.
                options.set("BatchMode", "no");
                options.set("NumberOfPasswordPrompts", 1);
            }
            Self::NoAuth => {
                options.set("BatchMode", "yes");
                options.set("NumberOfPasswordPrompts", 0);
                options.set("PreferredAuthentications", "none");
            }
            Self::ManagedKey { .. } => {
                // The public key file selects the one identity the in-process ssh-agent
                // holds; no private key file exists for ssh to read.
                options.set("IdentitiesOnly", "yes");
                match ssh_agent {
                    Some(ssh_agent) => {
                        options.set_path("IdentityFile", &ssh_agent.public_key);
                        options.set_path("IdentityAgent", &ssh_agent.socket);
                    }
                    None => {
                        options.set("IdentityFile", "none");
                        options.set("IdentityAgent", "none");
                    }
                }
                // A broken key must fail loudly instead of falling back to a password.
                options.set("PasswordAuthentication", "no");
                options.set("KbdInteractiveAuthentication", "no");
                options.set("PreferredAuthentications", "publickey");
                options.set("BatchMode", "yes");
                options.set("NumberOfPasswordPrompts", 0);
            }
        }
    }
}

/// Builds the complete ssh argv for one invocation from the host's policies, the resolved
/// routing (managed-key connections only) and the per-call options.
fn ssh_argv(
    host: &SshHost,
    routing: Option<&ResolvedRouting>,
    ssh_agent: Option<&SshAgentPaths>,
    command: &str,
    args: &[&str],
    options: &SshRunOptions,
) -> Vec<String> {
    let mut argv = Vec::new();
    let mut ssh_options = OptionWriter::default();
    match routing {
        Some(routing) => {
            // `IdentityFile`, forwards and environment settings accumulate across config
            // files and cannot be reset, so managed-key connections read no config file and
            // get the routing that `ssh -G` resolved for them instead. User and port are
            // part of that routing.
            argv.push("-F".to_string());
            argv.push("none".to_string());
            for (name, value) in &routing.options {
                ssh_options.set(name, value);
            }
        }
        None => {
            if let Some(ref username) = host.username {
                argv.push("-l".to_string());
                argv.push(username.clone());
            }
            if let Some(port) = host.ssh_port {
                argv.push("-p".to_string());
                argv.push(port.to_string());
            }
        }
    }
    if options.compressed {
        argv.push("-C".to_string());
    }
    argv.push("-T".to_string());
    // Always fail fast if a requested reverse forward cannot be bound.
    // Without this, ssh keeps running and the remote command executes
    // against a tunnel that will never come up.
    ssh_options.set("ExitOnForwardFailure", "yes");
    // Keeps a failed multiplexed session from leaving reverse forwards on an old master,
    // and makes every step of an enrollment authenticate on its own.
    ssh_options.set("ControlMaster", "no");
    ssh_options.set("ControlPath", "none");
    if !routing.is_some_and(|routing| {
        routing
            .options
            .iter()
            .any(|(name, _)| name == "ConnectTimeout")
    }) {
        ssh_options.set("ConnectTimeout", SSH_CONNECT_TIMEOUT_SECONDS);
    }
    host.host_key.write_options(&mut ssh_options);
    host.auth.write_options(&mut ssh_options, ssh_agent);
    argv.extend(ssh_options.args);
    for forward in &options.reverse_forwards {
        argv.push("-R".to_string());
        argv.push(forward.to_ssh_spec());
    }

    // A session-supplied target beginning with '-' must never become a local SSH option.
    argv.push("--".to_string());
    argv.push(host.target.clone());
    let mut script = String::new();
    if let Some((name, _)) = &options.secret_env {
        // Keep the secret out of both the local ssh argv and the remote agent argv,
        // since either can be exposed by process listings. `spawn` writes the value
        // as the first stdin line; this preamble reads and exports it so the agent the
        // script `exec`s inherits it only through its environment.
        script.push_str(&format!("read -r {name}; export {name}; "));
    }
    if options.managed_agent {
        script.push_str(&format!(
            "export {}=1; ",
            redoor_core::process::MANAGED_AGENT_ENV
        ));
    }
    script.push_str(command);
    // The login shell only sees quoted words, so fish or tcsh users get the same POSIX
    // script and arguments with spaces or quotes are not split or interpreted.
    argv.push(super::shell::sh_command(&script, args));
    argv
}

/// Connection routing resolved from the user's ssh config for a managed-key connection,
/// which then runs with `-F none`.
struct ResolvedRouting {
    /// Safelisted `(option, value)` pairs passed as `-o` options.
    options: Vec<(String, String)>,
}

/// Options copied from `ssh -G` because they decide how to reach the host and how the
/// transport behaves. Nothing that carries credentials, forwards or environment is copied.
/// An unset `ConnectTimeout` falls back to redoor's bounded default.
const ROUTING_SAFELIST: &[(&str, &str)] = &[
    ("hostname", "HostName"),
    ("port", "Port"),
    ("user", "User"),
    ("addressfamily", "AddressFamily"),
    ("bindaddress", "BindAddress"),
    ("bindinterface", "BindInterface"),
    ("connecttimeout", "ConnectTimeout"),
    ("serveraliveinterval", "ServerAliveInterval"),
    ("serveralivecountmax", "ServerAliveCountMax"),
    ("tcpkeepalive", "TCPKeepAlive"),
    ("ipqos", "IPQoS"),
    ("ciphers", "Ciphers"),
    ("macs", "MACs"),
    ("kexalgorithms", "KexAlgorithms"),
    ("hostkeyalgorithms", "HostKeyAlgorithms"),
    ("proxycommand", "ProxyCommand"),
];

impl ResolvedRouting {
    /// Runs `ssh -G` for the host. It evaluates `~/.ssh/config` and the system config,
    /// including `Host` and `Match` blocks, and prints the effective options without
    /// connecting.
    async fn resolve(host: &SshHost) -> Result<Self, std::io::Error> {
        let output = SshConfigDump::load(host).await?;
        Ok(Self::from_dump(&output))
    }

    /// Picks the safelisted options from an `ssh -G` dump and turns a `ProxyJump` into an
    /// explicit `ProxyCommand`.
    fn from_dump(dump: &SshConfigDump) -> Self {
        let mut options = Vec::new();
        for (key, name) in ROUTING_SAFELIST {
            if let Some(value) = dump.get(key).filter(|value| *value != "none") {
                options.push((name.to_string(), value.to_string()));
            }
        }
        let has_proxy_command = options.iter().any(|(name, _)| name == "ProxyCommand");
        if !has_proxy_command
            && let Some(jumps) = dump.get("proxyjump").filter(|value| *value != "none")
            && let (Some(hostname), Some(port)) = (dump.get("hostname"), dump.get("port"))
        {
            options.push((
                "ProxyCommand".to_string(),
                proxy_jump_command(jumps, hostname, port),
            ));
        }
        Self { options }
    }
}

/// Turns a resolved `ProxyJump` list into the `ProxyCommand` OpenSSH itself would run.
///
/// With `-F none` OpenSSH would pass `-F none` on to the jump host's ssh too, which would
/// lose that host's user, port and keys. The explicit command runs a normal `ssh`, so jump
/// hosts are reached exactly as the user's config describes and only the final hop is
/// isolated. The last jump is the `-W` destination, the earlier ones go to `-J`.
fn proxy_jump_command(jumps: &str, hostname: &str, port: &str) -> String {
    let mut hops: Vec<&str> = jumps.split(',').filter(|hop| !hop.is_empty()).collect();
    let last = hops.pop().unwrap_or(jumps);
    let destination = if last.starts_with("ssh://") {
        last.to_string()
    } else {
        // The URI form is the only destination syntax that accepts `host:port`.
        format!("ssh://{last}")
    };
    let mut command = "ssh".to_string();
    if !hops.is_empty() {
        command.push_str(" -J ");
        command.push_str(&shell_quote_proxy_arg(&hops.join(",")));
    }
    // Quote the resolved destination itself. OpenSSH substitutes %h after shell quoting,
    // so placeholders would allow hostile hostnames to break out on older SSH clients.
    command.push_str(" -W ");
    command.push_str(&shell_quote_proxy_arg(&format!("[{hostname}]:{port}")));
    command.push(' ');
    command.push_str(&shell_quote_proxy_arg(&destination));
    command
}

/// Single-quotes a value for the shell that runs `ProxyCommand`, escaping `%` because
/// OpenSSH expands `%` tokens in the command before the shell sees it.
fn shell_quote_proxy_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'").replace('%', "%%"))
}

/// The effective client options for one host as printed by `ssh -G`.
pub(super) struct SshConfigDump {
    /// Lowercase option name to value, in the order printed.
    entries: Vec<(String, String)>,
}

impl SshConfigDump {
    /// Runs `ssh -G` with the host's username and port overrides.
    pub(super) async fn load(host: &SshHost) -> Result<Self, std::io::Error> {
        let mut ssh = Command::new("ssh");
        ssh.arg("-G");
        if let Some(ref username) = host.username {
            ssh.arg("-l").arg(username);
        }
        if let Some(port) = host.ssh_port {
            ssh.arg("-p").arg(port.to_string());
        }
        // Config resolution has the same option-injection boundary as a real connection.
        ssh.arg("--").arg(&host.target);
        ssh.stdin(Stdio::null());
        ssh.kill_on_drop(true);
        let output = ssh.output().await?;
        if !output.status.success() {
            return Err(std::io::Error::other(format!(
                "Failed to resolve the ssh config for '{}': {}",
                sanitized_ssh_text(host, host.target.as_bytes()),
                sanitized_ssh_text(host, &output.stderr).trim()
            )));
        }
        Ok(Self::parse(&String::from_utf8_lossy(&output.stdout)))
    }

    /// Parses `key value` lines.
    fn parse(output: &str) -> Self {
        let entries = output
            .lines()
            .filter_map(|line| {
                let (key, value) = line.split_once(' ')?;
                Some((key.to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect();
        Self { entries }
    }

    /// The first value printed for `key` (lowercase).
    pub(super) fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

/// Formats argv only so configured passwords in the child environment stay out of logs.
fn ssh_command_argv_debug(ssh: &Command) -> String {
    let std_cmd = ssh.as_std();
    let mut parts = vec![std_cmd.get_program().to_string_lossy().into_owned()];
    parts.extend(
        std_cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned()),
    );
    format!("{parts:?}")
}

/// Points OpenSSH at this binary as `SSH_ASKPASS` so password auth can use a
/// separate process instead of the SSH stdin already reserved for secrets and uploads.
fn apply_askpass_env(ssh: &mut Command, password: &str) -> Result<(), std::io::Error> {
    // The path stays valid after `redoor upgrade` replaced the running binary.
    let exe = redoor_core::executable::current().map_err(|error| {
        std::io::Error::other(format!(
            "failed to locate redoor executable for SSH_ASKPASS: {error}"
        ))
    })?;
    ssh.env("SSH_ASKPASS", &exe);
    ssh.env("SSH_ASKPASS_REQUIRE", "force");
    ssh.env(super::askpass::ENV, "1");
    ssh.env(super::askpass::PASSWORD_ENV, password);
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        // Older OpenSSH refuses to invoke SSH_ASKPASS unless a display is advertised.
        ssh.env("DISPLAY", ":0");
    }
    Ok(())
}

/// Removes terminal controls, misleading direction markers, and configured credentials from SSH text.
fn sanitized_ssh_text(host: &SshHost, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let mut safe: String = text
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            )
        })
        .map(|character| {
            if character == '\n' || character == '\t' || !character.is_control() {
                character
            } else {
                ' '
            }
        })
        .collect();
    if let AuthPolicy::Password(password) = &host.auth
        && !password.is_empty()
    {
        safe = safe.replace(password.as_str(), "[redacted]");
    }
    safe
}

/// Explains a pinned host key that no longer matches, with both fingerprints, so the user
/// can decide whether to re-pin. `None` when the failure is not a pinned-key mismatch.
fn host_key_change_message(host: &SshHost, diagnostic: &str) -> Option<String> {
    let HostKeyPolicy::Pinned(pinned) = &host.host_key else {
        return None;
    };
    let lower = diagnostic.to_ascii_lowercase();
    // A different key type is reported as "no ... host key is known" instead of "changed".
    if !lower.contains("remote host identification has changed")
        && !lower.contains("host key is known for")
        && !lower.contains("host key verification failed")
    {
        return None;
    }
    let presented =
        presented_host_key_fingerprint(diagnostic).unwrap_or_else(|| "a different key".to_string());
    Some(format!(
        "SSH host key changed. The device presented {presented}, but {} is pinned for it. If the change is expected, re-pin the host key from the device page.",
        pinned.fingerprint
    ))
}

/// Finds the fingerprint OpenSSH prints after "sent by the remote host is" in its
/// changed-host-key warning.
fn presented_host_key_fingerprint(diagnostic: &str) -> Option<String> {
    let after = &diagnostic[diagnostic.find("sent by the remote host is")?..];
    let start = after.find("SHA256:")?;
    let fingerprint: String = after[start..]
        .chars()
        .take_while(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ':' | '+' | '/' | '=')
        })
        .collect();
    Some(fingerprint.trim_end_matches('.').to_string())
}

/// Converts bounded OpenSSH stderr into actionable, sanitized operator guidance.
fn format_ssh_failure(
    host: &SshHost,
    stage: &str,
    status: std::process::ExitStatus,
    stderr: &[u8],
) -> String {
    let diagnostic = sanitized_ssh_text(host, stderr);
    let diagnostic = diagnostic.trim();
    let lower = diagnostic.to_ascii_lowercase();
    if let Some(changed) = host_key_change_message(host, diagnostic) {
        return format!(
            "{changed} Target '{}', stage '{stage}'.\nOpenSSH: {diagnostic}",
            sanitized_ssh_text(host, host.target.as_bytes())
        );
    }
    let summary = if lower.contains("permission denied") || lower.contains("authentication failed")
    {
        match host.auth {
            AuthPolicy::Password(_) => {
                "SSH authentication failed. The configured password or SSH key was rejected."
            }
            AuthPolicy::ManagedKey { .. } => {
                "SSH authentication failed. The device rejected redoor's SSH key for this device; set up the SSH key again from the device page."
            }
            AuthPolicy::Default | AuthPolicy::NoAuth => {
                "SSH authentication requires credentials. Configure a password, SSH key, or ssh-agent credential for this managed agent."
            }
        }
    } else if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
    {
        "SSH host key verification failed. Verify the host key and update known_hosts before retrying."
    } else if lower.contains("could not resolve hostname") {
        "SSH could not resolve the target hostname."
    } else if lower.contains("connection refused") {
        "SSH connection was refused by the target."
    } else if lower.contains("connection timed out") || lower.contains("operation timed out") {
        "SSH connection to the target timed out."
    } else if lower.contains("no route to host") || lower.contains("network is unreachable") {
        "SSH target is unreachable from the server."
    } else {
        "SSH command failed."
    };
    let status = status.code().unwrap_or(-1);
    if diagnostic.is_empty() {
        format!(
            "{summary} Target '{}', stage '{stage}', exit status {status}.",
            sanitized_ssh_text(host, host.target.as_bytes())
        )
    } else {
        format!(
            "{summary} Target '{}', stage '{stage}', exit status {status}.\nOpenSSH: {diagnostic}",
            sanitized_ssh_text(host, host.target.as_bytes())
        )
    }
}

#[cfg(test)]
mod tests {
    /// Protects standalone forwarding monitoring when relay output also has a
    /// persistent log sink, which once redirected stderr away from the monitor.
    #[test]
    fn logged_output_keeps_stderr_piped_for_the_forwarding_monitor() {
        let log_file =
            redoor_core::rotating_log::LogFileSpec::new("/tmp/redoor-relay-test.log", None);
        let options = super::SshRunOptions::default()
            .with_log_file(log_file.clone())
            .with_piped_stderr();

        // Both pipes are needed: stdout for the log and stderr for the bind-failure monitor.
        assert_eq!(super::output_route(&options), super::OutputRoute::LogFile);
        // The log remains available so the monitor can tee remote diagnostics into it.
        assert_eq!(options.log_file(), Some(&log_file));
    }

    /// Keeps the secret-bearing channel open after its first line so daemon stdin EOF is not forwarded.
    #[tokio::test]
    async fn secret_stdin_stays_open_for_the_ssh_child_lifetime() {
        use tokio::io::AsyncWriteExt;

        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("read token; read lifecycle")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("the stdin lifecycle test shell should start");

        super::write_secret_and_retain_stdin(&mut child, "test-token")
            .await
            .expect("the secret line should be written");
        let mut stdin = child
            .stdin
            .take()
            .expect("the SSH child must retain stdin after receiving its secret");
        // A second write proves daemon `/dev/null` was not copied into and allowed to close this pipe.
        stdin
            .write_all(b"channel-still-open\n")
            .await
            .expect("the retained channel should accept lifecycle input");
        drop(stdin);

        let status = child
            .wait()
            .await
            .expect("the stdin lifecycle test shell should exit");
        // Successful reads prove both the secret and retained channel reached the child.
        assert!(status.success(), "the child should read both stdin lines");
    }

    /// Verifies the secret value is delivered through stdin and never embedded
    /// in the local ssh process arguments or remote command arguments.
    #[tokio::test]
    async fn secret_environment_value_is_absent_from_ssh_command() {
        let host = super::SshHost::new("example.test".to_string());
        let options = super::SshRunOptions::default()
            .with_secret_env("REDOOR_AGENT_TOKEN", "top-secret-token");
        let command = super::build_ssh_command(
            &host,
            "/opt/redoor",
            &["agent", "ws://localhost:50000/ws"],
            &options,
        )
        .await
        .unwrap();
        let debug_command = format!("{command:?}");

        // Process listings may expose argv, so the token value must not be there.
        assert!(!debug_command.contains("top-secret-token"));
        // The fixed environment name is safe and proves the remote preamble exports it.
        assert!(debug_command.contains("REDOOR_AGENT_TOKEN"));
        // The remote agent command must still be present after the environment preamble.
        assert!(debug_command.contains("/opt/redoor"));
    }

    /// The remote command line reads the secret, exports the managed marker and passes
    /// arguments with spaces and quotes intact when a login shell runs it the way sshd does.
    #[tokio::test]
    async fn remote_command_runs_in_sh_with_literal_arguments() {
        use tokio::io::AsyncWriteExt;

        let host = super::SshHost::new("example.test".to_string());
        let options = super::SshRunOptions::default()
            .with_secret_env("REDOOR_AGENT_TOKEN", "token value")
            .with_managed_agent();
        let argv = super::ssh_argv(
            &host,
            None,
            None,
            r#"printf '%s|' "$REDOOR_AGENT_TOKEN" "$REDOOR_MANAGED_AGENT" "$@""#,
            &["My Laptop", "it's $(touch pwned)"],
            &options,
        );
        let remote_command = argv.last().unwrap();
        // csh-family login shells reject newlines inside quotes.
        assert!(!remote_command.contains('\n'));

        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_command)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"token value\n").await.unwrap();
        drop(stdin);
        let output = child.wait_with_output().await.unwrap();
        // The secret arrives through stdin, the marker is exported and arguments stay whole.
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "token value|1|My Laptop|it's $(touch pwned)|"
        );
    }

    /// Sequential managed SSH agents share one remote user and must not take the singleton lock.
    #[tokio::test]
    async fn managed_agent_exports_the_skip_lock_environment() {
        let host = super::SshHost::new("example.test".to_string());
        let options = super::SshRunOptions::default()
            .with_secret_env("REDOOR_AGENT_TOKEN", "top-secret-token")
            .with_managed_agent();
        let command = super::build_ssh_command(
            &host,
            "/opt/redoor",
            &["agent", "ws://localhost:50000/ws"],
            &options,
        )
        .await
        .unwrap();
        let debug_command = format!("{command:?}");

        // The remote preamble must mark the process managed so it skips the user-wide PID lock.
        assert!(debug_command.contains("REDOOR_MANAGED_AGENT=1"));
        // Token delivery must still use the stdin preamble after the managed export is added.
        assert!(debug_command.contains("REDOOR_AGENT_TOKEN"));
        assert!(!debug_command.contains("top-secret-token"));
    }

    /// Keeps the configured SSH password out of argv logs while still enabling askpass.
    #[tokio::test]
    async fn password_is_absent_from_logged_ssh_argv() {
        let host = super::SshHost::new("example.test".to_string())
            .password(Some("super-secret-password".to_string()));
        let command =
            super::build_ssh_command(&host, "true", &[], &super::SshRunOptions::default())
                .await
                .unwrap();
        let logged = super::ssh_command_argv_debug(&command.command);

        // Operator logs must not print the configured password.
        assert!(!logged.contains("super-secret-password"));
        // A single prompt avoids three identical askpass failures for a wrong password.
        assert!(logged.contains("NumberOfPasswordPrompts=1"));
        // Host-level BatchMode settings must not disable configured password authentication.
        assert!(logged.contains("BatchMode=no"));

        let envs: Vec<(String, Option<String>)> = command
            .command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        // OpenSSH must call this binary instead of prompting on a TTY.
        assert!(envs.iter().any(|(key, value)| {
            key == "SSH_ASKPASS_REQUIRE" && value.as_deref() == Some("force")
        }));
        assert!(envs.iter().any(|(key, _)| key == "SSH_ASKPASS"));
        assert!(envs.iter().any(|(key, value)| {
            key == super::super::askpass::ENV && value.as_deref() == Some("1")
        }));
    }

    /// Verifies an omitted port preserves SSH host aliases while an explicit
    /// override still produces the expected OpenSSH `-p` arguments.
    #[tokio::test]
    async fn ssh_port_is_only_passed_when_explicitly_configured() {
        let options = super::SshRunOptions::default();
        let configured_host = super::SshHost::new("configured-alias".to_string());
        let configured_command = super::build_ssh_command(&configured_host, "true", &[], &options)
            .await
            .unwrap();
        // Omitting `-p` is what allows OpenSSH to use the alias's configured port.
        assert!(!format!("{configured_command:?}").contains("\"-p\""));
        // Non-interactive sessions must accept unknown hosts instead of prompting.
        assert!(format!("{configured_command:?}").contains("StrictHostKeyChecking=accept-new"));
        // Missing managed credentials must fail rather than opening an interactive prompt.
        assert!(format!("{configured_command:?}").contains("BatchMode=yes"));
        // A configured control master must not retain a forward when opening its session fails.
        assert!(format!("{configured_command:?}").contains("ControlMaster=no"));
        assert!(format!("{configured_command:?}").contains("ControlPath=none"));

        let overridden_host =
            super::SshHost::new("configured-alias".to_string()).ssh_port(Some(2222));
        let overridden_command = super::build_ssh_command(&overridden_host, "true", &[], &options)
            .await
            .unwrap();
        let overridden_debug = format!("{overridden_command:?}");
        // An operator-provided port must override any conflicting SSH configuration.
        assert!(overridden_debug.contains("\"-p\" \"2222\""));
    }

    /// Verifies a reverse route targets the host reachable from the local SSH
    /// client instead of always falling back to that client's localhost.
    #[tokio::test]
    async fn reverse_forward_uses_custom_destination() {
        let host = super::SshHost::new("linux.test".to_string());
        let options =
            super::SshRunOptions::default().with_reverse_forward(3000, "redoor.test", 4000);
        let command = super::build_ssh_command(
            &host,
            "/opt/redoor",
            &["agent", "ws://localhost:3000/ws"],
            &options,
        )
        .await
        .unwrap();
        let debug_command = format!("{command:?}");

        // The Linux listener must route to the destination reached from this machine.
        assert!(debug_command.contains("3000:redoor.test:4000"));
    }

    /// Verifies common OpenSSH failures become concise operator guidance while retaining context.
    #[tokio::test]
    async fn authentication_failure_without_password_is_actionable() {
        let host = super::SshHost::new("example.test".to_string());
        let status = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("exit 255")
            .status()
            .await
            .unwrap();
        let issue = super::format_ssh_failure(
            &host,
            "remote host probe",
            status,
            b"user@example.test: Permission denied (publickey,password).",
        );

        // Operators need the available credential choices instead of an opaque exit code.
        assert!(issue.contains("Configure a password, SSH key, or ssh-agent credential"));
        // Host and OpenSSH context make the configuration problem identifiable.
        assert!(issue.contains("example.test"));
        assert!(issue.contains("Permission denied"));
    }

    /// Verifies a configured but rejected password is not misreported as a missing credential.
    #[tokio::test]
    async fn rejected_password_has_distinct_guidance() {
        let host = super::SshHost::new("example.test".to_string())
            .password(Some("never-render-this".to_string()));
        let status = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("exit 255")
            .status()
            .await
            .unwrap();
        let issue = super::format_ssh_failure(
            &host,
            "remote host probe",
            status,
            b"Permission denied, please try again.",
        );

        // A rejected configured credential needs different remediation from an omitted password.
        assert!(issue.contains("configured password or SSH key was rejected"));
        // Browser diagnostics must never expose the configured secret.
        assert!(!issue.contains("never-render-this"));
    }

    /// Verifies representative transport failures retain distinct browser guidance.
    #[tokio::test]
    async fn transport_failures_have_actionable_guidance() {
        let host = super::SshHost::new("example.test".to_string());
        let status = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("exit 255")
            .status()
            .await
            .unwrap();
        let cases = [
            (
                "Could not resolve hostname example.test",
                "could not resolve",
            ),
            (
                "connect to host example.test: Connection refused",
                "was refused",
            ),
            (
                "connect to host example.test: Connection timed out",
                "timed out",
            ),
            (
                "ssh: connect to host example.test: No route to host",
                "is unreachable",
            ),
            (
                "Host key verification failed.",
                "host key verification failed",
            ),
        ];

        for (diagnostic, expected) in cases {
            let issue = super::format_ssh_failure(
                &host,
                "remote host probe",
                status,
                diagnostic.as_bytes(),
            );
            // Each common transport category should tell operators what failed, not only status 255.
            assert!(
                issue.to_ascii_lowercase().contains(expected),
                "expected '{expected}' in '{issue}'"
            );
        }
    }

    /// Verifies remotely influenced diagnostics cannot inject controls or reveal credentials.
    #[tokio::test]
    async fn ssh_diagnostics_are_sanitized() {
        let host = super::SshHost::new("example.test".to_string())
            .password(Some("secret-password".to_string()));
        let status = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("exit 255")
            .status()
            .await
            .unwrap();
        let issue = super::format_ssh_failure(
            &host,
            "remote host probe",
            status,
            "Permission denied: secret-password\u{1b}[31m\u{202e}".as_bytes(),
        );

        // Browser and log diagnostics must redact configured credentials even if echoed remotely.
        assert!(!issue.contains("secret-password"));
        // Terminal escapes and bidirectional controls must not alter how the issue is displayed.
        assert!(!issue.contains('\u{1b}'));
        assert!(!issue.contains('\u{202e}'));
        assert!(issue.contains("[redacted]"));
    }

    /// A managed key for the policy tests; argv building never uses its private half.
    fn test_key() -> std::sync::Arc<super::SshPrivateKey> {
        std::sync::Arc::new(super::SshPrivateKey::generate().unwrap())
    }

    /// Every `-o` value given for `name` in an argv.
    fn option_values(argv: &[String], name: &str) -> Vec<String> {
        argv.windows(2)
            .filter(|pair| pair[0] == "-o")
            .filter_map(|pair| pair[1].strip_prefix(&format!("{name}=")))
            .map(str::to_string)
            .collect()
    }

    /// One `ssh -G` dump like OpenSSH prints for a host with a jump host and extra keys.
    const CONFIG_DUMP: &str = "user alice
hostname real.example
port 2222
addressfamily any
tcpkeepalive yes
serveralivecountmax 3
serveraliveinterval 0
identityfile ~/.ssh/id_user
certificatefile ~/.ssh/id_user-cert.pub
localforward 8080 [localhost]:80
remoteforward 9090 [localhost]:90
dynamicforward 1080
sendenv LANG
setenv FOO=bar
identitiesonly no
connecttimeout none
ipqos lowdelay throughput
bindaddress none
proxyjump bob@j1:2201,carol@j2
";

    /// For every host key and credential policy combination, each security relevant option
    /// appears exactly once with the policy's value. OpenSSH keeps the first value of an
    /// option, so a duplicate would let an unconditional default shadow a stricter value.
    #[test]
    fn every_policy_combination_emits_each_option_once() {
        let pinned = super::PinnedHostKey {
            known_hosts: "/data/ssh/dev_x/known_hosts".into(),
            alias: "dev_x".to_string(),
            fingerprint: "SHA256:pinned".to_string(),
        };
        let host_keys = [
            ("tofu", super::HostKeyPolicy::TrustOnFirstUse),
            (
                "probe",
                super::HostKeyPolicy::Probe {
                    known_hosts: "/data/ssh/dev_x/.probe".into(),
                    alias: "dev_x".to_string(),
                },
            ),
            ("pinned", super::HostKeyPolicy::Pinned(pinned)),
        ];
        let auths = [
            ("default", super::AuthPolicy::Default),
            (
                "password",
                super::AuthPolicy::Password(zeroize::Zeroizing::new("pw".to_string())),
            ),
            ("none", super::AuthPolicy::NoAuth),
            ("key", super::AuthPolicy::ManagedKey { key: test_key() }),
        ];
        let ssh_agent = super::SshAgentPaths {
            socket: "/run/user/1/redoor-ssh-agent-x/s".into(),
            public_key: "/run/user/1/redoor-ssh-agent-x/id.pub".into(),
        };
        let routing = super::ResolvedRouting::from_dump(&super::SshConfigDump::parse(CONFIG_DUMP));
        for (host_key_name, host_key) in &host_keys {
            for (auth_name, auth) in &auths {
                let host = super::SshHost::new("device".to_string())
                    .username(Some("alice".to_string()))
                    .ssh_port(Some(2222))
                    .host_key(host_key.clone())
                    .auth(auth.clone());
                let is_key = matches!(auth, super::AuthPolicy::ManagedKey { .. });
                let argv = super::ssh_argv(
                    &host,
                    is_key.then_some(&routing),
                    is_key.then_some(&ssh_agent),
                    "true",
                    &[],
                    &super::SshRunOptions::default(),
                );
                let isolated = !matches!(host_key, super::HostKeyPolicy::TrustOnFirstUse);
                let expected: Vec<(&str, Option<&str>)> = vec![
                    (
                        "StrictHostKeyChecking",
                        Some(match *host_key_name {
                            "pinned" => "yes",
                            _ => "accept-new",
                        }),
                    ),
                    (
                        "UserKnownHostsFile",
                        match *host_key_name {
                            "pinned" => Some("\"/data/ssh/dev_x/known_hosts\""),
                            "probe" => Some("\"/data/ssh/dev_x/.probe\""),
                            _ => None,
                        },
                    ),
                    ("GlobalKnownHostsFile", isolated.then_some("/dev/null")),
                    ("KnownHostsCommand", isolated.then_some("none")),
                    ("VerifyHostKeyDNS", isolated.then_some("no")),
                    ("NoHostAuthenticationForLocalhost", isolated.then_some("no")),
                    ("FingerprintHash", isolated.then_some("sha256")),
                    ("UpdateHostKeys", isolated.then_some("no")),
                    ("HostKeyAlias", isolated.then_some("dev_x")),
                    (
                        "BatchMode",
                        Some(match *auth_name {
                            "password" => "no",
                            _ => "yes",
                        }),
                    ),
                    ("IdentitiesOnly", is_key.then_some("yes")),
                    // Only the public key file and the in-process ssh-agent; no private
                    // key file is ever handed to ssh.
                    (
                        "IdentityFile",
                        is_key.then_some("\"/run/user/1/redoor-ssh-agent-x/id.pub\""),
                    ),
                    (
                        "IdentityAgent",
                        is_key.then_some("\"/run/user/1/redoor-ssh-agent-x/s\""),
                    ),
                    ("PasswordAuthentication", is_key.then_some("no")),
                    ("ExitOnForwardFailure", Some("yes")),
                    ("ControlMaster", Some("no")),
                    ("ConnectTimeout", Some("15")),
                ];
                for (name, value) in expected {
                    let values = option_values(&argv, name);
                    // Exactly one value with the policy's setting, or none when the policy
                    // leaves the option to OpenSSH.
                    assert_eq!(
                        values,
                        value.map(str::to_string).into_iter().collect::<Vec<_>>(),
                        "{name} for {host_key_name}/{auth_name}: {argv:?}"
                    );
                }
                // Only managed-key connections skip the config files and take the routing
                // from `ssh -G` (which already includes -l and -p).
                assert_eq!(
                    argv.windows(2)
                        .any(|pair| pair[0] == "-F" && pair[1] == "none"),
                    is_key,
                    "{host_key_name}/{auth_name}: {argv:?}"
                );
                assert_eq!(
                    argv.iter().any(|arg| arg == "-l"),
                    !is_key,
                    "{host_key_name}/{auth_name}: {argv:?}"
                );
            }
        }
    }

    /// The safelist copies routing and transport options from `ssh -G` but never
    /// credentials, forwards or environment from the user's config.
    #[test]
    fn config_dump_copies_only_routing_options() {
        let routing = super::ResolvedRouting::from_dump(&super::SshConfigDump::parse(CONFIG_DUMP));
        let names: Vec<&str> = routing
            .options
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        for copied in [
            "HostName",
            "Port",
            "User",
            "TCPKeepAlive",
            "IPQoS",
            "ProxyCommand",
        ] {
            // Routing from the user's config keeps working for managed-key connections.
            assert!(names.contains(&copied), "{copied} missing from {names:?}");
        }
        for skipped in [
            "IdentityFile",
            "CertificateFile",
            "LocalForward",
            "RemoteForward",
            "DynamicForward",
            "SendEnv",
            "SetEnv",
            "IdentitiesOnly",
            // redoor sets its own connect timeout; "none" values are OpenSSH's unset marker.
            "ConnectTimeout",
            "BindAddress",
        ] {
            // Accumulating or credential-bearing options must not reach the device.
            assert!(!names.contains(&skipped), "{skipped} copied: {names:?}");
        }
        let value = |name: &str| {
            routing
                .options
                .iter()
                .find(|(option, _)| option == name)
                .map(|(_, value)| value.clone())
        };
        // Multi-value options keep all their words.
        assert_eq!(value("IPQoS").as_deref(), Some("lowdelay throughput"));
        // The last jump is the -W destination and the earlier ones go to -J, run without
        // -F none so jump hosts keep the user's config.
        assert_eq!(
            value("ProxyCommand").as_deref(),
            Some("ssh -J 'bob@j1:2201' -W '[real.example]:2222' 'ssh://carol@j2'")
        );
    }

    /// A configured timeout must survive config isolation without shadowing the default.
    #[test]
    fn configured_connect_timeout_is_emitted_once() {
        let routing = super::ResolvedRouting::from_dump(&super::SshConfigDump::parse(
            "hostname example.test
connecttimeout 37
",
        ));
        let host = super::SshHost::new("device".to_string())
            .auth(super::AuthPolicy::ManagedKey { key: test_key() });
        let argv = super::ssh_argv(
            &host,
            Some(&routing),
            None,
            "true",
            &[],
            &super::SshRunOptions::default(),
        );
        // A slow route may need the user's timeout rather than redoor's 15-second fallback.
        assert_eq!(option_values(&argv, "ConnectTimeout"), ["37"]);
    }

    /// Device targets are data, even if a caller supplies a string resembling an SSH flag.
    #[test]
    fn target_cannot_inject_ssh_options() {
        let host = super::SshHost::new("-oProxyCommand=touch /tmp/not-run".to_string());
        let argv = super::ssh_argv(
            &host,
            None,
            None,
            "true",
            &[],
            &super::SshRunOptions::default(),
        );
        let end = argv.iter().position(|arg| arg == "--").unwrap();
        // The option parser must stop before it encounters an untrusted target.
        assert_eq!(
            &argv[end + 1..],
            [host.target.clone(), "sh -c 'true' sh".to_string()]
        );
    }

    /// A single jump host becomes a plain `-W` command, and a configured ProxyCommand is
    /// copied as it is.
    #[test]
    fn single_jump_and_explicit_proxy_command() {
        // The URI form keeps a jump host port valid as an ssh destination.
        assert_eq!(
            super::proxy_jump_command("bob@j1:2201", "device", "22"),
            "ssh -W '[device]:22' 'ssh://bob@j1:2201'"
        );
        let routing = super::ResolvedRouting::from_dump(&super::SshConfigDump::parse(
            "hostname h\nproxycommand nc %h %p\n",
        ));
        // OpenSSH expands the tokens itself at connect time.
        assert!(
            routing
                .options
                .contains(&("ProxyCommand".to_string(), "nc %h %p".to_string()))
        );
        let routing =
            super::ResolvedRouting::from_dump(&super::SshConfigDump::parse("proxycommand none\n"));
        // "none" means no proxy and is not passed on.
        assert!(routing.options.is_empty());
    }

    /// OpenSSH expands tokens before invoking the proxy shell, so both percent signs and
    /// shell metacharacters must survive as literal argv bytes even on older clients.
    #[tokio::test]
    async fn generated_proxy_quotes_resolved_host_and_jump_arguments() {
        let home = redoor_core::test_support::TempDir::create();
        let ssh_path = home.path().join("ssh");
        tokio::fs::write(
            &ssh_path,
            "#!/bin/sh
printf '%s|' \"$@\"
",
        )
        .await
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&ssh_path, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let hostname = "host'$(exit 17)%h";
        let jumps = "first'$(exit 19)%h,last'$(exit 23)%h:2201";
        // Emulate the only percent expansion left for OpenSSH: %% becomes a literal %.
        let command = super::proxy_jump_command(jumps, hostname, "2222").replace("%%", "%");
        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let search_path = std::env::join_paths(
            std::iter::once(home.path().to_path_buf())
                .chain(std::env::split_paths(&inherited_path)),
        )
        .unwrap();
        let output = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .env("PATH", search_path)
            .output()
            .await
            .unwrap();
        // A fake SSH executable observes the literal arguments; none become shell syntax.
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "-J|first'$(exit 19)%h|-W|[host'$(exit 17)%h]:2222|ssh://last'$(exit 23)%h:2201|"
        );
    }

    /// Paths with spaces stay one option value and `%` is not expanded as a token; the data
    /// dir can contain spaces, for example on macOS.
    #[test]
    fn option_paths_are_quoted_and_escaped() {
        let path = std::path::Path::new("/Users/a b/Library/100% \"x\"/id_ed25519");
        // Quotes keep the value together, `%%` is a literal percent, inner quotes are escaped.
        assert_eq!(
            super::quote_ssh_path(path),
            "\"/Users/a b/Library/100%% \\\"x\\\"/id_ed25519\""
        );
    }

    /// A pinned host key mismatch names both fingerprints and the re-pin action instead of
    /// generic host key guidance.
    #[tokio::test]
    async fn pinned_host_key_change_names_both_fingerprints() {
        let host = super::SshHost::new("device".to_string()).host_key(
            super::HostKeyPolicy::Pinned(super::PinnedHostKey {
                known_hosts: "/data/known_hosts".into(),
                alias: "dev_x".to_string(),
                fingerprint: "SHA256:pinnedpinned".to_string(),
            }),
        );
        let status = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("exit 255")
            .status()
            .await
            .unwrap();
        let stderr = b"@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
The fingerprint for the ED25519 key sent by the remote host is
SHA256:37GuSDsn+/eh/mfE4ljJRsBc4iIVEHdf7nKKbCHhlF0.
Host key for dev_x has changed and you have requested strict checking.
Host key verification failed.";
        let issue = super::format_ssh_failure(&host, "remote host probe", status, stderr);
        // The user sees what was pinned and what is presented now.
        assert!(issue.starts_with("SSH host key changed."), "{issue}");
        assert!(issue.contains("SHA256:pinnedpinned"), "{issue}");
        assert!(
            issue.contains("SHA256:37GuSDsn+/eh/mfE4ljJRsBc4iIVEHdf7nKKbCHhlF0,"),
            "{issue}"
        );
        // The way out is named; redoor never re-pins on its own.
        assert!(issue.contains("re-pin the host key"), "{issue}");

        let unpinned = super::SshHost::new("device".to_string());
        let issue = super::format_ssh_failure(&unpinned, "remote host probe", status, stderr);
        // Devices without a pin keep today's generic guidance.
        assert!(
            issue.starts_with("SSH host key verification failed."),
            "{issue}"
        );
    }

    /// Verifies IPv6 destinations retain unambiguous OpenSSH `-R` syntax.
    #[test]
    fn reverse_forward_brackets_ipv6_destination() {
        let forward = super::ReverseForward {
            remote_port: 3000,
            destination_host: "2001:db8::10".to_string(),
            destination_port: 4000,
        };

        // Brackets prevent IPv6 colons from being parsed as SSH field separators.
        assert_eq!(forward.to_ssh_spec(), "3000:[2001:db8::10]:4000");
    }
}
