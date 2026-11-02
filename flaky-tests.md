# Flaky tests

## tests/agent-reconnect.test.ts › Agent connection recovery › abandons a blackholed socket and reconnects after traffic resumes

- 2026-11-01: `Timeout waiting for agent-side stale connection detection` after 10 s during a full `pn test` run under parallel load. Passed on rerun on its own.
