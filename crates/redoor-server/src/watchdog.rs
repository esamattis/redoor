//! Lazy per-key watchdog supervisors for managed agent subprocesses.
//!
//! A supervisor is registered at server startup but remains dormant until a
//! control request asks it to start. Once desired-running, it owns spawning,
//! registration tracking, stale-session recovery, bounded restart backoff, and
//! intentional shutdown without coupling the generic lifecycle code to Axum.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use redoor_core::log;
use redoor_core::rotating_log::{LogFileSpec, RotatingLogFile};
use redoor_protocol::api::agents::{AgentConnectionStatus, ProvisioningStatusMessage};
use redoor_protocol::ids::{SocketId, UnixTimestampMillis};
use redoor_protocol::wire::log::Level;

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
/// Supervisor mailbox size; senders wait (rather than grow memory) while a child is reaped.
const SUPERVISOR_COMMAND_CAPACITY: usize = 16;
/// Longest a lifecycle request waits for a mailbox slot. HTTP handlers call the watchdog
/// while holding the configuration lock, so a wedged supervisor must surface as a busy error
/// instead of stalling every lifecycle and configuration route behind that lock.
const COMMAND_RESERVE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an exited child's stderr may stay open before its diagnostic is given up. A
/// `ProxyCommand` grandchild can inherit the pipe and keep it open long after the child
/// died, and the supervisor must not stop processing commands while it waits.
const CHILD_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(2);

/// Why one spawn attempt produced no child.
///
/// Typed instead of a string so logs keep the failure class while the browser only sees
/// the transport's own actionable text via [`SpawnError::user_message`].
#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    /// Preparing the target (SSH probe, binary install) failed before any child existed.
    #[error("Preparing the agent failed: {0}")]
    Provision(#[source] crate::ssh::ProvisionError),
    /// The child process itself could not be started.
    #[error("Starting the agent process failed: {0}")]
    Spawn(#[source] std::io::Error),
}

impl SpawnError {
    /// Text for the lifecycle UI: the underlying reason without the internal classification.
    pub fn user_message(&self) -> String {
        match self {
            Self::Provision(error) => error.to_string(),
            Self::Spawn(error) => error.to_string(),
        }
    }

    /// Whether another attempt could succeed without the user doing something first.
    fn is_retryable(&self) -> bool {
        match self {
            Self::Provision(error) => error.is_retryable(),
            Self::Spawn(_) => true,
        }
    }
}

/// Lifecycle control failures, mapped to HTTP statuses by the REST layer.
#[derive(Debug, thiserror::Error)]
pub enum WatchdogError {
    /// The supervisor task is gone (removed or crashed), so it cannot act on the request.
    #[error("Watchdog supervisor stopped: {key}")]
    SupervisorStopped {
        /// Supervisor key (effective agent name).
        key: String,
    },
    /// The supervisor ended before acknowledging a shutdown or retry it had accepted.
    #[error("Watchdog {operation} acknowledgement dropped: {key}")]
    AcknowledgementDropped {
        /// `shutdown` or `retry`.
        operation: &'static str,
        /// Supervisor key (effective agent name).
        key: String,
    },
    /// Another supervisor already owns this name.
    #[error("Watchdog key already registered: key={key}")]
    AlreadyRegistered {
        /// Supervisor key (effective agent name).
        key: String,
    },
    /// The supervisor did not accept the request in time (it is busy reaping or wedged).
    #[error("Watchdog supervisor is busy: {key}")]
    Busy {
        /// Supervisor key (effective agent name).
        key: String,
    },
    /// Configuration may only change while the managed agent is stopped.
    #[error("Managed agent must be stopped before its configuration can change")]
    StillRunning,
}

/// Result of one spawn attempt.
type SpawnResult = Result<Child, SpawnError>;

/// Non-blocking sink so long SSH prepare/spawn work can publish inventory lines immediately.
#[derive(Clone)]
pub struct ProvisioningStatusSink {
    report: Arc<dyn Fn(String) + Send + Sync>,
}

impl ProvisioningStatusSink {
    /// Ignores reports so CLI relay and silent local spawn stay off the inventory path.
    pub fn noop() -> Self {
        Self {
            report: Arc::new(|_| {}),
        }
    }

    /// Appends one small status line without awaiting REST or file I/O.
    pub fn report(&self, message: impl Into<String>) {
        (self.report)(message.into());
    }
}

/// Spawn strategy kept transport-agnostic so local and SSH-backed agents share lifecycle code.
pub struct SpawnFn {
    inner: Arc<
        dyn Fn(ProvisioningStatusSink) -> futures_util::future::BoxFuture<'static, SpawnResult>
            + Send
            + Sync,
    >,
    /// Size-bounded file the child's piped stdout and stderr are forwarded into.
    log_file: Option<LogFileSpec>,
    process_name: &'static str,
}

impl SpawnFn {
    /// Boxes a reusable async spawn closure once at the supervisor boundary.
    pub fn new<F, Fut>(f: F) -> Self
    where
        F: Fn(ProvisioningStatusSink) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = SpawnResult> + Send + 'static,
    {
        Self {
            inner: Arc::new(move |status| Box::pin(f(status))),
            log_file: None,
            process_name: "Agent process",
        }
    }

    /// Forwards the child's piped stdout and stderr into `log_file`; the spawn closure must
    /// pipe both streams. The forwarded tail also explains an unsuccessful exit.
    pub fn with_log_file(mut self, log_file: LogFileSpec) -> Self {
        self.log_file = Some(log_file);
        self
    }

    /// Opens the configured log before spawning, so an unwritable log fails the attempt
    /// instead of leaving a child blocked on an undrained pipe.
    async fn open_log_file(&self) -> std::io::Result<Option<RotatingLogFile>> {
        match &self.log_file {
            Some(spec) => spec.open().await.map(Some),
            None => Ok(None),
        }
    }

    /// Names the owned child accurately in browser-visible lifecycle failures.
    pub fn with_process_name(mut self, process_name: &'static str) -> Self {
        self.process_name = process_name;
        self
    }

    /// Starts one transport-specific preparation/spawn attempt with a progress sink.
    fn spawn(
        &self,
        status: ProvisioningStatusSink,
    ) -> futures_util::future::BoxFuture<'static, SpawnResult> {
        (self.inner)(status)
    }
}

/// Public lifecycle snapshot shared with inventory and REST projections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogSnapshot {
    /// Invalidates work and registrations that belong to a canceled startup attempt.
    pub attempt_generation: u64,
    /// Separates operator intent from transient connection state.
    pub desired_running: bool,
    /// Gives clients the lifecycle state without exposing process details.
    pub status: AgentConnectionStatus,
    /// Retains the latest actionable spawn, exit, or startup issue.
    pub connection_issue: Option<String>,
    /// Accumulated SSH prepare/spawn lines for the current start cycle.
    pub provisioning_status: Vec<ProvisioningStatusMessage>,
    /// Protects replacement connections from stale disconnect events.
    pub socket_id: Option<SocketId>,
}

impl WatchdogSnapshot {
    /// Creates the intentionally dormant state used for every configured agent.
    fn stopped() -> Self {
        Self {
            attempt_generation: 0,
            desired_running: false,
            status: AgentConnectionStatus::Stopped,
            connection_issue: None,
            provisioning_status: Vec::new(),
            socket_id: None,
        }
    }
}

/// Callback used by server wiring to project lifecycle changes into the router.
pub type SnapshotCallback = Arc<dyn Fn(WatchdogSnapshot) + Send + Sync>;

/// Events serialize lifecycle changes so socket generations are checked by the supervisor.
enum SupervisorCommand {
    Start,
    Retry {
        reply: oneshot::Sender<()>,
    },
    Remove,
    Shutdown {
        reply: oneshot::Sender<()>,
    },
    Connected {
        socket_id: SocketId,
        attempt_generation: u64,
    },
    Disconnected(SocketId),
    Stale(SocketId),
}

/// Cloneable control handle for one configured supervisor.
#[derive(Clone)]
pub struct WatchdogHandle {
    key: String,
    commands: mpsc::Sender<SupervisorCommand>,
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

    /// Reserves one mailbox slot, waiting while the supervisor is busy reaping a child.
    ///
    /// Reserving before taking the snapshot lock lets the generation bump and the send
    /// happen atomically under that (synchronous) lock.
    /// The wait is bounded by `COMMAND_RESERVE_TIMEOUT` so callers holding locks recover.
    async fn reserve(&self) -> Result<mpsc::Permit<'_, SupervisorCommand>, WatchdogError> {
        match tokio::time::timeout(COMMAND_RESERVE_TIMEOUT, self.commands.reserve()).await {
            Ok(Ok(permit)) => Ok(permit),
            Ok(Err(_)) => Err(WatchdogError::SupervisorStopped {
                key: self.key.clone(),
            }),
            Err(_) => Err(WatchdogError::Busy {
                key: self.key.clone(),
            }),
        }
    }

    /// Delivers a socket event without making the caller wait for the supervisor.
    ///
    /// Socket teardown and stale detection run on websocket session tasks; blocking them on a
    /// busy supervisor would delay the router unregister of that session. When the mailbox is
    /// full the event is handed to a task that waits for capacity, so it is still delivered
    /// (the supervisor ignores events of sockets that are no longer current).
    fn notify(&self, command: SupervisorCommand) {
        match self.commands.try_send(command) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
            Err(mpsc::error::TrySendError::Full(command)) => {
                let commands = self.commands.clone();
                tokio::spawn(async move {
                    let _ = commands.send(command).await;
                });
            }
        }
    }

    /// Requests desired-running and immediately publishes an optimistic starting state.
    pub async fn start(&self) -> Result<(), WatchdogError> {
        let permit = self.reserve().await?;
        let should_publish = {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            if snapshot.desired_running {
                false
            } else {
                snapshot.attempt_generation = snapshot.attempt_generation.wrapping_add(1);
                permit.send(SupervisorCommand::Start);
                snapshot.desired_running = true;
                snapshot.status = AgentConnectionStatus::Starting;
                snapshot.connection_issue = None;
                snapshot.provisioning_status.clear();
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
    pub async fn shutdown(&self) -> Result<(), WatchdogError> {
        let (reply, response) = oneshot::channel();
        let permit = self.reserve().await?;
        {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            snapshot.desired_running = false;
            snapshot.attempt_generation = snapshot.attempt_generation.wrapping_add(1);
            permit.send(SupervisorCommand::Shutdown { reply });
        }
        response
            .await
            .map_err(|_| WatchdogError::AcknowledgementDropped {
                operation: "shutdown",
                key: self.key.clone(),
            })
    }

    /// Fences registrations from the old attempt until its work is canceled and a fresh cycle starts.
    pub async fn retry_startup(&self) -> Result<(), WatchdogError> {
        let (reply, response) = oneshot::channel();
        let permit = self.reserve().await?;
        {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            // Registration commits share this lock, so work from the canceled attempt
            // cannot become authoritative while the supervisor is cleaning it up.
            snapshot.desired_running = false;
            snapshot.attempt_generation = snapshot.attempt_generation.wrapping_add(1);
            permit.send(SupervisorCommand::Retry { reply });
        }
        response
            .await
            .map_err(|_| WatchdogError::AcknowledgementDropped {
                operation: "retry",
                key: self.key.clone(),
            })
    }

    /// Marks a matching managed registration and rejects connections after shutdown intent.
    pub async fn mark_connected(&self, socket_id: SocketId) -> Option<u64> {
        let permit = self.reserve().await.ok()?;
        let snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
        if !snapshot.desired_running {
            return None;
        }
        let attempt_generation = snapshot.attempt_generation;
        permit.send(SupervisorCommand::Connected {
            socket_id,
            attempt_generation,
        });
        Some(attempt_generation)
    }

    /// Reports socket teardown while letting the supervisor ignore stale generations.
    pub fn mark_disconnected(&self, socket_id: SocketId) {
        self.notify(SupervisorCommand::Disconnected(socket_id));
    }

    /// Runs a registration commit while shutdown is unable to revoke desired-running.
    pub fn while_current_attempt<T>(
        &self,
        attempt_generation: u64,
        commit: impl FnOnce() -> T,
    ) -> Option<T> {
        let snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
        (snapshot.desired_running && snapshot.attempt_generation == attempt_generation).then(commit)
    }

    /// Returns a cheap current snapshot without awaiting subprocess work.
    pub fn snapshot(&self) -> WatchdogSnapshot {
        self.snapshot
            .lock()
            .expect("watchdog snapshot poisoned")
            .clone()
    }

    /// Requests restart only if the stale WebSocket is still the current generation.
    pub fn signal_stale(&self, socket_id: SocketId) {
        self.notify(SupervisorCommand::Stale(socket_id));
    }

    /// Mutates the live snapshot under one lock so progress reports cannot drop sibling fields.
    fn publish_update(&self, update: impl FnOnce(&mut WatchdogSnapshot)) {
        let snapshot = {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            update(&mut snapshot);
            snapshot.clone()
        };
        (self.callback)(snapshot);
    }

    /// Appends one timestamped line and notifies inventory without blocking SSH work.
    fn report_provisioning_status(&self, attempt_generation: u64, message: String) {
        let at = UnixTimestampMillis::now();
        self.publish_attempt_update(attempt_generation, |snapshot| {
            snapshot
                .provisioning_status
                .push(ProvisioningStatusMessage { message, at });
        });
    }

    /// Builds a cloneable sink the spawn closure can hold across await points.
    pub fn provisioning_status_sink(&self, attempt_generation: u64) -> ProvisioningStatusSink {
        let handle = self.clone();
        ProvisioningStatusSink {
            report: Arc::new(move |message| {
                handle.report_provisioning_status(attempt_generation, message)
            }),
        }
    }

    /// Publishes attempt-owned state only while that startup attempt remains authoritative.
    fn publish_attempt_update(
        &self,
        attempt_generation: u64,
        update: impl FnOnce(&mut WatchdogSnapshot),
    ) -> bool {
        let snapshot = {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            if snapshot.attempt_generation != attempt_generation {
                return false;
            }
            update(&mut snapshot);
            snapshot.clone()
        };
        (self.callback)(snapshot);
        true
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
    ///
    /// The map entry is removed under the registry lock; the `Remove` command is sent
    /// afterwards (deferred to a task when the mailbox is full) because waiting for mailbox
    /// space must neither hold a std mutex nor stall the configuration route calling this.
    pub fn remove_stopped(&self, key: &str) -> Result<(), WatchdogError> {
        let handle = {
            let mut map = self.inner.lock().expect("watchdog registry poisoned");
            let Some(handle) = map.get(key) else {
                // A retry after a persist-then-remove failure must complete remaining cleanup.
                return Ok(());
            };
            if handle.snapshot().desired_running {
                return Err(WatchdogError::StillRunning);
            }
            map.remove(key)
        };
        if let Some(handle) = handle {
            handle.notify(SupervisorCommand::Remove);
        }
        Ok(())
    }

    /// Registers all control primitives atomically before the supervisor task is spawned.
    fn register(
        &self,
        key: String,
        callback: SnapshotCallback,
    ) -> Result<(WatchdogHandle, mpsc::Receiver<SupervisorCommand>), WatchdogError> {
        let mut map = self.inner.lock().expect("watchdog registry poisoned");
        if map.contains_key(&key) {
            return Err(WatchdogError::AlreadyRegistered { key });
        }
        let (commands, receiver) = mpsc::channel(SUPERVISOR_COMMAND_CAPACITY);
        let handle = WatchdogHandle {
            key: key.clone(),
            commands,
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
) -> Result<tokio::task::JoinHandle<()>, WatchdogError> {
    let (watchdog, commands) = registry.register(key.clone(), callback)?;
    log!(Level::Info, "Watchdog supervisor registered: key={}", key);
    Ok(tokio::spawn(run_supervisor(key, spawn, watchdog, commands)))
}

/// Why the idle wait ended: start a cycle or drop the supervisor task.
enum IdleWait {
    /// A start command arrived while the supervisor was intentionally dormant.
    Start,
    /// Remove or channel close must drop the task so a replacement can reuse the key.
    Exit,
}

/// Waits for start commands while acknowledging harmless shutdowns in the dormant state.
async fn wait_until_running(
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
) -> IdleWait {
    while let Some(command) = commands.recv().await {
        match command {
            SupervisorCommand::Start => return IdleWait::Start,
            SupervisorCommand::Retry { reply } => {
                publish_fresh_start(watchdog);
                let _ = reply.send(());
                return IdleWait::Start;
            }
            SupervisorCommand::Remove => return IdleWait::Exit,
            SupervisorCommand::Shutdown { reply } => {
                publish_stopped(watchdog);
                let _ = reply.send(());
            }
            SupervisorCommand::Connected { .. }
            | SupervisorCommand::Disconnected(_)
            | SupervisorCommand::Stale(_) => {}
        }
    }
    IdleWait::Exit
}

/// Runs desired-running cycles while every long operation remains cancelable by commands.
async fn run_supervisor(
    key: String,
    spawn: SpawnFn,
    watchdog: WatchdogHandle,
    mut commands: mpsc::Receiver<SupervisorCommand>,
) {
    'idle: loop {
        match wait_until_running(&watchdog, &mut commands).await {
            IdleWait::Exit => break,
            IdleWait::Start => {}
        }
        let mut backoff = INITIAL_BACKOFF;
        loop {
            // Shutdown changes intent before queue processing so a stale Start command
            // cannot revive preparation while its shutdown acknowledgement is pending.
            if !watchdog.snapshot().desired_running {
                break;
            }
            watchdog.publish_update(|snapshot| {
                snapshot.desired_running = true;
                snapshot.status = AgentConnectionStatus::Starting;
                snapshot.socket_id = None;
                snapshot.provisioning_status.clear();
            });
            let started = Instant::now();
            let attempt_generation = watchdog.snapshot().attempt_generation;
            let cycle =
                run_started_cycle(&spawn, &watchdog, &mut commands, attempt_generation).await;
            match cycle.action {
                CommandAction::Exit => {
                    publish_stopped(&watchdog);
                    return;
                }
                CommandAction::Stop => break,
                // Already published as stopped for exactly this attempt; publishing again
                // could overwrite a Start that arrived meanwhile.
                CommandAction::Halt => continue 'idle,
                CommandAction::Restart => {
                    backoff = INITIAL_BACKOFF;
                    continue;
                }
                CommandAction::Continue => {
                    if started.elapsed() >= STABLE_RUNTIME && cycle.was_connected {
                        backoff = INITIAL_BACKOFF;
                    }
                    log!(
                        Level::Info,
                        "Watchdog retry scheduled: key={}, backoff={:?}",
                        key,
                        backoff
                    );
                    match wait_for_restart(&watchdog, &mut commands, backoff).await {
                        CommandAction::Continue => {
                            backoff = (backoff * 2).min(MAX_BACKOFF);
                        }
                        CommandAction::Stop => break,
                        CommandAction::Halt => continue 'idle,
                        CommandAction::Restart => {
                            backoff = INITIAL_BACKOFF;
                            continue;
                        }
                        CommandAction::Exit => {
                            publish_stopped(&watchdog);
                            return;
                        }
                    }
                }
            }
        }
        publish_stopped(&watchdog);
    }
}

/// Captures the information needed to decide whether another cycle should run.
struct CycleResult {
    action: CommandAction,
    was_connected: bool,
}

/// Keeps spawning cancelable so slow SSH preparation never blocks shutdown controls.
async fn run_started_cycle(
    spawn: &SpawnFn,
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
    attempt_generation: u64,
) -> CycleResult {
    let log_file = match spawn.open_log_file().await {
        Ok(log_file) => log_file,
        Err(error) => {
            return report_spawn_failure(watchdog, attempt_generation, SpawnError::Spawn(error));
        }
    };
    let spawn_future = spawn.spawn(watchdog.provisioning_status_sink(attempt_generation));
    tokio::pin!(spawn_future);
    let child = loop {
        tokio::select! {
            result = &mut spawn_future => break result,
            command = commands.recv() => {
                match handle_pre_spawn_command(watchdog, command) {
                    CommandAction::Continue => {}
                    action => return CycleResult { action, was_connected: false },
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
                log_file,
                spawn.process_name,
                attempt_generation,
            )
            .await
        }
        Err(error) => report_spawn_failure(watchdog, attempt_generation, error),
    }
}

/// Publishes why an attempt produced no child; the supervisor retries after backoff, unless
/// retrying cannot help (a locked SSH key), which stops the agent with the issue shown.
fn report_spawn_failure(
    watchdog: &WatchdogHandle,
    attempt_generation: u64,
    error: SpawnError,
) -> CycleResult {
    let issue = error.user_message();
    let retryable = error.is_retryable();
    redoor_core::log_error!(
        anyhow::Error::new(error),
        "Watchdog spawn failed: key={}, retryable={}",
        watchdog.key(),
        retryable
    );
    if !retryable {
        // Only this attempt is stopped. A shutdown or retry that changed the generation
        // meanwhile has its command queued; the ordinary retry path below then handles it.
        let stopped = watchdog.publish_attempt_update(attempt_generation, |snapshot| {
            snapshot.desired_running = false;
            snapshot.status = AgentConnectionStatus::Stopped;
            snapshot.socket_id = None;
            snapshot.connection_issue = Some(issue.clone());
        });
        if stopped {
            return CycleResult {
                action: CommandAction::Halt,
                was_connected: false,
            };
        }
    }
    publish_issue(watchdog, attempt_generation, issue);
    CycleResult {
        action: CommandAction::Continue,
        was_connected: false,
    }
}

/// Reduces command handling during preparation to an explicit continue/stop decision.
fn handle_pre_spawn_command(
    watchdog: &WatchdogHandle,
    command: Option<SupervisorCommand>,
) -> CommandAction {
    match command {
        Some(SupervisorCommand::Shutdown { reply }) => {
            publish_stopped(watchdog);
            let _ = reply.send(());
            CommandAction::Stop
        }
        Some(SupervisorCommand::Retry { reply }) => {
            publish_fresh_start(watchdog);
            let _ = reply.send(());
            CommandAction::Restart
        }
        Some(SupervisorCommand::Connected {
            socket_id,
            attempt_generation: connected_generation,
        }) => {
            publish_connected(watchdog, connected_generation, socket_id);
            CommandAction::Continue
        }
        Some(SupervisorCommand::Remove) => {
            publish_stopped(watchdog);
            CommandAction::Exit
        }
        Some(SupervisorCommand::Start)
        | Some(SupervisorCommand::Disconnected(_))
        | Some(SupervisorCommand::Stale(_)) => CommandAction::Continue,
        None => CommandAction::Exit,
    }
}

/// Watches child exit, registration timeout, and serialized lifecycle controls concurrently.
async fn wait_for_child(
    mut child: Child,
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
    log_file: Option<RotatingLogFile>,
    process_name: &str,
    attempt_generation: u64,
) -> CycleResult {
    // Tokio closes Child::stdin when wait() is polled. Managed SSH agents retain
    // that pipe so the remote process sees EOF only when this watchdog cycle ends.
    let _retained_stdin = child.stdin.take();
    let log_path = log_file
        .as_ref()
        .map(|log_file| log_file.path().to_path_buf());
    let output_reader = spawn_output_reader(&mut child, log_file);
    let startup_timeout = tokio::time::sleep(STARTUP_CONNECTION_TIMEOUT);
    tokio::pin!(startup_timeout);
    let mut connected = false;
    let mut timeout_reported = false;

    loop {
        tokio::select! {
            status = child.wait() => {
                let output = read_child_diagnostic(output_reader, CHILD_DIAGNOSTIC_TIMEOUT).await;
                let issue = format_exit_issue(
                    status,
                    log_path.as_deref(),
                    process_name,
                    output.as_deref(),
                );
                publish_issue(watchdog, attempt_generation, issue);
                return CycleResult { action: CommandAction::Continue, was_connected: connected };
            }
            _ = &mut startup_timeout, if !connected && !timeout_reported => {
                timeout_reported = true;
                publish_issue(watchdog, attempt_generation, "Agent process started but has not connected within 15 seconds".to_string());
            }
            command = commands.recv() => {
                match handle_running_command(watchdog, command, &mut child, &mut connected, attempt_generation).await {
                    RunningCommandAction::Continue => {}
                    RunningCommandAction::Finish(action) => {
                        return CycleResult { action, was_connected: connected };
                    }
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
    attempt_generation: u64,
) -> RunningCommandAction {
    match command {
        Some(SupervisorCommand::Shutdown { reply }) => {
            kill_and_reap(child).await;
            publish_stopped(watchdog);
            let _ = reply.send(());
            RunningCommandAction::Finish(CommandAction::Stop)
        }
        Some(SupervisorCommand::Retry { reply }) => {
            kill_and_reap(child).await;
            publish_fresh_start(watchdog);
            let _ = reply.send(());
            RunningCommandAction::Finish(CommandAction::Restart)
        }
        Some(SupervisorCommand::Connected {
            socket_id,
            attempt_generation: connected_generation,
        }) => {
            if publish_connected(watchdog, connected_generation, socket_id) {
                *connected = true;
            }
            RunningCommandAction::Continue
        }
        Some(SupervisorCommand::Disconnected(socket_id)) => {
            if watchdog.snapshot().socket_id.as_ref() == Some(&socket_id) {
                *connected = false;
                watchdog.publish_update(|snapshot| {
                    snapshot.desired_running = true;
                    snapshot.status = AgentConnectionStatus::Starting;
                    snapshot.socket_id = None;
                });
            }
            RunningCommandAction::Continue
        }
        Some(SupervisorCommand::Stale(socket_id)) => {
            if watchdog.snapshot().socket_id.as_ref() == Some(&socket_id) {
                kill_and_reap(child).await;
                publish_issue(
                    watchdog,
                    attempt_generation,
                    "Agent connection went stale".to_string(),
                );
                RunningCommandAction::Finish(CommandAction::Continue)
            } else {
                RunningCommandAction::Continue
            }
        }
        Some(SupervisorCommand::Remove) => {
            kill_and_reap(child).await;
            publish_stopped(watchdog);
            RunningCommandAction::Finish(CommandAction::Exit)
        }
        Some(SupervisorCommand::Start) => RunningCommandAction::Continue,
        None => {
            kill_and_reap(child).await;
            RunningCommandAction::Finish(CommandAction::Exit)
        }
    }
}

/// Waits through restart backoff while allowing shutdown to win immediately.
async fn wait_for_restart(
    watchdog: &WatchdogHandle,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
    backoff: Duration,
) -> CommandAction {
    let delay = tokio::time::sleep(backoff);
    tokio::pin!(delay);
    loop {
        tokio::select! {
            _ = &mut delay => return CommandAction::Continue,
            command = commands.recv() => {
                match apply_restart_command(watchdog, command) {
                    CommandAction::Continue => {}
                    action => return action,
                }
            }
        }
    }
}

/// Applies one idle-backoff command without growing the `tokio::select!` arm.
fn apply_restart_command(
    watchdog: &WatchdogHandle,
    command: Option<SupervisorCommand>,
) -> CommandAction {
    match command {
        Some(SupervisorCommand::Shutdown { reply }) => {
            publish_stopped(watchdog);
            let _ = reply.send(());
            CommandAction::Stop
        }
        Some(SupervisorCommand::Retry { reply }) => {
            publish_fresh_start(watchdog);
            let _ = reply.send(());
            CommandAction::Restart
        }
        Some(SupervisorCommand::Remove) => {
            publish_stopped(watchdog);
            CommandAction::Exit
        }
        Some(SupervisorCommand::Connected {
            socket_id,
            attempt_generation,
        }) => {
            publish_connected(watchdog, attempt_generation, socket_id);
            CommandAction::Continue
        }
        Some(SupervisorCommand::Disconnected(_))
        | Some(SupervisorCommand::Stale(_))
        | Some(SupervisorCommand::Start) => CommandAction::Continue,
        None => CommandAction::Exit,
    }
}

/// Keeps command branch results compact inside `tokio::select!` call sites.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandAction {
    Continue,
    /// An explicit operator retry skips automatic backoff and begins a clean attempt.
    Restart,
    Stop,
    /// The attempt failed in a way retrying cannot fix and was already published as
    /// stopped; the supervisor goes idle without publishing again.
    Halt,
    /// Configuration replacement must end the task, not just return it to idle.
    Exit,
}

/// Separates commands that keep watching a child from those that finish its cycle.
enum RunningCommandAction {
    /// The current child remains authoritative and should keep running.
    Continue,
    /// The child cycle ended and the supervisor should apply this lifecycle action.
    Finish(CommandAction),
}

/// Settles intentional shutdown before acknowledging the management request.
fn publish_stopped(watchdog: &WatchdogHandle) {
    watchdog.publish_update(|snapshot| {
        snapshot.desired_running = false;
        snapshot.status = AgentConnectionStatus::Stopped;
        snapshot.socket_id = None;
    });
}

/// Clears all attempt-owned state only after the old attempt can no longer publish progress.
fn publish_fresh_start(watchdog: &WatchdogHandle) {
    watchdog.publish_update(|snapshot| {
        snapshot.desired_running = true;
        snapshot.status = AgentConnectionStatus::Starting;
        snapshot.connection_issue = None;
        snapshot.provisioning_status.clear();
        snapshot.socket_id = None;
    });
}

/// Publishes successful registration and clears stale diagnostic text.
fn publish_connected(
    watchdog: &WatchdogHandle,
    attempt_generation: u64,
    socket_id: SocketId,
) -> bool {
    watchdog.publish_attempt_update(attempt_generation, |snapshot| {
        // Only the first connect of this attempt should append; replacements
        // must not grow the sticky list with duplicate Connected lines.
        if snapshot.status != AgentConnectionStatus::Connected {
            snapshot
                .provisioning_status
                .push(ProvisioningStatusMessage {
                    message: "Connected".into(),
                    at: UnixTimestampMillis::now(),
                });
        }
        snapshot.desired_running = true;
        snapshot.status = AgentConnectionStatus::Connected;
        snapshot.connection_issue = None;
        snapshot.socket_id = Some(socket_id);
    })
}

/// Retains a concrete lifecycle issue while the desired-running retry loop continues.
fn publish_issue(watchdog: &WatchdogHandle, attempt_generation: u64, issue: String) {
    watchdog.publish_attempt_update(attempt_generation, |snapshot| {
        snapshot.desired_running = true;
        snapshot.status = AgentConnectionStatus::Starting;
        snapshot.connection_issue = Some(issue);
    });
}

/// Starts draining the child's output so its diagnostic tail is available after exit.
///
/// With a log file both pipes are forwarded into it; otherwise only a piped stderr is
/// read, because unpiped streams already reach the server's terminal.
fn spawn_output_reader(
    child: &mut Child,
    log_file: Option<RotatingLogFile>,
) -> Option<tokio::task::JoinHandle<std::io::Result<Vec<u8>>>> {
    let tail_limit = MAX_EXIT_DIAGNOSTIC_BYTES as usize;
    match log_file {
        Some(log_file) => {
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            Some(tokio::spawn(async move {
                Ok(log_file
                    .forward_child_output(stdout, stderr, tail_limit)
                    .await)
            }))
        }
        None => child.stderr.take().map(|stderr| {
            tokio::spawn(redoor_core::bounded_tail::read_bounded_tail(
                stderr, tail_limit,
            ))
        }),
    }
}

/// Adds a bounded tail of the child's output so clients receive its real error.
fn format_exit_issue(
    status: std::io::Result<std::process::ExitStatus>,
    log_path: Option<&Path>,
    process_name: &str,
    captured_output: Option<&[u8]>,
) -> String {
    let mut issue = match status {
        Ok(status) => match status.code() {
            Some(code) => format!("{process_name} exited with status code {code}"),
            None => format!("{process_name} exited with {status}"),
        },
        Err(error) => format!("Failed to wait for {process_name}: {error}"),
    };
    let Some(output) = captured_output else {
        return issue;
    };
    let output = sanitize_diagnostic_output(output);
    let output = output.trim();
    match log_path {
        Some(path) if output.is_empty() => issue.push_str(&format!(
            "\nThe configured agent log '{}' contained no output for this attempt.",
            path.display()
        )),
        Some(path) => issue.push_str(&format!(
            "\nAgent output from '{}':\n{output}",
            path.display()
        )),
        None if output.is_empty() => {}
        None => issue.push_str(&format!("\n{process_name} output:\n{output}")),
    }
    issue
}

/// Resolves a completed stderr reader without replacing the process status on read failure.
///
/// The read waits for EOF, which a surviving grandchild holding the pipe can postpone
/// indefinitely, so it is bounded by `timeout`. The reader is left running rather than
/// aborted: it keeps forwarding the grandchild's output into the configured log and
/// keeps the pipe drained so that process never blocks on a full pipe.
async fn read_child_diagnostic(
    reader: Option<tokio::task::JoinHandle<std::io::Result<Vec<u8>>>>,
    timeout: Duration,
) -> Option<Vec<u8>> {
    let mut reader = reader?;
    match tokio::time::timeout(timeout, &mut reader).await {
        Ok(Ok(Ok(output))) => Some(output),
        Ok(Ok(Err(error))) => Some(format!("Failed to read process output: {error}").into_bytes()),
        Ok(Err(error)) => Some(format!("Process output task failed: {error}").into_bytes()),
        Err(_) => {
            log!(
                Level::Warning,
                "Process output stayed open after exit; skipping its diagnostic"
            );
            None
        }
    }
}

/// Removes terminal controls and direction markers before output reaches browser clients.
fn sanitize_diagnostic_output(output: &[u8]) -> String {
    String::from_utf8_lossy(output)
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            )
        })
        .map(|character| {
            if character == '\n' || character == '\t' || !character.is_control() {
                character
            } else {
                ' '
            }
        })
        .collect()
}

/// Terminates and reaps the owned child so intentional shutdown cannot leave zombies.
async fn kill_and_reap(child: &mut Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
    async fn remove_stopped_is_idempotent_and_exits_a_dormant_supervisor() {
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "removed".into(),
                SpawnFn::new(|_status| async {
                    Command::new("sh")
                        .arg("-c")
                        .arg("cat")
                        .kill_on_drop(true)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(SpawnError::Spawn)
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );

        // The first removal must drop the handle so replacement can register the same key.
        registry.remove_stopped("removed").expect("first remove");
        assert!(registry.lookup("removed").is_none());
        // A retry after a partial persist-then-remove must not fail just because the handle is gone.
        registry.remove_stopped("removed").expect("retry remove");
    }

    #[tokio::test]
    async fn supervisor_is_dormant_until_started_and_start_is_idempotent() {
        let count = Arc::new(AtomicUsize::new(0));
        let spawn_count = count.clone();
        let spawn = SpawnFn::new(move |_status| {
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
                    .map_err(SpawnError::Spawn)
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

        handle.start().await.expect("first start accepted");
        handle.start().await.expect("duplicate start accepted");
        wait_until(|| count.load(Ordering::SeqCst) == 1).await;
        // Duplicate UI/direct-route requests must not create concurrent children.
        assert_eq!(count.load(Ordering::SeqCst), 1);

        handle.shutdown().await.expect("shutdown acknowledged");
        // Acknowledgement guarantees the supervisor has settled intentionally stopped.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
    }

    #[tokio::test]
    async fn shutdown_revokes_registration_and_interrupts_pending_spawn() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawn = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "pending".into(),
                SpawnFn::new(move |_status| {
                    let observed_spawn = observed_spawn.clone();
                    async move {
                        observed_spawn.fetch_add(1, Ordering::SeqCst);
                        std::future::pending::<SpawnResult>().await
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("pending").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;

        let shutdown_handle = handle.clone();
        let shutdown = tokio::spawn(async move { shutdown_handle.shutdown().await });
        wait_until(|| !handle.snapshot().desired_running).await;
        // Once shutdown intent wins, a socket parsed earlier cannot register late.
        assert!(handle.mark_connected(SocketId::new()).await.is_none());
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
    async fn retry_fences_pending_attempt_and_starts_with_clean_state() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "retry-pending".into(),
                SpawnFn::new(move |status| {
                    let observed_spawns = observed_spawns.clone();
                    async move {
                        let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst) + 1;
                        status.report(format!("attempt-{attempt}"));
                        std::future::pending::<SpawnResult>().await
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("retry-pending").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;
        publish_issue(
            &handle,
            handle.snapshot().attempt_generation,
            "old diagnostic".into(),
        );

        let late_socket = SocketId::new();
        // Queueing registration first models a connection that completed as cancellation began.
        let canceled_generation = handle
            .mark_connected(late_socket)
            .await
            .expect("old attempt should initially admit registration");
        handle
            .retry_startup()
            .await
            .expect("retry should be acknowledged");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 2).await;

        let snapshot = handle.snapshot();
        // A router commit parsed before retry must remain fenced after desired-running returns.
        assert!(
            handle
                .while_current_attempt(canceled_generation, || ())
                .is_none()
        );
        // The clean retry boundary supersedes registration from the canceled attempt.
        assert_eq!(snapshot.socket_id, None);
        // A retry presents only the replacement attempt's progress and diagnostics.
        assert_eq!(snapshot.connection_issue, None);
        assert_eq!(
            snapshot
                .provisioning_status
                .iter()
                .map(|line| line.message.as_str())
                .collect::<Vec<_>>(),
            ["attempt-2"]
        );
        assert_eq!(snapshot.status, AgentConnectionStatus::Starting);
        handle.shutdown().await.expect("shutdown acknowledged");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retry_reaps_owned_child_before_acknowledging_replacement() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let first_pid = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let observed_pid = first_pid.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "retry-child".into(),
                SpawnFn::new(move |_status| {
                    let observed_spawns = observed_spawns.clone();
                    let observed_pid = observed_pid.clone();
                    async move {
                        let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst);
                        let child = Command::new("sh")
                            .arg("-c")
                            .arg("cat")
                            .kill_on_drop(true)
                            .stdin(Stdio::piped())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                            .map_err(SpawnError::Spawn)?;
                        if attempt == 0 {
                            observed_pid.store(child.id().unwrap_or(0) as usize, Ordering::SeqCst);
                        }
                        Ok(child)
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("retry-child").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| first_pid.load(Ordering::SeqCst) > 0).await;
        let pid = first_pid.load(Ordering::SeqCst);

        handle.retry_startup().await.expect("retry acknowledged");
        let status = Command::new("sh")
            .arg("-c")
            .arg(format!("kill -0 {pid}"))
            .status()
            .await
            .expect("probe old child");
        // Retry acknowledgement is a cleanup barrier, so the original child cannot remain alive.
        assert!(!status.success());
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 2).await;
        // Exactly one replacement proves retry did not change ordinary duplicate-start behavior.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 2);
        handle.shutdown().await.expect("shutdown acknowledged");
    }

    #[tokio::test]
    async fn spawn_errors_are_visible_and_shutdown_interrupts_backoff() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "broken".into(),
                SpawnFn::new(move |_status| {
                    let observed_spawns = observed_spawns.clone();
                    async move {
                        observed_spawns.fetch_add(1, Ordering::SeqCst);
                        Err(SpawnError::Spawn(std::io::Error::other(
                            "missing executable",
                        )))
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("broken").expect("managed handle");
        handle.start().await.expect("start accepted");
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
        // Acknowledgement cancels the failed attempt instead of letting its backoff respawn it.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
    }

    /// Output of a child with a configured log is forwarded into the log, and only the
    /// latest attempt's output explains its exit.
    #[tokio::test]
    async fn exit_issue_includes_forwarded_output_from_the_latest_attempt() {
        let temp_dir = TempDir::create();
        let path = temp_dir.path().join("exit-diagnostic.log");
        tokio::fs::write(&path, "output from an earlier attempt\n")
            .await
            .expect("seed diagnostic log");
        let registry = WatchdogRegistry::new();
        let spawn = SpawnFn::new(|_status| async {
            Command::new("sh")
                .arg("-c")
                .arg("echo 'starting agent'; echo 'invalid configured directory: /missing' >&2; exit 1")
                .kill_on_drop(true)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(SpawnError::Spawn)
        })
        .with_log_file(LogFileSpec::new(&path, None));
        let _guard = SupervisorGuard(
            spawn_supervisor("log-diagnostic".into(), spawn, &registry, callback())
                .expect("register"),
        );
        let handle = registry.lookup("log-diagnostic").expect("managed handle");

        handle.start().await.expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;
        let issue = handle
            .snapshot()
            .connection_issue
            .expect("failed child should publish its output");
        handle.shutdown().await.expect("backoff interrupted");

        // The browser-facing issue must expose the subprocess's actionable error.
        assert!(
            issue.contains("invalid configured directory: /missing"),
            "{issue}"
        );
        // Output from an old retry must not be presented as part of the latest failure.
        assert!(!issue.contains("output from an earlier attempt"), "{issue}");
        let log = tokio::fs::read_to_string(&path).await.expect("read log");
        // Both streams are persisted after the existing history.
        assert!(log.starts_with("output from an earlier attempt\n"), "{log}");
        assert!(log.contains("starting agent\n"), "{log}");
        assert!(
            log.contains("invalid configured directory: /missing\n"),
            "{log}"
        );
    }

    #[tokio::test]
    async fn piped_ssh_stderr_is_visible_in_connection_issue() {
        let registry = WatchdogRegistry::new();
        let spawn = SpawnFn::new(|_status| async {
            Command::new("sh")
                .arg("-c")
                .arg("printf 'Error: remote port forwarding failed for listen port 51268\\n' >&2; exit 255")
                .kill_on_drop(true)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(SpawnError::Spawn)
        })
        .with_process_name("SSH process");
        let _guard = SupervisorGuard(
            spawn_supervisor("ssh-diagnostic".into(), spawn, &registry, callback())
                .expect("register"),
        );
        let handle = registry.lookup("ssh-diagnostic").expect("managed handle");

        handle.start().await.expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;
        let issue = handle
            .snapshot()
            .connection_issue
            .expect("failed SSH child should publish its stderr");

        // Naming the actual child avoids implying that the verified remote binary returned 255.
        assert!(issue.contains("SSH process exited with status code 255"));
        // OpenSSH's reason must reach the UI instead of collapsing into a bare exit status.
        assert!(issue.contains("remote port forwarding failed for listen port 51268"));
        handle.shutdown().await.expect("backoff interrupted");
    }

    #[tokio::test]
    async fn connection_generation_clears_issue_and_ignores_stale_disconnect() {
        let registry = WatchdogRegistry::new();
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let callback_snapshots = snapshots.clone();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "generation".into(),
                SpawnFn::new(|_status| async {
                    Command::new("sh")
                        .arg("-c")
                        .arg("cat")
                        .kill_on_drop(true)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(SpawnError::Spawn)
                }),
                &registry,
                Arc::new(move |snapshot| {
                    callback_snapshots
                        .lock()
                        .expect("snapshot history poisoned")
                        .push(snapshot);
                }),
            )
            .expect("register"),
        );
        let handle = registry.lookup("generation").expect("managed handle");
        handle.start().await.expect("start accepted");
        publish_issue(
            &handle,
            handle.snapshot().attempt_generation,
            "earlier lifecycle issue".into(),
        );
        let old_socket = SocketId::new();
        let new_socket = SocketId::new();
        let fence_socket = SocketId::new();
        assert!(handle.mark_connected(old_socket.clone()).await.is_some());
        assert!(handle.mark_connected(new_socket.clone()).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&new_socket)).await;
        handle.mark_disconnected(old_socket);
        assert!(handle.mark_connected(fence_socket.clone()).await.is_some());
        wait_until(|| {
            snapshots
                .lock()
                .expect("snapshot history poisoned")
                .iter()
                .any(|snapshot| snapshot.socket_id.as_ref() == Some(&fence_socket))
        })
        .await;

        // A replacement connection stays authoritative when an old session exits late.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Connected);
        assert_eq!(handle.snapshot().socket_id.as_ref(), Some(&fence_socket));
        {
            // Scoped so the std mutex guard is released before the shutdown await below.
            let snapshots = snapshots.lock().expect("snapshot history poisoned");
            let replacement_index = snapshots
                .iter()
                .position(|snapshot| snapshot.socket_id.as_ref() == Some(&new_socket))
                .expect("replacement connection published");
            let fence_index = snapshots
                .iter()
                .position(|snapshot| snapshot.socket_id.as_ref() == Some(&fence_socket))
                .expect("queue fence connection published");
            // Processing the stale disconnect must not publish a Starting transition.
            assert!(
                snapshots[replacement_index..fence_index]
                    .iter()
                    .all(|snapshot| snapshot.status == AgentConnectionStatus::Connected)
            );
        }
        // Successful registration removes an earlier lifecycle diagnostic.
        assert_eq!(handle.snapshot().connection_issue, None);
        handle.shutdown().await.expect("shutdown acknowledged");
    }

    #[tokio::test]
    async fn stale_signal_restarts_only_the_current_socket_generation() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "stale-generation".into(),
                SpawnFn::new(move |_status| {
                    let observed_spawns = observed_spawns.clone();
                    async move {
                        observed_spawns.fetch_add(1, Ordering::SeqCst);
                        Command::new("sh")
                            .arg("-c")
                            .arg("cat")
                            .kill_on_drop(true)
                            .stdin(Stdio::piped())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                            .map_err(SpawnError::Spawn)
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("stale-generation").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;
        let old_socket = SocketId::new();
        let replacement_socket = SocketId::new();
        let fence_socket = SocketId::new();
        // Managed registrations must be accepted while the supervisor is desired-running.
        assert!(handle.mark_connected(old_socket.clone()).await.is_some());
        // A replacement registration must supersede the old socket generation.
        assert!(
            handle
                .mark_connected(replacement_socket.clone())
                .await
                .is_some()
        );
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&replacement_socket)).await;

        handle.signal_stale(old_socket);
        // This connection acts as a queue fence after the stale event without pre-checking state.
        assert!(handle.mark_connected(fence_socket.clone()).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&fence_socket)).await;

        // The replaced socket's late stale event must not terminate the healthy child.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        // Ignoring an old generation must not publish a misleading lifecycle issue.
        assert_eq!(handle.snapshot().connection_issue, None);

        handle.signal_stale(fence_socket);
        wait_until(|| {
            handle.snapshot().connection_issue.as_deref() == Some("Agent connection went stale")
        })
        .await;
        // A stale event for the authoritative socket must promptly end the current child cycle.
        assert_eq!(
            handle.snapshot().connection_issue.as_deref(),
            Some("Agent connection went stale")
        );
        handle.shutdown().await.expect("shutdown acknowledged");
    }

    #[tokio::test]
    async fn provisioning_status_accumulates_then_resets_on_the_next_cycle() {
        let first_spawn = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let wait_first = first_spawn.clone();
        let hold_first = release_first.clone();
        let observed_spawns = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "status".into(),
                SpawnFn::new(move |status| {
                    let wait_first = wait_first.clone();
                    let hold_first = hold_first.clone();
                    let observed_spawns = observed_spawns.clone();
                    async move {
                        let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst);
                        status.report(format!("step-{attempt}"));
                        if attempt == 0 {
                            wait_first.notify_one();
                            hold_first.notified().await;
                        }
                        Err(SpawnError::Spawn(std::io::Error::other(format!(
                            "spawn failed {attempt}"
                        ))))
                    }
                }),
                &registry,
                callback(),
            )
            .expect("register"),
        );
        let handle = registry.lookup("status").expect("managed handle");
        handle.start().await.expect("start accepted");
        first_spawn.notified().await;

        // Progress published during the first cycle must stay visible until the next attempt.
        assert_eq!(
            handle
                .snapshot()
                .provisioning_status
                .iter()
                .map(|line| line.message.as_str())
                .collect::<Vec<_>>(),
            ["step-0"]
        );
        release_first.notify_one();
        wait_until(|| {
            handle
                .snapshot()
                .provisioning_status
                .iter()
                .any(|line| line.message == "step-1")
        })
        .await;

        // A new cycle must replace the previous attempt instead of appending forever.
        assert_eq!(
            handle
                .snapshot()
                .provisioning_status
                .iter()
                .map(|line| line.message.as_str())
                .collect::<Vec<_>>(),
            ["step-1"]
        );
        handle.shutdown().await.expect("shutdown acknowledged");
    }

    /// A full supervisor mailbox makes lifecycle events wait instead of growing memory or
    /// silently dropping a disconnect the supervisor must see.
    #[tokio::test]
    async fn full_mailbox_defers_socket_events_instead_of_dropping() {
        let registry = WatchdogRegistry::new();
        let (handle, mut commands) = registry.register("busy".into(), callback()).unwrap();
        for _ in 0..SUPERVISOR_COMMAND_CAPACITY {
            handle.mark_disconnected(SocketId::new());
        }
        let deferred_socket = SocketId::new();
        // The mailbox is full, yet the session reporting teardown must not wait for it.
        handle.mark_disconnected(deferred_socket.clone());
        commands.recv().await.expect("a queued command");
        let mut last = None;
        while last.is_none()
            || !matches!(&last, Some(SupervisorCommand::Disconnected(socket)) if *socket == deferred_socket)
        {
            last = Some(commands.recv().await.expect("deferred event delivered"));
        }
        // Once space frees up the deferred event is delivered intact.
        assert!(matches!(
            last,
            Some(SupervisorCommand::Disconnected(socket)) if socket == deferred_socket
        ));
    }

    /// Lifecycle requests give up with a busy error instead of hanging the HTTP handlers (and
    /// the configuration lock they hold) behind a wedged supervisor.
    #[tokio::test(start_paused = true)]
    async fn full_mailbox_bounds_lifecycle_requests() {
        let registry = WatchdogRegistry::new();
        let (handle, _commands) = registry.register("wedged".into(), callback()).unwrap();
        for _ in 0..SUPERVISOR_COMMAND_CAPACITY {
            handle.mark_disconnected(SocketId::new());
        }
        // Paused time auto-advances to the reserve deadline while nothing drains the mailbox.
        assert!(matches!(
            handle.start().await,
            Err(WatchdogError::Busy { key }) if key == "wedged"
        ));
    }

    /// A stderr pipe kept open by a surviving grandchild must not stall the supervisor.
    #[tokio::test(start_paused = true)]
    async fn child_diagnostic_read_is_bounded() {
        let reader = tokio::spawn(std::future::pending::<std::io::Result<Vec<u8>>>());
        // Paused time advances to the deadline; the diagnostic is skipped, not awaited forever.
        assert_eq!(
            read_child_diagnostic(Some(reader), CHILD_DIAGNOSTIC_TIMEOUT).await,
            None
        );
    }

    /// Spawn failures keep their class for logs but show only the transport text in the UI.
    #[test]
    fn spawn_error_user_message_omits_internal_classification() {
        let error = SpawnError::Spawn(std::io::Error::other("ssh: not found"));
        // Logs name what failed.
        assert_eq!(
            error.to_string(),
            "Starting the agent process failed: ssh: not found"
        );
        // Browser text stays exactly the underlying, actionable reason.
        assert_eq!(error.user_message(), "ssh: not found");
    }
}
