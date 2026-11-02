//! Process identity markers and in-place re-exec shared by every process role.

use std::{ffi::OsString, path::Path};

/// Signal `redoor upgrade` sends to make a long-lived role re-exec its launch binary.
///
/// Not SIGHUP, which a foreground process also receives when its terminal closes. Until a
/// role calls [`listen_for_reexec`] the default action terminates the process, so the
/// upgrade command checks a process's caught-signal mask before sending it.
pub const REEXEC_SIGNAL: nix::sys::signal::Signal = nix::sys::signal::Signal::SIGUSR2;

/// Starts catching [`REEXEC_SIGNAL`] so an upgrade can restart this process in place.
///
/// Must be called inside the Tokio runtime by the role that owns the process lifetime.
pub fn listen_for_reexec() -> std::io::Result<tokio::signal::unix::Signal> {
    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::from_raw(
        REEXEC_SIGNAL as i32,
    ))
}

/// Replaces this process with the same executable and arguments so supervisors keep tracking it.
///
/// Executes the path rather than the running image, so a restart after `redoor upgrade`
/// runs the upgraded binary.
pub fn reexec_current_process() -> ! {
    let exe = crate::executable::current().unwrap_or_else(|error| {
        eprintln!("restart: failed to resolve current executable: {error}");
        std::process::exit(1);
    });
    reexec_process(&exe)
}

/// Replaces this process from an explicit installed path after an atomic binary upgrade.
///
/// When the installed file cannot be executed (another CPU, a corrupt download, a `noexec`
/// mount), exiting would leave an unsupervised agent or server down for good. On Linux and
/// Android the running image stays reachable through `/proc/self/exe` even after its file was
/// replaced, so the process restarts on its old binary instead and stays reachable, where
/// the upgrade reports the wrong version.
pub fn reexec_process(exe: &Path) -> ! {
    // Command supplies argv[0], so only the original arguments are forwarded.
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();

    let error = exec_with_args(exe, exe, &args);
    eprintln!("restart: exec failed for {}: {error}", exe.display());
    if cfg!(any(target_os = "linux", target_os = "android")) {
        let running = Path::new("/proc/self/exe");
        // argv[0] keeps naming the installed path, which process discovery reads.
        let fallback_error = exec_with_args(running, exe, &args);
        eprintln!("restart: exec of the running image failed too: {fallback_error}");
    }
    std::process::exit(1);
}

/// Execs `program` with `args`, presenting it as `arg0`; returns only on failure.
fn exec_with_args(program: &Path, arg0: &Path, args: &[OsString]) -> std::io::Error {
    use std::os::unix::process::CommandExt;

    std::process::Command::new(program)
        .arg0(arg0)
        .args(args)
        .exec()
}

/// Environment variable a standalone or relayed agent may read its token from.
///
/// Shells and commands the agent starts must not inherit it: anything running in a terminal
/// could otherwise read the token and impersonate the server to every agent.
pub const AGENT_TOKEN_ENV: &str = "REDOOR_AGENT_TOKEN";

/// Marks the processes of a server-managed agent (`redoor agent managed` and its daemon).
///
/// Their owner is the server, which replaces them on every start with a different binary,
/// so they do not catch the upgrade re-exec signal and `redoor upgrade` skips them instead
/// of listing them for a manual restart.
pub const MANAGED_AGENT_ENV: &str = "REDOOR_MANAGED_AGENT";

/// Marks a detached child so it does not die with the short-lived CLI that spawned it.
pub const DETACHED_ENV: &str = "REDOOR_DETACHED";

/// Long-lived process that owns a PID file and optional daemon mode.
///
/// Lives in core (not the binary) because the server's managed-agent launcher and the
/// process-control commands must agree on the PID and log file names of each role.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessSlot {
    /// Standalone `redoor agent` process.
    Agent,
    /// `redoor server` process.
    Server,
}

impl ProcessSlot {
    /// Basename for PID and default log files (`agent`, `server`, `relay`).
    pub fn file_stem(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
        }
    }

    /// CLI path after `redoor` used in operator-facing stop guidance.
    pub fn command_path(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
        }
    }
}
