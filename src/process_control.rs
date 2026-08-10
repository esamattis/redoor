//! Coordinates one foreground or daemon process per application role.

use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use tokio::{fs, io::AsyncWriteExt, process::Command};

/// Internal marker used by the server because managed agents have their own watchdog lifecycle.
pub(crate) const MANAGED_AGENT_ENV: &str = "REDOOR_MANAGED_AGENT";

/// Long-lived process that owns a PID file and optional daemon mode.
///
/// Distinct from service-manager roles (`ServiceRole`) so SSH relay can share
/// PID/daemon/stop/status without implying systemd or launchd install support.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessSlot {
    /// Standalone `redoor agent` process.
    Agent,
    /// `redoor server` process.
    Server,
    /// Local `redoor agent relay` SSH tunnel process.
    Relay,
}

impl ProcessSlot {
    /// Basename for PID and default log files (`agent`, `server`, `relay`).
    pub(crate) fn file_stem(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
            Self::Relay => "relay",
        }
    }

    /// CLI path after `redoor` used in operator-facing stop guidance.
    pub(crate) fn command_path(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
            Self::Relay => "agent relay",
        }
    }

    /// Managed local agents skip PID files so they do not fight the standalone agent lock.
    fn skips_pid_when_managed(self) -> bool {
        matches!(self, Self::Agent) && std::env::var_os(MANAGED_AGENT_ENV).is_some()
    }
}

/// Owns the path claimed by a long-lived process so startup failures can clean it up.
pub(crate) struct PidFile {
    path: PathBuf,
    pid: u32,
    /// Keeping this descriptor open makes the advisory lock represent process lifetime.
    file: fs::File,
}

impl PidFile {
    /// Removes only this process's claim, avoiding deletion after a concurrent replacement.
    pub(crate) async fn remove(self) {
        if read_pid(&self.path).await == Some(self.pid) {
            let _ = fs::remove_file(self.path).await;
        }
        drop(self.file);
    }
}

/// Atomically claims the role PID file, rejecting a process that is still alive.
pub(crate) async fn acquire(slot: ProcessSlot) -> Result<Option<PidFile>> {
    if slot.skips_pid_when_managed() {
        return Ok(None);
    }

    let path = pid_path(slot)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create PID directory '{}'", parent.display()))?;
    }

    claim_pid_file(slot, path).await.map(Some)
}

/// Claims an explicit PID path so every process role uses the same duplicate-start check.
async fn claim_pid_file(slot: ProcessSlot, path: PathBuf) -> Result<PidFile> {
    let own_pid = std::process::id();
    let mut file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_pid(&path).await.unwrap_or(0);
        bail!(
            "{} is already running with PID {pid}; run `redoor {} stop` to stop it",
            slot.file_stem(),
            slot.command_path()
        );
    }
    file.set_len(0).await?;
    file.write_all(own_pid.to_string().as_bytes()).await?;
    file.write_all(b"\n").await?;
    file.flush().await?;
    Ok(PidFile {
        path,
        pid: own_pid,
        file,
    })
}

/// Reports whether the lock owner is alive without changing process state.
pub(crate) async fn status(slot: ProcessSlot) -> Result<()> {
    let path = pid_path(slot)?;
    if !fs::try_exists(&path).await? {
        bail!("{} is not running", slot.file_stem());
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("{} is not running", slot.file_stem());
    }
    let Some(pid) = read_pid(&path).await else {
        bail!("{} PID file is invalid", slot.file_stem());
    };
    println!("{} is running with PID {pid}", slot.file_stem());
    Ok(())
}

/// Sends SIGTERM to the lock owner and waits until that exact process releases the PID file.
pub(crate) async fn stop(slot: ProcessSlot) -> Result<()> {
    let path = pid_path(slot)?;
    if !fs::try_exists(&path).await? {
        bail!("{} is not running", slot.file_stem());
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("{} is not running", slot.file_stem());
    }
    let Some(pid) = read_pid(&path).await else {
        bail!("{} PID file is invalid", slot.file_stem());
    };

    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .with_context(|| format!("Failed to stop {} process {pid}", slot.file_stem()))?;
    let stopped = tokio::time::timeout(Duration::from_secs(10), async {
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        while !try_lock(&file)? {
            interval.tick().await;
        }
        anyhow::Ok(())
    })
    .await;
    match stopped {
        Ok(result) => result?,
        Err(_) => bail!(
            "Timed out waiting for {} process {pid} to stop",
            slot.file_stem()
        ),
    }
    if read_pid(&path).await == Some(pid) {
        let _ = fs::remove_file(path).await;
    }
    println!("Stopped {} process {pid}", slot.file_stem());
    Ok(())
}

/// Re-launches the current command without `--daemon` and detaches its session and stdio.
pub(crate) async fn spawn_daemon(slot: ProcessSlot) -> Result<()> {
    ensure_not_running(slot).await?;
    let executable = std::env::current_exe().context("Failed to locate the current executable")?;
    let arguments: Vec<OsString> = std::env::args_os()
        .skip(1)
        .filter(|argument| argument != "--daemon")
        .collect();
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // A new session prevents terminal hangups from terminating the background process.
        unsafe {
            command.as_std_mut().pre_exec(|| {
                nix::unistd::setsid()
                    .map(|_| ())
                    .map_err(std::io::Error::from)
            });
        }
    }

    let child = command.spawn().context("Failed to start daemon process")?;
    let pid = child.id().context("Daemon process did not receive a PID")?;
    println!(
        "Started {} process {pid} in the background",
        slot.file_stem()
    );
    Ok(())
}

/// Rejects daemon launch before detaching so duplicate-start guidance reaches the caller.
async fn ensure_not_running(slot: ProcessSlot) -> Result<()> {
    if slot.skips_pid_when_managed() {
        return Ok(());
    }
    let path = pid_path(slot)?;
    if !fs::try_exists(&path).await? {
        return Ok(());
    }
    let file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_pid(&path).await.unwrap_or(0);
        bail!(
            "{} is already running with PID {pid}; run `redoor {} stop` to stop it",
            slot.file_stem(),
            slot.command_path()
        );
    }
    Ok(())
}

/// Resolves a role PID file inside the selected application's persistent data directory.
fn pid_path(slot: ProcessSlot) -> Result<PathBuf> {
    Ok(crate::app_name::user_data_directory()?.join(format!("{}.pid", slot.file_stem())))
}

/// Reads a PID defensively so malformed or partially written stale files can be replaced.
async fn read_pid(path: &PathBuf) -> Option<u32> {
    fs::read_to_string(path).await.ok()?.trim().parse().ok()
}

/// Opens or creates a PID file without using its mere existence as process state.
async fn open_pid_file(path: &PathBuf) -> Result<fs::File> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .await
        .context("Failed to open PID file")
}

/// Attempts to own the process-lifetime lock without blocking the async runtime.
fn try_lock(file: &fs::File) -> Result<bool> {
    use std::os::fd::AsRawFd;

    // SAFETY: `file` owns a valid descriptor for the duration of this non-blocking syscall.
    match Errno::result(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }) {
        Ok(_) => Ok(true),
        Err(Errno::EWOULDBLOCK) => Ok(false),
        Err(error) => Err(error).context("Failed to lock PID file"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Protects standalone relays from a second start while the first PID owns the lock.
    #[tokio::test]
    async fn relay_rejects_a_second_pid_claim() {
        let path = std::env::temp_dir().join(format!(
            "redoor-relay-double-start-{}.pid",
            std::process::id()
        ));
        let first = claim_pid_file(ProcessSlot::Relay, path.clone())
            .await
            .expect("the first relay should claim its PID file");

        let error = match claim_pid_file(ProcessSlot::Relay, path).await {
            Ok(_) => panic!("a second relay must not claim the active PID file"),
            Err(error) => error,
        };
        // The PID identifies the process operators need to inspect or stop.
        assert!(
            error.to_string().contains(&format!(
                "relay is already running with PID {}",
                std::process::id()
            )),
            "duplicate relay startup should report the PID-file owner: {error:#}"
        );
        // Relay-specific stop guidance must not point at the standalone agent slot.
        assert!(
            error
                .to_string()
                .contains("run `redoor agent relay stop` to stop it"),
            "duplicate relay startup should provide the relay stop command: {error:#}"
        );

        first.remove().await;
    }
}
