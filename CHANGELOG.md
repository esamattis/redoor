# Changelog

## v2.13.0

_2026-11-13_

### Features

- Open files left untouched for a day now close automatically. Unsaved drafts and the file on screen always stay open. Change the delay or turn it off on the new Preferences page, which also holds the Vim mode toggle.
- Custom Vim key mappings for normal, visual and insert mode can be set in Preferences and are kept across editor sessions.

## v2.12.0

_2026-11-13_

### Features

- `rd-open <path>` in a redoor terminal opens that file or directory in the web UI of the device running the shell. The focused browser window opens it right away; other windows offer it in a toast.

### Fixes

- Passkey prompts injected by password managers such as 1Password are no longer hidden behind open dialogs, so unlocking the vault with a passkey works again.

## v2.11.0

_2026-11-12_

### Features

- Terminal tab tooltips show the command running in the shell, its current directory and any title the shell set, so tabs can be told apart without switching to each.
- Switch terminal tabs with Alt (Option) + h/l, also from inside the shell.
- Alt+e (focus the editor) and Alt+t (open or focus the terminal) now work from anywhere on the page, not only from the terminal or the editor.
- Open files with the same name show the parent directories that tell them apart, such as `open-pr/SKILL.md` and `code-review/SKILL.md`.

## v2.10.0

_2026-11-12_

### Features

- A new "vs origin/main" tab in the Git view shows what origin/main would look like if everything in your working tree, including uncommitted and untracked files, were committed and merged now. "Commits only" switches to committed work.
- Branch comparisons (`A...B`) now preview the merge: work that already landed upstream as squash merges or cherry-picks no longer shows up, and files that would conflict are flagged with the reason, even when the conflict leaves nothing to diff.
- Copy absolute or repository references (`path#Lline`) from text selected in a diff, including multi-line selections.

### Fixes

- A file opened while its device was offline now opens once the device connects, instead of staying on "Opening path..." or an outdated offline view.

## v2.9.0

_2026-11-10_

### Features

- Switch between open files with Alt (Option) + j/k or the arrow keys, and close the file on screen with Alt+w. Closing the file on screen goes to its directory.
- Discard unsaved editor changes from the toolbar while keeping the file open. Undo in the editor brings the discarded changes back, even after a reload.
- Copy an editor reference relative to the repository root with "Copy repo reference" in the editor context menu.
- The breadcrumbs copy menu offers the file name, the repository path and the absolute path.
- Jinja templates (`.j2`, `.jinja`, `.jinja2`) are highlighted in the editor.

### Fixes

- Clear in the open files list keeps the file on screen open instead of closing it and leaving the page.

## v2.8.0

_2026-11-10_

### Breaking changes

- The agent protocol is now `redoor.v7`. Upgrade every agent together with the server; agents using `redoor.v6` cannot connect until upgraded. Clients reading raw exec NDJSON, including `redoor remote exec --json`, must decode output event `data` as base64 instead of an array of byte values.

### Features

- MCP foreground commands return readable stdout, stderr and the exit status directly, and other tools include their actual results in text responses. Retained command output keeps both the beginning and the latest output, so errors at the end remain available.

### Fixes

- Directory downloads, Git exports, uploads and device-to-device copies transfer data more efficiently, especially on high-latency links and memory-constrained devices.
- MCP command output recovers safely after server crashes, discarding unreadable records and reclaiming unused spool storage.
- `redoor update` restarts servers and agents on macOS after an upgrade.
- Copying an editor file reference includes whole selected lines, and copies the cursor's line when nothing is selected.

## v2.7.3

_2026-11-09_

### Fixes

- Upgrade the browser terminal emulator to wterm 0.5.10 for the latest upstream terminal fixes.

## v2.7.2

_2026-11-08_

### Fixes

- Terminals no longer show a large blank area below the prompt after long output, and keep the intended 5000 lines of scrollback instead of a few pages.

## v2.7.1

_2026-11-08_

No user-facing changes since v2.7.0.

## v2.7.0

_2026-11-08_

### Features

- Terminals render with WebGL, so full-screen redraws and fast output are much smoother.
- Each managed device can set extra terminal environment variables with `terminal_env` in `config.toml`, also editable on the device's edit page without stopping the agent. Every shell also gets `REDOOR_SERVER`, naming the server it was opened through.
- Shells fall back to a UTF-8 locale when the agent inherited `LANG=C` or no locale, so programs such as `btop` run in redoor terminals.
- Fenced code blocks in the markdown preview have a copy button.

### Fixes

- The Vim insert caret stays visible on empty lines and at the start of a line.

## v2.6.0

_2026-11-08_

### Features

- Choose how long an idle session lasts on the login page: 1 hour (default), 24 hours, 1 week, 1 month or 1 year, for both password and OIDC sign-in. Only real use of the page and running transfers keep a session alive, so a forgotten tab now signs out, and open terminals close when the session ends. For OIDC, `session_lifetime_days` is now the upper bound of the choice. Everyone signs in again once after the upgrade.
- A new sessions page lists every signed-in browser with its user agent and address, and signs out one of them or all others.
- The session cookie's secret now rotates while you work. When a copied cookie is used next to the original, the server signs out both browsers and logs a warning about a possible stolen cookie in the server log.
- Creating or rotating an access token now asks you to sign in again first, so a copied browser profile cannot mint long-lived tokens.
- `redoor remote login` and `create-token` now sign in through the browser: the CLI prints a URL and a code that you approve in a signed-in browser. This also works on OIDC-only servers. `--password-stdin` is gone; scripts should use a token created in the browser and passed in `REDOOR_REMOTE_TOKEN`. Existing tokens keep working.
- Choose how long the vault stays unlocked: 15 minutes (default), 1 hour, 24 hours, 1 week or no idle lock. The lock is enforced by the server, so it holds even with no redoor tab open and a copied browser profile cannot open the vault. Each browser unlocks the vault once more after the upgrade.
- Editor selection actions (clipboard, search, AI reference) moved into a right-click menu, and find is also in the editor's "..." menu for phones. Mod+Shift+S opens the selection search. The terminal's context menu is more compact, shows your platform's shortcuts and can search the selected text in the file browser.
- Managed SSH keys in `authorized_keys` now also record when they were added.
- Log lines about refused agents and sign-ins show the client address from `X-Forwarded-For` or `X-Real-IP` next to the peer address when redoor runs behind a reverse proxy.

### Fixes

- Command replies and other control messages stay responsive during heavy transfers on slow links.
- The delete confirmation dialog is wider on desktop, so long paths no longer wrap mid-name.
- `Alt+C` toggles comments on macOS, and Mod+S no longer swallows Mod+Shift+S.

## v2.5.0

_2026-11-06_

### Breaking changes

- SSH devices no longer have the remote binary path and home directory settings: the server always manages the binary itself and the device opens the remote user's home. Remove `remote_bin` and `home` from SSH entries in `[[agents]]`, because the server refuses to load a config that still has them. Relays keep both settings and local devices keep their home directory.
- The agent protocol is now `redoor.v6`. Upgrade standalone agents together with the server, since agents of the previous version are refused until then. Managed local and SSH agents need nothing.

### Features

- Manage systemd services and timers from the UI. A device's Systemd view lists the units of each manager, and a unit file's Systemd tab shows its status, schedule and live journal next to the editor. After saving a unit file, the UI offers the daemon-reload it needs.
- Run an executable file in a new terminal opened in its directory, straight from the file view.
- Set up a managed SSH key by hand on hosts where the server cannot log in yet: the setup dialog shows a command to run on the device, and the key takes effect only after redoor has logged in with it.
- Managed SSH keys in a device's `authorized_keys` now end with the server's `<username>@<hostname>`, so you can tell which server installed them. Keys installed earlier keep working.
- SSH devices have a configurable install directory for the redoor binary, for hosts such as TrueNAS that mount home directories `noexec`. A start now stops before uploading and names the mount when the install directory cannot run programs.
- A failed device start keeps its connection log and error across retries and Disconnect until the device connects, and a stopped device shows how far an interrupted start got.
- Preview HTML and SVG files in a sandboxed frame that cannot reach redoor. Scripts stay off unless you turn them on for the file.
- Path and content search results appear as the agent finds them. Content search shows matches from files nearest the search root first, in a stable order, and shows how long the search took.
- The search filter chip for `.gitignore`d files now reads "Ignored files" and is pressed when ignored files are included, so every pressed chip widens the search.

### Fixes

- Opening a raw file URL in a tab no longer runs an HTML or SVG file's scripts with the signed-in user's access.
- Dotfiles such as `.env` are now hidden from search unless hidden files are included, as the filter promises.
- A daemon that outlived the server no longer reconnects needlessly after a server restart, which closed reattached terminals.
- Cancel now aborts a passkey prompt that never settles instead of leaving the vault dialog stuck.
- 1Password no longer offers to save the one-time SSH password from the add-device form.

## v2.4.0

_2026-11-04_

### Breaking changes

- After a server restart or upgrade, start SSH devices from the UI again; the server no longer restarts them or automatically supplies their vault-encrypted SSH keys. Their daemons and shells remain available for up to 24 hours. Surviving local daemons reconnect automatically. The server no longer reads `terminal-sessions.json` or `managed-running.json` in its data directory; you may delete these leftover files.

### Features

- Every file pick, drop and paste opens an Upload dialog where you can rename or remove items, choose encryption per item with an unlocked vault, and decide how to handle existing files. Drop or paste more items into the open dialog to add them to the same upload. Pasted text and images now appear in the upload queue and transfers pane.
- Copy, Move and Sync share per-item conflict choices and a bulk choice for existing items.
- Shift-click file checkboxes to select or deselect a range of visible files.
- Markdown headings have shareable permalinks and support GitHub-style section links, including duplicate headings.
- The device home provides file browsing, connect or disconnect, restart, edit and logs in every connection state. The edit page includes a breadcrumb back to the device.
- Filter the Git changed-files list by path; navigating back restores the filter. Branch context appears beside the breadcrumbs while the Git tab keeps its name.

### Fixes

- Selecting a file in a diff no longer scrolls the side menus off screen in short windows.
- Background directory refreshes no longer temporarily disable the upload button.
- Open-file tooltips show the full path without a redundant prefix.

## v2.3.0

_2026-11-02_

### Breaking changes

- Managed local and SSH agents now run as daemons on their devices, so they and their terminals survive server restarts, upgrades, crashes and dropped SSH connections. Devices that were running start again when the server starts, and upgrades still replace the daemons. To upgrade:
    - Remove `log` from every `[[agents]]` entry; the server refuses to load a config that still has it. A managed agent now logs to `agent.log` in its data directory on the device.
    - If the server is installed as a system service, reinstall its unit with `redoor server systemd install` so restarts keep local daemons running. The server warns at startup until you do.
    - Devices with SSH targets need sshd to allow stream-local (Unix socket) forwarding.

### Features

- After a server restart, an open browser tab with an unlocked vault hands waiting devices their vault-encrypted SSH keys automatically instead of requiring a click per device.

### Fixes

- Unlocking the vault with a passkey (such as from 1Password) works when the unlock dialog opens over another dialog, such as the SSH key setup of a new device.
- A debug server no longer endlessly re-uploads its build to devices with an older glibc or musl that cannot run it; it falls back to the static release build, and the start screen shows the loader error.

## v2.2.0

_2026-11-02_

### Breaking changes

- The agent protocol is now `redoor.v5`. Upgrade standalone agents together with the server; older agents cannot connect until upgraded. Managed local and SSH agents are upgraded with the server.

### Features

- Terminal shells now live in the agent and can survive server restarts and connection drops. Standalone and relay-backed agents keep their shells; managed local and SSH agents still restart with the server.
- Agent upgrades run in the background with visible progress and survive page reloads and reconnects. If the new agent binary cannot start, the running image is restored.

### Fixes

- Server upgrades and restarts recover without a hard browser reload, and open requests no longer delay a restart indefinitely. Stalled release downloads time out, and failed updates report the failure.
- Logging out reliably returns to the login page even when a background request detects the expired session first.
- Agent connection logs preserve the original reason for a disconnect, making stale connections easier to diagnose.

## v2.1.2

_2026-11-01_

### Fixes

- Password logins added, changed, or removed in the config file take effect without restarting the server. If the file cannot be loaded, the last valid logins remain active and password changes are unavailable until the file is fixed.
- SSH-backed agents and managed SSH keys work in the container image, which now includes the OpenSSH client.

## v2.1.1

_2026-11-01_

### Breaking changes

- PAM login has been removed. It never worked in the published Linux builds, where a server with `[server.pam] enabled = true` refused to start. Remove `[server.pam]` from `config.toml`, because the server now refuses to start on it as an unknown key, and sign in with `[[server.users]]`, `server.username`/`server.password`, or `[server.oidc]`. Existing PAM sessions are signed out. New Linux installs get the same `redoor`/`changeme` starter login as macOS.

### Features

- The server update dialog can install a chosen release, not just the latest, so you can roll the server back from the UI. Leave the version field empty to install the latest.
- When an identity provider is configured, the login page shows the password form next to the provider button instead of behind an extra click.

## v2.1.0

_2026-11-01_

### Breaking changes

- Agents no longer send the agent token over the network. The agent and server now prove to each other that they know it, and an agent refuses to connect to a server that cannot. The agent protocol is now `redoor.v4`, and the new server rejects older standalone agents with 401. Before you upgrade the server, upgrade standalone agents from the Devices view; they reconnect once the server is upgraded. Run `redoor upgrade` on the host of any agent you missed. Managed local and SSH agents need nothing. Consider rotating `agent_token` afterwards, because older agents sent it in the clear.

### Features

- The server can serve HTTPS itself with a new `[server.tls]` table, using your own certificate files or a self-signed certificate it creates on first start and reuses across restarts. Standalone agents connect to a self-signed server with `insecure_tls = true` (or `--insecure-tls`), and the remote CLI with `redoor remote login --insecure-tls`. See [docs/config.md](docs/config.md#servertls-built-in-https).
- When an agent refuses a server, its log line now gives the reason, so a wrong token can be told apart from a server that is not yours.

## v2.0.0

_2026-11-01_

### Breaking changes

- PAM login is now opt-in. A config without `username`/`password` no longer falls back to the system login; add `[server.pam] enabled = true` to keep signing in with the server user's system password. See [docs/config.md](docs/config.md#browser-authentication).
- The vault and managed SSH keys moved from `<data dir>/users/<name>/` to the data directory root and are not migrated. Move `vault.json` and `ssh/` there by hand, and set up managed SSH device keys again because their key headers and `authorized_keys` markers no longer carry the account name.

### Features

- Several people can sign in to the one Redoor account with `[[server.users]]`, next to PAM and OIDC. Logs and the UI show who signed in and how, and preferences and editor drafts are kept per person while the vault, SSH keys and devices are shared.
- `[server] password` and `[[server.users]]` passwords may be Argon2 PHC hashes instead of plaintext.
- Change a config password from the UI. The new password is written to `config.toml` as an Argon2id hash and applies without a restart.

## v1.10.1

_2026-10-31_

### Fixes

- The Termux build starts again; v1.10.0 aborted with "executable's TLS segment is underaligned".
- Agents never give up reconnecting: retries back off to at most 30 s, standalone agents keep retrying after a wrong token or protocol mismatch, and the watchdog replaces SSH agents that stay disconnected.
- SSH sessions default to a 10 s keepalive, so a tunnel over a dead network is rebuilt in about 30 s instead of hours.
- A terminal that reconnects or is taken back from another window keeps keyboard focus instead of handing it to the open file.
- Restored terminals attach with their real size, so full-screen apps no longer flash or come back cropped after a reload.

## v1.10.0

_2026-10-31_

### Features

- Encrypted files: a per-account vault encrypts `.redoorencrypted` files in the browser. Open, edit, save, upload and download them like plain files; agents and the server only ever see ciphertext. Unlock with a passphrase or a passkey, and optionally keep the vault unlocked on the device.
- Managed SSH device keys are encrypted with the vault, so a copy of the server data directory no longer grants access to devices.
- Terminal shells live on the server and survive reloads, closed laptop lids and network switches. Tabs are restored from the server's sessions, follow other windows, and a window can take a shell over from another.
- The bottom drawer remembers whether it was open, its tab and its height across reloads.
- OIDC `allowed_groups` is optional; leaving it out allows every account the provider signs in, with a startup warning.

### Fixes

- Managed SSH keys install on hosts whose `authorized_keys` is a symlink, such as Proxmox VE.
- Logging out locks the vault.
- Copying from terminal applications such as Claude Code works again, and Shift-drag selects terminal output.
- The full-window editor no longer overlaps the bottom drawer, and the terminal device picker no longer overflows.
