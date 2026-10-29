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
| `username`      | string        | see auth below     | Browser UI login username. Non-empty when set.                                                                                                                                |
| `password`      | string        | see auth below     | Browser UI login password. Non-empty when set.                                                                                                                                |
| `cookie_secure` | bool          | `false`            | When `true`, session cookies are marked `Secure` (use behind HTTPS).                                                                                                          |

\*Default log path: `~/.local/share/redoor/server.log` (non-root) or `/var/log/redoor/server.log` (root).

### Browser authentication

`username` and `password` must both be set or both omitted:

- **Both set** — dedicated Redoor credentials for the web UI.
- **Both omitted on Linux** — PAM authenticates as the process owner's system account.
- **Both omitted on non-Linux** — rejected; config credentials are required (PAM is Linux-only).

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

Adds "Sign in with …" to the login page using any OpenID Connect provider (Pocket ID, Authentik, Keycloak, …). It is off unless this table exists. When configured, the login page leads with the provider button; the username/password (or PAM) login above stays available as a fallback, so a provider outage cannot lock you out. A successful sign-in creates a browser session for the server's single account. Agent connections, access tokens and MCP are not affected.

| Key                     | Type             | Default                          | Description                                                                                                                         |
| ----------------------- | ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                | string           | required                         | Provider issuer URL. `https://` (plain `http://` only for localhost). Its `/.well-known/openid-configuration` is used for discovery. |
| `client_id`             | string           | required                         | Client ID registered at the provider.                                                                                               |
| `client_secret`         | string           | required                         | Client secret (confidential client).                                                                                                |
| `redirect_url`          | string           | required                         | Public callback URL registered at the provider, ending in `/api/v1/auth/oidc/callback`, e.g. `https://redoor.example.com/api/v1/auth/oidc/callback`. |
| `allowed_groups`        | array of strings | required                         | The ID token's `groups` claim must contain at least one of these. Checked by Redoor even if the provider also restricts the client. |
| `scopes`                | array of strings | `["openid", "profile", "groups"]` | Requested scopes. `openid` is always added. Change this if your provider releases the `groups` claim under another scope.           |
| `provider_name`         | string           | `single sign-on`                 | Button label: "Sign in with {provider_name}".                                                                                       |
| `session_lifetime_days` | integer          | `30`                             | Idle lifetime of sessions created by OIDC sign-in (1–400). Every use extends it, so it only expires after this long without use.     |

The provider must support the authorization code flow with PKCE (S256), and its discovered authorization and token endpoints must follow the same `https://` rule as `issuer`. The server uses `client_secret_basic` at the token endpoint unless discovery says only `client_secret_post` is supported. Changing `issuer`, `client_id` or `allowed_groups`, or removing the table, signs out all OIDC sessions; password sessions are unaffected. Set `cookie_secure = true` when serving over HTTPS.

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
# On Linux, omit username/password to use PAM (process owner).
username = "admin"
password = "long-private-password"
# log = "log/server.log"

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
