# Remote CLI

The `redoor remote` namespace talks to an existing server over its REST API.
Start with login; subsequent invocations use the selected server automatically.

```sh
redoor remote login https://redoor.example.com
redoor remote agents
redoor remote agents --json
redoor remote cp ./report.csv agent-a:/srv/report.csv
redoor remote cp agent-a:/srv/report.csv ./report.csv
redoor remote cp -r agent-a:/srv/project agent-b:/srv/project
redoor remote exec --cwd /srv/project --timeout 5m agent-a -- pnpm test
redoor remote logout
```

## Commands

- `remote login <SERVER_URL>` prompts for the same username and password used by
  the Web UI (configured credentials or the server account's PAM credentials).
  Password input is hidden and read from the controlling terminal. URLs must be
  absolute HTTP/HTTPS URLs without embedded credentials, query, or fragment.
  Reverse-proxy prefixes such as `https://example.com/redoor/` are supported.
  A successful login selects that server. Any failed login preserves the prior
  saved session. HTTPS is required when the server issues a Secure cookie.
- `remote agents` prints a table with ID, name, and connection status. IDs are the
  identifiers for subsequent remote operations. An empty inventory prints
  `No agents available.` and succeeds.
- `remote agents --json` prints the full API response object, shaped as
  `{ "agents": [...] }`, preserving agent details and a successful empty array.
- `remote logout` calls the existing server logout API and removes local session
  state. It succeeds when already logged out or when authentication has expired.
  If a transport/API failure prevents remote invalidation, local credentials are
  still removed and the command reports the failure.

Success returns exit code **0**. Authentication, transport, API, and storage
failures return **1**, except for execution (see below); invalid command-line arguments return **2**. Diagnostics
and login/logout status messages go to stderr, leaving JSON stdout usable by
scripts. Missing, expired, or rejected authentication directs you to log in again.

## Persistent authentication

Default storage is `~/.local/share/redoor/remote-session.json`. Select independent
sessions using the global `--app-name <NAME>` option or `REDOOR_APP_NAME`:

```sh
redoor --app-name production remote login https://redoor.example.com
redoor --app-name production remote agents
redoor --app-name production remote logout
```

This uses `~/.local/share/production/remote-session.json`, following the existing
application namespace convention. The application directory is user-only (0700),
and the session and lock files are user-only (0600). Writes use a private temporary
file, file synchronization, atomic rename, and directory synchronization. Existing
unsafe files and session-file symlinks are rejected when loading.

The saved state includes the server URL and complete cookie metadata: host-only
versus Domain scope, Path, Secure, HttpOnly, SameSite, session-cookie lifetime, and
absolute expiration. Max-Age is converted to an absolute expiry when received,
so a new CLI invocation never renews a cookie by loading it. Secure cookies are
sent only over HTTPS, including on loopback. Responses persist cookie rotations
and deletions even on HTTP errors. Redirects are rejected instead of forwarding
credentials. Credentials are not stored as a username/password pair.

Session updates merge response cookies under a cross-process lock. A new login
has a new generation, so late responses and logout from older commands cannot
overwrite a newer selection or recreate a logged-out session.

## Shared implementation interfaces

Copy and execution modules live alongside these commands in `src/remote`:

- `SessionStore::for_current_namespace()` resolves the store; `new(directory)`
  provides isolated storage for tests.
- `RemoteClient::load(store).await` loads the selected authenticated session.
  Clone the client for simultaneous streaming and control requests.
- `client.endpoint(path)` resolves paths relative to the selected server prefix.
- `client.request(method, path)` returns a reqwest builder for query parameters,
  headers, timeouts, and streamed bodies. Use `client.send(builder).await` to
  enforce origin checking, attach fresh cookies, persist response cookies, and
  validate HTTP/authentication status. The returned response body is unbuffered.
- `client.json_request(method, path, &payload)` builds JSON control requests;
  `client.get_json::<ResponseType>(path).await` decodes typed GET responses.
  Control GETs, login, and logout have a 30-second deadline. Streaming requests
  have no transfer-wide deadline; callers can set one on their builder.

No session lock is held during network IO or response streaming. The store's
`replace`, `update_cookies`, and generation-aware `remove` methods own persistence;
feature modules should send through the shared client rather than manage cookies.

## Copying files and directories

```text
redoor remote cp [-r|--recursive] [--on-existing error|override|merge]
                 [--quiet] [--json] <SOURCE> <DESTINATION>
```

At least one endpoint must be remote: `AGENT:/absolute/path`. Use the IDs from
`remote agents`. Local relative paths resolve against the current working
directory. Prefix local colon filenames with `./`, for example `./report:2026.csv`.
Quote paths containing spaces or shell metacharacters. Remote paths must be
resolved absolute paths without `.` or `..` components; filesystem roots are not
supported as sources because they have no source basename.

An existing destination directory receives the source basename. Otherwise the
destination names the resulting file or directory. This applies equally to
uploads, downloads, and agent-to-agent copies. A destination ending in `/` must
already be a directory. Parent directories must already exist. Directories
require `-r`; files do not.

The conflict policy applies to the **resolved resulting path**:

| Mode | Behavior |
| --- | --- |
| `error` (default) | Fail if the resulting path exists; preserve existing content. |
| `override` | Replace the entire resulting file or directory, including destination-only entries. |
| `merge` | Merge directory trees and preserve destination-only entries; replace conflicting files. File-to-file merge replaces contents. Root type mismatches and symlink roots are rejected. |

For example, copying `agent-a:/srv/project` into existing `agent-b:/srv/backup`
targets `/srv/backup/project`. To merge into that resulting directory, use
`--on-existing merge`. Copying into an existing directory named `project` instead
targets its child `project`, following the same basename rule.

Files stream through raw GET/PUT APIs. Recursive uploads generate plain tar
directly into HTTP; downloads extract the server's gzip/tar stream into a private
sibling staging directory and remove the archive's source-root layer. Archives
are never saved or buffered in full. Only regular files and directories are
supported inside recursive copies; links and special files fail. File permission
bits are retained in recursive archives, but this is not a full metadata backup
(directory modes, ownership and timestamps are not guaranteed across directions).
Agent-to-agent copies use `POST /api/v1/copy`: payloads never traverse the CLI.

Commands wait for destination completion. Human progress and completion go to
stderr; successful non-JSON copies have empty stdout. `--quiet` suppresses those
messages but retains failure diagnostics. `--json` suppresses progress and emits
one stdout object (also on authentication, preflight, transfer or interruption
failure):

```json
{
  "status": "completed",
  "source": "./report.csv",
  "destination": "agent-a:/srv",
  "resolved_destination": "agent-a:/srv/report.csv",
  "bytes_transferred": 1234,
  "error": null
}
```

Failures use `status: "failed"`, a non-null `error`, and exit code **1**; interrupted
copies also return **1**. Failed results have a null `resolved_destination`.
Byte counts are transport counts: raw bytes for files, plain-tar bytes for
recursive uploads and agent copies, compressed HTTP bytes for directory downloads.
They are progress measurements rather than a content-size comparison.

SIGINT/Ctrl-C and SIGTERM cancel streaming requests and explicitly cancel active
uploads and server-side copies. Uploads use a caller-owned request token so even
the post-body, pre-publication phase can be canceled without matching another
client's destination path. An interruption during copy admission waits for the short
control request to recover its transfer ID before issuing cancellation. Failed
downloads remove owned staging output and leave previous destinations untouched
until publication. Publication is allowed to finish once it starts; a directory
merge may already have changed some destination entries if publication itself
fails. Remote workers own upload/copy staging cleanup. SIGKILL cannot run cleanup.

### Recursive upload REST capability

`PUT /api/v1/agents/{agent}/archive/{absolute-path-without-leading-slash}` accepts
a streamed **plain tar** body, including chunked bodies without Content-Length.
GNU long-name/long-link and PAX extension members are limited to 64 KiB each,
matching the CLI extractor's long-name limit. Oversized metadata is rejected
from its header before its payload is buffered; ordinary file payloads remain
streamed without this size limit.
Members are relative to the resulting directory, with no extra source-root layer.
It accepts `?on_existing=error|override|merge` and defaults to `error`. Existing
raw PUT defaults remain compatible; the CLI always sends its selected policy.

The API waits for agent extraction and publication before returning
`ArchiveUploadResponse`: `{ "path": "/result", "bytes_written": 1234 }`.
Malformed/escaping/link/special members fail through the existing typed agent
error mapping. Disconnects, request-body errors, and explicit cancellation use
the existing upload cleanup lifecycle. Transfer progress and cancellation remain
available on independent requests while the archive body is streaming.

Raw and archive PUT requests optionally accept `X-Redoor-Upload-Request: <UUID>`.
`DELETE /api/v1/upload-requests/{UUID}` cancels that handler's active transfer and
returns `CancelUploadRequestResponse`:
`{ "request_token": "UUID", "transfer": { "transfer_id": 123, "status": "accepted" } }`.
The mapping lives through destination completion and is removed with the HTTP
handler; cancellation during destination setup returns `transfer: null` and
prevents later body forwarding. Absent/completed requests return 404, duplicate active tokens are rejected,
and existing clients that omit the header retain their existing behavior.

## Executing commands

```text
redoor remote exec [--cwd /absolute/path] [--env KEY=VALUE]...
                   [--timeout DURATION] [--json] <AGENT> -- <COMMAND> [ARGS...]
```

The `--` separator is required. Argument boundaries, empty arguments, spaces,
and shell metacharacters are preserved. There is no implicit shell, expansion,
pipeline, or redirection. Invoke a shell explicitly when needed:

```sh
redoor remote exec agent-a -- printf '%s' 'literal $HOME; *.txt'
redoor remote exec --env MODE=test --env TOKEN='a=b' agent-a -- printenv MODE TOKEN
redoor remote exec agent-a -- sh -lc 'df -h | sort -k 5'
```

`--cwd` selects an absolute remote working directory; otherwise the process
inherits the agent's working directory. Environment overrides inherit the
agent environment; repeated keys use the last value and `KEY=` sets an empty
value. `--timeout` accepts positive integer durations with `ms`, `s`, `m`, `h`,
or `d` units (maximum 365 days). It is enforced on the agent, including when
output is backpressured. Without it, execution has no deadline. Stdin is closed;
use the terminal UI for interactive input.

Output streams live to the corresponding local stdout and stderr, byte-for-byte.
CLI diagnostics go to stderr. The CLI waits for both output pipes and remote exit.
SIGINT/Ctrl-C and SIGTERM close the execution stream, causing the server to cancel
the process group, including descendants that remain in that group. A lost HTTP connection also cancels
execution; an agent disconnect drops its worker and kills its process group.

| Exit code | Meaning |
| --- | --- |
| Remote process exit code | Command completed, including nonzero command failures. |
| `128 + signal` | Remote process terminated by a signal. |
| `124` | Agent-side timeout. |
| `125` | Authentication, API, transport, local output, or remote spawn failure; no usable remote exit status. |
| `130` | Interruption or cancellation. |
| `2` | Invalid CLI syntax/options. |

Remote programs can themselves return reserved codes. `--json` distinguishes
those cases using typed terminal events. It emits **newline-delimited JSON**,
not a single buffered object. Output records use byte arrays to preserve binary
data and split UTF-8 sequences:

```json
{"type":"stdout","data":[104,105]}
{"type":"stderr","data":[101,114,114]}
{"type":"exit","code":7,"signal":null}
```

The final event is `exit`, `timed_out`, `canceled`, or `error` (with `message`).
Output chunks are bounded at 8 KiB before serialization; scripts should process
records incrementally. Errors loading a saved session also emit an `error` event.

### Execution REST capability

Authenticated `POST /api/v1/agents/{agent}/exec` accepts `ExecRequest`:

```json
{"argv":["printf","%s","literal value"],"cwd":null,"env":{},"timeout_ms":30000}
```

The response is `application/x-ndjson`, streaming `ExecEvent` records with the
same shape as CLI JSON. Invalid argv/cwd/environment/deadline inputs return 400;
missing agents return 404. `X-Redoor-Execution-Id` identifies the stream for
explicit cancellation through the existing `DELETE /api/v1/transfers/{id}`.
Dropping the response cancels automatically. Transport truncation without a
terminal event must be treated as an unknown exit status, never success. This
uses the existing transfer data lane, bounded routing queues, progress lifecycle,
and independent control channel, rather than PTY output or a shell command string.
