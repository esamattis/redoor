//! Builds and executes SSH commands without owning agent orchestration policy.

use std::path::Path;
use std::process::Stdio;

use redoor::{Level, log};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// Caps browser-bound SSH diagnostics while retaining the final, usually actionable lines.
const MAX_SSH_DIAGNOSTIC_BYTES: usize = 8 * 1024;

/// Bounds how long OpenSSH may spend establishing its transport before a retry.
const SSH_CONNECT_TIMEOUT_SECONDS: u32 = 15;

/// One reverse forward: SSH listens on `remote_port` at the remote host and
/// asks the local SSH client to connect to `destination_host:destination_port`.
/// Keeping the destination explicit lets a relay machine route agent traffic
/// to a redoor server that the SSH target cannot reach directly.
#[derive(Clone)]
struct ReverseForward {
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
    reverse_forwards: Vec<ReverseForward>,
    /// When true, adds `-C` so ssh compresses its traffic. Useful for bulk
    /// transfers like binary uploads and the one-shot sniff command; left off
    /// for the long-running agent session which is mostly idle and would just
    /// burn CPU on compression.
    compressed: bool,
    /// When set, the value is sent through ssh stdin and exported by a remote
    /// shell preamble so secrets never appear in either process's argv.
    secret_env: Option<(String, String)>,
    /// When set, the ssh process's stdout/stderr is redirected (append
    /// mode) to this local file path. Used only for the long-running
    /// agent run so sniff/upload diagnostics still go to the terminal.
    log_file: Option<String>,
    /// Pipes stderr so a standalone launcher can detect an initial reverse
    /// forwarding bind failure while still copying agent logs to its terminal.
    pipe_stderr: bool,
}

/// Selects who owns SSH stderr so forwarding diagnostics remain observable even
/// when ordinary remote output is persisted to a log file.
#[derive(Debug, PartialEq, Eq)]
enum StderrRoute {
    /// The relay monitor drains stderr, detects bind failures, and tees it to the log.
    Monitor,
    /// The SSH child appends stderr directly to the configured log file.
    LogFile,
    /// The SSH child writes stderr directly to the invoking terminal.
    Inherit,
}

/// Gives active forwarding monitoring precedence over direct log redirection;
/// otherwise the child would have no stderr pipe for detecting bind failures.
fn stderr_route(options: &SshRunOptions) -> StderrRoute {
    if options.pipe_stderr {
        StderrRoute::Monitor
    } else if options.log_file.is_some() {
        StderrRoute::LogFile
    } else {
        StderrRoute::Inherit
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
    pub(super) fn with_log_file(mut self, path: impl Into<String>) -> Self {
        self.log_file = Some(path.into());
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
    pub(super) fn log_file(&self) -> Option<&String> {
        self.log_file.as_ref()
    }
}

/// Represents an ssh reachable host and builds `ssh` invocations against it.
///
/// Encapsulates the ssh connection parameters (user, port, target) so the
/// `run` method can stay focused on the remote command and its options. The
/// builder methods return `Self` by value so callers can chain configuration
/// fluently before awaiting [`SshHost::run`].
#[derive(Clone)]
pub(super) struct SshHost {
    username: Option<String>,
    /// An explicit override passed with `-p`; `None` lets OpenSSH resolve the
    /// port from its host configuration or built-in default.
    ssh_port: Option<u16>,
    target: String,
    /// Optional login password delivered through `SSH_ASKPASS` rather than SSH stdin.
    password: Option<String>,
}

impl SshHost {
    /// Starts building an ssh connection to `target` (e.g. `user@host`).
    pub(super) fn new(target: String) -> Self {
        Self {
            username: None,
            ssh_port: None,
            target,
            password: None,
        }
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
    pub(super) fn password(mut self, password: Option<String>) -> Self {
        self.password = password;
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

    /// Spawns `ssh` to execute `command` with `args` on the remote host,
    /// applying the forwards and forwarding-failure behavior described by
    /// `options`. Output remains observable while secret-bearing agent sessions
    /// retain their stdin pipe until the SSH child exits.
    ///
    /// Returns the spawned child. Callers (the supervisor) own the child
    /// so they can wait for it or kill it when the WebSocket goes stale.
    pub(super) async fn spawn(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
    ) -> Result<tokio::process::Child, std::io::Error> {
        let mut ssh = build_ssh_command(self, command, args, options).await?;

        log!(
            Level::Debug,
            "Spawning ssh command: {}",
            ssh_command_argv_debug(&ssh)
        );

        // Ensure the ssh client is killed if the supervisor task is
        // dropped (e.g. on server shutdown), preventing the ssh
        // process from being orphaned. `kill_on_drop` sends SIGKILL.
        // Note: this only kills the local ssh client; the remote
        // `redoor agent` would need a separate shutdown signal.
        ssh.kill_on_drop(true);
        let mut child = ssh.spawn()?;
        if let Some((_, value)) = &options.secret_env {
            write_secret_and_retain_stdin(&mut child, value).await?;
        }
        Ok(child)
    }

    /// Spawns `ssh` to execute `command` with `args` on the remote host,
    /// applying the forwards and forwarding-failure behavior described by
    /// `options`. Stdio is inherited so the user can observe remote output
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
        let mut ssh = build_ssh_command(self, command, args, options).await?;

        log!(
            Level::Debug,
            "Running ssh command: {}",
            ssh_command_argv_debug(&ssh)
        );

        ssh.kill_on_drop(true);
        ssh.status().await
    }

    /// Streams a script to `sh -s` on the remote host and captures stdout.
    /// Sending the script through stdin keeps multiline probes readable and
    /// avoids embedding shell syntax in the SSH command argument. Stderr is
    /// captured so preparation failures can reach the lifecycle UI.
    pub(super) async fn run_script_captured(
        &self,
        script: &str,
        options: &SshRunOptions,
    ) -> Result<String, std::io::Error> {
        let mut ssh = build_ssh_command(self, "sh", &["-s"], options).await?;
        ssh.stdin(Stdio::piped());
        ssh.stdout(Stdio::piped());
        ssh.stderr(Stdio::piped());
        ssh.kill_on_drop(true);

        log!(
            Level::Debug,
            "Running ssh script through {}",
            ssh_command_argv_debug(&ssh)
        );

        let mut child = ssh.spawn()?;
        let mut stdin = child.stdin.take().expect("script requires piped ssh stdin");
        let stdout = child
            .stdout
            .take()
            .expect("script requires piped ssh stdout");
        let stderr = child
            .stderr
            .take()
            .expect("script requires piped ssh stderr");
        let stdout_handle = tokio::spawn(read_bounded_tail(stdout));
        let stderr_handle = tokio::spawn(read_bounded_tail(stderr));
        let write_result = stdin.write_all(script.as_bytes()).await;
        // Closing stdin tells the remote shell that the complete script has arrived.
        drop(stdin);

        let status = child.wait().await?;
        let stdout = join_diagnostic_reader(stdout_handle, "stdout").await?;
        let stderr = join_diagnostic_reader(stderr_handle, "stderr").await?;
        if !status.success() {
            return Err(std::io::Error::other(format_ssh_failure(
                self,
                "remote host probe",
                status,
                &stderr,
            )));
        }
        write_result.map_err(|error| {
            std::io::Error::other(format!(
                "failed to stream script through ssh stdin: {error}"
            ))
        })?;
        Ok(String::from_utf8_lossy(&stdout).to_string())
    }

    /// Streams `local_path` to the remote host by piping it into
    /// `cat > remote_path` over ssh with compression enabled. Streaming
    /// (rather than scp/sftp) keeps the implementation simple and avoids
    /// reading the entire binary into memory, which matters when the binary
    /// is large or memory is constrained. The remote path is interpreted by
    /// the remote shell so `~` and other shell expansions work as expected.
    ///
    /// Stderr is captured so remote failures (permission denied, disk full,
    /// ETXTBSY on an in-place overwrite of a running binary) become part of
    /// the returned error instead of a bare local Broken pipe. Callers that
    /// replace a live agent binary should write a sibling temp path and
    /// rename over the final path.
    pub(super) async fn upload_via_cat(
        &self,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<(), std::io::Error> {
        let mut ssh = Command::new("ssh");

        if let Some(ref username) = self.username {
            ssh.arg("-l").arg(username);
        }
        if let Some(port) = self.ssh_port {
            ssh.arg("-p").arg(port.to_string());
        }
        // No TTY and stdin is the upload stream, so new hosts cannot be confirmed interactively.
        ssh.arg("-T");
        ssh.arg("-o").arg("ExitOnForwardFailure=yes");
        ssh.arg("-o").arg("StrictHostKeyChecking=accept-new");
        ssh.arg("-o")
            .arg(format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"));
        // Compress the upload stream so large binaries transfer faster over
        // slow uplinks. ssh compression is cheap and transparent here.
        ssh.arg("-C");
        apply_non_interactive_auth(&mut ssh, self.password.as_deref())?;
        ssh.arg(&self.target);
        ssh.arg(format!("cat > {}", remote_path));

        ssh.stdin(Stdio::piped());
        ssh.stdout(Stdio::inherit());
        // Capture stderr so prepare/watchdog logs include the remote reason
        // instead of only the local Broken pipe that follows early cat exit.
        ssh.stderr(Stdio::piped());
        ssh.kill_on_drop(true);

        log!(
            Level::Debug,
            "Running ssh command: {}",
            ssh_command_argv_debug(&ssh)
        );

        let mut child = ssh.spawn()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut file = tokio::fs::File::open(local_path).await?;

        // Run the copy on a separate task so we can concurrently wait for
        // the child. If the remote `cat` exits early (e.g. disk full), the
        // stdin pipe closes and the copy errors out; without the spawn we
        // would deadlock waiting on a write that never completes.
        let copy_handle = tokio::spawn(async move {
            tokio::io::copy(&mut file, &mut stdin).await?;
            // Drop stdin to send EOF so the remote `cat` flushes and exits.
            drop(stdin);
            Ok::<_, std::io::Error>(())
        });
        // Drain stderr while the child runs so a full pipe cannot block exit.
        let stderr_handle = tokio::spawn(read_bounded_tail(stderr));

        let status = child.wait().await?;
        let stderr_bytes = join_diagnostic_reader(stderr_handle, "stderr").await?;
        let stderr = sanitized_ssh_text(self, &stderr_bytes);
        let stderr_trim = stderr.trim();

        // Prefer remote failure details over the copy-task Broken pipe that
        // appears whenever remote cat exits before the local stream finishes.
        let copy_result = copy_handle
            .await
            .map_err(|e| std::io::Error::other(format!("copy task panicked: {e}")))?;

        if !status.success() {
            let mut msg = format_ssh_failure(self, "binary upload", status, &stderr_bytes);
            if stderr_trim.contains("text file busy") || stderr_trim.contains("ETXTBSY") {
                msg.push_str(
                    " (remote binary is currently executing; upload must replace via temp file + mv)",
                );
            }
            return Err(std::io::Error::other(msg));
        }

        copy_result.map_err(|e| {
            std::io::Error::other(format!(
                "failed while streaming local file to remote '{}': {}",
                remote_path, e
            ))
        })?;
        Ok(())
    }
}

/// Drains a child pipe while retaining only the final diagnostic bytes in memory.
async fn read_bounded_tail(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, std::io::Error> {
    let mut tail = Vec::with_capacity(MAX_SSH_DIAGNOSTIC_BYTES);
    let mut chunk = [0_u8; 4096];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(tail);
        }
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > MAX_SSH_DIAGNOSTIC_BYTES {
            let excess = tail.len() - MAX_SSH_DIAGNOSTIC_BYTES;
            tail.drain(..excess);
        }
    }
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

/// Builds the [`Command`] used by both [`SshHost::run`] and
/// [`SshHost::spawn`]. Centralizing the arg/stdio wiring keeps the two
/// spawn paths from drifting out of sync as flags are added.
async fn build_ssh_command(
    host: &SshHost,
    command: &str,
    args: &[&str],
    options: &SshRunOptions,
) -> Result<Command, std::io::Error> {
    let mut ssh = Command::new("ssh");

    if let Some(ref username) = host.username {
        ssh.arg("-l").arg(username);
    }
    if let Some(port) = host.ssh_port {
        ssh.arg("-p").arg(port.to_string());
    }

    if options.compressed {
        ssh.arg("-C");
    }

    // Always fail fast if a requested reverse forward cannot be bound.
    // Without this, ssh keeps running and the remote command executes
    // against a tunnel that will never come up.
    ssh.arg("-o").arg("ExitOnForwardFailure=yes");
    // Managed SSH has no TTY for host-key prompts; accept-new still rejects changed keys.
    ssh.arg("-T");
    ssh.arg("-o").arg("StrictHostKeyChecking=accept-new");
    ssh.arg("-o")
        .arg(format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"));

    for forward in &options.reverse_forwards {
        ssh.arg("-R").arg(forward.to_ssh_spec());
    }

    apply_non_interactive_auth(&mut ssh, host.password.as_deref())?;

    ssh.arg(&host.target);
    if let Some((name, _)) = &options.secret_env {
        // Keep the secret out of both the local ssh argv and the remote agent argv,
        // since either can be exposed by process listings. `spawn` writes the value
        // as the first stdin line; this preamble reads and exports it, then `exec`
        // replaces the shell so the agent inherits the environment without a wrapper.
        ssh.arg(format!("read -r {name}; export {name}; exec {command}"));
    } else {
        ssh.arg(command);
    }
    for arg in args {
        ssh.arg(arg);
    }

    if options.secret_env.is_some() {
        ssh.stdin(Stdio::piped());
    } else {
        ssh.stdin(Stdio::inherit());
    }

    if let Some(log_path) = &options.log_file {
        // Open in append mode via the async tokio API, then convert to a
        // std::fs::File so it can be turned into a Stdio for the child.
        let path = Path::new(log_path);
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to create agent log directory '{}': {error}",
                    parent.display()
                ))
            })?;
        }
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .await
            .map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to open agent log file '{log_path}': {error}"
                ))
            })?;
        if stderr_route(options) == StderrRoute::Monitor {
            // Standalone relays must inspect OpenSSH stderr for bind failures;
            // their monitor tees that stream back into this same log path.
            ssh.stdout(Stdio::from(file.into_std().await));
            ssh.stderr(Stdio::piped());
        } else {
            // Managed agents do not inspect stderr, so let the child append both
            // output streams directly without an intermediate forwarding task.
            let file_for_stderr = file.try_clone().await.map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to clone agent log file handle '{log_path}': {error}"
                ))
            })?;
            ssh.stdout(Stdio::from(file.into_std().await));
            ssh.stderr(Stdio::from(file_for_stderr.into_std().await));
        }
    } else {
        ssh.stdout(Stdio::inherit());
        match stderr_route(options) {
            StderrRoute::Monitor => {
                ssh.stderr(Stdio::piped());
            }
            StderrRoute::Inherit => {
                ssh.stderr(Stdio::inherit());
            }
            StderrRoute::LogFile => {
                unreachable!("a log-file stderr route requires a configured log path")
            }
        }
    }

    Ok(ssh)
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
fn apply_non_interactive_auth(
    ssh: &mut Command,
    password: Option<&str>,
) -> Result<(), std::io::Error> {
    let Some(password) = password else {
        // BatchMode prevents OpenSSH from reading a password or keyboard-interactive
        // answer from a terminal, so managed startup fails instead of hanging.
        ssh.arg("-o").arg("BatchMode=yes");
        ssh.arg("-o").arg("NumberOfPasswordPrompts=0");
        return Ok(());
    };
    let exe = std::env::current_exe().map_err(|error| {
        std::io::Error::other(format!(
            "failed to locate redoor executable for SSH_ASKPASS: {error}"
        ))
    })?;
    // A second identical askpass answer cannot succeed, so fail on the first attempt.
    // Override host configuration that would otherwise disable askpass entirely.
    ssh.arg("-o").arg("BatchMode=no");
    ssh.arg("-o").arg("NumberOfPasswordPrompts=1");
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
    if let Some(password) = host
        .password
        .as_deref()
        .filter(|password| !password.is_empty())
    {
        safe = safe.replace(password, "[redacted]");
    }
    safe
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
    let summary = if lower.contains("permission denied") || lower.contains("authentication failed")
    {
        if host.password.is_some() {
            "SSH authentication failed. The configured password or SSH key was rejected."
        } else {
            "SSH authentication requires credentials. Configure a password, SSH key, or ssh-agent credential for this managed agent."
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
    /// persistent log sink, which previously redirected stderr away from the monitor.
    #[test]
    fn forwarding_monitor_takes_precedence_over_log_redirection() {
        let options = super::SshRunOptions::default()
            .with_log_file("/tmp/redoor-relay-test.log")
            .with_piped_stderr();

        // The monitor must own stderr or relay startup fails before waiting on SSH.
        assert_eq!(super::stderr_route(&options), super::StderrRoute::Monitor);
        // The log remains available so the monitor can tee remote diagnostics into it.
        assert_eq!(
            options.log_file().map(String::as_str),
            Some("/tmp/redoor-relay-test.log")
        );
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

    /// Keeps the configured SSH password out of argv logs while still enabling askpass.
    #[tokio::test]
    async fn password_is_absent_from_logged_ssh_argv() {
        let host = super::SshHost::new("example.test".to_string())
            .password(Some("super-secret-password".to_string()));
        let command =
            super::build_ssh_command(&host, "true", &[], &super::SshRunOptions::default())
                .await
                .unwrap();
        let logged = super::ssh_command_argv_debug(&command);

        // Operator logs must not print the configured password.
        assert!(!logged.contains("super-secret-password"));
        // A single prompt avoids three identical askpass failures for a wrong password.
        assert!(logged.contains("NumberOfPasswordPrompts=1"));
        // Host-level BatchMode settings must not disable configured password authentication.
        assert!(logged.contains("BatchMode=no"));

        let envs: Vec<(String, Option<String>)> = command
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
