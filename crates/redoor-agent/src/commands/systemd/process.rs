//! Builds and runs the systemd command line tools for one manager.
//!
//! Every invocation gets the same fixed environment (C locale, no colors, no pager, UTC
//! timestamps) so the text the parsers read does not depend on the agent's environment, and
//! arguments go straight to the process, never through a shell.

use super::scope::{Account, Manager, user_manager_not_running};
use redoor_protocol::wire::{command::CommandErrorKind, request::CommandError};
use std::process::{ExitStatus, Stdio};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

/// Most standard output kept from one tool run. Unit lists of large hosts stay far below it;
/// anything past it is drained and dropped so a runaway tool cannot grow agent memory.
const MAX_STDOUT_BYTES: usize = 16 * 1024 * 1024;
/// Most error output kept; the useful part of systemctl's errors is a line or two.
const MAX_STDERR_BYTES: usize = 16 * 1024;
/// `PATH` for the tools when the agent's own is unset, covering every distro's layout.
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// How a child reaches a user's manager.
#[derive(Debug, Clone, PartialEq, Eq)]
struct UserSession {
    account: Account,
    /// Run the child as the account instead of as the agent (root acting for another user).
    switch_user: bool,
}

/// One systemd tool invocation, built up before it runs so tests can inspect its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SystemdTool {
    program: &'static str,
    args: Vec<String>,
    /// Set for tools that talk to (or read the paths of) a user's manager.
    user: Option<UserSession>,
}

impl SystemdTool {
    /// `systemctl` for `manager`, with `--user` and the user's session environment for user
    /// managers. `--no-ask-password` keeps polkit from waiting for a password nobody types.
    pub(super) fn systemctl(manager: &Manager) -> Self {
        Self::for_manager("systemctl", manager).args(["--no-pager", "--no-ask-password"])
    }

    /// `systemd-analyze` for `manager`, whose `unit-paths` lists where it loads units from.
    pub(super) fn analyze(manager: &Manager) -> Self {
        Self::for_manager("systemd-analyze", manager).args(["--no-pager"])
    }

    /// `journalctl` run as the agent itself; callers choose system, `--user` or a user filter.
    pub(super) fn journalctl() -> Self {
        Self::plain("journalctl").args(["--no-pager", "--quiet"])
    }

    /// `journalctl --user` for the agent's own user journal.
    pub(super) fn user_journalctl(account: &Account) -> Self {
        Self {
            program: "journalctl",
            args: Vec::new(),
            user: Some(UserSession {
                account: account.clone(),
                switch_user: false,
            }),
        }
        .args(["--user", "--no-pager", "--quiet"])
    }

    /// `loginctl`, which changes linger through logind (and polkit for non-root agents).
    pub(super) fn loginctl() -> Self {
        Self::plain("loginctl").args(["--no-pager", "--no-ask-password"])
    }

    /// A tool that runs as the agent with no user session.
    fn plain(program: &'static str) -> Self {
        Self {
            program,
            args: Vec::new(),
            user: None,
        }
    }

    /// A tool aimed at `manager`: `--user` plus the user's session for user managers.
    fn for_manager(program: &'static str, manager: &Manager) -> Self {
        match manager {
            Manager::System => Self::plain(program),
            Manager::User {
                account,
                switch_user,
            } => Self {
                program,
                args: vec!["--user".to_string()],
                user: Some(UserSession {
                    account: account.clone(),
                    switch_user: *switch_user,
                }),
            },
        }
    }

    /// Appends arguments.
    pub(super) fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Program and arguments, for tests and error messages.
    #[cfg(test)]
    pub(super) fn argv(&self) -> Vec<String> {
        std::iter::once(self.program.to_string())
            .chain(self.args.iter().cloned())
            .collect()
    }

    /// The UID the child runs as when it switches user, for tests.
    #[cfg(test)]
    pub(super) fn switches_to(&self) -> Option<u32> {
        self.user
            .as_ref()
            .filter(|session| session.switch_user)
            .map(|session| session.account.uid)
    }

    /// The environment the child gets, as name and value pairs.
    ///
    /// The agent's environment is cleared rather than inherited: a root agent must not leak
    /// its variables into another user's tools, and fixed locale, colors and time zone keep
    /// the output the parsers read stable.
    pub(super) fn environment(&self) -> Vec<(String, String)> {
        let path = std::env::var("PATH").unwrap_or_else(|_| DEFAULT_PATH.to_string());
        let mut environment = vec![
            ("PATH".to_string(), path),
            ("LC_ALL".to_string(), "C".to_string()),
            ("TZ".to_string(), "UTC".to_string()),
            ("SYSTEMD_COLORS".to_string(), "0".to_string()),
            ("SYSTEMD_PAGER".to_string(), "cat".to_string()),
        ];
        if let Some(session) = &self.user {
            let runtime_dir = session.account.runtime_dir();
            environment.extend([
                (
                    "XDG_RUNTIME_DIR".to_string(),
                    runtime_dir.display().to_string(),
                ),
                (
                    "DBUS_SESSION_BUS_ADDRESS".to_string(),
                    format!("unix:path={}", runtime_dir.join("bus").display()),
                ),
                (
                    "HOME".to_string(),
                    session.account.home.display().to_string(),
                ),
                ("USER".to_string(), session.account.name.clone()),
                ("LOGNAME".to_string(), session.account.name.clone()),
            ]);
        }
        environment
    }

    /// The process to spawn: fixed environment, no stdin, both outputs piped, killed when
    /// dropped so a canceled request never leaves a tool behind.
    pub(super) fn command(&self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(self.program);
        command
            .args(&self.args)
            .env_clear()
            .envs(self.environment())
            // The agent's directory may be unreadable for a switched user.
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(session) = self.user.as_ref().filter(|session| session.switch_user) {
            // The standard library also drops root's supplementary groups when it sets a
            // UID, so the child has exactly the user's identity.
            command.uid(session.account.uid).gid(session.account.gid);
        }
        command
    }

    /// Starts the tool; a missing binary means the host has no usable systemd.
    pub(super) fn spawn(&self) -> Result<tokio::process::Child, CommandError> {
        self.command()
            .spawn()
            .map_err(|error| self.spawn_error(error))
    }

    /// Classifies a failure to start the tool.
    fn spawn_error(&self, error: std::io::Error) -> CommandError {
        if error.kind() == std::io::ErrorKind::NotFound {
            CommandError::new(
                CommandErrorKind::SystemdUnsupported,
                format!("{} is not installed on the device", self.program),
            )
        } else {
            CommandError::new(
                CommandErrorKind::Internal,
                format!("Failed to run {}: {error}", self.program),
            )
        }
    }

    /// Runs the tool to completion and returns its output whatever its exit status, for
    /// callers that read meaning from failures themselves.
    ///
    /// A cancel kills the tool and reports `Canceled`. For an action that means systemctl
    /// stops waiting; the systemd job it started keeps running in the manager.
    pub(super) async fn output(
        &self,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, CommandError> {
        let mut child = self.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let run = async {
            let (stdout, stderr) = tokio::join!(
                read_capped(stdout, MAX_STDOUT_BYTES),
                read_capped(stderr, MAX_STDERR_BYTES)
            );
            let status = child.wait().await;
            (stdout, stderr, status)
        };
        let (stdout, stderr, status) = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(canceled(self.program)),
            output = run => output,
        };
        let status = status.map_err(|error| {
            CommandError::new(
                CommandErrorKind::Internal,
                format!("Failed to wait for {}: {error}", self.program),
            )
        })?;
        let read_error = |error: std::io::Error| {
            CommandError::new(
                CommandErrorKind::Internal,
                format!("Failed to read the output of {}: {error}", self.program),
            )
        };
        let (stdout, stdout_truncated) = stdout.map_err(read_error)?;
        let (stderr, _) = stderr.map_err(read_error)?;
        Ok(ToolOutput {
            status,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stdout_truncated,
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        })
    }

    /// Runs the tool and fails with a classified error unless it exits successfully.
    pub(super) async fn run(&self, cancel: &CancellationToken) -> Result<ToolOutput, CommandError> {
        let output = self.output(cancel).await?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(self.failure(&output))
        }
    }

    /// Turns a failed run into the error the UI shows, keeping the tool's own explanation.
    fn failure(&self, output: &ToolOutput) -> CommandError {
        let message = if output.stderr.is_empty() {
            format!("{} failed with {}", self.program, output.status)
        } else {
            output.stderr.clone()
        };
        match classify_failure(&output.stderr) {
            Failure::UserBus => match &self.user {
                Some(session) => user_manager_not_running(&session.account.name),
                None => CommandError::new(CommandErrorKind::SystemdUnsupported, message),
            },
            Failure::Kind(kind) => CommandError::new(kind, message),
        }
    }
}

/// The captured result of one tool run.
#[derive(Debug)]
pub(super) struct ToolOutput {
    pub(super) status: ExitStatus,
    pub(super) stdout: String,
    /// Whether standard output passed [`MAX_STDOUT_BYTES`] and was cut.
    pub(super) stdout_truncated: bool,
    pub(super) stderr: String,
}

/// What a failed tool's error output means.
#[derive(Debug, PartialEq, Eq)]
enum Failure {
    /// The tool could not reach its manager's bus; for a user manager that means it stopped.
    UserBus,
    Kind(CommandErrorKind),
}

/// Maps systemctl, loginctl and journalctl error text to a stable kind, so the HTTP status
/// says "forbidden" or "not found" instead of a generic failure.
///
/// The texts are systemd's own and have been stable for many releases; anything unknown is
/// a conflict between the request and the unit's state (a failed start, an inapplicable
/// reload), with systemd's message attached.
fn classify_failure(stderr: &str) -> Failure {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("access denied")
        || lower.contains("authentication required")
        || lower.contains("permission denied")
        || lower.contains("operation not permitted")
    {
        Failure::Kind(CommandErrorKind::PermissionDenied)
    } else if lower.contains("has not been booted with systemd") {
        Failure::Kind(CommandErrorKind::SystemdUnsupported)
    } else if lower.contains("failed to connect to bus")
        || lower.contains("failed to connect to user scope bus")
    {
        Failure::UserBus
    } else if lower.contains("not found.")
        || lower.contains("does not exist")
        || lower.contains("no such file or directory")
    {
        Failure::Kind(CommandErrorKind::NotFound)
    } else {
        Failure::Kind(CommandErrorKind::Conflict)
    }
}

/// The error a canceled tool run reports.
fn canceled(program: &str) -> CommandError {
    CommandError::new(
        CommandErrorKind::Canceled,
        format!("{program} canceled by server"),
    )
}

/// Reads a pipe to its end, keeping at most `limit` bytes and draining the rest so the child
/// never blocks on a full pipe; the flag tells whether anything was dropped.
async fn read_capped(
    reader: Option<impl AsyncRead + Unpin>,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let Some(mut reader) = reader else {
        return Ok((Vec::new(), false));
    };
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok((kept, truncated));
        }
        let room = limit.saturating_sub(kept.len());
        if read > room {
            truncated = true;
        }
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A test account with a fixed UID.
    fn account(name: &str, uid: u32) -> Account {
        Account {
            name: name.to_string(),
            uid,
            gid: uid + 1,
            home: PathBuf::from(format!("/home/{name}")),
        }
    }

    /// Looks up one variable of a tool's environment.
    fn variable(tool: &SystemdTool, name: &str) -> Option<String> {
        tool.environment()
            .into_iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }

    /// Verifies system tools run as the agent with the fixed environment only.
    #[test]
    fn system_tools_run_as_the_agent_without_a_user_session() {
        let tool = SystemdTool::systemctl(&Manager::System).args(["start", "--", "a.service"]);
        // Polkit must never wait for a password and unit names follow `--`.
        assert_eq!(
            tool.argv(),
            [
                "systemctl",
                "--no-pager",
                "--no-ask-password",
                "start",
                "--",
                "a.service"
            ]
        );
        // The parsers read C-locale text with UTC timestamps.
        assert_eq!(variable(&tool, "LC_ALL").as_deref(), Some("C"));
        assert_eq!(variable(&tool, "TZ").as_deref(), Some("UTC"));
        // The system manager needs no user bus.
        assert_eq!(variable(&tool, "XDG_RUNTIME_DIR"), None);
        assert_eq!(tool.switches_to(), None);
    }

    /// Verifies the agent's own user manager is reached with `--user` and its session paths.
    #[test]
    fn own_user_tools_get_the_user_session_without_switching() {
        let me = account("me", 1000);
        let tool = SystemdTool::systemctl(&Manager::User {
            account: me,
            switch_user: false,
        });
        // `--user` selects the user's manager.
        assert_eq!(tool.argv()[1], "--user");
        // The bus paths are set explicitly, because a service-launched agent has no session.
        assert_eq!(
            variable(&tool, "XDG_RUNTIME_DIR").as_deref(),
            Some("/run/user/1000")
        );
        assert_eq!(
            variable(&tool, "DBUS_SESSION_BUS_ADDRESS").as_deref(),
            Some("unix:path=/run/user/1000/bus")
        );
        // The agent already is this user.
        assert_eq!(tool.switches_to(), None);
    }

    /// Verifies a root agent reaches another user's manager as that user.
    #[test]
    fn root_switches_to_the_target_user() {
        let alice = account("alice", 1001);
        let tool = SystemdTool::analyze(&Manager::User {
            account: alice,
            switch_user: true,
        })
        .args(["unit-paths"]);
        // The user's manager only accepts its own UID on its private socket.
        assert_eq!(tool.switches_to(), Some(1001));
        // Unit paths below the home directory are computed from the user's own HOME.
        assert_eq!(variable(&tool, "HOME").as_deref(), Some("/home/alice"));
        assert_eq!(variable(&tool, "USER").as_deref(), Some("alice"));
        assert_eq!(
            tool.argv(),
            ["systemd-analyze", "--user", "--no-pager", "unit-paths"]
        );
    }

    /// Verifies the agent token never reaches a tool.
    #[test]
    fn agent_environment_is_not_inherited() {
        let tool = SystemdTool::loginctl();
        // Only the fixed variables (and PATH) are passed, so no secret can leak.
        assert!(
            tool.environment()
                .iter()
                .all(|(name, _)| name != redoor_core::process::AGENT_TOKEN_ENV)
        );
        assert!(tool.environment().iter().all(|(name, _)| {
            ["PATH", "LC_ALL", "TZ", "SYSTEMD_COLORS", "SYSTEMD_PAGER"].contains(&name.as_str())
        }));
    }

    /// Verifies systemd's error texts map to the statuses the UI explains.
    #[test]
    fn classifies_systemd_failures() {
        let cases = [
            (
                "Failed to start ssh.service: Interactive authentication required.",
                Failure::Kind(CommandErrorKind::PermissionDenied),
            ),
            (
                "Failed to start nope.service: Unit nope.service not found.",
                Failure::Kind(CommandErrorKind::NotFound),
            ),
            (
                "Failed to enable unit: Unit file nope.service does not exist.",
                Failure::Kind(CommandErrorKind::NotFound),
            ),
            (
                "Failed to connect to bus: No such file or directory",
                Failure::UserBus,
            ),
            (
                "System has not been booted with systemd as init system (PID 1). Can't operate.",
                Failure::Kind(CommandErrorKind::SystemdUnsupported),
            ),
            (
                "Job for a.service failed because the control process exited with error code.",
                Failure::Kind(CommandErrorKind::Conflict),
            ),
        ];
        for (stderr, expected) in cases {
            // Each failure keeps a status the UI can explain instead of a generic 500.
            assert_eq!(classify_failure(stderr), expected, "{stderr}");
        }
    }

    /// Verifies a failed user-bus connection becomes the typed "manager not running" error.
    #[test]
    fn user_bus_failures_mean_the_manager_is_not_running() {
        let tool = SystemdTool::systemctl(&Manager::User {
            account: account("me", 1000),
            switch_user: false,
        });
        let output = ToolOutput {
            status: std::os::unix::process::ExitStatusExt::from_raw(1 << 8),
            stdout: String::new(),
            stdout_truncated: false,
            stderr: "Failed to connect to bus: No medium found".to_string(),
        };
        // The UI offers linger for exactly this error kind.
        assert_eq!(
            tool.failure(&output).kind,
            CommandErrorKind::SystemdUserManagerNotRunning
        );
    }

    /// Verifies output past the cap is dropped but the pipe is still drained.
    #[tokio::test]
    async fn capped_reads_keep_the_head_and_drain_the_rest() {
        let input = vec![b'x'; 20_000];
        let (kept, truncated) = read_capped(Some(input.as_slice()), 100).await.unwrap();
        // Memory stays bounded however much the tool prints.
        assert_eq!(kept.len(), 100);
        assert!(truncated);
        let (kept, truncated) = read_capped(Some(&b"short"[..]), 100).await.unwrap();
        // Short output is kept whole.
        assert_eq!(kept, b"short");
        assert!(!truncated);
    }

    /// Verifies a missing tool is reported as unsupported systemd.
    #[tokio::test]
    async fn missing_tools_mean_systemd_is_unsupported() {
        let tool = SystemdTool::plain("redoor-no-such-systemctl");
        let error = tool.output(&CancellationToken::new()).await.unwrap_err();
        // A host without the tools cannot use the systemd view at all.
        assert_eq!(error.kind, CommandErrorKind::SystemdUnsupported);
    }

    /// Verifies a canceled run stops the tool and reports the cancel.
    #[tokio::test]
    async fn canceled_runs_report_canceled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let tool = SystemdTool::plain("sleep").args(["30"]);
        let error = tool.output(&cancel).await.unwrap_err();
        // The dispatcher answers the cancel with this kind; the child was killed on drop.
        assert_eq!(error.kind, CommandErrorKind::Canceled);
    }
}
