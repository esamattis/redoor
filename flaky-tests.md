# Flaky tests

## 2026-08-08

- `ui/e2e/copy-operations.spec.ts` — `Copy Operations › should copy a file to a newly created directory within the same agent` timed out waiting for the copied file during `./scripts/build-and-test`. An immediate `pnpm run playwright` rerun passed all 42 tests.
- `ui/e2e/agent-management.spec.ts` — `Agent management › shows optimistic starting state before the start request completes` timed out waiting for the connected tab during `./scripts/build-and-test`. An immediate `pnpm run playwright` rerun passed all 44 tests.
- `ui/e2e/copy-operations.spec.ts` — `Copy Operations › should copy a file to a newly created directory within the same agent` failed once during `./scripts/build-and-test` after ssh sha1/stale-agent changes; immediate `pnpm run playwright` rerun passed all 45 tests.
- `ui/e2e/copy-operations.spec.ts` — `Copy Operations › should copy a file to a newly created directory within the same agent` failed once during `./scripts/build-and-test` after config precedence CLI>env>config change; immediate `pnpm run playwright` rerun passed all 45 tests.
