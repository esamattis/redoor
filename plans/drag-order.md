# Drag ordering for pins, devices, and bookmarks

## Goal

### Follow-up interaction decision

After completing and verifying the initial grip-based implementation, remove the
drag handles. Pins, editor pins, devices, and bookmarks are draggable across their
row surfaces, including links. Normal clicks, close/remove actions, middle-click,
and nested bookmark ownership remain independent of sorting. Focus the sortable
row itself for keyboard pickup, movement, drop, and cancellation. This decision
supersedes the grip-specific interaction details below.

Let users arrange their navigation by dragging:

1. Pinned files in the left application panel.
2. The same pinned files in the full-window editor's horizontal "tabs".
3. Devices in the right panel.
4. Bookmarks nested under each device in the right panel.

Persist all orders in the authenticated account's user state, so reloads and other browser sessions restore the arrangement. Sidebar pins and editor pins must always reflect the same order.

This document is the implementation plan. The feature work follows the steps below.

## Current implementation and integration points

| Area | Existing code | Relevant behavior |
| --- | --- | --- |
| User preferences | `ui/src/user-state.ts` | Zod schema, defaults, stable pin/bookmark key helpers, optimistic Query cache updates, serialized background persistence, shared save-error notification. |
| Sidebar pins | `ui/src/components/application-navigation.tsx` | `PinnedFiles` renders `userState.pinnedFiles` in array order, with navigation, remove, and clear actions. |
| Editor pins | `ui/src/components/browser/file-views.tsx` | `EditorPinnedFiles` renders the same array horizontally when the editor is full-window. Close and middle-click remove pins without changing the editor buffer. |
| Devices | `ui/src/components/agent-navigation.tsx` | `AgentMenu` currently renders `props.agents` in API order. Device links preserve remembered destinations and expose status/edit actions. |
| Bookmarks | `ui/src/components/agent-navigation.tsx` | `AgentBookmarks` receives `userState.bookmarks.filter(...)`, preserving that device's subsequence of the global array. |
| Responsive panels | `ui/src/components/side-menu.tsx` | Shared persistent sidebar and modal drawer. Drawer Escape handling is currently on `document` and closes the drawer unconditionally. |
| File imports | `ui/src/components/global-file-import-handler.tsx` | Window-level native drag handlers respond to file payloads and show an upload overlay. |
| Persistence API | `ui/src/api-client.ts`, `src/server/user_state.rs` | Existing GET/PUT `/api/v1/user/state` reads and atomically replaces arbitrary JSON for the authenticated user. |
| Existing browser coverage | `ui/e2e/pinned-files.spec.ts`, `bookmarks.spec.ts`, `application-navigation.spec.ts`, `user-state.spec.ts` | Covers pin/bookmark membership, editor navigation, responsive drawers, and persistence failures. |

There is currently no sortable drag-and-drop dependency in the root `package.json`.

## Product behavior and decisions

### Ordering rules

- Pins have one global order across devices. Both pin presentations read and update `pinnedFiles`; there is no separate tab order.
- Devices have one account-level right-panel order keyed by stable `agent.id`, independent of name and connection status.
- Bookmarks reorder within their owning device. Dragging between devices does not change ownership or create a bookmark on another filesystem.
- A device drag moves its complete visual block, including its bookmarks. It changes device order only.
- Every collection uses insertion/move behavior: dragging the third item to the first position shifts the intervening items; it does not merely swap two entries.
- New pins and bookmarks append using the existing add behavior. Removing an item preserves the order of the remaining items. Re-pinning an existing pin preserves its position.
- A device without a saved position follows the explicitly ordered devices, in the original inventory order among other unsaved devices.
- When no device order exists, preserve the current API inventory order.
- An unavailable device ID may remain in the saved order without rendering a phantom entry. If it reappears with the same ID, its remembered placement applies again.
- The right-panel preference is owned by `AgentMenu`; do not reorder the shared agents Query cache. This keeps inventory consumers independent of navigation presentation.

### Drag affordances

- Give every sortable row/tab a compact, discoverable grip using the existing `IconButton` and `Tooltip` components.
- Start sorting from the grip, leaving links, close/remove buttons, and edit actions as normal interactive controls. The grip is outside the link, never nested inside it.
- Use accessible names such as `Reorder pinned file <name>`, `Reorder device <name>`, and `Reorder bookmark <name>`. Include device/path context when labels would otherwise be ambiguous.
- Keep grips discoverable on touch screens and keyboard focus, not exclusively on hover. Use a comfortably sized hit area even if the icon is small.
- With fewer than two entries in a scope, hide or disable the grip consistently while keeping navigation/removal usable.
- Show the dragged item and destination clearly, using Tailwind styles, a stable source footprint, and sibling movement. Respect reduced-motion preferences.
- Support edge auto-scrolling in each list's scroll container and horizontally in the editor pin strip.
- A drop outside the owning list, Escape, loss of the source/target, or closing/unmounting the surface cancels the gesture without saving.

### Interaction invariants

- Reordering never navigates, closes a menu, edits configuration, uploads files, unpins, or removes a bookmark.
- Reordering editor pins preserves the active URL, editor instance, selection, unsaved buffer, and full-window presentation. Use stable item keys and keep drag state local to the pin navigation.
- Ordinary pin navigation still uses the existing unsaved-change guard. Ordinary middle-click still closes an editor pin.
- Device status/name updates do not reset ordering. Use IDs rather than display text or numeric indices for identity.
- A completed move paints immediately and saves in the background. A failed save uses the existing user-state error toast and retains the existing optimistic-save behavior.

## Reusable drag-and-drop architecture

### Recommendation: a small sortable primitive backed by dnd-kit

Create reusable components because the four surfaces share activation, sorting, cancellation, accessible grips, announcements, and scroll handling. Keep domain rendering and user-state writes at the call sites.

Use compatible versions of `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities`, checking React 19 support and the current package APIs before installation. Add dependencies in the root manifest and update `pnpm-lock.yaml` through pnpm.

Why this approach:

- Horizontal and vertical sortable strategies already cover the required layouts.
- Mouse, touch, and keyboard sensors avoid building a custom input/accessibility engine.
- Pointer/touch sorting does not produce a native file-transfer payload, keeping it separate from the existing file-import workflow.
- A handwritten HTML `draggable` solution would still need separate touch and keyboard implementations. These lists justify sharing that behavior through a maintained library.

### Proposed module and contracts

Add `ui/src/components/sortable-list.tsx` with these substantive primitives:

- **`SortableList`**: owns an isolated drag context, sensors, axis-specific strategy, collision rules, announcements, and drag lifecycle. Accepts stable ordered item IDs, orientation, an accessible collection label, and a completed-move callback.
- **`SortableItem`**: connects an existing row/list item to sortable measurement, transform, transition, and item-local handle state. Provide bindings through a render callback so callers retain semantic `li` or device-block elements and existing styling.
- **`SortableDragHandle`**: consumes item-local activator bindings and renders the shared accessible grip through `IconButton`, with tooltip instructions and guarded keyboard activation.

The completed-move callback reports `{ activeId, overId }`, not a stale replacement array. Define move semantics as removing the active item and inserting it at the target item's pre-removal index: upward means before the target, downward means after it.

Keep the module generic:

- It knows nothing about `ApiClient`, `UserState`, routes, file paths, or `Agent` objects.
- Callers retain their links, status labels, remove buttons, empty states, and active styling.
- Component-instance IDs must be unique, for example via React `useId`; collection labels alone are not unique because `SideMenu` can mount hidden sidebar content and visible drawer content simultaneously.
- Preserve `ul`/`li` and navigation semantics. The editor "tabs" remain route links; do not introduce ARIA tab semantics without implementing the corresponding tab behavior.
- Register only intended items as drop targets, and keep scope membership explicit.
- Add the reusable components to the list in `AGENTS.md` during implementation.

### Sensors, scopes, and cancellation

- Mouse: require a small movement threshold, approximately 6 pixels, so a click on a grip does not unexpectedly start sorting.
- Touch: use a short press delay, approximately 200 milliseconds, with movement tolerance. Apply appropriate touch-action styling to grips while ordinary list scrolling remains available elsewhere.
- Keyboard: focused grip uses Space/Enter to pick up or drop; vertical scopes use Up/Down and horizontal scopes use Left/Right; Escape cancels. Use the library's sortable coordinate getter, constrained to the current axis/scope.
- Scope keyboard handling to the grip. Apply `shouldIgnoreKeyboardShortcut` from `ui/src/utils/keyboard.ts` before activation, so modifier chords, editor/terminal keys, and text entry are not intercepted. Prevent default only for handled sorting keys.
- Override generic library announcements with collection-aware messages: picked up item, new position out of total, dropped item, and cancelled move. Preserve focus on the same grip after a committed move.
- Nest a bookmark drag context inside each device block. Only the device header's grip activates the outer context; only bookmark grips activate the inner context. A bookmark must never become an outer device draggable.
- Make pointer collision detection reject targets outside the owning list's visible bounds; `closestCenter` alone can otherwise select a distant item after the pointer leaves the list. Keep keyboard collision behavior independent of pointer bounds.
- Devices with many bookmarks have variable-height sortable blocks. Measure whole blocks, use the vertical list strategy, and verify dragging both directions across a tall block.
- Revalidate scope/source/target membership before committing. Cancel if membership changes during a gesture; ordinary name/status-only changes may continue. Check the latest user state again in the updater.
- Local drag state is transient. Do not save on drag start, hover, pointer movement, or keyboard position previews.

Prefer transformed items/siblings without a portal overlay if clipping is not an issue. If a drag overlay is needed, render a noninteractive, `aria-hidden`, pointer-events-none preview without duplicating focusable links/buttons; ensure it is visible above the editor's `z-[60]` layer and within drawer presentation.

### Drawer keyboard integration

Update `SideMenu`'s Escape handler to respect an event already handled by a child interaction, checking `event.defaultPrevented`. The sortable cancellation path must consume Escape before the document-level drawer dismissal sees it. Verify the chosen sensor's event phase actually gives that ordering; if it does not, add a narrowly scoped active-drag check to the drawer rather than relying on listener registration order.

Expected result: the first Escape cancels an active drag and leaves the drawer open; a subsequent Escape dismisses the drawer and restores focus to its trigger. Other drawer dismissal and focus-trap behavior remains conventional.

## User-state model and ordering algorithms

### Persisted fields

| Field | Representation | Purpose |
| --- | --- | --- |
| `pinnedFiles` | Existing `PinnedFile[]` | Array order is the shared pin/tab order. |
| `bookmarks` | Existing `Bookmark[]` | Each device's filtered subsequence is its bookmark order. |
| `deviceOrder` | New `string[]` of agent IDs | Remembers right-panel device placement. |

Add `deviceOrder: z.array(z.string()).catch([])` to `userStateSchema` and `deviceOrder: []` to `defaultUserState`. Old documents and malformed values fall back to an empty preference while existing fields retain their defaults. No eager write/migration is needed when loading an older document.

### Shared move algorithm

Add a focused utility such as `ui/src/utils/reorder.ts` for immutable keyed movement and scoped-subsequence replacement. This is real shared behavior, not a passthrough wrapper around a library helper.

Required properties:

1. Identify source and target by stable key, never by drag-start indices.
2. Return the original array for missing IDs, same source/target, invalid scopes, or a move that changes nothing.
3. Preserve every item and its metadata; reuse existing item objects.
4. For scoped lists, move items only within their selected subsequence, then put them back into that scope's original slots in the full array.
5. Preserve unrelated entries and their positions. Do not replace a full user-state array with a visible filtered list.

For example, reordering device A's bookmarks in `[A1, B1, A2, B2, A3]` to put `A3` first produces `[A3, B1, A1, B2, A2]`. Device B's bookmarks and the total membership are unchanged.

Use the existing `getPinnedFileKey` and `getBookmarkKey` consistently; device keys are `agent.id`. Put preference-specific methods in `user-state.ts` where they add domain behavior, while keeping the generic array algorithm in its utility module.

### Resolve and update device order

Device rendering:

1. Deduplicate saved IDs, retaining the first occurrence.
2. Resolve saved IDs against the current inventory and omit unavailable IDs from rendering.
3. Append inventory devices not already represented, retaining their input order.
4. Produce a new ordered array; never sort/mutate `props.agents` or the cached inventory in place.

On a committed device move:

1. Inside the functional user-state updater, start with the latest deduplicated saved IDs.
2. Append current inventory IDs not yet saved, creating a complete preference for currently visible devices.
3. Move the visible-ID subsequence and merge it back into the full saved-ID array. Retain unavailable IDs in their slots rather than silently deleting their remembered placement.
4. Save only if the visible order actually changes. A cancelled/no-op gesture must not normalize the document or trigger a PUT.

Example: saved `[A, missing, B]`, inventory `[A, B, C]`, moving `C` first stores `[C, missing, A, B]` and renders `[C, A, B]`. If `missing` returns, it renders in its retained saved slot.

### Commit through the existing preference store

Each surface uses `setUserState(current => ...)` with the latest array and the keyed move operation. Return `current` when there is no actual change, allowing the existing identity check to avoid redundant persistence.

Use `useUserState`'s existing Query cache and serialized write path. Preserve unrelated preferences by spreading the latest `current` state. This prevents a pin/bookmark added while a drag was active from being lost through a stale full-array replacement; if relevant membership changed, cancel rather than guessing a drop.

All network access remains through `ui/src/api-client.ts`. The generic state endpoint already accepts these fields and preserves array order. The new preference therefore fits the existing Rust response/request types and generated bindings. Regenerate bindings if implementation changes any `#[ts(export)]` type.

Existing whole-document PUT behavior across independent clients still applies: this feature does not introduce a server-side revision or conflict-resolution protocol. Within one client, rapid gestures and concurrent preference edits must converge through the existing serialized persistence chain.

## Implementation sequence

### 1. Ordering model and meaningful unit coverage

- Add `deviceOrder` schema/defaults in `ui/src/user-state.ts`.
- Implement generic immutable movement/scoped merge and device-order resolution.
- Add `ui/src/utils/reorder.test.ts` and focused `ui/src/user-state.test.ts` coverage for insertion semantics, filtered merging, no-op identity, and device fallback/normalization.
- Verify old documents with missing `deviceOrder`, malformed order values, duplicate/stale IDs, and empty/single-item lists.

### 2. Shared sortable interaction

- Install the selected compatible dnd-kit packages.
- Implement the shared list, item, and grip primitives with both orientations.
- Implement cancellation, announcements, scope validation, touch handling, and auto-scroll behavior.
- Coordinate Escape with `SideMenu`.
- Update the reusable-component inventory in `AGENTS.md`.

### 3. Sidebar and full-window pins

- Add vertical sorting to `PinnedFiles`; pass a keyed move callback from `ApplicationMenu`.
- Add horizontal sorting to `EditorPinnedFiles`; commit against the same `pinnedFiles` state.
- Keep existing pin/removal/clear behavior and editor middle-click handling.
- Ensure stable keys, navigation-free sorting, and no editor remount or draft reset.

### 4. Devices and nested bookmarks

- Resolve device display order inside `AgentMenu` from inventory plus `deviceOrder`.
- Make each device/bookmark group one outer sortable block, activated only from its header grip.
- Give each `AgentBookmarks` list its own vertical sortable scope and keyed update callback.
- Apply scoped bookmark merge against the full current `bookmarks` array.
- Preserve remembered device destinations, connection labels, active navigation, editing, and removal actions.

### 5. Browser persistence and regression verification

- Extend the existing pin/bookmark specs and add `ui/e2e/device-order.spec.ts`.
- Extend drawer and user-state specs for cancellation, failure feedback, and coordinated writes.
- Verify native external-file drops still work without being triggered by internal sorting.
- Run focused checks during development, then the complete required suite.

## Verification plan

### Unit tests: model edge cases

Use Vitest for behaviors that are difficult to isolate through browser inventory fixtures:

- Upward/downward insertion, first-to-last and last-to-first movement.
- Empty/single lists, same source/target, missing source/target, and no-op reference identity.
- Interleaved bookmark scopes, including equal file names/paths on different devices.
- Preservation of all metadata and unrelated bookmark positions.
- Device order with no preference, duplicates, unavailable IDs, new IDs, and reappearing IDs.
- Device rename/status changes preserving ID-based positions.
- Old/malformed user-state input falling back correctly.
- A stale move against current state cannot resurrect removed entries or discard newly added entries.

### Playwright: primary workflows

Use at least three entries for pointer-sort workflows to prove insertion instead of a two-item swap. For mouse sensors, drag with actual `page.mouse` movements from accessible grip locators, crossing the activation threshold and moving in steps. Do not rely solely on `locator.dragTo`, which is designed around native drag/drop behavior.

**Pins (`ui/e2e/pinned-files.spec.ts`)**

1. Drag a sidebar pin from last to first; assert exact ordered pin links, unchanged route, and persisted array order from API readback.
2. Enter the full-window editor and verify the same order.
3. Reorder horizontally; assert the new order, unchanged active file/full-window mode, and an intact unsaved draft. Restore normal size and verify sidebar agreement.
4. Poll server readback before reloading; verify reload and a fresh authenticated page/context restore the saved order.
5. Exercise close button, middle-click, adding another pin, and clear after reordering.
6. Verify horizontal scrolling can reach and reorder offscreen pins.

**Devices (`ui/e2e/device-order.spec.ts`)**

1. Drag a device in the right panel; assert exact order of direct device entries, unchanged current route, and `deviceOrder` readback/reload.
2. Include nested bookmarks and verify they move with the owning device, with bookmark state untouched.
3. Include a tall bookmark group to exercise variable-height device sorting.
4. Use inventory-response fixtures for new/unavailable/renamed devices where deterministic live inventory changes would be cumbersome; assert real persistence separately from mocked inventory behavior.
5. Confirm a subsequent ordinary device click still goes to its remembered destination.

**Bookmarks (`ui/e2e/bookmarks.spec.ts`)**

1. Seed multiple bookmarks for two devices, with interleaved stored entries.
2. Reorder one device's bookmarks; assert its exact visible order, the other device's unchanged order, all metadata, and unchanged device order.
3. Assert API readback and reload restore the per-device subsequence.
4. Attempt a drop onto another device/list and verify cancellation rather than ownership transfer.
5. Verify normal bookmark navigation/removal and append-after-reorder behavior.

**Accessibility and responsive behavior**

- Use keyboard pick-up, axis movement, drop, and cancel on a shared grip. Exercise both orientations and verify the same state changes as pointer sorting.
- Verify handle focus is retained and accessible announcements report the item and position.
- Verify tooltip instructions on focus/hover while the grip's accessible name stays stable.
- Type sorting keys in an input, editor, and terminal; confirm text/input behavior rather than reordering. Modifier chords must remain available.
- In a narrow viewport, reorder in both drawers. First Escape cancels the drag without dismissing the drawer; next Escape dismisses and restores trigger focus.
- Exercise touch activation and ordinary touch scrolling in a touch-enabled browser context. Wait for active-drag feedback instead of adding arbitrary sleeps for the activation delay.
- Verify scrolling long vertical lists and the horizontal tab strip can expose valid destinations.

**Persistence robustness**

- An unchanged drop or cancellation causes no user-state PUT.
- Multiple rapid moves plus an unrelated preference toggle preserve the latest orders and the unrelated preference after queued writes finish.
- A mocked PUT failure announces the existing save-error toast without undoing or blocking the local arrangement.
- Removing source/target or closing a drawer during a drag cancels cleanly without writing a stale order.
- Internal sorting does not show the upload overlay or issue upload requests; an actual native file drop still uses the existing import behavior.

Existing `tests/user-state.test.ts` already covers arbitrary JSON storage and account persistence. Extend its payload/readback coverage with ordered pins, bookmarks, and `deviceOrder` if needed to document the order contract; UI tests must still prove real gesture-to-store behavior.

### Test hygiene and commands

- Restore shared account state between tests, including `deviceOrder: []`. Review existing reset fixtures because some intentionally send partial state documents; missing fields must still apply defaults.
- Register per-test Vitest cleanup with `onTestFinished()`. Use the existing Playwright `afterEach`/fixture cleanup patterns for browser tests. Do not introduce per-test try/finally cleanup blocks.
- Use roles, accessible names, visible text, and container-scoped locators; never select by CSS class. For device lists, add semantic list labels if needed so tests distinguish parent devices from nested bookmarks.
- Add comments to assertions explaining why they matter.
- Use polling/observable drag state and request completion rather than sleeps. Poll persisted state before testing reload restoration.
- Execute every shell command through `mise exec --`.

Suggested focused checks from the repository root:

```sh
mise exec -- pnpm exec vitest run ui/src/utils/reorder.test.ts ui/src/user-state.test.ts
mise exec -- pnpm run types
mise exec -- pnpm run lint
mise exec -- pnpm run playwright -- ui/e2e/pinned-files.spec.ts ui/e2e/bookmarks.spec.ts ui/e2e/device-order.spec.ts ui/e2e/application-navigation.spec.ts ui/e2e/user-state.spec.ts
```

Finish implementation with `mise exec -- pn test`, using a tool timeout of **at least 1,200 seconds**. This is interactive behavior and persistence work, so the visual-only build-and-restart shortcut is insufficient. Inspect `./log` on failures; record transient tests that pass on a second run in `./flaky-tests.md`.

If implementation modifies route files, run the UI build from `ui` via `mise exec -- pnpm run build` to regenerate route types. If it changes exported Rust types, run `mise exec -- scripts/generate-ts-bindings`.

## Acceptance checklist

- [ ] Sidebar pins can be reordered by dragging and restore from user state.
- [ ] Full-window editor pins can be reordered horizontally and share the sidebar order.
- [ ] Reordering preserves the active editor, unsaved content, URL, and full-window mode.
- [ ] Right-panel devices can be reordered with their bookmark groups.
- [ ] Each device's bookmarks can be reordered without affecting another device's entries or ownership.
- [ ] All orders persist through the existing authenticated user-state API and survive reload/fresh session.
- [ ] Old user-state documents require no manual migration.
- [ ] New, renamed, disconnected, unavailable, and returning devices have deterministic ID-based ordering.
- [ ] Pointer, touch, keyboard, cancellation, scrolling, and nested scope behavior work through shared primitives.
- [ ] Existing links, pin close/middle-click, clear, remove/edit actions, drawers, and file uploads remain usable.
- [ ] No-op/cancelled gestures avoid writes; failed writes use existing feedback.
- [ ] Unit edge cases and primary Playwright workflows pass, followed by the complete `pn test` suite.
