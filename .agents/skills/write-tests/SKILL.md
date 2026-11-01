---
name: write-tests
description: Use when writing or changing integration tests in `tests/` or Playwright specs in `ui/e2e/`.
---

# Write Tests

Tests run under heavy parallel load (`pn test` runs the Playwright and integration suites side by side), so any assumption about relative timing will eventually fail.

## Isolation

- Integration test files run concurrently in several workers (see `integration-test-lanes.ts`). Use `VITEST_SERVER_PORT` (never `testPorts.vitest`) and per-file names for agents, logs and data dirs. Files that use the shared SSH test host go into `SERIAL_INTEGRATION_TEST_FILES`.
- Playwright specs in `ui/e2e/` run in parallel and must use their own fixtures and directories. Specs that mutate state shared by all specs (server or agent restarts, the device list, user settings such as theme, the hidden-file filter, bookmarks or pins, ...) go in `ui/e2e/serial/` with a top comment saying why; they run one at a time after the parallel specs.
- Tests own their environment: a fixture shell instead of the user's shell, dedicated credentials for rate-limited APIs, per-file dirs and names, and no reuse of HTTP connections across a server restart.

## Timing

- Never assume one operation is slower or faster than another. To observe an in-flight state, hold it open explicitly (held Playwright route, FIFO, toxiproxy, paused clock) and release it from the test.
- Never test expiry or retention with short real-time lifetimes; inject aged timestamps instead.
- Wait for every independent side effect you assert on, not just the first one to appear. Before asserting absence or cleanup, first observe the thing existing or an explicit acknowledgement.
- Hook and test timeouts must be longer than the wait budgets inside them.

## Playwright

- Do not select by class names. Add aria attributes when there is no text to select with.
- Use exact locators when stale results could also match.
- After a UI mutation, wait for the persisted state (the write's response, or read it back from the API) before `page.goto`/`reload`. Optimistic UI updates do not prove the server saved anything, and navigation aborts in-flight writes.
- After navigation, wait for content unique to the new route (or for content unique to the old one to disappear) before interacting. The URL changes before the route loader finishes, and the keyed remount detaches the old controls.
- Specs that count requests or assert that data stays stale must call `ignoreServerEvents`: other parallel specs broadcast `routes_changed`, which refetches all mounted data at random times.
- Prefer keyboard or persistent controls over hover-only toolbars. Use `ui/e2e/background-tabs.ts` for middle-click/new-tab checks.
- A retry inside `toPass` must reset state (selection, focus, open menus) so each attempt starts clean.

## Cleanup

- Teardown must tolerate partially completed setup.
- Drain intercepted routes with `page.unrouteAll({ behavior: "wait" })` before cleanup.
