# Flaky tests

## 2026-11-04 `ui/e2e/upload-conflicts.spec.ts` › should replace an existing directory with the uploaded one

- Failed once in the full `pn test` run: the Upload dialog stayed open after clicking "Upload 1 item" (`confirmUpload` expected the dialog to close within 5 s). Passed three separate reruns.
- Suspected cause: the dialog disabled Upload during every listing refetch, and `routes_changed` events from parallel specs refetch open listings, so the click could land while the button was briefly disabled.
