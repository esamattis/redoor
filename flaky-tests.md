# Flaky tests

## `tests/request-lifecycle.test.ts` > cancels an abandoned 'FileSearch' on the agent

- 2026-11-19: timed out after 10 s in `pn test` and passed on rerun of the file alone. The cause is unknown; it ran under the full parallel integration lane.

## `tests/agent-reconnect.test.ts` > exits a supervised agent that cannot reach its server for the stale timeout

- 2026-11-19: failed in `pn test` with "Timeout waiting for supervised agent exit diagnostic to drain from stdout" and passed on rerun of the file alone. The cause is unknown; it ran under the full parallel integration lane.
- 2026-11-20: failed the same way in `pn test` and passed on rerun of the test alone.
