# Backpressure Review

Review target: `/Users/esamatti/code/redoor` at commit
`a07ce558f5d2c8730a0ac16d38a6b4e7d34201b9`.

## Scope And Method

This was a read-only static review of the Rust server and agent, the REST and
WebSocket protocol boundaries, transfer routing, raw file and tar pipelines,
Tokio and standard-library channels, terminal and log relays, and the browser
consumers that participate in streaming. No application code was changed and
no dynamic tests were run; this report is the only created file.

The review traced these paths end to end:

- HTTP upload body -> REST handler -> router -> server transfer WebSocket ->
  agent transfer reader -> raw/tar upload worker -> filesystem.
- Filesystem -> raw/tar download worker -> agent transfer WebSocket -> server
  transfer reader -> router -> HTTP body -> browser/client.
- Agent-to-agent copy through the shared transfer sockets and router.
- Control commands and responses over the independent control WebSocket.
- Cancellation and disconnect propagation in both transfer directions.
- Logger, UI-event, terminal, and log-viewer producer/consumer boundaries.
- Queue capacities, frame limits, spawned work, eager allocations, and
  multiplexing behavior under slow or disconnected peers.

Important protections already present include 64 KiB transfer payload limits
(`src/streaming.rs:6-10`), capacity-one transfer-socket outbound queues
(`src/transfer_protocol.rs:10-16`), capacity-one REST download channels
(`src/server/raw.rs:204-205`, `src/server/raw.rs:306-307`), bounded logger
broadcast history (`src/logging.rs:13-16`, `src/logging.rs:129`), and physically
separate control and payload WebSockets. The HTTP download, gzip, raw file I/O,
and most WebSocket sink paths otherwise preserve pull-based backpressure.

## Finding Summary

| Severity | Count | Confirmed bugs | Design risks |
| --- | ---: | ---: | ---: |
| Critical | 0 | 0 | 0 |
| High | 5 | 5 | 0 |
| Medium | 4 | 3 | 1 |
| Low | 2 | 0 | 2 |

## Findings

### High 1: A disconnected download is not canceled until another agent chunk arrives

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Direct-download startup now returns the allocated request ID. The HTTP body and the UI-used diff consumer retain a drop guard that reliably awaits router mailbox capacity before sending `CancelTransfer`; consuming a final or error frame disarms it. A router-backed body-lifetime regression test drops the body after one nonterminal frame and verifies cancellation reaches the agent without any subsequent chunk.

**References:**

- `src/server/raw.rs:204-224`
- `src/server/raw.rs:253-279`
- `src/server/raw.rs:382-459`
- `src/actors/router/transfers/download.rs:176-196`
- `src/actors/router/transfers/download.rs:203-253`
- `src/agent/raw/download.rs:115-183`

**Failure scenario and impact:** The HTTP response body owns only the receiving
half of the capacity-one chunk channel. If the client disconnects while the
agent is blocked reading a slow filesystem, FIFO, device, or network mount, the
body and receiver are dropped, but no cancellation is sent. The router notices
the lost consumer only when a later agent chunk makes `chunk_sender.send`
fail. If no later chunk arrives, the router's download entry, progress row,
agent worker, file descriptor, and request-related state can remain active
indefinitely. Even for regular files, cancellation is delayed until the next
chunk rather than tied to HTTP body lifetime.

**Why current behavior is insufficient:** Uploads have an explicit drop guard
(`src/server/raw/upload.rs:23-30`, `src/server/raw/upload.rs:246-258`), but
downloads rely on a future producer action to discover consumer cancellation.
Backpressure can stop that producer action, making the cancellation trigger
self-defeating. The stream-start reply also returns only `Result<(),
RouterError>`, so the REST body does not receive the request ID needed to cancel
its transfer directly.

**Minimal fix:** Return the allocated `RequestId` from
`ExecuteStreamCommandRest`, attach a download cancellation guard to the body
stream, and have its `Drop` enqueue a reliable `CancelTransfer`. Disarm the
guard only after the final or error frame is consumed. The cancellation enqueue
must use an awaited or reserved reliable path rather than best-effort
`try_send`.

### High 2: The control-socket output queue and timed-out command state are unbounded

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Each agent session now has a bounded ordinary control lane with fail-fast command admission and a separately bounded, writer-prioritized lane for transfer bootstrap, cancellation, and lifecycle errors. Saturated REST commands return an explicit service-unavailable result, and transfer/copy starts roll back instead of retaining work that was never queued. The router rejects already-closed command replies, prunes closed pending replies on every event, and requests a prompt prune after REST timeout. The agent also caps live non-upload command tasks per control generation while processing cancellation and socket lifecycle messages outside that limit. Regression tests cover queue saturation, priority cancellation admission, pending-reply pruning, and bounded agent task admission without sleeps.

**References:**

- `src/actors/session.rs:47-50`
- `src/actors/session.rs:281-330`
- `src/actors/router/agents.rs:40-57`
- `src/actors/router/agents.rs:558-578`
- `src/actors/router/state.rs:101-107`
- `src/actors/router/mod.rs:70-84`
- `src/actors/router/mod.rs:125-149`
- `src/agent/protocol.rs:263-327`

**Failure scenario and impact:** A slow or half-open agent can stop the control
WebSocket sink at `sender.send`, while every REST command continues to append a
serialized frame to `mpsc::unbounded_channel`. Each command also inserts a
pending reply into `pending_rest.by_request_id`. If the REST request times out,
`RouterHandle::request` drops only its oneshot receiver; it sends no
cancellation and does not remove router state. A command that never finishes,
or a sustained request rate above the socket/agent completion rate, therefore
causes unbounded frame and hash-map growth. Once commands reach the agent, every
non-upload command is independently spawned, so there is no execution
concurrency limit to absorb the backlog safely.

**Why current behavior is insufficient:** Separating control and payload sockets
correctly prevents file bytes from blocking commands, but making the control
lane unbounded replaces latency with unconstrained memory. REST timeouts limit
caller waiting time, not work or state lifetime. Ping/stale detection does not
bound growth while a socket remains writable slowly or continues receiving
frames.

**Minimal fix:** Use a bounded per-agent control queue and make router command
admission fail fast with an overload result when it is full; keep a separately
reserved slot/lane for cancellation and lifecycle messages. Add a
request-cancellation message or periodically remove pending entries whose
oneshot sender `is_closed()`. Bound concurrent agent command tasks with a
semaphore, while leaving transfer cancellation and socket lifecycle handling
outside that semaphore.

### High 3: The logger command queue can grow without bound behind slow output

**Classification:** Confirmed bug.

**References:**

- `src/logging.rs:48-67`
- `src/logging.rs:160-190`
- `src/logging.rs:193-209`
- `src/logging.rs:233-247`
- `src/logging.rs:261-266`

**Failure scenario and impact:** Every log producer allocates a formatted
`String` and sends it to an unbounded MPSC queue. A slow log filesystem, blocked
stdout, or burst generated by a failure loop lets producers outrun the single
logger task indefinitely. Memory then grows with all queued strings. Subscription
requests share this queue and can also wait behind an arbitrary backlog, delaying
log WebSocket setup.

**Why current behavior is insufficient:** The live broadcast to viewers is
correctly bounded, but that bound is downstream of the unbounded logger command
queue. The stated goal that logging never waits for I/O does not provide an
overload policy; it only moves backpressure into heap growth.

**Minimal fix:** Replace the command queue with a bounded MPSC queue. Use
`try_send` for ordinary log records with an atomic dropped-record counter, and
reserve capacity or use a small separate channel for subscription commands.
Emit one synthetic dropped-record notice when capacity recovers. Avoid blocking
stdout writes on a Tokio worker if stdout can be redirected to a slow pipe.

### High 4: Tar upload backpressure blocks a Tokio runtime worker and delays cancellation

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** The extractor bridge is now a bounded Tokio channel. The async upload worker awaits channel capacity while selecting against cancellation, and the blocking tar reader uses `blocking_recv`, so a slow extractor no longer occupies a Tokio worker. The payload is moved instead of cloned. The upload session also owns and joins the blocking extractor before every terminal temp-tree cleanup or successful placement. A current-thread Tokio regression test covers full-queue cancellation and join-before-removal ordering.

**References:**

- `src/agent/transfers/upload.rs:154-161`
- `src/agent/transfers/upload.rs:264-271`
- `src/agent/transfers/upload.rs:322-325`
- `src/agent/transfers/upload.rs:375-449`
- `src/agent/transfers/upload.rs:492-523`

**Failure scenario and impact:** The async `TarUploadWorker` calls the blocking
`std::sync::mpsc::SyncSender::send` directly. When extraction or destination
storage is slow and the eight-item sync queue fills, a Tokio worker thread is
blocked. That future cannot observe its cancellation watch channel until the
blocking send returns. Multiple concurrent tar uploads can block all runtime
worker threads, stalling control commands, keepalives, transfer cancellation,
and unrelated async I/O. `chunk.data.clone()` also keeps an unnecessary second
copy while sending.

**Why current behavior is insufficient:** A bounded queue limits bytes but does
not constitute cooperative async backpressure when its blocking API is invoked
on the runtime. `stop_unpacker` cannot interrupt a task currently blocked in
`send`, so the cancellation design is ineffective in the exact slow-consumer
condition it must handle.

**Minimal fix:** Use a Tokio bounded channel and bridge it to the blocking tar
reader with `blocking_recv` inside the existing `spawn_blocking` task. The async
worker should `select!` an awaited `sender.send(chunk.data)` against cancellation,
moving rather than cloning the payload. Dropping the sender then wakes the
blocking reader and makes cleanup prompt.

### Medium 1: One blocked stream head-of-line blocks every transfer on the same agent

**Classification:** Design risk with confirmed mechanism.

**References:**

- `src/transfer_protocol.rs:15-16`
- `src/server/agent_transfers.rs:127-160`
- `src/actors/router/transfers/download.rs:105-196`
- `src/actors/router/transfers/copy.rs:345-482`
- `src/agent/transfer.rs:166-191`
- `src/agent/protocol.rs:540-586`

**Failure scenario and impact:** All uploads, downloads, and remote copies for
an agent share one transfer WebSocket. The server reads one frame and waits for
its router acknowledgement before reading the next. If that frame belongs to a
download whose HTTP client is slow, no later frame for another download or copy
can be read. In the opposite direction, the agent reader awaits delivery to one
upload worker; a slow disk or tar extractor blocks all other server-to-agent
uploads. Control remains responsive because it uses another socket, but
unrelated transfers can stall indefinitely behind one slow stream.

**Why current behavior is insufficient:** Capacity-one queues provide a useful
global memory bound, but the protocol treats WebSocket frame order as if it were
fair per-request flow control. Once a frame for a blocked request is first in
the socket, neither endpoint can skip it, and no per-stream credit tells the
producer which request is currently writable.

**Minimal fix:** Add per-request flow-control credits and a fair outbound
scheduler that emits a stream's next frame only after downstream acceptance of
its previous frame. If protocol complexity is undesirable, use one dedicated
payload WebSocket per transfer; that is the smallest design that lets TCP
backpressure isolate independent requests.

### Medium 2: Transfer concurrency and completed progress history have no resource bounds

**Classification:** Confirmed resource-growth bug.

**References:**

- `src/agent/state.rs:99-150`
- `src/agent/state.rs:160-204`
- `src/agent/raw/upload.rs:391-429`
- `src/agent/transfers/upload.rs:492-523`
- `src/agent/transfers/download.rs:433-451`
- `src/actors/router/progress.rs:107-134`
- `src/actors/router/progress.rs:139-203`
- `src/actors/router/progress.rs:356-360`

**Failure scenario and impact:** There is no maximum active upload or download
count, although terminals and log streams explicitly cap active sessions. Each
upload can retain an eight-frame queue; a tar upload adds another eight-frame
queue and a blocking task; a tar download adds another queue, blocking task, and
optional metadata walk. Many concurrent authenticated requests therefore
multiply fixed per-transfer buffers and tasks without an aggregate cap. After
transfers finish, every progress entry remains in `progress.entries` forever,
and every progress GET clones and sorts the entire history. Long-lived servers
thus grow memory and response cost with total historical transfers even when no
work is active.

**Why current behavior is insufficient:** Per-queue bounds control one stream's
residency but do not bound the sum across streams. Permanent history turns a
temporary concurrency issue into guaranteed process-lifetime growth.

**Minimal fix:** Add per-agent and global transfer semaphores/admission limits,
returning `429` or `503` before creating router progress and agent worker state.
Retain all active rows but cap terminal rows by count and/or age, pruning on
completion/start and before list projection.

### Medium 3: Router mailbox saturation silently drops cancellation and completion events

**Classification:** Confirmed bug.

**References:**

- `src/actors/router/mod.rs:32-61`
- `src/actors/session.rs:188-215`
- `src/server/raw/upload.rs:246-258`
- `src/actors/router/transfers/upload.rs:186-205`
- `src/actors/router/transfers/download.rs:176-196`
- `src/actors/router/transfers/copy.rs:456-482`

**Failure scenario and impact:** `RouterHandle::send` is `try_send`; a full
1024-item mailbox is returned as an ordinary send error. Several correctness
events either ignore that error or cannot retry it: agent command responses and
progress updates, upload drop-guard cancellation, and the completion events
sent after background chunk forwarding. Under saturation, a canceled upload can
leave its agent worker and temp path active; a final command response can be
lost while its REST caller times out; and a transfer chunk can be acknowledged
to the socket without router progress, terminal cleanup, or downstream failure
state being committed.

**Why current behavior is insufficient:** The bounded mailbox is appropriate,
but applying a fire-and-forget overload policy to state-machine transitions
breaks the protocol. The background download/copy fallbacks release the socket
acknowledgement directly, which restores throughput while skipping the state
transition that makes that acknowledgement safe.

**Minimal fix:** Separate lossy/coalescible notifications from mandatory router
events. Send responses, cancellations, readiness, unregister, and transfer
completion through an awaited/reserved-capacity lane. Progress updates may use
`try_send` if they are explicitly coalesced to the latest value. Never complete
the upstream chunk acknowledgement until the mandatory finish event has been
accepted or the whole connection is being torn down.

### Medium 4: Directory tar generation eagerly retains directory entry lists

**Classification:** Confirmed bug relative to the constrained-memory streaming
requirement.

**References:**

- `src/agent/transfers/download.rs:82-129`
- `src/agent/transfers/download.rs:159-223`
- `src/agent/transfers/download.rs:433-451`

**Failure scenario and impact:** Both tar generation and its parallel size walk
collect every entry in a directory into a `Vec` solely to sort it. A directory
with millions of entries consumes memory proportional to its width before any
of those entries can be released. The recursive tar function also retains each
ancestor's sorted vector while descending, so a deep tree can retain multiple
large sibling lists at once. The byte contents stream correctly, but namespace
metadata does not.

**Why current behavior is insufficient:** Streaming file payloads does not meet
the repository's constrained-memory goal if traversal eagerly plans an
unbounded directory. The size walk duplicates this pressure concurrently with
tar generation for browser directory downloads.

**Minimal fix:** Iterate `read_dir` lazily without sorting. If deterministic
ordering is a hard requirement, implement a bounded external sort/spill strategy
or explicitly reject directories above a configured entry cap; do not retain
all `DirEntry` values in memory. Use an iterative traversal so ancestor state is
bounded by depth and open iterators rather than full sibling vectors.

### Low 1: UI refresh delivery uses an unbounded per-browser queue

**Classification:** Design risk.

**References:**

- `src/server/ws.rs:53-87`
- `src/server/ws.rs:99-116`
- `src/actors/router/state.rs:276-286`
- `src/actors/router/ui.rs:102-125`

**Failure scenario and impact:** A UI WebSocket whose sink remains blocked keeps
an unbounded receiver alive while router broadcasts append events. Transfer
events are throttled, but agent and route changes are not coalesced. A long-lived
slow browser can therefore accumulate small refresh events indefinitely.

**Why current behavior is insufficient:** These events mean “data changed,” not
“replay every transition,” so preserving an unbounded sequence has no semantic
benefit. Socket closure eventually cleans it up, but a slow open peer need not
close.

**Minimal fix:** Use a bounded capacity-one channel or `watch` state with a
domain bitset, coalescing duplicate invalidations while a send is pending. Close
the subscriber if it remains unwritable past a modest timeout.

### Low 2: Browser terminal input does not apply a `bufferedAmount` limit

**Classification:** Design risk.

**References:**

- `ui/src/terminal/session.ts:49-75`
- `ui/src/components/terminal-panel.tsx:529-552`
- `src/server/terminals.rs:269-334`

**Failure scenario and impact:** Once a terminal is ready, every keyboard/paste
chunk and resize is passed directly to `WebSocket.send`. The browser API has no
awaitable send and buffers internally. A large paste or automated input while
the network/agent is stalled can grow the browser's native WebSocket queue well
beyond the bounded Rust terminal queues. The server applies backpressure only
after those bytes have already been accepted into browser memory.

**Why current behavior is insufficient:** Checking only `readyState` detects a
closed socket, not a slow one. The server's one-megabyte frame limit also does
not limit the sum of many queued browser frames.

**Minimal fix:** Check `socket.bufferedAmount` before every send, define a small
high-water mark, and pause or reject further terminal input until a polling
low-water mark is reached. If the terminal input API cannot be paused safely,
close the session with an explicit overload message rather than permitting
unbounded browser buffering.

## Testing Recommendations

1. Add a download cancellation integration test whose agent-side source stops
   producing after the first frame. Abort the HTTP body and assert, without
   waiting for another data frame, that the agent logs cancellation, the worker
   disappears, and progress becomes terminal.
2. Add a router saturation test that fills all 1024 mailbox slots, then submits
   `CancelTransfer`, `RouteResponse`, `RouteTransferReady`, and each
   `FinishRouted*Chunk` event. Assert every mandatory transition is eventually
   committed and no upstream acknowledgement is released early.
3. Put a non-reading WebSocket peer behind the server control lane, issue more
   commands than its configured capacity, and assert bounded RSS plus explicit
   overload responses. Verify pending reply count returns to zero after caller
   timeouts.
4. Run the logger against a deliberately blocked file/stdout sink while
   producing a large burst. Assert queue memory is bounded, dropped records are
   counted, and a subscription command is not starved.
5. Add a tar upload test with an unpack consumer that never drains. Cancel it
   and assert the async runtime remains responsive, the blocking reader exits,
   and the temp directory is removed without waiting for queue capacity.
6. Start two same-agent downloads and two same-agent uploads. Stall one consumer
   in each direction and assert the other transfer either continues under the
   new fairness protocol or is explicitly documented/rejected rather than
   silently blocked.
7. Start transfers up to the new admission limit, verify the next request fails
   predictably, and measure aggregate queue memory. Complete thousands of small
   transfers and assert progress history remains at its configured cap while
   active rows are never evicted.
8. Create a very wide directory under a memory limit and stream it as tar. Track
   peak RSS and first-byte latency; assert memory stays near the fixed pipeline
   budget rather than growing with entry count.
9. In Playwright, throttle a terminal WebSocket, paste beyond the high-water
    mark, and assert `bufferedAmount` remains bounded and the UI reports the
    pause/closure. Add an analogous slow UI-refresh socket test for event
    coalescing.

The existing throttled upload/download tests are useful for normal slow links,
especially `tests/raw-upload-toxiproxy.test.ts:137-214` and
`tests/raw-download.test.ts:412-519`. The cancellation tests at
`tests/raw-upload.test.ts:245-352` and `tests/raw-download.test.ts:521-704`
exercise cancellation only while further chunks can expose a dropped consumer;
they do not cover a producer that has stopped producing or router-mailbox
saturation.

## Residual Risks

- This was static analysis. OS socket buffers, Hyper/Axum body polling,
  Tokio-Tungstenite automatic ping/pong behavior, reverse-proxy buffering, and
  browser-native WebSocket queues were not measured under load.
- The review did not profile allocator peaks from JSON/WebSocket serialization;
  actual amplification for large control responses may exceed the obvious
  simultaneous Rust values.
- SSH tunnel buffering and remote network filesystem behavior can lengthen the
  cancellation windows described above and should be included in load tests.
- No critical-severity issue was confirmed, but the combined effect of
  unbounded control/log queues and unlimited transfer/command concurrency can
  become process-wide memory exhaustion under sustained authenticated load.
