# Flaky tests

(End of file - total 7 lines)

- 2026-08-20: `server-logs.spec.ts` timed out finding the Server logs navigation link during a targeted Playwright prerequisite run; the full `pnpm test` rerun passed.
- 2026-08-20: `file-edit-vim.spec.ts` timed out finding Editor options during an isolated `--no-deps` run; the full `pnpm test` rerun passed.
- 2026-08-23: `file-edit-vim.spec.ts` failed to restore editor focus after returning from the terminal with Alt+e; the full `pnpm run playwright` rerun passed.
- 2026-08-23: `file-detail.spec.ts` timed out creating a one-time shareable link during `pn test`; the full `pnpm run playwright` rerun passed.
- 2026-08-23: `file-detail.spec.ts` timed out displaying the existing file-size details during `pn test`; a targeted rerun passed.
- 2026-08-23: `file-detail.spec.ts` timed out navigating to a nested file detail view during `pn test`; the subsequent Playwright run cleared that failure.
- 2026-08-23: `copy-operations.spec.ts` timed out waiting for the New directory button to stabilize during `pn test`; the full `pnpm run playwright` rerun passed.
