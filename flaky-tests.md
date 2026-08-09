# Flaky tests

- `tests/watchdog.test.ts > Watchdog supervisor > intentionally shuts down and can restart a managed agent` failed because the old PID was briefly still observable, then passed on an immediate targeted retry (2026-08-09).
- `tests/watchdog.test.ts` stale-WebSocket restart and managed lifecycle cases timed out while the shared test binary was being rebuilt concurrently, then all 86 Vitest tests passed when rerun without a concurrent build (2026-08-09).
