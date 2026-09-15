# Docker Compose deployment

Use an external configuration and persistent volume for a long-running Redoor server. The image supports `linux/amd64` and `linux/arm64`.

## Configuration

Create a private deployment directory containing `config.toml`:

```toml
agent_token = "replace-with-a-long-random-secret"

[server]
bind = "0.0.0.0"
username = "admin"
password = "replace-with-a-long-private-password"
```

The server must bind to `0.0.0.0` inside the container. Keep the configuration file readable by the container and restrict access to its parent directory because it contains credentials.

## Compose file

Add `compose.yaml` in the same directory:

```yaml
services:
  redoor:
    image: ghcr.io/esamattis/redoor:latest
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:7666:7666"
    volumes:
      - ./config.toml:/etc/redoor/config.toml:ro
      - redoor-home:/home/redoor

volumes:
  redoor-home:
```

The named volume preserves server state, logs, cached agent binaries, and SSH files across container replacement. For reproducible deployments, replace `latest` with a specific release version.

Start the server in the background:

```bash
docker compose up --detach
```

Inspect its status and logs:

```bash
docker compose ps
docker compose logs --follow redoor
```

Pull and deploy a newer image:

```bash
docker compose pull
docker compose up --detach
```

Stop the deployment without deleting its persistent volume:

```bash
docker compose down
```

## Network exposure

The example publishes Redoor only on the host loopback interface. Put an HTTPS reverse proxy in front of it when providing remote access, then set `cookie_secure = true` in `config.toml`. See [Deployment](deployment.md) for proxy streaming settings needed by large uploads.

Publishing `7666:7666` directly on all host interfaces is not recommended unless access is protected by another network layer.
