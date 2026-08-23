# Unbounded Operations Review

## Scope

This review covers recursive filesystem work and resource-pressure paths such as queues, channels, buffers, task spawning, and retained collections. It distinguishes finite control operations, which should have total deadlines, from long-running streamed transfers, which should use cancellation and inactivity limits rather than short total timeouts.

## Changes Made

- `safe_rm_all` now performs iterative, entry-by-entry deletion without following directory symlinks. The traversal has a five-minute total deadline, so cleanup cannot occupy a task forever. Timing out reports that deletion may be partial.
- permanent raw directory deletion now has a 25-second agent-side deadline, shorter than the REST router's 30-second wait. Dropping the timed traversal stops scheduling further filesystem operations instead of leaving an opaque recursive `remove_dir_all` job running.

## Recursive Filesystem Findings

### High: same-agent recursive copy and move have uncancellable phases

Locations: `src/actors/router/transfers/copy.rs:163`, `src/actors/router/cleanup.rs:242`, `src/agent/state.rs:394`, `src/agent/transfers/copy.rs:429`, `src/agent/transfers/destination.rs:206`, `src/agent/transfers/move.rs:149`.

Same-agent copy receives connection-generation cancellation, but it is not registered with the transfer-specific cancellation registry. Merge placement and whole-file `tokio::fs::copy` calls have no progress cancellation points. A canceled copy can therefore retain a command slot and continue filesystem work. Large transfers should not have a short total timeout; add transfer-specific cancellation throughout traversal, merge, and move cleanup, replace whole-file copies with chunked copies, and add an inactivity deadline.

### High: tar upload extraction and finalization can wait forever

Locations: `src/agent/transfers/upload.rs:125`, `src/agent/transfers/upload.rs:169`, `src/agent/transfers/upload.rs:351`, `src/agent/transfers/upload.rs:593`, `src/server/raw/upload.rs:184`.

Cancellation closes the tar input and then waits without a deadline for a `spawn_blocking` extractor, which cannot be aborted once running. Per-entry `tar::Entry::unpack`, destination merge, and cleanup can block completion indefinitely. Add cooperative cancellation between entries and chunked file writes, bound cancellation join grace to 5-10 seconds, and apply a post-EOF inactivity/finalization timeout rather than a total transfer timeout.

### High: permanent recursive deletion outlived the REST timeout

Locations: `src/server/files.rs:32`, `src/commands/handler.rs:314`, `src/safe_fs.rs:8`.

Previously, the REST layer stopped waiting after 30 seconds while agent-side `tokio::fs::remove_dir_all` could continue indefinitely in an opaque blocking operation. This finding is addressed by the iterative bounded traversal and the 25-second command deadline described above.

### High: Git status can recursively walk after its caller times out

Locations: `src/server/git.rs:112`, `src/commands/git.rs:131`, `src/commands/git.rs:470`, `src/commands/git.rs:527`.

Git response entries are capped, but the worktree traversal is not. The existing gix interruption flag is set when the agent future is dropped, while the REST timeout only abandons the router reply. Add a 20-25 second agent deadline that sets the interruption flag, and stop traversal when the result limit is reached where ordering requirements allow it.

### High: binary provisioning holds a global lock across unbounded I/O

Locations: `src/binaries.rs:8`, `src/binaries.rs:151`, `src/binaries.rs:198`, `src/server/agents/upgrade.rs:176`, `src/ssh/provision.rs:293`.

Release download, response streaming, tar extraction, and cleanup occur while holding the process-wide provisioning mutex. Network and tar subprocess phases lack explicit deadlines. Configure connect and idle-read timeouts, apply a generous total provisioning deadline, bound tar extraction and kill/reap it on timeout, and avoid holding the lock during deferred cleanup. Recursive cleanup itself is now bounded through `safe_rm_all`.

### Medium: tar download has long cancellation gaps and detached metadata work

Locations: `src/agent/transfers/download.rs:82`, `src/agent/transfers/download.rs:159`, `src/agent/transfers/download.rs:340`, `src/agent/transfers/download.rs:425`.

Archive creation collects and sorts all direct entries before processing them, creating memory pressure and delaying cancellation. The detached size estimator can survive transfer completion because dropping its watch sender does not set the watched value. Traverse incrementally, explicitly cancel and join the estimator on every terminal path, and cap advisory size measurement at about 30 seconds. Use inactivity cancellation for the actual stream.

### Medium: destination merge and replacement cleanup delay published operations

Locations: `src/agent/transfers/destination.rs:132`, `src/agent/transfers/destination.rs:163`, `src/agent/transfers/destination.rs:224`, `src/agent/transfers/move.rs:204`.

An old destination may be renamed aside and then recursively removed before the already-published operation reports success. Move old content to an owned quarantine path, give synchronous cleanup a small budget, then finish cleanup in a supervised bounded task. The shared five-minute deletion ceiling prevents permanent stalls but does not remove this completion latency.

### Medium: trash inventory scans are unbounded

Locations: `src/agent/trash/linux.rs:175`, `src/agent/trash/linux.rs:338`, `src/agent/trash/linux.rs:737`, `src/server/trash.rs:61`.

List and restore scan every direct trash entry, read each metadata file fully, retain all valid items, and sort them. Add a 20-25 second agent deadline, paginate list results, stop restore once its ID is found, and cap metadata file size.

### Medium: build traversal follows directory symlinks and buffers all paths

Locations: `build.rs:26`, `build.rs:63`, `build.rs:80`.

The custom UI traversal uses `Path::is_dir`, which follows symlinks and permits cycles, and retains every path before emitting directives. Use `symlink_metadata`, avoid descending through symlinks, emit directives incrementally, and bound finite Git probes used by the build script.

## Queue, Channel, and Resource Findings

### Critical: control WebSocket permits large malformed frames and logs them verbatim

Locations: `src/server/ws.rs:18`, `src/actors/session.rs:275`, `src/logging.rs:356`.

The agent control socket has no explicit frame/message size, and parse failures format the complete untrusted frame before bounded logger admission. Set limits sized for legitimate command responses and log only frame length, parse error, and a small sanitized prefix.

### High: upload concurrency bypasses the command cap

Locations: `src/agent/protocol.rs:16`, `src/agent/protocol.rs:366`, `src/agent/state.rs:102`, `src/agent/raw/upload.rs:391`, `src/agent/transfers/upload.rs:547`.

Uploads are exempt from the 32-command cap and active upload maps have no admission limit. Each raw upload owns files, channels, and a task; each tar upload also owns a blocking extractor. Add per-agent upload admission and a smaller tar-upload cap before allocating temporary resources.

### High: active transfer count is unbounded server-wide and per agent

Locations: `src/server/routes.rs:38`, `src/server/raw/upload.rs:335`, `src/actors/router/progress.rs:126`, `src/actors/router/state.rs:151`.

Bounded per-stream channels do not bound the number of HTTP tasks, sockets, temporary files, or map entries. Add process-wide and per-agent transfer semaphores and load shedding for expensive routes.

### High: canceled transfer state can remain forever

Locations: `src/actors/router/cleanup.rs:246`, `src/actors/router/cleanup.rs:283`, `src/actors/router/agents.rs:47`, `src/actors/router/transfers/download.rs:133`, `src/actors/router/transfers/upload.rs:364`.

Cancellation retains full stream state until an agent acknowledgement, while priority cancellation uses `try_send` and ignores failure. Remove client-owned state immediately and retain only bounded expiring tombstones if late acknowledgement tracking is needed.

### High: transfer-progress history grows monotonically

Locations: `src/actors/router/state.rs:272`, `src/actors/router/progress.rs:107`, `src/actors/router/progress.rs:273`, `src/actors/router/progress.rs:356`.

Terminal transfer entries are never evicted, and each list request clones and sorts all history on the single router task. Keep active entries, cap terminal history by age/count, and paginate responses.

### High: directory listing responses have no entry or byte cap

Locations: `src/commands/handler.rs:191`, `src/commands/handler.rs:241`, `src/agent/protocol.rs:325`.

A directory with millions of direct children becomes one vector and one JSON WebSocket frame. Add pagination or a hard entry/encoded-size limit with a truncation marker, coordinated with the control WebSocket frame limit.

### High: one-time download tokens have no expiry or capacity limit

Locations: `src/one_time_token_registry.rs:19`, `src/one_time_token_registry.rs:33`, `src/one_time_token_registry.rs:68`, `src/server/raw.rs:590`.

Unused and partially consumed tokens retain path strings and range vectors indefinitely. Add creation/last-use expiration, pruning, and global/per-path capacity limits.

### High: browser directory upload queues every directory concurrently

Locations: `ui/src/upload-queue.ts:89`, `ui/src/upload-queue.ts:106`, `ui/src/upload-queue.ts:165`, `ui/src/upload-queue.ts:241`, `ui/src/upload-queue.ts:279`.

The 100-item queue cap covers files but not directories; all waiting directories are claimed together and settled promises are retained. Count both files and directories, use a small directory concurrency pool, and remove settled map entries.

### Medium: UI event subscribers use unbounded channels

Locations: `src/server/ws.rs:99`, `src/actors/router/state.rs:284`, `src/actors/router/ui.rs:102`.

A UI socket that stops reading accumulates events without backpressure. Use a small bounded channel and coalesce domain refresh events.

### Medium: transfer drop guards can spawn unlimited blocked tasks

Locations: `src/server/raw.rs:68`, `src/server/raw/upload.rs:247`, `src/actors/router/mod.rs:32`.

Each canceled handler spawns a task waiting for the bounded router mailbox, bypassing the mailbox's memory bound. Use one bounded cleanup queue or bounded `try_send` retry/tombstone handling.

### Medium: watchdog and lifecycle bridges use unbounded channels

Locations: `src/watchdog.rs:137`, `src/watchdog.rs:323`, `src/server/watchdog.rs:68`, `src/agent/mod.rs:76`.

Commands or cloned snapshots can accumulate when consumers are delayed. Use bounded control channels; use `watch` for latest-state snapshots and generation-keyed lifecycle state.

### Medium: retained registries grow for process lifetime

Locations: `src/actors/router/state.rs:100`, `src/actors/router/agents.rs:148`, `src/server/auth.rs:90`, `src/server/auth.rs:287`.

Disconnected unmanaged agents, login-rate IP keys, and session files lack complete age/count eviction. Add periodic expiry and caps, retaining managed agents as required.

### Low: local configuration imports and files can be read without size limits

Locations: `src/config/import.rs:51`, `src/config.rs:144`, `src/server/user_state.rs:35`, `ui/src/api-client.ts:199`.

Configuration import reads stdin to EOF, local config/state files are read wholly, and browser error handling reads full response bodies before truncating display text. Add explicit byte limits and bounded-prefix reads.

## Existing Bounds Worth Preserving

- File search has elapsed-time and supersession cancellation and retains at most 100 results (`src/commands/file_search.rs`).
- Transfer framing and payload channels are bounded and large files are streamed (`src/streaming.rs`, `src/server/raw.rs`, `src/server/raw/upload.rs`).
- Remote copy uses per-chunk acknowledgement and bounded destination queues (`src/actors/router/transfers/copy.rs`).
- Terminal, log, and pending setup registries already have explicit capacity limits (`src/terminal_registry.rs`, `src/log_registry.rs`, `src/logging.rs`).
- SSH and watchdog diagnostic output is retained through bounded tails (`src/ssh/transport.rs`, `src/watchdog.rs`).
- Route invalidations are coalesced, and ordinary browser file uploads have count/concurrency caps (`ui/src/refresh-listener.ts`, `ui/src/upload-queue.ts`).

## Recommended Order

1. Limit control WebSocket frames and stop logging raw malformed frames.
2. Add transfer/upload admission limits and bounded cancellation cleanup.
3. Cap transfer history, directory listings, and one-time token registries.
4. Complete cooperative cancellation and inactivity deadlines for copy and tar workflows.
5. Add internal Git, provisioning, trash, and advisory metadata deadlines.
