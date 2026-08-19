# Browser Error Propagation Review

## Scope and method

This review examined error handling and propagation from agent-side command and
stream workers, through the control and transfer WebSockets and router actor,
through REST status/body mapping, into `ui/src/api-client.ts`, TanStack Router
loaders, TanStack Query queries/mutations, and browser-visible feedback.

Representative paths traced end to end included:

- File listing and metadata: agent filesystem calls -> `CommandResult` -> control
  WebSocket -> router pending request -> REST -> browser route loader.
- Raw file and directory downloads: agent streaming worker -> transfer WebSocket
  -> router bounded channel -> Axum streaming body -> `fetch`, editor, image, and
  browser download surfaces.
- Raw uploads and directory imports: browser body -> REST -> router -> transfer
  WebSocket -> agent worker -> completion response -> upload queue UI.
- Copy/move progress: REST start -> router asynchronous transfer state -> UI event
  WebSocket -> TanStack Query invalidation/polling -> transfer feedback.
- Terminal and log sockets: browser setup -> router bootstrap -> agent dedicated
  WebSocket -> runtime lifecycle/error event -> browser state.
- Managed-agent lifecycle and generic command calls, especially timeout,
  disconnect, serialization, and HTTP status behavior.

The review was static and read-only with respect to application code. Existing
integration and Playwright tests were inspected for error-path coverage. No
fault-injection run was needed to establish the confirmed findings below; each
follows directly from reachable control flow. The only repository file created
by this review is this report.

Repository verification was also attempted with `mise exec -- pn test`. Rust
format/tests, project formatting, build, Rust build, and TypeScript checks passed;
the pipeline stopped at lint on the pre-existing unrelated
`typescript(no-floating-promises)` violation in
`tests/create-local-agent.test.ts:82`.

Severity means:

- **High:** can report corrupt/incomplete data as success, hang a request without
  a bound, or disclose a reusable credential.
- **Medium:** materially misclassifies or hides failures, leaves the UI
  indefinitely stale, or loses actionable failure context.
- **Low:** primarily weakens diagnostics or future protocol robustness.

## Findings

### High

#### H1. Directory tar construction failures are converted into successful completed downloads

**Classification:** Confirmed bug.

**References:** `src/agent/transfers/download.rs:437-451`,
`src/agent/transfers/download.rs:453-502`,
`src/actors/router/transfers/download.rs:274-295`,
`src/server/raw.rs:349-375`.

**Failure scenario and impact:** The blocking tar builder can fail after emitting
some bytes, for example when an entry disappears, permissions change, a file
cannot be opened, or an unsupported symlink/special entry is encountered. The
blocking task only logs the error at `src/agent/transfers/download.rs:443-449`.
Dropping `tar_sender` makes `tar_receiver.recv()` return `None`, which the async
worker treats as normal EOF. It then sends the last buffered bytes with the
default `is_last = true` at lines 496-502. The router marks the transfer
`completed`, and the REST edge finishes a `200 application/gzip` response. A
browser can therefore save an incomplete archive while both HTTP and transfer
history say it succeeded. The same source stream is reused for remote directory
copy, although destination extraction may catch some malformed archives.

**Why current behavior is insufficient:** Logging is not propagation. The tar
producer and transfer worker have no completion channel carrying the builder's
`Result`, so channel closure ambiguously means either successful completion or
producer failure. The final success marker is emitted without proving
`write_directory_tar` completed.

**Minimal fix:** Have the blocking task send its final `Result` through a
oneshot (or make the channel carry a terminal result). Emit the final normal
chunk only after `Ok(())`; on `Err`, emit a tar `StreamChunk` with
`is_error = true` and a safe message. Keep detailed filesystem context in agent
logs and send a bounded operator-facing message over the protocol.

#### H2. Agent/transfer disconnects can terminate an HTTP download as clean EOF

**Classification:** Confirmed bug.

**References:** `src/actors/router/cleanup.rs:70-101`,
`src/actors/router/cleanup.rs:187-204`, `src/server/raw.rs:421-459`,
`src/server/raw.rs:354-375`, `tests/raw-download.test.ts:353-409`.

**Failure scenario and impact:** On control or transfer-socket loss, router
cleanup removes the download entry. Dropping its `chunk_sender` closes the REST
receiver, but no error chunk is sent. Once the response has started,
`begin_download_body_stream` treats receiver closure as ordinary completion at
line 458. Fixed-length file downloads will often fail in `fetch` because fewer
bytes than `Content-Length` arrived, but they lose the disconnect reason.
Directory downloads have no `Content-Length`; the gzip encoder can finalize the
short input into a valid gzip member, so browser save-as can complete without an
HTTP error even though the tar payload is incomplete. Transfer history may
simultaneously say `errored`, creating contradictory browser-visible outcomes.

The existing disconnect test explicitly accepts any defined HTTP result and
checks only that progress eventually becomes terminal; it does not require the
body consumer to reject when progress is errored.

**Why current behavior is insufficient:** The REST stream cannot distinguish an
agent's successful final chunk from router-side sender disappearance. Correct
progress bookkeeping does not repair the already delivered HTTP semantics.

**Minimal fix:** Make router cleanup send a terminal error item to the REST body
before dropping the sender, or change the channel item to a typed
`Result<StreamChunk, DownloadStreamError>`. In the body stream, receiver closure
before an explicit `is_last` must yield an I/O error. Preserve a safe disconnect
category for the client and the detailed reason in transfer progress/logs.

#### H3. Streaming requests have unbounded waits after setup and can hang indefinitely

**Classification:** Confirmed bug.

**References:** `src/server/raw.rs:207-257`, `src/server/raw.rs:382-399`,
`src/server/raw/upload.rs:183-215`, `src/commands/metadata.rs:16-32`,
`src/agent/raw/download.rs:88-115`.

**Failure scenario and impact:** The 30-second router request in the download
handler only confirms that the command was queued. The handler then waits on
`response_receiver.recv().await` without a deadline. Likewise, upload finish
awaits `completion_receiver` without a deadline after disarming its cancellation
guard. A live but wedged agent worker therefore holds an HTTP request forever.

A concrete download case is a named pipe with a normal extension such as
`/tmp/input.txt`: metadata obtains MIME from the extension, reports neither
directory nor regular file, and the REST handler nevertheless selects the raw
file path. Agent `File::open` can block waiting for a FIFO peer, so no first chunk
ever arrives and the browser remains loading indefinitely. Similar indefinite
waits are possible when an upload worker or filesystem operation stalls while
the WebSockets remain connected.

**Why current behavior is insufficient:** WebSocket stale detection only covers
socket silence for supervised control sessions; it is not an operation deadline
and does not help a responsive connection with a stuck worker. The browser has
no `AbortSignal` on these calls by default and receives neither a status nor an
error body.

**Minimal fix:** Reject non-regular, non-directory metadata before starting raw
downloads. Add explicit first-byte/idle and completion deadlines around the
post-setup receives; on timeout, cancel the router transfer, mark progress
errored, and return `504` if headers are uncommitted or an I/O body error if they
are committed. Keep timeout values operation-specific so long healthy streams
are governed by idle activity rather than total duration.

#### H4. Malformed control frames are logged verbatim even though registration frames contain the agent token

**Classification:** Confirmed bug with a version-skew trigger; security impact
depends on who can read server logs.

**References:** `src/actors/session.rs:243-256`, `src/types.rs:205-224`,
`src/agent/actor.rs:424-447`, `ui/src/routes/logs.tsx:42-47`.

**Failure scenario and impact:** If `serde_json::from_str::<Message>` fails, the
server logs the complete raw text. `agent_register` includes the reusable shared
agent token. A malformed or protocol-incompatible registration, including an
older agent missing a newly required field, can therefore write the token into
the server log. The application exposes server logs to authenticated browser
users. Anyone who obtains the token can impersonate an agent and attempt agent
identity takeover; the token can also remain in persistent log files.

**Why current behavior is insufficient:** The agent correctly avoids logging its
registration JSON because it contains the token, but the receiving side does not
apply the same rule on deserialization failure. Malformed input is precisely the
case where typed redaction cannot be applied after parsing.

**Minimal fix:** Never log raw control-frame text. Log the deserialize error,
socket ID, frame length, and, at most, a safely extracted/redacted `type` value.
Close the socket with a protocol error after logging so the failure is explicit.
Add a regression test that sends malformed registration JSON containing a
sentinel token and asserts the token is absent from captured logs.

### Medium

#### M1. Directory listing silently returns partial success when entry iteration or metadata fails

**Classification:** Confirmed bug.

**References:** `src/commands/handler.rs:180-219`,
`src/agent/protocol.rs:227-244`, `src/server/agents/files.rs:63-101`,
`ui/src/routes/agents.$agentId.browser.$.tsx:80-112`.

**Failure scenario and impact:** `read_dir` startup errors are typed, but errors
from `next_entry()` are converted through `.await.ok().flatten()` and become
indistinguishable from EOF. Per-entry metadata and non-UTF-8 names are also
silently dropped. On an I/O error, permission change, mount failure, or racing
entry deletion, the agent returns `LsDirectory` containing only the entries
processed so far. REST returns `200`, the loader commits it, and the browser
shows an incomplete directory with no warning. Users can make destructive
decisions based on a listing that appears authoritative.

**Why current behavior is insufficient:** The only error-aware branch is the
initial `read_dir`; failures during traversal are swallowed rather than carried
by `CommandResult::Error` or represented as warnings.

**Minimal fix:** Explicitly match `next_entry().await` and return
`CommandResult::io_error` on iteration failure. Decide deliberately whether an
individual metadata/name failure should fail the listing or be represented in a
typed `warnings`/unreadable-entry field; do not silently omit it.

#### M2. Router timeouts and disconnects are collapsed to internal 500 errors, and timed-out requests retain correlation state

**Classification:** Confirmed bug.

**References:** `src/actors/router/mod.rs:64-93`,
`src/actors/router/agents.rs:558-584`, `src/actors/router/cleanup.rs:11-33`,
`src/server/responses.rs:22-30`, `src/server/agent_helpers.rs:21-54`,
`src/server/agents/files.rs:102-109`, `ui/src/components/route-error.tsx:23-46`.

**Failure scenario and impact:** A command that exceeds the router request
deadline returns `RouterCallError::TimedOut`, but handlers generally format its
`Debug` representation into a `500 ErrorResponse`. A command interrupted by an
agent disconnect is converted to `CommandErrorKind::Internal`, also yielding
500. The browser labels both as "Server error" instead of a timeout or temporary
agent outage. Retry guidance and status-based behavior cannot distinguish a bad
request, server failure, agent disconnect, or deadline.

When the HTTP-side oneshot times out, the corresponding sender remains in
`pending_rest.by_request_id`; it is removed only by a late response or agent
cleanup. A connected agent that never responds permits these abandoned entries
to accumulate.

**Why current behavior is insufficient:** The code has typed timeout and router
errors at the actor boundary but discards them in repetitive endpoint-specific
formatting. `CommandErrorKind` also has no unavailable/timeout category.

**Minimal fix:** Add a shared `RouterCallError -> Response` mapper: timeout to
`504`, stopped router to `503`, with stable safe messages. Represent in-flight
agent disconnect as unavailable (`503`) rather than internal (`500`). Include a
cancellation/removal message or request guard so a timed-out caller removes its
pending correlation entry and, where applicable, sends command cancellation.

#### M3. `NotADirectory` is mapped to 404, causing the browser to offer creation at an impossible path

**Classification:** Confirmed bug.

**References:** `src/commands.rs:483-496`, `src/server/responses.rs:22-30`,
`ui/src/components/browser/utils.tsx:20-31`,
`ui/src/routes/agents.$agentId.browser.$.tsx:113-129`,
`ui/src/routes/agents.$agentId.browser.$.tsx:195-220`.

**Failure scenario and impact:** If a path traverses through a regular file,
Rust classifies the filesystem error as `NotADirectory`. REST maps that kind to
404. The browser converts every 404 to `{ type: "missing" }` and renders the
file/directory creation form. The user is told the target does not exist and is
offered operations that cannot succeed because an ancestor is not a directory.

**Why current behavior is insufficient:** A stable error kind is available at
the agent boundary but is lost in the HTTP status. The browser's in-page 404
special case then actively misrepresents it.

**Minimal fix:** Map `NotADirectory` to `400` (or `409`) and retain a machine
error code in `ErrorResponse`. Have the browser map that code to the existing
"Not a directory" unavailable state rather than inferring semantics from status
or message text.

#### M4. UI event-socket and background refresh failures leave stale data visible without warning

**Classification:** Confirmed bug.

**References:** `ui/src/refresh-listener.ts:53-90`,
`ui/src/refresh-listener.ts:93-136`, `ui/src/queries.ts:48-63`,
`ui/src/routes/__root.tsx:251-263`, `ui/src/routes/transfers.index.tsx:13-35`.

**Failure scenario and impact:** A UI WebSocket error is handled only by closing
and retrying every second. There is no visible disconnected/stale state and no
polling fallback. Route invalidation errors are explicitly swallowed. Transfer
and server-info queries use infinite stale time, and the transfer components
read `data` without checking query error/fetch status. During a proxy outage,
authentication problem, malformed event, or failed background refetch, old
agent state, directory contents, and active transfer progress can remain on
screen indefinitely as if current.

**Why current behavior is insufficient:** Reconnection is useful but does not
communicate freshness. Swallowing `router.invalidate()` rejection prevents the
global route error UI from helping, and no successful reconnect forces a full
resynchronization unless a later event happens to arrive.

**Minimal fix:** Track event-stream connectivity and last successful refresh in
shared UI state; show a non-modal stale/reconnecting banner. On WebSocket open,
invalidate agent, route, and transfer data once. While disconnected, use a
bounded polling fallback. Surface background invalidation/query errors while
retaining stale data, rather than swallowing them.

#### M5. Empty-directory upload failures are swallowed, and completed upload errors disappear from the queue surface

**Classification:** Confirmed bug.

**References:** `ui/src/upload-queue.ts:165-217`,
`ui/src/upload-queue.ts:264-323`,
`ui/src/components/browser/upload-queue.tsx:5-19`,
`ui/src/routes/__root.tsx:447-490`.

**Failure scenario and impact:** Directory preparation calls
`mutateAsync`, catches every rejection as `undefined`, and marks the directory
done. For an empty directory with no child file upload to reuse the rejected
promise, permission, disconnect, and path-conflict failures are never attached
to any visible item. File upload failures are recorded on queue items, but the
destination queue renders only `status === "waiting"`; errored `done` rows
vanish. The bottom drawer also shows only active transfers. A user can therefore
finish a directory import missing empty directories, or miss failed files,
without immediate feedback.

**Why current behavior is insufficient:** Errors are stored or discarded in the
scheduler but are not modeled in the directory state and are filtered out by
the only queue UI. Transfer history is not an adequate replacement for batch
completion feedback, especially for directory-only operations.

**Minimal fix:** Add `error: string | null` to directory queue entries, retain
failed file/directory rows in the upload queue, and show a batch summary Toast
when all work settles. Only mark a directory successful on fulfillment; preserve
the current behavior of propagating a shared parent-creation rejection to child
files.

#### M6. Terminal runtime failures are log-only and become a generic browser disconnect

**Classification:** Confirmed bug.

**References:** `src/agent/terminal.rs:174-245`,
`src/agent/terminal.rs:301-313`, `src/agent/protocol.rs:426-447`,
`src/server/terminals.rs:255-266`,
`ui/src/components/terminal-panel.tsx:544-605`,
`ui/src/components/terminal-panel.tsx:922-928`.

**Failure scenario and impact:** After `Ready`, PTY read/write, resize, task
panic, and dedicated WebSocket writer failures become an `Err` from
`connect_and_run`. The control actor logs that error and sends only
`TerminalFinished`; the dedicated socket closes. The server relay has no typed
runtime-error path, and the browser displays only "Terminal connection closed."
The user cannot distinguish shell exit, agent disconnect, invalid protocol, or
PTY failure, even though the agent had specific context.

**Why current behavior is insufficient:** Typed `TerminalServerMessage::Error`
exists but is used only for setup failure. Runtime errors are reduced to logs at
the layer best able to classify them.

**Minimal fix:** Before teardown, best-effort send a safe
`TerminalServerMessage::Error` for non-cancellation runtime failures, with a
small category such as PTY I/O, protocol, or transport. Continue logging the full
error chain on the agent. Preserve `Exit` for normal process termination and use
generic close only when no final event can be delivered.

#### M7. Malformed transfer protocol frames trigger silent teardown or are swallowed instead of failing the active operation

**Classification:** Confirmed protocol-handling defect; exploitation requires a
buggy, version-skewed, or compromised peer.

**References:** `src/streaming.rs:131-170`,
`src/server/agent_transfers.rs:127-175`,
`src/agent/protocol.rs:540-586`.

**Failure scenario and impact:** The server closes the transfer reader on a
frame parse error without recording the parse reason or sending a typed protocol
failure. In the opposite direction, the agent logs a malformed upload chunk and
returns without removing/failing the associated upload worker. The server-side
upload can then wait forever for completion. In addition, flag bytes are parsed
as `bytes[n] == 1`; values other than 0 or 1 are silently treated as false. An
invalid error flag can therefore be interpreted as ordinary data, while an
invalid final flag can prevent completion.

**Why current behavior is insufficient:** Protocol corruption/version skew is
converted into generic disconnect behavior, and one direction does not even
tear down the affected transfer. The wire format has no typed protocol-error
event and does not strictly validate all header fields.

**Minimal fix:** Reject non-0/1 flag bytes in `StreamChunk::from_bytes`. On any
parse failure, close/recycle the entire transfer connection so router cleanup
fails all affected operations with a stable protocol-error category. If the
header is sufficiently parseable to trust the request ID, send a request-scoped
error; otherwise never leave an upload worker waiting.

### Low

#### L1. The public error model mixes safe user messages with internal diagnostics and the UI expands raw bodies/stacks by default

**Classification:** Design risk; several concrete internal strings are already
returned, but no unauthenticated disclosure was found.

**References:** `src/commands.rs:842-846`,
`src/server/agent_helpers.rs:41-54`, `src/server/files.rs:62-68`,
`src/server/agent_configuration.rs:560-563`,
`ui/src/api-client.ts:145-165`, `ui/src/api-client.ts:185-223`,
`ui/src/components/route-error.tsx:119-134`,
`ui/src/components/route-error.tsx:201-249`.

**Failure scenario and impact:** `ErrorResponse` has only one string field, so
endpoint code uses the same channel for actionable filesystem errors and
`Debug`-formatted actor/runtime errors. `ApiError` retains the full raw response
body, and `RouteError` opens technical details by default and displays the body,
JavaScript stack, and component stack. Authenticated users can see internal
actor error names, filesystem/config paths, proxy-generated HTML, and build/source
details. More importantly, code cannot reliably choose a safe display message
separately from a diagnostic log message.

**Why current behavior is insufficient:** Authentication reduces exposure but
does not establish that every UI user should receive process internals or proxy
content. Message-string parsing also prevents stable remediation and telemetry.

**Minimal fix:** Evolve the generated error response to include a stable `code`,
safe `message`, and optional opaque `request_id`; log internal causes server-side
under that ID. Do not return `Debug` actor errors. Keep technical details closed
by default in production and do not render arbitrary non-JSON proxy bodies as
trusted diagnostics beyond a generic, escaped summary.

#### L2. Successful REST responses are not runtime-validated, so serialization drift loses endpoint/status context

**Classification:** Design risk.

**References:** `ui/src/api-client.ts:735-743`,
`ui/src/api-client.ts:581-605`, `ui/src/queries.ts:40-63`,
`ui/src/routes/__root.tsx:91-113`.

**Failure scenario and impact:** Generated TypeScript types are compile-time
only. `apiRequest<T>` directly returns `response.json()` without validating the
shape or wrapping JSON parse errors. Several methods do the same independently.
An empty/truncated 2xx body, incompatible server version, or proxy that returns
HTML with status 200 becomes a generic `SyntaxError`, or worse, malformed JSON
objects enter caches and fail later during rendering. The user loses the
endpoint, HTTP status, and response-body context that `ApiError` preserves for
non-2xx responses.

**Why current behavior is insufficient:** The client validates only
`ErrorResponse`, even though successful payloads drive loaders and long-lived
TanStack caches. Protocol serialization failures therefore look like unrelated
UI exceptions.

**Minimal fix:** At minimum, wrap success JSON parsing in an `ApiError`-like
`ResponseDecodeError` containing endpoint and status. Add Zod validation at the
highest-risk shared boundaries (agent list, server info, transfer progress, and
filesystem listing), or generate runtime schemas alongside TypeScript bindings.

## Testing recommendations

1. Add an integration test with a directory containing an unsupported symlink or
   an entry made unreadable during tar production. Require the HTTP body to fail,
   transfer progress to be `errored`, and no completed archive to be reported.
2. Add file and directory download disconnect tests that consume the entire body.
   If progress is errored before an explicit final chunk, require body rejection;
   do not accept merely "not hung." For chunked gzip downloads, assert extraction
   cannot appear as a successful complete archive.
3. Add a FIFO/special-file raw-download test with a bounded client deadline.
   Require an immediate typed 400 instead of a pending stream. Add first-byte and
   upload-completion timeout tests using a deliberately nonresponding test agent.
4. Send malformed registration JSON containing a sentinel token and assert that
   neither captured server output nor the server-log WebSocket contains it.
5. Inject `read_dir` iteration and entry-metadata failures through a testable
   filesystem abstraction or a deterministic mount fixture. Assert the endpoint
   never returns an unexplained partial 200 listing.
6. Cover status mapping explicitly: router timeout -> 504, router stopped/agent
   disconnect -> 503, unknown agent -> 404, permission -> 403, not-a-directory ->
   400/409. Assert the browser renders the corresponding state rather than
   matching message substrings.
7. Unit-test pending request cancellation: after an HTTP/router deadline,
   `pending_rest.by_request_id` must no longer retain the sender and a late agent
   response must be harmless.
8. Add Playwright coverage that cuts the UI event WebSocket and fails refresh
   requests. Assert a stale/reconnecting indicator appears, old data is labeled
   stale, reconnect performs a full refresh, and background errors do not erase
   usable cached data.
9. Add upload-queue Playwright coverage for a denied empty-directory creation and
   one failed file in a batch. Require persistent per-item error feedback and a
   batch summary until the user dismisses or retries it.
10. Add terminal tests that inject PTY read/write and malformed-control failures
    after `Ready`; assert a typed safe terminal error reaches the tab while full
    details remain only in agent logs.
11. Fuzz `StreamChunk::from_bytes`, including every non-boolean flag value,
    truncated headers, invalid payload kinds, and extreme indexes. Assert parse
    failure tears down and errors all affected operations rather than hanging.
12. Add API-client tests for empty, invalid JSON, wrong-shaped JSON, and 200 HTML
    responses. Verify decode failures retain endpoint/status context but do not
    expose an unbounded raw body.

## Residual risks

- This was a static review. Timing-dependent races under real proxy buffering,
  TCP half-open behavior, filesystem mounts, and browser download managers may
  produce additional variants of the streaming findings.
- Agent and server versions appear to share one protocol crate, but there is no
  explicit negotiated protocol version. Rolling upgrades can therefore expose
  untested deserialization and shape-skew paths.
- Error strings can contain agent-controlled filesystem paths, hostnames, SSH
  diagnostics, and process output. SSH password redaction is present, but a full
  taint audit of every diagnostic source and every persistent log sink was beyond
  this propagation-focused review.
- Browser-native `<a download>` flows cannot provide the same post-header error
  UI as `fetch`; correctness therefore depends especially strongly on explicit
  stream completion and transfer-history consistency.
- No critical-severity finding was identified. Counts are: 4 high, 7 medium, and
  2 low.
