# Changelog

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
