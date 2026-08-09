# Flaky tests

- `tests/watchdog.test.ts > Watchdog supervisor > intentionally shuts down and can restart a managed agent` failed because the old PID was briefly still observable, then passed on an immediate targeted retry (2026-08-09).
- `tests/watchdog.test.ts` stale-WebSocket restart and managed lifecycle cases timed out while the shared test binary was being rebuilt concurrently, then all 86 Vitest tests passed when rerun without a concurrent build (2026-08-09).
- `ui/e2e/terminal.spec.ts > Terminal panel lifecycle > keeps independent terminal tabs in their captured directories` timed out waiting for Terminal 2 to become selected, then all 48 Playwright tests passed on the immediate rerun (2026-08-09).
- `pn integration-test` initially failed because a process left by an interrupted test run still held the shared test port, then all 88 Vitest tests passed after terminating the stale `redoor` process (2026-08-09).
