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

/// Closure type used to spawn a single subprocess for one supervisor
/// cycle. Returning an error means the supervisor backs off and
/// retries on the next cycle. The closure is `Send + 'static` so the
/// supervisor can own it across restarts.
pub type SpawnFn =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Result<Child, String>> + Send + Sync>;

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

    /// Allocates a fresh `Notify` and stores it under `key`. The
    /// supervisor keeps the returned handle and waits on its inner
    /// `Notify` for the rest of its lifetime.
    /// <CODEREVIEW>
    /// `register` silently overwrites an existing entry for the same
    /// key. If `register("foo")` is called twice, the first supervisor
    /// keeps running but `lookup("foo")` now returns the second
    /// supervisor's `Notify`. Signals from the session go to the new
    /// supervisor while the old one runs orphaned with its own
    /// `Notify` that nothing will ever signal again — its subprocess
    /// is never restarted on stale.
    /// In the current design `spawn_supervisor` is called exactly once
    /// per agent at startup, so this is not triggered. But it is a
    /// footgun if `spawn_agents` is ever called again (e.g. config
    /// reload) or if two configs resolve to the same default name
    /// (e.g. two ssh agents targeting the same host without explicit
    /// names).
    /// Suggestion: either `assert!` / log a warning on overwrite, or
    /// return the existing handle instead of creating a new `Notify`
    /// when the key is already present:
    ///   if let Some(existing) = map.get(&key) {
    ///       return WatchdogHandle { key, stale_signal: existing.clone() };
    ///   }
    /// Also consider detecting duplicate keys in `spawn_agents` at
    /// config-parse time so the operator gets a clear error instead
    /// of a silently broken supervisor.
    /// </CODEREVIEW>
    pub fn register(&self, key: String) -> WatchdogHandle {
        let stale_signal = Arc::new(Notify::new());
        self.inner
            .lock()
            .expect("watchdog registry poisoned")
            .insert(key.clone(), stale_signal.clone());
        WatchdogHandle { key, stale_signal }
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
pub fn spawn_supervisor(key: String, spawn: SpawnFn, registry: &WatchdogRegistry) {
    let watchdog = registry.register(key.clone());
    log!(Level::Info, "Watchdog supervisor registered: key={}", key);
    tokio::spawn(run_supervisor(key, spawn, watchdog));
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
                if runtime >= STABLE_RUNTIME {
                    // Long-stable run then a clean exit: treat as a
                    // fresh transient event, restart quickly.
                    // <CODEREVIEW>
                    // The comment says "clean exit" but the code does
                    // not check `status.success()`. A subprocess that
                    // runs for >= STABLE_RUNTIME and then crashes with
                    // a non-zero exit (e.g. segfault after 31s) also
                    // resets the backoff. If the crash is reproducible
                    // (e.g. a memory leak that OOMs every ~30s), the
                    // supervisor will restart at `INITIAL_BACKOFF`
                    // forever instead of escalating, producing a
                    // tight crash-restart loop.
                    // Suggestion: only reset backoff on
                    // `status.success()`, or at minimum track a
                    // separate "consecutive non-zero stable exits"
                    // counter and escalate after N of them:
                    //   if status.success() {
                    //       backoff = INITIAL_BACKOFF;
                    //   } else if runtime >= STABLE_RUNTIME {
                    //       // Stable but crashed: mild escalation.
                    //       backoff = (backoff * 2).min(MAX_BACKOFF);
                    //   } else {
                    //       backoff = (backoff * 2).min(MAX_BACKOFF);
                    //   }
                    // </CODEREVIEW>
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
                // A stale WebSocket is transient (network glitch,
                // tunnel bouncing). Don't penalize backoff for it.
                // <CODEREVIEW>
                // Unconditionally resetting to `INITIAL_BACKOFF` on
                // every stale signal means a persistently broken
                // network path (e.g. firewall dropping idle
                // connections every 30s, or a misconfigured reverse
                // forward that never comes up) produces a tight
                // restart loop: spawn → ssh connects → 30s silence →
                // stale → kill → 1s backoff → spawn → ... That is
                // ~1 restart per 31s with no escalation, which is a
                // lot of ssh reconnects and log noise.
                // Suggestion: escalate backoff on repeated stale
                // signals too, but reset it when a cycle runs long
                // enough to prove the connection is healthy:
                //   CycleOutcome::Stale => {
                //       backoff = (backoff * 2).min(MAX_BACKOFF);
                //   }
                // And in the `Exited(Ok(_))` arm, reset backoff when
                // `runtime >= STABLE_RUNTIME` (which already happens).
                // That way a one-off network blip still restarts
                // quickly (the previous run was long, so backoff was
                // already at `INITIAL_BACKOFF`), but a persistent
                // staleness escalates.
                // </CODEREVIEW>
                backoff = INITIAL_BACKOFF;
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
    let mut child = match spawn().await {
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

    /// Verifies `register` then `lookup` returns a handle bound to the
    /// same `Notify`, and that `signal_stale` on the registered
    /// handle wakes a task waiting on the looked-up handle's
    /// `notified()`.
    #[tokio::test]
    async fn test_registry_lookup_round_trips_stale_signal() {
        let registry = WatchdogRegistry::new();
        let handle = registry.register("agent-1".to_string());

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
    /// immediately. Uses `bash -c "exit 0"` (a command guaranteed to
    /// exist on macOS and Linux) as a stand-in for a real agent.
    /// The test passes if the supervisor keeps the loop going for
    /// several cycles without panicking and the subprocess count
    /// advances; we use a short `MAX_BACKOFF` would normally be the
    /// cap, but a quick-exit subprocess doubles the backoff up to
    /// the cap, so we just verify the process spawned at least twice
    /// by checking a counter via a shared atomic.
    #[tokio::test]
    async fn test_supervisor_restarts_subprocess_on_quick_exit() {
        // <CODEREVIEW>
        // The supervisor task spawned here is never cancelled. When
        // the test returns, the tokio runtime drops the task, but
        // the `Child` handles inside `run_one_cycle` are dropped
        // without `kill_on_drop`, so any in-flight `sh -c "exit 0"`
        // is not killed. For this test the subprocess exits in
        // milliseconds so the leak is negligible, but the pattern
        // matters for `test_supervisor_kills_subprocess_on_stale_signal`
        // (see comment there).
        // Suggestion: return a `JoinHandle` (or a cancellation token)
        // from `spawn_supervisor` so tests can abort the supervisor
        // and its current child in `on_test_finished`:
        ///   let handle = spawn_supervisor(...);
        ///   on_test_finished(move || { handle.abort(); });
        // </CODEREVIEW>
        use std::process::Stdio;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::process::Command;

        let counter = Arc::new(AtomicUsize::new(0));
        let counter_for_spawn = counter.clone();
        let spawn: SpawnFn = Arc::new(move || {
            let counter = counter_for_spawn.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Command::new("sh")
                    .arg("-c")
                    .arg("exit 0")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())
            })
        });

        let registry = WatchdogRegistry::new();
        spawn_supervisor("quick-exit".to_string(), spawn, &registry);

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
        // <CODEREVIEW>
        // The supervisor is never cancelled after the test returns.
        // If the test succeeds, the supervisor has already started a
        // new `sleep 60` child (the replacement subprocess). When the
        // tokio runtime drops the task, the `Child` is dropped
        // without `kill_on_drop(true)`, so that `sleep 60` is
        // orphaned and keeps running for up to 60s after the test.
        // On a busy CI host running many tests, this can leave
        // several orphaned `sleep` processes.
        // Suggestion: either (a) return a `JoinHandle` from
        // `spawn_supervisor` and abort it in `on_test_finished`,
        // or (b) construct the `Command` with
        // `.kill_on_drop(true)` in the test's spawn closure so the
        // child is reaped when the `Child` is dropped:
        ///   Command::new("sleep").arg("60")
        ///       .kill_on_drop(true)
        ///       .stdin(Stdio::null()) ...
        // The same `kill_on_drop(true)` should be considered for the
        // production spawn paths in `spawn_local_agent` and
        // `SshHost::spawn` so the server doesn't orphan agents on
        // shutdown.
        // </CODEREVIEW>
        use std::process::Stdio;
        use std::sync::atomic::{AtomicU32, Ordering};
        use tokio::process::Command;

        let pid_counter = Arc::new(AtomicU32::new(0));
        let pid_counter_for_spawn = pid_counter.clone();
        let spawn: SpawnFn = Arc::new(move || {
            let pid_counter = pid_counter_for_spawn.clone();
            Box::pin(async move {
                let child = Command::new("sleep")
                    .arg("60")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                pid_counter.store(child.id().unwrap_or(0), Ordering::SeqCst);
                Ok(child)
            })
        });

        let registry = WatchdogRegistry::new();
        spawn_supervisor("stale-test".to_string(), spawn, &registry);

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
