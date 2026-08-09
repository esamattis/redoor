# redoor

Remote agent (not AI one) control over WebSockets. Run a **server** (HTTP UI + API) and one or more **agents** that connect back to it. Features: file explorer, download/upload, remote shell.

## Install

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/esamattis/redoor/refs/heads/main/install.sh)"
```

This just puts the `redoor` binary in `~/.local/bin` (or `/usr/local/bin` as root).

To configure background services do

```bash
redoor server systemd setup
redoor agent systemd setup
```

or for macOS

```bash
redoor server launchd setup
redoor agent launchd setup
```

## Configuration

Server and agent use the same TOML file. Default path: `/etc/<app-name>/config.toml` when running as root, otherwise `~/.config/<app-name>/config.toml`.

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

# Standalone agent process (`redoor agent` or `redoor agent systemd|launchd`)
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
