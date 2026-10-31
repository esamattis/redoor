# Upgrade

```bash
redoor upgrade
```

This runs the same install script over the binary you invoked and restarts the local redoor server, agents and relays that run it, in place, including systemd and launchd services. The Update button next to the version on the web UI home page does the same for the server's binary.

- Pass a tag such as `redoor upgrade v1.3.1` to pick a release instead of the latest one.
- Pass `--no-restart` to only replace the binary. Running processes keep the old version until they are restarted.
- Use `sudo redoor upgrade` when the binary or the services belong to root.
