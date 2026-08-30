# Button-triggered Git directory diffs

## Goal

Replace the directory Git view's `?diff=true` navigation with an in-place **Load all diffs** button. Automatically activate that same button when it intersects the viewport only when the ordered, de-duplicated changed-file count is below 50; 50 or more files must remain click-only.

## Current flow

- `ui/src/routes/agents.$agentId.browser.$.tsx` declares `BrowserSearch.diff`, includes it in `loaderDeps`, prefetches the batch through `gitDiffQueryOptions()` when `diff=true`, and threads `showDiffs` through `DirectoryBrowserPage` to `GitDirectoryView`.
- `ui/src/components/browser/git.tsx::GitDirectoryView` derives `groups.diffEntries`, enables its existing TanStack Query only when `showDiffs` is true, and renders **Load all diffs** as a router `Link` to `{ view: "git", diff: true }`.
- `ui/src/queries.ts::gitDiffQueryOptions` already provides the desired ordered cache identity (`agent`, ordered file array, mode) and infinite stale time; `Agent.gitDiff()` already posts the batch. No API, binding, server, or query-key change is needed.
- `ui/e2e/git-browser.spec.ts` currently asserts link navigation to `diff=true` and then verifies batch ordering/rendering.

## Implementation

### Route and URL cleanup

Update `ui/src/routes/agents.$agentId.browser.$.tsx`:

1. Remove `diff` from `BrowserSearch`, `validateSearch`, and `loaderDeps`; retain `view` as the Git loader dependency and keep `line` out of loader dependencies as today.
2. Remove the directory-only `deps.diff` prefetch block and the now-unused route import of `groupGitStatusEntries`. Keep `gitDiffQueryOptions` because file Git views and deleted-file handling still prefetch one-file diffs.
3. Remove `showDiffs` from `FileBrowser` -> `DirectoryBrowserPage` -> `GitDirectoryView`; directory diff activation becomes component-local and no button interaction invokes TanStack Router.
4. Canonicalize stale direct/bookmarked `diff` parameters in the route loader: after the existing legacy `view=diff` redirect, detect `diff` in `location.searchStr` and replace-navigate to the same route with only the validated `view` and valid `line`. Thus old `?view=git&diff=true` no longer loads diffs or remains in the address bar, while unrelated supported search state is preserved. Do not otherwise preserve or interpret the old value.

### Activation, observer, and query state

Update `ui/src/components/browser/git.tsx::GitDirectoryView`:

1. Replace `props.showDiffs` with local activation state keyed to `${props.agent.id}:${props.path}` rather than a bare boolean. This prevents an activated directory from implicitly activating another directory if the route reuses the component, while allowing status refreshes/file-list changes within the same directory to stay activated.
2. Continue deriving the request file list from `groupGitStatusEntries(...).diffEntries`; this is the authoritative ordered and de-duplicated changed-file count. Define auto-load eligibility as `diffEntries.length > 0 && diffEntries.length < 50`: 49 auto-loads, exactly 50 and every larger count require a click.
3. Render the shared `Button` component (`type="button"`) instead of a `Link`. Clicking sets activation for the current agent/path without navigation. Once activated, enable the existing `useQuery(gitDiffQueryOptions(...))`; its current key, POST behavior, cache reuse, pending/error states, and refreshed file-list key changes remain intact.
4. Put a `ref` on a tightly sized (`w-fit`) wrapper around the button because `ui/src/components/button.tsx::Button` does not forward refs. In a browser-only `React.useEffect`, create `IntersectionObserver` with the viewport root, zero root margin, and any-positive-intersection semantics (`threshold: 0`, check `entry.isIntersecting`) only while the current directory is unactivated and has 1-49 diff entries. Activate once, disconnect immediately in the callback, and always disconnect in cleanup. If `IntersectionObserver` is unavailable, leave the accessible click path working rather than auto-loading.
5. Do not install an observer for 50+ entries. If status changes before activation, effect dependencies must tear down/re-evaluate against the new count; after activation, keep the directory activated and let the changed ordered file array select/fetch the corresponding query cache entry.
6. Use the local activation value everywhere currently using `props.showDiffs`: showing per-row **Diff** anchors, hiding the load button, displaying pending/error/results, and assigning `git-diff-*` anchors. Keep the button present until activation so keyboard and pointer users can always trigger it; the existing `role="status"` loading text and `role="alert"` error remain the live feedback. The visible label is unambiguous, so no tooltip is required.

## Tests

Update `ui/e2e/git-browser.spec.ts` (accessible role/name selectors, with assertion comments per repository convention):

1. Replace the old link/`diff=true` assertion with button behavior: capture the URL, activate **Load all diffs**, assert the URL is unchanged and contains no `diff` parameter, then retain the existing five-result ordering, links, rendering, and anchors assertions.
2. Add deterministic subdirectory fixtures containing 49 and 50 individually reported changed files. For 49, assert no batch diff before the button is in view, scroll the button into the viewport, and assert automatic loading/results without clicking. For exactly 50, scroll it into view and assert the button remains and no diff request/results appear, then click and assert all 50 load. Use request counting/routing for POST `/git/diff` where needed so the negative assertion proves no eager fetch rather than relying only on render timing.
3. Cover stale URL cleanup by opening a Git directory with `?view=git&diff=true`, asserting replacement to `?view=git` (preserving any supported state used by the case) and proving the legacy flag itself did not eagerly issue the directory batch request.
4. Keep backend `tests/git.test.ts` unchanged: batch ordering and API behavior are already covered, and this change is UI activation only.

## Verification

Run with the repository toolchain and sufficient full-suite timeout:

```sh
# From ui/; regenerates TanStack route types after the route search schema changes.
mise exec -- pnpm run build

# From the repository root.
mise exec -- pnpm playwright -- git-browser.spec.ts
mise exec -- pnpm test
```

Allow at least 600 seconds for `mise exec -- pnpm test`. If a transient test passes on immediate rerun, record it in `flaky-tests.md` as required.
