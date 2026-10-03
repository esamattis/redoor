# Rust memory and resource retention review

Date: 2026-10-03. Initial reviewed revision: `a96c39ef2b778d5dad6a38cbebe059bd1069b842`.

## Follow-up implementation

The five fixes selected from the easiest-change list were implemented by separate subagents, each running tests and creating a focused commit. The original findings below describe the reviewed revision; this table records their current resolution.

| Finding | Resolution | Commit in the main workspace |
| --- | --- | --- |
| R8: failed raw-download seek | Unregister before reporting the seek error; worker regression test covers the failing branch. | `25a6ddb` |
| R9: lost terminal command responses | Await router mailbox admission and log router shutdown failures; regression test verifies full-mailbox backpressure. | `001ea8f` |
| R7: login source-IP retention | Retain only failed-login sources, prune expired 60-second windows, and cap tracking at 1,024 IPs. At capacity, reject untracked sources without evicting active lockouts; in-flight failures still count globally. Deterministic tests cover expiry, cardinality and abuse protection. | `b39176a` |
| R3: lifetime transfer history | Keep the newest 1,000 ordinary terminal rows and expire them after one hour. Preserve active/canceling transfers and the inclusive 60-second download resume window. Idle maintenance checks once per minute, shrinks oversized maps and invalidates UI history. Deterministic tests cover count, expiry, live-state protection and resume behavior. | `00da674` |
| M1: aggregate Git diffs | Deduplicate paths in first-occurrence order, reject more than 128 distinct files, and budget retained patch text to 8 MiB. Patches that cannot fit use the existing `too_large` outcome; later smaller patches can still fit. Unit and REST regression tests cover these limits. | `687014c` |

Recent resumable downloads can temporarily exceed R3's ordinary history cap; once their protection expires, the next maintenance pass restores the cap. Active/canceling rows are not capped by history retention. Other findings remain open.

Every subagent ran the full `pn test` command. R8, R7, M1 and R3 passed their full suites. R9 passed Rust, integration and all build/lint checks, but its browser suite timed out in the existing mocked measuring-badge tooltip case (`ui/e2e/server-home.spec.ts:139`). The final combined `pn test` passed after all five commits were brought into the main workspace (477 seconds, including integration and Playwright). The tooltip case passed on subsequent runs and is recorded in `flaky-tests.md`. The runner skipped Android checking because `cargo-ndk` is unavailable; the required development-service restart completed.

## Scope and codebase map

Redoor has one Rust package, built as a library and a CLI binary. The binary selects server, agent, remote-client, and service-management roles. The UI and TypeScript integration tests are outside this review's implementation scope.

| Area | Main modules | Memory and resource ownership |
| --- | --- | --- |
| Server HTTP/WebSocket entry points | `src/server/`, `src/main.rs` | Shared server state, HTTP body lifetimes, browser sockets, authentication and upload-request state |
| Server routing | `src/actors/router/`, `src/actors/session.rs` | Single-owner router with a bounded 1,024-message mailbox; agent connections, pending replies, uploads/downloads, copy requests, progress history and UI subscribers |
| Agent runtime | `src/agent/actor.rs`, `state.rs`, `protocol.rs`, `ws.rs` | Connection generations, command JoinSet, active worker registries, cancellation signals and reconnect tasks |
| Payload workers | `src/agent/raw/`, `src/agent/transfers/`, `src/agent/transfer.rs` | Streaming buffers, bounded chunk queues, archive producer/extractor tasks, temporary output and secondary WebSockets |
| Commands and filesystem traversal | `src/commands/`, `src/directory_measurement.rs`, `src/agent/trash/` | Search/grep permits, Git response buffers, directory collections and trash metadata |
| Shared registries and logging | `src/terminal_registry.rs`, `log_registry.rs`, `one_time_token_registry.rs`, `logging.rs` | Socket rendezvous entries, credentials, bounded replay history and output queues |
| Managed processes and SSH | `src/watchdog.rs`, `src/ssh/`, `src/ssh.rs`, process/service modules | Supervisor handles, snapshots, child processes, SSH pipes and diagnostic readers |
| Remote CLI | `src/remote/` | HTTP client, persisted cookies, stream bodies and staging/admission tasks |

The primary reviewer mapped these owners before launching three parallel review agents: server/router; agent lifecycle/commands; and transfer/archive workers. The primary reviewer checked shared registries, logging, SSH/watchdogs, remote CLI, and the reported findings. Review traced completion, cancellation, queue saturation, disconnect and generation replacement paths. Older review documents were consulted only as context; findings below refer to current code.

This is a static review. “Confirmed” means the retention or missing bound follows from current control flow; it does not mean production RSS growth has been measured. P1 means address first because a workload can retain large resources or exhaust memory; P2 means meaningful growth or lifecycle risk; P3 means a narrow error-path leak. Reachable but unnecessary retained allocations, tasks and queues count as leaks here even when Rust will free them at process exit. Temporary peak allocation is explicitly separated.

## Findings: persistent retention and orphaned tasks

### R1 — P1: UI WebSocket event queues grow without bound for slow clients

**Evidence:** `src/server/ws.rs:102` creates an unbounded `UiEvent` channel per browser. `forward_ui_events` at `src/server/ws.rs:65` awaits socket sends without a deadline. `src/actors/router/ui.rs:118` continues sending events as long as the receiver exists, pruning only closed channels.

**Trigger and impact:** A connected client stops reading, or its network becomes half-open. Once transport buffers fill, forwarding stalls while the router continues enqueueing events. Neither receive-side close nor send failure is guaranteed to arrive promptly. Retention scales with event count and stalled subscribers. Normal disconnect cleanup is correct but cannot bound a client that remains apparently connected.

**Fix:** Use bounded/coalesced invalidation events and disconnect lagging subscribers; put a deadline on writes and add explicit liveness handling. Avoid awaiting a slow browser from the single-owner router.

**Validation:** Connect a fixture that stops reading, generate more events than the selected bound, and assert queue/task/subscriber counts remain bounded and the lagging client is removed. Use progress signals or polling rather than test sleeps.

### R2 — P1: Lost upload cancellation retains both server state and idle agent workers

**Evidence:** `src/actors/router/cleanup.rs:477` sets `canceled_by_rest`, then line 493 calls `send_priority_message` without checking its result. `src/actors/router/agents.rs:51` delegates to `try_send` on a bounded lane; it returns false when full. Subsequent cancellation returns immediately at `src/actors/router/cleanup.rs:473`. Cleanup normally removes the upload on the agent acknowledgement at `src/actors/router/transfers/upload.rs:526`. Agent upload loops at `src/agent/raw/upload.rs:310` and `src/agent/transfers/upload.rs:452` wait for cancellation or another chunk, while the active registry still owns their senders.

**Trigger and impact:** Abort admitted HTTP uploads while the agent's 16-message priority lane is full. Router delivery of the cancellation itself succeeds, but downstream enqueue fails. The HTTP producer has gone away, yet the agent registry prevents chunk-channel closure. The worker, temporary output, channel buffers/cancellation handles and router upload entry can remain indefinitely during a stable connection. A second cancel does not repair the failed implicit delivery.

**Fix:** Make agent cancellation delivery reliable and owned until acknowledgement, or fence/tear down the affected connection when cancellation cannot be delivered. Do not mark delivery irreversibly complete before admission succeeds. Keep the router responsive while retrying.

**Validation:** Prefill the priority lane, cancel an admitted idle upload, drain the lane, and verify cancellation is eventually delivered and both registries and temporary output disappear. Cover repeated cancellation and both raw and tar uploads.

### R3 — P2: Completed transfer progress is retained for the server's entire lifetime

**Evidence:** `src/actors/router/state.rs:383` owns `TransferProgressStore.entries`. New downloads, uploads and copies insert entries in `src/actors/router/progress.rs:111`, `:140`, and `:178`. Completion/error handlers at `:279`, `:307` and `:336` mutate entries into terminal states; they do not evict them. Production code has no retention limit, TTL or clear operation for this map.

**Trigger and impact:** Ordinary repeated downloads, uploads, copies, moves and editor saves accumulate unique rows, paths and error strings forever. Progress listing clones/sorts the full history, amplifying both memory and CPU costs as the process ages. Active-worker cleanup does not remove historical progress.

**Fix:** Keep active rows and a bounded recent terminal history. Preserve the existing 60-second canceled-download resume window when choosing expiry. Paginate history or persist it outside process memory if unlimited history is a product requirement.

**Validation:** Complete many transfers and edits, assert terminal history remains within its limit after pruning, and verify active and recent resumable rows survive.

### R4 — P2: Unused one-time tokens and incomplete coverage never expire

**Evidence:** `src/one_time_token_registry.rs:34` creates another entry on every call; only fully merged download coverage removes it at `:129`. `TokenEntry.downloaded_ranges` at `:15` is an uncapped vector of merged disjoint ranges. `src/server/raw.rs:564` exposes token creation through the REST handler. There is no TTL, count limit, revocation or agent-removal cleanup in this registry.

**Trigger and impact:** Create download links that are never used, abandon downloads, or delete the underlying files/agents. All associated paths, token entries and incomplete range coverage remain until process exit. Many disjoint partial ranges can also grow a single token's vector. Completion cleanup is correct, but abandoned tokens have no cleanup path.

**Fix:** Add expiry and global/per-scope admission limits, remove invalidated scopes where appropriate, and bound range fragmentation without incorrectly granting coverage. Document link lifetime.

**Validation:** Create unused tokens above the chosen limit, advance a controllable clock past expiry, and verify storage is bounded. Cover interrupted retries, disjoint ranges and concurrent single-use completion.

### R5 — P2: Late transfer cancellations leave permanent agent tombstones

**Evidence:** `src/agent/protocol.rs:661` inserts a cancellation ID when no active worker exists. Only receiving a command with that same ID removes it at `:462`; control/transfer teardown clears the set in `src/agent/actor.rs:203` and `:292`.

**Trigger and impact:** A worker removes its active handle before its terminal result reaches the server. A legitimate client cancellation during that window arrives after agent-side completion, so it is treated as cancellation preceding registration. The unique ID will never have another command. Repeating this race grows `pending_transfer_cancellations` for the full stable connection lifetime. Each entry is small, but there is no bound.

**Fix:** Distinguish already-completed requests from commands awaiting admission, or use bounded expiration tied to the maximum command-admission delay. Preserve the required behavior when priority cancellation overtakes a command.

**Validation:** Gate terminal-result delivery, complete the worker, deliver a late cancel and repeat unique IDs; assert retained state returns to baseline. Separately verify cancellation before worker registration still prevents publication.

### R6 — P2: Replaced transfer connection attempts are detached and cannot be canceled

**Evidence:** `src/agent/transfer.rs:27` cancels only an installed connection, whose shutdown sender is created after `connect` completes. `spawn_transfer_connection` at `:90` discards the JoinHandle. `run_transfer_connection` at `:110` waits for `AgentConnection::connect`; `src/agent/connection.rs:59` has no timeout around TCP/TLS/WebSocket setup. Generation validation happens after setup, when the sender is installed.

**Trigger and impact:** A server/proxy accepts TCP but never completes the secondary WebSocket handshake. Further transfer-open messages or control reconnects create fresh generations while old setup futures remain pending. Each old attempt holds a task, socket, token, actor/control senders and registry references. Generation fencing prevents stale installation but does not release the pending work.

**Fix:** Own one setup task per generation and cancel/join its replacement or shutdown. Apply a deadline spanning the full connection handshake, with cancellation available before connect begins.

**Validation:** Gate the transfer handshake while allowing control connectivity; repeatedly replace credentials, then shut down. Assert stale setup tasks and sockets disappear without releasing the handshake gate.

### R7 — P2: Login source-IP entries never leave the rate limiter

**Evidence:** `src/server/auth.rs:129` inserts an IP during `is_limited`; `:145` inserts during `record_failure`. `FailureWindow::refresh` at `:113` resets counters in place. There is no removal or capacity policy for `LoginRateLimiter.by_ip`.

**Trigger and impact:** Login requests from new source IPs accumulate entries even when credentials succeed, requests are already globally limited, or the failure window expires. Memory tracks all source addresses ever seen, rather than recent login activity. Distributed traffic can grow unauthenticated process state over time; the global failure counter does not bound map cardinality.

**Fix:** Evict expired windows and bound cardinality while keeping a safe global fallback for new addresses. Do not let eviction weaken the current abuse protection.

**Validation:** Exercise many distinct addresses, advance the limiter clock beyond the window, and assert bounded entries while active per-IP/global limits remain effective.

### R8 — P3: A raw-download seek failure skips active-registry cleanup

**Evidence:** `src/agent/raw/download.rs:120` handles a failed range seek by sending an error and returning at `:130`, without invoking `cleanup` at `:83`. `ActiveDownloads` continues owning the cancellation sender. Later cancellation at `src/agent/protocol.rs:650` signals the sender but does not remove the dead entry.

**Trigger and impact:** A ranged file seek fails, for example because the source changes between metadata and open into a nonseekable source, or a filesystem returns a seek error. Each request leaves a registry entry until connection teardown. This is a narrow leak of metadata/channel state, not retention of the whole file buffer. A plain zero-size FIFO is not a trivial REST reproduction because range validation rejects it.

**Fix:** Centralize unregister-on-exit ownership, or call cleanup on this branch before error delivery.

**Validation:** Inject a seek failure after registration, then assert the active download count returns to baseline even when error delivery/cancellation also fails.

### R9 — P2: Router saturation can discard terminal command responses

**Evidence:** `src/actors/session.rs:220` forwards `CommandResponse` through `router_ref.send` and ignores the result. `src/actors/router/mod.rs:49` implements this as `try_send` on the bounded mailbox. Unlike the awaited `TransferReady` path, a terminal upload/copy response has no retry when the mailbox is full.

**Trigger and impact:** An agent finishes an upload or local copy/move during router saturation. Its terminal response disappears before the router removes the corresponding transfer bookkeeping. The agent may have cleaned up successfully while the router retains upload/copy state and completion channels until disconnect or another explicit cleanup path. Ordinary timed REST replies have separate timeout pruning; that safeguard does not remove transfer-owned state.

**Fix:** Await mailbox admission for terminal responses, preserving bounded backpressure and reporting router shutdown. Audit one-shot completion messages for the same delivery guarantee.

**Validation:** Fill the router mailbox, finish a registered upload/copy, and verify its terminal response waits for admission and the transfer registries return to baseline after capacity becomes available.

## Findings: temporary memory exhaustion rather than permanent leaks

### M1 — P1: Git diffs have a per-file limit but no aggregate response limit

**Evidence:** `src/server/git.rs:64` forwards the requested files without a count limit or deduplication. `src/commands/git.rs:305` collects every patch into a response vector. Individual unified patches allow up to 4 MiB, but total response bytes are not budgeted.

**Trigger and impact:** A short request can repeat a changed file many times. Thousands of near-limit diffs can occupy gigabytes, followed by an additional aggregate serialization allocation. The 32-command task limit does not bound bytes per result. Cancellation and individual-file limits do not prevent this peak.

**Fix:** Deduplicate files and enforce count and aggregate byte limits at server and agent boundaries, before accumulating patches beyond the budget.

**Validation:** Request many repeated large changed files and verify bounded rejection/truncation with a small deterministic aggregate budget.

### M2 — P2: Archive streaming still collects unbounded directory metadata

**Evidence:** `src/agent/transfers/download.rs:22` collects and sorts every directory entry before recursion, retaining ancestor vectors while descendants run. `src/directory_measurement.rs:122` similarly collects entries; pending directory paths and measurement errors are also uncapped. Tar download size measurement can run concurrently with archive generation.

**Trigger and impact:** A very wide or deeply nested directory consumes memory proportional to metadata/path counts despite fixed-size file streaming. Concurrent traversal duplicates that pressure on restrained agents. These allocations normally release when traversal finishes; this is not a persistent ownership leak.

**Fix:** Traverse incrementally where ordering is unnecessary. Where deterministic archive ordering is required, use bounded/spilled sorting or an explicit entry/path budget; bound diagnostics and simultaneous measurements.

**Validation:** Generate a wide directory under a constrained budget and assert traversal memory/admission stays bounded and cancellation releases collected state.

## Secondary observations and checked safeguards

- Linux trash parsing at `src/agent/trash/linux.rs:525` reads an entire `.trashinfo` file; trash inventories are also uncapped. Bound metadata reads and consider capped/paginated listings. This is an allocation risk, not demonstrated permanent retention.
- `src/watchdog.rs:971` snapshots a log length but then uses unrestricted `read_to_end`; concurrent append can exceed the intended final diagnostic window. Use a bounded reader for the captured window. This is a concurrency-dependent peak-allocation risk.
- Ordinary command JoinSet completions are reaped on later command admission, with a 32-task cap; shutdown/disconnect cancel and join those workers. Idle completed records are bounded and were not reported as an unbounded leak.
- File transfer payloads generally use fixed-size chunks and bounded channels. Archive extension parsing has explicit bounds. These safeguards do not bound metadata traversal or concurrent worker count.
- Terminal/log setup registries cap pending entries globally and per agent; agent active terminal/log sessions are capped and signaled on teardown.
- Logging replay, broadcast and producer queues have explicit capacities and bounded messages. The process-global logger is intentional process-lifetime state.
- Managed watchdog startup cycles clear provisioning history; SSH diagnostic readers retain bounded tails, and child commands use kill-on-drop where inspected. No unbounded provisioning-history leak was confirmed.
- Remote CLI error bodies and persisted session reads are bounded; file bodies stream and staging/admission tasks have explicit cleanup ownership.
- No `mem::forget`, `Box::leak` or raw-pointer ownership cycle was found in the searched Rust sources. PAM allocation-failure cleanup and transaction completion were inspected; the principal findings concern async lifetimes and reachable collections.

## Validation and limits

The initial review made no implementation or test changes. Its reproduction procedures above were proposed regression tests, not executed leak proofs. The follow-up fixes and their regression coverage are tracked at the top of this document. A passing functional suite does not establish bounded memory for every reviewed scenario. Allocator caching can keep RSS high after allocations are freed, so further verification should inspect live registry/task counts and heap allocations alongside RSS.

Recommended order: reliable upload cancellation and bounded UI queues; aggregate diff limits; bounded transfer/token history; then tombstones, setup-task ownership, limiter eviction and seek-error cleanup.

Initial review test run: `mise exec -- timeout 1800 pn test` passed. This covered the build, Rust tests, TypeScript checks, lint, formatting, Clippy, integration tests and Playwright. The runner skipped Android checking because `cargo-ndk` is not installed. The test script also restarted the development service.
