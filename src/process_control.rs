//! Coordinates one foreground or daemon process per application role.

use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use tokio::{fs, io::AsyncWriteExt, process::Command};

use crate::ServiceRole;

/// Internal marker used by the server because managed agents have their own watchdog lifecycle.
pub(crate) const MANAGED_AGENT_ENV: &str = "REDOOR_MANAGED_AGENT";

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
pub(crate) async fn acquire(role: ServiceRole) -> Result<Option<PidFile>> {
    if role == ServiceRole::Agent && std::env::var_os(MANAGED_AGENT_ENV).is_some() {
        return Ok(None);
    }

    let path = pid_path(role)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create PID directory '{}'", parent.display()))?;
    }

    let own_pid = std::process::id();
    let mut file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_pid(&path).await.unwrap_or(0);
        bail!(
            "{} is already running with PID {pid}; run `redoor {} stop` to stop it",
            role.cli_name(),
            role.cli_name()
        );
    }
    file.set_len(0).await?;
    file.write_all(own_pid.to_string().as_bytes()).await?;
    file.write_all(b"\n").await?;
    file.flush().await?;
    Ok(Some(PidFile {
        path,
        pid: own_pid,
        file,
    }))
}

/// Sends SIGTERM to the lock owner and waits until that exact process releases the PID file.
pub(crate) async fn stop(role: ServiceRole) -> Result<()> {
    let path = pid_path(role)?;
    if !fs::try_exists(&path).await? {
        bail!("{} is not running", role.cli_name());
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("{} is not running", role.cli_name());
    }
    let Some(pid) = read_pid(&path).await else {
        bail!("{} PID file is invalid", role.cli_name());
    };

    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .with_context(|| format!("Failed to stop {} process {pid}", role.cli_name()))?;
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
            role.cli_name()
        ),
    }
    if read_pid(&path).await == Some(pid) {
        let _ = fs::remove_file(path).await;
    }
    println!("Stopped {} process {pid}", role.cli_name());
    Ok(())
}

/// Re-launches the current command without `--daemon` and detaches its session and stdio.
pub(crate) async fn spawn_daemon(role: ServiceRole) -> Result<()> {
    ensure_not_running(role).await?;
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
        role.cli_name()
    );
    Ok(())
}

/// Rejects daemon launch before detaching so duplicate-start guidance reaches the caller.
async fn ensure_not_running(role: ServiceRole) -> Result<()> {
    if role == ServiceRole::Agent && std::env::var_os(MANAGED_AGENT_ENV).is_some() {
        return Ok(());
    }
    let path = pid_path(role)?;
    if !fs::try_exists(&path).await? {
        return Ok(());
    }
    let file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_pid(&path).await.unwrap_or(0);
        bail!(
            "{} is already running with PID {pid}; run `redoor {} stop` to stop it",
            role.cli_name(),
            role.cli_name()
        );
    }
    Ok(())
}

/// Resolves a role PID file inside the selected application's persistent data directory.
fn pid_path(role: ServiceRole) -> Result<PathBuf> {
    Ok(crate::app_name::user_data_directory()?.join(format!("{}.pid", role.cli_name())))
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
