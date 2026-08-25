# Flaky tests

- 2026-08-25 `pn test` Playwright: `git-browser.spec.ts` failed after the test web server exited (`server exited unexpectedly with code null`), then later Playwright files failed with `ERR_CONNECTION_REFUSED` / `fetch failed`. Passed on a later full `pn test` run.
- 2026-08-25 `pn integration-test`: leftover test servers caused `Failed to bind to address 127.0.0.1:35237` and skipped/failed suites (`server is already running`). Passed on the next full `pn test` run.
