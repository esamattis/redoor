---
name: add-keyboard-shortcuts
description: Use when adding, changing, or reviewing keyboard shortcuts, hotkeys, key bindings, or shortcut tooltips in the redoor UI.
---

# Add Keyboard Shortcuts

Add keyboard shortcuts that are scoped to the relevant UI, safe during text entry, discoverable from matching controls, and covered by browser tests.

## Inspect Existing Behavior

1. Find the action that the shortcut should invoke and reuse the same state or callback. Do not duplicate the action's behavior.
2. Search existing shortcuts to avoid key conflicts and follow the closest listener pattern.
3. Use `ui/src/utils/keyboard.ts` for shared guards instead of implementing local target checks.
4. Keep listeners in the narrowest mounted component that owns the action. Use a global listener only when the shortcut is genuinely application-wide.

## Implement Safely

- Handle shortcuts on `keydown` unless existing behavior requires another event.
- Call `shouldIgnoreKeyboardShortcut(event)` before handling a key. Pass `{ shift: true }` when Shift must also disable the shortcut.
- Never trigger character shortcuts while an `input` or `textarea` is active.
- Ignore Ctrl, Meta, and Alt combinations so application shortcuts do not replace browser or operating-system commands.
- Match `event.key` explicitly and call `event.preventDefault()` only after deciding to handle the shortcut.
- Do not reopen an already open dialog or start an action that is already active.
- Register and remove window listeners in the same React effect.
- Reuse the existing action callback or dialog state so mouse and keyboard interaction stay behaviorally identical.

## Make Shortcuts Discoverable

- Wrap the matching button or link with `ui/src/components/tooltip.tsx`.
- Include the shortcut in the tooltip text, following the established form: `Action description (key)`, for example `Create a new directory (d)`.
- Preserve the control's accessible name. The tooltip supplements the label and does not replace it.
- If the action has no visible matching control, add shortcut guidance at the nearest relevant UI rather than creating an unrelated button solely for the tooltip.

## Test The Workflow

Add or update a Playwright test in `ui/e2e` that verifies:

1. The shortcut invokes the same visible workflow as the matching control.
2. The resulting dialog, route, focus, or state change is correct.
3. Pressing the shortcut key while an input or textarea is focused enters text and does not invoke the action.
4. Hovering or focusing the matching control exposes tooltip text containing the shortcut.

Use role, label, or visible-text selectors rather than class names. Add a short comment explaining why each assertion matters.

## Verify

Run all commands through `mise exec --`.

1. Run `mise exec -- pnpm run types`.
2. Run `mise exec -- pnpm run lint`.
3. Run the relevant Playwright test while developing.
4. After changes, run `mise exec -- pn test` with a timeout of at least 300 seconds, as required by the repository instructions.
