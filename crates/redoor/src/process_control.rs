//! Coordinates process ownership, daemonization, and single-instance runtime files.
//!
//! Foreground Redoor processes belong to the process that launched them. They must
//! therefore exit if that parent is killed, otherwise a terminated terminal,
//! supervisor, or server can leave an agent reconnecting indefinitely. Daemons are
//! deliberately different: the short-lived CLI re-execs Redoor in a new session and
//! marks that child as detached so the same parent-death machinery does not stop it.
//!
//! Parent-death notification is platform-specific. Linux-family kernels can ask the
//! kernel to deliver a signal, while macOS requires a dedicated `kqueue` watcher.
//! PID-file advisory locks provide the separate single-instance guarantee; the lock,
//! rather than file existence or a recycled numeric PID, is the source of liveness.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use redoor_core::paths::AppPaths;
use redoor_core::process::{DETACHED_ENV, ProcessSlot};
use redoor_protocol::identity::{BinaryIdentity, ServerBuildMode};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, process::Command};

/// Parent process observed when this process started.
///
/// Captured once at the top of `main`, before anything can await, and passed to the role
/// that needs it: if the parent dies before the lifetime hook is installed the kernel will
/// not replay the death, so the hook compares against this snapshot instead of re-reading.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LaunchParent(Pid);

impl LaunchParent {
    /// Records the current parent PID.
    pub(crate) fn capture() -> Self {
        Self(Pid::parent())
    }

    /// Ties this foreground process to its parent so SIGKILL of the supervisor cannot leak it.
    pub(crate) fn bind_lifetime(self) {
        if std::env::var_os(DETACHED_ENV).is_some() {
            return;
        }

        // Linux and Android expose a kernel-maintained parent-death signal, so no
        // userspace task or thread needs to remain scheduled after registration.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        bind_to_parent_lifetime_linux(self.0);

        // macOS has no PR_SET_PDEATHSIG equivalent. A kqueue watcher provides the
        // closest behavior and also observes parents terminated with SIGKILL.
        #[cfg(target_os = "macos")]
        bind_to_parent_lifetime_macos(self.0);
    }
}

/// Exits when the recorded parent is no longer ours; the kernel does not replay PR_SET_PDEATHSIG.
///
/// A hard exit is intended: the process is an orphan of a dead supervisor and must not
/// start serving, so there is nothing to unwind into.
fn exit_if_parent_gone(parent: Pid) {
    if nix::unistd::getppid() != parent {
        std::process::exit(1);
    }
}

/// Registers Linux-kernel parent-death delivery, then closes the registration race.
///
/// Android uses the Linux kernel facility too. It is named separately by Rust's
/// `target_os`, so both targets must be included even though the behavior is shared.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn bind_to_parent_lifetime_linux(parent: Pid) {
    if let Err(error) = set_parent_death_sigterm() {
        eprintln!("Failed to bind process lifetime to the parent: {error}");
    }
    exit_if_parent_gone(parent);
}

/// Configures the Linux-kernel `PR_SET_PDEATHSIG` facility for Linux and Android.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn set_parent_death_sigterm() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // nix exposes its checked prctl wrapper only for the Rust Linux target.
        nix::sys::prctl::set_pdeathsig(Some(Signal::SIGTERM)).map_err(std::io::Error::from)
    }
    #[cfg(target_os = "android")]
    {
        // Android is a Linux kernel target, but nix does not expose the Linux-only
        // safe wrapper there. libc still provides the same prctl syscall ABI.
        // SAFETY: PR_SET_PDEATHSIG consumes SIGTERM as an integer value; the three
        // remaining variadic arguments are unused and passed as zero, with no pointers.
        let result = unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

/// Registers a macOS process-exit event and dedicates a thread to observing it.
///
/// Unlike the Linux kernel facility, `kqueue` reports the event to this process
/// instead of delivering a termination signal, so a live watcher must explicitly
/// exit Redoor when the parent disappears.
#[cfg(target_os = "macos")]
fn bind_to_parent_lifetime_macos(parent: Pid) {
    use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent, Kqueue};

    let queue = match Kqueue::new() {
        Ok(queue) => queue,
        Err(error) => {
            eprintln!("Failed to bind process lifetime to the parent: {error}");
            return;
        }
    };
    let change = KEvent::new(
        parent.as_raw() as usize,
        EventFilter::EVFILT_PROC,
        EvFlags::EV_ADD | EvFlags::EV_ONESHOT,
        FilterFlag::NOTE_EXIT,
        0,
        0,
    );
    let zero_timeout = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    match queue.kevent(&[change], &mut [], Some(zero_timeout)) {
        Ok(_) => {}
        Err(Errno::ESRCH) => std::process::exit(1),
        Err(error) => {
            eprintln!("Failed to bind process lifetime to the parent: {error}");
            return;
        }
    }
    exit_if_parent_gone(parent);

    // A dedicated OS thread cannot be starved or dropped the way a Tokio task can.
    if let Err(error) = std::thread::Builder::new()
        .name("redoor-parent-death".into())
        .spawn(move || watch_parent_exit(queue))
    {
        eprintln!("Failed to watch parent process lifetime: {error}");
    }
}

/// Blocks on macOS until the registered parent exits, then terminates this process.
///
/// This runs on an OS thread because a Tokio task can be cancelled or starved during
/// runtime teardown, exactly when the parent-death guarantee matters most.
#[cfg(target_os = "macos")]
fn watch_parent_exit(queue: nix::sys::event::Kqueue) -> ! {
    use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent};

    let mut events = [KEvent::new(
        0,
        EventFilter::EVFILT_PROC,
        EvFlags::empty(),
        FilterFlag::empty(),
        0,
        0,
    )];
    loop {
        match queue.kevent(&[], &mut events, None) {
            // kevent is not restarted by SA_RESTART; Tokio's SIGCHLD handler would otherwise
            // tear down the whole process the first time a child exits.
            Ok(0) | Err(Errno::EINTR) => {}
            Err(Errno::ESRCH) => std::process::exit(1),
            Ok(_) => {
                let event = events[0];
                if event.fflags().contains(FilterFlag::NOTE_EXIT)
                    || event.flags().contains(EvFlags::EV_ERROR)
                {
                    std::process::exit(1);
                }
            }
            Err(_) => std::process::exit(1),
        }
    }
}

/// Owns the path claimed by a long-lived process; dropping it releases the claim.
///
/// Cleanup lives in `Drop` so every return path of a role (success, startup error,
/// runtime error) removes the file without each caller remembering to do it.
pub(crate) struct PidFile {
    path: PathBuf,
    pid: u32,
    /// Keeping this descriptor open makes the advisory lock represent process lifetime;
    /// it is only held, never read, and closes after `Drop` removed the file.
    _lock: fs::File,
}

/// Runtime identity every long-lived role records in its PID file.
///
/// The running process writes its own build identity because only it knows which binary
/// image is in memory: after `redoor upgrade` replaces the executable on disk, inspecting the
/// file would describe the new build while the process still runs the old one.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ProcessPidMetadata {
    /// Process holding the advisory lock.
    pub(crate) pid: u32,
    /// UTC launch timestamp of the current binary image; re-exec rewrites it.
    /// `None` only for legacy bare-number PID files.
    pub(crate) started_at: Option<String>,
    /// Build of the running image, `None` for files written before it was recorded.
    pub(crate) binary: Option<BinaryIdentity>,
}

impl ProcessPidMetadata {
    /// Captures this process's identity at claim time.
    pub(crate) fn current() -> Self {
        Self {
            pid: std::process::id(),
            started_at: Some(jiff::Timestamp::now().to_string()),
            binary: Some(redoor_core::identity::current_binary_identity()),
        }
    }

    /// Parses a JSON record, falling back to the bare PID older binaries wrote so a process
    /// started before an upgrade can still be inspected and stopped.
    pub(crate) fn parse(content: &str) -> Option<Self> {
        if let Ok(metadata) = serde_json::from_str(content) {
            return Some(metadata);
        }
        let pid = content.trim().parse().ok()?;
        Some(Self {
            pid,
            started_at: None,
            binary: None,
        })
    }

    /// Reads a record defensively so malformed or partially written stale files can be replaced.
    async fn read(path: &PathBuf) -> Option<Self> {
        Self::parse(&fs::read_to_string(path).await.ok()?)
    }

    /// Prints the liveness line followed by the build details operators need to tell which
    /// binary is actually running, e.g. whether a restart after an upgrade is still pending.
    /// The PID file path is included so operators can find the raw record without knowing
    /// how the data directory resolves for the selected application name.
    fn print_status(&self, description: &str, pid_file: &Path) {
        println!("{description} is running with PID {}", self.pid);
        println!("  pid file:   {}", pid_file.display());
        let Some(binary) = &self.binary else {
            println!("  build:      unknown, the process predates build recording in PID files");
            return;
        };
        let version_note = if binary.version_dirty {
            format!(" (dirty: HEAD was not tagged v{})", binary.version)
        } else {
            String::new()
        };
        let revision_note = if binary.git_dirty {
            " (dirty: uncommitted changes at build time)"
        } else {
            ""
        };
        let build_mode = match binary.build_mode {
            ServerBuildMode::Debug => "debug",
            ServerBuildMode::Release => "release",
            ServerBuildMode::Unknown => "unknown",
        };
        println!("  version:    {}{version_note}", binary.version);
        println!("  revision:   {}{revision_note}", binary.git_rev);
        println!("  build:      {build_mode}, built {}", binary.build_date);
        if let Some(started_at) = &self.started_at {
            println!("  started at: {started_at}");
        }
        let cli = redoor_core::identity::current_binary_identity();
        if *binary != cli {
            println!(
                "  note:       differs from this redoor binary ({}, revision {}, built {}); restart to run it",
                cli.version, cli.git_rev, cli.build_date
            );
        }
    }
}

/// Runtime identity persisted for a named relay without recording its secret.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct RelayPidMetadata {
    /// Fields shared with the other roles, flattened so every PID file exposes a top-level `pid`.
    #[serde(flatten)]
    pub(crate) process: ProcessPidMetadata,
    /// Stable configured relay identity.
    pub(crate) id: String,
    /// SSH destination captured in case configuration changes while running.
    pub(crate) target: String,
    /// Canonical configured server address captured for status diagnostics.
    pub(crate) server: String,
    /// Effective server-side agent name.
    pub(crate) agent_name: String,
    /// Remote application namespace isolating this agent's PID and data files.
    pub(crate) agent_app_name: String,
    /// Log path used by the running relay.
    pub(crate) log: String,
}

impl PidFile {
    /// Wraps a PID file this process has just locked and written, so dropping it releases
    /// the claim like any other role's.
    pub(crate) fn claimed(path: PathBuf, pid: u32, lock: fs::File) -> Self {
        Self {
            path,
            pid,
            _lock: lock,
        }
    }
}

impl Drop for PidFile {
    /// Removes only this process's claim, avoiding deletion after a concurrent replacement.
    ///
    /// `Drop` cannot await, so this uses blocking std I/O on one tiny local file; the
    /// advisory lock is released afterwards when the `file` field is dropped.
    fn drop(&mut self) {
        let Ok(content) = std::fs::read_to_string(&self.path) else {
            return;
        };
        // Relay records parse as the shared metadata too because unknown fields are ignored.
        if ProcessPidMetadata::parse(&content).is_some_and(|metadata| metadata.pid == self.pid) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Atomically claims the role PID file, rejecting a process that is still alive.
pub(crate) async fn acquire(slot: ProcessSlot, paths: &AppPaths) -> Result<PidFile> {
    let path = pid_path(slot, paths)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create PID directory '{}'", parent.display()))?;
    }

    claim_pid_file(slot, path).await
}

/// Claims one named relay runtime file and writes its JSON launch metadata.
pub(crate) async fn acquire_relay(metadata: RelayPidMetadata, paths: &AppPaths) -> Result<PidFile> {
    let path = relay_pid_path(&metadata.id, paths)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create PID directory '{}'", parent.display()))?;
    }
    let mut file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_relay_metadata(&path)
            .await
            .map_or(0, |record| record.process.pid);
        bail!(
            "relay '{}' is already running with PID {pid}; run `redoor agent relay stop {}` to stop it",
            metadata.id,
            metadata.id
        );
    }
    write_pid_record(&mut file, &metadata).await?;
    Ok(PidFile {
        path,
        pid: metadata.process.pid,
        _lock: file,
    })
}

/// Claims an explicit PID path so every process role uses the same duplicate-start check.
async fn claim_pid_file(slot: ProcessSlot, path: PathBuf) -> Result<PidFile> {
    let metadata = ProcessPidMetadata::current();
    let mut file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = ProcessPidMetadata::read(&path)
            .await
            .map_or(0, |record| record.pid);
        bail!(
            "{} is already running with PID {pid}; run `redoor {} stop` to stop it",
            slot.file_stem(),
            slot.command_path()
        );
    }
    write_pid_record(&mut file, &metadata).await?;
    Ok(PidFile {
        path,
        pid: metadata.pid,
        _lock: file,
    })
}

/// Replaces the locked file's contents with one pretty JSON record so both tools and humans
/// can read it; called only while holding the lock, so no reader sees a competing writer.
pub(crate) async fn write_pid_record(file: &mut fs::File, record: &impl Serialize) -> Result<()> {
    let json = serde_json::to_vec_pretty(record).context("Failed to encode PID file")?;
    file.set_len(0).await?;
    file.write_all(&json).await?;
    file.write_all(b"\n").await?;
    file.flush().await?;
    Ok(())
}

/// Reports whether the lock owner is alive without changing process state.
pub(crate) async fn status(slot: ProcessSlot, paths: &AppPaths) -> Result<()> {
    let path = pid_path(slot, paths)?;
    if !fs::try_exists(&path).await? {
        bail!("{} is not running", slot.file_stem());
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("{} is not running", slot.file_stem());
    }
    let Some(metadata) = ProcessPidMetadata::read(&path).await else {
        bail!("{} PID file is invalid", slot.file_stem());
    };
    metadata.print_status(slot.file_stem(), &path);
    Ok(())
}

/// Reports whether one named relay owns its runtime-file lock.
pub(crate) async fn status_relay(id: &str, paths: &AppPaths) -> Result<()> {
    let (lock, metadata) = open_running_relay(id, paths).await?;
    metadata
        .process
        .print_status(&format!("relay '{id}'"), &relay_pid_path(id, paths)?);
    drop(lock);
    Ok(())
}

/// Sends SIGTERM to the lock owner and waits until that exact process releases the PID file.
pub(crate) async fn stop(slot: ProcessSlot, paths: &AppPaths) -> Result<()> {
    let path = pid_path(slot, paths)?;
    if !fs::try_exists(&path).await? {
        bail!("{} is not running", slot.file_stem());
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("{} is not running", slot.file_stem());
    }
    let Some(pid) = ProcessPidMetadata::read(&path)
        .await
        .map(|record| record.pid)
    else {
        bail!("{} PID file is invalid", slot.file_stem());
    };

    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .with_context(|| format!("Failed to stop {} process {pid}", slot.file_stem()))?;
    wait_for_unlock(&file, slot.file_stem(), pid).await?;
    if ProcessPidMetadata::read(&path)
        .await
        .is_some_and(|record| record.pid == pid)
    {
        let _ = fs::remove_file(path).await;
    }
    println!("Stopped {} process {pid}", slot.file_stem());
    Ok(())
}

/// Stops one named relay and waits for its exact runtime-file lock to be released.
pub(crate) async fn stop_relay(id: &str, paths: &AppPaths) -> Result<()> {
    let path = relay_pid_path(id, paths)?;
    if !fs::try_exists(&path).await? {
        bail!("relay '{id}' is not running");
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("relay '{id}' is not running");
    }
    let metadata = read_relay_metadata(&path)
        .await
        .with_context(|| format!("relay '{id}' PID file is invalid"))?;
    let pid = metadata.process.pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .with_context(|| format!("Failed to stop relay '{id}' process {pid}"))?;
    wait_for_unlock(&file, "relay", pid).await?;
    if read_relay_metadata(&path)
        .await
        .is_some_and(|record| record.process.pid == pid)
    {
        let _ = fs::remove_file(path).await;
    }
    println!("Stopped relay '{id}' process {pid}");
    Ok(())
}

/// Re-launches the current command without `--daemon` and detaches its session and stdio.
pub(crate) async fn spawn_daemon(slot: ProcessSlot, paths: &AppPaths) -> Result<()> {
    ensure_not_running(slot, paths).await?;
    spawn_daemon_process(slot.file_stem()).await
}

/// Detaches one named relay after checking its own runtime-file lock.
pub(crate) async fn spawn_relay_daemon(id: &str, paths: &AppPaths) -> Result<()> {
    ensure_relay_not_running(id, paths).await?;
    spawn_daemon_process(&format!("relay '{id}'")).await
}

/// Rejects daemon launch before detaching so duplicate-start guidance reaches the caller.
async fn ensure_not_running(slot: ProcessSlot, paths: &AppPaths) -> Result<()> {
    let path = pid_path(slot, paths)?;
    if !fs::try_exists(&path).await? {
        return Ok(());
    }
    let file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = ProcessPidMetadata::read(&path)
            .await
            .map_or(0, |record| record.pid);
        bail!(
            "{} is already running with PID {pid}; run `redoor {} stop` to stop it",
            slot.file_stem(),
            slot.command_path()
        );
    }
    Ok(())
}

/// Rejects a detached named-relay launch while the selected ID is active.
async fn ensure_relay_not_running(id: &str, paths: &AppPaths) -> Result<()> {
    let path = relay_pid_path(id, paths)?;
    if !fs::try_exists(&path).await? {
        return Ok(());
    }
    let file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_relay_metadata(&path)
            .await
            .map_or(0, |record| record.process.pid);
        bail!(
            "relay '{id}' is already running with PID {pid}; run `redoor agent relay stop {id}` to stop it"
        );
    }
    Ok(())
}

/// Spawns the current command without `--daemon` in a new session, reporting `description`.
async fn spawn_daemon_process(description: &str) -> Result<()> {
    let executable =
        redoor_core::executable::current().context("Failed to locate the current executable")?;
    let arguments: Vec<OsString> = std::env::args_os()
        .skip(1)
        .filter(|argument| argument != "--daemon")
        .collect();
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env(DETACHED_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // A new session prevents terminal hangups from terminating the background process.
        // SAFETY: this closure runs after fork and before exec, so it calls only
        // `setsid` and converts its errno without touching locks or shared runtime state.
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
    println!("Started {description} process {pid} in the background");
    Ok(())
}

/// Resolves a role PID file inside the selected application's persistent data directory.
pub(crate) fn pid_path(slot: ProcessSlot, paths: &AppPaths) -> Result<PathBuf> {
    Ok(paths.data_dir()?.join(format!("{}.pid", slot.file_stem())))
}

/// Resolves the isolated runtime file for one validated relay ID.
pub(crate) fn relay_pid_path(id: &str, paths: &AppPaths) -> Result<PathBuf> {
    redoor_core::config::parse_relay_id(id).map_err(anyhow::Error::msg)?;
    Ok(paths.data_dir()?.join("relays").join(format!("{id}.pid")))
}

/// Reads one relay runtime record without interpreting file existence as liveness.
pub(crate) async fn read_relay_metadata(path: &PathBuf) -> Option<RelayPidMetadata> {
    let bytes = fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Opens a running relay and returns its locked descriptor and persisted metadata.
async fn open_running_relay(id: &str, paths: &AppPaths) -> Result<(fs::File, RelayPidMetadata)> {
    let path = relay_pid_path(id, paths)?;
    if !fs::try_exists(&path).await? {
        bail!("relay '{id}' is not running");
    }
    let file = open_pid_file(&path).await?;
    if try_lock(&file)? {
        let _ = fs::remove_file(&path).await;
        bail!("relay '{id}' is not running");
    }
    let metadata = read_relay_metadata(&path)
        .await
        .with_context(|| format!("relay '{id}' PID file is invalid"))?;
    Ok((file, metadata))
}

/// Polls an advisory lock so stop confirms process exit rather than only signal delivery.
async fn wait_for_unlock(file: &fs::File, description: &str, pid: u32) -> Result<()> {
    let stopped = tokio::time::timeout(Duration::from_secs(10), async {
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        while !try_lock(file)? {
            interval.tick().await;
        }
        anyhow::Ok(())
    })
    .await;
    match stopped {
        Ok(result) => result,
        Err(_) => bail!("Timed out waiting for {description} process {pid} to stop"),
    }
}

/// Opens or creates a PID file without using its mere existence as process state.
pub(crate) async fn open_pid_file(path: &PathBuf) -> Result<fs::File> {
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
pub(crate) fn try_lock(file: &fs::File) -> Result<bool> {
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

    /// Protects a named relay while preserving its JSON runtime identity.
    #[tokio::test]
    async fn relay_rejects_a_second_pid_claim() {
        let directory = redoor_core::test_support::TempDir::create();
        let path = directory.path().join("relay.pid");
        let metadata = RelayPidMetadata {
            process: ProcessPidMetadata::current(),
            id: "production".to_string(),
            target: "user@example.com".to_string(),
            server: "https://redoor.example.com".to_string(),
            agent_name: "production-agent".to_string(),
            agent_app_name: "redoor-relay-production".to_string(),
            log: "/tmp/production.log".to_string(),
        };
        let mut file = open_pid_file(&path).await.unwrap();
        assert!(try_lock(&file).unwrap());
        file.set_len(0).await.unwrap();
        file.write_all(&serde_json::to_vec_pretty(&metadata).unwrap())
            .await
            .unwrap();
        file.flush().await.unwrap();
        let first = PidFile {
            path: path.clone(),
            pid: metadata.process.pid,
            _lock: file,
        };

        let record = read_relay_metadata(&path)
            .await
            .expect("relay PID metadata should be valid JSON");
        // Runtime metadata must retain the identity needed after TOML changes.
        assert_eq!(record.id, "production");
        // The PID identifies the process operators need to inspect or stop.
        assert!(
            record.process.pid > 0,
            "relay JSON should contain the lock owner's PID"
        );
        // Status reports the relay's own build, so it must survive the flattened round trip.
        assert_eq!(
            record.process.binary,
            Some(redoor_core::identity::current_binary_identity())
        );

        drop(first);
        // Normal relay exit must remove JSON records just like numeric role PID files.
        assert!(
            !path.exists(),
            "relay PID cleanup should remove its own JSON file"
        );
    }

    /// Processes started by a binary that wrote bare PIDs must stay inspectable and stoppable
    /// after an upgrade, until they are restarted and rewrite the file as JSON.
    #[test]
    fn parses_legacy_numeric_pid_files() {
        let metadata = ProcessPidMetadata::parse("4242\n").expect("legacy PID should parse");
        // The PID is all stop needs to signal the old process.
        assert_eq!(metadata.pid, 4242);
        // Status must not invent a build identity the old process never recorded.
        assert!(metadata.binary.is_none());
    }

    /// Role PID files carry the running build so status can report it without asking the process.
    #[test]
    fn role_pid_records_round_trip_the_build_identity() {
        let json = serde_json::to_string_pretty(&ProcessPidMetadata::current()).unwrap();
        let metadata = ProcessPidMetadata::parse(&json).expect("JSON record should parse");
        // The PID must survive so stop and duplicate-start checks keep working.
        assert_eq!(metadata.pid, std::process::id());
        // The identity is what status prints, so it must not be lost in serialization.
        assert_eq!(
            metadata.binary,
            Some(redoor_core::identity::current_binary_identity())
        );
    }

    const PARENT_DEATH_CHILD_ENV: &str = "REDOOR_PARENT_DEATH_TEST_CHILD";
    const PARENT_DEATH_READY_ENV: &str = "REDOOR_PARENT_DEATH_TEST_READY";
    const PARENT_DEATH_SURVIVED_ENV: &str = "REDOOR_PARENT_DEATH_TEST_SURVIVED";

    /// Runs only when spawned as a helper so cargo's test harness is not killed by the hook.
    #[test]
    fn parent_death_child_dispatch_entry() {
        run_parent_death_test_child();
    }

    /// Turns this test binary into the watched child without adding a separate helper crate.
    fn run_parent_death_test_child() {
        let Ok(mode) = std::env::var(PARENT_DEATH_CHILD_ENV) else {
            return;
        };
        match mode.as_str() {
            "foreground" | "detached" => {
                LaunchParent::capture().bind_lifetime();
                write_ready_pid();
                park_forever();
            }
            "already-dead" => {
                let parent = LaunchParent::capture();
                write_ready_pid();
                while nix::unistd::getppid() == parent.0 {
                    std::thread::yield_now();
                }
                parent.bind_lifetime();
                if let Ok(path) = std::env::var(PARENT_DEATH_SURVIVED_ENV) {
                    let _ = std::fs::write(path, "survived");
                }
                std::process::exit(0);
            }
            other => panic!("unknown parent-death test child mode {other}"),
        }
    }

    /// Publishes the helper pid through a file so the parent can wait without sleeping.
    fn write_ready_pid() {
        let path = std::env::var(PARENT_DEATH_READY_ENV).expect("ready path");
        std::fs::write(path, std::process::id().to_string()).expect("write ready pid");
    }

    /// Keeps the helper alive until the parent-death hook or the test kills it.
    fn park_forever() -> ! {
        loop {
            std::thread::park();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    /// Waits for a helper file without inserting fixed sleeps into process-lifetime tests.
    fn wait_for_file(path: &std::path::Path) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(contents) = std::fs::read_to_string(path)
                && !contents.is_empty()
            {
                return contents;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            std::thread::yield_now();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    /// Treats ESRCH as death so tests can poll liveness the same way operators use `kill -0`.
    fn process_is_alive(pid: i32) -> bool {
        !matches!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH))
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    /// Polls until `kill(pid, 0)` fails so parent-death coverage does not depend on sleeps.
    fn wait_until_dead(pid: i32) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while process_is_alive(pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "process {pid} should have exited after its parent died"
            );
            std::thread::yield_now();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    /// Spawns this test binary under `sh` so SIGKILL of the shell is a real parent death.
    fn spawn_parent_death_child(mode: &str, detached: bool) -> ParentDeathChild {
        let directory = redoor_core::test_support::TempDir::create();
        let ready = directory.path().join("ready");
        let survived = directory.path().join("survived");
        let exe = std::env::current_exe().expect("test executable");
        let command = format!(
            "'{}' process_control::tests::parent_death_child_dispatch_entry --exact --nocapture; true",
            exe.display()
        );
        let mut sh = std::process::Command::new("sh");
        sh.arg("-c")
            .arg(command)
            .env(PARENT_DEATH_CHILD_ENV, mode)
            .env(PARENT_DEATH_READY_ENV, &ready)
            .env(PARENT_DEATH_SURVIVED_ENV, &survived)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if detached {
            sh.env(DETACHED_ENV, "1");
        }
        let parent = sh.spawn().expect("spawn parent-death helper");
        let child_pid: i32 = wait_for_file(&ready)
            .trim()
            .parse()
            .expect("ready file should contain the helper pid");
        // bash execs a lone `sh -c` command; `; true` keeps a real parent to SIGKILL.
        assert_ne!(
            parent.id() as i32,
            child_pid,
            "helper must remain a child of the shell we are about to kill"
        );
        ParentDeathChild {
            parent,
            child_pid,
            _directory: directory,
            survived,
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    /// Owns the intermediate shell and helper so a failed assertion cannot leak them.
    struct ParentDeathChild {
        parent: std::process::Child,
        child_pid: i32,
        _directory: redoor_core::test_support::TempDir,
        survived: PathBuf,
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    impl Drop for ParentDeathChild {
        /// SIGKILL leftovers so a failed lifetime assertion cannot poison later tests.
        fn drop(&mut self) {
            let _ = self.parent.kill();
            let _ = self.parent.wait();
            let _ = kill(Pid::from_raw(self.child_pid), Signal::SIGKILL);
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    /// SIGKILLs the helper's parent because that is the Playwright / aborted-`pn test` failure.
    fn kill_parent(child: &mut ParentDeathChild) {
        let parent_pid = child.parent.id() as i32;
        let _ = kill(Pid::from_raw(parent_pid), Signal::SIGKILL);
        let _ = child.parent.wait();
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    #[tokio::test]
    async fn foreground_child_exits_after_parent_is_killed() {
        let mut child = spawn_parent_death_child("foreground", false);
        kill_parent(&mut child);
        wait_until_dead(child.child_pid);
        // SIGKILL of the supervisor must take the foreground child with it.
        assert!(
            !process_is_alive(child.child_pid),
            "foreground child {} should exit after parent SIGKILL",
            child.child_pid
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    #[tokio::test]
    async fn detached_child_survives_after_spawning_cli_exits() {
        let mut child = spawn_parent_death_child("detached", true);
        kill_parent(&mut child);
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            // A wrongly installed hook may deliver SIGTERM shortly after the parent is reaped.
            assert!(
                process_is_alive(child.child_pid),
                "detached child {} should survive parent exit",
                child.child_pid
            );
            std::thread::yield_now();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "android"))]
    #[tokio::test]
    async fn child_exits_when_parent_is_already_dead_before_the_hook() {
        let mut child = spawn_parent_death_child("already-dead", false);
        kill_parent(&mut child);
        wait_until_dead(child.child_pid);
        // Binding after the parent is gone must not leave an orphan running forever.
        assert!(
            !child.survived.exists(),
            "already-orphaned child should exit inside bind_to_parent_lifetime"
        );
    }
}
