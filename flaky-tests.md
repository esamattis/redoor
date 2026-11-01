# Flaky tests

## ui/e2e/auth.spec.ts › Authentication › logout clears the session and returns to login

- 2026-11-01: After clicking "Log out" the page landed on `/login?redirect=%2F` instead of `/login`, failing `toHaveURL`. Likely a protected query on the home page got a 401 after the session was cleared and redirected with the current path before the logout navigation won. Passed on rerun.

## tests/agent-reconnect.test.ts › Agent connection recovery › abandons a blackholed socket and reconnects after traffic resumes

- 2026-11-01: `Timeout waiting for agent-side stale connection detection` after 10 s during a full `pn test` run under parallel load. Passed on rerun on its own.
