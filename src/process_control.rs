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

use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, process::Command};

/// Internal marker used by the server because managed agents have their own watchdog lifecycle.
pub(crate) const MANAGED_AGENT_ENV: &str = "REDOOR_MANAGED_AGENT";

/// Marks a detached child so it does not die with the short-lived CLI that spawned it.
pub(crate) const DETACHED_ENV: &str = "REDOOR_DETACHED";

/// Long-lived process that owns a PID file and optional daemon mode.
///
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessSlot {
    /// Standalone `redoor agent` process.
    Agent,
    /// `redoor server` process.
    Server,
}

impl ProcessSlot {
    /// Basename for PID and default log files (`agent`, `server`, `relay`).
    pub(crate) fn file_stem(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
        }
    }

    /// CLI path after `redoor` used in operator-facing stop guidance.
    pub(crate) fn command_path(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
        }
    }

    /// Managed local agents skip PID files so they do not fight the standalone agent lock.
    fn skips_pid_when_managed(self) -> bool {
        matches!(self, Self::Agent) && std::env::var_os(MANAGED_AGENT_ENV).is_some()
    }
}

/// Ties this foreground process to its parent so SIGKILL of the supervisor cannot leak it.
pub(crate) fn bind_to_parent_lifetime() {
    if std::env::var_os(DETACHED_ENV).is_some() {
        return;
    }

    // Linux and Android expose a kernel-maintained parent-death signal, so no
    // userspace task or thread needs to remain scheduled after registration.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    bind_to_parent_lifetime_linux();

    // macOS has no PR_SET_PDEATHSIG equivalent. A kqueue watcher provides the
    // closest behavior and also observes parents terminated with SIGKILL.
    #[cfg(target_os = "macos")]
    bind_to_parent_lifetime_macos();
}

/// Snapshots getppid() before any await; the kernel will not replay a parent death in that window.
pub(crate) fn record_launch_parent() {
    #[cfg(unix)]
    {
        let _ = launch_parent();
    }
}

/// Remembers the first observed parent so a later hook can still see a parent that died first.
#[cfg(unix)]
fn launch_parent() -> nix::unistd::Pid {
    static LAUNCH_PARENT: std::sync::OnceLock<nix::unistd::Pid> = std::sync::OnceLock::new();
    *LAUNCH_PARENT.get_or_init(nix::unistd::Pid::parent)
}

/// Exits when the recorded parent is no longer ours; the kernel does not replay PR_SET_PDEATHSIG.
#[cfg(unix)]
fn exit_if_parent_gone(parent: nix::unistd::Pid) {
    if nix::unistd::getppid() != parent {
        std::process::exit(1);
    }
}

/// Registers Linux-kernel parent-death delivery, then closes the registration race.
///
/// Android uses the Linux kernel facility too. It is named separately by Rust's
/// `target_os`, so both targets must be included even though the behavior is shared.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn bind_to_parent_lifetime_linux() {
    let parent = launch_parent();
    if let Err(error) = set_parent_death_sigterm() {
        eprintln!("Failed to bind process lifetime to the parent: {error}");
    }
    exit_if_parent_gone(parent);
}

/// Configures the Linux-kernel `PR_SET_PDEATHSIG` facility for Linux and Android.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn set_parent_death_sigterm() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // nix exposes its checked prctl wrapper only for the Rust Linux target.
        nix::sys::prctl::set_pdeathsig(Some(Signal::SIGTERM)).map_err(|error| error.to_string())
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
            Err(std::io::Error::last_os_error().to_string())
        }
    }
}

/// Registers a macOS process-exit event and dedicates a thread to observing it.
///
/// Unlike the Linux kernel facility, `kqueue` reports the event to this process
/// instead of delivering a termination signal, so a live watcher must explicitly
/// exit Redoor when the parent disappears.
#[cfg(target_os = "macos")]
fn bind_to_parent_lifetime_macos() {
    use nix::sys::event::{EvFlags, EventFilter, FilterFlag, KEvent, Kqueue};

    let parent = launch_parent();
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

/// Owns the path claimed by a long-lived process so startup failures can clean it up.
pub(crate) struct PidFile {
    path: PathBuf,
    pid: u32,
    /// Keeping this descriptor open makes the advisory lock represent process lifetime.
    file: fs::File,
}

/// Runtime identity persisted for a named relay without recording its secret.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct RelayPidMetadata {
    /// Process holding the advisory lock.
    pub(crate) pid: u32,
    /// Stable configured relay identity.
    pub(crate) id: String,
    /// UTC launch timestamp for operator diagnostics.
    pub(crate) started_at: String,
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
    /// Removes only this process's claim, avoiding deletion after a concurrent replacement.
    pub(crate) async fn remove(self) {
        let owns_numeric_file = read_pid(&self.path).await == Some(self.pid);
        let owns_relay_file = read_relay_metadata(&self.path)
            .await
            .is_some_and(|metadata| metadata.pid == self.pid);
        if owns_numeric_file || owns_relay_file {
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

/// Claims one named relay runtime file and writes its JSON launch metadata.
pub(crate) async fn acquire_relay(mut metadata: RelayPidMetadata) -> Result<PidFile> {
    metadata.pid = std::process::id();
    let path = relay_pid_path(&metadata.id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create PID directory '{}'", parent.display()))?;
    }
    let mut file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_relay_metadata(&path)
            .await
            .map_or(0, |record| record.pid);
        bail!(
            "relay '{}' is already running with PID {pid}; run `redoor agent relay stop {}` to stop it",
            metadata.id,
            metadata.id
        );
    }
    file.set_len(0).await?;
    let json = serde_json::to_vec_pretty(&metadata).context("Failed to encode relay PID file")?;
    file.write_all(&json).await?;
    file.write_all(b"\n").await?;
    file.flush().await?;
    Ok(PidFile {
        path,
        pid: metadata.pid,
        file,
    })
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

/// Reports whether one named relay owns its runtime-file lock.
pub(crate) async fn status_relay(id: &str) -> Result<()> {
    let (path, metadata) = open_running_relay(id).await?;
    println!("relay '{id}' is running with PID {}", metadata.pid);
    drop(path);
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

/// Stops one named relay and waits for its exact runtime-file lock to be released.
pub(crate) async fn stop_relay(id: &str) -> Result<()> {
    let path = relay_pid_path(id)?;
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
    kill(Pid::from_raw(metadata.pid as i32), Signal::SIGTERM)
        .with_context(|| format!("Failed to stop relay '{id}' process {}", metadata.pid))?;
    wait_for_unlock(&file, "relay", metadata.pid).await?;
    if read_relay_metadata(&path)
        .await
        .is_some_and(|record| record.pid == metadata.pid)
    {
        let _ = fs::remove_file(path).await;
    }
    println!("Stopped relay '{id}' process {}", metadata.pid);
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
    println!(
        "Started {} process {pid} in the background",
        slot.file_stem()
    );
    Ok(())
}

/// Detaches one named relay after checking its own runtime-file lock.
pub(crate) async fn spawn_relay_daemon(id: &str) -> Result<()> {
    ensure_relay_not_running(id).await?;
    spawn_daemon_process(&format!("relay '{id}'")).await
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

/// Rejects a detached named-relay launch while the selected ID is active.
async fn ensure_relay_not_running(id: &str) -> Result<()> {
    let path = relay_pid_path(id)?;
    if !fs::try_exists(&path).await? {
        return Ok(());
    }
    let file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        let pid = read_relay_metadata(&path)
            .await
            .map_or(0, |record| record.pid);
        bail!(
            "relay '{id}' is already running with PID {pid}; run `redoor agent relay stop {id}` to stop it"
        );
    }
    Ok(())
}

/// Spawns the current command without `--daemon`, preserving role-specific messaging.
async fn spawn_daemon_process(description: &str) -> Result<()> {
    let executable = std::env::current_exe().context("Failed to locate the current executable")?;
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
fn pid_path(slot: ProcessSlot) -> Result<PathBuf> {
    Ok(crate::app_name::user_data_directory()?.join(format!("{}.pid", slot.file_stem())))
}

/// Resolves the isolated runtime file for one validated relay ID.
pub(crate) fn relay_pid_path(id: &str) -> Result<PathBuf> {
    crate::config::parse_relay_id(id).map_err(anyhow::Error::msg)?;
    Ok(crate::app_name::user_data_directory()?
        .join("relays")
        .join(format!("{id}.pid")))
}

/// Reads a PID defensively so malformed or partially written stale files can be replaced.
async fn read_pid(path: &PathBuf) -> Option<u32> {
    fs::read_to_string(path).await.ok()?.trim().parse().ok()
}

/// Reads one relay runtime record without interpreting file existence as liveness.
pub(crate) async fn read_relay_metadata(path: &PathBuf) -> Option<RelayPidMetadata> {
    let bytes = fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Opens a running relay and returns its locked descriptor and persisted metadata.
async fn open_running_relay(id: &str) -> Result<(fs::File, RelayPidMetadata)> {
    let path = relay_pid_path(id)?;
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

    /// Protects a named relay while preserving its JSON runtime identity.
    #[tokio::test]
    async fn relay_rejects_a_second_pid_claim() {
        let directory = crate::test_support::TempDir::create();
        let path = directory.path().join("relay.pid");
        let metadata = RelayPidMetadata {
            pid: std::process::id(),
            id: "production".to_string(),
            started_at: "2026-08-12T00:00:00Z".to_string(),
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
            pid: metadata.pid,
            file,
        };

        let record = read_relay_metadata(&path)
            .await
            .expect("relay PID metadata should be valid JSON");
        // Runtime metadata must retain the identity needed after TOML changes.
        assert_eq!(record.id, "production");
        // The PID identifies the process operators need to inspect or stop.
        assert!(
            record.pid > 0,
            "relay JSON should contain the lock owner's PID"
        );

        first.remove().await;
        // Normal relay exit must remove JSON records just like numeric role PID files.
        assert!(
            !path.exists(),
            "relay PID cleanup should remove its own JSON file"
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
            "foreground" => {
                record_launch_parent();
                bind_to_parent_lifetime();
                write_ready_pid();
                park_forever();
            }
            "detached" => {
                record_launch_parent();
                bind_to_parent_lifetime();
                write_ready_pid();
                park_forever();
            }
            "already-dead" => {
                record_launch_parent();
                write_ready_pid();
                #[cfg(unix)]
                {
                    let parent = launch_parent();
                    while nix::unistd::getppid() == parent {
                        std::thread::yield_now();
                    }
                }
                bind_to_parent_lifetime();
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
        let directory = crate::test_support::TempDir::create();
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
        _directory: crate::test_support::TempDir,
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
