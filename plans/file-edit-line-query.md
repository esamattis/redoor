# File edit `?line=` scroll-to-line

High-level plan: add a query string on the file edit view so a line number scrolls CodeMirror to that line.

## Current architecture

File editing is the default file representation of the splat browser route, not a dedicated route.

- Route: `ui/src/routes/agents.$agentId.browser.$.tsx` (`/agents/:agentId/browser/<path>`)
- URL helper: `getBrowserUrl()` / `Agent.getBrowserUrl()` — path only, no search params
- View switching already uses query params via `BrowserSearch` (`view`, `diff`)
- Editor stack: `FileBrowser` → `FileEditView` → `FileEditorSurface` → `CodeEditor` (`ui/src/components/browser/code-editor.tsx`)
- Content is primed in the route loader; `FileEditView` reads it with TanStack Query
- CodeMirror (`@uiw/react-codemirror`) has `onCreateEditor` / `EditorView` but no scroll-to-line prop
- Selection already reports **1-based** lines; copy-reference uses `` path#L${startLine} ``
- `loaderDeps` is `{ view, diff }` only — extra search keys must not refetch content

## URL shape

`?line=<positive integer>`, **1-based**.

- Matches CodeMirror `doc.line(n)` and existing `#L` copy-reference
- Same query model as `?view=` / `?diff=` (not hash)
- Examples: `/agents/{id}/browser/home/user/src/app.ts?line=42`
- Apply only when `FileEditView` is shown; ignore on directories, images, Details/Sync/Git
- Validate like `BrowserSearch.diff`: keep finite integers `>= 1`; drop `0`, negatives, floats, garbage
- Do **not** add `line` to `loaderDeps`
- Preserve `line` on the legacy `?view=edit` redirect (`replaceUnsupportedOrLegacyFileView` currently wipes search)

## UI / router

1. Extend `BrowserSearch` with optional `line?: number`; parse in `validateSearch`
2. Pass `scrollToLine={search.line}` from `FileBrowser` into `FileEditView` (prop, not route imports in the editor)
3. Thread that prop through `FileEditorSurface` → `CodeEditor`
4. Do not change `getBrowserUrl()`; callers that want a line use `search: { line: N }`
5. View tabs may drop `line` — acceptable; no persist across Details/Git
6. After search-type changes: `cd ui && pnpm run build`
7. No API-client / loader / Query changes; any `useEffect` is CodeMirror-only

## CodeMirror scroll

After the view exists and content is loaded:

- Resolve `doc.line(clamped)` (1-based)
- Set caret on that line
- `EditorView.scrollIntoView` so virtualized lines enter the viewport

When:

- After first paint (content loaded + `onCreateEditor`)
- Again if `scrollToLine` changes on the same file
- Do not remount on line change (`FileEditView` key stays path-only)
- Do not re-scroll on typing, save, or dirty draft updates

Out of range: clamp to last line. Missing/invalid: no scroll. Empty file: no-op.

Keep `line` in the URL after the jump (shareable). Dirty buffer: jump uses current draft, do not discard edits.

## Call sites (v1)

None required. Feature is URL-driven (bookmarks, pasted URLs). Follow-ups, not v1:

- Git hunk / diff line → `?line=`
- Content search hits
- Copy-reference as a real editor URL instead of markdown `#L`

## Tests

Add to `ui/e2e/file-edit.spec.ts` (reuse large-file fixture; accessible names only):

1. `?line=<last>` → last line visible; page scroller does not grow
2. `?line=1` → first line visible, last still virtualized
3. `?line=99999` on a short file → clamp, no crash
4. `?line=abc` / `?line=0` → ignored
5. `?view=edit&line=N` still edits **and** scrolls (legacy redirect keeps `line`)

No REST integration tests. After implementation: Playwright then `pn test`.

## Out of scope

- Changing `getBrowserUrl` signature
- Hash `#L42` navigation
- Live URL sync as the caret moves
- Line ranges (`?line=10-20`)
- Git / search / logs auto-linking
- Scrolling non-edit views
- Refetching because `line` changed

## Open questions

- Caret move vs scroll-only (recommendation: move caret)
- Jump on a dirty editor uses draft line count — OK?
