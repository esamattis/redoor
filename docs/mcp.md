# MCP

Redoor exposes an authenticated, stateless MCP endpoint at `POST /mcp`. The
implementation targets only the published `2026-07-28` protocol and provides
`server/discover`, `tools/list`, and authenticated device tools. Every
request is independent: there is no `initialize` handshake, MCP session ID,
standalone GET event stream, resumable SSE, or client capability remembered
from an earlier request.

## Create an access token

MCP clients authenticate with an **access token**, the same kind of credential
the remote CLI uses. Create one under **Access tokens** in Redoor's application
menu. Choose only the permissions and devices the client needs, create the
token, and copy both the endpoint and the token from the one-time result. If
your last sign-in was more than a minute ago, Redoor asks you to sign in again
before it creates the token (see
[Access tokens need a fresh sign-in](remote-cli.md#access-tokens-need-a-fresh-sign-in)). The
result also offers a ready-made **AI agent setup prompt** containing the
endpoint and token, which you can paste to an AI agent so it configures the
server for itself.

Permissions:

| Permission | Allows |
|---|---|
| `files:read` | List, stat, read and search files |
| `files:write` | Write files, create directories, copy destinations |
| `files:delete` | Trash and delete files, move sources |
| `commands:execute` | Run commands as the agent's OS user (high trust: this bypasses every file permission) |
| `agents:manage` | Start and stop managed agents |

The device scope is either **all devices** (including devices added later) or
an explicit list of devices. Listing devices needs no permission, but only
shows devices in the token's scope.

A local managed agent runs as the same OS user as the server. Write or command
access to it can therefore change the server's own files, so leave such devices
out of the scope of tokens that should not have full control.

On a headless machine, create one with the remote CLI instead. It prints a URL
and a code; approve the token in a browser where you are signed in to Redoor
(on any device), and the command prints the token and the MCP endpoint as JSON
without saving anything. Its flags suggest the permissions and devices:

```sh
redoor remote create-token http://127.0.0.1:7666 --permissions files:read,files:write
```

Redoor stores only a SHA-256 verifier of each token, so the token cannot be
shown again; save it in the client's secret store. Editing a token changes its
permissions on the next request without a new secret. Rotation issues a new
secret for the same token and invalidates the old one at once. Deleting a
token rejects every later request that uses it. Tokens are independent of the
login password: changing the password does not invalidate them.

Tokens can only be created and managed by a browser session, and creating or
rotating one needs a sign-in from the last minute; `redoor remote login` and
`create-token` are approved in such a browser too. A token can never create or
edit tokens, so it cannot widen its own access.

Old `server mcp-token` credentials are not migrated. The files
`mcp/machine-tokens.json`, `mcp/machine-tokens.lock` and `mcp/operations/` in
the application data directory are no longer used and can be deleted.

## Client configuration

Configure an HTTP MCP client with the endpoint and bearer header:

```json
{
    "servers": {
        "redoor": {
            "url": "http://127.0.0.1:7666/mcp",
            "headers": {
                "Authorization": "Bearer YOUR_ACCESS_TOKEN"
            }
        }
    }
}
```

This generic shape applies only to clients that implement MCP `2026-07-28`.
Each POST must include:

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method` matching the JSON-RPC method
- `Mcp-Name` matching `params.name` for `tools/call`, using the specification's
  Base64 sentinel encoding when it is not safe plain ASCII
- `params._meta["io.modelcontextprotocol/protocolVersion"]`
- `params._meta["io.modelcontextprotocol/clientCapabilities"]`, which may be
  an empty object

Client identity in `_meta` is optional diagnostic information and never
changes authorization. A direct first request may be `tools/call`; discovery
is optional.

The official TypeScript and Rust MCP SDK releases reviewed for this work do
not yet expose the final `2026-07-28` stateless wire contract. In particular,
their older "stateless HTTP" modes still use initialization-era messages and
do not establish support for per-request metadata or `Mcp-Method`/`Mcp-Name`.
The integration tests therefore use a small revision-specific HTTP helper in
`tests/mcp-client.ts`. Initialization-era clients, including clients that open
MCP with GET or require an `Mcp-Session-Id`, are not compatible.

## Network and Origin security

Redoor binds to loopback by default. Keep the loopback URL for a client on the
same machine. Remote deployments must terminate HTTPS before exposing MCP;
bearer tokens must not cross an unencrypted remote network.

Origin-less native clients are accepted. Browser clients must have their exact
origin configured:

```toml
[server]
mcp_allowed_origins = ["https://trusted-client.example"]
```

An unconfigured or malformed `Origin` receives 403. MCP has its own narrow
CORS and bearer middleware and does not inherit the wildcard browser API CORS
or the rule that treats non-`/api/` paths as public.

Responses are bounded JSON. This initial server does not emit SSE, advertise
subscriptions/resources/prompts, or initiate calls into a client.

## Device tools and authorization

The catalog contains `hello`, `list_devices`, `get_device`, `run_command`,
`get_operation`, `read_command_output`, `cancel_operation`, `list_directory`,
`stat_path`, `read_file`, `write_file`, `copy_path`, `move_path`,
`delete_path`, `create_directory`, `search_paths`, `search_contents`,
`start_managed_agent` and `stop_managed_agent`. `tools/list` only returns the
tools the token's permissions allow, so a model never sees tools it cannot use.

| Tool | Permissions |
|---|---|
| `hello`, `list_devices`, `get_device` | none (inventory is filtered to the device scope) |
| `run_command`, `read_command_output` | `commands:execute` |
| `get_operation`, `cancel_operation` | the permissions of the operation's kind |
| `list_directory`, `stat_path`, `read_file`, `search_paths`, `search_contents` | `files:read` |
| `write_file`, `create_directory` | `files:write` |
| `copy_path` | `files:read` on the source, `files:write` on the destination |
| `move_path` | `files:read`, `files:write` and `files:delete` on the source, `files:write` on the destination |
| `delete_path` | `files:delete` |
| `start_managed_agent`, `stop_managed_agent` | `agents:manage` |

Every filesystem request includes an explicit `device_id` and absolute path.
`device_id` accepts the stable device id or the device's current name; the id
keeps pointing at the same device after a rename, a name follows whichever
device has it now. There is no remembered device or working directory. Each call checks its
permissions on the devices it touches through the same decision function the
REST API uses. Managed lifecycle calls reject external agents.

Background commands and copy/move calls return an operation UUID. Operation
state, output pages, and cancellation are restricted to the access token that
admitted the work; rotating the token keeps its id, so ownership survives
rotation. Current device and permission checks run again when work is
inspected or canceled. Cancellation acceptance is reported separately from
remote termination acknowledgement. Optional `idempotency_key` values on
transfer admission are scoped to the token and bound to the tool and its
arguments; reusing a key for a different tool or different arguments is
rejected. Concurrent retries share one durable operation UUID. If a keyed
admission's remote start fails, inspect that operation for the failure;
retrying the same key returns the original admission without starting new
work. Transfer completion is persisted independently of client polling. After
a server restart, retained operations cannot cancel work admitted by the new
server.

`read_file` and `write_file` are limited to 64 KiB per call. MCP does not
transfer big files between the client and a device; use the remote CLI
(`redoor remote cp`) for that. Copies and moves between devices have no size
limit, because the bytes stay in Redoor's backpressured device transfer
pipeline and never pass through the MCP client. Command retention defaults to
1 MiB per operation and 64 MiB globally, reports truncation while continuing to
drain the agent stream, and expires after 24 hours. Configure these with
`REDOOR_MCP_OPERATION_JOB_QUOTA`, `REDOOR_MCP_OPERATION_GLOBAL_QUOTA`, and
`REDOOR_MCP_OPERATION_EXPIRY_SECONDS`. Directory and search results are
bounded.

The deployment remains single-server: live agent routes and transfer progress
are process-local. Operation admissions and retained command output are durable;
a server restart marks work lacking a terminal acknowledgement `interrupted`
and never repeats it. Multiple replicas require shared
operation storage plus routing to the server that owns each device connection.
Filesystem-root confinement is not implemented; stronger confinement must be
canonical, symlink-aware, and enforced by the agent or its OS container.
