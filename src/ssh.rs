//! `redoor ssh` subcommand: starts a redoor agent on a remote host through
//! ssh and tunnels the local redoor server port to the remote host so the
//! agent can connect back to the server running on the machine that issued
//! the ssh command.

use clap::Args;
use std::process::Stdio;
use tokio::process::Command;

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
    /// SSH login username. Forwarded to ssh via `-l`.
    #[arg(short = 'l')]
    pub(crate) username: String,
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
    /// Path to the redoor binary on the remote host. Defaults to the
    /// versioned install layout (`~/.local/redoor/<version>/redoor`).
    #[arg(long, env = "REDOOR_REMOTE_BIN", default_value_t = default_remote_bin())]
    pub(crate) remote_bin: String,
    /// Remote ssh target in `user@host` form. Kept positional to mirror the
    /// standard ssh CLI usage so existing muscle memory transfers.
    pub(crate) target: String,
}

/// Default remote redoor binary path when the user does not override it
/// via `--remote-bin` or `REDOOR_REMOTE_BIN`.
fn default_remote_bin() -> String {
    format!("~/.local/redoor/{}/redoor", env!("CARGO_PKG_VERSION"))
}

/// Derives a default agent name from the ssh target by stripping any
/// `user@` prefix so the name reflects the host being connected to.
fn default_agent_name(target: &str) -> String {
    target.rsplit('@').next().unwrap_or(target).to_string()
}

/// One end of a reverse port forward: ssh listens on `remote_port` at the
/// remote host and tunnels connections to `local_port` on the machine that
/// started ssh. Both ports are usually the same redoor port, but they are
/// kept separate so callers can map onto a different local port if needed.
#[derive(Clone, Copy)]
pub(crate) struct ReverseForward {
    pub(crate) remote_port: u16,
    pub(crate) local_port: u16,
}

/// Options for [`SshHost::run`] that are orthogonal to the remote command,
/// such as reverse port forwards and whether ssh should abort the connection
/// when a requested forward cannot be established.
#[derive(Default)]
pub(crate) struct SshRunOptions {
    /// Reverse port forwards (`ssh -R`) to request on this connection.
    pub(crate) reverse_forwards: Vec<ReverseForward>,
    /// When true, adds `-o ExitOnForwardFailure=yes` so ssh exits at startup
    /// if any requested forward could not be bound. This prevents the remote
    /// command from running against a tunnel that will never come up.
    pub(crate) exit_on_forward_failure: bool,
}

impl SshRunOptions {
    /// Adds a reverse forward mapping `remote_port` on the ssh host to
    /// `local_port` on this machine.
    pub(crate) fn with_reverse_forward(mut self, remote_port: u16, local_port: u16) -> Self {
        self.reverse_forwards.push(ReverseForward {
            remote_port,
            local_port,
        });
        self
    }

    /// Requests ssh to abort the connection if any requested forward fails.
    pub(crate) fn exit_on_forward_failure(mut self) -> Self {
        self.exit_on_forward_failure = true;
        self
    }
}

/// Represents an ssh reachable host and builds `ssh` invocations against it.
///
/// Encapsulates the ssh connection parameters (user, port, target) so the
/// `run` method can stay focused on the remote command and its options. The
/// builder methods return `Self` by value so callers can chain configuration
/// fluently before awaiting [`SshHost::run`].
pub(crate) struct SshHost {
    username: String,
    ssh_port: u16,
    target: String,
}

impl SshHost {
    /// Starts building an ssh connection to `target` (e.g. `user@host`).
    pub(crate) fn new(target: String) -> Self {
        Self {
            username: String::new(),
            ssh_port: 22,
            target,
        }
    }

    /// Sets the ssh login username (`ssh -l`).
    pub(crate) fn username(mut self, username: impl Into<String>) -> Self {
        self.username = username.into();
        self
    }

    /// Sets the ssh server port (`ssh -p`). Defaults to 22 if not called.
    pub(crate) fn ssh_port(mut self, port: u16) -> Self {
        self.ssh_port = port;
        self
    }

    /// Spawns `ssh` to execute `command` with `args` on the remote host,
    /// applying the forwards and forwarding-failure behavior described by
    /// `options`. Stdio is inherited so the user can observe remote output
    /// and interact with the process when needed.
    ///
    /// Returns the ssh exit status. Callers are responsible for translating
    /// a non-zero status into their own error handling.
    pub(crate) async fn run(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
    ) -> Result<std::process::ExitStatus, std::io::Error> {
        let mut ssh = Command::new("ssh");

        if !self.username.is_empty() {
            ssh.arg("-l").arg(&self.username);
        }
        ssh.arg("-p").arg(self.ssh_port.to_string());

        if options.exit_on_forward_failure {
            ssh.arg("-o").arg("ExitOnForwardFailure=yes");
        }

        for forward in &options.reverse_forwards {
            let spec = format!("{}:localhost:{}", forward.remote_port, forward.local_port);
            ssh.arg("-R").arg(spec);
        }

        ssh.arg(&self.target);
        ssh.arg(command);
        for arg in args {
            ssh.arg(arg);
        }

        ssh.stdin(Stdio::inherit());
        ssh.stdout(Stdio::inherit());
        ssh.stderr(Stdio::inherit());

        ssh.status().await
    }
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
    let remote_bin = args.remote_bin;
    let agent_name = args
        .name
        .clone()
        .unwrap_or_else(|| default_agent_name(&args.target));
    let ws_url = format!("ws://localhost:{}/ws", args.redoor_port);

    let host = SshHost::new(args.target)
        .username(args.username)
        .ssh_port(args.ssh_port);

    // The reverse forward and exit-on-failure behavior are run-time options
    // because they describe the tunnel, not the remote command itself.
    let options = SshRunOptions::default()
        .with_reverse_forward(args.redoor_port, args.redoor_port)
        .exit_on_forward_failure();

    // ssh joins all trailing args after the command into one remote argv, so
    // the agent name must be appended after the fixed flags.
    let remote_argv: [&str; 4] = ["agent", &ws_url, "--name", &agent_name];

    let status = host.run(&remote_bin, &remote_argv, &options).await?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}
