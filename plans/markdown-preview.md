# Markdown preview in the file editor

High-level plan: render markdown files with `react-markdown`, driven by a browser query string. Opening a markdown file lands in preview. Toggling preview hides CodeMirror with CSS and never unmounts it.

## Goal

- Preview `.md` / `.markdown` files as rendered markdown.
- A toolbar Preview control writes the query string; that query string is the source of truth.
- Opening a markdown file (file list, Edit tab, direct URL with no preview param) goes to preview immediately.
- CodeMirror stays mounted while hidden so draft, caret, undo, and vim state survive.

## Current architecture

File editing is the default file representation of the splat browser route, not a dedicated route.

- Route: `ui/src/routes/agents.$agentId.browser.$.tsx` (`/agents/:agentId/browser/<path>`)
- `BrowserSearch` today: `view?`, `line?`. `validateSearch` strips unknown keys.
- Default content view (`search.view` absent) mounts `FileEditView` when `metadata.editable`.
- Switching Details / Sync / Git **unmounts** `FileEditView`. Preview must not reuse `view=`.
- `FileEditView` key is `${agentId}:${path}` — search changes do not remount if the component stays in the tree.
- Draft lives in React state; caret/undo/vim live in CodeMirror. Unmounting the editor loses those even if draft survives.
- Markdown is already a CodeMirror language via `syntaxLanguageFromFileName()` in `ui/src/utils/editor-language.ts` (`.md`, `.markdown`).
- No `react-markdown` today. UI deps live in the **repo root** `package.json`.
- Toolbar lives in `FileEditActions` (`ui/src/components/browser/file-views.tsx`). Use `ToggleButton`, not a raw `<button>`.

`view=preview` is the wrong model: `FileBrowser` would stop rendering `FileEditView` and unmount CodeMirror.

## URL shape

`?preview=true` on the existing browser route.

Tri-state, same boolean parsing style as parent `AgentSearch.hidden`:

| Query | Markdown file, content view |
| --- | --- |
| absent | Loader `replace: true` to `{ preview: true }` (opening → preview) |
| `preview=true` | Render markdown; hide editor |
| `preview=false` | Show editor; do not redirect |

- Do **not** add `preview` to `loaderDeps` (no listing/content refetch on toggle).
- Omit `preview` from non-markdown URLs; ignore it if leftover.
- Preserve `line` and parent search (`q`, `gitroot`, …) on every preview navigate. Use search updater functions, not `search={{ preview: true }}`.
- `ViewToggle` Edit tab currently sets `search={{}}`. Accept that: returning to Edit on a markdown file is an “open” and lands in preview again.
- `?line=` with preview unset: stay in the editor (`preview=false` or skip the default-preview redirect) so git/search line bookmarks still jump. Preview with an explicit `preview=true` can keep `line` unused until the user toggles back.

Examples:

- `/agents/{id}/browser/home/user/README.md` → `/agents/{id}/browser/home/user/README.md?preview=true`
- Toggle off → `?preview=false`
- `/agents/{id}/browser/home/user/README.md?line=12` → editor at line 12, not preview

## UI / router

1. Extend `BrowserSearch` with `preview?: boolean`. Parse with the same optional boolean union as `agents.$agentId.tsx`.
2. In the file-content loader, if the path is markdown, content view is wanted, and `preview` is unset: `throw redirect({ search: { preview: true, line }, replace: true })`. Mirror `replaceLegacyEditFileView`.
3. Keep rendering `FileEditView` whenever `activeView === "view" && editable`. Pass `preview={search.preview === true}` (or read search inside `FileEditView` via the browser `Route`). Prefer a prop from `FileBrowser` so the editor stays route-import free, matching `scrollToLine`.
4. Gate the toolbar control with `syntaxLanguageFromFileName(fileName) === "markdown"`.
5. `ToggleButton` (`pressed`, `label`, tooltip). Navigate with `search: (prev) => ({ ...prev, preview: next })` so `preview=false` is explicit.
6. After search-type changes: `cd ui && pnpm run build` to refresh `routeTree.gen.ts`.
7. No REST / agent / Query changes. Preview reads the existing editor draft.

## Hide without unmount

In `FileEditorSurface` (or a thin wrapper around it):

- Always mount `CodeEditor` after load success.
- Hide it with CSS (`hidden` / `invisible` + `aria-hidden`), never `{preview ? markdown : editor}`.
- Mount a sibling markdown pane only when preview is on **or** keep it mounted and hide it the same way. Prefer always mounting both after load so toggling is CSS-only.
- Give the preview an accessible name (e.g. region “Markdown preview”).
- Keep `fillAvailableHeight` / overflow on the preview pane so long docs scroll in the pane, not the page.
- Search/replace, vim, and selection still exist on the hidden editor; they do not need to work *through* the preview. Save / dirty / Ctrl+S keep working because `FileEditView` stays mounted.

## Markdown rendering

- Add `react-markdown` (and `remark-gfm` for tables, strikethrough, task lists) in root `package.json`.
- New presentational component, e.g. `ui/src/components/browser/markdown-preview.tsx`. Feed it the **draft** string (`content` in `FileEditView`), not a second fetch.
- Default `react-markdown` already skips raw HTML — keep it that way. Do not enable `rehype-raw`. Agent files are untrusted.
- No `@tailwindcss/typography` in the repo. Style headings, lists, code, blockquotes, tables, and links with Tailwind against the existing dark editor chrome (`#11141b` / slate).
- Relative images and wiki links are out of scope for v1 (broken `src` is acceptable).
- Fenced code can stay unhighlighted in v1; git diffs already use highlight.js separately.

## Tests

New Playwright workflow in `ui/e2e/markdown-preview.spec.ts` (do not select by class names):

1. Open a `.md` file from the listing → URL has `preview=true`, rendered heading/text is visible, `File editor` is attached but not visible.
2. Toggle Preview off → `preview=false`, editor visible, draft/caret still there (edit while hidden or before toggle).
3. Toggle back on → preview shows the **draft**, not only disk content.
4. Non-markdown editable file has no Preview control and no redirect.
5. `?line=` on a markdown file opens the editor, not preview.

Comment assertions with why. After implementation: `pn test` with timeout ≥ 1200s.

## Out of scope

- Preview as a `ViewToggle` tab
- Live split view
- Keyboard shortcut (add later with the keyboard-shortcuts skill if wanted)
- Server-side markdown
- Resolving relative images through the agent raw URL
