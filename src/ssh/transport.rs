//! Builds and executes SSH commands without owning agent orchestration policy.

use std::path::Path;
use std::process::Stdio;

use redoor::{Level, log};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

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
    ssh_port: u16,
    target: String,
}

impl SshHost {
    /// Starts building an ssh connection to `target` (e.g. `user@host`).
    pub(super) fn new(target: String) -> Self {
        Self {
            username: None,
            ssh_port: 22,
            target,
        }
    }

    /// Sets the ssh login username (`ssh -l`).
    pub(super) fn username(mut self, username: Option<String>) -> Self {
        self.username = username;
        self
    }

    /// Sets the ssh server port (`ssh -p`). Defaults to 22 if not called.
    pub(super) fn ssh_port(mut self, port: u16) -> Self {
        self.ssh_port = port;
        self
    }

    /// Spawns `ssh` to execute `command` with `args` on the remote host,
    /// applying the forwards and forwarding-failure behavior described by
    /// `options`. Stdio is inherited so the user can observe remote output
    /// and interact with the process when needed.
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

        log!(Level::Debug, "Spawning ssh command: {:?}", ssh);

        // Ensure the ssh client is killed if the supervisor task is
        // dropped (e.g. on server shutdown), preventing the ssh
        // process from being orphaned. `kill_on_drop` sends SIGKILL.
        // Note: this only kills the local ssh client; the remote
        // `redoor agent` would need a separate shutdown signal.
        ssh.kill_on_drop(true);
        let mut child = ssh.spawn()?;
        if let Some((_, value)) = &options.secret_env {
            let mut child_stdin = child
                .stdin
                .take()
                .expect("secret environment requires piped ssh stdin");
            child_stdin.write_all(value.as_bytes()).await?;
            child_stdin.write_all(b"\n").await?;
            tokio::spawn(async move {
                let mut stdin = tokio::io::stdin();
                let _ = tokio::io::copy(&mut stdin, &mut child_stdin).await;
            });
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

        log!(Level::Debug, "Running ssh command: {:?}", ssh);

        ssh.status().await
    }

    /// Runs a single shell command on the remote host and captures its
    /// stdout. Used for one-shot "sniff" commands whose output we need to
    /// parse locally rather than stream to the user. Stderr is still
    /// inherited so authentication errors and similar diagnostics stay
    /// visible.
    pub(super) async fn run_captured(
        &self,
        shell_command: &str,
        options: &SshRunOptions,
    ) -> Result<String, std::io::Error> {
        let mut ssh = Command::new("ssh");

        if let Some(ref username) = self.username {
            ssh.arg("-l").arg(username);
        }
        ssh.arg("-p").arg(self.ssh_port.to_string());

        if options.compressed {
            ssh.arg("-C");
        }

        // Always fail fast if a requested reverse forward cannot be bound.
        // Without this, ssh keeps running and the remote command executes
        // against a tunnel that will never come up.
        ssh.arg("-o").arg("ExitOnForwardFailure=yes");

        for forward in &options.reverse_forwards {
            ssh.arg("-R").arg(forward.to_ssh_spec());
        }

        ssh.arg(&self.target);
        ssh.arg(shell_command);

        ssh.stdin(Stdio::null());
        ssh.stdout(Stdio::piped());
        ssh.stderr(Stdio::inherit());

        log!(Level::Debug, "Running ssh command: {:?}", ssh);

        let output = ssh.output().await?;
        if !output.status.success() {
            return Err(std::io::Error::other(format!(
                "ssh exited with status {} while running: {}",
                output.status.code().unwrap_or(-1),
                shell_command
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
        ssh.arg("-p").arg(self.ssh_port.to_string());
        // Compress the upload stream so large binaries transfer faster over
        // slow uplinks. ssh compression is cheap and transparent here.
        ssh.arg("-C");
        ssh.arg(&self.target);
        ssh.arg(format!("cat > {}", remote_path));

        ssh.stdin(Stdio::piped());
        ssh.stdout(Stdio::inherit());
        // Capture stderr so prepare/watchdog logs include the remote reason
        // instead of only the local Broken pipe that follows early cat exit.
        ssh.stderr(Stdio::piped());

        log!(Level::Debug, "Running ssh command: {:?}", ssh);

        let mut child = ssh.spawn()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let mut stderr = child.stderr.take().expect("stderr was piped");
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
        let stderr_handle = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            buf
        });

        let status = child.wait().await?;
        let stderr_bytes = stderr_handle
            .await
            .map_err(|e| std::io::Error::other(format!("stderr task panicked: {e}")))?;
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        let stderr_trim = stderr.trim();

        // Prefer remote failure details over the copy-task Broken pipe that
        // appears whenever remote cat exits before the local stream finishes.
        let copy_result = copy_handle
            .await
            .map_err(|e| std::io::Error::other(format!("copy task panicked: {e}")))?;

        if !status.success() {
            let mut msg = format!(
                "ssh upload to '{}' failed with status {}",
                remote_path,
                status.code().unwrap_or(-1)
            );
            if !stderr_trim.is_empty() {
                msg.push_str(": ");
                msg.push_str(stderr_trim);
            }
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
    ssh.arg("-p").arg(host.ssh_port.to_string());

    if options.compressed {
        ssh.arg("-C");
    }

    // Always fail fast if a requested reverse forward cannot be bound.
    // Without this, ssh keeps running and the remote command executes
    // against a tunnel that will never come up.
    ssh.arg("-o").arg("ExitOnForwardFailure=yes");

    for forward in &options.reverse_forwards {
        ssh.arg("-R").arg(forward.to_ssh_spec());
    }

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
        // Clone the handle so stdout and stderr can both write to the same file.
        let file_for_stderr = file.try_clone().await.map_err(|error| {
            std::io::Error::other(format!(
                "Failed to clone agent log file handle '{log_path}': {error}"
            ))
        })?;
        let stdout_file = file.into_std().await;
        let stderr_file = file_for_stderr.into_std().await;
        ssh.stdout(Stdio::from(stdout_file));
        ssh.stderr(Stdio::from(stderr_file));
    } else {
        ssh.stdout(Stdio::inherit());
        if options.pipe_stderr {
            ssh.stderr(Stdio::piped());
        } else {
            ssh.stderr(Stdio::inherit());
        }
    }

    Ok(ssh)
}

#[cfg(test)]
mod tests {
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
