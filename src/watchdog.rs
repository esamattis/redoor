//! Lazy per-key watchdog supervisors for managed agent subprocesses.
//!
//! A supervisor is registered at server startup but remains dormant until a
//! control request asks it to start. Once desired-running, it owns spawning,
//! registration tracking, stale-session recovery, bounded restart backoff, and
//! intentional shutdown without coupling the generic lifecycle code to Axum.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Child;
use tokio::sync::{Notify, mpsc, oneshot};

use crate::commands::AgentConnectionStatus;
use crate::log;
use crate::logging::Level;
use crate::types::SocketId;

/// Backoff for the first retry after a quick failure.
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
/// Caps retries so a broken managed host does not spin continuously.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Resets retry escalation after a subprocess has remained useful for a while.
const STABLE_RUNTIME: Duration = Duration::from_secs(30);
/// Surfaces a useful issue when a live child has not registered promptly.
const STARTUP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounds browser-visible subprocess output so repeated failures cannot grow API responses.
const MAX_EXIT_DIAGNOSTIC_BYTES: u64 = 8 * 1024;

/// Spawn strategy kept transport-agnostic so local and SSH-backed agents share lifecycle code.
pub struct SpawnFn {
    inner: Arc<
        dyn Fn() -> futures_util::future::BoxFuture<'static, Result<Child, String>> + Send + Sync,
    >,
    diagnostic_log: Option<PathBuf>,
}

impl SpawnFn {
    /// Boxes a reusable async spawn closure once at the supervisor boundary.
    pub fn new<F, Fut>(f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Child, String>> + Send + 'static,
    {
        Self {
            inner: Arc::new(move || Box::pin(f())),
            diagnostic_log: None,
        }
    }

    /// Records where redirected child output can be read after an unsuccessful exit.
    pub fn with_diagnostic_log(mut self, path: impl Into<PathBuf>) -> Self {
        self.diagnostic_log = Some(path.into());
        self
    }

    /// Starts one transport-specific preparation/spawn attempt.
    fn spawn(&self) -> futures_util::future::BoxFuture<'static, Result<Child, String>> {
        (self.inner)()
    }
}

/// Public lifecycle snapshot shared with inventory and REST projections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogSnapshot {
    /// Separates operator intent from transient connection state.
    pub desired_running: bool,
    /// Gives clients the lifecycle state without exposing process details.
    pub status: AgentConnectionStatus,
    /// Retains the latest actionable spawn, exit, or startup issue.
    pub connection_issue: Option<String>,
    /// Protects replacement connections from stale disconnect events.
    pub socket_id: Option<SocketId>,
}

impl WatchdogSnapshot {
    /// Creates the intentionally dormant state used for every configured agent.
    fn stopped() -> Self {
        Self {
            desired_running: false,
            status: AgentConnectionStatus::Stopped,
            connection_issue: None,
            socket_id: None,
        }
    }
}

/// Callback used by server wiring to project lifecycle changes into the router.
pub type SnapshotCallback = Arc<dyn Fn(WatchdogSnapshot) + Send + Sync>;

/// Commands are independent from the stale signal so shutdown remains selectable everywhere.
enum SupervisorCommand {
    Start,
    Remove,
    Shutdown {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Connected(SocketId),
    Disconnected(SocketId),
}

/// Cloneable control handle for one configured supervisor.
#[derive(Clone)]
pub struct WatchdogHandle {
    key: String,
    commands: mpsc::UnboundedSender<SupervisorCommand>,
    stale_signal: Arc<Notify>,
    snapshot: Arc<Mutex<WatchdogSnapshot>>,
    callback: SnapshotCallback,
}

impl std::fmt::Debug for WatchdogHandle {
    /// Avoids requiring the callback closure to implement `Debug`.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WatchdogHandle")
            .field("key", &self.key)
            .finish()
    }
}

impl WatchdogHandle {
    /// Returns the stable configured name used by sessions and management routes.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Requests desired-running and immediately publishes an optimistic starting state.
    pub fn start(&self) -> Result<(), String> {
        let should_publish = {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            if snapshot.desired_running {
                false
            } else {
                self.commands
                    .send(SupervisorCommand::Start)
                    .map_err(|_| format!("Watchdog supervisor stopped: {}", self.key))?;
                snapshot.desired_running = true;
                snapshot.status = AgentConnectionStatus::Starting;
                snapshot.connection_issue = None;
                snapshot.socket_id = None;
                true
            }
        };
        if should_publish {
            (self.callback)(self.snapshot());
        }
        Ok(())
    }

    /// Waits until startup/backoff is canceled and any owned child is killed and reaped.
    pub async fn shutdown(&self) -> Result<(), String> {
        let (reply, response) = oneshot::channel();
        {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            snapshot.desired_running = false;
            self.commands
                .send(SupervisorCommand::Shutdown { reply })
                .map_err(|_| format!("Watchdog supervisor stopped: {}", self.key))?;
        }
        response
            .await
            .map_err(|_| format!("Watchdog shutdown acknowledgement dropped: {}", self.key))?
    }

    /// Marks a matching managed registration and rejects connections after shutdown intent.
    pub fn mark_connected(&self, socket_id: SocketId) -> bool {
        let snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
        snapshot.desired_running
            && self
                .commands
                .send(SupervisorCommand::Connected(socket_id))
                .is_ok()
    }

    /// Reports socket teardown while letting the supervisor ignore stale generations.
    pub fn mark_disconnected(&self, socket_id: SocketId) {
        let _ = self
            .commands
            .send(SupervisorCommand::Disconnected(socket_id));
    }

    /// Runs a registration commit while shutdown is unable to revoke desired-running.
    pub fn while_desired_running<T>(&self, commit: impl FnOnce() -> T) -> Option<T> {
        let snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
        snapshot.desired_running.then(commit)
    }

    /// Returns a cheap current snapshot without awaiting subprocess work.
    pub fn snapshot(&self) -> WatchdogSnapshot {
        self.snapshot
            .lock()
            .expect("watchdog snapshot poisoned")
            .clone()
    }

    /// Requests restart of a subprocess whose WebSocket stopped responding.
    pub fn signal_stale(&self) {
        self.stale_signal.notify_one();
    }

    /// Publishes one state transition after updating the shared snapshot.
    fn publish(&self, snapshot: WatchdogSnapshot) {
        *self.snapshot.lock().expect("watchdog snapshot poisoned") = snapshot.clone();
        (self.callback)(snapshot);
    }
}

/// Shared lookup from configured effective name to its lifecycle handle.
#[derive(Clone, Default)]
pub struct WatchdogRegistry {
    inner: Arc<Mutex<HashMap<String, WatchdogHandle>>>,
}

impl WatchdogRegistry {
    /// Creates an empty registry before configured entries are validated.
    pub fn new() -> Self {
        Self::default()
    }

    /// Stops every managed child before process replacement so exec cannot orphan agents.
    pub async fn shutdown_all(&self) {
        let handles = self
            .inner
            .lock()
            .expect("watchdog registry poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handle in handles {
            if let Err(error) = handle.shutdown().await {
                log!(
                    Level::Warning,
                    "Failed to shut down watchdog during server teardown: key={}, error={}",
                    handle.key(),
                    error
                );
            }
        }
    }

    /// Returns the managed handle for a configured name, or `None` for external agents.
    pub fn lookup(&self, key: &str) -> Option<WatchdogHandle> {
        self.inner
            .lock()
            .expect("watchdog registry poisoned")
            .get(key)
            .cloned()
    }

    /// Removes a dormant supervisor after callers verify it has no running intent.
    pub fn remove_stopped(&self, key: &str) -> Result<()> {
        let mut map = self.inner.lock().expect("watchdog registry poisoned");
        let handle = map
            .get(key)
            .with_context(|| format!("Watchdog key is not registered: key={key}"))?;
        if handle.snapshot().desired_running {
            bail!("Managed agent must be stopped before its configuration can change");
        }
        handle
            .commands
            .send(SupervisorCommand::Remove)
            .map_err(|_| anyhow::anyhow!("Watchdog supervisor stopped: {key}"))?;
        map.remove(key);
        Ok(())
    }

    /// Registers all control primitives atomically before the supervisor task is spawned.
    fn register(
        &self,
        key: String,
        callback: SnapshotCallback,
    ) -> Result<(WatchdogHandle, mpsc::UnboundedReceiver<SupervisorCommand>)> {
        let mut map = self.inner.lock().expect("watchdog registry poisoned");
        if map.contains_key(&key) {
            bail!("Watchdog key already registered: key={key}");
        }
        let (commands, receiver) = mpsc::unbounded_channel();
        let handle = WatchdogHandle {
            key: key.clone(),
            commands,
            stale_signal: Arc::new(Notify::new()),
            snapshot: Arc::new(Mutex::new(WatchdogSnapshot::stopped())),
            callback,
        };
        map.insert(key, handle.clone());
        Ok((handle, receiver))
    }
}

/// Registers a dormant supervisor and returns its task for test cleanup.
pub fn spawn_supervisor(
    key: String,
    spawn: SpawnFn,
    registry: &WatchdogRegistry,
    callback: SnapshotCallback,
) -> Result<tokio::task::JoinHandle<()>> {
    let (watchdog, commands) = registry.register(key.clone(), callback)?;
    log!(Level::Info, "Watchdog supervisor registered: key={}", key);
    Ok(tokio::spawn(run_supervisor(key, spawn, watchdog, commands)))
}

/// Waits for start commands while acknowledging harmless shutdowns in the dormant state.
async fn wait_until_running(
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
) -> bool {
    while let Some(command) = commands.recv().await {
        match command {
            SupervisorCommand::Start => return true,
            SupervisorCommand::Remove => return false,
            SupervisorCommand::Shutdown { reply } => {
                watchdog.publish(WatchdogSnapshot {
                    desired_running: false,
                    status: AgentConnectionStatus::Stopped,
                    connection_issue: watchdog.snapshot().connection_issue,
                    socket_id: None,
                });
                let _ = reply.send(Ok(()));
            }
            SupervisorCommand::Connected(_) | SupervisorCommand::Disconnected(_) => {}
        }
    }
    false
}

/// Runs desired-running cycles while every long operation remains cancelable by commands.
async fn run_supervisor(
    key: String,
    spawn: SpawnFn,
    watchdog: WatchdogHandle,
    mut commands: mpsc::UnboundedReceiver<SupervisorCommand>,
) {
    while wait_until_running(&watchdog, &mut commands).await {
        let mut backoff = INITIAL_BACKOFF;
        let mut desired_running = true;
        while desired_running {
            watchdog.publish(WatchdogSnapshot {
                desired_running: true,
                status: AgentConnectionStatus::Starting,
                connection_issue: watchdog.snapshot().connection_issue,
                socket_id: None,
            });
            let started = Instant::now();
            let cycle = run_started_cycle(&spawn, &watchdog, &mut commands).await;
            desired_running = cycle.desired_running;
            if !desired_running {
                break;
            }
            if started.elapsed() >= STABLE_RUNTIME && cycle.was_connected {
                backoff = INITIAL_BACKOFF;
            }
            log!(
                Level::Info,
                "Watchdog retry scheduled: key={}, backoff={:?}",
                key,
                backoff
            );
            desired_running = wait_for_restart(&watchdog, &mut commands, backoff).await;
            if desired_running {
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
        watchdog.publish(WatchdogSnapshot {
            desired_running: false,
            status: AgentConnectionStatus::Stopped,
            connection_issue: watchdog.snapshot().connection_issue,
            socket_id: None,
        });
    }
}

/// Captures the information needed to decide whether another cycle should run.
struct CycleResult {
    desired_running: bool,
    was_connected: bool,
}

/// Keeps spawning cancelable so slow SSH preparation never blocks shutdown controls.
async fn run_started_cycle(
    spawn: &SpawnFn,
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
) -> CycleResult {
    let diagnostic_log_offset = diagnostic_log_len(spawn.diagnostic_log.as_deref()).await;
    let spawn_future = spawn.spawn();
    tokio::pin!(spawn_future);
    let child = loop {
        tokio::select! {
            result = &mut spawn_future => break result,
            command = commands.recv() => {
                if handle_pre_spawn_command(watchdog, command).await == CommandAction::Stop {
                    return CycleResult { desired_running: false, was_connected: false };
                }
            }
        }
    };

    match child {
        Ok(child) => {
            wait_for_child(
                child,
                watchdog,
                commands,
                spawn.diagnostic_log.as_deref(),
                diagnostic_log_offset,
            )
            .await
        }
        Err(error) => {
            log!(
                Level::Error,
                "Watchdog spawn failed: key={}, error={}",
                watchdog.key(),
                error
            );
            publish_issue(watchdog, error);
            CycleResult {
                desired_running: true,
                was_connected: false,
            }
        }
    }
}

/// Reduces command handling during preparation to an explicit continue/stop decision.
async fn handle_pre_spawn_command(
    watchdog: &WatchdogHandle,
    command: Option<SupervisorCommand>,
) -> CommandAction {
    match command {
        Some(SupervisorCommand::Shutdown { reply }) => {
            publish_stopped(watchdog);
            let _ = reply.send(Ok(()));
            CommandAction::Stop
        }
        Some(SupervisorCommand::Connected(socket_id)) => {
            publish_connected(watchdog, socket_id);
            CommandAction::Continue
        }
        Some(SupervisorCommand::Start)
        | Some(SupervisorCommand::Remove)
        | Some(SupervisorCommand::Disconnected(_)) => CommandAction::Continue,
        None => CommandAction::Stop,
    }
}

/// Watches child exit, registration timeout, stale signal, and controls concurrently.
async fn wait_for_child(
    mut child: Child,
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
    diagnostic_log: Option<&Path>,
    diagnostic_log_offset: u64,
) -> CycleResult {
    // Tokio closes Child::stdin when wait() is polled. Managed SSH agents retain
    // that pipe so the remote process sees EOF only when this watchdog cycle ends.
    let _retained_stdin = child.stdin.take();
    let startup_timeout = tokio::time::sleep(STARTUP_CONNECTION_TIMEOUT);
    tokio::pin!(startup_timeout);
    let mut connected = false;
    let mut timeout_reported = false;

    loop {
        tokio::select! {
            status = child.wait() => {
                let issue = format_exit_issue(status, diagnostic_log, diagnostic_log_offset).await;
                publish_issue(watchdog, issue);
                return CycleResult { desired_running: true, was_connected: connected };
            }
            _ = watchdog.stale_signal.notified() => {
                kill_and_reap(&mut child).await;
                publish_issue(watchdog, "Agent connection went stale".to_string());
                return CycleResult { desired_running: true, was_connected: connected };
            }
            _ = &mut startup_timeout, if !connected && !timeout_reported => {
                timeout_reported = true;
                publish_issue(watchdog, "Agent process started but has not connected within 15 seconds".to_string());
            }
            command = commands.recv() => {
                match handle_running_command(watchdog, command, &mut child, &mut connected).await {
                    CommandAction::Continue => {}
                    CommandAction::Stop => return CycleResult { desired_running: false, was_connected: connected },
                }
            }
        }
    }
}

/// Applies one command while a child is owned, including guaranteed shutdown reaping.
async fn handle_running_command(
    watchdog: &WatchdogHandle,
    command: Option<SupervisorCommand>,
    child: &mut Child,
    connected: &mut bool,
) -> CommandAction {
    match command {
        Some(SupervisorCommand::Shutdown { reply }) => {
            kill_and_reap(child).await;
            publish_stopped(watchdog);
            let _ = reply.send(Ok(()));
            CommandAction::Stop
        }
        Some(SupervisorCommand::Connected(socket_id)) => {
            *connected = true;
            publish_connected(watchdog, socket_id);
            CommandAction::Continue
        }
        Some(SupervisorCommand::Disconnected(socket_id)) => {
            if watchdog.snapshot().socket_id.as_ref() == Some(&socket_id) {
                *connected = false;
                watchdog.publish(WatchdogSnapshot {
                    desired_running: true,
                    status: AgentConnectionStatus::Starting,
                    connection_issue: watchdog.snapshot().connection_issue,
                    socket_id: None,
                });
            }
            CommandAction::Continue
        }
        Some(SupervisorCommand::Start) | Some(SupervisorCommand::Remove) => CommandAction::Continue,
        None => {
            kill_and_reap(child).await;
            CommandAction::Stop
        }
    }
}

/// Waits through restart backoff while allowing shutdown to win immediately.
async fn wait_for_restart(
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
    backoff: Duration,
) -> bool {
    let delay = tokio::time::sleep(backoff);
    tokio::pin!(delay);
    loop {
        tokio::select! {
            _ = &mut delay => return true,
            command = commands.recv() => {
                match command {
                    Some(SupervisorCommand::Shutdown { reply }) => {
                        publish_stopped(watchdog);
                        let _ = reply.send(Ok(()));
                        return false;
                    }
                    Some(SupervisorCommand::Connected(socket_id)) => publish_connected(watchdog, socket_id),
                    Some(SupervisorCommand::Disconnected(_)) => {},
                    Some(SupervisorCommand::Start) | Some(SupervisorCommand::Remove) => {}
                    None => return false,
                }
            }
        }
    }
}

/// Keeps command branch results compact inside `tokio::select!` call sites.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandAction {
    Continue,
    Stop,
}

/// Settles intentional shutdown before acknowledging the management request.
fn publish_stopped(watchdog: &WatchdogHandle) {
    watchdog.publish(WatchdogSnapshot {
        desired_running: false,
        status: AgentConnectionStatus::Stopped,
        connection_issue: watchdog.snapshot().connection_issue,
        socket_id: None,
    });
}

/// Publishes successful registration and clears stale diagnostic text.
fn publish_connected(watchdog: &WatchdogHandle, socket_id: SocketId) {
    watchdog.publish(WatchdogSnapshot {
        desired_running: true,
        status: AgentConnectionStatus::Connected,
        connection_issue: None,
        socket_id: Some(socket_id),
    });
}

/// Retains a concrete lifecycle issue while the desired-running retry loop continues.
fn publish_issue(watchdog: &WatchdogHandle, issue: String) {
    watchdog.publish(WatchdogSnapshot {
        desired_running: true,
        status: AgentConnectionStatus::Starting,
        connection_issue: Some(issue),
        socket_id: watchdog.snapshot().socket_id,
    });
}

/// Returns the current log length so exit diagnostics only include the latest attempt.
async fn diagnostic_log_len(path: Option<&Path>) -> u64 {
    let Some(path) = path else {
        return 0;
    };
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

/// Adds a bounded tail of redirected output so clients receive the child process's real error.
async fn format_exit_issue(
    status: std::io::Result<std::process::ExitStatus>,
    diagnostic_log: Option<&Path>,
    attempt_offset: u64,
) -> String {
    let mut issue = match status {
        Ok(status) => format!("Agent process exited with status {status}"),
        Err(error) => format!("Failed to wait for agent process: {error}"),
    };
    let Some(path) = diagnostic_log else {
        return issue;
    };

    match read_attempt_log_tail(path, attempt_offset).await {
        Ok(output) if !output.trim().is_empty() => {
            issue.push_str(&format!(
                "\nAgent output from '{}':\n{}",
                path.display(),
                output.trim()
            ));
        }
        Ok(_) => issue.push_str(&format!(
            "\nThe configured agent log '{}' contained no output for this attempt.",
            path.display()
        )),
        Err(error) => issue.push_str(&format!(
            "\nFailed to read configured agent log '{}': {error}",
            path.display()
        )),
    }
    issue
}

/// Reads at most the final diagnostic window written since this process attempt began.
async fn read_attempt_log_tail(path: &Path, attempt_offset: u64) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let end = file.metadata().await?.len();
    let start = attempt_offset.max(end.saturating_sub(MAX_EXIT_DIAGNOSTIC_BYTES));
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut output = Vec::with_capacity((end - start) as usize);
    file.read_to_end(&mut output).await?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

/// Terminates and reaps the owned child so intentional shutdown cannot leave zombies.
async fn kill_and_reap(child: &mut Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    /// Aborts a supervisor on every test exit path while child `kill_on_drop` handles cleanup.
    struct SupervisorGuard(tokio::task::JoinHandle<()>);

    impl Drop for SupervisorGuard {
        /// Prevents a failed assertion from leaking a supervisor into later tests.
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    /// Builds a no-op callback because unit tests inspect the shared snapshot directly.
    fn callback() -> SnapshotCallback {
        Arc::new(|_| {})
    }

    /// Polls a condition cooperatively without adding fixed sleeps to lifecycle tests.
    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("watchdog condition should become observable");
    }

    #[tokio::test]
    async fn supervisor_is_dormant_until_started_and_start_is_idempotent() {
        crate::logging::init(None).await.unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let spawn_count = count.clone();
        let spawn = SpawnFn::new(move || {
            let spawn_count = spawn_count.clone();
            async move {
                spawn_count.fetch_add(1, Ordering::SeqCst);
                Command::new("sh")
                    .arg("-c")
                    .arg("cat")
                    .kill_on_drop(true)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| error.to_string())
            }
        });
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor("lazy".into(), spawn, &registry, callback()).expect("register"),
        );
        let handle = registry.lookup("lazy").expect("managed handle");

        // Registration must not eagerly invoke the process factory.
        assert_eq!(count.load(Ordering::SeqCst), 0);
        // The initial public state makes the dormant agent visible to clients.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);

        handle.start().expect("first start accepted");
        handle.start().expect("duplicate start accepted");
        wait_until(|| count.load(Ordering::SeqCst) == 1).await;
        // Duplicate UI/direct-route requests must not create concurrent children.
        assert_eq!(count.load(Ordering::SeqCst), 1);

        handle.shutdown().await.expect("shutdown acknowledged");
        // Acknowledgement guarantees the supervisor has settled intentionally stopped.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
    }

    #[tokio::test]
    async fn shutdown_revokes_registration_and_interrupts_pending_spawn() {
        crate::logging::init(None).await.unwrap();
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawn = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "pending".into(),
                SpawnFn::new(move || {
                    let observed_spawn = observed_spawn.clone();
                    async move {
                        observed_spawn.fetch_add(1, Ordering::SeqCst);
                        std::future::pending::<Result<Child, String>>().await
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("pending").expect("managed handle");
        handle.start().expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;

        let shutdown_handle = handle.clone();
        let shutdown = tokio::spawn(async move { shutdown_handle.shutdown().await });
        wait_until(|| !handle.snapshot().desired_running).await;
        // Once shutdown intent wins, a socket parsed earlier cannot register late.
        assert!(!handle.mark_connected(SocketId::new()));
        shutdown
            .await
            .expect("shutdown task should complete")
            .expect("pending spawn should be canceled");
        // Acknowledgement proves cancellation settled without waiting for spawn preparation.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
        // Canceling preparation must not accidentally schedule another spawn cycle.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn spawn_errors_are_visible_and_shutdown_interrupts_backoff() {
        crate::logging::init(None).await.unwrap();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "broken".into(),
                SpawnFn::new(|| async { Err("missing executable".to_string()) }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("broken").expect("managed handle");
        handle.start().expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;

        // Spawn failures remain actionable while retry intent stays active.
        assert_eq!(
            handle.snapshot().connection_issue.as_deref(),
            Some("missing executable")
        );
        assert!(handle.snapshot().desired_running);
        handle.shutdown().await.expect("backoff interrupted");
        // Shutdown must win over a pending retry timer.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
    }

    #[tokio::test]
    async fn exit_issue_includes_output_from_the_latest_attempt() {
        let path = std::env::temp_dir().join(format!(
            "redoor-watchdog-exit-diagnostic-{}.log",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&path, "output from an earlier attempt\n")
            .await
            .expect("seed diagnostic log");
        let attempt_offset = tokio::fs::metadata(&path)
            .await
            .expect("diagnostic metadata")
            .len();
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .expect("open diagnostic log");
        file.write_all(b"invalid configured directory: /missing\n")
            .await
            .expect("append current attempt output");
        file.flush().await.expect("flush current attempt output");
        let status = Command::new("sh").arg("-c").arg("exit 1").status().await;

        let issue = format_exit_issue(status, Some(&path), attempt_offset).await;

        // The browser-facing issue must expose the subprocess's actionable error.
        assert!(issue.contains("invalid configured directory: /missing"));
        // Output from an old retry must not be presented as part of the latest failure.
        assert!(!issue.contains("output from an earlier attempt"));
        tokio::fs::remove_file(path)
            .await
            .expect("remove diagnostic log");
    }

    #[tokio::test]
    async fn connection_generation_clears_issue_and_ignores_stale_disconnect() {
        crate::logging::init(None).await.unwrap();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "generation".into(),
                SpawnFn::new(|| async {
                    Command::new("sh")
                        .arg("-c")
                        .arg("cat")
                        .kill_on_drop(true)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|error| error.to_string())
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("generation").expect("managed handle");
        handle.start().expect("start accepted");
        let old_socket = SocketId::new();
        let new_socket = SocketId::new();
        assert!(handle.mark_connected(old_socket.clone()));
        assert!(handle.mark_connected(new_socket.clone()));
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&new_socket)).await;
        handle.mark_disconnected(old_socket);
        tokio::task::yield_now().await;

        // A replacement connection stays authoritative when an old session exits late.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Connected);
        assert_eq!(handle.snapshot().socket_id.as_ref(), Some(&new_socket));
        // Successful registration removes an earlier lifecycle diagnostic.
        assert_eq!(handle.snapshot().connection_issue, None);
        handle.shutdown().await.expect("shutdown acknowledged");
    }
}
