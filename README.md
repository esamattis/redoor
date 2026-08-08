# redoor

Remote agent control over WebSockets. Run a **server** (HTTP UI + API) and one or more **agents** that connect back to it.

Each connected agent maintains one authoritative control WebSocket for commands, responses, cancellation, progress, registration, and connection lifecycle. A second persistent, session-authenticated transfer WebSocket carries only bounded binary file-stream frames, preventing congested uploads, downloads, or remote copies from blocking control traffic. Terminal and log WebSockets remain ephemeral, independently authenticated connections.

## Shared config

Server and agent use the same TOML file and the same parser. Default path: `~/.config/redoor/config.toml`.

Precedence for every overridable setting: **CLI > env > config file > default**.

```toml
# Top-level: shared by server and agent (required)
agent_token = "replace-me"

[server]
# Optional browser login. On Linux, omit both to use PAM
# (process owner's system username/password).
# username = "admin"
# password = "long-private-password"

# port = 3000                 # also --port / REDOOR_PORT
# bind = "0.0.0.0"            # also --bind; default 127.0.0.1
# cookie_secure = false       # set true behind HTTPS
# log = "log/server.log"      # also --log

# Standalone agent process (redoor agent / systemd --mode agent)
[agent]
ws_address = "ws://127.0.0.1:3000/ws"   # also positional CLI / REDOOR_AGENT_WS
name = "local"                          # also --name / REDOOR_AGENT_NAME
# dir = "/home/me/projects"             # also -d/--dir / REDOOR_AGENT_DIR
# log = "log/agent.log"                 # also --log / REDOOR_AGENT_LOG

# Server-managed agents (started lazily by the server; not the [agent] table)
[[agents]]
local = true
name = "local"
dir = "/home/me/projects"
log = "log/local.log"

[[agents]]
target = "user@example.com"
# username = "deploy"
# ssh_port = 22
# name = "prod"
# remote_bin = "~/.local/redoor/<version>/redoor"
# dir = "/srv/app"
# log = "log/prod.log"
```

| Key | Where | Required | Notes |
|-----|--------|----------|-------|
| `agent_token` | top-level | yes | Shared registration secret |
| `[server]` | table | server only | Listener + browser auth |
| `[server].username` / `password` | pair | non-Linux; optional on Linux | Both or neither; omit both on Linux for PAM |
| `[server].port` / `bind` / `log` / `cookie_secure` | optional | no | CLI/env overrides where documented |
| `[agent]` | table | agent-only hosts | Full standalone agent settings |
| `[agent].ws_address` / `name` | optional in file | yes after merge | Must come from CLI, config, or env |
| `[agent].dir` / `log` | optional | no | Defaults: process cwd / stderr |
| `[[agents]]` | array | no | Server-managed local/SSH fleet |

Reload after editing: UI **Reload config**, or the reload API (restarts the process and re-reads the file).

Configured `[[agents]]` start lazily when their tab or status page is opened, or when **Start** is used from the **Agents** management view. The view retains stopped and previously disconnected agents, reports connection and startup issues, and provides lifecycle controls for TOML-managed agents. Externally launched agents are observation-only.

## Server

```bash
redoor server
redoor server --config /path/to/config.toml
redoor server --port 3000 --bind 127.0.0.1 --log log/server.log
```

| Flag | Env | Config | Default |
|------|-----|--------|---------|
| `--config` | | | `~/.config/redoor/config.toml` (created on first run) |
| `--port` | `REDOOR_PORT` | `[server].port` | `3000` |
| `--bind` | | `[server].bind` | `127.0.0.1` |
| `--log` | | `[server].log` | stderr |

First start without `--config` creates `~/.config/redoor/config.toml` and prints generated secrets once.

## Agent

Usually started by the server via `[[agents]]`. Manual start (any required value may come from CLI, config, or env):

```bash
redoor agent
redoor agent ws://127.0.0.1:3000/ws --name my-host --token "$TOKEN"
redoor agent --config ~/.config/redoor/config.toml
redoor agent wss://example.com/ws --name edge -d /var/app --log log/agent.log
```

| Flag | Env | Config | Default |
|------|-----|--------|---------|
| `[WS_ADDRESS]` | `REDOOR_AGENT_WS` | `[agent].ws_address` | (required from one source) |
| `--name` | `REDOOR_AGENT_NAME` | `[agent].name` | (required from one source) |
| `--token` | `REDOOR_AGENT_TOKEN` | top-level `agent_token` | (required from one source) |
| `--config` | | | `~/.config/redoor/config.toml` when present |
| `-d` / `--dir` | `REDOOR_AGENT_DIR` | `[agent].dir` | process cwd |
| `--log` | `REDOOR_AGENT_LOG` | `[agent].log` | stderr |

When every required field is set in the TOML, `redoor agent` needs no flags. Startup errors if `ws_address`, `name`, or `agent_token` are still missing after applying precedence.

## systemd (Linux user services)

Install and start a lingering user service so the process keeps running after logout:

```bash
redoor setup-systemd --user --mode server
redoor setup-systemd --user --mode agent
```

| Flag | Description |
|------|-------------|
| `--user` | Required. Install into the current non-root user's systemd manager |
| `--mode server` | Writes and enables `~/.config/systemd/user/redoor-server.service` |
| `--mode agent` | Writes and enables `~/.config/systemd/user/redoor-agent.service` |

Creates `~/.config/redoor/config.toml` when missing (server prints generated secrets once; agent prompts for the token and writes a complete `[agent]` section). Enables linger via `loginctl`, then `systemctl --user enable --now` for the unit.

The agent unit runs bare `redoor agent` with **no CLI flags or environment variables** — configure everything in the TOML (`agent_token` + `[agent]`). Setup refuses to install if the existing file is incomplete for standalone agent startup.
