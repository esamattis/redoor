---
name: upgrade-terminal-emulator
description: Use when upgrading wterm (`@wterm/dom`, `@wterm/ghostty`) or the `libghostty-vt` Rust crate, or when either shows up in a dependency update.
---

# Upgrade the Terminal Emulator

The terminal runs Ghostty's emulator twice: the browser renders with wterm (`@wterm/dom` on top of the `@wterm/ghostty` wasm core), and `redoor-agent` keeps a headless mirror of every shell's screen with the `libghostty-vt` crate so a re-attached tab gets its screen and modes back. Both sides must parse the same output the same way, or a restored screen differs from what the live tab showed.

## Upgrade them in tandem

Whenever either side is upgraded, upgrade the other in the same change.

1. Run every shell command through `mise exec --`.
2. Browser: bump `@wterm/dom` and `@wterm/ghostty` together in `package.json` to the same version (`pnpm view @wterm/dom version`), then `pnpm install`.
3. Agent: bump `libghostty-vt` in the workspace `Cargo.toml` to the latest release (`cargo info libghostty-vt`), then `cargo update -p libghostty-vt`.
4. The crate builds Ghostty from source with Zig. If the build asks for a newer Zig, raise `zig` in `mise.toml` and run `mise install`. Android builds also need `ANDROID_NDK_HOME`; keep the Bionic TLS alignment workaround (the `cc` dependency) building.
5. If one side has no newer release, say so and upgrade only the other, so the user knows they can drift apart.

## Local patches on wterm

pnpm applies the patches listed under `patchedDependencies` in `pnpm-workspace.yaml`. They are keyed to an exact version, so after a bump `pnpm install` fails until each patch is moved or dropped. Do not delete a patch just to make install pass.

- `patches/@wterm__dom@<version>.patch` makes the hidden input textarea follow the cursor on every render. Without it the absolutely positioned textarea stays where the last focus put it and holds the scroll height past a buffer that shrank (after `clear`, `ESC[3J`, entering the alternate screen, or trimmed scrollback), leaving empty space below the prompt. Upstream: https://github.com/vercel-labs/wterm/issues/245.

For each patch:

1. Check whether upstream fixed it (`gh issue view 245 -R vercel-labs/wterm`, and read the new `dist` code).
2. If fixed, remove the patch file and its `patchedDependencies` entry.
3. If not, recreate it against the new version: `pnpm patch @wterm/dom@<new>`, reapply the change in the edit dir, `pnpm patch-commit <edit dir>`, and delete the old patch file and entry.

## wterm internals the app relies on

`ui/src/terminal/wterm.ts` reaches past wterm's public API. Recheck these against the new version:

- `preserveOptionText` finds wterm's input through the host's only `<textarea>` and calls `terminal.focus()` to move it to the prompt before macOS Option text is inserted. Once the textarea patch is upstream this refocus may be unnecessary.
- `GhosttyCore.load` gets `scrollbackLines`, not `scrollbackLimit`: the latter is a byte budget that trims history a whole page at a time. Make sure the option still means lines.
- `styles.css` styles `.terminal-host.wterm` and its `has-scrollback` / `has-image-flow` classes.

## Verify

Run `pn test`; the terminal Playwright specs in `ui/e2e/serial/terminal*.spec.ts` and the terminal integration tests cover both emulators. Then check by hand with `pn build-and-restart`: run a command with long output, scroll through the history, and confirm no empty space appears below the prompt and that a reloaded tab restores the same screen.
