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

`redoor remote login` logs in through your browser, like `gh auth login`. It prints a URL
and a code:

```
To approve this login, open this page in a browser where you are signed in to Redoor:

    https://redoor.example.com/cli-login/3q2-7xYm...

and enter the code KTPW-HZRB

Waiting for approval (expires in 10 minutes, Ctrl-C cancels)...
```

Open the page in any browser where you are signed in to Redoor, on this machine or another
one such as your phone. It shows which machine asked, so check it is the one where you
just ran the command. Type the code from the terminal, choose what the CLI may do
(permissions, devices, name, expiry) and press **Approve**. Redoor asks you to sign in again
first if your last sign-in was more than a minute ago (see
[Access tokens need a fresh sign-in](#access-tokens-need-a-fresh-sign-in)). The command then
continues by itself and saves the new **access token**; no password is ever typed into or
stored by the CLI. **Deny** turns the request down, and the command stops.

The flags `--permissions`, `--devices`, `--name` and `--expires` only fill in the form in the
browser, where you have the final say. Without them the form suggests everything but
`files:delete` on all devices, named `redoor remote on <hostname>`, expiring in 90 days.

Scripts cannot create tokens on their own: a person approves each one in the browser. For
CI jobs, create a token once and pass it through the environment (see below).

`redoor remote status` shows the token's permissions, and `redoor remote logout` revokes it.
Logging in again replaces and revokes the previous token for the same server. Tokens are
listed, edited and revoked under **Access tokens** in the web UI. Earlier versions saved a
browser session in `remote-session.json`; that file is no longer used and can be deleted.

### Access tokens need a fresh sign-in

Creating or rotating an access token, in the web UI or for the CLI, needs a sign-in from the
last minute. If someone copies your browser profile, they get your signed-in session but
cannot turn it into a long-lived token without your password. When your sign-in is older,
Redoor sends you to the sign-in page as the last step and back to the filled-in form, where
you press the button again. With single sign-on (OIDC) the identity provider is asked to
check your credentials again, even if you are signed in there.

## Servers with a self-signed certificate

When the server uses [`[server.tls] self_signed = true`](config.md#servertls-built-in-https),
add `--insecure-tls` to `login` (or `create-token`) to skip certificate verification.
`login` saves the choice with the token, so later commands need no flag, and
`redoor remote status` shows `Certificate: not verified`. With the environment override,
set `REDOOR_REMOTE_INSECURE_TLS=true`. Anyone able to intercept the connection could then
read your token, so only use it on networks you trust.

```sh
redoor remote login https://192.168.1.10:7666 --insecure-tls
```

## CI jobs and AI agents

Skip the login and pass a token through the environment. Create the token under **Access
tokens** in the web UI or with `redoor remote create-token`:

```sh
export REDOOR_REMOTE_SERVER=https://redoor.example.com
export REDOOR_REMOTE_TOKEN=redoor_at_...
redoor remote devices
```

`redoor remote create-token` creates a token through the browser the same way as `login` but
prints it as JSON instead of saving it, for configuring MCP clients (see [MCP](mcp.md)).
