# SSH WSS Routing

## Goal

Extend the standalone `redoor ssh` relay command so an agent on an SSH target can connect through the relay machine to a redoor server exposed through HTTPS/WSS.

The SSH target and redoor server do not need direct network connectivity. The machine running `redoor ssh` must be able to reach both.

## End Result

The command will continue to:

- Provision the redoor agent on the SSH target when needed.
- Select a random dynamic listening port on the SSH target.
- Forward that port through SSH to the configured redoor server route.
- Retry with another random port when the remote SSH port is already occupied.
- Run as an attached, standalone command without adding watchdog behavior.

For WSS routes, the agent will connect to the random local tunnel port while identifying the actual redoor server hostname separately. This ensures:

- The TCP connection travels through the SSH tunnel.
- TLS uses the redoor server hostname for SNI.
- The WebSocket request uses the redoor server hostname in its HTTP authority/Host information.
- All agent WebSocket connections use the same secure routing behavior, including control, transfer, logs, and terminal connections.

## CLI Flags

### `--route HOST:PORT`

Keep this required flag.

It identifies the redoor server endpoint reached from the machine running `redoor ssh`.

Examples:

```bash
--route redoor.internal.example:3000
--route redoor.example.com:443
```

For plain WebSocket routing, it remains the destination of the SSH reverse forward.

For WSS routing, its hostname is also the default TLS server identity and HTTP WebSocket authority.

### `--wss`

Add this flag to enable secure WebSocket routing.

Example:

```bash
redoor ssh \
  --route redoor.example.com:443 \
  --wss \
  user@linux-server
```

When enabled:

- The agent uses WSS rather than plain WS.
- The agent connects through the random SSH tunnel port.
- TLS SNI uses the hostname from `--route`.
- WebSocket HTTP authority/Host information uses the hostname from `--route`.
- Certificate verification remains enabled by default.

Without this flag, the command retains its current plain WebSocket behavior.

### `--insecure`

Add this optional flag for WSS endpoints with self-signed, privately issued, expired, or hostname-mismatched certificates.

Example:

```bash
redoor ssh \
  --route redoor.internal.example:443 \
  --wss \
  --insecure \
  user@linux-server
```

Requirements:

- Accept it only together with `--wss`.
- Clearly describe that it disables TLS certificate verification.
- Emit a visible warning when used.
- Never enable it by default.

## Connection Model

For this command:

```bash
redoor ssh --route redoor.example.com:443 --wss user@linux-server
```

The effective connection model will be:

1. Redoor selects a random dynamic port on the Linux SSH target.
2. The Linux agent opens its TCP connection to that local random port.
3. SSH transports the connection to the relay machine.
4. The relay machine connects to `redoor.example.com:443`.
5. The agent performs TLS using `redoor.example.com` as the server identity.
6. The WebSocket request targets the redoor server using the expected secure authority.

The tunnel connection address and the logical server identity must remain separate. The random tunnel endpoint must not become the TLS hostname or WebSocket Host value.

## User Experience

Update command help and documentation to explain:

- When to use the SSH relay command.
- That `--route` is reached from the relay machine, not from the SSH target.
- That `--wss` should be used for HTTPS/WSS deployments.
- That normal certificate verification is enabled by default.
- The security implications of `--insecure`.
- That the command remains attached and does not supervise or restart an agent after successful startup.

Errors should distinguish between:

- SSH authentication or connectivity failures.
- Exhausted random remote-port retries.
- Failure to reach the routed server.
- TLS handshake or certificate verification failures.
- WebSocket upgrade or authentication failures.

## Compatibility

- Existing plain `ws` routing remains supported without `--wss`.
- Existing random-port selection and collision retries remain unchanged.
- Existing managed SSH agents retain their current behavior unless secure routing is explicitly introduced for them separately.
- Agent tokens must continue to avoid process command-line arguments.

## Validation

Validate the completed behavior with coverage for:

- Plain WS routing without `--wss`.
- WSS routing with a trusted certificate.
- WSS routing through a hostname-based reverse proxy, confirming correct SNI and HTTP authority.
- Certificate rejection when verification fails.
- Successful connection with `--insecure` and a visible warning.
- Rejection of `--insecure` without `--wss`.
- All secondary agent WebSockets using the same tunnel and TLS identity behavior.
- Random SSH listener collision retries continuing to work in both WS and WSS modes.

## Non-goals

- Adding a standalone watchdog or automatic restart after successful startup.
- Supporting HTTPS URLs directly in `--route`; it remains a `HOST:PORT` endpoint.
- Changing server-managed agent lifecycle behavior.
- Making insecure certificate handling the default.
