# Configuration (`config.toml`)

Server and agent share one TOML file. The same file can hold `[server]`, `[agent]`, and `[[agents]]`.

## Location

When `--config` is omitted, Redoor loads (and may create) a conventional path:

| Privileges | Path |
| --- | --- |
| Non-root | `~/.config/redoor/config.toml` |
| Root | `/etc/redoor/config.toml` |

The `redoor` segment follows `--app-name` / `REDOOR_APP_NAME` (default `redoor`).

Pass an explicit path with:

```bash
redoor server --config /path/to/config.toml
redoor agent --config /path/to/config.toml
```

## Precedence

For values that exist in more than one place:

**CLI flag > environment variable > `config.toml` > built-in default**

Unknown top-level keys and unknown keys inside `[server]` / `[agent]` are rejected so typos fail fast.

## Top-level

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_token` | string | yes | Shared registration secret. Agents present this when connecting over `/ws`. Must be non-empty. |

```toml
agent_token = "long-private-secret"
```

CLI/env overrides for the agent process: `--token` / `REDOOR_AGENT_TOKEN`.

## `[server]`

Required when running `redoor server`. Optional in agent-only configs.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | integer (u16) | `3000` | HTTP listen port. Override with `--port` / `REDOOR_PORT`. |
| `bind` | string | `127.0.0.1` | Listen address. Use `0.0.0.0` only when intentionally exposing beyond localhost. Override with `--bind`. |
| `log` | string | platform default\* | Server log file path. Override with `--log` / `REDOOR_SERVER_LOG`. |
| `username` | string | see auth below | Browser UI login username. Non-empty when set. |
| `password` | string | see auth below | Browser UI login password. Non-empty when set. |
| `cookie_secure` | bool | `false` | When `true`, session cookies are marked `Secure` (use behind HTTPS). |

\*Default log path: `~/.local/share/redoor/server.log` (non-root) or `/var/log/redoor/server.log` (root).

### Browser authentication

`username` and `password` must both be set or both omitted:

- **Both set** — dedicated Redoor credentials for the web UI.
- **Both omitted on Linux** — PAM authenticates as the process owner's system account.
- **Both omitted on non-Linux** — rejected; config credentials are required (PAM is Linux-only).

Do not put `agent_token` under `[server]`; it must stay at the top level.

```toml
[server]
port = 3000
bind = "127.0.0.1"
cookie_secure = false
# log = "log/server.log"
username = "admin"
password = "long-private-password"
```

## `[agent]`

Used by a standalone `redoor agent` process (and by systemd/launchd agent units). Not used for server-managed `[[agents]]` entries.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `server` | string | none (required to connect) | Redoor server URL (`http(s)://` or `ws(s)://`). Path is optional and forced to `/ws`. Override with positional `SERVER` / `REDOOR_AGENT_WS`. |
| `name` | string | computer hostname | Registration name shown in the UI. Override with `--name` / `REDOOR_AGENT_NAME`. |
| `dir` | string | process cwd / bootstrap default | Default directory opened in the UI; does not limit filesystem access. Override with `--dir` / `REDOOR_AGENT_DIR`. |
| `log` | string | platform default\* | Agent log file path. Override with `--log` / `REDOOR_AGENT_LOG`. |

\*Default log path: `~/.local/share/redoor/agent.log` (non-root) or `/var/log/redoor/agent.log` (root).

Legacy alias: `ws_address` is still accepted as a synonym for `server`. Do not set both.

```toml
[agent]
server = "http://127.0.0.1:3000"
name = "macbook"
dir = "/home/me/projects"
log = "log/agent.log"
```

## `[[agents]]`

Optional array of server-managed agents. Only the server reads this section. Each entry is either **SSH-backed** (default) or **local** (`local = true`). Entries start lazily from the UI or management API.

### SSH-backed agent

Default when `local` is omitted or `false`. The server SSHes to the host, ensures a matching binary, and starts `redoor agent` with reverse port forwarding.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | string | yes | SSH destination (`host` or `user@host`). |
| `local` | bool | no | Must be absent or `false`. |
| `username` | string | no | SSH login via `ssh -l`. When omitted, OpenSSH config or `user@host` supplies it. |
| `ssh_port` | integer (u16) | no | SSH port. When omitted, OpenSSH host config / default applies (not forced to 22). |
| `name` | string | no | Registration name. Defaults to the host portion of `target`. |
| `remote_bin` | string | no | Path to the redoor binary on the remote host. When omitted, uses the versioned install layout under `${XDG_DATA_HOME:-$HOME/.local/share}/redoor/binaries/<version>/redoor`. |
| `dir` | string | no | Default UI directory on the remote agent. When omitted, the remote launch cwd is published. |
| `log` | string | no | Local file that captures the SSH process stdout/stderr (append mode). |

```toml
[[agents]]
target = "user@example.com"
# username = "deploy"
# ssh_port = 22
# name = "prod-server"
# remote_bin = "/home/deploy/.local/share/redoor/binaries/<version>/redoor"
# dir = "/srv/app"
# log = "/var/log/redoor/prod-agent.log"
```

### Local agent

Runs on the same machine as the server. The server reuses its own binary (`std::env::current_exe`); no `remote_bin` is needed.

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `local` | bool | yes | Must be `true`. |
| `name` | string | no | Registration name. Defaults to the system hostname. |
| `dir` | string | no | Default UI directory. |
| `log` | string | no | File for the spawned agent stdout/stderr (append). When omitted, stdio is inherited from the server. |

SSH-only keys (`target`, `username`, `ssh_port`, `remote_bin`) are rejected on local entries.

```toml
[[agents]]
local = true
name = "local"
dir = "/home/me/projects"
log = "~/.local/share/redoor/log/local.log"
```

## Full shared example

```toml
# Shared by server and agent. Precedence: CLI > env > config file > default.

agent_token = "long-private-secret"

[server]
port = 3000
bind = "127.0.0.1"
cookie_secure = false
# On Linux, omit username/password to use PAM (process owner).
username = "admin"
password = "long-private-password"
# log = "log/server.log"

[agent]
server = "http://127.0.0.1:3000"
name = "macbook"
dir = "/home/me/projects"
# log = "log/agent.log"

[[agents]]
local = true
name = "local"
dir = "/home/me/projects"
log = "~/.local/share/redoor/log/local.log"

[[agents]]
target = "user@example.com"
name = "prod-server"
dir = "/srv/app"
log = "/var/log/redoor/prod-agent.log"
```

## Related environment variables

These override matching config keys when set (CLI still wins):

| Variable | Affects |
| --- | --- |
| `REDOOR_APP_NAME` | Config/data/log namespace (default `redoor`) |
| `REDOOR_PORT` | `[server].port` |
| `REDOOR_SERVER_LOG` | `[server].log` |
| `REDOOR_AGENT_WS` | `[agent].server` |
| `REDOOR_AGENT_TOKEN` | top-level `agent_token` (agent process) |
| `REDOOR_AGENT_NAME` | `[agent].name` |
| `REDOOR_AGENT_DIR` | `[agent].dir` |
| `REDOOR_AGENT_LOG` | `[agent].log` |
| `REDOOR_RELAY_LOG` | relay log path (`redoor agent relay`) |
| `REDOOR_AGENT_NOTIFICATION` | desktop notification delay after connect (`off` disables) |
