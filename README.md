# redoor

Remote agent control over WebSockets. Run a **server** (HTTP UI + API) and one or more **agents** that connect back to it.

## Server

```bash
redoor server
redoor server --config /path/to/config.toml
redoor server --port 3000 --bind 127.0.0.1 --log log/server.log
```

| Flag | Env | Default |
|------|-----|---------|
| `--config` | | `~/.config/redoor/config.toml` (created on first run) |
| `--port` | `REDOOR_PORT` | `3000` |
| `--bind` | | `127.0.0.1` |
| `--log` | | stderr |

Precedence: **CLI > config file > env > default**.

### `config.toml`

```toml
# redoor server --config config.toml
# First start without --config creates ~/.config/redoor/config.toml

[server]
agent_token = "replace-me"   # required; agents must present this secret

# Optional browser login. On Linux, omit both to use PAM
# (process owner's system username/password).
# username = "admin"
# password = "long-private-password"

# port = 3000
# bind = "0.0.0.0"          # only when intentionally exposing the server
# cookie_secure = false     # set true behind HTTPS
# log = "log/server.log"

# Local agent: server lazily spawns `redoor agent` as a child process
[[agents]]
local = true
name = "local"              # optional; defaults to hostname
dir = "/home/me/projects"   # optional; UI default directory
log = "log/local.log"       # optional; agent stdout/stderr file

# SSH agent: server lazily sshes in, reverse-tunnels, and runs the remote agent
[[agents]]
target = "user@example.com" # required for ssh agents
# username = "deploy"       # optional; or use user@host / ssh config
# ssh_port = 22
# name = "prod"             # optional; defaults to host portion of target
# remote_bin = "~/.local/redoor/<version>/redoor"
# dir = "/srv/app"
# log = "log/prod.log"      # local file capturing remote agent output
```

Reload after editing: UI **Reload config**, or the reload API (restarts the process and re-reads the file).

Configured agents start lazily when their tab or status page is opened, or when **Start** is used from the **Agents** management view. The view retains stopped and previously disconnected agents, reports connection and startup issues, and provides lifecycle controls for TOML-managed agents. Externally launched agents are observation-only.

## Agent

Usually started by the server via `[[agents]]`. Manual start:

```bash
redoor agent ws://127.0.0.1:3000/ws --name my-host --token "$TOKEN"
redoor agent ws://127.0.0.1:3000/ws --name my-host --config ~/.config/redoor/config.toml
redoor agent wss://example.com/ws --name edge -d /var/app --log log/agent.log
```

| Flag | Env | Default |
|------|-----|---------|
| `<WS_ADDRESS>` | | (required) e.g. `ws://host:3000/ws` |
| `--name` | | (required) registration name |
| `--token` | `REDOOR_AGENT_TOKEN` | from `--config` → `[server].agent_token` |
| `--config` | | `~/.config/redoor/config.toml` (token only) |
| `-d` / `--dir` | | process cwd (UI default directory) |
| `--log` | | stderr |

The agent config file is the same shape as the server's: only `[server].agent_token` is read.

```toml
[server]
agent_token = "same-as-server"
```
