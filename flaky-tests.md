# Flaky tests

## ui/e2e/session-length.spec.ts > Session length > warns before the session ends and renews it on interaction

- 2026-11-11: Failed a `toHaveCount` assertion in a full Playwright run with `--trace on`; it passed in the next full `pn test` run without tracing.
