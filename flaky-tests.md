# Flaky tests

## 2026-11-04 `ui/e2e/upload-conflicts.spec.ts` › should replace an existing directory with the uploaded one

- Failed once in the full `pn test` run: the Upload dialog stayed open after clicking "Upload 1 item" (`confirmUpload` expected the dialog to close within 5 s). Passed three separate reruns.
- Suspected cause: the dialog disabled Upload during every listing refetch, and `routes_changed` events from parallel specs refetch open listings, so the click could land while the button was briefly disabled.

## 2026-11-04 `tests/resumable-transfers.test.ts` › MCP defaults to resuming a paused copy

- Timed out after 10 s during the full `pn test` run alongside Playwright and the serial integration lane while validating Shift-click file selection.
- Passed when rerunning `pn integration-test tests/managed-daemons.test.ts tests/resumable-transfers.test.ts` (all resumable-transfer tests passed).
- Cause remains unconfirmed; the failure occurred under full-suite load. No transfer implementation or test changes were made for the file-selection feature.
