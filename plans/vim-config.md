# Minimal Vim configuration

Add a Vim configuration textarea to Settings → Preferences → Editor and persist its source as `vimConfig` in user state, defaulting to an empty string. Keep it editable when Vim mode is disabled so users can prepare mappings before enabling them.

Support blank lines, Vim comment lines beginning with `"`, and mapping commands: `map`, `nmap`, `vmap`, `imap`, `noremap`, `nnoremap`, `vnoremap`, and `inoremap`. Parse the source as data rather than executing arbitrary Vimscript. Preserve Unicode keys and Vim key notation such as `<Esc>`. Show unsupported commands and malformed lines with line numbers. Explain the supported subset beside the textarea.

Apply valid mappings through CodeMirror's Vim adapter, preserving the editor's built-in commands including `:w`. Respect the adapter's global mapping lifecycle: replacing or clearing the config must remove previous user mappings and restore default bindings. Ensure settings changes reach existing and restored buffers without discarding their document, selection, or undo history. Avoid applying mappings repeatedly for unchanged source.

Cover parsing, configuration replacement/removal, normal/visual motions and insert-mode `jj` through meaningful tests. Extend the serial Vim Playwright workflow to save settings, verify persistence after reload, exercise mappings in an editor, and remove a mapping. Update ARCHITECTURE.md briefly for the configuration flow.

Run type checking, lint, the relevant unit and browser tests, regenerate route types with the UI build, and run `pn test` with at least a 1200-second timeout. Diagnose any failures using logs. Do not commit unless requested.
