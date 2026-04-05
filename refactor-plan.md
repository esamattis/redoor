# Router Refactor Plan

## Purpose

`src/actors/router.rs` has grown into one large module that currently owns several distinct domains at once:

- agent registration and lookup
- one-shot command routing
- direct download routing
- direct upload routing
- remote and local copy orchestration
- transfer progress bookkeeping
- UI refresh throttling and subscriber fanout
- disconnect cleanup

The file is now hard to navigate because each of those concerns has its own state, invariants, and completion paths, but they are all interleaved in one `impl RouterActor` block and one large `match` in `handle()`.

This plan keeps the runtime behavior the same while splitting the code into focused modules and reducing argument-heavy helper functions.

## Motivations

- Make the code easier to read by grouping related logic together.
- Make the streaming paths easier to audit for correctness.
- Reduce the risk of accidental regressions when changing upload, download, or copy flows.
- Make more of the bookkeeping logic unit-testable without going through the full router entry point.
- Replace broad, overloaded state maps with narrower domain-specific types.
- Reduce long parameter lists by introducing small context structs.

## Hard Constraints

- Keep the current runtime topology unchanged.
- Preserve the current backpressure behavior for uploads, downloads, and remote copy.
- Never buffer an entire file, tar stream, or reframed copy in memory.
- Keep control messages responsive while transfer traffic is flowing.
- Do not change the wire format for websocket streaming frames.
- Do not change REST API behavior.
- Do not change external command/result semantics.
- Prefer mechanical moves first, then type cleanup, then behavior-preserving simplification.

## Streaming Invariants That Must Not Change

These are the most important rules in the refactor. Every extraction should be checked against them.

### 1. Binary sends must stay bounded

The binary lane in `session.rs` is intentionally bounded:

- `src/actors/session.rs:185`

That capacity is part of the current backpressure behavior and must remain bounded.

### 2. Incoming binary chunk acknowledgement must stay coupled to downstream acceptance

For all streamed data paths, the router currently delays the RPC reply until the downstream bounded send has either succeeded or failed.

Current places where this happens:

- download forwarding: `src/actors/router.rs:1160-1176`
- upload forwarding: `src/actors/router.rs:2070-2089`
- remote copy forwarding: `src/actors/router.rs:796-822`

This ordering must remain true after the split:

1. receive one chunk
2. start the bounded downstream send in a background task
3. send an internal completion message back to the router only after that send finishes
4. only then reply to the original caller

If this changes, the system can start buffering chunks in the wrong place.

### 3. Remote copy reframing must stay incremental

Remote copy currently uses `StreamChunkFrames` to reframe one incoming chunk into one or more destination frames and sends them one at a time.

- frame iterator: `src/streaming.rs:174-235`
- copy reframing helper: `src/actors/router.rs:372-394`

This must stay incremental. Do not collect all derived frames into a `Vec` before sending them.

### 4. Transfer cancellation semantics must stay intact

Downloads currently mark `canceled_by_rest` and send `Message::CancelTransfer { request_id }` only when needed.

- cancel path: `src/actors/router.rs:1192-1251`, `1555-1597`

The refactor must keep the same semantics for:

- client-side stream receiver drop
- agent-side completion after cancellation
- disconnect cleanup

### 5. Copy source completion must still depend on destination forwarding progress

For remote copy, the source side must not get ahead of the destination side by turning routing into a fire-and-forget operation. The current chunk-level completion loop must be preserved.

## Current Problem Areas

The file naturally breaks into these domains:

- shared router state and helper types: `src/actors/router.rs:28-191`
- message definitions: `src/actors/router.rs:192-322`
- websocket send helpers: `src/actors/router.rs:324-394`
- transfer progress bookkeeping: `src/actors/router.rs:396-610`, `1012-1016`
- copy routing and copy completion: `src/actors/router.rs:613-1010`
- UI subscriber refresh throttling: `src/actors/router.rs:1018-1078`
- direct download routing: `src/actors/router.rs:1080-1284`
- direct upload routing: `src/actors/router.rs:1286-1441`
- disconnect cleanup and cancel handling: `src/actors/router.rs:1443-1597`
- top-level dispatch: `src/actors/router.rs:1600-2258`

Two structural issues are especially worth fixing while splitting the file:

### Overloaded `transfers` map

`state.transfers` currently stores several different things:

- real REST download streams
- real REST upload streams
- remote copy source bookkeeping using a dummy sender
- remote copy destination bookkeeping using `completion_sender: None`
- local copy bookkeeping using `completion_sender: None`

That makes the state harder to understand and forces several branches to reject impossible combinations at runtime.

### Large router messages with many fields

Several `RouterMsg` variants currently carry many individual fields, which increases call-site noise and makes refactors harder.

Examples:

- `RegisterAgent`
- `ExecuteStreamCommandRest`
- `StartUploadStreamRest`
- `StartCopyRest`
- `FinishRoutedDownloadChunk`
- `FinishRoutedUploadChunk`
- `FinishRoutedCopyChunk`

## Target Module Layout

Turn `src/actors/router.rs` into a directory-backed module:

```text
src/actors/router/
  mod.rs
  messages.rs
  state.rs
  agents.rs
  progress.rs
  ui.rs
  cleanup.rs
  transfers/
    mod.rs
    download.rs
    upload.rs
    copy.rs
```

### `mod.rs`

Responsibilities:

- define the router entry type
- own the `impl Actor for RouterActor`
- keep `pre_start()` and `post_stop()`
- keep a thin `handle()` that dispatches to domain modules
- re-export public router types needed elsewhere in the crate

Expected size goal:

- mostly wiring and dispatch
- no large domain-specific helper bodies

### `messages.rs`

Responsibilities:

- define `RouterMsg`
- define small payload structs used by message variants with many fields

Suggested payload structs:

- `RegisterAgentRequest`
- `ExecuteCommandRequest`
- `ExecuteStreamRequest`
- `StartUploadRequest`
- `StartCopyRequest`
- `FinishDownloadChunkRoute`
- `FinishUploadChunkRoute`
- `FinishCopyChunkRoute`

Suggested enum style:

```rust
pub enum RouterMsg {
    RegisterAgent(RegisterAgentRequest),
    ExecuteCommandRest(ExecuteCommandRequest),
    ExecuteStreamCommandRest(ExecuteStreamRequest),
    StartUploadStreamRest(StartUploadRequest),
    StartCopyRest(StartCopyRequest),
    FinishRoutedDownloadChunk(FinishDownloadChunkRoute),
    FinishRoutedUploadChunk(FinishUploadChunkRoute),
    FinishRoutedCopyChunk(FinishCopyChunkRoute),
    // ...
}
```

This is still an internal API, so the change is mechanical.

### `state.rs`

Responsibilities:

- define `RouterState`
- define domain-specific state wrapper types
- define `AgentInfo`
- define copy-related state types
- keep `next_id()`

Recommended state split inside `RouterState`:

```rust
pub struct RouterState {
    agents: AgentRegistry,
    pending_rest: PendingRestReplies,
    streams: StreamTransferRegistry,
    copies: CopyRegistry,
    progress: TransferProgressStore,
    ui: UiState,
    next_request_id: RequestId,
}
```

Recommended internal wrapper types:

- `AgentRegistry`
- `PendingRestReplies`
- `StreamTransferRegistry`
- `CopyRegistry`
- `TransferProgressStore`
- `UiState`

The main goal is to make each map mean one thing.

### `agents.rs`

Responsibilities:

- register and unregister agents
- validate duplicate names
- send text control messages
- send binary frames
- handle one-shot REST command execution
- build the agent list response

Helpers to move here:

- `send_agent_message`
- `send_agent_binary`
- register handler
- unregister helper for agent registry changes only
- one-shot command execution helper

### `progress.rs`

Responsibilities:

- create progress entries
- increment transferred byte counts
- mark transfers completed or errored
- list progress entries in sorted order

Move here:

- `record_download_start`
- `record_upload_start`
- `record_copy_start`
- `increment_download_progress`
- `increment_upload_progress`
- `mark_transfer_completed`
- `mark_copy_transfer_completed`
- `mark_transfer_errored`
- `list_transfer_progress`

Recommended cleanup:

- unify `increment_download_progress` and `increment_upload_progress` into one generic byte increment helper on the store
- keep copy-specific completion helper if needed because it may update `total_bytes`

### `ui.rs`

Responsibilities:

- manage subscriber registration
- manage throttled refresh logic
- broadcast refresh events

Move here:

- `UI_REFRESH_THROTTLE_WINDOW`
- `UI_REFRESH_CHECK_INTERVAL`
- `notify_ui_refresh`
- `check_pending_ui_refresh`
- `broadcast_ui_event`

Recommended type:

```rust
pub struct UiState {
    subscribers: HashMap<String, tokio::sync::mpsc::UnboundedSender<UiEvent>>,
    last_refresh_sent_at: Option<Instant>,
    refresh_pending: bool,
    refresh_check_task: tokio::task::JoinHandle<()>,
}
```

### `cleanup.rs`

Responsibilities:

- clean up state associated with a disconnected agent
- route disconnect errors into pending replies and progress state
- centralize cancel/error/cleanup ordering

Move here:

- `cleanup_agent_requests`
- `cancel_transfer`

### `transfers/download.rs`

Responsibilities:

- start direct download bookkeeping
- route direct download chunks to REST consumers
- finish direct download chunk forwarding
- handle client-side receiver closure and agent cancellation

Move here:

- direct download start handling from `ExecuteStreamCommandRest`
- `route_download_chunk`
- `finish_routed_download_chunk`

### `transfers/upload.rs`

Responsibilities:

- start direct upload bookkeeping
- forward upload chunks to the destination websocket binary lane
- finish upload chunk forwarding
- finish upload transfer on final command response

Move here:

- direct upload start handling from `StartUploadStreamRest`
- `finish_routed_upload_chunk`
- `finish_upload_transfer`
- the upload-specific part of `SendStreamChunkToAgent`

### `transfers/copy.rs`

Responsibilities:

- start local or remote copy bookkeeping
- route remote copy chunks
- validate copy source and destination identity
- track `next_chunk_index`
- finish copy on final response
- update copy progress for local copy progress events
- clean up copy tracking

Move here:

- `CopyContentKind`
- `CopyExecution`
- `CopyRequest`
- `cleanup_copy_tracking`
- `abort_copy_upload`
- `route_copy_chunk`
- `finish_routed_copy_chunk`
- `finish_copy_transfer`
- `update_copy_progress`
- the copy-specific part of `StartCopyRest`

## Data Model Changes

The module split alone will help, but the biggest readability win comes from separating state by meaning.

### Replace `TransferRequest` with narrower direct-stream state

Current `TransferRequest` mixes two very different things:

- download stream state
- upload stream state

Recommended replacement:

```rust
pub struct DirectDownload {
    pub agent_id: String,
    pub chunk_sender: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
    pub canceled_by_rest: bool,
}

pub struct DirectUpload {
    pub agent_id: String,
    pub completion_sender: Option<tokio::sync::oneshot::Sender<Result<CommandResult, String>>>,
}

pub struct StreamTransferRegistry {
    pub downloads: HashMap<RequestId, DirectDownload>,
    pub uploads: HashMap<RequestId, DirectUpload>,
}
```

This removes the need for runtime branches like "received a download completion for an upload transfer" in many places.

### Give copy its own registry

Recommended shape:

```rust
pub struct CopyRegistry {
    pub by_public_id: HashMap<TransferId, CopyRequest>,
    pub public_id_by_internal_request: HashMap<RequestId, TransferId>,
}
```

This lets copy bookkeeping stand on its own instead of pretending to be part of direct upload/download state.

### Introduce small context structs to shrink argument lists

Functions that currently take many arguments should be changed to take one request-specific context struct.

Recommended examples:

```rust
pub struct DownloadStartContext {
    pub request_id: RequestId,
    pub agent_id: String,
    pub path: String,
    pub total_bytes: u64,
    pub chunk_sender: tokio::sync::mpsc::Sender<crate::streaming::StreamChunk>,
}

pub struct UploadStartContext {
    pub request_id: RequestId,
    pub agent_id: String,
    pub path: String,
    pub total_bytes: u64,
    pub completion_sender: tokio::sync::oneshot::Sender<Result<CommandResult, String>>,
}

pub struct CopyEndpoints {
    pub source_agent_id: String,
    pub source_path: String,
    pub dest_agent_id: String,
    pub dest_path: String,
}
```

These can be passed through the router modules and also make tests cleaner.

## Detailed Refactor Sequence

The refactor should be done in small behavior-preserving steps.

### Phase 1. Convert `router.rs` into a directory-backed module

Actions:

- create `src/actors/router/mod.rs`
- move the existing contents there first with minimal edits
- update `src/actors/mod.rs` only if needed by the compiler

Goal:

- no logic changes yet
- only establish the module structure needed for later extraction

Verification:

- compile
- run the existing router test

### Phase 2. Extract `messages.rs` and payload structs

Actions:

- move `RouterMsg` into `messages.rs`
- replace long enum variants with small payload structs
- update `main.rs`, `session.rs`, and router internal call sites mechanically

Goal:

- reduce call-site noise
- reduce future edit risk when fields change

Verification:

- compile
- ensure all RPC call sites still behave the same

### Phase 3. Extract `state.rs` and wrap the maps

Actions:

- move `RouterState`, `AgentInfo`, copy state types, and stream state types into `state.rs`
- introduce wrapper structs around the major maps without changing behavior yet
- keep method names close to the current ones during this phase

Goal:

- make the main state layout understandable from one file
- stop using raw `HashMap` fields directly everywhere

Verification:

- compile
- existing tests unchanged

### Phase 4. Extract `ui.rs`

Actions:

- move subscriber registration, event fanout, throttle window constants, and refresh checks into `ui.rs`
- move the periodic refresh task ownership into `UiState`

Goal:

- remove unrelated timing logic from the transfer-heavy parts of the router

Unit tests to add:

- first refresh sends immediately
- repeated refresh within the throttle window only marks pending
- periodic check emits the trailing refresh after the window
- closed subscriber is removed during broadcast

Verification:

- compile
- unit tests for the throttle logic

### Phase 5. Extract `progress.rs`

Actions:

- move all transfer progress creation and mutation into `TransferProgressStore`
- replace repeated "get mutable entry, update, notify" patterns with store methods

Goal:

- keep progress mutations in one place
- make sorting and completion behavior explicit and testable

Unit tests to add:

- download start creates expected entry
- upload start creates expected entry
- copy start creates expected entry with source and dest fields
- byte increment saturates and clears stale error field
- completion sets end time and final byte count correctly
- error stores message and end time
- listing sorts newest request first

Verification:

- compile
- unit tests

### Phase 6. Extract direct download flow into `transfers/download.rs`

Actions:

- move the direct-download part of `ExecuteStreamCommandRest`
- move `route_download_chunk`
- move `finish_routed_download_chunk`
- move direct-download lookup helpers into `StreamTransferRegistry`

Goal:

- isolate the direct download state machine
- keep current cancellation and acknowledgement ordering exactly the same

Important checks:

- `chunk_sender.send(chunk).await` must still happen in the spawned task
- router reply must still be sent only after the send finishes
- receiver closure must still trigger cancel to the agent

Tests to keep or add:

- direct download chunk routes to the REST stream
- REST stream receiver closure cancels the agent-side transfer
- a blocked download receiver does not block unrelated router work

### Phase 7. Extract direct upload flow into `transfers/upload.rs`

Actions:

- move the direct-upload part of `StartUploadStreamRest`
- move upload chunk forwarding from `SendStreamChunkToAgent`
- move `finish_routed_upload_chunk`
- move `finish_upload_transfer`

Goal:

- isolate the direct upload state machine
- preserve binary-lane backpressure exactly

Important checks:

- `send_agent_binary(...).await` must still happen in the spawned task
- upload progress must only advance after successful downstream acceptance
- final command response handling must still remove transfer state and notify completion sender

Tests to keep or add:

- existing `slow_upload_send_does_not_block_unrelated_router_work`
- upload send failure marks progress errored and completes the oneshot with error
- unexpected final response type marks transfer errored

### Phase 8. Extract copy flow into `transfers/copy.rs`

Actions:

- move all copy state and helpers into `copy.rs`
- move the copy-specific part of `StartCopyRest`
- move `route_copy_chunk`
- move `finish_routed_copy_chunk`
- move `finish_copy_transfer`
- move `update_copy_progress`
- move `cleanup_copy_tracking`

Goal:

- isolate the most complex state machine in the file
- remove copy bookkeeping from the direct upload/download registry

Recommended cleanup in this phase:

- stop storing copy source and destination pseudo-transfers in `state.transfers`
- keep copy state in `CopyRegistry` only
- add explicit helper methods for common validations:
    - source request lookup by internal request id
    - destination request lookup by public copy id
    - source agent validation
    - payload kind validation

Unit tests to add:

- local copy setup creates expected copy state
- remote copy setup creates expected source and destination request ids
- copy payload kind mismatch marks transfer errored
- source agent mismatch is ignored and logged
- failed destination forwarding marks transfer errored and triggers source cancellation
- copy completion accepts only the expected final response for the copy kind
- local copy progress update is applied only for the expected request id and agent id

Integration tests to add if feasible:

- remote copy with a blocked destination binary lane does not block unrelated router work
- remote copy does not acknowledge source chunks before destination queue acceptance

### Phase 9. Extract `agents.rs` and `cleanup.rs`

Actions:

- move register/list/one-shot-command logic into `agents.rs`
- move disconnect cleanup and direct cancel handling into `cleanup.rs`

Goal:

- leave `mod.rs` mostly as dispatch and lifecycle wiring

Tests to add:

- duplicate registration name is rejected
- pending one-shot request is completed with disconnect error
- upload and download cleanup after disconnect mark progress errored
- copy cleanup after disconnect marks progress errored and removes bookkeeping

### Phase 10. Reduce duplication and finalize interfaces

Actions:

- simplify repeated validation patterns into small registry/store methods
- rename helpers for clarity once the modules are stable
- move the test module to the most appropriate file or split it across modules

Goal:

- achieve the final shape without changing behavior
- ensure each file has a clear ownership boundary

## Proposed End State For `handle()`

After extraction, `handle()` should read like a dispatcher instead of a second implementation file.

Rough shape:

```rust
match message {
    RouterMsg::RegisterAgent(request) => agents::register(state, request),
    RouterMsg::UnregisterAgent { agent_id } => cleanup::unregister_and_cleanup(state, &myself, &agent_id).await,
    RouterMsg::ExecuteCommandRest(request) => agents::execute_command_rest(state, request),
    RouterMsg::ExecuteStreamCommandRest(request) => transfers::download::start(state, &myself, request),
    RouterMsg::StartUploadStreamRest(request) => transfers::upload::start(state, &myself, request),
    RouterMsg::SendStreamChunkToAgent(request) => transfers::upload::route_chunk(state, &myself, request),
    RouterMsg::RouteStreamChunk(request) => transfers::route_incoming_stream_chunk(state, &myself, request),
    RouterMsg::StartCopyRest(request) => transfers::copy::start(state, &myself, request),
    RouterMsg::TransferProgressUpdate(request) => transfers::copy::update_progress(state, &myself, request),
    RouterMsg::GetTransferProgress { reply } => reply_progress(state, reply),
    RouterMsg::RegisterUiSubscriber(request) => ui::register_subscriber(state, request),
    RouterMsg::UnregisterUiSubscriber { subscriber_id } => ui::unregister_subscriber(state, &subscriber_id),
    RouterMsg::CheckPendingUiRefresh => ui::check_pending_refresh(state),
    // ...
}
```

This should be the readability benchmark for the final result.

## Unit-Test Opportunities

The following code should become straightforward to unit-test once extracted:

- `TransferProgressStore`
- UI refresh throttle logic
- copy request bookkeeping and validation helpers
- `CopyContentKind` command/result mapping
- disconnect cleanup bookkeeping

Prefer unit tests for pure state transitions and small registry methods. Keep end-to-end streaming behavior in async integration-style tests.

## Integration Tests To Preserve Or Add

Keep:

- `slow_upload_send_does_not_block_unrelated_router_work`

Add:

- `slow_download_send_does_not_block_unrelated_router_work`
- `remote_copy_destination_backpressure_does_not_block_unrelated_router_work`
- `disconnect_cleans_up_pending_upload_and_download_state`
- `copy_cleanup_on_disconnect_marks_progress_errored`

Per repo guidance, test assertions should include comments explaining why the assertion exists.

## Verification Checklist Per Phase

After each phase:

1. `cargo test` for the affected Rust tests
2. `./scripts/build-and-test`

If a failure appears in integration tests, inspect `./log` before changing behavior.

## Acceptance Criteria

The refactor is complete when all of the following are true:

- `src/actors/router/mod.rs` is mostly lifecycle and dispatch glue.
- transfer domains live in separate focused files.
- copy bookkeeping no longer relies on placeholder transfer entries.
- long helper parameter lists are replaced with small context structs.
- direct upload, direct download, and copy flows preserve the same downstream acknowledgement ordering as today.
- no path materializes full file or tar contents in memory.
- existing behavior and protocol semantics remain unchanged.
- unit tests cover the extracted stateful helpers.
- async tests cover at least one blocked upload, one blocked download, and one blocked remote copy path.
- `./scripts/build-and-test` passes.

## Explicit Non-Goals

- changing websocket frame format
- changing REST endpoints
- changing command/result enum behavior
- merging upload, download, and copy into one generic abstraction too early
- performing broad cleanup unrelated to the router split

## Recommended Implementation Style

- Start with pure code motion where possible.
- Keep helper names close to the current code until the move is stable.
- Introduce wrapper types before changing internal algorithms.
- Prefer moving one domain at a time and re-running tests after each move.
- Avoid opportunistic behavioral cleanup in the same step as module extraction.

This should keep the refactor reviewable and make any regression easier to localize.
