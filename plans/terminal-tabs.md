# Multiple Terminal Tabs

## Goal

Replace the single lazy terminal launcher with an agent-scoped terminal tab bar that supports any number of independent terminal sessions.

The completed behavior must satisfy these rules:

- An agent page initially has zero terminal tabs, zero Ghostty instances, zero terminal WebSockets, and zero PTYs.
- The terminal panel header remains visible with an empty tab bar and a `+` button. The `+` button is immediately to the right of the last terminal tab, or is the first item when there are no tabs.
- Clicking `+` creates a new tab, selects it, expands the panel, and starts one fresh terminal session.
- Every tab owns an independent Ghostty instance, WebSocket, PTY, shell, status, scrollback, and teardown lifecycle.
- Switching tabs does not disconnect, dispose, recreate, or reset either terminal.
- Minimizing the panel keeps all tabs and PTYs alive. Re-expanding refits and focuses only the selected terminal.
- Closing a tab destroys only that tab's WebSocket/Ghostty/PTY. Closing the final tab returns to the initial zero-terminal state.
- New tab labels are monotonic for the mounted agent panel (`Terminal 1`, `Terminal 2`, and so on); a closed number is not reused.
- A new terminal snapshots the current committed route's directory at the instant `+` is clicked. Existing tabs do not follow later file-browser navigation.
- On the agent details page, the starting directory is the agent's reported `cwd`.
- On a directory browser page, the starting directory is the directory represented by the route loader's canonical `fullPath`.
- On a file detail page, the starting directory is the open file's parent directory.
- Switching agents or leaving agent routes retains the existing ephemeral behavior: all tabs for the old agent are unmounted and destroyed, and an agent entered later starts with zero tabs.
- Refresh never restores tabs or shells.

This plan does not add tab persistence, terminal reattachment, output replay, automatic reconnection, tab renaming, reordering, or cross-agent terminal retention.

## Current Architecture

- `ui/src/routes/__root.tsx:199-225` derives the active agent from the URL and mounts one `TerminalPanel`, keyed by agent ID. This already gives the desired route-level teardown boundary.
- `ui/src/components/terminal-panel.tsx:70-342` combines panel-level collapse state with all resources for one terminal. It lazily starts on first expansion, preserves the one terminal while minimized, and disposes on close/unmount.
- `ui/src/components/terminal-panel.tsx:359-417` renders one status badge, restart/close controls, and one Ghostty host through `CollapsibleBottomPanel`.
- `ui/src/components/collapsible-bottom-panel.tsx:141-224` keeps its header/actions visible while collapsed and can keep children mounted. Its existing `actions` slot is sufficient for a visible terminal tab strip; no generic panel API change is required unless implementation styling reveals an overflow issue.
- `ui/src/routes/agents.$agentId.index.tsx:13-22` loads `AgentDetailsResponse`, including the canonical agent `cwd` displayed at lines 83-97.
- `ui/src/routes/agents.$agentId.browser.$.tsx:92-128` already loads both `fullPath` and `lsResult`. `fullPath` is the canonical target path: it is `cwd` at browser root, `cwd/relativePath` for relative browser paths, or the absolute path itself.
- `ui/src/routes/agents.$agentId.browser.$.tsx:142-218` distinguishes directory and file views with `isLsDirectoryResponse` and `isLsFileResponse`; the same typed distinction should drive terminal cwd selection.
- `ui/src/api-client.ts:159-169` currently creates the browser terminal WebSocket URL with only `rows` and `cols`.
- `src/server/terminals.rs:41-70` parses those dimensions and starts terminal setup; `run_browser_setup` at lines 119-173 creates the rendezvous and sends `OpenTerminalRequest`.
- `src/actors/router/messages.rs:199-206`, `src/actors/router/agents.rs:174-191`, and `src/types.rs:265-271` carry the terminal bootstrap over the existing control plane.
- `src/agent/protocol.rs:196-244` dispatches each bootstrap as an independent task, so the backend already supports concurrent terminal sessions.
- `src/agent/terminal.rs:58-137` opens the dedicated socket and spawns the shell, currently inheriting the agent process directory because `start_pty` does not call `current_dir`.
- `tests/terminal.test.ts:36-133` provides bounded WebSocket/PTY helpers; its current end-to-end tests prove streaming, resize, early input, and teardown.
- `ui/e2e/terminal.spec.ts:13-114` covers the old single-terminal lazy/minimize/close behavior and must be rewritten around the zero-tab and multi-tab model.

## Resolved Design

### State Ownership

Keep `TerminalPanel` as the agent-scoped owner, but split one terminal's imperative lifecycle into a private child component in the same file. Avoid introducing global/Jotai terminal state: sessions are intentionally ephemeral, and component unmount remains the authoritative cleanup mechanism.

Use a small render model in `ui/src/components/terminal-panel.tsx`:

```ts
type TerminalState =
    | { type: "not_started" }
    | { type: "initializing" }
    | { type: "connecting" }
    | { type: "connected" }
    | { type: "disconnected"; message: string };

type TerminalTab = {
    id: number;
    title: string;
    cwd: string;
    state: TerminalState;
};
```

`TerminalPanel` owns:

- `tabs: TerminalTab[]`, initially `[]`.
- `activeTabId: number | null`, initially `null`.
- `isCollapsed`, initially `true`.
- `nextTabIdRef`, initially `1`, incremented on every creation and never decremented.
- Tab creation, selection, close-neighbor selection, the active status badge, active restart action, and panel collapse behavior.

Each private `TerminalSession` owns exactly the refs and lifecycle currently held by `TerminalPanel` at `ui/src/components/terminal-panel.tsx:76-342`:

- Host element.
- Ghostty terminal and fit addon.
- Dedicated WebSocket.
- Ghostty disposables and WebSocket listener cleanup.
- Generation counter for stale async initialization.
- `stateRef` used by asynchronous event handlers.

The child receives `agent`, immutable `tabId`, immutable `cwd`, `isActive`, `isPanelCollapsed`, `restartGeneration`, and an `onStateChange` callback. Do not destructure props, per the project UI convention.

Keep this split in `terminal-panel.tsx`; the lifecycle is specific to the panel and does not yet justify another public component/module.

### Creation And Startup

The `+` handler must read the current `props.cwd` at click time and append one immutable tab snapshot:

```tsx
const createTerminal = () => {
    const id = nextTabIdRef.current;
    nextTabIdRef.current += 1;
    setTabs((currentTabs) => [
        ...currentTabs,
        {
            id,
            title: `Terminal ${id}`,
            cwd: props.cwd,
            state: { type: "not_started" },
        },
    ]);
    setActiveTabId(id);
    setIsCollapsed(false);
};
```

Render all tab sessions with stable `key={tab.id}` values. Start a session in a child effect only when its state is `not_started`, it is active, and the panel is expanded. The newly created tab is immediately active and expanded, so it starts once its measurable host is rendered. This preserves user-triggered Ghostty initialization while removing the old extra Expand step.

Do not start inactive `not_started` sessions. That state can occur only briefly during React rendering or explicit restart; when selected and visible, its effect starts it.

Continue to use the memoized `initializeGhostty()` in `ui/src/terminal/ghostty.ts`; concurrent tab starts must share the one WASM initialization promise.

### Tab Switching And Visibility

Render one panel per tab and keep every child mounted. Mark only the active panel visible; inactive panels use the HTML `hidden` attribute and `aria-hidden`, while the active panel has `role="tabpanel"` and an `aria-labelledby` link to its tab.

Changing `activeTabId` must not alter a child's generation or resource refs. When a connected child transitions from inactive/collapsed to active and expanded, schedule one `requestAnimationFrame`, verify that it is still active/current, then call `fitAddon.fit()` and `terminal.focus()`. Do not focus a terminal that becomes ready after the user has already selected another tab.

`fitAddon.observeResize()` may remain enabled for each mounted host, but explicit fit-on-activation is mandatory because hidden elements are not measurable. Resize messages continue to be emitted only through each child's own open socket.

### Closing And Restarting

Closing is implemented by removing the tab from `tabs`; React child unmount then runs the existing generation invalidation and `disposeResources`, which closes only that tab's socket and disposes only that Ghostty instance.

Use this deterministic selection policy when closing the active tab:

1. Select the tab immediately to its right if one exists.
2. Otherwise select the tab immediately to its left.
3. If no tabs remain, set `activeTabId` to `null` and collapse the panel.

Closing an inactive tab leaves `activeTabId` unchanged. Do not renumber remaining labels.

Keep unexpected-disconnect behavior per tab. The active tab displays its disconnected status and alert. The header's Restart action targets only the active disconnected tab. Implement restart with a per-tab numeric generation/token in parent state or an equivalent explicit child command; incrementing it must make that child dispose its old resources, reset to `not_started`, and start again with the same immutable cwd. Do not remount the tab merely to restart, because the stable tab identity and title should remain intact.

The status badge reflects only the active tab:

- With no tabs: `No terminals` using the neutral style.
- Active initializing/connecting: `Connecting`.
- Active connected: `Connected`.
- Active disconnected: `Disconnected`.

There is no separate panel-wide Close button. Every tab has its own close control, which makes the target unambiguous.

### Tab Bar And Accessibility

Place the terminal tab strip in `CollapsibleBottomPanel`'s existing `actions` slot so it remains visible while the panel is collapsed. The visual order must be:

```text
[Terminal 1] [x] [Terminal 2] [x] [+]
```

The plus button must be in the same non-wrapping horizontal flex row immediately after the mapped tab groups, not right-aligned separately. Allow the strip to scroll horizontally on narrow viewports rather than wrapping tabs into multiple rows. Keep Restart after the strip; `CollapsibleBottomPanel` adds its own separator and Expand/Minimize button after all actions.

Accessibility requirements:

- The labels container uses `role="tablist"` and `aria-label="Terminal tabs"`.
- Each label control uses `role="tab"`, `id`, `aria-selected`, and `aria-controls`.
- Tab activation works by click/Enter/Space through native buttons.
- Add ArrowLeft/ArrowRight keyboard navigation within the tab list, wrapping at the ends and moving focus/selection together.
- The close control is a sibling of the tab button, not a button nested inside another button. Use `aria-label="Close Terminal N"` and `title`.
- The plus control uses `aria-label="New terminal"` and `title="New terminal"`.
- Each host gets a unique name such as `Terminal 2 for agent1_src`; do not reuse the current identical `Terminal for {agent}` labels for multiple mounted hosts.
- The selected panel uses `role="tabpanel"`; inactive panels are hidden from the accessibility tree.
- Show the active disconnected message with `role="alert"` as today.
- Expose each tab's cwd in a `title` or concise accessible description so users can distinguish terminal origins without putting long paths into every visible label.
- Do not select UI elements by class name in Playwright.

If the existing generic action wrapper at `ui/src/components/collapsible-bottom-panel.tsx:191-208` prevents horizontal shrinking/scrolling, make only the minimal layout adjustment (`min-w-0`/overflow containment) there. Do not add terminal-specific concepts to the shared panel API.

## Current Directory Derivation

### Route Data In The Root Layout

Update `RootLayout` in `ui/src/routes/__root.tsx:199-225` to derive a terminal cwd from the currently committed route matches with TanStack Router's typed `useMatches` selector. Do not parse `location.pathname`, duplicate file-browser path joining, issue an additional details request, or synchronize route data through an effect/atom.

Use the generated route IDs from `ui/src/routeTree.gen.ts:59-66`:

- `/agents/$agentId/` loader data is `AgentDetailsResponse`; return `.cwd`.
- `/agents/$agentId/browser/$` loader data contains `fullPath` and `lsResult`.
- If browser `lsResult` is a directory, return `fullPath`.
- If browser `lsResult` is a file, return `getParentPath(fullPath)`.

Conceptual selector:

```tsx
const terminalCwd = useMatches({
    select: (matches) => {
        const browserMatch = matches.find(
            (match) => match.routeId === "/agents/$agentId/browser/$",
        );
        if (browserMatch) {
            return isLsFileResponse(browserMatch.loaderData.lsResult)
                ? getParentPath(browserMatch.loaderData.fullPath)
                : browserMatch.loaderData.fullPath;
        }

        const detailsMatch = matches.find(
            (match) => match.routeId === "/agents/$agentId/",
        );
        return detailsMatch?.loaderData.cwd ?? null;
    },
});
```

Use TypeScript's route-match narrowing directly if the generated union supports it. If `find` loses discrimination, use a small commented structural type guard in `__root.tsx`; do not use `as any`, non-null assertions, or import a child route module into the root route (which would create an avoidable root/child module cycle).

Pass the resolved value to `TerminalPanel`:

```tsx
{activeAgent && terminalCwd ? (
    <TerminalPanel
        key={activeAgent.id}
        agent={activeAgent}
        cwd={terminalCwd}
    />
) : null}
```

On normal agent routes, child loader data is available before the route renders. If route loading fails and no trustworthy cwd exists, do not offer a terminal with a guessed directory.

### Parent Path Utility

Update `getParentPath` in `ui/src/utils/path.ts:1-9` so an absolute file directly beneath filesystem root maps to `/`, not `null`. Preserve existing relative behavior:

```ts
export function getParentPath(path: string): string | null {
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === "") return null;

    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    if (lastSlashIndex === -1) return null;
    if (lastSlashIndex === 0) return "/";
    return normalizedPath.slice(0, lastSlashIndex);
}
```

This handles both ordinary paths such as `/work/project/file.txt -> /work/project` and the root edge case `/file.txt -> /` without Node-only path helpers in browser code.

## End-To-End Cwd Propagation

Do not implement cwd by typing `cd` into the terminal after startup. That would race shell initialization, mutate visible scrollback, depend on shell syntax, mishandle arbitrary path characters, and fail before-shell semantics. Carry cwd in the one-time terminal bootstrap and apply it to the spawned process.

### UI URL

Change `Agent.getTerminalWebSocketUrl` at `ui/src/api-client.ts:159-169` to require both dimensions and cwd. A two-argument API is the smallest change:

```ts
getTerminalWebSocketUrl(size: TerminalSize, cwd: string): string {
    // existing URL construction
    url.searchParams.set("rows", String(size.rows));
    url.searchParams.set("cols", String(size.cols));
    url.searchParams.set("cwd", cwd);
    return url.toString();
}
```

`URLSearchParams` must perform all encoding so spaces, `#`, `&`, Unicode, and absolute-path slashes survive correctly. Update every caller; do not keep an optional fallback because cwd is required for every new terminal after this protocol change.

Each `TerminalSession` calls this method with its immutable `props.cwd`, not the panel's latest route cwd.

### Server Bootstrap

In `src/server/terminals.rs`:

- Add `cwd: String` to `TerminalQuery` at lines 41-46.
- Pass it from `browser_terminal_websocket_handler` through `run_browser_setup` at lines 48-70 and 119-125.
- Add it to `OpenTerminalRequest` construction at lines 143-153.
- Keep dimensions validated before upgrade. Cwd existence/type is authoritatively checked when the agent spawns the shell; the server must not perform synchronous or local filesystem checks against its own filesystem.
- Keep same-origin and message-size behavior unchanged.

In `src/actors/router/messages.rs:199-206`, add `pub cwd: String` to `OpenTerminalRequest`. In `src/actors/router/agents.rs:174-191`, move that cwd into `Message::TerminalOpen` along with ID, token, and size.

In `src/types.rs:265-271`, extend the existing control-plane variant:

```rust
TerminalOpen {
    terminal_id: crate::terminal_protocol::TerminalId,
    token: String,
    size: crate::terminal_protocol::TerminalSize,
    cwd: String,
},
```

Cwd remains a small control-plane string. Terminal bytes continue to use dedicated WebSockets, so this does not affect streaming responsiveness or memory bounds.

### Agent Spawn

In `src/agent/protocol.rs:196-244`, destructure `cwd` from `Message::TerminalOpen`, move it into the spawned task, and pass it to `terminal::connect_and_run`.

In `src/agent/terminal.rs`:

- Add a `cwd: String` argument to `connect_and_run` at lines 58-64.
- Pass `&cwd` into `start_pty` at lines 86-96.
- Add a cwd parameter to `start_pty` at lines 109-137.
- Apply `.current_dir(cwd)` to `pty_process::Command` before `.kill_on_drop(true)` at lines 122-129.

Conceptual spawn code:

```rust
let command = pty_process::Command::new(shell)
    .env("TERM", "xterm-256color")
    .env("COLORTERM", "truecolor")
    .current_dir(cwd)
    .kill_on_drop(true);
```

`pty-process 0.5.3` exposes this async-command wrapper method, and spawning remains nonblocking through Tokio. If the path no longer exists, is a file, or is inaccessible by the agent user, spawn fails through the existing setup-error path at `src/agent/terminal.rs:98-105`; do not silently fall back to the agent cwd because that would violate the tab's displayed origin.

No `#[ts(export)]` type changes are needed: cwd is added to the internal `Message`/router bootstrap and the browser WebSocket query, not to a generated REST response or terminal data-plane message.

## UI Lifecycle Details

Refactor `ui/src/components/terminal-panel.tsx` in this order:

1. Keep `parseServerMessage` and `getServerDisconnectMessage` unchanged; they are shared by all child sessions.
2. Add `TerminalTab` and any restart token field needed by the parent.
3. Turn exported `TerminalPanel` into the tab/panel owner and add required `cwd: string` to its props.
4. Move resource refs and lifecycle methods (`updateTerminalState`, `disposeResources`, setup failure, disconnected state, startup, socket handlers, cleanup) into private `TerminalSession`.
5. Report child state changes to the parent so the corresponding tab and active badge update without conflating other tabs.
6. Guard stale initialization with the existing generation checks. Closing one child during shared Ghostty initialization must never allow its continuation to create a socket later.
7. Render all children, hide only inactive ones, and refit/focus only the selected visible child.
8. Add tab creation, selection, keyboard traversal, close-neighbor selection, and restart targeting.
9. Replace the single close action with per-tab close controls and replace the old initial `Not started` launcher with the empty tab strip plus `No terminals` badge.
10. Keep panel resize behavior and `defaultExpandedHeight={400}` unchanged.

Important race handling:

- If tab A is connecting and the user selects tab B, A may finish connecting but must not steal focus.
- If tab A is closed while awaiting `initializeGhostty()` or animation frame, its generation check must stop terminal/socket creation.
- If active tab A is closed, select the replacement tab in the same state update so the replacement is refit on the next frame.
- If Restart is clicked repeatedly, the child's state/generation guard must permit only one replacement startup.
- If the panel is minimized while startup is pending, let startup complete and keep the session alive, but do not focus or fit against a hidden host until re-expansion.
- Parent state callbacks from an unmounted/stale child generation must be ignored. Include the tab ID in every callback and update only if that tab still exists.

## Tests

All added assertions must have comments explaining the protected behavior, per `AGENTS.md`. Do not use sleeps; wait for typed lifecycle messages, WebSocket events, visible status, or deterministic shell markers.

### Terminal Tunnel Integration

Update `tests/terminal.test.ts`:

- Change `openTerminal` at lines 36-71 to accept a required cwd (defaulting only inside the test helper to `agentCwd` for concise existing calls) and pass it to `getTerminalWebSocketUrl`.
- Update the pre-ready direct URL call at lines 192-197 with `agentCwd`.
- Create a nested directory under `agentCwd` with Node filesystem setup.
- Add a focused test that opens a terminal with that nested directory, sends `printf '__REDOOR_CWD__%s__\n' "$PWD"`, waits through the existing bounded rolling matcher, and asserts the exact nested path appears between markers. This proves UI/server/router/agent bootstrap cwd reaches process spawn rather than merely appearing in a URL.
- In the cwd test, open a second terminal simultaneously with a different cwd before closing the first and verify each reports its own expected `$PWD`. This protects independent concurrent session configuration and catches accidental shared mutable cwd state.
- Keep `onTestFinished()` for every socket and retain bounded output accumulation.
- Keep the existing streaming, resize, process-group teardown, and pre-ready tests intact.

An optional invalid-cwd assertion is useful but not required for the user behavior. If added, assert a typed `error` lifecycle and no `ready`, without depending on the exact internal OS error text.

### Playwright UI Coverage

Rewrite/expand `ui/e2e/terminal.spec.ts` around the new semantics. Capture terminal WebSockets as today and parse `new URL(socket.url()).searchParams.get("cwd")` for deterministic cwd assertions.

Cover these scenarios:

1. Navigate to `/agents/{id}/browser` and assert the `Terminal tabs` tablist and `New terminal` button are visible, there are zero terminal tabs, the status is `No terminals`, and no terminal WebSocket exists. This protects the required empty initial state.
2. Fetch the agent details through Playwright's request API to obtain its canonical `cwd`, click `New terminal`, and assert `Terminal 1` is selected, the panel expands, status reaches `Connected`, exactly one socket exists, and its `cwd` query equals the agent cwd.
3. Minimize and expand with Terminal 1 live; assert no second socket is created and the unique host retains the existing caret-color protection.
4. Navigate the file browser into `ctx.testDirName`, click `New terminal`, and assert Terminal 2 is selected and its socket cwd is `${agentCwd}/${ctx.testDirName}`. Assert Terminal 1 remains present and its socket does not close.
5. Switch between Terminal 1 and Terminal 2 and assert no sockets are opened/closed. Verify `aria-selected` and visible tabpanel/host follow selection.
6. Open `file1.txt`, click `New terminal`, and assert Terminal 3's socket cwd is still the containing test directory, proving open files use their parent.
7. Close an inactive tab and assert only that socket closes while selection and the other sockets survive.
8. Close the active last-position tab and assert the left neighbor becomes selected. Close all remaining tabs and assert zero tabs plus `No terminals`, with every socket closed.
9. Create two terminals, switch to `agent2_custom`, and wait for both sockets to close. Assert the new agent panel starts with no tabs and does not eagerly open a socket.
10. Navigate to Transfers and assert the Terminal heading/panel is absent, preserving route scoping.

Keep selectors accessibility-based. Do not inspect Ghostty canvas text for cwd; Playwright verifies route-to-query selection, while `tests/terminal.test.ts` verifies query-to-PTY behavior.

### Focused Rust Coverage

No new Rust-only unit test is required if the TypeScript integration cwd test exercises the real process. Preserve existing protocol dimension and server-origin tests. If a helper is extracted to build `Message::TerminalOpen`, add a serialization assertion for the cwd field only if that helper otherwise warrants a unit test; do not add a helper solely for testing.

## Exact Files To Modify

- `ui/src/routes/__root.tsx:1-38,199-225` - import `useMatches`, `isLsFileResponse`, and `getParentPath`; derive committed-route cwd and pass it to the agent-keyed panel.
- `ui/src/utils/path.ts:1-9` - make absolute root a valid parent directory.
- `ui/src/api-client.ts:159-169` - require cwd and encode it in the terminal WebSocket query.
- `ui/src/components/terminal-panel.tsx:17-419` - refactor into tab owner plus per-tab session lifecycle; add tab bar, selection, close/restart, unique hosts, and per-tab cwd.
- `src/server/terminals.rs:41-70,119-153` - parse and forward cwd in terminal setup.
- `src/actors/router/messages.rs:199-206` - carry cwd in `OpenTerminalRequest`.
- `src/actors/router/agents.rs:174-191` - forward cwd in `Message::TerminalOpen`.
- `src/types.rs:265-271` - add cwd to the internal terminal bootstrap variant.
- `src/agent/protocol.rs:196-244` - dispatch cwd to the terminal task.
- `src/agent/terminal.rs:58-137` - pass cwd through setup and apply it with `Command::current_dir`.
- `tests/terminal.test.ts:36-210` - update URL calls and verify concurrent terminals start in their requested directories.
- `ui/e2e/terminal.spec.ts:13-114` - replace single-launcher expectations with zero-state, multi-tab, cwd snapshot, selection, close, minimize, and route teardown coverage.

`ui/src/components/collapsible-bottom-panel.tsx:168-208` should change only if needed to let the tab strip shrink/scroll on mobile; the existing action slot and always-visible collapsed header already support the design.

## Files Not To Change

- Do not change `ui/src/routes/agents.$agentId.browser.$.tsx`; its loader already exposes the canonical data needed by the root.
- Do not change `ui/src/routeTree.gen.ts`; no route is added or modified.
- Do not change `src/terminal_protocol.rs` or generated files under `bindings/`; the dedicated data-plane controls remain resize/ready/error/exit only.
- Do not add persistence storage, Jotai atoms, REST endpoints, shell commands for `cd`, or backend terminal registries beyond the existing per-session structures.

## Validation Sequence

During implementation, run focused checks first:

```sh
pnpm run test -- terminal
pnpm run playwright -- terminal.spec.ts
cargo test terminal
pnpm run types
```

No `scripts/generate-ts-bindings` run is required because no `#[ts(export)]` struct or enum changes. No `cd ui && pnpm run build` route regeneration is required because route definitions do not change. If implementation departs from this plan and updates an exported Rust type or route, run the corresponding required generation command immediately.

Finally run the mandatory repository-wide command:

```sh
./scripts/build-and-test
```

If a test fails, inspect `./log` before changing behavior. Confirm formatting, lint, clippy, all Rust/TypeScript tests, and Playwright pass.

## Completion Criteria

- Agent routes initially show a visible empty terminal tab bar with `+` and allocate no terminal resources.
- Every click on `+` creates and selects exactly one independent terminal.
- New terminals start in agent cwd, the browsed directory, or an open file's parent as appropriate at creation time.
- Existing terminal cwd and session state do not change when browser navigation changes.
- Multiple tabs stay connected while inactive and while the panel is minimized.
- Tab selection refits/focuses only the selected terminal and never creates another socket.
- Closing/restarting one tab cannot affect another tab.
- Closing the final tab restores the zero-terminal state.
- Agent/route changes and refresh destroy every relevant PTY and do not restore tabs.
- Tab controls and panels expose correct ARIA relationships and keyboard navigation.
- Cwd is safely URL-encoded, forwarded through server/router/control-plane setup, and applied before shell spawn.
- Invalid cwd never silently falls back to a different directory.
- Terminal bytes remain on dedicated bounded streams, so multiple active tabs do not block ordinary control commands or file transfers.
- Focused integration/UI tests and `./scripts/build-and-test` pass.
