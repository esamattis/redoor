//! Per-device watchdog supervisors for managed agents.
//!
//! A managed agent is a daemon on its device (`redoor agent managed`), which outlives SSH
//! sessions and server restarts so its shells do too. A supervisor owns the server's
//! *session* to that daemon. Each cycle runs the ensure step, which keeps or replaces the
//! daemon, reports it, and then holds the session open; for SSH devices the session carries
//! the tunnel. Killing the session only drops the tunnel: the daemon reconnects through the
//! next one.
//!
//! A supervisor is registered at server startup, stopped, and runs while its device is
//! desired-running. Nothing is saved across server restarts: the user starts devices, and a
//! local daemon that reconnects on its own is adopted (see
//! [`WatchdogHandle::mark_connected`]). It never gives
//! up on a desired-running device: every failure is retried on the shared [`Backoff`]
//! schedule, and a daemon that stays without a connection is replaced. The only wait without
//! a timer is for a locked SSH key, which no retry can unlock.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use redoor_core::backoff::Backoff;
use redoor_core::log;
use redoor_protocol::api::agents::{AgentConnectionStatus, ProvisioningStatusMessage};
use redoor_protocol::identity::BinaryIdentity;
use redoor_protocol::ids::{SocketId, UnixTimestampMillis};
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::managed::{DaemonReport, EnsureOutcome, HolderEnd};

/// Surfaces a useful issue when a session's daemon has not connected promptly.
const STARTUP_CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a session may stay without a connection, after its start or after the socket
/// closed, before the next cycle replaces the daemon. A running session is no proof the
/// daemon comes back (a wedged daemon, an `ssh` whose remote side hangs), and the deadline
/// is long enough for a slow SSH login and launch.
const CONNECTION_DEADLINE: Duration = Duration::from_secs(60);
/// Bounds browser-visible subprocess output so repeated failures cannot grow API responses.
const MAX_EXIT_DIAGNOSTIC_BYTES: usize = 8 * 1024;
/// Supervisor mailbox size; senders wait (rather than grow memory) while a child is reaped.
const SUPERVISOR_COMMAND_CAPACITY: usize = 16;
/// Longest a lifecycle request waits for a mailbox slot. HTTP handlers call the watchdog
/// while holding the configuration lock, so a wedged supervisor must surface as a busy error
/// instead of stalling every lifecycle and configuration route behind that lock.
const COMMAND_RESERVE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an exited session's output may stay open before its diagnostic is given up. A
/// `ProxyCommand` grandchild can inherit the pipe and keep it open long after the child
/// died, and the supervisor must not stop processing commands while it waits.
const CHILD_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(2);

/// Why one cycle produced no session.
///
/// Typed instead of a string so logs keep the failure class while the browser only sees
/// the transport's own actionable text via [`SpawnError::user_message`].
#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    /// Preparing the target (SSH probe, binary install) failed before any child existed.
    #[error("Preparing the agent failed: {0}")]
    Provision(#[source] crate::ssh::ProvisionError),
    /// The session process itself could not be started or reported nothing usable.
    #[error("Starting the agent process failed: {0}")]
    Spawn(#[source] std::io::Error),
    /// The ensure step ran but no daemon runs, with its explanation.
    #[error("Starting the agent daemon failed: {0}")]
    Ensure(String),
}

impl SpawnError {
    /// Text for the lifecycle UI: the underlying reason without the internal classification.
    pub fn user_message(&self) -> String {
        match self {
            Self::Provision(error) => error.to_string(),
            Self::Spawn(error) => error.to_string(),
            Self::Ensure(message) => message.clone(),
        }
    }

    /// Whether another attempt could succeed without the user doing something first.
    fn is_retryable(&self) -> bool {
        match self {
            Self::Provision(error) => error.is_retryable(),
            Self::Spawn(_) | Self::Ensure(_) => true,
        }
    }
}

/// Lifecycle control failures, mapped to HTTP statuses by the REST layer.
#[derive(Debug, thiserror::Error)]
pub enum WatchdogError {
    /// The supervisor task is gone (removed or crashed), so it cannot act on the request.
    #[error("Watchdog supervisor stopped: {key}")]
    SupervisorStopped {
        /// Supervisor key (device id).
        key: String,
    },
    /// The supervisor ended before acknowledging a request it had accepted.
    #[error("Watchdog {operation} acknowledgement dropped: {key}")]
    AcknowledgementDropped {
        /// `shutdown`, `retry`, `restart` or `detach`.
        operation: &'static str,
        /// Supervisor key (device id).
        key: String,
    },
    /// Another supervisor already owns this key.
    #[error("Watchdog key already registered: key={key}")]
    AlreadyRegistered {
        /// Supervisor key (device id).
        key: String,
    },
    /// The supervisor did not accept the request in time (it is busy reaping or wedged).
    #[error("Watchdog supervisor is busy: {key}")]
    Busy {
        /// Supervisor key (device id).
        key: String,
    },
    /// Configuration may only change while the managed agent is stopped.
    #[error("Managed agent must be stopped before its configuration can change")]
    StillRunning,
    /// A restart needs a running device; a stopped one is started instead.
    #[error("Managed agent is not running; start it instead")]
    NotRunning,
}

/// What one cycle's ensure step needs to know besides the device's configuration.
pub struct CycleRequest {
    /// Progress lines for the lifecycle UI.
    pub status: ProvisioningStatusSink,
    /// Replace the daemon even when it matches (a Restart, or one that stopped connecting).
    pub replace: bool,
    /// Whether the server has a socket from this device now; a kept daemon is woken to
    /// reconnect at once only when it has none.
    pub server_connected: bool,
    /// Marks that a daemon may run on the device. The transport sets it right before it
    /// sends the payload, from which on the ensure step can start a daemon even if its
    /// report never arrives, so a later Stop must reach the device.
    pub daemon_may_run: DaemonMayRun,
}

/// See [`CycleRequest::daemon_may_run`].
#[derive(Clone)]
pub struct DaemonMayRun(Arc<std::sync::atomic::AtomicBool>);

impl DaemonMayRun {
    /// Records that the ensure step may start a daemon from now on.
    pub fn mark(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// A running session: the process holding it and the daemon its ensure step reported.
pub struct ManagedSession {
    /// The session process (`redoor agent managed` locally, `ssh` for SSH devices). Its
    /// stdin is the session's liveness signal and must stay open while the cycle runs.
    pub child: Child,
    /// The daemon running after the ensure step.
    pub daemon: DaemonReport,
}

/// Result of one cycle's ensure step.
type SpawnResult = Result<ManagedSession, SpawnError>;

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

/// Session strategy kept transport-agnostic so local and SSH-backed agents share lifecycle
/// code.
pub struct SpawnFn {
    inner: Arc<
        dyn Fn(CycleRequest) -> futures_util::future::BoxFuture<'static, SpawnResult> + Send + Sync,
    >,
    process_name: &'static str,
}

impl SpawnFn {
    /// Boxes a reusable async session closure once at the supervisor boundary.
    pub fn new<F, Fut>(f: F) -> Self
    where
        F: Fn(CycleRequest) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = SpawnResult> + Send + 'static,
    {
        Self {
            inner: Arc::new(move |request| Box::pin(f(request))),
            process_name: "Agent session",
        }
    }

    /// Names the session process accurately in browser-visible lifecycle failures.
    pub fn with_process_name(mut self, process_name: &'static str) -> Self {
        self.process_name = process_name;
        self
    }

    /// Starts one transport-specific ensure step.
    fn spawn(
        &self,
        request: CycleRequest,
    ) -> futures_util::future::BoxFuture<'static, SpawnResult> {
        (self.inner)(request)
    }
}

/// A prepared operation on the device's daemon (stop it, or stop it and delete its
/// namespace), with the credentials it needs captured when it was built.
///
/// Built by the HTTP handler before it releases a held SSH key, so an encrypted key stays
/// usable for the operation and is dropped with it.
pub type RemoteJob =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Public lifecycle snapshot shared with inventory and REST projections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogSnapshot {
    /// Invalidates work and registrations that belong to a canceled startup attempt.
    pub attempt_generation: u64,
    /// Separates operator intent from transient connection state.
    pub desired_running: bool,
    /// Gives clients the lifecycle state without exposing process details.
    pub status: AgentConnectionStatus,
    /// Retains the latest actionable spawn, exit, stop or startup issue.
    pub connection_issue: Option<String>,
    /// Accumulated prepare/ensure lines for the current start cycle.
    pub provisioning_status: Vec<ProvisioningStatusMessage>,
    /// Protects replacement connections from stale disconnect events.
    pub socket_id: Option<SocketId>,
}

impl WatchdogSnapshot {
    /// The state of a device nobody started.
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

/// Callback that ends the router connection of `socket` with `superseded`, for a daemon that
/// connected before its ensure report and turned out not to be the reported one.
pub type SupersedeCallback = Arc<dyn Fn(SocketId) + Send + Sync>;

/// What a connecting daemon announced about itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectingDaemon {
    /// Its build.
    pub binary: BinaryIdentity,
    /// Its spec hash; absent for agents that are not managed daemons.
    pub spec_hash: Option<String>,
}

/// The daemon the current cycle's ensure step reported, the only one whose `hello` is
/// accepted.
#[derive(Clone, Debug)]
struct ExpectedDaemon {
    /// Attempt the report belongs to.
    attempt_generation: u64,
    /// Build of the reported daemon.
    binary: BinaryIdentity,
    /// Spec hash of the reported daemon.
    spec_hash: String,
}

impl ExpectedDaemon {
    /// Whether `daemon` is the reported one.
    fn matches(&self, daemon: &ConnectingDaemon) -> bool {
        daemon.binary == self.binary && daemon.spec_hash.as_deref() == Some(&self.spec_hash)
    }
}

/// How a managed `hello` is answered.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectVerdict {
    /// Accepted for this attempt; provisionally when no ensure report exists yet.
    Accepted(u64),
    /// The device is not desired-running.
    Stopped,
    /// Another build or settings than the latest ensure report.
    Superseded,
}

/// Events serialize lifecycle changes so socket generations are checked by the supervisor.
enum SupervisorCommand {
    Start,
    Retry {
        reply: oneshot::Sender<()>,
    },
    /// Replaces the daemon in a new cycle (Restart of a managed device).
    Restart {
        reply: oneshot::Sender<()>,
    },
    Remove,
    /// Drops the session and, with a job, stops the daemon on the device afterwards.
    Shutdown {
        reply: oneshot::Sender<()>,
        stop: Option<RemoteJob>,
    },
    /// Drops the session only and ends the supervisor, for a server that is going away.
    Detach {
        reply: oneshot::Sender<()>,
    },
    Connected {
        socket_id: SocketId,
        attempt_generation: u64,
        daemon: ConnectingDaemon,
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
    supersede: SupersedeCallback,
    /// The latest ensure report of the current attempt; see [`ExpectedDaemon`].
    expected: Arc<Mutex<Option<ExpectedDaemon>>>,
    /// Whether a daemon of this device may run: an ensure step reported one in this server
    /// process, or a daemon that outlived the previous server process connected on its own.
    /// A stop only reaches out to the device then, so stopping a device that never got a
    /// daemon (a wrong password, an unreachable host) does not wait for that device.
    daemon_may_run: Arc<std::sync::atomic::AtomicBool>,
    /// The signed-in user whose Start or Retry asked for the next cycle. The supervisor
    /// takes it for that cycle's spawn, so its provisioning logs name the user, while
    /// later automatic reconnects find nothing and log without one.
    requester: Arc<Mutex<Option<Arc<str>>>>,
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
    /// Returns the stable configured key (the device id) used by sessions and routes.
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
    ///
    /// An agent that is already desired-running still gets the Start: one that waits for its
    /// SSH key to be unlocked resumes with it, and every other state ignores it.
    pub async fn start(&self) -> Result<(), WatchdogError> {
        let permit = self.reserve().await?;
        self.record_requester();
        let should_publish = {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            if snapshot.desired_running {
                permit.send(SupervisorCommand::Start);
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

    /// Drops the device's session and stops it.
    ///
    /// Acknowledged once the session is gone, without waiting for `stop`: reaching an SSH
    /// device can take long, and the HTTP handlers waiting here have a short timeout. The
    /// supervisor then runs `stop` (status `Stopping`) and retries it on the backoff until
    /// it succeeds or the device is started again. Without `stop`, a connected daemon is
    /// still ended through its connection.
    pub async fn shutdown(&self, stop: Option<RemoteJob>) -> Result<(), WatchdogError> {
        let (reply, response) = oneshot::channel();
        let permit = self.reserve().await?;
        {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            snapshot.desired_running = false;
            snapshot.attempt_generation = snapshot.attempt_generation.wrapping_add(1);
            permit.send(SupervisorCommand::Shutdown { reply, stop });
        }
        response
            .await
            .map_err(|_| WatchdogError::AcknowledgementDropped {
                operation: "shutdown",
                key: self.key.clone(),
            })
    }

    /// Drops the device's session and ends the supervisor without changing anything else.
    ///
    /// Used when the server itself goes away (restart or shutdown): the daemon keeps running
    /// and the next server process starts a new session to it.
    pub async fn detach(&self) -> Result<(), WatchdogError> {
        let (reply, response) = oneshot::channel();
        self.reserve()
            .await?
            .send(SupervisorCommand::Detach { reply });
        response
            .await
            .map_err(|_| WatchdogError::AcknowledgementDropped {
                operation: "detach",
                key: self.key.clone(),
            })
    }

    /// Replaces the daemon of a running device in a new cycle.
    ///
    /// A daemon started from a payload cannot re-exec itself (its stdin is closed, and exec
    /// would release its lock), so a Restart of a managed device asks the ensure step to
    /// replace it instead.
    pub async fn restart(&self) -> Result<(), WatchdogError> {
        let (reply, response) = oneshot::channel();
        let permit = self.reserve().await?;
        if !self.snapshot().desired_running {
            return Err(WatchdogError::NotRunning);
        }
        permit.send(SupervisorCommand::Restart { reply });
        response
            .await
            .map_err(|_| WatchdogError::AcknowledgementDropped {
                operation: "restart",
                key: self.key.clone(),
            })
    }

    /// Remembers the calling task's user for the next cycle; see `requester`.
    fn record_requester(&self) {
        *self.requester.lock().expect("watchdog requester poisoned") =
            redoor_core::logging::current_user();
    }

    /// Takes the user who asked for the cycle that is starting now, if any.
    fn take_requester(&self) -> Option<Arc<str>> {
        self.requester
            .lock()
            .expect("watchdog requester poisoned")
            .take()
    }

    /// Fences registrations from the old attempt until its work is canceled and a fresh cycle starts.
    pub async fn retry_startup(&self) -> Result<(), WatchdogError> {
        let (reply, response) = oneshot::channel();
        let permit = self.reserve().await?;
        self.record_requester();
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

    /// Decides a managed `hello`: rejected while stopped, superseded when it is not the daemon
    /// the latest ensure report describes, otherwise accepted for the current attempt.
    ///
    /// The server never starts devices on its own when it starts, because an SSH device may
    /// need a key only an unlocked vault gives, and starting one is the user's decision. A
    /// daemon that outlived the previous server process needs no tunnel when it runs on this
    /// host, though, and reconnects by itself; such a device is adopted as running instead of
    /// being refused, which would end the daemon and its shells. Only a device nobody
    /// started or stopped in this server process is adopted, so a Stop is never undone.
    ///
    /// Without a report for the current cycle the `hello` is accepted provisionally: a local
    /// daemon reconnects on its own, and an SSH forward exists before the remote command
    /// prints anything. The supervisor checks it once the report arrives.
    pub async fn mark_connected(
        &self,
        socket_id: SocketId,
        daemon: ConnectingDaemon,
    ) -> ConnectVerdict {
        if self.untouched() {
            log!(
                Level::Info,
                "Adopting a managed agent daemon that reconnected on its own: key={}",
                self.key
            );
            self.set_daemon_may_run(true);
            match self.adopt(&socket_id, &daemon).await {
                Ok(Some(attempt_generation)) => {
                    return ConnectVerdict::Accepted(attempt_generation);
                }
                // Someone started or stopped the device meanwhile; judge it like any `hello`.
                Ok(None) => {}
                Err(_) => return ConnectVerdict::Stopped,
            }
        }
        let Ok(permit) = self.reserve().await else {
            return ConnectVerdict::Stopped;
        };
        let snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
        if !snapshot.desired_running {
            return ConnectVerdict::Stopped;
        }
        let attempt_generation = snapshot.attempt_generation;
        let superseded = self.expected().is_some_and(|expected| {
            expected.attempt_generation == attempt_generation && !expected.matches(&daemon)
        });
        if superseded {
            return ConnectVerdict::Superseded;
        }
        permit.send(SupervisorCommand::Connected {
            socket_id,
            attempt_generation,
            daemon,
        });
        ConnectVerdict::Accepted(attempt_generation)
    }

    /// Starts an untouched device with the daemon that reconnected by itself as its current
    /// connection, returning the new attempt, or `None` when the device is no longer untouched.
    ///
    /// The socket is published and `Start` and `Connected` are queued under one lock, so the
    /// adopting cycle already sees the connection. A cycle that saw none would have its ensure
    /// step wake the kept daemon to reconnect, which drops the connection and every terminal a
    /// client reattached to it after the server restart.
    async fn adopt(
        &self,
        socket_id: &SocketId,
        daemon: &ConnectingDaemon,
    ) -> Result<Option<u64>, WatchdogError> {
        let start = self.reserve().await?;
        let connected = self.reserve().await?;
        self.record_requester();
        let snapshot = {
            let mut snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
            if snapshot.desired_running || snapshot.attempt_generation != 0 {
                return Ok(None);
            }
            snapshot.attempt_generation = snapshot.attempt_generation.wrapping_add(1);
            let attempt_generation = snapshot.attempt_generation;
            start.send(SupervisorCommand::Start);
            connected.send(SupervisorCommand::Connected {
                socket_id: socket_id.clone(),
                attempt_generation,
                daemon: daemon.clone(),
            });
            snapshot.desired_running = true;
            snapshot.status = AgentConnectionStatus::Connected;
            snapshot.connection_issue = None;
            snapshot.provisioning_status.clear();
            snapshot.socket_id = Some(socket_id.clone());
            snapshot.clone()
        };
        let attempt_generation = snapshot.attempt_generation;
        (self.callback)(snapshot);
        Ok(Some(attempt_generation))
    }

    /// Whether nobody started or stopped the device in this server process: every Start,
    /// Stop and Retry starts a new attempt, so the first attempt generation is still current.
    fn untouched(&self) -> bool {
        let snapshot = self.snapshot.lock().expect("watchdog snapshot poisoned");
        !snapshot.desired_running && snapshot.attempt_generation == 0
    }

    /// Records whether a daemon of this device may run; see `daemon_may_run`.
    fn set_daemon_may_run(&self, may_run: bool) {
        self.daemon_may_run
            .store(may_run, std::sync::atomic::Ordering::SeqCst);
    }

    /// Keeps `stop` only when a daemon of this device may run.
    fn stop_if_needed(&self, stop: Option<RemoteJob>) -> Option<RemoteJob> {
        stop.filter(|_| {
            self.daemon_may_run
                .load(std::sync::atomic::Ordering::SeqCst)
        })
    }

    /// The latest ensure report, if the current cycle has one.
    fn expected(&self) -> Option<ExpectedDaemon> {
        self.expected
            .lock()
            .expect("watchdog expectation poisoned")
            .clone()
    }

    /// Replaces the latest ensure report.
    fn set_expected(&self, expected: Option<ExpectedDaemon>) {
        *self.expected.lock().expect("watchdog expectation poisoned") = expected;
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

    /// Asks for a new session only if the stale WebSocket is still the current generation.
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

/// Shared lookup from device id to its lifecycle handle.
#[derive(Clone, Default)]
pub struct WatchdogRegistry {
    inner: Arc<Mutex<std::collections::HashMap<String, WatchdogHandle>>>,
}

impl WatchdogRegistry {
    /// Creates an empty registry, for tests.
    #[cfg(test)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Drops every session before the server process goes away.
    ///
    /// Daemons are never stopped here: they keep their shells. The next server process starts
    /// no device on its own; a local daemon reconnects and is adopted, and an SSH device
    /// waits for the user's Start, which keeps its running daemon. Exec preserves process memory
    /// rather than dropping Rust values, so the sessions are ended explicitly.
    pub async fn detach_all(&self) {
        let handles = self
            .inner
            .lock()
            .expect("watchdog registry poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handle in handles {
            if let Err(error) = handle.detach().await {
                log!(
                    Level::Warning,
                    "Failed to detach watchdog during server teardown: key={}, error={}",
                    handle.key(),
                    error
                );
            }
        }
    }

    /// Returns the managed handle for a device id, or `None` for external agents.
    pub fn lookup(&self, key: &str) -> Option<WatchdogHandle> {
        self.inner
            .lock()
            .expect("watchdog registry poisoned")
            .get(key)
            .cloned()
    }

    /// Removes a stopped supervisor after callers verify it has no running intent, then runs
    /// `cleanup` on the device in the background.
    ///
    /// The map entry is removed under the registry lock; the `Remove` command is sent
    /// afterwards (deferred to a task when the mailbox is full) because waiting for mailbox
    /// space must neither hold a std mutex nor stall the configuration route calling this.
    /// The cleanup runs once after the supervisor is gone, so an unreachable device cannot
    /// block a delete; a daemon it misses ends at its orphan limit.
    pub fn remove_stopped(
        &self,
        key: &str,
        cleanup: Option<RemoteJob>,
    ) -> Result<(), WatchdogError> {
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
        if let Some(cleanup) = cleanup {
            let key = key.to_string();
            tokio::spawn(async move {
                match cleanup().await {
                    Ok(()) => log!(
                        Level::Info,
                        "Removed a deleted managed agent from its device: key={}",
                        key
                    ),
                    Err(error) => log!(
                        Level::Warning,
                        "Failed to remove a deleted managed agent from its device; its daemon ends at the orphan limit: key={}, error={}",
                        key,
                        error
                    ),
                }
            });
        }
        Ok(())
    }

    /// Registers all control primitives atomically before the supervisor task is spawned.
    fn register(
        &self,
        key: String,
        callback: SnapshotCallback,
        supersede: SupersedeCallback,
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
            supersede,
            expected: Arc::default(),
            daemon_may_run: Arc::default(),
            requester: Arc::default(),
        };
        map.insert(key, handle.clone());
        Ok((handle, receiver))
    }
}

/// Registers a stopped supervisor and returns its task for test cleanup.
pub fn spawn_supervisor(
    key: String,
    spawn: SpawnFn,
    registry: &WatchdogRegistry,
    callback: SnapshotCallback,
    supersede: SupersedeCallback,
) -> Result<tokio::task::JoinHandle<()>, WatchdogError> {
    let (watchdog, commands) = registry.register(key.clone(), callback, supersede)?;
    log!(Level::Info, "Watchdog supervisor registered: key={}", key);
    Ok(tokio::spawn(
        Supervisor {
            key,
            spawn,
            watchdog,
            commands,
            replace_next: false,
            connected: None,
        }
        .run(),
    ))
}

/// What ends a cycle and decides the next step.
enum CommandAction {
    /// Retry after the backoff.
    Continue,
    /// An explicit operator retry or restart skips the backoff and begins a clean cycle.
    Restart,
    /// Stop: the session is gone and the stop job, if any, still has to run.
    Stop(Option<RemoteJob>),
    /// The attempt failed in a way retrying cannot fix (a locked SSH key); the agent stays
    /// desired-running with the issue shown until the next Start or Retry.
    WaitForStart,
    /// Configuration replacement must end the task, not just return it to idle.
    Exit,
    /// The server is going away: end the task without touching the snapshot.
    Detach,
}

/// Separates commands that keep watching a session from those that finish its cycle.
enum RunningCommandAction {
    /// The current session remains authoritative and should keep running.
    Continue,
    /// The cycle ended and the supervisor should apply this lifecycle action.
    Finish(CommandAction),
}

/// Captures the information needed to decide whether another cycle should run.
struct CycleResult {
    action: CommandAction,
    was_connected: bool,
}

/// How the stopped state ended.
enum IdleWait {
    /// A start (or retry) arrived.
    Start,
    /// Remove, detach or channel close must drop the task so a replacement can reuse the key.
    Exit,
}

/// One device's supervisor task.
struct Supervisor {
    /// Device id.
    key: String,
    /// Transport-specific ensure step.
    spawn: SpawnFn,
    /// Shared handle.
    watchdog: WatchdogHandle,
    /// Lifecycle mailbox.
    commands: mpsc::Receiver<SupervisorCommand>,
    /// Set when the next cycle must replace the daemon (a Restart, or a daemon that stayed
    /// without a connection for the deadline).
    replace_next: bool,
    /// The current socket and what its daemon announced, kept across cycles because a local
    /// daemon's connection does not depend on the session.
    connected: Option<(SocketId, ConnectingDaemon)>,
}

impl Supervisor {
    /// Waits in the stopped state, then runs desired-running cycles, until removed.
    async fn run(mut self) {
        let mut start_now = false;
        loop {
            if !start_now && let IdleWait::Exit = self.wait_until_running().await {
                return;
            }
            start_now = false;
            match self.run_desired().await {
                CommandAction::Exit => {
                    publish_stopped(&self.watchdog);
                    return;
                }
                CommandAction::Detach => return,
                CommandAction::Stop(Some(stop)) => match self.run_stop(stop).await {
                    StopEnd::Exit => return,
                    StopEnd::Start => start_now = true,
                    StopEnd::Idle => {}
                },
                _ => {
                    self.connected = None;
                    publish_stopped(&self.watchdog);
                }
            }
        }
    }

    /// Waits for a start while stopped, acknowledging harmless requests.
    async fn wait_until_running(&mut self) -> IdleWait {
        while let Some(command) = self.commands.recv().await {
            match command {
                SupervisorCommand::Start => return IdleWait::Start,
                SupervisorCommand::Retry { reply } => {
                    publish_fresh_start(&self.watchdog);
                    let _ = reply.send(());
                    return IdleWait::Start;
                }
                SupervisorCommand::Remove => return IdleWait::Exit,
                SupervisorCommand::Detach { reply } => {
                    let _ = reply.send(());
                    return IdleWait::Exit;
                }
                SupervisorCommand::Shutdown { reply, stop } => {
                    let _ = reply.send(());
                    let Some(stop) = self.watchdog.stop_if_needed(stop) else {
                        publish_stopped(&self.watchdog);
                        continue;
                    };
                    // A stop of a stopped device still reaches a daemon its last stop missed,
                    // for example one that outlived a server restart.
                    publish_stopping(&self.watchdog);
                    match self.run_stop(stop).await {
                        StopEnd::Exit => return IdleWait::Exit,
                        StopEnd::Start => return IdleWait::Start,
                        StopEnd::Idle => {}
                    }
                }
                SupervisorCommand::Restart { reply } => {
                    let _ = reply.send(());
                }
                SupervisorCommand::Connected { .. }
                | SupervisorCommand::Disconnected(_)
                | SupervisorCommand::Stale(_) => {}
            }
        }
        IdleWait::Exit
    }

    /// Runs cycles with backoff while the device is desired-running.
    async fn run_desired(&mut self) -> CommandAction {
        let mut backoff = Backoff::default();
        loop {
            // Shutdown changes intent before queue processing so a stale Start command
            // cannot revive preparation while its shutdown acknowledgement is pending.
            if !self.watchdog.snapshot().desired_running {
                return CommandAction::Stop(None);
            }
            let started = Instant::now();
            let cycle = self.run_cycle().await;
            match cycle.action {
                CommandAction::Restart => {
                    backoff.reset();
                }
                CommandAction::WaitForStart => {
                    log!(
                        Level::Info,
                        "Watchdog waiting for the next start: key={}",
                        self.key
                    );
                    match self.wait_for_start().await {
                        CommandAction::Continue | CommandAction::Restart => backoff.reset(),
                        action => return action,
                    }
                }
                CommandAction::Continue => {
                    if cycle.was_connected {
                        backoff.reset_if_stable(started.elapsed());
                    }
                    let delay = backoff.next_delay();
                    log!(
                        Level::Info,
                        "Watchdog retry scheduled: key={}, backoff={:?}",
                        self.key,
                        delay
                    );
                    match self.wait_for_restart(delay).await {
                        CommandAction::Continue => {}
                        CommandAction::Restart | CommandAction::WaitForStart => backoff.reset(),
                        action => return action,
                    }
                }
                action => return action,
            }
        }
    }

    /// One cycle: the cancellable ensure step, then watching the session.
    async fn run_cycle(&mut self) -> CycleResult {
        let watchdog = self.watchdog.clone();
        watchdog.publish_update(|snapshot| {
            snapshot.desired_running = true;
            // A local daemon can stay connected while its session is replaced.
            if snapshot.socket_id.is_none() {
                snapshot.status = AgentConnectionStatus::Starting;
            }
            snapshot.provisioning_status.clear();
        });
        // Until this cycle's report arrives, every `hello` is provisional.
        watchdog.set_expected(None);
        let snapshot = watchdog.snapshot();
        let attempt_generation = snapshot.attempt_generation;
        let request = CycleRequest {
            status: watchdog.provisioning_status_sink(attempt_generation),
            replace: std::mem::take(&mut self.replace_next),
            server_connected: snapshot.socket_id.is_some(),
            daemon_may_run: DaemonMayRun(watchdog.daemon_may_run.clone()),
        };
        // A cycle a user asked for logs its provisioning as that user.
        let spawn_future =
            redoor_core::logging::user_scope(watchdog.take_requester(), self.spawn.spawn(request));
        tokio::pin!(spawn_future);
        let session = loop {
            tokio::select! {
                result = &mut spawn_future => break result,
                command = self.commands.recv() => {
                    match self.handle_pre_session_command(command) {
                        RunningCommandAction::Continue => {}
                        RunningCommandAction::Finish(action) => {
                            return CycleResult { action, was_connected: false };
                        }
                    }
                }
            }
        };
        match session {
            Ok(session) => {
                self.accept_report(&session.daemon, attempt_generation);
                self.watch_session(session.child, attempt_generation).await
            }
            Err(error) => report_spawn_failure(&watchdog, attempt_generation, error),
        }
    }

    /// Records the ensure report as the only daemon whose `hello` is accepted and checks a
    /// daemon that connected before it.
    fn accept_report(&self, daemon: &DaemonReport, attempt_generation: u64) {
        let status = match daemon.outcome {
            EnsureOutcome::Kept => format!("Kept the running agent daemon (PID {})", daemon.pid),
            EnsureOutcome::Started => format!("Started the agent daemon (PID {})", daemon.pid),
            EnsureOutcome::Restarted => {
                format!("Replaced the agent daemon (new PID {})", daemon.pid)
            }
        };
        self.watchdog
            .report_provisioning_status(attempt_generation, status);
        self.watchdog.set_daemon_may_run(true);
        self.watchdog.set_expected(Some(ExpectedDaemon {
            attempt_generation,
            binary: daemon.binary.clone(),
            spec_hash: daemon.spec_hash.clone(),
        }));
        self.supersede_if_unexpected();
    }

    /// Ends the current connection when it is not the reported daemon. Its `hello` came
    /// before the report and was accepted provisionally.
    fn supersede_if_unexpected(&self) {
        let (Some(expected), Some((socket_id, daemon))) =
            (self.watchdog.expected(), &self.connected)
        else {
            return;
        };
        if expected.matches(daemon) {
            return;
        }
        log!(
            Level::Warning,
            "Superseding a managed agent connection that is not the reported daemon: key={}, socket_id={}",
            self.key,
            socket_id
        );
        (self.watchdog.supersede)(socket_id.clone());
    }

    /// Applies a command while the ensure step still runs.
    fn handle_pre_session_command(
        &mut self,
        command: Option<SupervisorCommand>,
    ) -> RunningCommandAction {
        match command {
            Some(SupervisorCommand::Shutdown { reply, stop }) => {
                let stop = self.watchdog.stop_if_needed(stop);
                self.connected = None;
                publish_stop_requested(&self.watchdog, stop.is_some());
                let _ = reply.send(());
                RunningCommandAction::Finish(CommandAction::Stop(stop))
            }
            Some(SupervisorCommand::Retry { reply }) => {
                self.connected = None;
                publish_fresh_start(&self.watchdog);
                let _ = reply.send(());
                RunningCommandAction::Finish(CommandAction::Restart)
            }
            Some(SupervisorCommand::Restart { reply }) => {
                self.replace_next = true;
                let _ = reply.send(());
                RunningCommandAction::Finish(CommandAction::Restart)
            }
            Some(SupervisorCommand::Detach { reply }) => {
                let _ = reply.send(());
                RunningCommandAction::Finish(CommandAction::Detach)
            }
            Some(SupervisorCommand::Remove) | None => {
                RunningCommandAction::Finish(CommandAction::Exit)
            }
            Some(command) => {
                self.apply_socket_event(command);
                RunningCommandAction::Continue
            }
        }
    }

    /// Applies `Connected` and `Disconnected` of the current socket; events of replaced
    /// sockets change nothing.
    fn apply_socket_event(&mut self, command: SupervisorCommand) {
        match command {
            SupervisorCommand::Connected {
                socket_id,
                attempt_generation,
                daemon,
            } => {
                if publish_connected(&self.watchdog, attempt_generation, socket_id.clone()) {
                    self.connected = Some((socket_id, daemon));
                    self.supersede_if_unexpected();
                }
            }
            SupervisorCommand::Disconnected(socket_id)
                if publish_disconnected(&self.watchdog, &socket_id) =>
            {
                self.connected = None;
            }
            _ => {}
        }
    }

    /// Watches the session, registration timeouts and lifecycle commands concurrently.
    ///
    /// A session that has no connection for [`CONNECTION_DEADLINE`], after its start or after
    /// its socket closed, is dropped and the next cycle replaces the daemon: a running session
    /// is no proof that the daemon will ever reach the server again.
    async fn watch_session(&mut self, mut child: Child, attempt_generation: u64) -> CycleResult {
        // Tokio closes Child::stdin when wait() is polled. The session's stdin stays open so
        // the holder sees EOF only when this cycle ends.
        let _retained_stdin = child.stdin.take();
        let output_reader = spawn_output_reader(&mut child);
        let startup_timeout = tokio::time::sleep(STARTUP_CONNECTION_TIMEOUT);
        tokio::pin!(startup_timeout);
        let connection_deadline = tokio::time::sleep(CONNECTION_DEADLINE);
        tokio::pin!(connection_deadline);
        // The daemon can register while the ensure step still runs, or stay connected from
        // an earlier cycle; that connection already counts.
        let mut connected = self.watchdog.snapshot().socket_id.is_some();
        let mut timeout_reported = false;
        let process_name = self.spawn.process_name;

        loop {
            tokio::select! {
                status = child.wait() => {
                    let output = read_child_diagnostic(output_reader, CHILD_DIAGNOSTIC_TIMEOUT).await;
                    let issue = format_exit_issue(status, process_name, output.as_ref());
                    publish_issue(&self.watchdog, attempt_generation, issue);
                    return CycleResult { action: CommandAction::Continue, was_connected: connected };
                }
                _ = &mut startup_timeout, if !connected && !timeout_reported => {
                    timeout_reported = true;
                    publish_issue(&self.watchdog, attempt_generation, "Agent daemon is running but has not connected within 15 seconds".to_string());
                }
                _ = &mut connection_deadline, if !connected => {
                    return self.replace_unconnected(&mut child, attempt_generation).await;
                }
                command = self.commands.recv() => {
                    let was_connected = connected;
                    match self.handle_session_command(command, &mut child, &mut connected, attempt_generation).await {
                        RunningCommandAction::Continue => {}
                        RunningCommandAction::Finish(action) => {
                            return CycleResult { action, was_connected: connected };
                        }
                    }
                    if was_connected && !connected {
                        connection_deadline.as_mut().reset(tokio::time::Instant::now() + CONNECTION_DEADLINE);
                    }
                }
            }
        }
    }

    /// Drops a session whose daemon stayed without a connection past the deadline; the next
    /// cycle, after the usual backoff, replaces the daemon.
    async fn replace_unconnected(
        &mut self,
        child: &mut Child,
        attempt_generation: u64,
    ) -> CycleResult {
        log!(
            Level::Warning,
            "Managed agent has no connection; replacing its daemon: key={}",
            self.key
        );
        kill_and_reap(child).await;
        self.replace_next = true;
        publish_issue(
            &self.watchdog,
            attempt_generation,
            format!(
                "Agent daemon had no connection for {} seconds and is being replaced",
                CONNECTION_DEADLINE.as_secs()
            ),
        );
        CycleResult {
            action: CommandAction::Continue,
            was_connected: false,
        }
    }

    /// Applies one command while a session runs. Every command that ends the cycle drops the
    /// session first, which never stops the daemon by itself.
    async fn handle_session_command(
        &mut self,
        command: Option<SupervisorCommand>,
        child: &mut Child,
        connected: &mut bool,
        attempt_generation: u64,
    ) -> RunningCommandAction {
        match command {
            Some(SupervisorCommand::Stale(socket_id)) => {
                if self.watchdog.snapshot().socket_id.as_ref() != Some(&socket_id) {
                    return RunningCommandAction::Continue;
                }
                // Only the tunnel is rebuilt; a repeat failure reaches the deadline, which
                // replaces the daemon.
                kill_and_reap(child).await;
                publish_issue(
                    &self.watchdog,
                    attempt_generation,
                    "Agent connection went stale".to_string(),
                );
                RunningCommandAction::Finish(CommandAction::Continue)
            }
            Some(SupervisorCommand::Start) => RunningCommandAction::Continue,
            Some(
                command
                @ (SupervisorCommand::Connected { .. } | SupervisorCommand::Disconnected(_)),
            ) => {
                self.apply_socket_event(command);
                *connected = self.watchdog.snapshot().socket_id.is_some();
                RunningCommandAction::Continue
            }
            command => {
                kill_and_reap(child).await;
                self.handle_pre_session_command(command)
            }
        }
    }

    /// Waits through restart backoff while allowing shutdown to win immediately.
    async fn wait_for_restart(&mut self, backoff: Duration) -> CommandAction {
        let delay = tokio::time::sleep(backoff);
        tokio::pin!(delay);
        loop {
            tokio::select! {
                _ = &mut delay => return CommandAction::Continue,
                command = self.commands.recv() => {
                    match self.handle_pre_session_command(command) {
                        RunningCommandAction::Continue => {}
                        RunningCommandAction::Finish(action) => return action,
                    }
                }
            }
        }
    }

    /// Parks a desired-running device whose start needs an operator (a locked SSH key) until
    /// a Start or Retry arrives, while shutdown and removal still win at once.
    async fn wait_for_start(&mut self) -> CommandAction {
        loop {
            let command = self.commands.recv().await;
            if matches!(command, Some(SupervisorCommand::Start)) {
                return CommandAction::Restart;
            }
            match self.handle_pre_session_command(command) {
                RunningCommandAction::Continue => {}
                RunningCommandAction::Finish(action) => return action,
            }
        }
    }

    /// Runs `stop` until it succeeds, retrying on the backoff with the failure shown, while a
    /// Start, Retry, Remove or Detach still wins at once.
    ///
    /// Kept in memory only: after a server restart, the orphan limit ends a daemon whose stop
    /// never reached its device.
    async fn run_stop(&mut self, mut stop: RemoteJob) -> StopEnd {
        let mut backoff = Backoff::default();
        loop {
            let attempt = stop();
            tokio::pin!(attempt);
            let result = loop {
                tokio::select! {
                    result = &mut attempt => break result,
                    command = self.commands.recv() => {
                        match self.handle_stop_command(command, &mut stop) {
                            StopStep::Continue => {}
                            StopStep::End(end) => return end,
                        }
                    }
                }
            };
            match result {
                Ok(()) => {
                    self.watchdog.set_daemon_may_run(false);
                    publish_stopped(&self.watchdog);
                    return StopEnd::Idle;
                }
                Err(error) => {
                    log!(
                        Level::Warning,
                        "Stopping the managed agent's daemon failed; retrying: key={}, error={}",
                        self.key,
                        error
                    );
                    publish_stopping_issue(&self.watchdog, error);
                }
            }
            let delay = tokio::time::sleep(backoff.next_delay());
            tokio::pin!(delay);
            loop {
                tokio::select! {
                    _ = &mut delay => break,
                    command = self.commands.recv() => {
                        match self.handle_stop_command(command, &mut stop) {
                            StopStep::Continue => {}
                            StopStep::End(end) => return end,
                        }
                    }
                }
            }
        }
    }

    /// Applies one command while a stop is pending.
    fn handle_stop_command(
        &mut self,
        command: Option<SupervisorCommand>,
        stop: &mut RemoteJob,
    ) -> StopStep {
        match command {
            Some(SupervisorCommand::Start) => StopStep::End(StopEnd::Start),
            Some(SupervisorCommand::Retry { reply }) => {
                publish_fresh_start(&self.watchdog);
                let _ = reply.send(());
                StopStep::End(StopEnd::Start)
            }
            Some(SupervisorCommand::Shutdown {
                reply,
                stop: replacement,
            }) => {
                if let Some(replacement) = replacement {
                    *stop = replacement;
                }
                let _ = reply.send(());
                StopStep::Continue
            }
            Some(SupervisorCommand::Restart { reply }) => {
                let _ = reply.send(());
                StopStep::Continue
            }
            Some(SupervisorCommand::Detach { reply }) => {
                let _ = reply.send(());
                StopStep::End(StopEnd::Exit)
            }
            Some(SupervisorCommand::Remove) | None => {
                publish_stopped(&self.watchdog);
                StopStep::End(StopEnd::Exit)
            }
            Some(SupervisorCommand::Connected { .. })
            | Some(SupervisorCommand::Disconnected(_))
            | Some(SupervisorCommand::Stale(_)) => StopStep::Continue,
        }
    }
}

/// What a command does to a pending stop.
enum StopStep {
    /// Keep stopping.
    Continue,
    /// Leave the stop with this result.
    End(StopEnd),
}

/// How a pending stop ended.
enum StopEnd {
    /// The daemon is stopped; wait for the next start.
    Idle,
    /// The device was started again, which wins over the stop.
    Start,
    /// The supervisor was removed or detached.
    Exit,
}

/// Publishes why an attempt produced no session; the supervisor retries after backoff,
/// unless retrying cannot help (a locked SSH key). The agent then stays desired-running with
/// the issue shown and waits for the Start that unlocks the key, instead of stopping and
/// making the operator notice that it needs to be started again.
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
    publish_issue(watchdog, attempt_generation, issue);
    CycleResult {
        // A shutdown or retry queued meanwhile still wins: the wait handles it first.
        action: if retryable {
            CommandAction::Continue
        } else {
            CommandAction::WaitForStart
        },
        was_connected: false,
    }
}

/// Clears the current socket when `socket_id` is it, so late events of replaced sockets
/// change nothing. Returns whether the current connection ended.
fn publish_disconnected(watchdog: &WatchdogHandle, socket_id: &SocketId) -> bool {
    if watchdog.snapshot().socket_id.as_ref() != Some(socket_id) {
        return false;
    }
    watchdog.publish_update(|snapshot| {
        snapshot.socket_id = None;
        if snapshot.desired_running {
            snapshot.status = AgentConnectionStatus::Starting;
        }
    });
    true
}

/// Settles a stop: `Stopping` while a stop job still has to run, `Stopped` otherwise.
fn publish_stop_requested(watchdog: &WatchdogHandle, stopping: bool) {
    if stopping {
        publish_stopping(watchdog);
    } else {
        publish_stopped(watchdog);
    }
}

/// The device is stopped and nothing is pending.
fn publish_stopped(watchdog: &WatchdogHandle) {
    watchdog.publish_update(|snapshot| {
        snapshot.desired_running = false;
        snapshot.status = AgentConnectionStatus::Stopped;
        snapshot.connection_issue = None;
        snapshot.socket_id = None;
    });
}

/// The session is gone and the daemon is being stopped on the device.
fn publish_stopping(watchdog: &WatchdogHandle) {
    watchdog.publish_update(|snapshot| {
        snapshot.desired_running = false;
        snapshot.status = AgentConnectionStatus::Stopping;
        snapshot.connection_issue = None;
        snapshot.socket_id = None;
    });
}

/// Shows why the pending stop failed while it is retried.
fn publish_stopping_issue(watchdog: &WatchdogHandle, issue: String) {
    watchdog.publish_update(|snapshot| {
        if snapshot.status == AgentConnectionStatus::Stopping {
            snapshot.connection_issue = Some(issue);
        }
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
        if snapshot.socket_id.is_none() {
            snapshot.status = AgentConnectionStatus::Starting;
        }
        snapshot.connection_issue = Some(issue);
    });
}

/// The rest of an exited session's output: its stdout after the report, which ends with the
/// holder's end line, and its stderr (SSH's own errors).
#[derive(Debug, Default, PartialEq, Eq)]
struct SessionOutput {
    /// Bounded tail of stdout.
    stdout: Vec<u8>,
    /// Bounded tail of stderr.
    stderr: Vec<u8>,
}

/// Starts draining the session's output so its diagnostic is available after exit.
fn spawn_output_reader(
    child: &mut Child,
) -> Option<tokio::task::JoinHandle<std::io::Result<SessionOutput>>> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if stdout.is_none() && stderr.is_none() {
        return None;
    }
    Some(tokio::spawn(async move {
        let read_stdout = async {
            match stdout {
                Some(stdout) => {
                    redoor_core::bounded_tail::read_bounded_tail(stdout, MAX_EXIT_DIAGNOSTIC_BYTES)
                        .await
                }
                None => Ok(Vec::new()),
            }
        };
        let read_stderr = async {
            match stderr {
                Some(stderr) => {
                    redoor_core::bounded_tail::read_bounded_tail(stderr, MAX_EXIT_DIAGNOSTIC_BYTES)
                        .await
                }
                None => Ok(Vec::new()),
            }
        };
        let (stdout, stderr) = tokio::join!(read_stdout, read_stderr);
        Ok(SessionOutput {
            stdout: stdout?,
            stderr: stderr?,
        })
    }))
}

/// Explains why a session ended: the daemon's log when it died, otherwise the session's own
/// exit status and stderr.
fn format_exit_issue(
    status: std::io::Result<std::process::ExitStatus>,
    process_name: &str,
    output: Option<&SessionOutput>,
) -> String {
    let end = output.and_then(|output| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<HolderEnd>(line).ok())
    });
    if let Some(HolderEnd::DaemonExited { log_tail }) = end {
        let log_tail = sanitize_diagnostic_output(log_tail.as_bytes());
        let log_tail = log_tail.trim();
        if log_tail.is_empty() {
            return "The agent daemon exited".to_string();
        }
        return format!("The agent daemon exited. End of its log:\n{log_tail}");
    }
    let mut issue = match status {
        Ok(status) => match status.code() {
            Some(code) => format!("{process_name} exited with status code {code}"),
            None => format!("{process_name} exited with {status}"),
        },
        Err(error) => format!("Failed to wait for {process_name}: {error}"),
    };
    let stderr = output
        .map(|output| sanitize_diagnostic_output(&output.stderr))
        .unwrap_or_default();
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        issue.push_str(&format!("\n{process_name} output:\n{stderr}"));
    }
    issue
}

/// Resolves a completed output reader without replacing the process status on read failure.
///
/// The read waits for EOF, which a surviving grandchild holding the pipe can postpone
/// indefinitely, so it is bounded by `timeout`. The reader is left running rather than
/// aborted, which keeps the pipe drained so that process never blocks on a full pipe.
async fn read_child_diagnostic(
    reader: Option<tokio::task::JoinHandle<std::io::Result<SessionOutput>>>,
    timeout: Duration,
) -> Option<SessionOutput> {
    let mut reader = reader?;
    match tokio::time::timeout(timeout, &mut reader).await {
        Ok(Ok(Ok(output))) => Some(output),
        Ok(Ok(Err(error))) => Some(SessionOutput {
            stdout: Vec::new(),
            stderr: format!("Failed to read process output: {error}").into_bytes(),
        }),
        Ok(Err(error)) => Some(SessionOutput {
            stdout: Vec::new(),
            stderr: format!("Process output task failed: {error}").into_bytes(),
        }),
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
pub(crate) fn sanitize_diagnostic_output(output: &[u8]) -> String {
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

/// Terminates and reaps the session process; this only drops the session, never the daemon.
async fn kill_and_reap(child: &mut Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
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

    /// Ignores supersede requests in tests that do not check them.
    fn no_supersede() -> SupersedeCallback {
        Arc::new(|_| {})
    }

    /// Registers a supervisor with the no-op callbacks.
    fn supervise(key: &str, spawn: SpawnFn, registry: &WatchdogRegistry) -> SupervisorGuard {
        SupervisorGuard(
            spawn_supervisor(key.into(), spawn, registry, callback(), no_supersede())
                .expect("register"),
        )
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

    /// The daemon every test session reports.
    fn reported_daemon() -> DaemonReport {
        DaemonReport {
            outcome: EnsureOutcome::Started,
            pid: 1,
            binary: redoor_core::identity::current_binary_identity(),
            spec_hash: "spec".to_string(),
        }
    }

    /// What the reported daemon announces in its `hello`.
    fn reported_hello() -> ConnectingDaemon {
        ConnectingDaemon {
            binary: redoor_core::identity::current_binary_identity(),
            spec_hash: Some("spec".to_string()),
        }
    }

    /// A `hello` of another build than the reported daemon.
    fn other_hello() -> ConnectingDaemon {
        ConnectingDaemon {
            binary: BinaryIdentity {
                git_rev: "0000000".to_string(),
                ..redoor_core::identity::current_binary_identity()
            },
            spec_hash: Some("spec".to_string()),
        }
    }

    /// Wraps `child` as a session whose ensure step reported [`reported_daemon`].
    fn session(child: std::io::Result<Child>) -> SpawnResult {
        Ok(ManagedSession {
            child: child.map_err(SpawnError::Spawn)?,
            daemon: reported_daemon(),
        })
    }

    /// Spawns a long-running session that keeps running until the supervisor kills it.
    fn idle_session() -> SpawnResult {
        session(
            Command::new("sh")
                .arg("-c")
                .arg("cat")
                .kill_on_drop(true)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn(),
        )
    }

    /// Accepts the reported daemon's `hello` and returns its attempt.
    async fn connect(handle: &WatchdogHandle, socket: &SocketId) -> Option<u64> {
        match handle
            .mark_connected(socket.clone(), reported_hello())
            .await
        {
            ConnectVerdict::Accepted(generation) => Some(generation),
            _ => None,
        }
    }

    /// A spawn closure counting its calls and recording each cycle's flags.
    #[derive(Clone, Default)]
    struct Recorder {
        count: Arc<AtomicUsize>,
        requests: Arc<Mutex<Vec<(bool, bool)>>>,
    }

    impl Recorder {
        /// A spawn function that records and then runs an idle session.
        fn spawn(&self) -> SpawnFn {
            let recorder = self.clone();
            SpawnFn::new(move |request| {
                recorder.count.fetch_add(1, Ordering::SeqCst);
                recorder
                    .requests
                    .lock()
                    .unwrap()
                    .push((request.replace, request.server_connected));
                async { idle_session() }
            })
        }

        /// How many cycles ran.
        fn count(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }

        /// `(replace, server_connected)` of every cycle.
        fn requests(&self) -> Vec<(bool, bool)> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[tokio::test]
    async fn remove_stopped_is_idempotent_and_exits_a_dormant_supervisor() {
        let registry = WatchdogRegistry::new();
        let _guard = supervise("removed", Recorder::default().spawn(), &registry);

        // The first removal must drop the handle so replacement can register the same key.
        registry
            .remove_stopped("removed", None)
            .expect("first remove");
        assert!(registry.lookup("removed").is_none());
        // A retry after a partial persist-then-remove must not fail just because the handle is gone.
        registry
            .remove_stopped("removed", None)
            .expect("retry remove");
    }

    /// Deleting a device cleans it up in the background after its supervisor is gone, so an
    /// unreachable device cannot block the delete.
    #[tokio::test]
    async fn removal_runs_its_cleanup_job_after_the_supervisor_is_gone() {
        let registry = WatchdogRegistry::new();
        let _guard = supervise("cleaned", Recorder::default().spawn(), &registry);
        let ran = Arc::new(tokio::sync::Notify::new());
        let notify = ran.clone();
        let cleanup: RemoteJob = Arc::new(move || {
            let notify = notify.clone();
            Box::pin(async move {
                notify.notify_one();
                Ok(())
            })
        });

        registry
            .remove_stopped("cleaned", Some(cleanup))
            .expect("remove");
        // The handle is gone at once, before the device answered.
        assert!(registry.lookup("cleaned").is_none());
        // The namespace cleanup still runs.
        tokio::time::timeout(Duration::from_secs(5), ran.notified())
            .await
            .expect("cleanup job should run");
    }

    #[tokio::test]
    async fn supervisor_is_dormant_until_started_and_start_is_idempotent() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("lazy", recorder.spawn(), &registry);
        let handle = registry.lookup("lazy").expect("managed handle");

        // Registration must not eagerly invoke the process factory.
        assert_eq!(recorder.count(), 0);
        // The initial public state makes the dormant agent visible to clients.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);

        handle.start().await.expect("first start accepted");
        handle.start().await.expect("duplicate start accepted");
        wait_until(|| recorder.count() == 1).await;
        // Duplicate UI/direct-route requests must not create concurrent sessions.
        assert_eq!(recorder.count(), 1);

        handle.shutdown(None).await.expect("shutdown acknowledged");
        // Acknowledgement guarantees the supervisor has settled intentionally stopped.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
    }

    /// A Start made for a signed-in user runs that cycle's spawn as the user, so its
    /// provisioning logs name them, and the user is used up so automatic reconnects log
    /// without one.
    #[tokio::test]
    async fn started_cycle_spawns_as_the_requesting_user() {
        let (seen_tx, mut seen) = mpsc::unbounded_channel();
        let spawn = SpawnFn::new(move |_request| {
            let seen_tx = seen_tx.clone();
            async move {
                let _ = seen_tx.send(redoor_core::logging::current_user());
                std::future::pending::<SpawnResult>().await
            }
        });
        let registry = WatchdogRegistry::new();
        let _guard = supervise("attributed", spawn, &registry);
        let handle = registry.lookup("attributed").expect("managed handle");

        redoor_core::logging::user_scope(Some(Arc::from("alice (password)")), handle.start())
            .await
            .expect("start accepted");
        // The spawn of the requested cycle runs as the user who pressed Start.
        assert_eq!(
            seen.recv().await.expect("spawned").as_deref(),
            Some("alice (password)")
        );
        // The cycle took the user, so a later automatic cycle has none to log with.
        assert!(handle.take_requester().is_none());
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    #[tokio::test]
    async fn shutdown_revokes_registration_and_interrupts_pending_spawn() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawn = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "pending",
            SpawnFn::new(move |_request| {
                let observed_spawn = observed_spawn.clone();
                async move {
                    observed_spawn.fetch_add(1, Ordering::SeqCst);
                    std::future::pending::<SpawnResult>().await
                }
            }),
            &registry,
        );
        let handle = registry.lookup("pending").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;

        let shutdown_handle = handle.clone();
        let shutdown = tokio::spawn(async move { shutdown_handle.shutdown(None).await });
        wait_until(|| !handle.snapshot().desired_running).await;
        // Once shutdown intent wins, a socket parsed earlier cannot register late.
        assert_eq!(
            handle
                .mark_connected(SocketId::new(), reported_hello())
                .await,
            ConnectVerdict::Stopped
        );
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
        let _guard = supervise(
            "retry-pending",
            SpawnFn::new(move |request| {
                let observed_spawns = observed_spawns.clone();
                async move {
                    let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst) + 1;
                    request.status.report(format!("attempt-{attempt}"));
                    std::future::pending::<SpawnResult>().await
                }
            }),
            &registry,
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
        let canceled_generation = connect(&handle, &late_socket)
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
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retry_reaps_owned_session_before_acknowledging_replacement() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let first_pid = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let observed_pid = first_pid.clone();
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "retry-child",
            SpawnFn::new(move |_request| {
                let observed_spawns = observed_spawns.clone();
                let observed_pid = observed_pid.clone();
                async move {
                    let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst);
                    let session = idle_session()?;
                    if attempt == 0 {
                        observed_pid
                            .store(session.child.id().unwrap_or(0) as usize, Ordering::SeqCst);
                    }
                    Ok(session)
                }
            }),
            &registry,
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
        // Retry acknowledgement is a cleanup barrier, so the original session cannot remain.
        assert!(!status.success());
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 2).await;
        // Exactly one replacement proves retry did not change ordinary duplicate-start behavior.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 2);
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    #[tokio::test]
    async fn spawn_errors_are_visible_and_shutdown_interrupts_backoff() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "broken",
            SpawnFn::new(move |_request| {
                let observed_spawns = observed_spawns.clone();
                async move {
                    observed_spawns.fetch_add(1, Ordering::SeqCst);
                    Err(SpawnError::Spawn(std::io::Error::other(
                        "missing executable",
                    )))
                }
            }),
            &registry,
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
        handle.shutdown(None).await.expect("backoff interrupted");
        // Shutdown must win over a pending retry timer.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
        // Acknowledgement cancels the failed attempt instead of letting its backoff respawn it.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
    }

    /// Moves the paused clock forward in small steps until `predicate` holds, so timers
    /// fire without the test waiting in real time. Returns whether it held.
    async fn advance_until(limit: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let step = Duration::from_millis(250);
        let mut advanced = Duration::ZERO;
        while !predicate() {
            if advanced >= limit {
                return false;
            }
            tokio::time::advance(step).await;
            advanced += step;
            // Lets the supervisor and the process driver run between clock steps.
            for _ in 0..100 {
                tokio::task::yield_now().await;
            }
        }
        true
    }

    /// A locked SSH key cannot be unlocked by retrying, but the agent must not drop out of
    /// desired-running either: it waits for the Start that hands the key over.
    #[tokio::test(start_paused = true)]
    async fn locked_key_waits_for_the_next_start_instead_of_stopping() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let observed_spawns = spawn_count.clone();
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "locked",
            SpawnFn::new(move |_request| {
                let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst) + 1;
                async move {
                    if attempt == 1 {
                        Err(SpawnError::Provision(
                            crate::ssh::ProvisionError::SshKeyLocked("key locked".into()),
                        ))
                    } else {
                        idle_session()
                    }
                }
            }),
            &registry,
        );
        let handle = registry.lookup("locked").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;

        // The operator sees why the agent is not coming up ...
        assert_eq!(
            handle.snapshot().connection_issue.as_deref(),
            Some("key locked")
        );
        // ... while the agent stays wanted, so unlocking needs no second Start decision.
        assert!(handle.snapshot().desired_running);
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Starting);
        // Retrying on a timer cannot unlock the key, so no attempt is made without a Start.
        assert!(
            !advance_until(Duration::from_secs(120), || {
                spawn_count.load(Ordering::SeqCst) > 1
            })
            .await
        );

        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 2).await;
        // The Start of an already desired-running agent wakes the waiting supervisor.
        assert_eq!(spawn_count.load(Ordering::SeqCst), 2);
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A live session is no proof the daemon will connect again; one without a connection
    /// for the deadline, after its start or after its socket closed, is dropped and the next
    /// cycle replaces the daemon.
    #[tokio::test(start_paused = true)]
    async fn session_without_a_connection_replaces_the_daemon_after_the_deadline() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("unconnected", recorder.spawn(), &registry);
        let handle = registry.lookup("unconnected").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;

        // A daemon that never connects is replaced once the deadline passes.
        assert!(advance_until(CONNECTION_DEADLINE * 2, || recorder.count() == 2).await);
        // The replacement is explained to the operator.
        assert!(
            handle
                .snapshot()
                .connection_issue
                .is_some_and(|issue| issue.contains("had no connection"))
        );
        // The first cycle keeps a matching daemon; the next one asks for its replacement.
        assert_eq!(recorder.requests(), [(false, false), (true, false)]);

        let socket = SocketId::new();
        assert!(connect(&handle, &socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&socket)).await;
        // A connected daemon is left alone however long it runs.
        assert!(!advance_until(CONNECTION_DEADLINE * 2, || recorder.count() > 2).await);

        handle.mark_disconnected(socket);
        // After a clean close the daemon gets the deadline again to reconnect.
        assert!(advance_until(CONNECTION_DEADLINE * 2, || recorder.count() == 3).await);
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A daemon can register before its ensure step finishes (an SSH forward exists before
    /// the report); that connection must count, or the deadline replaces a healthy daemon.
    #[tokio::test(start_paused = true)]
    async fn registration_during_spawn_counts_against_the_deadline() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let observed_spawns = spawn_count.clone();
        let spawn_release = release.clone();
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "early-registration",
            SpawnFn::new(move |_request| {
                observed_spawns.fetch_add(1, Ordering::SeqCst);
                let release = spawn_release.clone();
                async move {
                    release.notified().await;
                    idle_session()
                }
            }),
            &registry,
        );
        let handle = registry
            .lookup("early-registration")
            .expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;

        let socket = SocketId::new();
        assert!(connect(&handle, &socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&socket)).await;
        release.notify_one();

        // The healthy daemon outlives the deadline instead of being replaced.
        assert!(
            !advance_until(CONNECTION_DEADLINE * 2, || {
                spawn_count.load(Ordering::SeqCst) > 1
            })
            .await
        );
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A socket that registered and closed again before the ensure step finished is no
    /// connection; the daemon still gets replaced after the deadline.
    #[tokio::test(start_paused = true)]
    async fn socket_closed_during_spawn_does_not_count_as_connected() {
        let spawn_count = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let observed_spawns = spawn_count.clone();
        let spawn_release = release.clone();
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "early-disconnect",
            SpawnFn::new(move |_request| {
                let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst) + 1;
                let release = spawn_release.clone();
                async move {
                    if attempt == 1 {
                        release.notified().await;
                    }
                    idle_session()
                }
            }),
            &registry,
        );
        let handle = registry.lookup("early-disconnect").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| spawn_count.load(Ordering::SeqCst) == 1).await;

        let socket = SocketId::new();
        assert!(connect(&handle, &socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&socket)).await;
        handle.mark_disconnected(socket);
        // The closed socket is forgotten even though no session is being watched yet.
        assert!(
            advance_until(Duration::from_secs(1), || handle
                .snapshot()
                .socket_id
                .is_none())
            .await
        );
        release.notify_one();

        // The closed socket does not keep the deadline off, so the daemon is replaced.
        assert!(
            advance_until(CONNECTION_DEADLINE * 2, || {
                spawn_count.load(Ordering::SeqCst) == 2
            })
            .await
        );
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A session ended by its dead daemon explains the exit with the end of the daemon's log,
    /// which the holder printed as its last line.
    #[tokio::test]
    async fn daemon_exit_is_explained_with_its_log_tail() {
        let registry = WatchdogRegistry::new();
        let spawn = SpawnFn::new(|_request| async {
            session(
                Command::new("sh")
                    .arg("-c")
                    .arg(r#"echo '{"ended":"daemon_exited","log_tail":"invalid home: /missing"}'; exit 1"#)
                    .kill_on_drop(true)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn(),
            )
        });
        let _guard = supervise("log-diagnostic", spawn, &registry);
        let handle = registry.lookup("log-diagnostic").expect("managed handle");

        handle.start().await.expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;
        let issue = handle
            .snapshot()
            .connection_issue
            .expect("a dead daemon should publish its log");
        handle.shutdown(None).await.expect("backoff interrupted");

        // The browser-facing issue must expose the daemon's own error.
        assert!(issue.contains("invalid home: /missing"), "{issue}");
        // It must say that the daemon died, not that some process exited with a status.
        assert!(issue.contains("agent daemon exited"), "{issue}");
    }

    #[tokio::test]
    async fn piped_ssh_stderr_is_visible_in_connection_issue() {
        let registry = WatchdogRegistry::new();
        let spawn = SpawnFn::new(|_request| async {
            session(
                Command::new("sh")
                    .arg("-c")
                    .arg("printf 'Error: remote port forwarding failed for listen path /tmp/x.sock\\n' >&2; exit 255")
                    .kill_on_drop(true)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn(),
            )
        })
        .with_process_name("SSH process");
        let _guard = supervise("ssh-diagnostic", spawn, &registry);
        let handle = registry.lookup("ssh-diagnostic").expect("managed handle");

        handle.start().await.expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;
        let issue = handle
            .snapshot()
            .connection_issue
            .expect("failed SSH child should publish its stderr");

        // Naming the actual child avoids implying that the remote agent returned 255.
        assert!(issue.contains("SSH process exited with status code 255"));
        // OpenSSH's reason must reach the UI instead of collapsing into a bare exit status.
        assert!(issue.contains("remote port forwarding failed for listen path"));
        handle.shutdown(None).await.expect("backoff interrupted");
    }

    #[tokio::test]
    async fn connection_generation_clears_issue_and_ignores_stale_disconnect() {
        let registry = WatchdogRegistry::new();
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let callback_snapshots = snapshots.clone();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "generation".into(),
                SpawnFn::new(|_request| async { idle_session() }),
                &registry,
                Arc::new(move |snapshot| {
                    callback_snapshots
                        .lock()
                        .expect("snapshot history poisoned")
                        .push(snapshot);
                }),
                no_supersede(),
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
        assert!(connect(&handle, &old_socket).await.is_some());
        assert!(connect(&handle, &new_socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&new_socket)).await;
        handle.mark_disconnected(old_socket);
        assert!(connect(&handle, &fence_socket).await.is_some());
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
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A stale socket only drops the session (the tunnel); the next cycle keeps the daemon,
    /// and only a repeated failure reaches the deadline, which replaces it.
    #[tokio::test]
    async fn stale_signal_drops_only_the_session_of_the_current_socket() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("stale-generation", recorder.spawn(), &registry);
        let handle = registry.lookup("stale-generation").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;
        let old_socket = SocketId::new();
        let replacement_socket = SocketId::new();
        let fence_socket = SocketId::new();
        // Managed registrations must be accepted while the supervisor is desired-running.
        assert!(connect(&handle, &old_socket).await.is_some());
        // A replacement registration must supersede the old socket generation.
        assert!(connect(&handle, &replacement_socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&replacement_socket)).await;

        handle.signal_stale(old_socket);
        // This connection acts as a queue fence after the stale event without pre-checking state.
        assert!(connect(&handle, &fence_socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.as_ref() == Some(&fence_socket)).await;

        // The replaced socket's late stale event must not end the healthy session.
        assert_eq!(recorder.count(), 1);
        // Ignoring an old generation must not publish a misleading lifecycle issue.
        assert_eq!(handle.snapshot().connection_issue, None);

        handle.signal_stale(fence_socket.clone());
        handle.mark_disconnected(fence_socket);
        wait_until(|| recorder.count() == 2).await;
        // The new cycle rebuilds the tunnel to the same daemon instead of replacing it.
        assert!(!recorder.requests()[1].0);
        handle.shutdown(None).await.expect("shutdown acknowledged");
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
        let _guard = supervise(
            "status",
            SpawnFn::new(move |request| {
                let wait_first = wait_first.clone();
                let hold_first = hold_first.clone();
                let observed_spawns = observed_spawns.clone();
                async move {
                    let attempt = observed_spawns.fetch_add(1, Ordering::SeqCst);
                    request.status.report(format!("step-{attempt}"));
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
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A Restart of a managed device replaces the daemon in a new cycle at once, and a
    /// Restart of a stopped device is refused.
    #[tokio::test]
    async fn restart_replaces_the_daemon_without_backoff() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("restarted", recorder.spawn(), &registry);
        let handle = registry.lookup("restarted").expect("managed handle");

        // A stopped device has no daemon to replace.
        assert!(matches!(
            handle.restart().await,
            Err(WatchdogError::NotRunning)
        ));
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;
        handle.restart().await.expect("restart accepted");
        wait_until(|| recorder.count() == 2).await;

        // Only the restarted cycle asks the ensure step to replace a matching daemon.
        assert_eq!(recorder.requests(), [(false, false), (true, false)]);
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// The ensure step learns whether the server still has a socket, so a kept daemon is only
    /// woken when it has none.
    #[tokio::test]
    async fn cycle_reports_whether_the_server_is_connected() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("connected-flag", recorder.spawn(), &registry);
        let handle = registry.lookup("connected-flag").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;
        let socket = SocketId::new();
        assert!(connect(&handle, &socket).await.is_some());
        wait_until(|| handle.snapshot().socket_id.is_some()).await;

        handle.restart().await.expect("restart accepted");
        wait_until(|| recorder.count() == 2).await;

        // A local daemon's connection does not depend on the session, so it survives the
        // session's replacement and the next ensure step knows about it.
        assert_eq!(recorder.requests()[1], (true, true));
        // The device stays connected while its session is replaced.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Connected);
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A server going away drops the sessions but leaves the devices' state alone: the
    /// daemons keep running and the next server process takes over.
    #[tokio::test]
    async fn detach_leaves_the_device_state_alone() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("detached", recorder.spawn(), &registry);
        let handle = registry.lookup("detached").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;
        let before = handle.snapshot();

        registry.detach_all().await;

        // Nothing was stopped, so no Stopped state reaches the router, which would evict
        // the daemon.
        assert_eq!(handle.snapshot(), before);
        assert!(handle.snapshot().desired_running);
    }

    /// A stop job runs after the acknowledgement, shows `Stopping` with its failure while it
    /// is retried, and settles `Stopped` once it succeeds.
    #[tokio::test(start_paused = true)]
    async fn stop_job_is_retried_until_it_succeeds() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("stopping", recorder.spawn(), &registry);
        let handle = registry.lookup("stopping").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = attempts.clone();
        let stop: RemoteJob = Arc::new(move || {
            let attempt = counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if attempt == 0 {
                    Err("device unreachable".to_string())
                } else {
                    Ok(())
                }
            })
        });

        handle
            .shutdown(Some(stop))
            .await
            .expect("shutdown acknowledged");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;
        // The failure is shown while the stop is still pending.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopping);
        assert_eq!(
            handle.snapshot().connection_issue.as_deref(),
            Some("device unreachable")
        );
        assert!(
            advance_until(Duration::from_secs(5), || handle.snapshot().status
                == AgentConnectionStatus::Stopped)
            .await
        );
        // The retry succeeded and nothing started again.
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(recorder.count(), 1);
    }

    /// A device that never got a daemon (its start failed) stops at once, without reaching
    /// out to a device that may not even be reachable.
    #[tokio::test]
    async fn stop_without_a_daemon_skips_the_device() {
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "never-started",
            SpawnFn::new(|_request| async {
                Err(SpawnError::Spawn(std::io::Error::other("wrong password")))
            }),
            &registry,
        );
        let handle = registry.lookup("never-started").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| handle.snapshot().connection_issue.is_some()).await;
        let ran = Arc::new(AtomicUsize::new(0));
        let counted = ran.clone();
        let stop: RemoteJob = Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        });

        handle
            .shutdown(Some(stop))
            .await
            .expect("shutdown acknowledged");

        // No daemon can run, so the device is stopped right away.
        assert_eq!(handle.snapshot().status, AgentConnectionStatus::Stopped);
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    /// A Stop while the ensure step runs after it sent the payload still stops the device:
    /// the step may have started a daemon whose report never arrived.
    #[tokio::test]
    async fn stop_after_the_payload_was_sent_reaches_the_device() {
        let (sent_tx, sent) = tokio::sync::oneshot::channel();
        let sent_tx = Arc::new(Mutex::new(Some(sent_tx)));
        let registry = WatchdogRegistry::new();
        let _guard = supervise(
            "payload-sent",
            SpawnFn::new(move |request| {
                let sent_tx = sent_tx.clone();
                async move {
                    request.daemon_may_run.mark();
                    if let Some(sent_tx) = sent_tx.lock().unwrap().take() {
                        let _ = sent_tx.send(());
                    }
                    std::future::pending::<SpawnResult>().await
                }
            }),
            &registry,
        );
        let handle = registry.lookup("payload-sent").expect("managed handle");
        handle.start().await.expect("start accepted");
        sent.await.expect("payload sent");
        let ran = Arc::new(tokio::sync::Notify::new());
        let notify = ran.clone();
        let stop: RemoteJob = Arc::new(move || {
            notify.notify_one();
            Box::pin(async { Ok(()) })
        });

        handle
            .shutdown(Some(stop))
            .await
            .expect("shutdown acknowledged");

        // The device stop runs although no report ever arrived.
        tokio::time::timeout(Duration::from_secs(5), ran.notified())
            .await
            .expect("the device stop should run");
    }

    /// A Start while a stop is pending wins: the device runs again.
    #[tokio::test]
    async fn start_wins_over_a_pending_stop() {
        let recorder = Recorder::default();
        let registry = WatchdogRegistry::new();
        let _guard = supervise("restarting", recorder.spawn(), &registry);
        let handle = registry.lookup("restarting").expect("managed handle");
        handle.start().await.expect("start accepted");
        wait_until(|| recorder.count() == 1).await;
        let stop: RemoteJob = Arc::new(|| Box::pin(std::future::pending()));

        handle
            .shutdown(Some(stop))
            .await
            .expect("shutdown acknowledged");
        wait_until(|| handle.snapshot().status == AgentConnectionStatus::Stopping).await;
        handle.start().await.expect("start accepted");

        // The start is not stuck behind a stop that never finishes.
        wait_until(|| recorder.count() == 2).await;
        assert!(handle.snapshot().desired_running);
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A `hello` after the report is checked at once: another build is superseded.
    #[tokio::test]
    async fn hello_after_the_report_must_match_it() {
        let registry = WatchdogRegistry::new();
        let reported = Arc::new(tokio::sync::Notify::new());
        let notify = reported.clone();
        let _guard = supervise(
            "checked",
            SpawnFn::new(move |_request| {
                let notify = notify.clone();
                async move {
                    let session = idle_session();
                    notify.notify_one();
                    session
                }
            }),
            &registry,
        );
        let handle = registry.lookup("checked").expect("managed handle");
        handle.start().await.expect("start accepted");
        reported.notified().await;
        wait_until(|| handle.expected().is_some()).await;

        // A daemon of another build is not the one the ensure step reported.
        assert_eq!(
            handle.mark_connected(SocketId::new(), other_hello()).await,
            ConnectVerdict::Superseded
        );
        // The reported daemon is accepted.
        assert!(connect(&handle, &SocketId::new()).await.is_some());
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A `hello` before the report is accepted provisionally and superseded when the report
    /// describes another daemon.
    #[tokio::test]
    async fn provisional_hello_is_superseded_by_a_mismatching_report() {
        let registry = WatchdogRegistry::new();
        let release = Arc::new(tokio::sync::Notify::new());
        let spawn_release = release.clone();
        let (superseded_tx, mut superseded) = mpsc::unbounded_channel();
        let _guard = SupervisorGuard(
            spawn_supervisor(
                "provisional".into(),
                SpawnFn::new(move |_request| {
                    let release = spawn_release.clone();
                    async move {
                        release.notified().await;
                        idle_session()
                    }
                }),
                &registry,
                callback(),
                Arc::new(move |socket| {
                    let _ = superseded_tx.send(socket);
                }),
            )
            .expect("register"),
        );
        let handle = registry.lookup("provisional").expect("managed handle");
        handle.start().await.expect("start accepted");
        let socket = SocketId::new();

        let verdict = handle.mark_connected(socket.clone(), other_hello()).await;
        // Without a report the daemon cannot be judged yet, so it is not refused.
        assert!(matches!(verdict, ConnectVerdict::Accepted(_)));
        wait_until(|| handle.snapshot().socket_id.is_some()).await;
        release.notify_one();

        // The report names another build, so the provisional connection is ended.
        assert_eq!(superseded.recv().await, Some(socket));
        handle.shutdown(None).await.expect("shutdown acknowledged");
    }

    /// A freshly started server starts no device, but adopts a daemon that reconnects on its
    /// own, so a local daemon keeps its shells across a server restart. A device stopped in
    /// this server process refuses its daemon instead, so a Stop is never undone.
    #[tokio::test]
    async fn adopts_a_reconnecting_daemon_only_when_untouched() {
        let registry = WatchdogRegistry::new();
        let recorder = Recorder::default();
        let _adopted = supervise("dev_adopted", recorder.spawn(), &registry);
        let _stopped = supervise("dev_stopped", Recorder::default().spawn(), &registry);
        let adopted = registry.lookup("dev_adopted").unwrap();
        let stopped = registry.lookup("dev_stopped").unwrap();

        // Registration alone starts nothing, so an SSH device waits for the user's Start.
        assert!(!adopted.snapshot().desired_running);
        assert_eq!(recorder.count(), 0);

        let verdict = adopted
            .mark_connected(SocketId::new(), reported_hello())
            .await;
        // The daemon that reconnected by itself is accepted and its device runs again, with
        // a cycle that checks the daemon like any start.
        assert!(matches!(verdict, ConnectVerdict::Accepted(_)));
        assert!(adopted.snapshot().desired_running);
        wait_until(|| recorder.count() == 1).await;
        // The adopting cycle knows the daemon is connected, so its ensure step does not wake
        // the daemon to reconnect, which would drop the connection and its open terminals.
        assert_eq!(recorder.requests(), vec![(false, true)]);

        stopped.start().await.unwrap();
        stopped.shutdown(None).await.unwrap();
        // The user stopped this device, so its daemon is refused and exits.
        assert_eq!(
            stopped
                .mark_connected(SocketId::new(), reported_hello())
                .await,
            ConnectVerdict::Stopped
        );
        assert!(!stopped.snapshot().desired_running);
        adopted.shutdown(None).await.unwrap();
    }

    /// A full supervisor mailbox makes lifecycle events wait instead of growing memory or
    /// silently dropping a disconnect the supervisor must see.
    #[tokio::test]
    async fn full_mailbox_defers_socket_events_instead_of_dropping() {
        let registry = WatchdogRegistry::new();
        let (handle, mut commands) = registry
            .register("busy".into(), callback(), no_supersede())
            .unwrap();
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
        let (handle, _commands) = registry
            .register("wedged".into(), callback(), no_supersede())
            .unwrap();
        for _ in 0..SUPERVISOR_COMMAND_CAPACITY {
            handle.mark_disconnected(SocketId::new());
        }
        // Paused time auto-advances to the reserve deadline while nothing drains the mailbox.
        assert!(matches!(
            handle.start().await,
            Err(WatchdogError::Busy { key }) if key == "wedged"
        ));
    }

    /// An output pipe kept open by a surviving grandchild must not stall the supervisor.
    #[tokio::test(start_paused = true)]
    async fn child_diagnostic_read_is_bounded() {
        let reader = tokio::spawn(std::future::pending::<std::io::Result<SessionOutput>>());
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
