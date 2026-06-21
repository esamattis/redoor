//! Generic per-key watchdog supervisors that own a long-lived subprocess
//! lifecycle.
//!
//! The watchdog is intentionally decoupled from any specific subprocess
//! type. The [`WatchdogSupervisor`] takes a closure that knows how to
//! spawn one child process; the supervisor loops:
//!
//! 1. Call the spawn closure to get a [`tokio::process::Child`].
//! 2. Wait for either:
//!    - the child to exit on its own, or
//!    - a stale signal from the session layer
//!      ([`WatchdogHandle::signal_stale`]).
//! 3. Kill the child (if still alive) and reap it.
//! 4. Sleep for a backoff that resets on a stable run and grows on
//!    repeated quick failures.
//! 5. Restart.
//!
//! The supervisor runs forever for the lifetime of the server. The
//! server instantiates one supervisor per configured agent and passes
//! in a closure that knows how to spawn that agent's subprocess
//! (local `redoor agent` or `ssh` wrapping a remote one).
//!
//! The watchdog is exposed as a library module so the actor session
//! (in [`crate::actors::session`]) can look up the right supervisor
//! by name after the agent registers. The server wires the
//! `WatchdogRegistry` into its own axum state and forwards it to the
//! session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};

use crate::log;
use crate::logging::Level;
use tokio::process::Child;
use tokio::sync::Notify;
use tokio::time::sleep;

/// Backoff for the first restart after a quick failure or spawn error.
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);

/// Cap on the backoff to avoid waiting forever between restart attempts
/// against a persistently broken host.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// A run of at least this long is considered "stable" and resets the
/// backoff. A crash after a long stable run is treated as a fresh
/// transient event rather than an escalating outage.
const STABLE_RUNTIME: Duration = Duration::from_secs(30);

/// Spawn strategy for one supervisor. Returning an error means the
/// supervisor backs off and retries on the next cycle. The inner
/// closure is `Send + Sync + 'static` so the supervisor can own it
/// across restarts.
///
/// Construct with [`SpawnFn::new`] to avoid hand-writing the
/// `Arc::new(move || Box::pin(async move { ... }))` triple-nesting at
/// every call site: pass an `Fn() -> Fut` and the constructor boxes
/// each future for you.
pub struct SpawnFn {
    inner: Arc<
        dyn Fn() -> futures_util::future::BoxFuture<'static, Result<Child, String>>
            + Send
            + Sync,
    >,
}

impl SpawnFn {
    /// Wraps an `Fn() -> Fut` into a [`SpawnFn`] by boxing each call's
    /// future. Callers pass a plain function/closure that returns a
    /// future; the `Arc<dyn Fn ...>` + `BoxFuture` plumbing is handled
    /// here once instead of being repeated at every construction site.
    pub fn new<F, Fut>(f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Child, String>> + Send + 'static,
    {
        Self {
            inner: Arc::new(move || Box::pin(f())),
        }
    }

    /// Runs one spawn invocation, returning a future that resolves to
    /// the spawned child or an error string.
    fn spawn(&self) -> futures_util::future::BoxFuture<'static, Result<Child, String>> {
        (self.inner)()
    }
}

/// Handle the WebSocket session uses to signal that its connection has
/// gone stale. The supervisor listens on the inner `Notify` and treats
/// the signal as "kill the subprocess and start a new cycle."
#[derive(Clone)]
pub struct WatchdogHandle {
    key: String,
    stale_signal: Arc<Notify>,
}

impl WatchdogHandle {
    /// Returns the key this handle is bound to. Used for logging when
    /// the session signals staleness.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Tells the supervisor the WebSocket is no longer responsive. The
    /// supervisor kills the subprocess (if still alive) and starts a
    /// new cycle.
    pub fn signal_stale(&self) {
        self.stale_signal.notify_one();
    }
}

/// Shared map from key to the supervisor's `Notify`. The server hands
/// one to the axum state so the WebSocket session can look up the
/// right supervisor after the agent sends its `AgentRegister` frame.
#[derive(Clone, Default)]
pub struct WatchdogRegistry {
    inner: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
}

impl WatchdogRegistry {
    /// Creates a new, empty registry. The server builds one before
    /// spawning the axum app and before [`spawn_supervisor`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocates a fresh `Notify` and stores it under `key`, then
    /// returns a handle bound to it. The supervisor keeps the returned
    /// handle and waits on its inner `Notify` for the rest of its
    /// lifetime.
    ///
    /// Returns an error if the key is already registered. Two
    /// supervisors sharing the same key would race on the same
    /// `Notify`, with each one killing the other's subprocess on
    /// stale signals, so the second registration is rejected instead
    /// of being silently aliased.
    pub fn register(&self, key: String) -> Result<WatchdogHandle> {
        let mut map = self.inner.lock().expect("watchdog registry poisoned");
        if map.contains_key(&key) {
            bail!("Watchdog key already registered: key={}", key);
        }
        let stale_signal = Arc::new(Notify::new());
        map.insert(key.clone(), stale_signal.clone());
        Ok(WatchdogHandle { key, stale_signal })
    }

    /// Looks up the handle for an already-registered key. Returns
    /// `None` if no supervisor owns the given key (e.g. an external
    /// agent spawned outside the server). The session treats `None` as
    /// "this agent is not supervised, so don't signal on stale" — a
    /// half-open connection to an external agent is the operator's
    /// problem to detect, not the watchdog's.
    pub fn lookup(&self, key: &str) -> Option<WatchdogHandle> {
        self.inner
            .lock()
            .expect("watchdog registry poisoned")
            .get(key)
            .map(|stale_signal| WatchdogHandle {
                key: key.to_string(),
                stale_signal: stale_signal.clone(),
            })
    }
}

/// Outcome of one supervisor cycle. Drives the next backoff and the
/// log line that explains why the cycle ended.
enum CycleOutcome {
    /// Subprocess exited on its own. Wraps the OS-level result so
    /// the supervisor can distinguish a clean exit from a `wait()`
    /// failure (e.g. the child was already reaped by a signal).
    Exited(std::io::Result<std::process::ExitStatus>),
    /// Watchdog notified the supervisor that the WebSocket went
    /// stale. The subprocess has already been killed and reaped.
    Stale,
    /// Spawn itself failed (e.g. binary not found).
    SpawnFailed(String),
}

/// Spawns one supervisor task for a single key and returns
/// immediately. The supervisor lives for the lifetime of the server
/// and keeps restarting its subprocess forever.
///
/// `key` is the identifier used to look up the supervisor from the
/// session (typically the agent's name). `spawn` is called once per
/// cycle; it must be re-entrant because the supervisor invokes it on
/// every restart.
///
/// Returns an error if `key` is already registered; see
/// [`WatchdogRegistry::register`] for the rationale. On success,
/// returns the supervisor task's `JoinHandle` so callers (notably
/// tests) can abort it and avoid orphaning the current subprocess
/// when they no longer need the supervisor. Production callers ignore
/// the handle — the supervisor is meant to run for the server's
/// lifetime.
pub fn spawn_supervisor(
    key: String,
    spawn: SpawnFn,
    registry: &WatchdogRegistry,
) -> Result<tokio::task::JoinHandle<()>> {
    let watchdog = registry.register(key.clone())?;
    log!(Level::Info, "Watchdog supervisor registered: key={}", key);
    Ok(tokio::spawn(run_supervisor(key, spawn, watchdog)))
}

/// Runs one supervisor loop until the process exits. Cycles through
/// spawn → wait/kill → sleep forever, adjusting the backoff based on
/// what ended the previous cycle.
async fn run_supervisor(key: String, spawn: SpawnFn, watchdog: WatchdogHandle) {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        let started = Instant::now();
        let outcome = run_one_cycle(&spawn, &watchdog).await;
        let runtime = started.elapsed();

        match outcome {
            CycleOutcome::Exited(Ok(status)) => {
                log!(
                    Level::Info,
                    "Watchdog subprocess exited: key={}, status={}, runtime={:?}",
                    key,
                    status,
                    runtime
                );
                if runtime >= STABLE_RUNTIME && status.success() {
                    // Long-stable run then a clean exit: treat as a
                    // fresh transient event, restart quickly. A
                    // non-zero exit after a long run (e.g. a crash
                    // after 31s) is NOT treated as clean — a
                    // reproducible crash (memory leak that OOMs every
                    // ~30s) would otherwise produce a tight
                    // crash-restart loop at `INITIAL_BACKOFF` forever.
                    backoff = INITIAL_BACKOFF;
                } else {
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
            CycleOutcome::Exited(Err(error)) => {
                log!(
                    Level::Error,
                    "Watchdog subprocess wait failed: key={}, error={}, runtime={:?}",
                    key,
                    error,
                    runtime
                );
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
            CycleOutcome::Stale => {
                log!(
                    Level::Warning,
                    "Watchdog connection went stale, restarting: key={}, runtime={:?}",
                    key,
                    runtime
                );
                // A stale WebSocket is often transient (network
                // glitch, tunnel bouncing), but a persistently broken
                // path (e.g. firewall dropping idle connections every
                // 30s) would produce a tight restart loop if we reset
                // to `INITIAL_BACKOFF` every time. Escalate the
                // backoff here too; a one-off blip still restarts
                // quickly because the previous long run already
                // reset the backoff in the `Exited(Ok(_))` arm, while
                // a persistent staleness escalates up to `MAX_BACKOFF`.
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
            CycleOutcome::SpawnFailed(error) => {
                log!(
                    Level::Error,
                    "Watchdog spawn failed: key={}, error={}, retrying in {:?}",
                    key,
                    error,
                    backoff
                );
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }

        sleep(backoff).await;
    }
}

/// Runs one supervisor cycle: spawn the subprocess, wait for either
/// subprocess exit or a stale-WebSocket signal, return the outcome.
async fn run_one_cycle(spawn: &SpawnFn, watchdog: &WatchdogHandle) -> CycleOutcome {
    let mut child = match spawn.spawn().await {
        Ok(child) => child,
        Err(error) => return CycleOutcome::SpawnFailed(error),
    };

    tokio::select! {
        status = child.wait() => CycleOutcome::Exited(status),
        _ = watchdog.stale_signal.notified() => {
            // Kill the subprocess and reap it so we don't leave a
            // zombie between restarts. `start_kill` is non-blocking;
            // the explicit `wait()` collects the exit status.
            let _ = child.start_kill();
            let _ = child.wait().await;
            CycleOutcome::Stale
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RAII guard that aborts a supervisor task on drop. Tests hold
    /// one for every supervisor they spawn so the supervisor (and its
    /// in-flight subprocess, when constructed with `kill_on_drop`)
    /// is cleaned up on every exit path, including early returns and
    /// panics. Mirrors the role of `onTestFinished` in the TS suite
    /// for Rust tests, which have no such hook of their own.
    struct SupervisorGuard {
        handle: Option<tokio::task::JoinHandle<()>>,
    }

    impl SupervisorGuard {
        fn new(handle: tokio::task::JoinHandle<()>) -> Self {
            Self {
                handle: Some(handle),
            }
        }
    }

    impl Drop for SupervisorGuard {
        fn drop(&mut self) {
            if let Some(handle) = self.handle.take() {
                handle.abort();
            }
        }
    }

    /// Verifies `register` then `lookup` returns a handle bound to the
    /// same `Notify`, and that `signal_stale` on the registered
    /// handle wakes a task waiting on the looked-up handle's
    /// `notified()`.
    #[tokio::test]
    async fn test_registry_lookup_round_trips_stale_signal() {
        let registry = WatchdogRegistry::new();
        let handle = registry
            .register("agent-1".to_string())
            .expect("first register should succeed");

        let looked_up = registry
            .lookup("agent-1")
            .expect("agent-1 must be registered");

        // Signal via the original handle; the looked-up handle's
        // `notified()` future should resolve because both handles
        // share the same `Arc<Notify>`.
        handle.signal_stale();
        // Bound the wait so a regression deadlocks the test instead of
        // hanging the suite. The default test timeout is generous
        // (60s) and the signal is delivered synchronously, so this
        // resolves immediately in practice.
        let _ = tokio::time::timeout(Duration::from_secs(1), looked_up.stale_signal.notified())
            .await
            .expect("stale_signal.notified() should resolve after signal_stale()");
    }

    /// Verifies `lookup` returns `None` for an unknown key so the
    /// session can tell a server-spawned supervised agent apart from a
    /// manually-spawned external one.
    #[tokio::test]
    async fn test_registry_lookup_returns_none_for_unknown_key() {
        let registry = WatchdogRegistry::new();
        assert!(registry.lookup("ghost-agent").is_none());
    }

    /// Verifies the supervisor restarts a subprocess that exits
    /// immediately. Uses `sh -c "exit 0"` (a command guaranteed to
    /// exist on macOS and Linux) as a stand-in for a real agent.
    /// The test passes if the supervisor keeps the loop going for
    /// several cycles without panicking and the subprocess count
    /// advances; we use a short `MAX_BACKOFF` would normally be the
    /// cap, but a quick-exit subprocess doubles the backoff up to
    /// the cap, so we just verify the process spawned at least twice
    /// by checking a counter via a shared atomic.
    #[tokio::test]
    async fn test_supervisor_restarts_subprocess_on_quick_exit() {
        use std::process::Stdio;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::process::Command;

        let counter = Arc::new(AtomicUsize::new(0));
        let counter_for_spawn = counter.clone();
        let spawn = SpawnFn::new(move || {
            let counter = counter_for_spawn.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                // `kill_on_drop(true)` ensures any in-flight child is
                // reaped when the aborted supervisor drops its `Child`.
                Command::new("sh")
                    .arg("-c")
                    .arg("exit 0")
                    .kill_on_drop(true)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())
            }
        });

        let registry = WatchdogRegistry::new();
        // Abort the supervisor when the test exits so we don't keep
        // spawning `sh -c "exit 0"` cycles into a dropped runtime.
        let _guard = SupervisorGuard::new(
            spawn_supervisor("quick-exit".to_string(), spawn, &registry)
                .expect("spawn_supervisor should register the key"),
        );

        // Wait for the counter to reach at least 3 spawns to prove
        // the supervisor kept restarting instead of stopping after
        // the first quick exit.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if counter.load(Ordering::SeqCst) >= 3 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let observed = counter.load(Ordering::SeqCst);
        assert!(
            observed >= 3,
            "supervisor should have spawned the subprocess at least 3 times, got {}",
            observed
        );
    }

    /// Verifies the supervisor kills a still-running subprocess when
    /// the WebSocket signals stale, and then starts a new one.
    /// Uses `sleep 60` as a stand-in for an agent that won't exit on
    /// its own. The test passes if the PID changes after a stale
    /// signal, proving the old subprocess was killed and replaced.
    #[tokio::test]
    async fn test_supervisor_kills_subprocess_on_stale_signal() {
        use std::process::Stdio;
        use std::sync::atomic::{AtomicU32, Ordering};
        use tokio::process::Command;

        let pid_counter = Arc::new(AtomicU32::new(0));
        let pid_counter_for_spawn = pid_counter.clone();
        let spawn = SpawnFn::new(move || {
            let pid_counter = pid_counter_for_spawn.clone();
            async move {
                // `kill_on_drop(true)` ensures the replacement
                // `sleep 60` is reaped when the aborted supervisor
                // drops its `Child`, instead of orphaning it for up
                // to 60s after the test returns.
                let child = Command::new("sleep")
                    .arg("60")
                    .kill_on_drop(true)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                pid_counter.store(child.id().unwrap_or(0), Ordering::SeqCst);
                Ok(child)
            }
        });

        let registry = WatchdogRegistry::new();
        // Abort the supervisor on test exit so the replacement
        // `sleep 60` (and any later cycles) is killed via
        // `kill_on_drop` instead of outliving the test.
        let _guard = SupervisorGuard::new(
            spawn_supervisor("stale-test".to_string(), spawn, &registry)
                .expect("spawn_supervisor should register the key"),
        );

        // Wait for the first sleep to be spawned.
        let first_pid = {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let pid = pid_counter.load(Ordering::SeqCst);
                if pid != 0 {
                    break pid;
                }
                if Instant::now() >= deadline {
                    panic!("supervisor did not spawn the first subprocess in time");
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };

        // Signal stale via the looked-up handle.
        let handle = registry
            .lookup("stale-test")
            .expect("stale-test must be registered");
        handle.signal_stale();

        // Wait for a new PID to appear, proving the old subprocess
        // was killed and a new one started.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let new_pid = pid_counter.load(Ordering::SeqCst);
            if new_pid != first_pid && new_pid != 0 {
                return;
            }
            if Instant::now() >= deadline {
                panic!(
                    "supervisor did not restart the subprocess with a new PID after stale signal; first_pid={}, new_pid={}",
                    first_pid,
                    pid_counter.load(Ordering::SeqCst)
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
