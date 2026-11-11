# Flaky tests

## ui/e2e/run-in-terminal.spec.ts > Run in terminal > runs an executable script in a new terminal in its directory

- 2026-11-10: During the full `pn test` run the captured terminal input held only a resize frame instead of `./'my script.sh'\r`; the spec passed when rerun alone.
- 2026-11-10: Same failure again in the full `pn test` run (only a resize frame captured), while adding the editor's Discard changes button; passed when the spec was rerun alone.
