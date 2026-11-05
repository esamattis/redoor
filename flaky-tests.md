# Flaky tests

- 2026-11-05: `tests/managed-daemons.test.ts` > managed local agent daemons > does not loop when the binary at the old server's path was replaced. Failed once in `pn test` with "Timeout waiting for daemon-running's daemon to be replaced and connect", then passed when the file was rerun alone.
