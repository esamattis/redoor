# Configuration (`config.toml`)

Server, agent, and relays share one TOML file. The same file can hold `[server]`, `[agent]`, `[[agents]]`, and `[[relays]]`.

The UI and remote CLI call the machines you access **devices**. A **Redoor agent**
is the process running on a device. Configuration keys, environment variables,
and process commands retain `agent` terminology.

## Location

When `--config` is omitted, Redoor loads (and may create) a conventional path:

| Privileges | Path                           |
| ---------- | ------------------------------ |
| Non-root   | `~/.config/redoor/config.toml` |
| Root       | `/etc/redoor/config.toml`      |

The `redoor` segment follows `--app-name` / `REDOOR_APP_NAME` (default `redoor`).

Pass an explicit path with:

```bash
redoor server --config /path/to/config.toml
redoor agent --config /path/to/config.toml
redoor agent relay start production --config /path/to/config.toml
```

## Precedence

For values that exist in more than one place:

**CLI flag > environment variable > `config.toml` > built-in default**

Unknown keys anywhere in the file (top level, `[server]`, `[agent]`, `[[agents]]` and `[[relays]]` rows) are rejected so typos fail fast.

## Top-level

| Key           | Type   | Required | Description                                                                                    |
| ------------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `agent_token` | string | yes      | Shared agent secret. Agents present it as a bearer token when they open their websocket (`/api/v1/agent/ws`). Must be non-empty. |

```toml
agent_token = "long-private-secret"
```

CLI/env overrides for the agent process: `--token` / `REDOOR_AGENT_TOKEN`.

## `[server]`

Required when running `redoor server`. Optional in agent-only configs.

| Key             | Type          | Default            | Description                                                                                                                                                                   |
| --------------- | ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`          | integer (u16) | `7666`             | HTTP listen port. Override with `--port` / `REDOOR_PORT`.                                                                                                                     |
| `bind`          | string        | `127.0.0.1`        | Listen address. Use `0.0.0.0` only when intentionally exposing beyond localhost. Override with `--bind`.                                                                      |
| `log`           | string        | platform default\* | Server log file path. Override with `--log` / `REDOOR_SERVER_LOG`.                                                                                                            |
| `log_max_size`  | integer or string | `"10MB"`       | Size limit of the log file: bytes, or a size with `KB`, `MB` or `GB` (binary multiples), such as `"10MB"`. Also limits the `log` files of server-managed `[[agents]]`. See [Log rotation](#log-rotation). |
| `log_level`     | string        | `info`             | Initial threshold: `trace`, `debug`, `info`, `warning`, or `error`. Override with `--log-level` or `REDOOR_SERVER_LOG_LEVEL`. Runtime UI/API changes last only until restart. |
| `log_format`    | string        | `line`             | Process stdout/file format: `line` or newline-delimited `json`. Override with `--log-format` or `REDOOR_SERVER_LOG_FORMAT`. Browser streams are always structured.            |
| `username`      | string        | see auth below     | Shorthand for one `[[server.users]]` entry: its login name. Set together with `password`.                                                                                     |
| `password`      | string        | see auth below     | Shorthand for one `[[server.users]]` entry: its password, in plaintext or as an Argon2 PHC hash (`$argon2id$...`). Non-empty when set.                                       |
| `cookie_secure` | bool          | `false`            | When `true`, session cookies are marked `Secure` (use behind an HTTPS reverse proxy). Always on with [`[server.tls]`](#servertls-built-in-https).                             |

\*Default log path: `~/.local/share/redoor/server.log` (non-root) or `/var/log/redoor/server.log` (root).

### `[server.tls]` (built-in HTTPS)

Without this table the server serves plain HTTP. With it, the server serves HTTPS on the same `port` and no longer answers plain HTTP. Use either a self-signed certificate or your own files:

| Key           | Type   | Default | Description                                                                                                                              |
| ------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `self_signed` | bool   | `false` | Create a self-signed certificate on the first start and reuse it afterwards. Cannot be combined with `cert`/`key`.                     |
| `cert`        | string | none    | PEM certificate chain, leaf first (for example Let's Encrypt `fullchain.pem`). Set together with `key`.                                 |
| `key`         | string | none    | PEM private key of the certificate. Set together with `cert`.                                                                            |

```toml
[server.tls]
self_signed = true

# or your own certificate, read on every start (restart after renewing it):
# cert = "/etc/redoor/fullchain.pem"
# key = "/etc/redoor/privkey.pem"
```

The self-signed certificate and its key are stored in `~/.local/share/redoor/tls/` (`self-signed-cert.pem`, `self-signed-key.pem`). It is valid for `localhost`, `127.0.0.1`, `::1`, the hostname, a specific `bind` address and the primary LAN address, for 825 days, and is replaced automatically when it expires within 30 days or a file is missing. Delete both files and restart to create a new one, for example after changing the hostname. The server log shows its SHA-256 fingerprint, so you can check it against the one your browser shows before accepting the warning.

Browsers warn about a self-signed certificate until you accept it. The [remote CLI](remote-cli.md#servers-with-a-self-signed-certificate) logs in with `redoor remote login --insecure-tls`. Standalone agents must be told to skip verification with `insecure_tls = true` in `[agent]` (or `--insecure-tls`); the agent config shown on the UI home page already includes it. Server-managed local and SSH agents need nothing: they connect through `localhost` and the SSH tunnel and skip verification automatically, as no certificate can match `localhost` through a tunnel.

Session cookies are always marked `Secure` with built-in HTTPS.

### Browser authentication

Redoor has exactly one account with full access: anyone who can sign in can already run commands as the server's OS user through the local agent, so per-user rights would only pretend to protect anything. Several people and several methods can sign in to it. Everyone shares the vault, SSH keys, devices, terminal sessions and access tokens; only the UI state (preferences, open files, editor drafts) is kept per login name. Log lines written for a request name who made it (`[user=alice (password)]`), and the application menu shows who is signed in.

At least one login method must be configured, or the server refuses to start:

- **`[[server.users]]`** — a name and password per person.
- **`[server.pam]`** — the system password of the user running the server (Linux only).
- **`[server.oidc]`** — an OpenID Connect provider (see below).

```toml
[[server.users]]
name = "alice"
password = "$argon2id$v=19$m=19456,t=2,p=1$..."   # plaintext or an Argon2 PHC string

[[server.users]]
name = "bob"
password = "long-private-password"

[server.pam]
enabled = true
```

Names may contain only ASCII letters, numbers, `.`, `_` and `-`, and must be unique. Every entry needs a non-empty `password`.

`[server] username` and `password` are shorthand for a single `[[server.users]]` entry. Both must be set together, and the shorthand cannot be combined with `[[server.users]]`.

`password` may be an Argon2 PHC string instead of plaintext, so the file does not hold a recoverable password. A value starting with `$argon2` is read as a hash and must parse as one, otherwise the server refuses to start. A name that is not a login is checked against a dummy hash with the default Argon2 parameters, so the response time does not tell which names exist; a hand-written hash with other cost parameters takes a different time and so still reveals its name. Hashes written by the password change form always use the default parameters.

**Breaking change:** older versions used PAM whenever `[server]` had neither `username` nor `password`. That implicit fallback is gone; such a config now fails at startup and asks for `[server.pam] enabled = true`.

#### `[server.pam]`

| Key       | Type | Default | Description                                                                                       |
| --------- | ---- | ------- | ------------------------------------------------------------------------------------------------- |
| `enabled` | bool | `false` | Lets the server process's own OS user sign in with its system password. Refused on non-Linux.    |

PAM only ever checks the user the server runs as, under the `login` service. That user can check its own password without privileges, so the server needs no access to `/etc/shadow`. Signing in as any other system user is not possible.

The same name may be both a `[[server.users]]` entry and the PAM user: the config password is checked first, then PAM.

On systems whose `login` PAM stack uses `pam_faillock` (Fedora, RHEL and Arch by default; not Debian, Ubuntu or Proxmox), failed redoor logins count towards the OS account's lock. Repeated failures on the login page can then lock the server's user out of console logins, `sudo` and password SSH for the lock time. Redoor's own login rate limit counts failures of every method.

#### Changing a password

For a `[[server.users]]` (or shorthand) login, the server home page and the application menu have a **Change password** button. It asks for the current password and a new one of at least 8 characters, writes the new password into that user's entry as an Argon2id hash (keeping the rest of the file and its comments), and takes effect at once without a restart. That user's other browsers are signed out; other users, access tokens, PAM and OIDC sessions keep working. PAM and OIDC sessions get no button: those passwords belong to the system and the provider.

#### When sessions end

| Method   | Session ends when                                                         |
| -------- | ------------------------------------------------------------------------- |
| Password | that user's password changes or the user is removed from the config       |
| PAM      | `[server.pam]` is turned off                                               |
| OIDC     | the issuer, client id or allowed groups change, or `[server.oidc]` is removed |

Changing a password by hand, including replacing a plaintext password with a hash of the same password, signs out that user's sessions on the next start.

Do not put `agent_token` under `[server]`; it must stay at the top level.

```toml
[server]
port = 7666
bind = "127.0.0.1"
cookie_secure = false
# log = "log/server.log"
# log_level = "info"
# log_format = "line"
username = "admin"
password = "long-private-password"
```

### `[server.oidc]` (optional OpenID Connect sign-in)

Adds "Sign in with …" to the login page using any OpenID Connect provider (Pocket ID, Authentik, Keycloak, …). It is off unless this table exists. When configured, the login page leads with the provider button; password and PAM logins stay available next to it, so a provider outage cannot lock you out when one of them is configured. A successful sign-in creates a browser session for the server's single account, named after the ID token's `preferred_username` (else `email`, else `sub`) in logs and the UI. Agent connections, access tokens and MCP are not affected.

| Key                     | Type             | Default                          | Description                                                                                                                         |
| ----------------------- | ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                | string           | required                         | Provider issuer URL. `https://` (plain `http://` only for localhost). Its `/.well-known/openid-configuration` is used for discovery. |
| `client_id`             | string           | required                         | Client ID registered at the provider.                                                                                               |
| `client_secret`         | string           | required                         | Client secret (confidential client).                                                                                                |
| `redirect_url`          | string           | required                         | Public callback URL registered at the provider, ending in `/api/v1/auth/oidc/callback`, e.g. `https://redoor.example.com/api/v1/auth/oidc/callback`. |
| `allowed_groups`        | array of strings | unset (any account)              | The ID token's `groups` claim must contain at least one of these. Checked by Redoor even if the provider also restricts the client. When unset, every account that signs in at the provider gets in, so restrict the client at the provider instead. An empty list is an error. |
| `scopes`                | array of strings | `["openid", "profile", "groups"]` | Requested scopes. `openid` is always added. Change this if your provider releases the `groups` claim under another scope.           |
| `provider_name`         | string           | `single sign-on`                 | Button label: "Sign in with {provider_name}".                                                                                       |
| `session_lifetime_days` | integer          | `30`                             | Idle lifetime of sessions created by OIDC sign-in (1–400). Every use extends it, so it only expires after this long without use.     |

The provider must support the authorization code flow with PKCE (S256), and its discovered authorization and token endpoints must follow the same `https://` rule as `issuer`. The server uses `client_secret_basic` at the token endpoint unless discovery says only `client_secret_post` is supported. Changing `issuer`, `client_id` or `allowed_groups` (including adding or removing it), or removing the table, signs out all OIDC sessions; password sessions are unaffected. Set `cookie_secure = true` when serving over HTTPS through a reverse proxy; built-in [`[server.tls]`](#servertls-built-in-https) does it automatically.

```toml
[server.oidc]
issuer = "https://id.example.com"
client_id = "redoor"
client_secret = "client-secret-from-the-provider"
redirect_url = "https://redoor.example.com/api/v1/auth/oidc/callback"
allowed_groups = ["admins"]
# provider_name = "Pocket ID"
# session_lifetime_days = 30
```

## `[agent]`

Used by a standalone `redoor agent` process (and by systemd/launchd agent units). Not used for server-managed `[[agents]]` entries.

| Key          | Type   | Default                     | Description                                                                                                                                  |
| ------------ | ------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`     | string | none (required to connect)  | Redoor server URL (`http(s)://` or `ws(s)://`). Path is optional and forced to the agent endpoint `/api/v1/agent/ws`. Override with positional `SERVER` / `REDOOR_AGENT_WS`. |
| `insecure_tls` | bool | `false`                     | Skip TLS certificate verification, for a server with a [self-signed certificate](#servertls-built-in-https). Anyone able to intercept the connection could then impersonate the server. Also `--insecure-tls` / `REDOOR_AGENT_INSECURE_TLS`. |
| `name`       | string | computer hostname           | Device name shown in the UI and remote CLI. Override with `--name` / `REDOOR_AGENT_NAME`.                                                    |
| `home`       | string | process user home directory | Home directory opened in the UI; does not limit filesystem access. Override with `--home` / `REDOOR_AGENT_HOME`.                             |
| `log`        | string | platform default\*          | Agent log file path. Override with `--log` / `REDOOR_AGENT_LOG`.                                                                             |
| `log_max_size` | integer or string | `"10MB"`         | Size limit of the log file: bytes, or a size with `KB`, `MB` or `GB` (binary multiples), such as `"10MB"`. See [Log rotation](#log-rotation). |
| `log_level`  | string | `info`                      | Initial threshold. Override with `--log-level` or `REDOOR_AGENT_LOG_LEVEL`. Runtime changes are not written to TOML.                         |
| `log_format` | string | `line`                      | Process stdout/file format: `line` or newline-delimited `json`. Override with `--log-format` or `REDOOR_AGENT_LOG_FORMAT`.                   |

\*Default log path: `~/.local/share/redoor/agent.log` (non-root) or `/var/log/redoor/agent.log` (root).

```toml
[agent]
server = "http://127.0.0.1:7666"
name = "macbook"
home = "/home/me/projects"
log = "log/agent.log"
log_level = "info"
log_format = "line"
```

CLI values take precedence over role-specific environment variables, which take precedence over TOML. Server-managed local and SSH agents are explicitly launched with `line` output. Log format does not change the structured WebSocket records shown in the browser.

## `[[agents]]`

Optional array of device connections with server-managed agents. Only the server reads this section. Each entry is either **SSH-backed** (default) or **local** (`local = true`). Agents start lazily when you connect a device from the UI or management API. The UI uses **Add device**, **Edit device**, and **Remove device** to manage these entries; removing a device stops its agent and removes its configuration, without deleting files on the device.

### Device ids and names

Every device has a stable **id** (`dev_` followed by 20 lowercase letters and digits) and an editable **name**. Access token scopes and everything else the server stores refer to the id, so renaming a device never changes what a token can reach. Requests (REST, MCP, `redoor remote`) accept either the name or the id; use the id in scripts that must stay on one device across renames.

- The server writes `id` into entries added through the UI or API. Entries you write by hand get an `id` written back on the next server start, keeping the file's comments and formatting. Do not change or copy it: duplicate ids are rejected, so when you copy an entry, delete its `id` line and let the server assign a new one.
- If the server cannot write the file (for example a read-only mount), startup fails and prints a ready-to-paste `id = "dev_..."` line for each entry without one.
- Names must be unique, must not be empty, must not contain `:` or `/`, and must not look like an id.
- A standalone `redoor agent` stores its id in `agent-id` in its data directory (`~/.local/share/redoor/agent-id` by default). Delete that file on a cloned machine to give it its own identity.

### SSH-backed agent

Default when `local` is omitted or `false`. The server SSHes to the host, ensures a matching binary, and starts `redoor agent` with reverse port forwarding.

| Key          | Type          | Required | Description                                                                                                                                                                  |
| ------------ | ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`     | string        | yes      | SSH destination (`host` or `user@host`).                                                                                                                                     |
| `id`         | string        | no       | Stable device id. Written by the server; see [Device ids and names](#device-ids-and-names).                                                                                  |
| `local`      | bool          | no       | Must be absent or `false`.                                                                                                                                                   |
| `username`   | string        | no       | SSH login via `ssh -l`. When omitted, OpenSSH config or `user@host` supplies it.                                                                                             |
| `ssh_port`   | integer (u16) | no       | SSH port. When omitted, OpenSSH host config / default applies (not forced to 22).                                                                                            |
| `name`       | string        | no       | Device name. Defaults to the host portion of `target`.                                                                                                                       |
| `remote_bin` | string        | no       | Path to the redoor binary on the remote host. When omitted, uses the versioned install layout under `${XDG_DATA_HOME:-$HOME/.local/share}/redoor/binaries/<version>/redoor`. |
| `home`       | string        | no       | Home directory opened on the remote device. When omitted, the remote process user's home directory is published.                                                             |
| `log`        | string        | no       | Local file that captures the SSH process stdout/stderr (appended, limited by `[server].log_max_size`).                                                                        |
| `password`   | string        | no       | Plaintext SSH login password. When set, the server answers OpenSSH via `SSH_ASKPASS`. Prefer keys or `ssh-agent` when possible.                                              |

`remote_bin` and `home` are used literally on the device, except that a leading `~/`, `$HOME/` or `${HOME}/` is expanded to the remote user's home directory. Other shell syntax such as variables or `$(...)` is not interpreted.

```toml
[[agents]]
target = "user@example.com"
# username = "deploy"
# ssh_port = 22
# name = "prod-server"
# remote_bin = "/home/deploy/.local/share/redoor/binaries/<version>/redoor"
# home = "/srv/app"
# log = "/var/log/redoor/prod-agent.log"
# password = "plaintext-ssh-password"
```

### Local agent

Runs on the same machine as the server. The server reuses its own binary (`std::env::current_exe`); no `remote_bin` is needed.

| Key     | Type   | Required | Description                                                                                          |
| ------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `local` | bool   | yes      | Must be `true`.                                                                                      |
| `id`    | string | no       | Stable device id. Written by the server; see [Device ids and names](#device-ids-and-names).          |
| `name`  | string | no       | Device name. Defaults to the system hostname.                                                        |
| `home`  | string | no       | Home directory opened in the UI. Defaults to the spawned process user's home directory.              |
| `log`   | string | no       | File for the spawned agent stdout/stderr (appended, limited by `[server].log_max_size`). When omitted, stdio is inherited from the server. |

SSH-only keys (`target`, `username`, `ssh_port`, `remote_bin`, `password`) are rejected on local entries.

```toml
[[agents]]
local = true
name = "local"
home = "/home/me/projects"
log = "~/.local/share/redoor/log/local.log"
```

## `[[relays]]`

Optional named SSH relays started explicitly with `redoor agent relay start ID`. Configuring an entry does not start it.

| Key              | Type          | Required | Description                                                                                 |
| ---------------- | ------------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`             | string        | yes      | Unique lifecycle ID. Allowed characters: ASCII letters, numbers, `.`, `_`, `-`.             |
| `agent_id`       | string        | no       | Stable device id of the remote agent. Written by `relay start` when missing.                |
| `target`         | string        | yes      | SSH destination (`host` or `user@host`).                                                    |
| `server`         | string        | yes      | Redoor server URL reached by the relay machine (`http(s)://` or `ws(s)://`).                |
| `username`       | string        | no       | SSH login via `ssh -l`.                                                                     |
| `ssh_port`       | integer (u16) | no       | SSH port; omission preserves OpenSSH configuration.                                         |
| `name`           | string        | no       | Device name shown by the server. Defaults to the host portion of `target`.                  |
| `agent_app_name` | string        | no       | Remote agent process namespace. Defaults to `<local-app-name>-relay-<id>`.                  |
| `remote_bin`     | string        | no       | Remote Redoor binary path.                                                                  |
| `binary_source`  | string        | no       | Local Redoor binary to upload unconditionally.                                              |
| `home`           | string        | no       | Home directory published by the remote agent.                                               |
| `log`            | string        | no       | Local relay and remote-agent log. Defaults to a per-ID path.                                |
| `log_max_size`   | integer or string | no   | Size limit of `log`. Default `"10MB"`. See [Log rotation](#log-rotation).                    |
| `password`       | string        | no       | Plaintext SSH login password delivered through `SSH_ASKPASS`.                               |
| `insecure`       | bool          | no       | Disable routed TLS certificate verification. Requires a secure server URL. Default `false`. |

```toml
[[relays]]
id = "production"
target = "user@example.com"
server = "https://redoor.example.com"
name = "production-agent"
```

See [SSH relays](relays.md) for commands and runtime-file behavior.

## Log rotation

Every log file Redoor writes is kept under its `log_max_size` (default `"10MB"`): the server log, standalone agent and relay logs, and the `log` files of server-managed agents. The size is checked when the process opens the file and again after every 100 log lines. When the file is over the limit, its older half of lines is dropped and the newer half kept, in place, so there are no rotated `.1` files to clean up.

| Section       | Limits                                               |
| ------------- | ---------------------------------------------------- |
| `[server]`    | The server log and every `[[agents]]` entry's `log`. |
| `[agent]`     | The standalone agent log.                            |
| `[[relays]]`  | That relay's log.                                    |

Sizes are a plain byte count (`log_max_size = 1048576`) or a string with a `B`, `KB`, `MB` or `GB` suffix (`"512KB"`, `"10MB"`). Units are binary multiples (1 KB = 1024 bytes), and zero is rejected.

## Full shared example

```toml
# Shared by server and agent. Precedence: CLI > env > config file > default.

agent_token = "long-private-secret"

[server]
port = 7666
bind = "127.0.0.1"
cookie_secure = false
# log = "log/server.log"

[[server.users]]
name = "admin"
password = "long-private-password"

# Linux only: sign in with the server user's system password.
# [server.pam]
# enabled = true

[agent]
server = "http://127.0.0.1:7666"
name = "macbook"
home = "/home/me/projects"
# log = "log/agent.log"

[[agents]]
local = true
name = "local"
home = "/home/me/projects"
log = "~/.local/share/redoor/log/local.log"

[[agents]]
target = "user@example.com"
name = "prod-server"
home = "/srv/app"
log = "/var/log/redoor/prod-agent.log"

[[relays]]
id = "production"
target = "user@example.com"
server = "https://redoor.example.com"
name = "production-relay-agent"
```

## Related environment variables

These override matching config keys when set (CLI still wins):

| Variable                    | Affects                                                   |
| --------------------------- | --------------------------------------------------------- |
| `REDOOR_APP_NAME`           | Config/data/log namespace (default `redoor`)              |
| `REDOOR_PORT`               | `[server].port`                                           |
| `REDOOR_SERVER_LOG`         | `[server].log`                                            |
| `REDOOR_AGENT_WS`           | `[agent].server`                                          |
| `REDOOR_AGENT_TOKEN`        | top-level `agent_token` (agent process)                   |
| `REDOOR_AGENT_NAME`         | `[agent].name`                                            |
| `REDOOR_AGENT_HOME`         | `[agent].home`                                            |
| `REDOOR_AGENT_LOG`          | `[agent].log`                                             |
| `REDOOR_AGENT_INSECURE_TLS` | `[agent].insecure_tls` (`true` to skip verification)      |
| `REDOOR_AGENT_NOTIFICATION` | desktop notification delay after connect (`off` disables) |

## MCP browser origins

MCP accepts origin-less native clients. To allow a browser-based MCP client,
list its exact HTTP(S) origin under `[server]`:

```toml
[server]
mcp_allowed_origins = ["https://trusted-client.example"]
```

See [MCP](mcp.md) for creating access tokens, client headers, and protocol limits.

Retained MCP operation output and metadata can be bounded or expired with
`REDOOR_MCP_OPERATION_JOB_QUOTA` (bytes per operation),
`REDOOR_MCP_OPERATION_GLOBAL_QUOTA` (bytes across retained operations), and
`REDOOR_MCP_OPERATION_EXPIRY_SECONDS` (terminal record lifetime). Invalid or
zero values use the documented safe defaults.
