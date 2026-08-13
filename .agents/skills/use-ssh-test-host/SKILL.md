---
name: use-ssh-test-host
description: Use when adding, changing, or running tests that need a real SSH host, REDOOR_SSH_TEST, redoor-ssh-test, password SSH login, or cleanup of the shared SSH test server.
---

# Use the SSH test host

`redoor-ssh-test` is a shared, stateful server used only for real SSH command tests. It is available when `REDOOR_SSH_TEST` is set. Do not treat it as an ephemeral container.

## When to use

- Writing or updating gated real-SSH integration or Playwright tests.
- Debugging failures in `tests/real-ssh.test.ts` or the Playwright SSH-agent workflow.
- Adding password-authenticated SSH coverage.

Skip this host for unit tests and for local/in-process agent tests.

## Fixture

| Item | Value |
| --- | --- |
| Enable tests | `REDOOR_SSH_TEST=1` |
| SSH host alias | `redoor-ssh-test` |
| Key-auth user | `redoor` |
| Password-auth user | `redoor-password` |
| Password | `REDOOR_SSH_TEST_PASSWORD` |

The `redoor` user logs in with the configured SSH key and no password. Use it for the default agent, relay, and cleanup paths.

The `redoor-password` user requires a password. Read it from `REDOOR_SSH_TEST_PASSWORD`. Never hardcode the password. Use this user only when the test is specifically covering password login.

The host alias's default SSH user is wrong on purpose. Always pass the user explicitly:

```bash
ssh -l redoor redoor-ssh-test whoami
```

In Redoor TOML and the add-agent form, set both `target = "redoor-ssh-test"` and `username = "redoor"` (or `redoor-password`). Do not rely on `user@host` defaults or OpenSSH config.

## Gate tests

Skip unless the fixture is enabled:

```ts
describe.skipIf(process.env.REDOOR_SSH_TEST !== "1")("real SSH", () => {
    // ...
});
```

Playwright:

```ts
test.skip(
    process.env.REDOOR_SSH_TEST !== "1",
    "redoor-ssh-test SSH fixture is not enabled",
);
```

Run enabled tests with `mise exec -- env REDOOR_SSH_TEST=1 pn test`. Password tests also need `REDOOR_SSH_TEST_PASSWORD` in the environment.

## Clear state first

The server keeps processes, PID files, homes, and `/tmp` artifacts across runs. Always clean the remote state before starting a test, then clean again in `onTestFinished()`.

Reuse or follow the helpers in `tests/real-ssh.test.ts`:

- Isolate every run with a unique remote root such as `/tmp/redoor-…-${pid}-${Date.now()}`.
- Isolate remote agent namespaces with unique `REDOOR_APP_NAME` / `agent_app_name` values.
- Before start: kill leftover agent PIDs under `$HOME/.local/share/<app>/agent.pid`, remove those app directories, and remove this test's remote root.
- After finish: stop local relays/servers, then repeat the remote cleanup.
- Use `onTestFinished()` for cleanup. Do not use `try/finally` for a single test.

Do not leave agents, relays, or files behind. A later test on the same host will otherwise see stale PIDs or files.

## Existing coverage

- `tests/real-ssh.test.ts`: named relays and TOML-managed SSH agents via key auth.
- `ui/e2e/agent-management.spec.ts`: form-created SSH agent through `redoor-ssh-test` as `redoor`.

Prefer extending those files over adding another live-SSH suite unless the new behavior is unrelated.

## Conventions

- Run commands through `mise exec --`.
- Never `sleep` in tests. Wait for a log line or poll an API.
- Comment assertions with why they exist.
- After changes, run `mise exec -- env REDOOR_SSH_TEST=1 pn test` with a timeout of at least 300 seconds.
