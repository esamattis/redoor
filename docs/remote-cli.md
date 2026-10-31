# Remote CLI

The `redoor remote` subcommand lists devices, copies, moves, searches and deletes files, and executes commands through your Redoor server. Use it to give AI agents control of multiple servers at once.

```sh
redoor remote login https://redoor.example.com
redoor remote devices
redoor remote cp ./report.csv workstation:/srv/report.csv
redoor remote exec workstation -- uptime
redoor remote ls workstation:/srv
redoor remote grep workstation:/srv/app "TODO"
```

Remote paths are written `DEVICE:/absolute/path`. The commands are `devices`, `start`, `stop`,
`exec`, `cp`, `mv`, `ls`, `stat`, `mkdir`, `rm` (to the trash unless `--permanent`), `find`
and `grep`, plus `login`, `logout`, `status` and `create-token`. Most take `--json` for
scripts.

See `redoor remote --help` for available commands and options.

## Logging in

`redoor remote login` asks for your username and password, then lets you choose what the
CLI may do. It creates an **access token** with those permissions and saves only the token;
the password is not stored:

```
Permissions (space toggles, enter accepts):
  [x] files:read — List, stat, read, search and download files
  [x] files:write — Upload, create, overwrite and copy into files
  [ ] files:delete — Trash and delete files, move sources
  [x] commands:execute — Run commands as the agent's OS user (high trust)
  [x] agents:manage — Start/stop managed agents, used by auto-start
Devices: All devices (including devices added later)
Token name: redoor remote on laptop
Expires: 90 days
```

Every prompt also has a flag (`--username`, `--password-stdin`, `--permissions`,
`--devices`, `--name`, `--expires`, `--yes`), so scripts can log in without a terminal.
`redoor remote status` shows the token's permissions, and `redoor remote logout` revokes it.
Tokens are listed, edited and revoked under **Access tokens** in the web UI. Earlier
versions saved a browser session in `remote-session.json`; that file is no longer used and
can be deleted.

## CI jobs and AI agents

Skip the login and pass a token through the environment:

```sh
export REDOOR_REMOTE_SERVER=https://redoor.example.com
export REDOOR_REMOTE_TOKEN=redoor_at_...
redoor remote devices
```

`redoor remote create-token` creates a token the same way as `login` but prints it as JSON
instead of saving it, for configuring MCP clients (see [MCP](mcp.md)).
