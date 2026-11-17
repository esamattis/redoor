# Flaky tests

## tests/agent-reconnect.test.ts › Agent connection recovery › exits a supervised agent that cannot reach its server for the stale timeout

- 2026-11-17: The agent log did not contain `exiting so the supervisor can start a…` when the assertion ran, then passed on three reruns. The log showed only reconnect attempts to the stopped server, so the stale-timeout exit had not happened or been logged yet when the test checked.
