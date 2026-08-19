# Flaky tests

- `ui/e2e/agent-management.spec.ts > Agent management > switches an existing agent from password auth to key auth` again reported `has_password: true` after Stop and Save during `pn test` (2026-08-18).
- `ui/e2e/agent-management.spec.ts > Agent management > switches an existing agent from password auth to key auth` again reported `has_password: true` after Stop and Save during `pn test`, then the Sync Playwright cases in the same run had already passed (2026-08-18).
- `ui/e2e/agent-management.spec.ts > Agent management > switches an existing agent from password auth to key auth` failed during `pn test`, then all 111 Playwright tests passed on the immediate rerun (2026-08-15).
