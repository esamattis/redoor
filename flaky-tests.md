# Flaky tests

## Investigation on 2026-10-03

- Terminal focus: reproduced the recorded failure by waiting for the drawer to fully hide before reopening it with `t` (one failure in three repetitions). The drawer now reveals content in the opening render, before terminal focus effects run. All ten repetitions of the strengthened workflow passed after the fix.
- Remote copy/archive cancellation: tests now wait for destination staging to exist before interrupting. The chunked archive test also waits for the worker's `canceled` acknowledgement before asserting cleanup, avoiding an initially empty directory being mistaken for completed cleanup. All ten tests passed in five sequential runs after these changes.
- Pin reordering: the existing animation-frame pickup synchronization and committed-position polling already address the recorded races. The pin and content-search files passed three repetitions (42 tests including server-log dependencies).
- Content search and agent log format: commit `bcf0f8e` already replaced request-event-count assertions and isolated the log-format server from ambient test processes. The ten agent-log tests passed in five sequential runs alongside remote copy.
- Shared server failures: test runners already stage immutable executables and await child shutdown. Separate integration runs still share a port and must run sequentially. Overlapping integration runs during this investigation reproduced fixture collisions; those runs were stopped and rerun sequentially.
- Full validation: `pn test` passed in 414 seconds after these changes, including integration and Playwright. The Android warning check was skipped because `cargo-ndk` is not installed.

## Failure history

- 2026-10-03 `pn test` Playwright (R9 memory-retention fix): `server-home.spec.ts` failed in `shows a measuring badge until a directory archive total arrives` while waiting for the measuring-badge tooltip at line 205. Rust and integration checks passed in that run. The browser case passed in subsequent isolated fix suites and the final combined `pn test` run; no UI implementation or test change was needed.

- 2026-10-03 `pn test` Playwright (compact editor search): `terminal.spec.ts` failed in `opens or focuses the current agent terminal with t` while waiting for terminal focus at line 622. All 12 tests in the focused terminal run and its dependencies passed on immediate rerun.

- 2026-10-01 `pn test` Playwright (whole-row dragging): `pinned-files.spec.ts` failed in `reorders editor pins horizontally without resetting the draft` when the next keyboard move read the DOM before the prior optimistic Query update repainted. The workflow passed three focused repetitions after waiting for the committed row position between gestures.
- 2026-10-01 `pn test` Playwright (drag ordering): `pinned-files.spec.ts` failed in `reorders pins from the keyboard and cancels without writing` because Escape raced dnd-kit's deferred keyboard listener attachment. The focused rerun passed after synchronizing pickup with browser animation frames; keyboard workflows now share that synchronization.
- 2026-10-01 `pn test` integration (drag ordering): `remote-cp.test.ts` failed in `cancels CLI copy on interruption and removes incomplete output` because `.result.bin.redoor-upload-11760459535884571767` still existed at the cleanup assertion. The file passed on immediate rerun.
- 2026-10-01 `pn test` integration (full-window pinned editor work): `remote-cp.test.ts` failed in `cancels CLI copy on interruption and removes incomplete output` because `.result.bin.redoor-upload-3657595513438930064` still existed at the cleanup assertion. The exact test passed on immediate rerun.
- 2026-10-01 `pn test` integration (pinned-tab close actions): `remote-cp.test.ts` failed in `cancels CLI copy on interruption and removes incomplete output` and `keeps control requests responsive during chunked archives and cleans up canceled uploads` because upload staging entries remained at cleanup assertions. All 10 tests in the file passed on immediate rerun.

- 2026-10-01 `pn test` integration: `remote-cp.test.ts` failed in `cancels CLI copy on interruption and removes incomplete output` because a remote upload staging file still existed at the cleanup assertion. The exact test passed on immediate rerun.

- 2026-08-25 `pn test` Playwright: `git-browser.spec.ts` failed after the test web server exited (`server exited unexpectedly with code null`), then later Playwright files failed with `ERR_CONNECTION_REFUSED` / `fetch failed`. Passed on a later full `pn test` run.
- 2026-08-25 `pn integration-test`: leftover test servers caused `Failed to bind to address 127.0.0.1:35237` and skipped/failed suites (`server is already running`). Passed on the next full `pn test` run.
- 2026-08-29 `pn test` Playwright: `content-search.spec.ts` briefly observed two active grep requests while checking cancellation of a superseded search. All 184 Playwright tests passed on the immediate `pn playwright` rerun.
- 2026-08-30 focused and full Playwright runs: `content-search.spec.ts` again briefly observed two active grep requests while checking cancellation of a superseded search. The final full rerun passed all 185 tests.
- 2026-08-30 `pn playwright -- git-browser.spec.ts`: `content-search.spec.ts` briefly observed two active grep requests while checking cancellation of a superseded search. The exact test passed on immediate rerun.
- 2026-08-30 `pn test` Playwright: `content-search.spec.ts` briefly observed two active grep requests while checking cancellation of a superseded search. The exact test and its dependencies passed on immediate rerun.
- 2026-08-30 `pn test` integration: `agent-logs.test.ts` timed out in `uses CLI log format over environment and TOML` while conflicting processes were running. The isolated test passed after those processes were stopped.
