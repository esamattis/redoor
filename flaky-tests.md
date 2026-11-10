# Flaky tests

## tests/raw-directory-download.test.ts > should stream a directory as a tar archive via the raw endpoint

- 2026-11-10: Timed out after 10000ms during the full parallel `pn test` run, passed in 354ms when rerun alone. Seen right after the stream frame coalescing commits (1dab17a, a72cce4).

## ui/e2e/run-in-terminal.spec.ts > Run in terminal > runs an executable script in a new terminal in its directory

- 2026-11-10: During the full `pn test` run the captured terminal input held only a resize frame instead of `./'my script.sh'\r`; the spec passed when rerun alone.
