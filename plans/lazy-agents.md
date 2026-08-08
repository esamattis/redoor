# Plan: Lazy managed agents and agent management

## Goal

Change TOML-configured agents from eager, always-running subprocesses into managed agents that are registered at server startup but only started when requested. A configured agent tab must be visible before the subprocess exists; clicking it must immediately show an agent-status placeholder, request startup, and only move into the file browser after the agent has registered its WebSocket connection.

Add an authenticated `/agents` management view that lists every agent known during the current server process lifetime:

- TOML-configured agents, including agents that have never started.
- Currently connected external agents.
- External or configured agents that connected earlier but are currently disconnected.

The view and tab strip must expose lifecycle state. Connected rows show how long the current connection has been up. Disconnected/stopped/starting rows that connected previously show how long ago they were last seen. TOML-configured rows additionally expose start and shutdown actions and their latest connection/startup issue. External agents remain observation-only.

This plan deliberately uses the configured agent's effective name as its stable `AgentId`. That matches the existing agent process behavior (`src/agent/mod.rs:124-128`) and the watchdog lookup key (`src/server/watchdog.rs:45-57`), so a tab can exist before an agent has connected without introducing a second identifier or route migration.

## Current behavior and constraints

- `src/main.rs:207-223` calls `server::spawn_agents` after binding the listener, so all configured agents begin immediately.
- `src/server/watchdog.rs:26-42` creates one supervisor per TOML entry, and `src/watchdog.rs:207-280` immediately enters an infinite spawn/restart loop. There is no intentional stopped state or shutdown command.
- `src/actors/router/state.rs:35-40` retains only currently connected agents. `src/actors/router/mod.rs:179-210` removes the connection on unregister, so disconnected agents and their last-seen time disappear.
- `src/server/agents.rs:44-77` exposes only the router's connected list. `AgentInfoResponse` at `src/commands.rs:242-254` has no source, lifecycle, timestamps, or issue fields.
- The root loader (`ui/src/routes/__root.tsx:209-230`) supplies this connected-only list to the application. `TopTabStrip` (`ui/src/routes/__root.tsx:359-438`) therefore cannot show a configured-but-stopped agent.
- Agent tabs link directly to the file browser (`ui/src/routes/__root.tsx:404-435`). Both agent route loaders reject an absent connected agent (`ui/src/routes/agents.$agentId.index.tsx:14-23` and `ui/src/routes/agents.$agentId.browser.$.tsx:113-130`).
- The existing UI refresh websocket invalidates router data after connect/disconnect (`ui/src/routes/__root.tsx:73-198`), but watchdog-only transitions such as a spawn error do not currently emit a UI refresh.
- Playwright runs one shared server and two external agents from `scripts/test/playwright-dev:16-37`; the browser suite is serial at the worker level (`ui/playwright.config.ts:15-37`).
- Every new REST response must have a dedicated Rust response struct with `#[ts(export)]`, followed by `scripts/generate-ts-bindings`.
- New Rust structs, enums, functions, and methods need comments that explain intent/why. Test assertions also need comments explaining the behavior they protect.
- Do not use sleeps in tests. Poll APIs/state or wait for observable log/UI events.

## Lifecycle model

Use one authoritative inventory in the router for UI-facing agent records and keep process supervision in the watchdog. This avoids duplicating connection timestamps and makes existing UI refresh notifications cover both connection and lifecycle changes.

### Public agent status

Add a generated `AgentConnectionStatus` enum with these serialized values:

- `stopped`: a configured agent has never been started or was intentionally shut down.
- `starting`: start was requested and the supervisor is spawning, waiting for registration, or retrying after an issue.
- `connected`: the router has a current authoritative WebSocket connection.
- `disconnected`: an agent seen previously has no current connection and is not actively starting. This is the normal status for disconnected external agents; a configured agent may briefly enter it while an unexpected disconnect is handed back to its desired-running supervisor.

Represent process ownership separately with `managed: bool`. Do not infer controls from status: only TOML entries are managed.

### Timestamp semantics

- `connected_at`: set from the current authoritative registration and present only while connected.
- `last_seen_at`: set to wall-clock time when the current authoritative socket unregisters or is replaced. It is retained across later starts during the same server process lifetime. This is intentionally the server's last positive observation of the connection, not a client-provided timestamp.
- The UI computes duration from `Date.now()` and these timestamps. It updates its local clock on an interval without refetching solely to make labels tick.

### Desired-running and retries

A managed supervisor has a separate internal `desired_running` flag:

- Initial value is false, and its public status is `stopped`.
- Start sets it true idempotently and transitions to `starting` before spawning.
- Unexpected process exit, stale WebSocket, spawn failure, or disconnect retains `desired_running = true`; the existing bounded backoff/restart behavior remains active.
- Shutdown sets it false, cancels backoff or startup work, kills and reaps the owned child if present, and settles at `stopped` without restarting.
- A repeated start while starting/connected and a repeated shutdown while stopped are successful no-ops. This makes double clicks and retries safe.

### Connection issues

Store `connection_issue: Option<String>` on managed inventory entries:

- Clear it when a new start is requested and when a valid agent WebSocket registers.
- Set it to the concrete error returned by local spawn, SSH prepare, or SSH spawn.
- Set it to a useful child-exit message including exit status when the subprocess exits before registering.
- If a child remains alive but no matching registration arrives within a named startup timeout (for example 15 seconds), set `"Agent process started but has not connected within 15 seconds"` while leaving the supervisor desired-running. Do not block control commands during this timer.
- Preserve the latest issue during retry/backoff so the management row and startup placeholder can explain why connection is delayed.
- Shutdown may retain the latest issue for diagnostics; a later start clears it.

Do not attempt to scrape an agent log file into memory or return it through the API. Only surface lifecycle errors already available to the supervisor, keeping the feature safe for large logs and memory-constrained deployments.

## API contract

### Expanded list response

Update `AgentInfoResponse` in `src/commands.rs:242-254` to represent both connected and disconnected inventory entries:

```rust
/// Identifies whether an agent can be controlled by this server.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionStatus {
    Stopped,
    Starting,
    Connected,
    Disconnected,
}

/// Summarizes one known agent without requiring a live connection.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentInfoResponse {
    pub id: AgentId,
    pub name: String,
    pub cwd: Option<String>,
    pub managed: bool,
    pub status: AgentConnectionStatus,
    pub connected_at: Option<UnixTimestampSeconds>,
    pub last_seen_at: Option<UnixTimestampSeconds>,
    pub connection_issue: Option<String>,
}
```

`cwd` becomes optional because a never-connected SSH entry without `dir` has no authoritative browser directory yet. On registration, replace it with the absolute/default directory reported by the agent. Existing external connected agents continue to have `Some(cwd)`.

Keep `GET /api/v1/agents` as the single list API used by root loading and management. Return entries sorted by name and then id in the server handler so tests and every client receive stable ordering.

### Management endpoints

Add:

- `POST /api/v1/agents/{agent}/start`
- `POST /api/v1/agents/{agent}/shutdown`

Create dedicated exported response structs, rather than returning `AgentInfoResponse` directly:

```rust
/// Confirms that a managed agent accepted a start request.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Confirms that a managed agent accepted a shutdown request.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ShutdownAgentResponse {
    pub agent: AgentInfoResponse,
}
```

Endpoint behavior:

- Return `404` with `ErrorResponse` for an unknown id.
- Return `409 Conflict` with `ErrorResponse` when the id belongs to an external/unmanaged agent.
- Start returns after the supervisor has accepted the command and the inventory is `starting`; it must not wait for SSH preparation or WebSocket registration.
- Shutdown waits for the supervisor's acknowledgement that startup/backoff was cancelled and any current child was killed/reaped, then returns the `stopped` snapshot. Bound the request/reply wait and return an actionable `500`/`504` error rather than hanging.
- Both handlers notify UI refresh after changing lifecycle state. The starting view will additionally poll while transitional, covering later asynchronous failures.

## Detailed implementation

### 1. Make watchdog supervisors controllable and initially dormant

Modify `src/watchdog.rs` around `WatchdogHandle`/`WatchdogRegistry` (`90-165`) and the supervisor loop (`167-302`).

1. Replace the stale-only `Notify` entry with an entry that has:
   - an unbounded or bounded Tokio command sender;
   - a state snapshot protected by a Tokio `watch` channel or async mutex;
   - the existing stale signal;
   - a connection notification used to distinguish pre-registration exits/timeouts from connected runs.
2. Add a `SupervisorCommand` enum for `Start` and `Shutdown { reply }`. Keep `tokio::select!` arm bodies small by delegating spawn-cycle, shutdown, and backoff handling to methods/functions, as required by `AGENTS.md`.
3. Change `spawn_supervisor` so it registers the key and starts a dormant task, but does not call `SpawnFn` until `Start` arrives.
4. Add documented `WatchdogHandle` methods:
   - `start()` for an idempotent nonblocking desired-running request;
   - `shutdown().await` for acknowledged cancellation and child cleanup;
   - `mark_connected(socket_id)` and `mark_disconnected(socket_id)` so stale unregisters cannot overwrite a replacement connection;
   - `snapshot()` for list projection;
   - retain `signal_stale()` for the session stale detector.
5. Extend the supervisor loop so shutdown is selectable during spawn preparation, process wait, registration wait, and restart backoff. Dropping a preparation future must not block the runtime; child ownership remains in the supervisor and every shutdown path reaps it.
6. Track registration state per socket/generation. A late unregister from an old session must be ignored in the watchdog just as it is in the router today (`src/actors/router/mod.rs:179-210`).
7. Publish state transitions through a callback or router message supplied when the server registers a configured supervisor. Do not make the generic watchdog depend directly on Axum. The server wiring can translate watchdog snapshots into router inventory updates and UI refreshes.
8. Keep the existing exponential backoff constants and stable-run logic, but make backoff cancellable with a Tokio timer inside `select!`; production async delays are acceptable, while tests must observe state rather than sleeping.

Important supervisor shape:

```rust
loop {
    wait_until_desired_running(&mut commands).await?;
    publish_starting(None);

    while desired_running {
        let cycle = run_started_cycle(&spawn, &mut commands, &watchdog).await;
        if handle_cycle_outcome(cycle, &mut desired_running).await == Stop {
            break;
        }
        wait_for_restart_or_command(backoff, &mut commands).await;
    }

    publish_stopped();
}
```

Unit tests in `src/watchdog.rs` should cover without fixed sleeps:

- Registration alone does not invoke `SpawnFn`; observe an atomic counter remains zero while the supervisor reports stopped.
- Start invokes spawn and duplicate start does not create a second concurrent child.
- Shutdown kills/reaps the child and no later respawn occurs; synchronize with command acknowledgements and watch-state changes.
- Shutdown interrupts a pending backoff/startup future.
- Spawn errors become visible in snapshots and retries remain desired-running.
- Matching registration clears the issue and marks connected; stale disconnect generations are ignored.

Use child processes or controllable pending futures with `onTestFinished`-equivalent RAII cleanup already established at `src/watchdog.rs:304-332`; do not add `sleep` calls to tests.

### 2. Register TOML inventory without starting subprocesses

Modify `src/server/watchdog.rs:17-154`.

1. Rename `spawn_agents` to a name matching its new behavior, such as `register_agents`, and update module docs that currently promise immediate startup.
2. For every cloned `AgentConfig`:
   - compute the effective stable name with the existing `supervisor_key` logic;
   - derive the configured default directory (`Option<String>`) and source kind needed only for diagnostics;
   - register a stopped managed inventory record with the router;
   - build the existing local/SSH `SpawnFn`;
   - create the dormant supervisor and wire lifecycle snapshot notifications back to the router.
3. Preserve duplicate effective-name validation as a fatal server startup error. Validate/register all names before launching background tasks, or roll back already-created registrations if later validation fails, so startup cannot leave a partially initialized fleet.
4. Keep the SSH prepared-agent cache in `ssh_spawn_fn` (`88-154`), but ensure shutdown can cancel an in-progress prepare and a later start can retry from an empty cache.
5. Update `src/server/config.rs:1-9`, `AgentConfig` comments at `221-229`, and `CoordinatorArgs` documentation at `src/server/state.rs:80-89` so configuration describes lazy managed agents rather than an eagerly launched fleet.

Modify `src/main.rs:182-223` to call `register_agents` after the router exists and before serving requests. Keep listener binding before registration if SSH spawn construction needs the resolved port, but no subprocess should run as a result. Update the startup log to say configured agents were registered, not started.

### 3. Extend router state into an all-agent inventory

Modify `src/actors/router/state.rs:10-40` and `src/actors/router/agents.rs:82-151`.

1. Keep `AgentRegistry.by_id` as the live connection routing map so transfer/control code remains simple and responsive.
2. Add a separate `known_by_id: HashMap<AgentId, KnownAgent>` inventory containing:
   - id/name;
   - optional last authoritative cwd;
   - managed flag;
   - public lifecycle status;
   - connected/last-seen timestamps;
   - latest connection issue;
   - current socket id while connected, for stale-event protection.
3. Add router messages and small handlers for:
   - registering a configured stopped agent;
   - applying a managed lifecycle snapshot;
   - getting all inventory entries;
   - starting/shutting down a managed agent through its watchdog handle or stored management handle.
4. On `agents::register` (`src/actors/router/agents.rs:91-137`):
   - retain existing same-name takeover and request cleanup;
   - upsert unknown external agents into inventory;
   - preserve `managed = true` for matching configured entries;
   - set status connected, authoritative cwd, connected timestamp, current socket id, and clear connection issue;
   - tell the matching watchdog handle which socket connected;
   - notify UI refresh once after state is consistent.
5. On current-socket unregister (`src/actors/router/mod.rs:179-210`):
   - remove only the live routing connection as today;
   - retain inventory;
   - set `last_seen_at = now` and clear `connected_at`;
   - external agents become disconnected;
   - managed desired-running agents transition through disconnected to starting/reconnecting via the supervisor snapshot, while intentionally stopped agents settle at stopped;
   - notify the watchdog with the socket id and issue one UI refresh.
6. During same-name replacement, set the old connection's last-seen timestamp but finish with the new connection as authoritative; do not briefly publish disconnected state to the UI.
7. Change `AgentListEntry` in `src/actors/router/messages.rs:35-44` to carry the full inventory projection (or add a clearly named replacement type) and return all records from `list_agents`.

This router-owned inventory intentionally resets when the server process execs/reloads. Configured entries are recreated as stopped after reload; external agents reappear when their processes reconnect. Persistence is out of scope.

### 4. Add REST handlers and generated bindings

Modify `src/server/agents.rs:44-102` and `src/server/routes.rs:27-89`.

1. Update `list_agents_handler` to project all inventory fields into the expanded `AgentInfoResponse` and sort deterministically.
2. Add `start_agent_handler` and `shutdown_agent_handler` using router request/reply messages. Keep each handler thin and delegate lifecycle operations to focused async methods.
3. Register POST routes adjacent to `GET /api/v1/agents/{agent}`.
4. Ensure `get_agent_details_handler` still operates only on a connected agent. A stopped/disconnected id should produce the existing not-found/agent-unavailable error rather than waiting 30 seconds.
5. Add handler/router tests for unknown ids, unmanaged conflicts, idempotent controls, and list snapshots across stopped → starting → connected → stopped/disconnected.
6. Run `scripts/generate-ts-bindings` immediately after changing exported commands types. Commit generated updates under `bindings/`, including `AgentInfoResponse.ts`, `AgentConnectionStatus.ts`, `StartAgentResponse.ts`, and `ShutdownAgentResponse.ts`.

### 5. Update the TypeScript API model

Modify imports and agent methods in `ui/src/api-client.ts` (`1-11`, `170-209`, and `500-511`).

1. Import only generated lifecycle/list/control types from `bindings`; do not duplicate interfaces in the UI.
2. Keep `Agent` as the wrapper around `AgentInfoResponse`, and expose read-only getters for `managed`, `status`, `connectedAt`, `lastSeenAt`, `connectionIssue`, and nullable `cwd`.
3. Add `Agent.start(): Promise<StartAgentResponse>` and `Agent.shutdown(): Promise<ShutdownAgentResponse>` methods using the new POST endpoints.
4. Audit every caller of `agent.cwd`. Connected-only operations may narrow via status plus a null check; never use TypeScript `!`. `getBrowserUrl` must require a concrete path, so stopped agents cannot accidentally generate a malformed browser URL.
5. Update `waitForAgentNames` only if tests need a connected-only predicate. Prefer adding `waitForConnectedAgentNames` rather than silently changing list semantics now that `listAgents()` includes stopped records.

### 6. Make tabs include stopped agents and show startup before connection

Modify `RootLoaderData` and `RootLayout` in `ui/src/routes/__root.tsx:60-71` and `240-343`, plus `TopTabStrip` at `359-525`.

1. Render one tab for every inventory entry, not only connected entries. Replace “No agents connected” with “No agents configured or connected” only when the complete inventory is empty.
2. Add accessible status text/icon to each tab (for example an `aria-label` containing name and status) without relying on CSS classes in Playwright selectors.
3. For connected agents with a non-null cwd, preserve remembered browser navigation using `agent-tab-locations.ts`.
4. For stopped, starting, or disconnected agents, target `/agents/{id}` instead of a browser route.
5. On click of a stopped/disconnected managed tab:
   - navigate immediately to `/agents/{id}` and set an optimistic per-agent starting state in React/Jotai;
   - then call `agent.start()`;
   - invalidate the router with the returned snapshot;
   - if the request itself fails, keep the status route mounted and show the request error with a Retry action.
6. Do not await start before navigation. This ordering is the guarantee that the browser sees the starting placeholder even when a local agent registers almost instantly.
7. Direct navigation to `/agents/{configured-id}` must also trigger the same idempotent start from the status route, so bookmarks have the same lazy behavior as tab clicks.
8. While any managed agent is starting, poll `router.invalidate()` on a short bounded interval (for example one second). Stop polling when it connects, is shut down, or the component unmounts. This surfaces delayed spawn/SSH errors even though no agent registration event occurred. Use cleanup to cancel the timer and avoid overlapping invalidations.
9. Once a starting agent is connected and has a cwd, redirect from its status route to its remembered browser location (validated by `getAgentTabLocation`) or its cwd browser URL. Keep the explicit status route available when users navigate to agent details intentionally; only auto-redirect when startup was initiated from a stopped/disconnected state.
10. Keep terminal/import panels disabled until status is connected and cwd is non-null (`ui/src/routes/__root.tsx:263-343`).

A minimal optimistic flow should look like:

```tsx
const openManagedAgent = (agent: Agent) => {
    markOptimisticallyStarting(agent.id);
    void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    void agent.start().then(() => router.invalidate()).catch((error) => {
        setStartError(agent.id, getErrorMessage(error));
    });
};
```

### 7. Turn the agent index route into the lifecycle/status boundary

Refactor `ui/src/routes/agents.$agentId.index.tsx:14-205`.

1. Its loader must locate any known inventory agent, not only a connected one.
2. Fetch `getDetails()` only when status is connected. Return a discriminated loader result so the component never calls live-agent APIs while stopped/disconnected.
3. Render a centered accessible starting placeholder for `starting`/optimistic-starting:
   - spinner;
   - heading such as `Starting {name}`;
   - explanation that the server is waiting for the agent connection;
   - latest `connection_issue`, if present;
   - Retry and Shutdown actions where applicable.
4. Render a disconnected/stopped placeholder with last-seen text and a Start button for managed agents. External disconnected agents get observation-only messaging and no controls.
5. Preserve the existing detail cards for connected agents, but change the “Connected” value at `142-145` from an absolute timestamp to a live duration label. The management view and details view should share one formatting utility.
6. Replace the destructured `ErrorDisplay` props at `28` with the project-required `props` access pattern while touching this component.
7. In `ui/src/routes/agents.$agentId.browser.$.tsx:113-167`, detect known-but-not-connected agents and navigate/redirect to `/agents/{id}` instead of throwing “Agent not found.” This gives stale bookmarked browser URLs the startup placeholder and lazy start behavior.

Create a small `ui/src/utils/agent-time.ts` helper with documented functions such as:

```ts
export function formatAgentRecency(
    status: AgentConnectionStatus,
    connectedAt: number | null,
    lastSeenAt: number | null,
    nowMs: number,
): string {
    // "Connected for 2m 14s", "Last seen 35s ago", or "Never connected".
}
```

Use a `useNow` hook/component-local interval for ticking labels. Handle null timestamps explicitly; do not use non-null assertions.

### 8. Add the agent management route

Create `ui/src/routes/agents.index.tsx` for `/agents` and add an “Agents” menu link beside Home in `ui/src/routes/__root.tsx:482-501`.

The page should:

1. Use `RootRoute.useLoaderData().agents`, sorted consistently with the tabs.
2. Render a heading and an accessible table/list with columns for name, source (`Managed (TOML)` or `External`), status, connection recency, issue, and actions.
3. Make the name link to the agent status/details route. Connected rows may also offer “Browse files” only when cwd exists.
4. Show Start for managed stopped/disconnected rows, Shutdown for managed starting/connected rows, and a disabled busy state while each mutation is in flight.
5. Use per-agent mutation state so operating one agent does not disable unrelated controls.
6. Confirm shutdown with the existing `ConfirmationDialog`, explaining that transfers and terminals for that agent will be interrupted.
7. Display `connection_issue` inline with an alert/status semantic and preserve it while retrying. Never expose controls for external agents.
8. Update the local clock independently of API polling for connected-duration/last-seen labels.
9. Use Tailwind and accessible names/roles; Playwright must select by heading, row, status, or button text rather than classes.

Because this is a new file-based route, run `cd ui && pnpm run build` after creating it so TanStack Router regenerates `ui/src/routeTree.gen.ts`.

### 9. Update integration tests for lazy semantics

Modify `tests/watchdog.test.ts:32-101` and lifecycle assertions at `104-221`.

1. After server startup, assert the configured agent is listed as managed/stopped but is not connected; this replaces the current eager wait at `74-86`.
2. Call the start API and poll until connected before running crash/stale restart checks.
3. Preserve crash and stale restart coverage, but update helpers to select `status === "connected"` because list results now include disconnected inventory records.
4. Add a shutdown test that captures the PID, invokes shutdown, polls for stopped status, verifies the old PID is gone, and verifies no reconnect appears during an event-driven observation window. Prefer watchdog state/log notifications or API polling bounded by a timeout; do not sleep.
5. Add a deliberately failing configured agent case (for example a local agent with a nonexistent default directory that exits before registration) and assert `connection_issue` becomes non-empty while the server and unrelated control APIs remain responsive.
6. Use `onTestFinished()` for every start requiring cleanup and add explanatory comments to assertions.

Update existing tests/helpers that assume `listAgents()` means connected agents, especially:

- `tests/agents.test.ts:74-103` and later list lookups.
- `ui/e2e/helpers.ts:54-73`.
- `ui/e2e/reload-config.spec.ts:35-68`.

Narrow by `status === "connected"` and handle nullable cwd explicitly.

### 10. Add deterministic Playwright coverage

Modify `scripts/test/playwright-dev:16-37` to include two TOML-managed local entries while retaining the existing two external agents used by file/copy tests:

- A valid lazy agent with a unique name and explicit `dir`.
- A failing lazy agent whose explicit directory is guaranteed not to exist, causing an actionable startup/connection issue without network access.

Do not start either managed agent in the shell script. Extend cleanup only for processes the script itself launches; managed children remain owned by the server supervisor.

Create `ui/e2e/agent-management.spec.ts` with serial tests and cleanup registered before mutations:

1. **Inventory before start**
   - Open `/agents`.
   - Assert both existing external agents are connected.
   - Assert the valid and failing TOML agents are shown as managed/stopped.
   - Assert only managed rows contain Start controls.
   - Assert the valid lazy agent has not produced an “Agent registered” log before interaction, proving startup is lazy.

2. **Tab click shows startup before connection**
   - Route/intercept the start POST long enough to observe optimistic UI before allowing the request to continue; do not use a timeout sleep.
   - Click the stopped agent tab.
   - Assert the `Starting <name>` placeholder is visible while the intercepted request is pending.
   - Release the request, then wait for the file browser/connected status using visible UI or `expect.poll` against the API.
   - Assert connected recency says `Connected for …` and the tab remains the active tab.

3. **Management shutdown and restart**
   - From `/agents`, shut down the valid managed agent through the confirmation dialog.
   - Assert the row becomes stopped and shows `Last seen … ago` rather than disappearing.
   - Assert the previously used browser URL now redirects to the status placeholder instead of an Agent not found error.
   - Start it from the management row and poll until connected again.

4. **Connection issue visibility**
   - Start the failing managed agent.
   - Assert its row/status page remains starting and displays a non-empty actionable issue.
   - Assert another management action or server page remains responsive while the supervisor retries, protecting the “control commands stay responsive” architecture requirement.
   - Shut the failing agent down in `onTestFinished`/test cleanup through the API so retries cannot leak into later scenarios.

Use Playwright request routing, `expect.poll`, and locator assertions—not `waitForTimeout`. Every assertion should have an adjacent comment explaining which lifecycle guarantee it protects. Select elements by role, accessible name, row text, or explicit ARIA labels, never Tailwind class names.

Update `ui/e2e/reload-config.spec.ts`: after self-exec, configured managed entries should be stopped again rather than eagerly reconnecting. The two shell-owned external agents should still reconnect. Add an assertion for the stopped configured row/tab so reload behavior is explicit.

## Race and failure handling checklist

- Start is idempotent across tab effects, management clicks, and direct-route loads.
- Shutdown wins over spawn preparation, child wait, registration timeout, stale signal, and backoff.
- A child is always killed/reaped on intentional shutdown; no zombie or watchdog respawn remains.
- Old-socket unregister cannot mark a replacement connection disconnected.
- A late WebSocket registration after shutdown must be rejected/terminated or immediately shut down; it must not change the managed record back to connected while `desired_running` is false.
- External agents with the same valid token continue to register without becoming controllable.
- Configured and external records are not duplicated when names/ids match.
- Starting/failing one SSH agent does not block list/start/shutdown requests for another agent; no registry mutex is held across SSH preparation or process I/O.
- UI loaders never issue file/details/terminal requests until connected and cwd is present.
- UI mutation failures remain visible and retryable; no non-null assertions are introduced.
- All lifecycle transitions that matter to the UI either emit a refresh or are covered by bounded transitional polling.

## Documentation and generated artifacts

- Update relevant module and CLI comments that say configured agents start at server launch (`src/server/config.rs:1-9`, `src/server/watchdog.rs:17-25`, `src/watchdog.rs:1-27`, `src/server/state.rs:80-89`, and `src/main.rs:207-214`).
- Update `README.md` configuration/UI sections if they describe eager TOML startup, documenting lazy tab/start behavior, management controls, and the fact that external agents are not controllable.
- Run `scripts/generate-ts-bindings` after Rust API type changes and include generated files in `bindings/`.
- Run `cd ui && pnpm run build` after adding `ui/src/routes/agents.index.tsx` to regenerate route types.

## Validation sequence

Run the narrowest checks first, then the mandatory project-wide script:

1. `cargo test watchdog`
2. `pnpm run test -- tests/watchdog.test.ts tests/agents.test.ts`
3. `cd ui && pnpm run build`
4. `pnpm run playwright -- ui/e2e/agent-management.spec.ts`
5. `./scripts/build-and-test`

If a test fails, inspect the related files under `log/`, especially `log/playwright-redoor.log` and the configured managed-agent logs. Do not claim success unless the commands were actually run and passed.

## Expected file changes

- `src/watchdog.rs`
- `src/server/watchdog.rs`
- `src/server/config.rs`
- `src/server/mod.rs`
- `src/server/state.rs`
- `src/server/agents.rs`
- `src/server/routes.rs`
- `src/main.rs`
- `src/actors/session.rs`
- `src/actors/router/messages.rs`
- `src/actors/router/state.rs`
- `src/actors/router/agents.rs`
- `src/actors/router/mod.rs`
- `src/commands.rs`
- `bindings/AgentInfoResponse.ts`
- `bindings/AgentConnectionStatus.ts` (new)
- `bindings/StartAgentResponse.ts` (new)
- `bindings/ShutdownAgentResponse.ts` (new)
- `ui/src/api-client.ts`
- `ui/src/routes/__root.tsx`
- `ui/src/routes/agents.$agentId.index.tsx`
- `ui/src/routes/agents.$agentId.browser.$.tsx`
- `ui/src/routes/agents.index.tsx` (new)
- `ui/src/utils/agent-time.ts` (new)
- `ui/src/routeTree.gen.ts` (generated)
- `ui/e2e/helpers.ts`
- `ui/e2e/reload-config.spec.ts`
- `ui/e2e/agent-management.spec.ts` (new)
- `scripts/test/playwright-dev`
- `tests/watchdog.test.ts`
- `tests/agents.test.ts`
- `README.md` if its current wording describes eager configured-agent startup
