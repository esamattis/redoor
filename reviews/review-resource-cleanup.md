# Resource Cleanup Code Review

## Executive summary

This review found **17 cleanup issues**: **6 high severity**, **8 medium severity**, and **3 low severity**. Fourteen are confirmed bugs whose failure paths are directly represented in the current code; three are design risks that need shutdown/load testing to determine their production frequency.

The most important themes are:

- Cleanup messages can be dropped exactly when the router is overloaded.
- Unmanaged control sockets are exempt from stale-connection teardown.
- Tar upload cancellation races a still-running blocking extractor and can block Tokio worker threads.
- Detached agent and provisioning tasks are not consistently owned, canceled, or joined.
- HTTP and process shutdown paths have no end-to-end deadline or ownership-driven cleanup.

## Scope and method

The review was read-only except for this report. It covered:

- Server and agent control and transfer WebSocket setup, replacement, stale detection, and teardown.
- REST request timeout and cancellation behavior, including router request/reply state.
- Raw file and tar upload/download streaming, local and remote copy/move, progress tracking, and temporary paths.
- Spawned Tokio and blocking tasks, channels, timers, locks, permits, files, and child processes.
- Server restart/shutdown and managed-agent watchdog shutdown.
- Dedicated terminal and log sockets and PTY child cleanup.
- Browser WebSockets, terminal resources, polling, mutations, and upload scheduling.
- Rust unit-test and TypeScript integration-test cleanup infrastructure.

The method was to inventory task/process/channel/temp-resource creation, then trace every normal, error, timeout, disconnect, cancellation, replacement, and shutdown exit. Existing tests were inspected for coverage of those paths. No application code or tests were changed, and tests were not run because this was a read-only review.

## Findings

### High severity

#### H1. Router cleanup messages are lossy under mailbox pressure

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Agent unregister and UI subscriber lifecycle messages now await bounded mailbox capacity, and failures caused by router shutdown are logged with lifecycle identifiers. Agent session shutdown is asynchronous so disconnect cleanup cannot be discarded. The synchronous HTTP upload drop guard now spawns an independent task that awaits mailbox capacity, allowing cancellation to survive handler-future cancellation without adding a second router lane that could reorder cleanup ahead of transfer setup. A regression test fills the mailbox and verifies session shutdown remains pending until its unregister message can be delivered.

**References:**

- `src/actors/router/mod.rs:47-53` implements `RouterHandle::send` with `try_send` and converts both `Full` and `Closed` to an error.
- `src/actors/session.rs:220-230` ignores failure while enqueueing `UnregisterAgent` during control-socket teardown.
- `src/server/raw/upload.rs:246-258` ignores failure while a drop guard enqueues `CancelTransfer`.
- `src/server/ws.rs:111-116` ignores failure while enqueueing `UnregisterUiSubscriber`.
- `src/actors/session.rs:155-163` also uses the lossy path for an explicit agent unregister.

**Failure scenario and impact:** When the bounded 1,024-message router mailbox is full, a control WebSocket can disconnect, an HTTP upload can be canceled, or a UI WebSocket can close while its cleanup message is rejected. A lost agent unregister leaves the old agent and transfer connection authoritative in the router, retains pending REST replies and stream/copy state, and prevents the normal terminal/log cleanup. A lost upload cancellation leaves an agent worker and its temporary output alive. A lost UI unregister retains a dead sender until a future broadcast happens to prune it. The failure is most likely during heavy transfer activity, which is also when cleanup needs to be reliable.

**Why current behavior is insufficient:** These call sites discard the error and have no ownership fallback. Comments around transfer readiness already recognize that dropping a one-shot lifecycle message on a full mailbox can leave work stuck (`src/actors/session.rs:168-170`), but teardown uses the same lossy mechanism.

**Minimal fix:** Use `send_async` in async teardown paths (`SessionRuntime::shutdown` can become async, and `handle_ui_socket` is already async). For drop-based HTTP guards, use a dedicated unbounded cleanup lane or spawn a small task that awaits `send_async`; do not rely on `try_send`. If the router is closed, perform any locally-owned cleanup immediately. Add structured logging for cleanup delivery failure.

#### H2. Stale unmanaged agent sockets are never torn down

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Stale detection now closes every silent agent session and unregisters it from the router, while watchdog signaling remains conditional on the session having a managed supervisor. Every outbound control WebSocket write is also bounded by the configured stale timeout so a blackholed peer cannot pin the writer task. An integration test registers an unmanaged protocol fixture that does not answer pings and verifies its inventory entry becomes disconnected.

**References:**

- `src/actors/session.rs:51-55` documents that unmanaged agents have no watchdog.
- `src/actors/session.rs:337-370` breaks a stale session only inside `if ... && let Some(watchdog)`, so a stale unmanaged socket does nothing.
- `src/actors/session.rs:302-330` relies on a WebSocket write failing; a blackholed TCP connection can leave that send pending rather than failing promptly.
- `src/actors/router/mod.rs:220-240` performs the cleanup that the stale unmanaged session never reaches.

**Failure scenario and impact:** A manually started/external agent loses its network path without a TCP close. No inbound frames arrive, but because it has no watchdog the stale timer never breaks the session. The router continues reporting the agent as connected, retains the transfer socket and all pending requests, and may route new work into a dead unbounded control lane. Pending HTTP operations and temporary transfer workers can remain indefinitely.

**Why current behavior is insufficient:** Restarting a managed subprocess and declaring a socket stale are separate concerns. The implementation couples both actions to watchdog presence, making stale detection a no-op for a supported class of agents.

**Minimal fix:** Always break and unregister the session after `stale_timeout`. If a watchdog exists, signal it before breaking; otherwise only close the socket and clean router state. Apply an explicit timeout around outbound sends as an additional bound for blackholed peers.

#### H3. Tar upload cancellation can block Tokio and races the blocking extractor

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Tar uploads now use a bounded Tokio channel whose async send is selected against cancellation, while the blocking tar reader consumes it with `blocking_recv`. The upload session owns the extractor `JoinHandle`; success, cancellation, shutdown, and failure all close the input and join the extractor before publishing or removing its temp tree. Chunk payload ownership moves into the queue without cloning. A current-thread Tokio regression test fills the extractor queue, verifies cancellation remains runnable, and verifies extraction has stopped before temp cleanup.

**References:**

- `src/agent/transfers/upload.rs:154-161` starts an untracked `spawn_blocking` tar extractor and retains only a one-shot completion receiver.
- `src/agent/transfers/upload.rs:206-215` lets the blocking reader wait on a synchronous channel.
- `src/agent/transfers/upload.rs:321-350` closes the producer and immediately removes the temp directory on cancel/shutdown without waiting for extraction to stop.
- `src/agent/transfers/upload.rs:435-441` calls blocking `SyncSender::send` directly inside an async worker.
- `src/agent/transfers/upload.rs:538-599` waits for extraction only on happy-path finalization.

**Failure scenario and impact:** If extraction is slower than ingress, `SyncSender::send` can block a Tokio worker thread. Enough concurrent tar uploads can starve control messages, including their own cancellation. On cancellation or transfer disconnect, dropping the sender wakes the blocking extractor eventually, but cleanup immediately runs `remove_dir_all` while the extractor may still be creating or writing entries. The extractor can race removal, recreate descendants, fail unpredictably, or leave a partial hidden tree. Its completion is then sent to a dropped receiver and never observed.

**Why current behavior is insufficient:** Closing an input channel is not equivalent to the blocking consumer having stopped. The temp directory has two concurrent owners, and there is no join before deletion. The synchronous send also violates the repository's requirement to keep control commands responsive during long streams.

**Minimal fix:** Store the `spawn_blocking` `JoinHandle` in `TarUploadSession`. Feed it through a Tokio bounded channel or move each blocking send into the blocking side so no runtime worker blocks. On cancel/failure/shutdown, close the input, await the extractor handle, then remove the temp directory. On normal completion, use the same single cleanup/finalization path.

#### H4. Detached agent command tasks survive disconnect and are aborted without cleanup on graceful agent exit

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Each control generation now owns its non-upload command workers in an `AgentRuntime` `JoinSet` and has a shared cancellation signal. Control loss and graceful shutdown publish cancellation, await every worker, and replace the signal only for the next connection generation, so old command tasks and control-writer clones cannot survive reconnect. Local copy and move operations observe cancellation only at filesystem-safe boundaries, select cancellation while blocked on progress delivery, await hidden temp-file or temp-tree removal before returning, and are then joined by the runtime. Upload workers remain on their existing transfer registry path, preserving tar upload's extractor join-before-delete ownership. Deterministic unit tests verify generation cancellation is joined and a backpressured local copy removes its hidden temp file before completion.

**References:**

- `src/agent/mod.rs:106-113` stores command task and cancellation ownership in `AgentRuntime`.
- `src/agent/protocol.rs:280-403` registers non-upload commands in the runtime-owned `JoinSet` and gives temp-owning local operations cooperative cancellation.
- `src/agent/actor.rs:75-94`, `src/agent/actor.rs:203-244`, and `src/agent/actor.rs:269-287` cancel and join command workers on graceful shutdown and control loss.
- `src/agent/transfers/copy.rs:235-344`, `src/agent/transfers/copy.rs:359-468`, and `src/agent/transfers/copy.rs:528-686` keep cancellation responsive without dropping in-flight filesystem futures and await temp cleanup before returning.
- `src/agent/transfers/move.rs:81-169` checks cancellation before mutation and delegates cross-filesystem fallback to the cancellation-safe copy paths.

**Failure scenario and impact:** During a long local copy, metadata operation on a slow filesystem, or other command, the control socket disconnects. The command continues against the filesystem and retains the old control sender/writer until it next reports progress or completes. If the agent then exits gracefully via stdin EOF, the Tokio runtime drops these detached tasks without executing async cleanup, leaving hidden `.redoor-local-copy-*` or `.redoor-local-copy-dir-*` output. Similar detached operations can continue consuming file descriptors and I/O after their peer is gone.

**Why current behavior is insufficient:** Clearing the known transfer registries does not cover the generic task spawned at the protocol boundary. Tokio `JoinHandle` drop detaches rather than cancels; runtime teardown then aborts tasks at arbitrary await points. Async cleanup after an await is not cancellation-safe.

**Minimal fix:** Track command tasks in a `JoinSet` or request-id registry owned by `AgentRuntime`, with a per-control-generation cancellation token. Cancel appropriate tasks on control loss and all tasks on shutdown, then join them before returning. Put temp-path ownership in a guard whose drop schedules/executes cleanup, or make command cancellation explicitly await cleanup before task termination.

#### H5. Canceled provisioning can orphan child processes and temporary artifacts

**Status:** Fixed.

**Classification:** Confirmed bug (fixed).

**Resolution:** Provisioning SSH commands and local tar extraction now set `kill_on_drop(true)`, so cancellation cannot detach their local child processes. Unique local provisioning directories are owned by a guard that retries asynchronous removal from `Drop`, including cancellation during ordinary cleanup. Remote sibling uploads are likewise guard-owned: normal failures await cleanup, successful rename disarms ownership, and cancellation schedules a bounded best-effort SSH `rm -f` whose own child is kill-on-drop. A deterministic streaming-server regression test cancels local release provisioning after the request starts and verifies its work directory is removed without sleeps.

**References:**

- `src/watchdog.rs:403-422` drops an in-progress spawn/preparation future when a shutdown/remove command wins `select!`.
- `src/ssh/transport.rs:249-264` awaits `ssh.status()` without `kill_on_drop(true)`.
- `src/ssh/provision.rs:426-506` creates a remote sibling temp binary and removes it only on ordinary returned errors.
- `src/binaries.rs:148-153` creates a local provisioning work directory.
- `src/binaries.rs:159-224` runs the whole download/extract operation before cleanup is reached.
- `src/binaries.rs:190-197` awaits a `tar` child without `kill_on_drop(true)`.
- `src/binaries.rs:224-239` removes the work directory only after the inner future completes.
- `src/server/agents/upgrade.rs:250-267` invokes local binary provisioning directly in a cancellable REST handler.

**Failure scenario and impact:** Stopping or deleting a managed SSH agent while it is preparing drops the preparation future. If it is in `SshHost::run`, the Tokio child is dropped without kill-on-drop and the local `ssh` process can continue. Cancellation after creating the remote upload temp path skips the later `rm -f`, leaving remote artifacts. Similarly, a browser disconnect or server task abort during release provisioning skips local work-directory cleanup; if cancellation occurs while `tar` runs, that child can continue too.

**Why current behavior is insufficient:** Cleanup is expressed as code after `.await`, so cancellation bypasses it. Some SSH paths correctly set `kill_on_drop(true)`, which makes the unprotected `run` and local `tar` paths inconsistent.

**Minimal fix:** Set `kill_on_drop(true)` on every provisioning child and use owned cleanup guards for local and remote temp paths. For remote cleanup, either make preparation a supervisor-owned task that is canceled and joined before acknowledging shutdown, or run a bounded best-effort remote cleanup after cancellation. Refactor local provisioning so work-directory cleanup is guard-owned and survives early returns and future cancellation.

#### H6. Server restart has no bound for active requests or supervisor shutdown

**Classification:** Design risk.

**References:**

- `src/main.rs:665-673` awaits Axum graceful shutdown without a drain deadline.
- `src/main.rs:675-682` does not stop watchdog children or re-exec until that unbounded wait completes.
- `src/server/raw.rs:388-459` allows a download body to wait indefinitely for the next agent chunk.
- `src/server/raw/upload.rs:197-215` can wait indefinitely for upload completion after the body is sent.
- `src/watchdog.rs:225-243` shuts supervisors down serially without a per-handle or overall deadline.

**Failure scenario and impact:** Restart is requested while a client holds a slow/hung streaming HTTP request or an agent never sends the next/completion frame. Graceful shutdown waits for active HTTP work, so execution never reaches `shutdown_all` or `reexec_current_process`. Even after HTTP drains, one supervisor whose shutdown acknowledgement never arrives blocks all later supervisors and restart. The server can remain indefinitely in a partially shutting-down state with the listener closed but children and resources still active.

**Why current behavior is insufficient:** Graceful drain has no cancellation token propagated into handlers and no maximum duration. Process replacement requires a deterministic upper bound, not solely cooperative completion by remote peers.

**Minimal fix:** Add a server shutdown cancellation token to state and select it in all long-lived streams/setup waits. Drain for a bounded interval, then force-cancel remaining tasks. Shut watchdogs down concurrently with individual and aggregate timeouts, logging any forced termination before re-exec.

### Medium severity

#### M1. Timed-out or canceled REST command replies remain in router state

**Classification:** Confirmed bug.

**References:**

- `src/actors/router/mod.rs:70-84` drops the reply receiver when a router request times out.
- `src/actors/router/agents.rs:558-578` inserts the reply sender into `pending_rest` and does not react if the receiver later closes; it also ignores a failed agent send.
- `src/actors/router/mod.rs:124-149` removes the entry only when an agent response arrives.
- `src/actors/router/cleanup.rs:13-34` otherwise removes it only when the agent disconnects.

**Failure scenario and impact:** An HTTP client disconnects, the 30-second server timeout expires, or routing to the agent's control lane fails. The one-shot receiver is gone but `pending_rest` retains its sender and agent ID until a response or disconnect. A connected but hung agent can therefore cause one retained map entry per request indefinitely, while the corresponding agent command also continues with no generic cancellation protocol.

**Why current behavior is insufficient:** A one-shot sender does expose receiver closure, but the router never checks it after insertion. Timeouts limit HTTP waiting, not the underlying resource lifetime.

**Minimal fix:** Introduce a request-id cancellation message/guard from the HTTP side and remove the entry when its receiver closes or deadline expires. At minimum, prune `Sender::is_closed()` entries on a periodic router tick and immediately remove entries when `send_message` returns false. Add a protocol cancel for commands that can be long-running.

#### M2. Direct streams rely on peer acknowledgement for final cleanup and have no idle/completion deadline

**Classification:** Confirmed bug.

**References:**

- `src/actors/router/transfers/download.rs:52-92` starts the agent command and records stream state even if the start reply receiver has already closed.
- `src/server/raw.rs:382-459` has no timeout or drop guard while waiting for the first or later download chunks.
- `src/actors/router/cleanup.rs:251-318` marks a canceled transfer but keeps it in the registry.
- `src/actors/router/transfers/download.rs:128-138` removes a canceled download only when a final/error frame later arrives.
- `src/server/raw/upload.rs:197-205` disarms cancellation before waiting without a timeout for agent completion.
- `src/actors/router/transfers/upload.rs:359-379` removes canceled upload state only when the agent acknowledges it.

**Failure scenario and impact:** A router start RPC times out before its delayed message is handled, an HTTP download disconnects before the first agent frame, or an upload client disappears while the server is waiting for finalization. If the agent remains nominally connected but never sends another frame/response, router stream state, progress state, agent workers, open files, and upload temp output remain indefinitely.

**Why current behavior is insufficient:** Channel closure is detected only when the next chunk is routed. Cancellation is a state flag rather than a bounded terminal transition. Upload cancellation protection ends before the final response actually arrives.

**Minimal fix:** Check `request.reply.is_closed()` before starting downloads, as upload startup already does. Give every stream a last-activity/deadline tracked by the router; on expiry, remove router state and send best-effort cancel. Keep the upload cancel guard armed while awaiting completion, and bound that wait. Add a download body drop guard so cancellation is sent even when no further chunk arrives.

#### M3. Agent control and transfer connection establishment is not timeout- or cancellation-aware

**Classification:** Confirmed bug.

**References:**

- `src/agent/connection.rs:59-73` performs TCP/TLS/WebSocket establishment with no timeout or cancellation input.
- `src/agent/actor.rs:337-351` awaits control connection establishment inside the single agent actor, preventing it from processing queued shutdown messages meanwhile.
- `src/agent/transfer.rs:83-108` detaches transfer connection establishment with no cancel handle.
- `src/agent/state.rs:412-420` can signal only an already-installed transfer connection; it cannot stop a setup task that has not reached installation.

**Failure scenario and impact:** TCP connects to a blackholed address, or TLS/WebSocket negotiation stalls. The control actor cannot process `Shutdown` until the connect future returns. A transfer setup spawned for an old control generation continues to own a socket/task after control loss and only discovers staleness if setup eventually completes. Reconnect generations can accumulate multiple in-flight setup tasks during network pathologies.

**Why current behavior is insufficient:** Generation checks prevent stale state installation but do not release resources promptly. They are validation after completion, not cancellation.

**Minimal fix:** Apply explicit connect and handshake timeouts. Pass a per-generation cancellation token into `AgentConnection::connect`, select it against every setup phase, and cancel it from `clear_transfer_connection` and actor shutdown. Move control connection setup out of the actor or select it against actor control messages.

#### M4. Tar size-measurement tasks outlive completed and disconnected downloads

**Classification:** Confirmed bug.

**References:**

- `src/agent/transfers/download.rs:161-222` checks only the watch value, not whether its sender has been dropped.
- `src/agent/transfers/download.rs:340-378` spawns the measurement task without retaining its handle.
- `src/agent/transfers/download.rs:427-451` starts measurement and a separate blocking tar builder.
- `src/agent/state.rs:197-204` sends `true` on registry clear, but normal download cleanup only removes the sender.
- `src/agent/raw/download.rs:62-65` and `src/agent/transfers/download.rs:312-315` normal cleanup remove registry entries without explicitly canceling auxiliary tasks.

**Failure scenario and impact:** A directory tar stream completes quickly, fails, or loses its output channel while the metadata walk is still traversing a large/slow tree. Normal registry removal drops the last watch sender with value `false`; the measurement loop only reads the value, so it continues walking after the transfer is gone and can later attempt a stale progress update. This consumes filesystem I/O, memory for per-directory collections, and a Tokio task beyond the operation lifetime.

**Why current behavior is insufficient:** Closed watch channels and an explicit `true` value are treated differently, but both mean there is no live owner. The task handle is unavailable for joining.

**Minimal fix:** Give the measurement task its own cancellation token or retain its `JoinHandle` in the download session. Cancel and join it on every terminal path, including successful completion. If watch remains, check `has_changed`/closure as well as the borrowed value.

#### M5. One-time download tokens have neither expiry nor capacity bounds

**Classification:** Confirmed bug.

**References:**

- `src/one_time_token_registry.rs:9-19` stores coverage without creation/expiry metadata.
- `src/one_time_token_registry.rs:33-43` inserts every created token into an unbounded nested map.
- `src/one_time_token_registry.rs:59-66` treats every retained token as valid indefinitely.
- `src/one_time_token_registry.rs:68-124` removes a token only after complete byte coverage.
- `src/server/raw.rs:462-524` exposes token creation but performs no expiry/cap cleanup.

**Failure scenario and impact:** An authenticated client repeatedly creates links but never downloads them, or starts only partial downloads. Every UUID, agent/path string, and accumulated range vector remains until process restart. This is an unbounded memory leak and leaves supposedly short-lived credentials valid indefinitely; the API's "invalid or expired" response is misleading because no expiry exists.

**Why current behavior is insufficient:** Completion-only reclamation assumes every issued token is eventually fully consumed, which is not true for abandoned shares or canceled downloads.

**Minimal fix:** Store creation/last-use timestamps, enforce a short TTL and global/per-user capacity, and prune on create/contains/record (or with one bounded maintenance task). Merge/cap partial ranges before accepting more state.

#### M6. Login rate-limit entries are never removed

**Classification:** Confirmed bug.

**References:**

- `src/server/auth.rs:90-101` stores one `FailureWindow` per source IP.
- `src/server/auth.rs:112-117` resets expired windows in place.
- `src/server/auth.rs:120-152` inserts on lookup/failure but never removes entries from `by_ip`.

**Failure scenario and impact:** Requests arrive from many unique IPv6 addresses or proxy-observed client IPs. Each address permanently occupies a hash-map entry even after its failure window expires. A distributed unauthenticated client can grow server memory for the process lifetime.

**Why current behavior is insufficient:** Resetting counters reuses entries for returning clients but does not reclaim clients that never return.

**Minimal fix:** Periodically retain only non-expired/nonzero windows, and apply a hard capacity with oldest-entry eviction. Avoid inserting an entry in `is_limited` when the client has no recorded failures.

#### M7. Router shutdown exists but production shutdown never invokes or joins it

**Classification:** Design risk.

**References:**

- `src/main.rs:591-595` stores the router task in `_router_task`, intentionally discarding lifecycle ownership.
- `src/actors/router/mod.rs:95-108` returns a join handle intended for ownership.
- `src/actors/router/mod.rs:324-331` has a `Shutdown` branch and aborts its periodic UI task only when the router loop exits.
- `src/main.rs:665-682` proceeds from HTTP drain to watchdog shutdown and `exec` without sending router shutdown or awaiting the task.

**Failure scenario and impact:** During restart, router-owned channels, UI subscribers, pending replies, stream maps, and its periodic task remain live until `exec` abruptly replaces memory. If a future non-exec shutdown path is added, merely dropping the stored handle would detach the router indefinitely. Current restart also gives no deterministic point at which agent lanes are closed before child shutdown.

**Why current behavior is insufficient:** The code exposes a shutdown protocol and join handle but production discards both, so cleanup is accidental process replacement rather than an ordered lifecycle.

**Minimal fix:** Retain `router_task`, send `RouterMsg::Shutdown` after canceling/draining handlers, and await it with a deadline before watchdog shutdown/re-exec. In the router shutdown branch, explicitly fail pending replies and signal transfer sockets before dropping state.

#### M8. Atomic file writers leak temp files on cancellation and user-state writes share one temp name

**Classification:** Confirmed bug.

**References:**

- `src/server/auth.rs:287-310` writes a unique session temp file but has no cleanup if write, rename, permission update, or task cancellation fails.
- `src/server/auth.rs:328-351` purges only `session_*.json`, not `.session_*.tmp`.
- `src/server/user_state.rs:53-79` uses the fixed `.state.json.tmp` path with no per-user write lock or cleanup guard.
- `src/server/user_state.rs:92-103` can return after partially writing the shared temp file.

**Failure scenario and impact:** A login or user-state request is canceled after temp creation, disk I/O fails, or rename/permission setting fails. Temp files remain permanently. Two concurrent state updates open/truncate and write the same `.state.json.tmp`; one can rename while the other is writing, causing the second rename to fail or allowing mixed/last-racer contents to be published.

**Why current behavior is insufficient:** Atomic rename protects readers only if each writer owns a unique complete temp file and every abandoned temp is reclaimed. Neither condition holds for concurrent user-state writes.

**Minimal fix:** Use a unique sibling temp file per operation plus a cleanup guard, `sync_all`, rename, and parent-directory sync where durability matters. Serialize writes per account or rely on unique temps with a clear last-write policy. Purge stale session temp files during auth initialization.

### Low severity

#### L1. Raw download seek failure leaves the agent's active-download entry behind

**Classification:** Confirmed bug.

**References:**

- `src/agent/protocol.rs:27-46` inserts the download handle before starting the raw worker.
- `src/agent/raw/download.rs:97-108` sends an error and returns on seek failure without calling `cleanup`.
- `src/agent/raw/download.rs:62-65` is the cleanup method used by the other terminal branches.

**Failure scenario and impact:** A ranged download targets a file-like path for which open succeeds but seek fails, such as some virtual or unusual filesystems. The task exits but `active_downloads` retains its cancel sender until the transfer/control connection is later reset. Repeated failures consume map entries and make later cancel messages appear to target live work.

**Why current behavior is insufficient:** This is the only early error branch in the worker that returns before unregistering itself.

**Minimal fix:** Call `self.cleanup().await` before returning, or introduce a small session guard so every exit removes the request ID automatically.

#### L2. Agent reconnect and notification timers are detached and not canceled on shutdown

**Classification:** Design risk.

**References:**

- `src/agent/actor.rs:259-274` spawns reconnect sleeps without retaining handles.
- `src/agent/actor.rs:277-300` spawns startup-notification sleeps without retaining handles.
- `src/agent/transfer.rs:231-247` similarly detaches transfer reconnect timers.
- `src/agent/actor.rs:75-94` shuts down the actor without canceling or joining these timers.

**Failure scenario and impact:** The actor shuts down or rapidly changes generations while one or more timers sleep. They retain `AgentHandle`, tokens, and strings until their delay expires, then send into a closed mailbox. Generation checks prevent state corruption, but shutdown is not prompt from a task/resource accounting perspective and repeated connection churn can accumulate sleepers.

**Why current behavior is insufficient:** Stale-message validation prevents behavioral races but does not release timer allocations at lifecycle end.

**Minimal fix:** Keep one replaceable `JoinHandle` or cancellation token for each timer category, cancel it on generation change/shutdown, and join or abort it before actor exit.

#### L3. Test cleanup retains stale paths and several temp tests rely on happy-path completion

**Classification:** Confirmed bug in test infrastructure.

**References:**

- `tests/test-utils.ts:100-103` tracks both files and directories.
- `tests/test-utils.ts:163-184` clears `files` but never clears `dirs`, so repeated cleanup retains every old directory path.
- `src/agent/transfers/download.rs:591-629` removes tar-size test directories only after all assertions.
- `src/binaries.rs:294-310` creates a background test server whose callers must manually abort the handle.

**Failure scenario and impact:** A shared `TempFileManager` is reused across many tests, or an assertion fails before explicit Rust test cleanup. The manager repeatedly retains and revisits stale directory names; Rust tests can leave filesystem fixtures until an external cleanup, and manually owned server tasks survive until the per-test runtime is torn down. This adds noise to later failures and weakens leak tests.

**Why current behavior is insufficient:** Cleanup is not registered at resource creation and therefore depends on reaching the end of the happy path. The repository guidance explicitly prefers `onTestFinished()` for single-test cleanup.

**Minimal fix:** Clear both `files` and `dirs` in `TempFileManager.cleanup`. Register temp directories, proxies, sockets, and task aborts immediately with `onTestFinished()` or an RAII test guard, before the first assertion that can fail.

## Testing recommendations

1. **Router saturation cleanup:** Fill the router mailbox, then disconnect a control socket and abort an upload. Assert the agent, transfer maps, pending replies, temp files, and UI subscriber are removed without requiring a later event.
2. **Unmanaged stale socket:** Connect an unmanaged agent through Toxiproxy, blackhole both directions without TCP close, and use shortened WebSocket timeouts. Assert router inventory becomes disconnected and pending commands fail.
3. **Tar upload cancellation race:** Pause or instrument extraction after it creates entries, cancel the upload, and assert the blocking worker has exited before the hidden temp directory is absent. Run multiple concurrent uploads and assert ordinary control requests remain responsive.
4. **Agent graceful shutdown during work:** Start raw upload, tar upload, local file copy, local directory copy, file search, terminal, and log tasks; trigger `Shutdown`/stdin EOF; then assert all tasks joined, PTY descendants reaped, channels closed, and hidden temp paths removed.
5. **Provisioning cancellation:** Cancel watchdog preparation during each SSH command/upload phase and cancel release provisioning during download and `tar`. Assert local children are reaped and local/remote temp paths are removed.
6. **REST timeout ownership:** Use an agent fixture that accepts commands but never responds. After each HTTP timeout/client abort, inspect a test-only router snapshot and assert `pending_rest`, downloads, and uploads return to baseline within a fixed deadline.
7. **No-sleep transfer tests:** Gate workers with channels/log messages rather than sleeps, abort clients before first chunk and while waiting for completion, then poll progress and filesystem state until terminal cleanup.
8. **Bounded restart:** Hold a download body and a stuck supervisor, request restart, and assert the old process exits within the configured drain deadline and no managed child remains.
9. **Connection setup cancellation:** Blackhole TCP and TLS handshakes, request agent shutdown or replace the generation, and assert setup tasks/sockets disappear promptly.
10. **Registry bounds:** Create more one-time tokens and unique login-source IPs than the chosen caps, advance paused Tokio time beyond TTLs, and assert old entries are evicted.
11. **Concurrent atomic writes:** Issue concurrent user-state updates and cancel one at each await boundary. Assert the final file is valid JSON, represents one complete writer, and no `.tmp` files remain.
12. **Test leak checks:** At integration-suite teardown, assert no tracked child processes, Toxiproxy proxies, WebSockets, temporary roots, or known `.redoor-*` temp paths remain.

## Residual risks

- Blocking filesystem and PAM operations can remain inside the OS after async cancellation; tests should cover slow/network filesystems and a deliberately hung PAM backend where feasible.
- `spawn_blocking` work cannot be forcibly canceled once running. Ownership, cooperative stop signals, and join-before-delete are therefore more important than aborting handles.
- Abrupt process death (`SIGKILL`, crash, power loss) cannot run async cleanup. Temp naming should support safe startup scavenging for upload, copy, provisioning, session, and user-state artifacts.
- WebSocket/TCP behavior under half-open mobile networks and backpressured kernels is platform-dependent; production-like fault injection is still needed beyond unit tests.
- Browser `AbortController` use is inconsistent: selected-file transfer polling is aborted, but copy/move start calls do not receive that signal, and upload queue requests have no explicit component-lifetime abort. Those operations may be intentionally server-owned, but that ownership contract should be documented and tested.
