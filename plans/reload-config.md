# Plan: Reload config.toml via process self-exec

## Goal

Add a **Reload config** control on the root route (`/`) that restarts the
server process in place so it re-reads `config.toml` from scratch. Use the
existing confirmation dialog. Prefer a full process restart over hot-reloading
individual settings.

## Why self-exec (not hot reload)

Today config is a **one-shot startup artifact** (`src/main.rs` 53–221):

1. Resolve + parse `config.toml`
2. Init logging, bind TCP, build `AuthState`, spawn agent supervisors
3. Drop the `ServerConfig` / path — nothing re-reads the file

Hot-reloading would require new APIs on `AuthState`, `WatchdogRegistry`
(stop/unregister/replace spawn fns), careful handling of in-flight transfers,
and a hot/cold split for port/bind/log. That is a large, fragile surface.

**Self-exec** reuses the existing startup path unchanged:

- Same binary, same argv, same PID (`execve`)
- Full re-parse of config, full re-bind, full re-spawn of agents
- Local/SSH children already use `kill_on_drop(true)` and die when supervisors drop
- File-based sessions survive if credentials fingerprint is unchanged
- Works under systemd and bare `redoor server` the same way
- Test `ProcessManager` keeps the same PID, so kill-by-pid still works

## Considerations when reloading

| Concern | Behavior |
|---------|----------|
| Invalid TOML / parse error | **Reject before restart** — parse the current config file first; on error return 400 and keep the running process |
| Port / bind / log changes | Applied on restart (full process restart handles cold settings) |
| Auth / agent_token / agents | Applied on restart via normal startup |
| In-flight transfers / terminals | Dropped when the process is replaced; UI reconnects after |
| Browser session | Kept if username/password fingerprint unchanged; otherwise next API call gets 401 → login |
| Port change | UI may be on the old origin and cannot auto-recover; dialog copy should warn that a port change requires opening the new URL |
| Listener reuse / EADDRINUSE | Must **gracefully shut down axum** (drop listener) **before** `exec`, otherwise the listening FD can block re-bind |
| External unsupervised agents | Disconnect; they reconnect if still running with a still-valid token |
| SSH prepare cost | Paid again on startup (same as a manual restart) — acceptable |
| Concurrent reload clicks | Idempotent: second call may fail if shutdown already started; use a one-shot shutdown signal |

## Design

```
UI Confirm → POST /api/v1/config/reload
                │
                ├─ parse_config_file(stored path)  ── fail → 400, no restart
                ├─ respond 200 { reloaded: true }
                └─ trigger graceful shutdown
                         │
              axum::serve returns
                         │
              kill_on_drop tears down agent children
                         │
              execve(current_exe, original_argv)
                         │
              normal run_server() startup with fresh config
```

### Restart mechanism

Use Unix `CommandExt::exec` so the process image is replaced **in place**
(same PID). Capture argv once at process start.

Do **not** spawn a sibling and exit — that changes PID (breaks tests and
systemd tracking) and races on the listen port.

### Graceful shutdown

Wire `axum::serve(...).with_graceful_shutdown(...)` to a oneshot/watch
channel held in `ServerState`. The reload handler validates config, returns
JSON, then signals shutdown. After `serve` completes, `run_server` calls
`reexec_current_process()`.

### Pre-validation

Only parse is required before restart. Do not attempt to bind the new port
while the old listener is still up. If the new process fails after exec
(e.g. port taken by something else), that is the same failure mode as a
manual restart with a bad config — operator fixes config and starts again.
Parse errors are the common footgun and are caught pre-restart.

## Files to change

### 1. `src/server/state.rs` — hold reload plumbing

Add to `ServerState`:

```rust
/// Absolute path of the config file loaded at startup so reload can
/// re-validate the same file the process was started with.
pub(crate) config_path: PathBuf,

/// Signals axum graceful shutdown; reload fires this after a successful
/// pre-validation so the listener is dropped before exec.
pub(crate) shutdown_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
```

Update `ServerState::new` accordingly. Construct the oneshot in `run_server`
and share the sender via state; the receiver feeds `with_graceful_shutdown`.

### 2. `src/main.rs` — graceful shutdown + exec

```rust
async fn run_server(args: server::CoordinatorArgs) {
    // ... existing config load / auth / registries ...

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let app = server::build_app(server::ServerState::new(
        router_ref.clone(),
        watchdog_registry.clone(),
        terminal_registry,
        auth,
        config_path.clone(),
        Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx))),
    ));

    // ... bind + spawn_agents ...

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        shutdown_rx.await.ok();
    })
    .await
    .unwrap();

    // Only reached after reload (or future shutdown paths). Replace this
    // process with the same binary+argv so startup re-reads config.toml.
    server::reexec_current_process();
}
```

Add `reexec_current_process` in the server module (e.g. `src/server/reload.rs`
or next to config):

```rust
/// Replaces the current process image with the same binary and argv.
///
/// Used after a config reload request has validated the file and axum has
/// released the listen socket. Same PID keeps systemd and test harnesses
/// tracking the server correctly.
pub(crate) fn reexec_current_process() -> ! {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("reload: failed to resolve current executable: {error}");
        std::process::exit(1);
    });
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();

    let error = std::process::Command::new(&exe).args(&args).exec();
    // exec only returns on failure
    eprintln!("reload: exec failed for {}: {error}", exe.display());
    std::process::exit(1);
}
```

Comments must explain **why** (PID stability, drop listener first, full
startup path applies config).

### 3. `src/commands.rs` — response type

```rust
/// Confirms the server accepted a config reload and is about to restart.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReloadConfigResponse {
    pub reloaded: bool,
}
```

Run `scripts/generate-ts-bindings` after adding it.

### 4. Handler + route

New handler (prefer `src/server/config.rs` or small `src/server/reload.rs`):

```rust
/// Validates config.toml then asks the process to restart so startup
/// applies the file from scratch (agents, auth, bind/port/log).
pub(crate) async fn reload_config_handler(
    State(state): State<ServerState>,
) -> impl IntoResponse {
    let path = state.config_path.to_string_lossy().to_string();
    if let Err(error) = parse_config_file(&path).await {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid config, not reloading: {error}"),
            }),
        )
            .into_response();
    }

    let mut guard = state.shutdown_tx.lock().await;
    let Some(tx) = guard.take() else {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Reload already in progress".to_string(),
            }),
        )
            .into_response();
    };

    // Drop the lock before signaling so we do not hold it across restart.
    drop(guard);
    let _ = tx.send(());

    Json(ReloadConfigResponse { reloaded: true }).into_response()
}
```

Route in `src/server/routes.rs` (auth middleware already covers it):

```rust
.route("/api/v1/config/reload", post(reload_config_handler))
```

Export the handler from `src/server/mod.rs` as needed.

### 5. `ui/src/api-client.ts`

```ts
import type { ReloadConfigResponse } from "../../bindings/ReloadConfigResponse";

// on ApiClient:
async reloadConfig(): Promise<ReloadConfigResponse> {
    return apiRequest<ReloadConfigResponse>(
        this.baseUrl,
        "/api/v1/config/reload",
        { method: "POST" },
        this.requestContext(),
    );
}
```

### 6. `ui/src/routes/index.tsx` — button + confirmation

Add a **Reload config** button on `/` (header row next to the "Agents"
title). Follow the delete confirmation state machine from
`ui/src/routes/__root.tsx` (~502–780):

```tsx
type ReloadState =
    | { type: "idle" }
    | { type: "reloading" }
    | { type: "error"; message: string };

// Button opens dialog
// ConfirmationDialog:
//   title: "Reload config?"
//   description: explain that the server process restarts, agents
//     reconnect, in-flight transfers/terminals drop, and a port change
//     requires opening the new URL.
//   confirmLabel: "Reload config"
//   busyLabel: "Reloading..."
//   isBusy when reloading
```

On confirm:

1. `setReloadState({ type: "reloading" })`
2. `await api.reloadConfig()` — may throw on 400 (invalid config)
3. On success, the TCP connection dies shortly after. **Poll** until the
   server answers again (e.g. `api.listAgents()` in a loop with small delay,
   timeout ~30s), then `window.location.assign("/")` or `router.invalidate()`
   + `router.load()`.
4. On parse/API error before restart: show `errorMessage` in the dialog.
5. If polling times out: show error that the server did not come back.

Do **not** destructure props. Use `ConfirmationDialog` from
`ui/src/components/confirmation-dialog.tsx`. Prefer accessible name on the
button (visible text "Reload config") for Playwright.

Suggested layout sketch:

```tsx
<div className="mb-6 flex items-center justify-between gap-4">
  <h1 className="text-2xl font-bold text-slate-100">Agents</h1>
  <button type="button" onClick={...} className="...">
    Reload config
  </button>
</div>
```

### 7. Integration test `tests/reload-config.test.ts`

Pattern from existing tests (`tests/watchdog.test.ts`, `tests/auth.test.ts`):

1. Start server with a temp config that includes a **local** `[[agents]]`
   entry (so the agent is supervised and comes back after restart).
2. Login, `waitForAgentNames`.
3. Mutate the config file on disk (e.g. change nothing critical, or add a
   second local agent / rename — pick something observable).
4. `api.reloadConfig()` → expect `{ reloaded: true }`.
5. Poll `listAgents` / login+list until the server is healthy again
   (**never `sleep` fixed time as the only wait** — poll API or wait for log
   line "Loaded server config" / "Server running on").
6. Assert new config took effect (e.g. new agent name present, or old agent
   back).
7. Separate case: write **invalid** TOML, call reload → expect 400 and
   server still serving the previous config (agents still listed).
8. `onTestFinished` cleanup via existing process manager patterns.

**PID note:** after successful reload the server PID is unchanged (`exec`).
`ProcessManager.kill(pid)` must still work — assert this implicitly by
normal test teardown.

Optional: assert stdout/log contains a second "Loaded server config" after
reload.

### 8. Bindings

After the Rust response type:

```bash
scripts/generate-ts-bindings
```

### 9. Build and test

Per AGENTS.md:

```bash
./scripts/build-and-test
```

On failure inspect `./log`.

## Out of scope

- Hot-reloading auth/agents without process restart
- Writing config.toml from the API
- UI for editing config
- Windows support for `exec` (project is Linux-focused; `CommandExt::exec` is
  Unix — gate with `cfg(unix)` only if needed; current platform is linux)
- Automatically redirecting the browser when `server.port` changes

## Implementation order

1. `ReloadConfigResponse` + bindings
2. `ServerState` fields + `run_server` graceful shutdown + `reexec_current_process`
3. Handler + route
4. `api-client.ts` method
5. Root route button + `ConfirmationDialog`
6. Integration test
7. `./scripts/build-and-test`

## Dialog copy (suggested)

**Title:** Reload config?

**Description:** The server will restart and re-read `config.toml`. Connected
agents reconnect automatically. In-flight transfers and terminals are
interrupted. If you changed the listen port, open the new URL after reload.

**Confirm:** Reload config
