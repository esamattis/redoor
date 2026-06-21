# Plan: Watchdog monitoring for spawned agents

## Goal

Wrap each agent subprocess spawned by the server with a watchdog supervisor
that:

1. **Restarts the subprocess** when it exits (so a crashed `redoor agent`,
   crashed `ssh`, or broken SSH tunnel is recovered without operator action).
2. **Restarts the subprocess** when the WebSocket ping stops being answered
   (so a half-open connection that won't notice a TCP close on its own gets
   killed and reconnected).

This applies to both `[[agents]]` kinds configured in the server's
`config.toml`:

- **local agents** — server-spawned `redoor agent` child processes.
- **ssh agents** — server-spawned `ssh` processes that run a remote
  `redoor agent` over a reverse port forward.

The `redoor ssh` CLI is unchanged; only the server's `spawn_agents` path is
rewritten to create one supervisor per configured agent.

## Design overview

Introduce a per-agent **supervisor task** that owns the subprocess lifecycle.
Each supervisor holds the running subprocess and watches two things in
parallel:

- `child.wait()` — the OS process exits.
- `stale_signal.notified()` — a signal the WebSocket session raises when it
  detects the connection is no longer responsive (no inbound frames for too
  long, no Pong responding to a Ping).

When either fires, the supervisor kills the subprocess (if still alive),
reaps it, waits a backoff, and starts a new cycle. The supervisor runs forever
for the lifetime of the server.

A `WatchdogRegistry` shared between the server and the session layer maps
`agent_name → WatchdogHandle`. The supervisor registers itself in this map at
startup. A session, after it has received the agent's `AgentRegister` frame,
looks up the handle by name and keeps it for the duration of the connection.
If the connection goes stale, the session calls `handle.signal_stale()`, the
supervisor wakes up, kills the child, and restarts.

### Why a per-agent `Notify` rather than a global one

- Avoids cross-talk when several agents go silent at the same time.
- The supervisor already knows which `agent_name` it owns, so it doesn't need
  a tagged message — just a boolean-ish "something is wrong, restart" signal.
- `tokio::sync::Notify` is cheap and coalesces multiple notifications.

### Why "stale" lives in the session, not the supervisor

The supervisor owns the OS process; the session owns the WebSocket protocol
state. A half-open TCP connection (e.g. SSH tunnel died) shows up as "no
frames received for N seconds" in the session, not as a subprocess exit. The
session is the only place that can observe that, so it's the one that
signals.

### Backoff

- After a "stable" run (>= `STABLE_RUNTIME`), reset backoff to `INITIAL_BACKOFF`.
  A long-running agent that exited cleanly is not a sign of a broken host.
- After a quick exit or spawn failure, double the backoff up to
  `MAX_BACKOFF`. Avoids hammering an unreachable host.
- After a stale WebSocket signal, reset backoff to `INITIAL_BACKOFF`. A stale
  tunnel is transient (network glitch) — restart quickly.

```
INITIAL_BACKOFF = 1s
MAX_BACKOFF     = 30s
STABLE_RUNTIME  = 30s
```

## Files to change

1. `src/ssh.rs` — split `start_ssh_agent` into a one-shot "prepare" path and
   a "spawn the long-running ssh subprocess" path; add a new `SshHost::spawn`
   method that returns the `Child` rather than waiting for it. The watcher
   needs the `Child` to be able to kill it.
2. `src/server/config.rs` — `spawn_agents` becomes a thin wrapper that hands
   configs to the watchdog module; `start_local_agent` is refactored to
   return a `Child` so the supervisor can hold and kill it.
3. `src/server/watchdog.rs` — **new file**: `WatchdogRegistry`, `WatchdogHandle`,
   and the supervisor loop. Owns the restart-with-backoff logic.
4. `src/server/state.rs` — add `watchdog_registry: WatchdogRegistry` to
   `ServerState`.
5. `src/server/mod.rs` — register the new module.
6. `src/server/ws.rs` — pass `WatchdogRegistry` to the session.
7. `src/actors/session.rs` — track `last_seen`, run a periodic stale check,
   call `handle.signal_stale()` and break the loop on stale.
8. `src/main.rs` — create the `WatchdogRegistry`, pass it into both
   `ServerState` and `spawn_agents`.

## Detailed steps

### 1. `src/ssh.rs`

#### 1a. Add `SshHost::spawn` that returns a `Child`

Mirrors the existing `SshHost::run` (lines 472-529) but stops before
`status().await` and returns the spawned child. The supervisor will own it.

```rust
pub(crate) async fn spawn(
    &self,
    command: &str,
    args: &[&str],
    options: &SshRunOptions,
) -> Result<tokio::process::Child, std::io::Error> {
    let mut ssh = Command::new("ssh");
    // ... same arg-building as run() ...
    ssh.stdin(Stdio::inherit());
    if let Some(log_path) = &options.log_file {
        // ... same stdio redirect as run() ...
    } else {
        ssh.stdout(Stdio::inherit());
        ssh.stderr(Stdio::inherit());
    }
    log!(Level::Debug, "Spawning ssh command: {:?}", ssh);
    ssh.spawn()
}
```

#### 1b. Split `start_ssh_agent` into `prepare_ssh_agent` and `spawn_ssh_agent`

`prepare_ssh_agent` (one-shot setup): sniff, download + upload if needed.
Returns the resolved `(SshHost, SshRunOptions, remote_argv, agent_name)`.

`spawn_ssh_agent` (long-running): uses the resolved values from `prepare` to
spawn the ssh child. The supervisor calls `prepare` once at startup (so the
binary is installed), then loops `spawn → wait/kill → restart`. To avoid
re-sniffing on every restart, the supervisor caches the prepared handles
once at the top of the loop and reuses them on every cycle.

Refactor `start_ssh_agent` so the existing `redoor ssh` CLI keeps working
unchanged. New shape:

```rust
pub(crate) async fn start_ssh_agent(config, port) -> Result<()> {
    let prepared = prepare_ssh_agent(&config, port).await?;
    let status = prepared.spawn_and_wait().await?;
    if !status.success() { ... }
    Ok(())
}
```

#### 1c. Public test surface

- Add a small unit test that the prepared `SshRunOptions` round-trip the
  `log_file` and `reverse_forwards` correctly. (Cheap, no ssh required.)

### 2. `src/server/config.rs`

#### 2a. Rename / refactor `start_local_agent`

- Returns `tokio::process::Child` instead of `Result<(), Error>`.
- Same body as today, just the call site at the bottom changes from
  `command.status().await?` to `command.spawn()?`.
- The supervisor takes the `Child` and calls `child.wait()` / `child.kill()`.

#### 2b. `spawn_agents` becomes a wrapper

```rust
pub(crate) fn spawn_agents(
    configs: &[AgentConfig],
    redoor_port: u16,
    registry: &WatchdogRegistry,
) {
    watchdog::spawn_supervisors(configs, redoor_port, registry.clone());
}
```

The `pub(crate) use config::spawn_agents` in `mod.rs` keeps the existing
`server::spawn_agents` call site in `main.rs` working, so the diff stays
small.

### 3. `src/server/watchdog.rs` (new)

```rust
//! Per-agent watchdog supervisors that own the agent subprocess lifecycle.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sysinfo::System;
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::time::sleep;

use redoor::{Level, log};

use crate::ssh::{SshAgentConfig, prepare_ssh_agent};

use super::config::{AgentConfig, LocalAgentConfig};

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const STABLE_RUNTIME: Duration = Duration::from_secs(30);

/// One handle the WebSocket session uses to signal "this connection is
/// stale, please restart the subprocess."
#[derive(Clone)]
pub struct WatchdogHandle {
    agent_name: String,
    stale_signal: Arc<Notify>,
}

impl WatchdogHandle {
    pub fn agent_name(&self) -> &str { &self.agent_name }
    pub fn signal_stale(&self) { self.stale_signal.notify_one(); }
}

/// Registry of all agent supervisors, keyed by expected agent name.
#[derive(Clone, Default)]
pub struct WatchdogRegistry {
    inner: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
}

impl WatchdogRegistry {
    pub fn new() -> Self { Self::default() }

    /// Allocates a fresh stale-signal Notify and registers it under
    /// `agent_name`. The supervisor holds the returned handle and listens
    /// on its `Notify`.
    pub fn register(&self, agent_name: String) -> WatchdogHandle {
        let stale_signal = Arc::new(Notify::new());
        self.inner.lock().expect("watchdog registry poisoned")
            .insert(agent_name.clone(), stale_signal.clone());
        WatchdogHandle { agent_name, stale_signal }
    }

    /// Looks up the handle by agent name. Returns None if no supervisor
    /// is registered under that name (e.g. an external agent that wasn't
    /// spawned by the server).
    pub fn lookup(&self, agent_name: &str) -> Option<WatchdogHandle> {
        self.inner.lock().expect("watchdog registry poisoned")
            .get(agent_name)
            .map(|stale_signal| WatchdogHandle {
                agent_name: agent_name.to_string(),
                stale_signal: stale_signal.clone(),
            })
    }
}

/// Outcome of one supervisor cycle.
enum CycleOutcome {
    Exited(std::io::Result<std::process::ExitStatus>),
    Stale,
    SpawnFailed(String),
}

/// Spawns one supervisor task per agent config. Returns immediately.
pub(crate) fn spawn_supervisors(
    configs: &[AgentConfig],
    redoor_port: u16,
    registry: WatchdogRegistry,
) {
    log!(Level::Info, "Starting {} agent supervisor(s)", configs.len());
    for config in configs.iter().cloned() {
        let registry = registry.clone();
        tokio::spawn(run_supervisor(config, redoor_port, registry));
    }
}

/// Runs one supervisor loop. Resolves the agent's expected name, prepares
/// the ssh host (sniff+download) once, then loops spawn → wait/kill →
/// restart with backoff forever.
async fn run_supervisor(
    config: AgentConfig,
    redoor_port: u16,
    registry: WatchdogRegistry,
) {
    let agent_name = match &config {
        AgentConfig::Ssh(c) => c.name.clone()
            .unwrap_or_else(|| crate::ssh::default_agent_name(&c.target)),
        AgentConfig::Local(c) => c.name.clone()
            .unwrap_or_else(default_local_agent_name),
    };

    let watchdog = registry.register(agent_name.clone());

    // Resolve the agent name default BEFORE we move config into the loop,
    // because the loop wants `config` by value.
    let mut backoff = INITIAL_BACKOFF;

    // One-time ssh preparation (sniff + download + upload). Only the ssh
    // kind has any setup; local agents are skipped.
    let ssh_prepared = match &config {
        AgentConfig::Ssh(c) => match prepare_ssh_agent(c, redoor_port).await {
            Ok(prepared) => Some(prepared),
            Err(error) => {
                log!(Level::Error,
                    "Failed to prepare ssh host: agent_name={}, error={}",
                    agent_name, error);
                None
            }
        },
        AgentConfig::Local(_) => None,
    };

    loop {
        let started = Instant::now();
        let outcome = run_one_cycle(
            &config, redoor_port, &watchdog, ssh_prepared.as_ref()
        ).await;
        let runtime = started.elapsed();

        match outcome {
            CycleOutcome::Exited(Ok(status)) => {
                log!(Level::Info,
                    "Agent subprocess exited: agent_name={}, status={}, runtime={:?}",
                    agent_name, status, runtime);
                if runtime >= STABLE_RUNTIME {
                    backoff = INITIAL_BACKOFF;
                } else {
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
            CycleOutcome::Exited(Err(error)) => {
                log!(Level::Error,
                    "Agent subprocess wait failed: agent_name={}, error={}, runtime={:?}",
                    agent_name, error, runtime);
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
            CycleOutcome::Stale => {
                log!(Level::Warning,
                    "Agent WebSocket went stale, restarting: agent_name={}, runtime={:?}",
                    agent_name, runtime);
                backoff = INITIAL_BACKOFF;
            }
            CycleOutcome::SpawnFailed(error) => {
                log!(Level::Error,
                    "Agent spawn failed: agent_name={}, error={}, retrying in {:?}",
                    agent_name, error, backoff);
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }

        sleep(backoff).await;
    }
}

/// Runs one cycle: spawn the subprocess, wait for exit or stale signal.
async fn run_one_cycle(
    config: &AgentConfig,
    redoor_port: u16,
    watchdog: &WatchdogHandle,
    ssh_prepared: Option<&crate::ssh::PreparedSshAgent>,
) -> CycleOutcome {
    let mut child = match spawn_subprocess(config, redoor_port, ssh_prepared).await {
        Ok(child) => child,
        Err(error) => return CycleOutcome::SpawnFailed(error.to_string()),
    };

    tokio::select! {
        status = child.wait() => CycleOutcome::Exited(status),
        _ = watchdog.stale_signal.notified() => {
            // Kill and reap so we don't leave zombies between restarts.
            let _ = child.start_kill();
            let _ = child.wait().await;
            CycleOutcome::Stale
        }
    }
}

async fn spawn_subprocess(
    config: &AgentConfig,
    redoor_port: u16,
    ssh_prepared: Option<&crate::ssh::PreparedSshAgent>,
) -> Result<tokio::process::Child, Box<dyn std::error::Error>> {
    match (config, ssh_prepared) {
        (AgentConfig::Local(c), _) => spawn_local(c, redoor_port).await,
        (AgentConfig::Ssh(_), Some(prepared)) => prepared.spawn().await,
        // ssh_prepared is None means the one-time prepare failed earlier;
        // the supervisor's loop is already in error-backoff, so we just
        // return a stub error.
        (AgentConfig::Ssh(_), None) => Err("ssh host not prepared".into()),
    }
}

async fn spawn_local(
    config: &LocalAgentConfig,
    redoor_port: u16,
) -> Result<tokio::process::Child, Box<dyn std::error::Error>> {
    // Same body as today's start_local_agent minus the trailing status().await?:
    // returns the spawned child so the supervisor can wait/kill it.
    ...
}

fn default_local_agent_name() -> String {
    System::host_name().unwrap_or_else(|| "local".to_string())
}
```

#### 3a. Unit tests in `src/server/watchdog.rs`

**`test_watchdog_restarts_subprocess_on_exit`**

- Spawn a supervisor with a config that points at `bash -c "exit 0"` (a
  command that exits immediately).
- Poll the registry or a counter until the cycle count advances >= 2
  within a reasonable timeout.
- Asserts that the supervisor keeps restarting instead of giving up after
  one failure.

**`test_watchdog_kills_subprocess_on_stale_signal`**

- Spawn a supervisor with a config that points at `sleep 60`.
- Wait for the child to be alive (poll `/proc` on Linux or use a known
  stdout message).
- Call `signal_stale()`.
- Wait for the supervisor to log "Agent WebSocket went stale, restarting"
  and for the next cycle to start a new `sleep` process.
- Asserts the old PID is gone and a new one is running.

These tests use `bash`/`sleep` to avoid the complexity of running real
agents. The integration test (below) covers the real `redoor agent` path.

### 4. `src/server/state.rs`

```rust
pub(crate) struct ServerState {
    pub(crate) router_ref: actors::router::RouterHandle,
    pub(crate) watchdog_registry: super::watchdog::WatchdogRegistry,
}

impl ServerState {
    pub(crate) fn new(
        router_ref: actors::router::RouterHandle,
        watchdog_registry: super::watchdog::WatchdogRegistry,
    ) -> Self {
        Self { router_ref, watchdog_registry }
    }
}
```

### 5. `src/server/mod.rs`

Add `mod watchdog;` and re-export `WatchdogRegistry` so other modules can
construct it (in particular `main.rs`).

### 6. `src/server/ws.rs`

`handle_socket` becomes:

```rust
async fn handle_socket(
    socket: WebSocket,
    router_ref: actors::router::RouterHandle,
    watchdog_registry: WatchdogRegistry,
) {
    let socket_id = SocketId::new();
    actors::session::handle_websocket(
        socket, socket_id, router_ref, watchdog_registry
    ).await;
}
```

`websocket_handler` extracts `watchdog_registry` from `AxumState` and passes
it through.

### 7. `src/actors/session.rs`

#### 7a. New module-level constants

```rust
/// How often to check whether the websocket has gone silent. Independent
/// of the ping interval so the stale check can use a multiple of the
/// ping interval as its threshold (e.g. 3x the ping interval = 30s).
const WEBSOCKET_STALE_CHECK_INTERVAL: tokio::time::Duration =
    tokio::time::Duration::from_secs(5);

/// No inbound frame for this long means the connection is treated as
/// stale. Sized as 3x the ping interval so two missed pongs (= 30s)
/// trigger a restart.
const WEBSOCKET_STALE_TIMEOUT: tokio::time::Duration =
    tokio::time::Duration::from_secs(30);
```

#### 7b. New field on `SessionRuntime`

```rust
struct SessionRuntime {
    /* existing fields */
    /// Handle to the agent's supervisor; populated after AgentRegister.
    /// Stays None if the agent isn't supervised (e.g. a manually-spawned
    /// external agent), in which case the stale check is a no-op.
    watchdog: Option<WatchdogHandle>,
}
```

#### 7c. `handle_websocket` signature

```rust
pub async fn handle_websocket(
    socket: WebSocket,
    socket_id: SocketId,
    router_ref: RouterHandle,
    watchdog_registry: WatchdogRegistry,
) { ... }
```

#### 7d. Last-seen tracking

Add `let mut last_seen = Instant::now();` to the function. Update it on
**every** `Some(Ok(message))` arm of the read loop:

```rust
result = receiver.next() => match result {
    Some(Ok(message)) => {
        last_seen = Instant::now();
        if !runtime.handle_ws_message(message).await { break; }
    }
    _ => break,
},
```

This covers Text, Binary, Ping, Pong, Frame, and Close. (The current
`WsMessage` arms inside `handle_ws_message` ignore Ping/Pong/Close, but the
outer `match` arm updates `last_seen` before dispatch, so any frame resets
the timer.)

#### 7e. Populate `watchdog` after AgentRegister

In `handle_control_message`, on `Message::AgentRegister`, look up the
supervisor by name:

```rust
self.watchdog = watchdog_registry.lookup(&agent_name);
```

This means a manually-spawned external agent (no entry in the registry)
keeps `watchdog = None` and never triggers a restart — which is correct
because the supervisor doesn't own its process.

#### 7f. Stale check arm

Add a `stale_check` interval alongside the writer task. The check fires
every 5s; if `last_seen.elapsed() > 30s` and `watchdog.is_some()`, signal
and break.

```rust
let mut stale_check = tokio::time::interval(WEBSOCKET_STALE_CHECK_INTERVAL);
stale_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
stale_check.tick().await; // burn the first immediate tick

loop {
    tokio::select! {
        biased;
        _ = &mut writer_done_rx => break,
        _ = stale_check.tick() => {
            if last_seen.elapsed() > WEBSOCKET_STALE_TIMEOUT
                && let Some(watchdog) = runtime.watchdog.as_ref()
            {
                log!(Level::Warning,
                    "WebSocket stale for {:?}, requesting restart: agent_name={}",
                    last_seen.elapsed(), watchdog.agent_name());
                watchdog.signal_stale();
                break;
            }
        }
        result = receiver.next() => match result {
            /* as above, updating last_seen */
        },
    }
}
```

> The session is broken out of the read loop on stale. The writer task
> will then see the channels close (the session unregisters the agent in
> `runtime.shutdown()`) and exit cleanly. The supervisor is already
> notified and will kill the child and start a new one, which opens a
> fresh WebSocket → fresh session.

### 8. `src/main.rs`

```rust
let watchdog_registry = server::WatchdogRegistry::new();

let (router_ref, _router_task) = actors::router::spawn_router();
let app = server::build_app(server::ServerState::new(
    router_ref.clone(),
    watchdog_registry.clone(),
));

// ... bind listener ...

if let Some(config) = &config {
    server::spawn_agents(&config.agents, port, &watchdog_registry);
}
```

## Tests

### Unit tests (`src/server/watchdog.rs`)

- `test_watchdog_restarts_subprocess_on_exit` — see 3a.
- `test_watchdog_kills_subprocess_on_stale_signal` — see 3a.

### Integration test (`tests/watchdog.test.ts`)

Goal: prove the full path (config → spawn → server session → stale →
restart) works end-to-end.

1. **Setup**: write a temp `config.toml` with one `[[agents]] local = true`
   entry. Spawn the server with `--config` pointing at that file. The
   server registers the supervisor and the first agent.
2. **Test A: subprocess death → restart**:
   - Wait for the agent to be listed (REST `/api/v1/agents`).
   - Read its `pid` via `getDetails()`.
   - `process.kill(pid, "SIGKILL")`.
   - Wait for a new agent to be listed with a **different** `pid`.
   - Assert old PID is gone (`process.kill(pid, 0)` throws ESRCH) and the
     new PID is alive.
3. **Test B: stale WebSocket → restart**:
   - Wait for the agent to be listed and stable.
   - Read its `pid` via `getDetails()`.
   - Use the existing `kill -STOP` / SIGSTOP / SIGCONT approach to freeze
     the agent process. The agent is now alive but the WebSocket is
     frozen — no Pong, no frames.
   - Wait for the supervisor to declare stale and restart (a new agent
     registers with a new PID).
   - Assert the new agent is responsive (e.g. `getDetails()` succeeds).
   - `kill -CONT` the frozen process to clean up (it'll exit because the
     WebSocket is gone).

Test B requires `kill -STOP` / `kill -CONT` to freeze a single process
without killing it. The integration test already uses `process.kill`
(`SIGKILL`) for cleanup, so adding the SIGSTOP/SIGCONT is a small
extension.

## Verification

Run `./scripts/build-and-test` to exercise:

- `cargo fmt -- --check`
- `cargo test` (the new unit tests)
- `cargo build`
- `pnpm run test` (the new integration test)
- `cargo clippy`

No new REST API surface → no TypeScript bindings to regenerate.

## Risks and trade-offs

- **Sniff+download re-runs on every ssh restart.** If the remote binary
  is already installed, sniff is one short ssh round-trip, so the cost
  is bounded. If the binary gets uninstalled mid-flight, the supervisor
  re-installs it on the next cycle. Acceptable.
- **A genuine long-running agent that gets paused by a debugger / cgroup
  freeze is treated as stale and restarted.** This is the documented
  behavior — the watchdog's contract is "always responsive or
  restarted." The integration test relies on this for Test B.
- **The supervisor runs forever in its own task; if it panics, the
  server keeps going but the agent is gone.** Acceptable for an
  operator-visible server; if this becomes a real concern we can wrap
  the loop in a recovery supervisor later.
