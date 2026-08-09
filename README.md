# redoor

Remote agent (not AI one) control over WebSockets. Run a **server** (HTTP UI + API) and one or more **agents** that connect back to it. Features: file explorer, download/upload, remote shell.

## Shared config

Server and agent use the same TOML file and the same parser. Default path: `/etc/<app-name>/config.toml` when running as root, otherwise `~/.config/<app-name>/config.toml`. The root option `--app-name <name>` or its `REDOOR_APP_NAME` environment equivalent selects `<app-name>` and defaults to `redoor`, allowing independent installations to use separate config, data, log, SSH cache, and systemd namespaces. Managed agents receive the selected root option explicitly.

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
# remote_bin = "${XDG_DATA_HOME:-$HOME/.local/share}/<app-name>/binaries/<version>/redoor"
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
| `--config` | | | `/etc/<app-name>/config.toml` as root, else `~/.config/<app-name>/config.toml` (created on first run) |
| `--port` | `REDOOR_PORT` | `[server].port` | `3000` |
| `--bind` | | `[server].bind` | `127.0.0.1` |
| `--log` | | `[server].log` | stderr |

First start without `--config` creates the conventional path above and prints generated secrets once.

## Agent

Usually started by the server via `[[agents]]`. Manual start (any required value may come from CLI, config, or env):

```bash
redoor agent
redoor agent ws://127.0.0.1:3000/ws --name my-host --token "$TOKEN"
redoor agent --config ~/.config/<app-name>/config.toml
redoor agent wss://example.com/ws --name edge -d /var/app --log log/agent.log
```

| Flag | Env | Config | Default |
|------|-----|--------|---------|
| `[WS_ADDRESS]` | `REDOOR_AGENT_WS` | `[agent].ws_address` | (required from one source) |
| `--name` | `REDOOR_AGENT_NAME` | `[agent].name` | (required from one source) |
| `--token` | `REDOOR_AGENT_TOKEN` | top-level `agent_token` | (required from one source) |
| `--config` | | | `/etc/<app-name>/config.toml` as root, else `~/.config/<app-name>/config.toml` when present |
| `-d` / `--dir` | `REDOOR_AGENT_DIR` | `[agent].dir` | process cwd |
| `--log` | `REDOOR_AGENT_LOG` | `[agent].log` | stderr |

When every required field is set in the TOML, `redoor agent` needs no flags. Startup errors if `ws_address`, `name`, or `agent_token` are still missing after applying precedence.

## systemd (Linux)

Install and start a service. Non-root installs a lingering user unit; root installs a system unit.

```bash
# as your user (user systemd + linger)
redoor setup-systemd --mode server
redoor setup-systemd --mode agent

# as root (system systemd)
sudo redoor setup-systemd --mode server
sudo redoor setup-systemd --mode agent
```

| Flag | Description |
|------|-------------|
| `--mode server` | Non-root: `~/.config/systemd/user/redoor-server.service`. Root: `/etc/systemd/system/redoor-server.service` running as the `redoor` system user |
| `--mode agent` | Non-root: `~/.config/systemd/user/redoor-agent.service`. Root: `/etc/systemd/system/redoor-agent.service` running as root |
| `--unit-name NAME` | Override the unit file name (appends `.service` if missing). Use to install multiple agents/servers on one host |

Creates the conventional shared config when missing (`~/.config/<app-name>/config.toml` non-root, `/etc/<app-name>/config.toml` as root). Agent and server modes write the same starter file (generated `agent_token`, `[server]`, `[agent]`, and a managed local `[[agents]]` entry). Log paths default to `~/.local/share/<app-name>/{server,agent}.log` for user installs and `/var/log/<app-name>/{server,agent}.log` as root. Generated units persist `REDOOR_APP_NAME` and default to `<app-name>-server.service` or `<app-name>-agent.service`. Secrets are printed once; nothing is prompted. The unit is always enabled on boot but **never** started by setup — start it yourself after reviewing the config (agent settings usually need changes).

Non-root enables linger via `loginctl`. Root creates the fixed `redoor` service user when installing the server, chowns `/etc/<app-name>` and pre-creates `/var/log/<app-name>` for that user.

The agent unit runs `redoor agent --config <path>` with no other CLI flags or environment variables — configure everything in the TOML (`agent_token` + `[agent]`). Setup refuses to install if the existing file is incomplete for standalone agent startup.
