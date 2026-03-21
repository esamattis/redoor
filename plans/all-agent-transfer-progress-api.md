# All-Agent Transfer Progress API

## Overview

Add one server-owned REST endpoint that returns raw upload and download progress for every agent without querying agents at read time. The progress state lives in the main server process, is updated as bytes pass through the existing transfer pipeline, and remains queryable after a transfer finishes. Completed transfers report `transferred_bytes == total_bytes`; errored transfers keep the last transferred byte count.

This plan uses the existing `RouterActor` as the source of truth instead of adding a new actor. That is the simplest fit for the current architecture because the router already:

- starts upload and download transfers
- routes all download chunks coming back from agents
- forwards all upload chunks from HTTP to agents
- receives upload completion and error responses
- handles agent disconnect cleanup

## Endpoint Shape

Add a new endpoint outside the per-agent namespace so one call can return progress across all connected and previously completed transfers:

- `GET /api/v1/transfers/progress`

Return one exported response type from `src/commands.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferProgressListResponse {
    pub transfers: Vec<TransferProgressEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferProgressEntry {
    pub request_id: u64,
    pub agent_id: String,
    pub path: String,
    pub direction: TransferDirection,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub state: TransferProgressState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TransferProgressState {
    Active,
    Errored,
    Completed,
}
```

Notes:

- `TransferProgressState` becomes the TS union the UI/tests need: `"active" | "errored" | "completed"`.
- `direction` is needed because one endpoint returns both uploads and downloads.
- `request_id` gives each transfer a stable identifier even when the same agent/path is used multiple times.
- `error` is optional but useful for errored rows and does not require callers to infer failure cause from missing data.

## Why RouterActor Is Enough

No new actor is needed for this implementation.

- Download totals are already known in `src/main.rs` before the stream starts because metadata and range handling compute the exact byte count for the transfer.
- Download progress can be updated in `src/actors/router.rs` every time `RouteStreamChunk` arrives.
- Upload progress can be updated in `src/actors/router.rs` every time the server forwards a `StreamChunk` to the agent.
- Upload completion and upload errors already flow back through `RouteResponse`.
- Agent disconnects already trigger cleanup in the router, which is the correct place to mark active transfers as errored instead of deleting their progress record.

This keeps the progress registry fully server-side and avoids any extra round-trips to agents when the new REST endpoint is called.

## Files To Change

- `src/commands.rs`
- `src/actors/router.rs`
- `src/main.rs`
- `ui/src/api-client.ts`
- `tests/raw-upload.test.ts`
- `tests/raw-download.test.ts`
- `tests/test-utils.ts` (only if extracting a reusable polling helper makes the tests clearer)
- `bindings/*` via `scripts/generate-ts-bindings`

## Implementation Steps

### 1. Add exported REST response types

In `src/commands.rs`:

- add `TransferProgressListResponse`
- add `TransferProgressEntry`
- add `TransferDirection`
- add `TransferProgressState`
- derive `TS` and `#[ts(export)]` on all new exported REST-facing types
- use `#[serde(rename_all = "snake_case")]` on the enums so the generated TS types line up with the requested values

Keep these as REST response types only; they do not need new agent `Command` or `CommandResult` variants because the progress data is owned by the server.

### 2. Add a retained progress registry to the router

In `src/actors/router.rs`:

- add a new `transfer_progress: HashMap<u64, TransferProgressEntry>` to `RouterState`
- keep the existing `transfers: HashMap<u64, TransferRequest>` for active stream routing only
- retain completed and errored entries in `transfer_progress` after removing the active routing entry from `transfers`

Recommended helper methods on `RouterActor`:

- `record_download_start(...)`
- `record_upload_start(...)`
- `increment_download_progress(...)`
- `increment_upload_progress(...)`
- `mark_transfer_completed(request_id)`
- `mark_transfer_errored(request_id, error_message)`
- `list_transfer_progress()`

Make `mark_transfer_completed` force `transferred_bytes = total_bytes` so completed transfers always report 100% exactly, even if the last event was a terminal empty chunk.

### 3. Extend router messages so the router has enough context

Add a new query message:

```rust
GetTransferProgress {
    reply: RpcReplyPort<TransferProgressListResponse>,
}
```

Extend the transfer-start messages so the router can create a full progress row at the start of the transfer:

- `ExecuteStreamCommandRest` should also carry `path` and `total_bytes`
- `StartUploadStreamRest` should also carry `path` and `total_bytes`

Change `SendStreamChunkToAgent` to carry a parsed `StreamChunk` instead of only serialized bytes. That lets the router update upload progress from the real chunk payload before serializing it for the websocket session.

Recommended shape:

```rust
SendStreamChunkToAgent {
    agent_id: String,
    request_id: u64,
    chunk: crate::streaming::StreamChunk,
    reply: RpcReplyPort<Result<(), String>>,
}
```

The router can then serialize with `chunk.to_bytes()` only at the moment it forwards the data to `SessionMsg::OutgoingBinary`.

### 4. Record download progress in the router

When `ExecuteStreamCommandRest` succeeds:

- create the active `TransferRequest::Download`
- create a `TransferProgressEntry` with:
    - `direction = Download`
    - `state = Active`
    - `transferred_bytes = 0`
    - `total_bytes = content_length` from the HTTP handler
    - `path` from the handler

When `RouteStreamChunk` arrives:

- increment `transferred_bytes` by `chunk.data.len()` for normal chunks
- if `chunk.is_error`, mark the transfer `Errored` and keep the last transferred count
- if `chunk.is_last` and not error, mark the transfer `Completed`
- remove the active routing entry from `transfers` on terminal chunks, but keep the `transfer_progress` entry

This works for full downloads and range downloads because the handler already computes the exact number of bytes the transfer should deliver.

### 5. Record upload progress in the router

When `StartUploadStreamRest` succeeds:

- create the active `TransferRequest::Upload`
- create a `TransferProgressEntry` with:
    - `direction = Upload`
    - `state = Active`
    - `transferred_bytes = 0`
    - `total_bytes` resolved before streaming starts
    - resolved absolute `path`

When `SendStreamChunkToAgent` forwards a normal chunk:

- increment `transferred_bytes` by `chunk.data.len()`
- do not mark completed when forwarding the final empty chunk; completion should still be driven by the agent's explicit `CommandResult::RawUpload` ack so the server only reports `Completed` after the file has been flushed on the agent side

When `SendStreamChunkToAgent` forwards an error chunk caused by request-body failure:

- mark the upload as `Errored`
- preserve the transferred count accumulated before the failure

When `RouteResponse` resolves an upload with `CommandResult::RawUpload`:

- mark the progress row `Completed`
- force `transferred_bytes = total_bytes`

When `RouteResponse` resolves an upload with `CommandResult::Error { message }`:

- mark the progress row `Errored`
- set `error = Some(message)`

### 6. Mark active transfers errored on disconnect instead of dropping them

Update `cleanup_agent_requests` in `src/actors/router.rs` so that when an agent disconnects:

- active download progress rows become `Errored` with an `Agent disconnected: ...` message
- active upload progress rows become `Errored` with the same message
- the active routing entries are still removed from `transfers`
- the retained `transfer_progress` rows stay queryable

That change is what makes the new endpoint keep showing failures after the transfer path is torn down.

### 7. Add the aggregated REST endpoint

In `src/main.rs`:

- add `.route("/api/v1/transfers/progress", get(list_transfer_progress_handler))`
- implement `list_transfer_progress_handler`
- have it call `RouterMsg::GetTransferProgress`
- return `StatusCode::OK` with `Json(TransferProgressListResponse)`

For deterministic responses, have the router snapshot sort transfers before returning them. Sorting by descending `request_id` is enough and makes tests easier to write.

### 8. Pass total byte counts into the router at transfer start

For downloads in `src/main.rs`:

- reuse the already computed `content_length` from the metadata/range logic
- pass that exact number to `ExecuteStreamCommandRest`
- pass the transfer `path` too

For uploads in `src/main.rs`:

- resolve `total_bytes` before consuming the request body
- prefer `Content-Length` from the request headers
- if needed, fall back to an exact body size hint when available
- if neither source yields an exact size, return a request error before creating the tracked upload so the server never reports a bogus `total_bytes`

Then:

- pass `path` and `total_bytes` to `StartUploadStreamRest`
- send structured `StreamChunk` values to the router instead of pre-serialized bytes
- keep the current upload completion response behavior, but let the router own the persistent progress state

### 9. Add the API client method

In `ui/src/api-client.ts`:

- import the generated types from `bindings`
- add a new `ApiClient` method such as `getTransferProgress()`
- implement it with the existing `apiRequest<T>()` helper against `/api/v1/transfers/progress`
- export any useful transfer-progress types from the client module for tests and UI callers

This belongs on `ApiClient`, not `Agent`, because the endpoint aggregates transfers across all agents.

### 10. Regenerate bindings

Run:

```sh
./scripts/generate-ts-bindings
```

Expected new binding files include the response struct and enums for transfer progress.

## Test Plan

Add coverage to both transfer integration test files, using the new `ApiClient.getTransferProgress()` method.

### Upload test additions in `tests/raw-upload.test.ts`

Add one controlled upload-progress test that covers `active` and `completed`.

Recommended structure:

1. create a target file path and two known chunks
2. start a `fetch()` `PUT` request directly against `testAgent.getRawUrl(path)` using a `ReadableStream`
3. set a known `Content-Length` equal to the combined chunk size
4. enqueue only the first chunk initially, leaving the stream open
5. poll `apiClient.getTransferProgress()` until the matching row appears with:
    - the correct `agent_id`
    - `direction === "upload"`
    - `state === "active"`
    - `total_bytes === full_size`
    - `transferred_bytes === first_chunk_size`
6. enqueue the remaining bytes and close the stream
7. await the upload response
8. poll until the same row reports:
    - `state === "completed"`
    - `transferred_bytes === total_bytes === full_size`
9. read the uploaded file back to confirm the progress row corresponds to a real successful upload

Why direct `fetch()` instead of `Agent.upload()` for this test:

- `Agent.upload()` completes too quickly and does not expose chunk-by-chunk control
- the controlled stream makes the `active` assertion deterministic without sleeps

### Download test additions in `tests/raw-download.test.ts`

Add one download-progress test that covers `active` and `errored`.

Recommended structure:

1. create a large test file
2. spawn a second ephemeral agent, following the same pattern already used in the disconnect test
3. start a raw download with `fetch(ephemeralAgent.getRawUrl(path))` and keep the promise alive
4. poll `apiClient.getTransferProgress()` until the matching row appears with:
    - `direction === "download"`
    - `state === "active"`
    - `total_bytes === file_size`
    - `transferred_bytes > 0`
5. wait for the agent log showing `command=RawDownload` so the kill happens during a real transfer
6. kill the agent
7. await the download outcome, asserting it does not hang
8. poll until the same row reports:
    - `state === "errored"`
    - `transferred_bytes < total_bytes`
    - an error message mentioning the disconnect or stream failure

This reuses an existing reliable failure scenario instead of inventing a new one.

### Test helper option

If the polling logic becomes repetitive, add a small helper in `tests/test-utils.ts` that repeatedly calls an async predicate until it returns a value or times out. Use API polling rather than sleeps so the tests follow the repository rule for asynchronous waiting.

All new assertions should include short comments explaining why the check exists.

## Validation

After implementation:

```sh
./scripts/generate-ts-bindings
./scripts/build-and-test
```

## Expected End State

After this work:

- one `GET /api/v1/transfers/progress` endpoint returns upload and download progress for all agents
- the response is served entirely from server memory
- no agent query is needed when reading progress
- active, completed, and errored states are exposed as generated TS unions
- completed transfers remain visible and report `transferred_bytes == total_bytes`
- upload and download integration tests verify the new endpoint against real transfer flows
