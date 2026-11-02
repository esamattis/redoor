//! `redoor agent managed`: keeps a server-managed agent's daemon running on this device and
//! holds the server's session to it.
//!
//! The server runs this command in every watchdog cycle (over SSH, or as a local child) with
//! the launch payload on stdin, always under the device's own namespace
//! (`--app-name <server app name>-<agent id>`). The ensure step keeps a daemon that runs this
//! very binary with the same settings, so its terminals survive server restarts and dropped
//! SSH sessions, and replaces any other. It then prints one report line and holds the session:
//! the server drops the tunnel by ending the session, and the command ends the session itself
//! when the daemon dies. The daemon is the same binary started with `--serve`.
//!
//! The daemon's PID file lock is the only proof that it is alive: the kernel releases an
//! `flock` when its holder dies, so a recycled PID can never look like a live daemon.

use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::Args;
use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use redoor_core::paths::AppPaths;
use redoor_core::process::{DETACHED_ENV, MANAGED_AGENT_ENV, ProcessSlot};
use redoor_core::runtime::RuntimeContext;
use redoor_protocol::identity::BinaryIdentity;
use redoor_protocol::wire::managed::{
    DaemonReport, EnsureFailure, EnsureOutcome, EnsureReport, HolderEnd, MAX_MANAGED_LAUNCH_BYTES,
    ManagedConnect, ManagedLaunch,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::process_control::{
    PidFile, ProcessPidMetadata, open_pid_file, pid_path, try_lock, write_pid_record,
};

/// How long a daemon may take to stop after `SIGTERM` before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(10);
/// How long a new daemon may take to lock its PID file and get ready.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// How much of the daemon's stderr or log a report carries.
const DIAGNOSTIC_TAIL_BYTES: usize = 4 * 1024;
/// How long to wait for a daemon that holds the lock to finish writing its identity.
const IDENTITY_WAIT: Duration = Duration::from_secs(2);

/// Options of `redoor agent managed`. Without one, the command runs the ensure step and holds
/// the session.
#[derive(Args)]
pub(crate) struct ManagedArgs {
    /// Runs the daemon itself. Only the ensure step starts it this way, with the payload on
    /// stdin and stderr piped back to it until the daemon is ready.
    #[arg(long, hide = true, conflicts_with_all = ["stop", "remove"])]
    serve: bool,
    /// Stops this namespace's daemon if one runs.
    #[arg(long, conflicts_with = "remove")]
    stop: bool,
    /// Stops the daemon and deletes the namespace's data, cache, config and log directories.
    #[arg(long)]
    remove: bool,
    /// Socket of this SSH session's forward. The daemon's stable socket path is pointed at
    /// it, because sshd keeps a forward's socket file after its session ends, so every
    /// session needs a path of its own.
    #[arg(long, hide = true, conflicts_with_all = ["serve", "stop", "remove"])]
    session_socket: Option<PathBuf>,
}

/// Runs the mode `args` selects.
pub(crate) async fn run(args: ManagedArgs, context: &RuntimeContext) -> Result<ExitCode> {
    if args.serve {
        return serve(context).await;
    }
    if args.stop {
        stop(&context.paths).await?;
        return Ok(ExitCode::SUCCESS);
    }
    if args.remove {
        stop(&context.paths).await?;
        remove_namespace(&context.paths).await?;
        return Ok(ExitCode::SUCCESS);
    }
    ensure_and_hold(&context.paths, args.session_socket.as_deref()).await
}

/// Size, place and modification time of the file a process was started from.
///
/// `BinaryIdentity` alone misses rebuilds: the build script only reruns on git changes, so a
/// debug rebuild after editing another crate keeps the identity and build date at the same
/// path. Every cargo build and every `install.sh` rename produces a new file, so comparing
/// the file's identity catches them without hashing hundreds of megabytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ExecutableIdentity {
    /// Device of the file.
    device: u64,
    /// Inode of the file.
    inode: u64,
    /// Size in bytes.
    size: u64,
    /// Modification time, whole seconds.
    modified_seconds: i64,
    /// Modification time, nanoseconds within the second.
    modified_nanos: i64,
}

impl ExecutableIdentity {
    /// Reads the identity of the file at `path`.
    async fn of(path: &Path) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;

        let metadata = tokio::fs::metadata(path)
            .await
            .with_context(|| format!("Failed to inspect '{}'", path.display()))?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.size(),
            modified_seconds: metadata.mtime(),
            modified_nanos: metadata.mtime_nsec(),
        })
    }
}

/// What a managed daemon records in its PID file so the next ensure step can tell whether
/// it may be kept. Flattened over the shared fields, so `redoor agent status` and `stop`
/// work on the namespace too.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ManagedPidMetadata {
    /// PID, start time and build, like every role's PID file.
    #[serde(flatten)]
    process: ProcessPidMetadata,
    /// Path the daemon was executed from.
    install_path: PathBuf,
    /// Identity of that file when the daemon started, before anything could replace it.
    executable: ExecutableIdentity,
    /// Spec hash of the daemon's launch settings.
    spec_hash: String,
}

/// The binary and settings the ensure step expects the daemon to run.
///
/// `agent managed` was just executed from the expected binary, so its own identity is the
/// expected one.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ExpectedDaemon {
    /// This binary's build.
    binary: BinaryIdentity,
    /// Path this binary was executed from.
    install_path: PathBuf,
    /// Identity of that file.
    executable: ExecutableIdentity,
    /// Spec hash of the payload.
    spec_hash: String,
}

impl ExpectedDaemon {
    /// Describes this process and `launch`.
    async fn current(launch: &ManagedLaunch) -> Result<Self> {
        let install_path = redoor_core::executable::current()
            .context("Failed to locate the current executable")?;
        Ok(Self {
            binary: redoor_core::identity::current_binary_identity(),
            executable: ExecutableIdentity::of(&install_path).await?,
            install_path,
            spec_hash: launch.spec_hash(),
        })
    }

    /// Whether a daemon recorded as `running` is exactly this binary with these settings.
    fn matches(&self, running: &ManagedPidMetadata) -> bool {
        running.process.binary.as_ref() == Some(&self.binary)
            && running.install_path == self.install_path
            && running.executable == self.executable
            && running.spec_hash == self.spec_hash
    }
}

/// A daemon that holds the namespace's lock.
#[derive(Clone, Debug)]
struct RunningDaemon {
    /// Process holding the lock.
    pid: u32,
    /// Its identity, absent when the record is not a managed daemon's (it is then replaced).
    managed: Option<ManagedPidMetadata>,
}

/// What the ensure step does with the daemon it found.
#[derive(Debug, PartialEq, Eq)]
enum Decision {
    /// Nothing runs; start a daemon.
    Start,
    /// The running daemon matches; keep it and its shells.
    Keep,
    /// The running daemon differs or a replacement was asked for; stop it and start another.
    Restart,
}

/// Decides between keeping, replacing and starting a daemon.
fn decide(running: Option<&RunningDaemon>, expected: &ExpectedDaemon, replace: bool) -> Decision {
    let Some(running) = running else {
        return Decision::Start;
    };
    let matches = running
        .managed
        .as_ref()
        .is_some_and(|managed| expected.matches(managed));
    if matches && !replace {
        Decision::Keep
    } else {
        Decision::Restart
    }
}

/// Reads the daemon holding the lock at `path`, if any.
///
/// The PID is only trusted while the lock is held: a free lock means no daemon, whatever the
/// file says.
async fn inspect(path: &PathBuf) -> Result<Option<RunningDaemon>> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(None);
    }
    let file = open_pid_file(path).await?;
    if try_lock(&file)? {
        return Ok(None);
    }
    drop(file);
    // A daemon writes its identity right after taking the lock, so an empty or partial
    // record is retried for a moment before giving up.
    let deadline = tokio::time::Instant::now() + IDENTITY_WAIT;
    loop {
        let content = tokio::fs::read_to_string(path).await.unwrap_or_default();
        if let Ok(managed) = serde_json::from_str::<ManagedPidMetadata>(&content) {
            return Ok(Some(RunningDaemon {
                pid: managed.process.pid,
                managed: Some(managed),
            }));
        }
        if let Some(process) = ProcessPidMetadata::parse(&content) {
            return Ok(Some(RunningDaemon {
                pid: process.pid,
                managed: None,
            }));
        }
        if tokio::time::Instant::now() >= deadline {
            bail!(
                "The managed agent's PID file '{}' is locked but holds no readable record",
                path.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Resolves once the lock at `path` can be taken, which means its holder is gone.
///
/// The wait is a blocking `flock` on a dedicated thread: it cannot be cancelled, but it always
/// returns, because the kernel releases the lock when its holder dies, even after `SIGKILL`.
/// The thread closes its descriptor before reporting, so the lock is free again afterwards.
fn wait_for_lock_release(path: &Path) -> Result<tokio::sync::oneshot::Receiver<()>> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .with_context(|| format!("Failed to open PID file '{}'", path.display()))?;
    let (released, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("redoor-lock-wait".to_string())
        .spawn(move || {
            // SAFETY: `file` owns a valid descriptor for the duration of each call.
            while let Err(Errno::EINTR) =
                Errno::result(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) })
            {}
            drop(file);
            let _ = released.send(());
        })
        .context("Failed to start the lock wait thread")?;
    Ok(receiver)
}

/// Stops the daemon `pid` that holds the lock at `path` and waits until it is gone.
async fn stop_daemon(path: &Path, pid: u32) -> Result<()> {
    let mut released = wait_for_lock_release(path)?;
    let pid = Pid::from_raw(pid as i32);
    match kill(pid, Signal::SIGTERM) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => return Err(error).context("Failed to stop the managed agent daemon"),
    }
    if tokio::time::timeout(STOP_GRACE, &mut released)
        .await
        .is_ok()
    {
        return Ok(());
    }
    match kill(pid, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => return Err(error).context("Failed to kill the managed agent daemon"),
    }
    let _ = released.await;
    Ok(())
}

/// Reads the single payload line, bounded by [`MAX_MANAGED_LAUNCH_BYTES`].
async fn read_launch(reader: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> Result<ManagedLaunch> {
    let mut line = Vec::new();
    let limit = MAX_MANAGED_LAUNCH_BYTES as u64 + 1;
    (&mut *reader)
        .take(limit)
        .read_until(b'\n', &mut line)
        .await
        .context("Failed to read the launch payload from stdin")?;
    if line.last() != Some(&b'\n') {
        if line.len() as u64 >= limit {
            bail!("The launch payload is larger than {MAX_MANAGED_LAUNCH_BYTES} bytes");
        }
        bail!("stdin ended before the launch payload");
    }
    line.pop();
    Ok(ManagedLaunch::parse(&line)?)
}

/// Prints one JSON line on stdout and flushes it, so the server sees it at once.
fn print_line(value: &impl Serialize) {
    use std::io::Write;

    let mut stdout = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, value);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

/// The ensure step followed by holding the session.
async fn ensure_and_hold(paths: &AppPaths, session_socket: Option<&Path>) -> Result<ExitCode> {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let launch = read_launch(&mut stdin).await?;
    if let (Some(session_socket), ManagedConnect::Unix(stable)) = (session_socket, &launch.connect)
    {
        point_stable_socket(Path::new(stable), session_socket).await;
    }
    let report = match ensure(&launch, paths).await {
        Ok(report) => EnsureReport::Ready(report),
        Err(failure) => EnsureReport::Failed(failure),
    };
    print_line(&report);
    if matches!(report, EnsureReport::Failed(_)) {
        return Ok(ExitCode::FAILURE);
    }
    hold(stdin, paths).await
}

/// Points the daemon's stable socket path at this session's socket and removes the sockets
/// of earlier sessions, which sshd left behind.
///
/// The symlink is replaced with a rename, so a daemon connecting meanwhile finds either the
/// old or the new target, never nothing. Failures are reported on stderr and otherwise
/// ignored: the daemon then keeps retrying and the next session tries again.
async fn point_stable_socket(stable: &Path, session: &Path) {
    let temporary = stable.with_extension(format!("{}.tmp", std::process::id()));
    let _ = tokio::fs::remove_file(&temporary).await;
    let pointed = async {
        tokio::fs::symlink(session, &temporary).await?;
        tokio::fs::rename(&temporary, stable).await
    }
    .await;
    if let Err(error) = pointed {
        eprintln!(
            "Failed to point {} at {}: {error}",
            stable.display(),
            session.display()
        );
        let _ = tokio::fs::remove_file(&temporary).await;
        return;
    }
    let (Some(directory), Some(stem), Some(current)) = (
        stable.parent(),
        stable.file_stem().and_then(|stem| stem.to_str()),
        session.file_name(),
    ) else {
        return;
    };
    let prefix = format!("{stem}-");
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(text) = name.to_str() else {
            continue;
        };
        if name != current && text.starts_with(&prefix) && text.ends_with(".sock") {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

/// Makes sure the expected daemon runs and describes it.
async fn ensure(launch: &ManagedLaunch, paths: &AppPaths) -> Result<DaemonReport, EnsureFailure> {
    let failure = |error: anyhow::Error| EnsureFailure {
        message: format!("{error:#}"),
        stderr_tail: String::new(),
    };
    let expected = ExpectedDaemon::current(launch).await.map_err(failure)?;
    let path = pid_path(ProcessSlot::Agent, paths).map_err(failure)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create '{}'", parent.display()))
            .map_err(failure)?;
    }
    let running = inspect(&path).await.map_err(failure)?;
    let outcome = match decide(running.as_ref(), &expected, launch.replace) {
        Decision::Keep => {
            let pid = running.as_ref().map_or(0, |daemon| daemon.pid);
            if !launch.server_connected {
                // The new tunnel is up now; without the signal the daemon could wait out
                // the rest of its backoff before reconnecting.
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGUSR1);
            }
            EnsureOutcome::Kept
        }
        Decision::Start => {
            start_daemon(launch, paths).await?;
            EnsureOutcome::Started
        }
        Decision::Restart => {
            let pid = running.as_ref().map_or(0, |daemon| daemon.pid);
            stop_daemon(&path, pid).await.map_err(failure)?;
            start_daemon(launch, paths).await?;
            EnsureOutcome::Restarted
        }
    };
    // The report describes the daemon that holds the lock now, as it recorded itself.
    let Some(RunningDaemon {
        pid,
        managed: Some(managed),
    }) = inspect(&path).await.map_err(failure)?
    else {
        return Err(EnsureFailure {
            message: "The managed agent daemon exited right after it started".to_string(),
            stderr_tail: log_tail(paths).await,
        });
    };
    Ok(DaemonReport {
        outcome,
        pid,
        binary: managed
            .process
            .binary
            .unwrap_or_else(redoor_core::identity::current_binary_identity),
        spec_hash: managed.spec_hash,
    })
}

/// How a new daemon is detached from the session that starts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Detach {
    /// A new session (`setsid`), so it survives the SSH session and hangups.
    Session,
    /// A transient systemd scope of the given manager, so it also leaves the server's cgroup
    /// and survives `systemctl restart` of the server.
    SystemdScope {
        /// The user manager instead of the system manager.
        user: bool,
    },
}

/// The ways to try for a daemon of `launch`, best first.
///
/// Only a local daemon of a server running as a systemd service needs a scope; everything
/// else, and a scope that cannot be created, falls back to a new session.
fn detach_modes(launch: &ManagedLaunch) -> Vec<Detach> {
    let scope = match &launch.connect {
        ManagedConnect::Tcp(_) => systemd_service_manager(),
        ManagedConnect::Unix(_) => None,
    };
    match scope {
        Some(user) => vec![Detach::SystemdScope { user }, Detach::Session],
        None => vec![Detach::Session],
    }
}

/// Whether this process runs inside a systemd service, and whether that is a user service.
///
/// Read from the cgroup rather than `INVOCATION_ID`, which every descendant of a service
/// inherits, including terminals started from a desktop's own service.
fn systemd_service_manager() -> Option<bool> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let cgroups = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    service_manager_of_cgroup(&cgroups)
}

/// Parses `/proc/self/cgroup`: a unified hierarchy path ending in a `.service` is a service,
/// and one below `user@<uid>.service` belongs to the user manager.
fn service_manager_of_cgroup(cgroups: &str) -> Option<bool> {
    let path = cgroups
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?
        .trim();
    let unit = path.rsplit('/').next()?;
    unit.ends_with(".service").then(|| path.contains("/user@"))
}

/// Starts a daemon for `launch` and waits until it holds the lock and is ready.
async fn start_daemon(launch: &ManagedLaunch, paths: &AppPaths) -> Result<(), EnsureFailure> {
    let modes = detach_modes(launch);
    let mut last_failure = None;
    for mode in modes {
        match start_daemon_with(launch, paths, mode).await {
            Ok(()) => return Ok(()),
            Err(failure) => {
                eprintln!(
                    "Starting the managed agent daemon ({mode:?}) failed: {}",
                    failure.message
                );
                last_failure = Some(failure);
            }
        }
    }
    Err(last_failure.unwrap_or_else(|| EnsureFailure {
        message: "No way to start the managed agent daemon".to_string(),
        stderr_tail: String::new(),
    }))
}

/// Starts a daemon detached with `mode` and waits for it.
///
/// The payload goes over the daemon's stdin, which is closed after writing. Its stderr stays
/// piped here until it holds the lock and wrote its identity; it then points stderr at its
/// log, so end of file means ready, and an early exit leaves its error in what was read.
async fn start_daemon_with(
    launch: &ManagedLaunch,
    paths: &AppPaths,
    mode: Detach,
) -> Result<(), EnsureFailure> {
    let failure = |message: String| EnsureFailure {
        message,
        stderr_tail: String::new(),
    };
    let executable = redoor_core::executable::current()
        .map_err(|error| failure(format!("Failed to locate the current executable: {error}")))?;
    let mut command = match mode {
        Detach::Session => tokio::process::Command::new(&executable),
        Detach::SystemdScope { user } => {
            let mut command = tokio::process::Command::new("systemd-run");
            command.arg("--scope");
            if user {
                command.arg("--user");
            }
            // A unique unit name, so a scope kept alive by a shell the user started from a
            // terminal cannot block the next daemon. `KillMode=process` keeps such shells
            // when the daemon is replaced, which happens by PID and never by stopping the
            // scope.
            command
                .arg("--quiet")
                .arg("--collect")
                .arg(format!(
                    "--unit={}-{:08x}",
                    paths.app_name(),
                    fastrand::u32(..)
                ))
                .arg("--property=KillMode=process")
                .arg(&executable);
            command
        }
    };
    command
        .arg("--app-name")
        .arg(paths.app_name())
        .arg("agent")
        .arg("managed")
        .arg("--serve")
        .env(DETACHED_ENV, "1")
        .env(MANAGED_AGENT_ENV, "1")
        .env_remove(redoor_core::process::AGENT_TOKEN_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: this closure runs after fork and before exec, so it calls only `setsid` and
    // converts its errno without touching locks or shared runtime state.
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setsid()
                .map(|_| ())
                .map_err(std::io::Error::from)
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| failure(format!("Failed to start the managed agent daemon: {error}")))?;
    let mut stdin = child.stdin.take().expect("daemon stdin is piped");
    let stderr = child.stderr.take().expect("daemon stderr is piped");
    let write = stdin.write_all(launch.to_line().as_bytes()).await;
    drop(stdin);
    let ready = tokio::time::timeout(
        READY_TIMEOUT,
        redoor_core::bounded_tail::read_bounded_tail(stderr, DIAGNOSTIC_TAIL_BYTES),
    )
    .await;
    let stderr_tail = match ready {
        Ok(output) => String::from_utf8_lossy(&output.unwrap_or_default()).into_owned(),
        Err(_) => {
            let _ = child.start_kill();
            return Err(failure(format!(
                "The managed agent daemon did not get ready within {} seconds",
                READY_TIMEOUT.as_secs()
            )));
        }
    };
    let exited = child
        .try_wait()
        .map_err(|error| failure(format!("Failed to check the managed agent daemon: {error}")))?;
    if let Some(status) = exited {
        return Err(EnsureFailure {
            message: format!("The managed agent daemon exited during startup with {status}"),
            stderr_tail,
        });
    }
    if let Err(error) = write {
        return Err(EnsureFailure {
            message: format!("Failed to send the launch payload to the daemon: {error}"),
            stderr_tail,
        });
    }
    // The daemon is not waited for: it outlives this session, and Tokio reaps it if it
    // exits while this process still runs.
    drop(child);
    Ok(())
}

/// Holds the session until stdin ends or the daemon releases its lock, then prints the end
/// line and exits.
///
/// Exits with `std::process::exit`, so the lock wait thread, which cannot be cancelled, does
/// not keep the process alive the way a normal runtime shutdown would.
async fn hold(mut stdin: BufReader<tokio::io::Stdin>, paths: &AppPaths) -> Result<ExitCode> {
    let path = pid_path(ProcessSlot::Agent, paths)?;
    let released = wait_for_lock_release(&path)?;
    tokio::select! {
        () = drain(&mut stdin) => {
            print_line(&HolderEnd::StdinEof);
            std::process::exit(0);
        }
        _ = released => {
            print_line(&HolderEnd::DaemonExited {
                log_tail: log_tail(paths).await,
            });
            std::process::exit(1);
        }
    }
}

/// Reads and discards `reader` until it ends or fails.
async fn drain(reader: &mut (impl AsyncRead + Unpin)) {
    let mut buffer = [0_u8; 1024];
    while matches!(reader.read(&mut buffer).await, Ok(read) if read > 0) {}
}

/// The end of the namespace's daemon log, which usually says why the daemon stopped.
async fn log_tail(paths: &AppPaths) -> String {
    let Ok(path) = paths.process_log_path(ProcessSlot::Agent) else {
        return String::new();
    };
    let Ok(file) = tokio::fs::File::open(&path).await else {
        return String::new();
    };
    let tail = redoor_core::bounded_tail::read_bounded_tail(file, DIAGNOSTIC_TAIL_BYTES)
        .await
        .unwrap_or_default();
    String::from_utf8_lossy(&tail).into_owned()
}

/// Runs the daemon: reads the payload, takes the namespace's lock, records its identity,
/// prepares the agent and only then points stderr at its log, which tells the ensure step
/// that it is ready.
async fn serve(context: &RuntimeContext) -> Result<ExitCode> {
    let paths = &context.paths;
    let launch = read_launch(&mut BufReader::new(tokio::io::stdin())).await?;
    // Taken now, before anything can replace the file this process was started from.
    let expected = ExpectedDaemon::current(&launch).await?;
    let path = pid_path(ProcessSlot::Agent, paths)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Failed to create '{}'", parent.display()))?;
    }
    let mut file = open_pid_file(&path).await?;
    if !try_lock(&file)? {
        bail!("Another daemon of this managed agent is already running");
    }
    let metadata = ManagedPidMetadata {
        process: ProcessPidMetadata::current(),
        install_path: expected.install_path,
        executable: expected.executable,
        spec_hash: expected.spec_hash,
    };
    write_pid_record(&mut file, &metadata).await?;
    // Held until return; dropping it removes the record on every path.
    let _pid_file = PidFile::claimed(path, metadata.process.pid, file);
    let daemon = redoor_agent::ManagedDaemon::prepare(launch, context).await?;
    detach_stdio(&paths.process_log_path(ProcessSlot::Agent)?)?;
    install_panic_logging();
    let code = daemon.run().await;
    // The last lines say why the daemon exits; the next ensure step shows them.
    redoor_core::logging::flush(Duration::from_secs(2)).await;
    Ok(code)
}

/// Points stdin at `/dev/null` and stderr at the daemon's log.
///
/// The daemon must keep nothing of the session that started it: closing the stderr pipe is
/// its readiness signal, and later panics or messages from libraries land in the log.
fn detach_stdio(log_path: &str) -> Result<()> {
    let null = std::fs::File::open("/dev/null").context("Failed to open /dev/null")?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .with_context(|| format!("Failed to open the daemon log '{log_path}'"))?;
    for (source, target) in [(null.as_raw_fd(), 0), (log.as_raw_fd(), 2)] {
        // SAFETY: both descriptors are open for the duration of the call, and replacing the
        // standard descriptors is what this function is for.
        Errno::result(unsafe { libc::dup2(source, target) })
            .context("Failed to redirect the daemon's standard streams")?;
    }
    Ok(())
}

/// Prefixes panic messages with a timestamp; stderr is the log by then, so a crashed daemon
/// leaves its reason where the next ensure step reads it.
fn install_panic_logging() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        eprintln!(
            "{} Managed agent daemon panicked: {info}",
            jiff::Timestamp::now()
        );
        default(info);
    }));
}

/// Stops the namespace's daemon if one runs.
async fn stop(paths: &AppPaths) -> Result<()> {
    let path = pid_path(ProcessSlot::Agent, paths)?;
    match inspect(&path).await? {
        None => println!("The managed agent daemon is not running"),
        Some(running) => {
            stop_daemon(&path, running.pid).await?;
            println!("Stopped the managed agent daemon {}", running.pid);
        }
    }
    Ok(())
}

/// Deletes every directory of the namespace after its daemon stopped, so a deleted device
/// leaves nothing behind. Binaries live under the server's own namespace and stay.
async fn remove_namespace(paths: &AppPaths) -> Result<()> {
    let mut directories = vec![paths.data_dir()?, paths.cache_dir()?, paths.log_dir()?];
    if let Some(config) = paths.default_config_path()?.parent() {
        directories.push(config.to_path_buf());
    }
    directories.dedup();
    for directory in directories {
        if tokio::fs::symlink_metadata(&directory).await.is_err() {
            continue;
        }
        redoor_core::safe_fs::safe_rm_all(&directory)
            .await
            .with_context(|| format!("Failed to remove '{}'", directory.display()))?;
        println!("Removed {}", directory.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binary identity that differs from the test binary's.
    fn other_binary() -> BinaryIdentity {
        BinaryIdentity {
            git_rev: "0000000".to_string(),
            ..redoor_core::identity::current_binary_identity()
        }
    }

    /// The daemon the tests expect.
    fn expected() -> ExpectedDaemon {
        ExpectedDaemon {
            binary: redoor_core::identity::current_binary_identity(),
            install_path: PathBuf::from("/opt/redoor/redoor"),
            executable: ExecutableIdentity {
                device: 1,
                inode: 2,
                size: 3,
                modified_seconds: 4,
                modified_nanos: 5,
            },
            spec_hash: "spec".to_string(),
        }
    }

    /// A running daemon recorded as `expected()`.
    fn running() -> RunningDaemon {
        let expected = expected();
        RunningDaemon {
            pid: 42,
            managed: Some(ManagedPidMetadata {
                process: ProcessPidMetadata {
                    pid: 42,
                    started_at: None,
                    binary: Some(expected.binary),
                },
                install_path: expected.install_path,
                executable: expected.executable,
                spec_hash: expected.spec_hash,
            }),
        }
    }

    /// Changes one field of the running daemon's record.
    fn running_with(change: impl FnOnce(&mut ManagedPidMetadata)) -> RunningDaemon {
        let mut daemon = running();
        change(daemon.managed.as_mut().unwrap());
        daemon
    }

    /// Only an exact match is kept; anything else is replaced, and no daemon means a start.
    #[test]
    fn decision_keeps_only_an_exact_match() {
        // Without a daemon there is nothing to keep or stop.
        assert_eq!(decide(None, &expected(), false), Decision::Start);
        assert_eq!(decide(None, &expected(), true), Decision::Start);
        // The same binary file and settings keep the daemon and its shells.
        assert_eq!(decide(Some(&running()), &expected(), false), Decision::Keep);
        // A Restart replaces even a matching daemon.
        assert_eq!(
            decide(Some(&running()), &expected(), true),
            Decision::Restart
        );
        type Change = Box<dyn FnOnce(&mut ManagedPidMetadata)>;
        let changes: [(&str, Change); 5] = [
            (
                "build",
                Box::new(|record| record.process.binary = Some(other_binary())),
            ),
            (
                "unknown build",
                Box::new(|record| record.process.binary = None),
            ),
            (
                "install path",
                Box::new(|record| record.install_path = PathBuf::from("/other/redoor")),
            ),
            (
                "rebuilt file",
                Box::new(|record| record.executable.inode = 99),
            ),
            (
                "settings",
                Box::new(|record| record.spec_hash = "other".to_string()),
            ),
        ];
        for (what, change) in changes {
            // Every difference must replace the daemon, or it would keep running stale code
            // or settings.
            assert_eq!(
                decide(Some(&running_with(change)), &expected(), false),
                Decision::Restart,
                "a different {what} must restart the daemon"
            );
        }
        let foreign = RunningDaemon {
            pid: 7,
            managed: None,
        };
        // A lock holder that is not a managed daemon is replaced as well.
        assert_eq!(
            decide(Some(&foreign), &expected(), false),
            Decision::Restart
        );
    }

    /// The PID file descriptor must not leak into shells: a shell that inherited it would
    /// keep the lock after the daemon died, which would look like a live daemon forever.
    #[tokio::test]
    async fn pid_file_descriptor_is_close_on_exec() {
        let directory = redoor_core::test_support::TempDir::create();
        let file = open_pid_file(&directory.path().join("agent.pid"))
            .await
            .unwrap();
        // SAFETY: the descriptor is valid while `file` lives.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0, "F_GETFD failed");
        assert_ne!(flags & libc::FD_CLOEXEC, 0, "the lock fd must be O_CLOEXEC");
    }

    /// The payload is read up to its newline; a line that never ends within the limit is
    /// refused instead of being buffered without bound.
    #[tokio::test]
    async fn payload_line_is_bounded() {
        let launch = ManagedLaunch {
            token: "t".to_string(),
            agent_id: redoor_protocol::ids::AgentId::generate(),
            name: "n".to_string(),
            server_url: "ws://localhost:1/api/v1/agent/ws".to_string(),
            insecure_tls: false,
            home: None,
            connect: ManagedConnect::Tcp("localhost:1".to_string()),
            orphan_timeout: 60,
            replace: false,
            server_connected: false,
        };
        let input = format!("{}trailing input stays unread", launch.to_line());
        let mut reader = BufReader::new(input.as_bytes());
        // The payload line parses and the rest of stdin stays for the session.
        assert_eq!(read_launch(&mut reader).await.unwrap(), launch);
        let mut rest = String::new();
        reader.read_to_string(&mut rest).await.unwrap();
        assert_eq!(rest, "trailing input stays unread");

        let endless = vec![b'x'; MAX_MANAGED_LAUNCH_BYTES * 2];
        let error = read_launch(&mut BufReader::new(endless.as_slice()))
            .await
            .unwrap_err();
        // An endless line fails with the size limit, not after reading everything.
        assert!(error.to_string().contains("larger than"), "{error}");
        let error = read_launch(&mut BufReader::new(&b"{}"[..]))
            .await
            .unwrap_err();
        // A session that ends early says so.
        assert!(error.to_string().contains("ended before"), "{error}");
    }

    /// The scope is only used inside a service, and the manager follows the service's.
    #[test]
    fn systemd_manager_is_read_from_the_cgroup() {
        // A user service's daemon goes into a user scope.
        assert_eq!(
            service_manager_of_cgroup(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/redoor.service\n"
            ),
            Some(true)
        );
        // A system service's daemon goes into a system scope.
        assert_eq!(
            service_manager_of_cgroup("0::/system.slice/redoor.service\n"),
            Some(false)
        );
        // A server started from a terminal (a session scope) needs no scope of its own.
        assert_eq!(
            service_manager_of_cgroup(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-term.scope\n"
            ),
            None
        );
        // Without a unified hierarchy there is nothing to tell.
        assert_eq!(service_manager_of_cgroup("1:name=systemd:/\n"), None);
    }

    /// The stable socket follows the newest session, and earlier sessions' sockets are
    /// removed while unrelated files stay.
    #[tokio::test]
    async fn stable_socket_points_at_the_newest_session() {
        let directory = redoor_core::test_support::TempDir::create();
        let stable = directory.path().join("ns.sock");
        let first = directory.path().join("ns-00000001.sock");
        let second = directory.path().join("ns-00000002.sock");
        let other = directory.path().join("other-00000001.sock");
        for path in [&first, &other] {
            std::fs::write(path, b"").unwrap();
        }

        point_stable_socket(&stable, &first).await;
        // The next session's sshd creates its socket before the session runs.
        std::fs::write(&second, b"").unwrap();
        point_stable_socket(&stable, &second).await;

        // The daemon's fixed path reaches the current session's forward.
        assert_eq!(std::fs::read_link(&stable).unwrap(), second);
        // The previous session's leftover socket is gone ...
        assert!(!first.exists());
        // ... while another namespace's socket is not touched.
        assert!(other.exists());
        assert!(second.exists());
    }

    /// A stopped daemon's lock is released, so a waiter sees it at once, and the waiter
    /// gives the lock back so the next daemon can take it.
    #[tokio::test]
    async fn lock_release_wait_returns_and_frees_the_lock() {
        let directory = redoor_core::test_support::TempDir::create();
        let path = directory.path().join("agent.pid");
        let holder = open_pid_file(&path).await.unwrap();
        assert!(try_lock(&holder).unwrap());
        let mut released = wait_for_lock_release(&path).unwrap();
        // While the holder lives, the waiter must not report a release.
        assert!(released.try_recv().is_err());
        drop(holder);
        released.await.unwrap();
        let next = open_pid_file(&path).await.unwrap();
        // The waiter closed its descriptor, so the lock is free for the next daemon.
        assert!(try_lock(&next).unwrap());
    }
}
