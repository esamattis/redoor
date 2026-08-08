# Flaky tests

## 2026-08-08

- `ui/e2e/copy-operations.spec.ts` — `Copy Operations › should copy a file to a newly created directory within the same agent` timed out waiting for the copied file during `./scripts/build-and-test`. An immediate `pnpm run playwright` rerun passed all 42 tests.
