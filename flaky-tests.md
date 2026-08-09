# Flaky tests

- `tests/watchdog.test.ts > Watchdog supervisor > intentionally shuts down and can restart a managed agent` failed because the old PID was briefly still observable, then passed on an immediate targeted retry (2026-08-09).
