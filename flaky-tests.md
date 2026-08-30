# Flaky tests

- 2026-08-25 `pn test` Playwright: `git-browser.spec.ts` failed after the test web server exited (`server exited unexpectedly with code null`), then later Playwright files failed with `ERR_CONNECTION_REFUSED` / `fetch failed`. Passed on a later full `pn test` run.
- 2026-08-25 `pn integration-test`: leftover test servers caused `Failed to bind to address 127.0.0.1:35237` and skipped/failed suites (`server is already running`). Passed on the next full `pn test` run.
- 2026-08-29 `pn test` Playwright: `content-search.spec.ts` briefly observed two active grep requests while checking cancellation of a superseded search. All 184 Playwright tests passed on the immediate `pn playwright` rerun.
- 2026-08-30 focused and full Playwright runs: `content-search.spec.ts` again briefly observed two active grep requests while checking cancellation of a superseded search. The final full rerun passed all 185 tests.
- 2026-08-30 `pn playwright -- git-browser.spec.ts`: `content-search.spec.ts` briefly observed two active grep requests while checking cancellation of a superseded search. The exact test passed on immediate rerun.
- 2026-08-30 `pn test` Playwright: `content-search.spec.ts` briefly observed two active grep requests while checking cancellation of a superseded search. The exact test and its dependencies passed on immediate rerun.
- 2026-08-30 `pn test` integration: `agent-logs.test.ts` timed out in `uses CLI log format over environment and TOML` while conflicting processes were running. The isolated test passed after those processes were stopped.
