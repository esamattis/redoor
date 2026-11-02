# Changelog

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
