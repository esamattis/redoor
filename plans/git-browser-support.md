# Git Browser Support Plan

## Scope and semantics

- Add a route-backed **Git** tab after **Sync** in both file and directory browser views. Preserve the existing default, Details, and Sync behavior and the legacy `?view=diff` to `?view=sync` redirect.
- Use `?view=git` as the canonical URL so status entries can link directly to a file's Git view and browser history/back behavior remains consistent with the other tabs.
- Show the Git tab for every file and directory whose path is inside a discovered non-bare Git worktree, regardless of whether the exact path is tracked, untracked, or ignored. Hide it only when the path is outside a worktree.
- Classify files separately as tracked, untracked, ignored, or deleted from the worktree. An untracked file's Git view should state that it is untracked rather than synthesizing a diff; an ignored file should likewise explain that it is ignored. Direct links to deleted HEAD/index entries remain useful even when the filesystem path no longer exists.
- Discover the enclosing non-bare worktree from the requested absolute path. Support normal repositories, linked worktrees, and an unborn HEAD without assuming `.git` is a directory. Reject bare repositories for browser status/diff because they have no worktree.
- Directory Git view mirrors the useful parts of `git status .`: repository/HEAD context, staged changes, unstaged changes, untracked files, conflicts, clean state, truncation notices, and links from every returned entry to its file Git view. Omit ignored entries from the status list by default even though browsing an ignored file directly still exposes its Git tab and ignored state.
- File Git view shows one of two comparisons:
  - **Full** (default): HEAD versus the current worktree file, equivalent in intent to `git diff HEAD -- <file>` and including staged plus unstaged edits.
  - **Staged**: HEAD versus the index entry, equivalent in intent to `git diff --cached -- <file>`.
- Keep this phase read-only. Do not add stage, unstage, discard, commit, branch, or repository mutation operations.

## REST API

- Add a dedicated `src/server/git.rs` module rather than extending generic file metadata or `src/server/diffs.rs`. Git inspection belongs on the agent that owns the repository; the existing diff endpoint compares arbitrary files, potentially across agents, and has different semantics.
- Register exact and wildcard forms using the existing absolute filesystem path conventions:
  - `GET /api/v1/agents/{agent}/git/context[/{*path}]`
  - `GET /api/v1/agents/{agent}/git/status[/{*path}]`
  - `GET /api/v1/agents/{agent}/git/diff[/{*path}]?mode=full|staged`
- `context` is the inexpensive availability and classification contract used by the route loader and tab strip. Return `GitContextResponse { inside_worktree, entry_type, tracking_state, repository_root, repository_relative_path }`, with nullable `tracking_state` for directories and a generated file-state enum covering tracked, untracked, ignored, and deleted. A path outside Git returns `inside_worktree: false` rather than an error; malformed relative requests and permission failures remain errors.
- Let context discovery begin at a file's parent, or at the nearest existing parent for a deleted tracked path. This allows status links for deleted files to open a useful Git diff even though the normal filesystem listing returns 404. Existing untracked and ignored paths are classified from gix status/exclude data after discovery.
- `status` returns a structured `GitStatusResponse`, not porcelain text. Include the selected absolute directory, repository root, branch name or detached HEAD ID, upstream/ahead/behind data only if gix can obtain it without network access, `entries`, `truncated`, and `omitted_non_utf8_entries`.
- Model each `GitStatusEntry` with an absolute browser path, repository-relative display path, optional original path for renames/copies, explicit index and worktree states, conflict state, and entry kind. Use exported enums for states such as added, modified, deleted, renamed, copied, type-changed, and unmodified instead of leaking gix types.
- Return status entries under the requested directory prefix only, as literal paths rather than user-controlled Git pathspec expressions. Include individual untracked files, omit ignored entries, sort deterministically by repository-relative path, and cap the response at a named constant such as 5,000 entries. Set `truncated: true` when more entries exist.
- `diff` returns `GitDiffResponse { mode, path, result }`, where the exported tagged result distinguishes `text { unified_diff }`, `no_changes`, `untracked`, `ignored`, `binary`, `too_large`, and `unsupported_entry` (for example a submodule/gitlink). Return `untracked` or `ignored` before diff generation so the file view can explain why no Git diff exists. This also avoids treating binary or oversized content as an empty textual diff.
- Generate Git-compatible-enough unified text with `a/<path>` and `b/<path>` headers for the existing diff2html renderer. Preserve missing-final-newline markers. Represent additions/deletions with an empty side and handle unborn HEAD as an empty tree.
- Bound each diff input to the existing editable-file limit where practical and cap rendered patch bytes with a bounded writer. Never serialize an unrestricted repository diff into one WebSocket text frame. Since this endpoint compares one browser file, return `too_large` rather than introducing a transfer stream in this phase; repository-wide patch output is explicitly out of scope.
- Use the normal `ErrorResponse` and `CommandErrorKind` mappings for invalid paths, not found, permissions, unsupported repositories, and internal failures. Validate `mode` at the REST boundary and absolute paths at both REST and command boundaries.

## gix and agent implementation

- `gix = { version = "0.87.0", default-features = false, features = ["status", "parallel", "sha1"] }` is already added to `Cargo.toml` and locked. `status` supplies the status/index walk plus its attribute, exclude, and blob-diff prerequisites; `parallel` supports bounded concurrent status work; `sha1` supports standard repositories. This deliberately excludes gix networking, credentials, mutation, archive, blame, and other default features. Verify this feature set on Linux, macOS, and Android Termux during implementation.
- Add `src/commands/git.rs` for repository discovery, context classification, structured status, object/index/worktree source selection, and conversion into project-owned response types.
- Add `Command::GitContext`, `Command::GitStatus`, and `Command::GitDiff` plus matching `CommandResult` variants in `src/commands.rs`. Update command/result summaries without logging patch bodies, and dispatch them from `CommandHandler`.
- Derive `Serialize`, `Deserialize`, `TS`, and `#[ts(export)]` for every public REST request/response struct and enum. Keep gix-specific types and byte paths internal.
- Run each complete gix operation inside `tokio::task::spawn_blocking`; create and consume the thread-local repository/status iterator inside that closure because the relevant gix objects are not generally `Send`/`Sync`. Do not block Tokio/Axum workers with repository walking or diff computation.
- Use gix discovery, repository layout, HEAD/tree, index, status, object database, and attributes APIs. Do not invoke the `git` executable and do not honor repository-configured external diff or textconv commands, which could execute untrusted programs.
- Use gix to select the correct HEAD, index, and worktree resources. Use gix's blob classification/diff facilities where they provide the needed attributes and binary behavior, then serialize bounded unified hunks with a small project-owned formatter or the existing `similar` crate where gix does not provide porcelain patch formatting. Add focused formatter tests rather than trying to reproduce every `git diff` header in this phase.
- Treat symlinks and submodule gitlinks as Git entries without following them into unrelated filesystem content. Return an explicit unsupported/submodule result where a text patch is not meaningful.
- Enable rename detection only if it remains bounded and predictable with the selected gix APIs. Otherwise document and test the initial behavior as delete/add; do not add an expensive whole-repository similarity pass solely for display labels.
- Keep paths as `Path`/`OsStr` and `BStr` internally. The current browser URL/API contract is UTF-8, so omit non-UTF-8 status entries while incrementing `omitted_non_utf8_entries`; never silently return a lossy path that could link to the wrong filesystem entry.
- Wire gix status interruption support to an owned atomic cancellation flag where available, check cancellation and output limits between entries/files, and keep all result collections bounded. A dropped REST waiter cannot stop arbitrary `spawn_blocking` work by itself, so limits are still required.

## UI data flow and routing

- Import generated Git types and add `Agent.gitContext(path)`, `Agent.gitStatus(path)`, and `Agent.gitDiff(path, mode)` in `ui/src/api-client.ts`, using `appendFilesystemPath` so every public path remains absolute and component-encoded.
- Add query keys/options in `ui/src/queries.ts` for context, directory status, and file diff keyed by agent ID, canonical path, and diff mode. Git reads belong in TanStack Query rather than effects.
- In `agents.$agentId.browser.$.tsx`, accept `view: "git"`. Fetch context alongside the normal listing, and prime status or the default full file diff in the route loader only when entering the Git view so its primary content is ready at navigation time.
- Pass `gitAvailable={context.inside_worktree}` through `BrowserRouteShell`, `BrowserHeader`, and `ViewToggle`. Render Git immediately after Sync for every path inside the worktree; include it in both directory and file active-view unions and keep the tab strip horizontally scrollable on narrow screens.
- If a direct `?view=git` URL is outside a worktree, redirect to the normal default/details representation instead of leaving a hidden active tab. For a missing path that context identifies as a deleted tracked file, bypass `MissingPathCreationForm` only for `view=git` and render a file Git shell from context; all other missing-path behavior remains unchanged.
- Add `ui/src/components/browser/git.tsx` with focused directory and file views. The directory component groups entries into staged, unstaged, conflicts, and untracked sections, displays a clean state, shows branch/root context, and links every returned entry to the same browser path with `?view=git`. The file component renders explicit untracked and ignored messages before considering staged/full diff output.
- Use an existing reusable control such as `ToggleButton`/`RadioCardGroup` according to its current semantics for the **Full** versus **Staged** choice. Changing mode updates query state without an effect, keeps prior content only if it cannot be mistaken for the selected mode, and exposes loading/error/empty/binary/too-large states accessibly.
- Extend browser refresh invalidation to context/status/diff keys so focus refresh and explicit reload pick up external Git changes. Do not mutate the general listing cache in response to Git queries.

## Reusable diff renderer

- Extract `FileDiffResult` and its `diff2html` setup from `ui/src/components/browser/sync.tsx` into `ui/src/components/browser/unified-diff.tsx` (or an equivalently focused shared component).
- Keep the reusable component responsible only for converting a supplied unified-diff string to accessible, horizontally scrollable diff HTML and for the empty-text fallback. Keep mutation/query loading, errors, binary/size notices, section titles, and Sync-specific layout in each consumer.
- Move the renderer imports and `.file-diff-*` host contract with the component while preserving the existing diff2html options and current Sync visual behavior. Continue rendering only server/generated diff text; do not accept arbitrary user HTML.
- Update `SyncDiffSection` to use the extracted renderer, then use the same renderer for `GitDiffResponse.result.type === "text"`. This extraction should not pull any Sync endpoint selection, transfer state, or mutation logic into shared code.

## Tests

- Add Rust unit tests around literal path-prefix handling, repository discovery, HEAD/index membership, directory tracking, unborn HEAD, linked worktrees, staged/full source selection, conflicts, symlinks, binary classification, size/output caps, deterministic ordering, cancellation checks, and the unified patch formatter including missing final newlines.
- Add `tests/git.test.ts` with a real server and agent. Construct temporary repositories (the test harness may use `git` or gix-backed fixtures, but production requests must exercise gix) and cover clean status, modified/staged/untracked/deleted files, staged additions/deletions, nested directory filtering, ignored files, conflicts, spaces and Unicode paths, non-UTF-8 omission where supported, detached and unborn HEAD, linked worktrees, outside-repository paths, relative-path rejection, binary/oversized diff outcomes, truncation, and full-versus-staged content.
- Assert that status and diff do not execute external diff/textconv commands from repository configuration. Issue a lightweight control command while a large bounded status operation is running to verify the WebSocket control path remains responsive; poll observable state/logs rather than sleeping.
- Extend `ui/e2e/agent-view-navigation.spec.ts` to verify Git appears after Sync for tracked, untracked, and ignored files and for directories anywhere inside a worktree, remains hidden outside repositories, and remains reachable at phone width.
- Add or extend Playwright coverage (prefer a focused `ui/e2e/git-browser.spec.ts`) for the primary workflow: open directory Git status, follow a modified file link, inspect the full diff, switch to staged diff, refresh after an external change, and verify clean/binary/too-large/untracked/deleted states. Select controls through text/ARIA, not CSS classes.
- Keep existing `tests/file-diff.test.ts` and Sync Playwright assertions as regression coverage for the extracted renderer and arbitrary cross-agent diff behavior.

## Implementation sequence

1. Use the pre-added minimal gix dependency to implement and test the bounded agent-side context, status, and diff domain in `src/commands/git.rs`.
2. Add command/result variants, dedicated REST handlers/routes, error mapping, and backend integration tests.
3. Export the REST models and run `mise exec -- scripts/generate-ts-bindings`.
4. Add API-client methods, query options, route-loader integration, conditional tab visibility, and deleted-file Git routing.
5. Extract the reusable unified-diff component, implement directory/file Git views and the staged/full control, then add Playwright coverage.
6. Run `mise exec -- pnpm --dir ui run build` after route changes.
7. Run focused Rust, integration, and Playwright tests during development, then run `mise exec -- pn test` with at least a 600-second timeout. Record any transient failure that passes on rerun in `flaky-tests.md`.

## Explicit non-goals and follow-ups

- No staging, commit, checkout, reset, discard, branch, log, blame, or remote/network operations.
- No repository-wide patch download and no unbounded diff payload. If later required, add a cancellable transfer-lane streaming endpoint rather than enlarging `CommandResult` frames.
- No exact byte-for-byte emulation of every Git porcelain edge case in the first renderer. Preserve the status/diff semantics needed by the UI and explicitly represent unsupported binary, submodule, and oversized cases.
