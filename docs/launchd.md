# macOS launchd services

Redoor can install the server or standalone agent as a per-user macOS LaunchAgent. A LaunchAgent starts at login in the current user's GUI session and does not require root privileges.

Redoor does not install a system LaunchDaemon. Run all `launchd` commands as the user who should own and run the service, without `sudo`.

## Prerequisites

The default configuration is `~/.config/redoor/config.toml`. The selected service must be fully configured before installation because launchd cannot supply missing interactive settings.

For a standalone agent, configure the shared token and server:

```toml
agent_token = "secret"

[agent]
server = "https://redoor.example.com"
name = "macbook"
```

For a server, the configuration must contain a `[server]` section. Run `redoor server` once to create a starter configuration if the file does not exist.

## Install

Install and start an agent:

```bash
redoor agent launchd install --start
```

Install and start a server:

```bash
redoor server launchd install --start
```

Without `--start`, installation enables automatic startup at the next login but leaves the service stopped.

Installation writes one of these property lists:

```text
~/Library/LaunchAgents/redoor-agent.plist
~/Library/LaunchAgents/redoor-server.plist
```

The property list records the absolute path of the Redoor executable used for installation and passes the absolute default configuration path. It also sets `REDOOR_APP_NAME` so the service keeps the selected application namespace.

Use `--app-name` when maintaining an installation with a non-default namespace:

```bash
redoor agent launchd --app-name staging install --start
redoor agent launchd --app-name staging status
```

This creates a namespace-specific service label, configuration directory, and log directory.

## Manage services

Replace `agent` with `server` in these commands to manage the server LaunchAgent.

```bash
redoor agent launchd start
redoor agent launchd stop
redoor agent launchd restart
redoor agent launchd status
redoor agent launchd enable
redoor agent launchd disable
redoor agent launchd disable --now
redoor agent launchd uninstall
```

The operations have these effects:

| Command | Effect |
| --- | --- |
| `start` | Load and start the installed service. |
| `stop` | Stop and unload it while retaining automatic startup at the next login. |
| `restart` | Reload the installed property list and restart the process. |
| `status` | Show whether the service is installed, enabled, loaded, and running. |
| `enable` | Enable automatic startup without starting the service now. |
| `disable` | Disable automatic startup without stopping a running process. |
| `disable --now` | Disable automatic startup and stop the process. |
| `uninstall` | Stop the process and remove its property list while preserving configuration and logs. |

Add `--verbose` to show output from the underlying `launchctl` commands:

```bash
redoor agent launchd --verbose restart
```

## Configuration and logs

Restart the service after changing its configuration:

```bash
redoor agent launchd restart
```

Follow the role-specific file log with Redoor:

```bash
redoor agent logs --follow
redoor server logs --follow
```

Unless overridden in the configuration, logs use these paths:

```text
~/.local/share/redoor/agent.log
~/.local/share/redoor/server.log
```

launchd does not run through an interactive shell. Shell aliases, shell initialization files, and terminal environment variables are therefore unavailable. Put persistent service settings in `config.toml` rather than relying on the terminal environment.

## Updating or moving the binary

The property list contains the absolute executable path selected during installation. Reinstall the service when moving Redoor to another path:

```bash
redoor agent launchd install --start
```

Replacing the executable at the same path does not require reinstalling the property list. Restart the service to run the new binary:

```bash
redoor agent launchd restart
```

On macOS, replacing an ad-hoc-signed executable can invalidate its existing Local Network permission even when its path is unchanged. See [Launchd agent cannot access the local network](#launchd-agent-cannot-access-the-local-network) if an updated agent works in a terminal but fails under launchd.

## Troubleshooting

### Service is not running

Check Redoor's view of the service first:

```bash
redoor agent launchd status
redoor agent logs --follow
```

Inspect the launchd job directly when more detail is needed:

```bash
launchctl print "gui/$(id -u)/redoor-agent"
```

Use `redoor-server` for the server or the namespace-specific label shown during installation.

If the property list is missing or refers to an old executable path, run `install` again. Installation safely replaces the existing definition.

### Configuration changes have no effect

Confirm the property list's `ProgramArguments` contains the expected configuration path:

```bash
plutil -p "$HOME/Library/LaunchAgents/redoor-agent.plist"
```

Then restart the service. launchd does not automatically restart Redoor when `config.toml` changes.

### Launchd agent cannot access the local network

On recent macOS versions, a launchd agent can report this error while the same `redoor agent` command works in a terminal:

```text
Connection failed: failed to connect to WebSocket server: IO error: No route to host (os error 65)
```

This problem applies when the configured server resolves to a private address, such as an address in `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`.

An interactive agent inherits the Local Network permission of its terminal application. A launchd process is evaluated independently using the identity of the Redoor executable.

Redoor release binaries are currently ad-hoc signed and have no Apple Developer Team ID. Replacing the binary changes its Mach-O UUID. macOS may retain a Local Network preference containing the previous UUID and deny the replacement binary, even though **System Settings > Privacy & Security > Local Network** still shows Redoor as enabled. Multiple Redoor rows can refer to the same underlying permission rule, so changing one toggle may change all of them.

Confirm a stale identity by inspecting the macOS network privacy log:

```bash
log stream --info --debug \
  --predicate 'subsystem == "com.apple.networkextension" AND eventMessage CONTAINS[c] "redoor"'
```

The relevant messages look like this:

```text
Received UUID <current UUID> ... does not match cached UUIDs (<old UUID>)
Local network denied by preference for redoor
```

Toggling an existing Redoor entry off and on may not repair its cached UUID. On macOS versions where NetworkExtension manages this permission, `tccutil reset LocalNetwork` is also unavailable.

Create a fresh local identity and permission record with:

```bash
redoor agent launchd refresh-local-network-permission
```

The command:

1. Reads the executable path from the installed LaunchAgent property list.
2. Refuses to alter a binary carrying an Apple Developer Team ID.
3. Copies the ad-hoc-signed executable to a sibling temporary file.
4. Signs the copy with a new unique identifier and verifies its signature.
5. Stops the LaunchAgent, atomically replaces the executable, and starts it again.

Redoor prints every external command it executes during this operation. Preparing and verifying the replacement before stopping the service keeps downtime short and avoids modifying the executable from which the repair command is running.

Select **Allow** when macOS asks whether Redoor may find devices on local networks. Then verify the connection:

```bash
redoor agent launchd status
redoor agent logs --follow
```

A successful log contains `Connected to ...` and `Transfer socket connected`.

The repair supplies a fresh ad-hoc identity only. It does not establish publisher trust, and installing another Redoor release replaces the signature. Run the command again if the launchd-only failure returns after an update.

The durable distribution-level solution is to sign macOS release binaries with a stable Apple Developer ID and identifier. macOS can then associate replacement binaries with the same team and designated requirement instead of relying on one ad-hoc build's UUID.
