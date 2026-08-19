# General Architecture Review

## Scope And Method

This is a read-only architecture review of the Redoor repository as of 2026-08-19. It covers the Rust server, agent, shared protocol/router library, generated TypeScript bindings, UI API client, and representative unit and integration tests. The review concentrates on correctness and evolution risk in module boundaries, lifecycle/protocol ownership, type-level invariants, concurrency, REST organization, and server/agent/UI contracts.

No application code was changed and no test suite was run. Findings are based on static tracing of the relevant control, transfer, persistence, and UI paths. Each finding is labeled either:

- **Confirmed correctness defect**: the current code admits a concrete incorrect execution without requiring a hypothetical future change.
- **Design risk**: the current design has a concrete missing invariant or duplicated responsibility that makes a future defect or operational failure materially likely, but no normal-path failure was proven from the static review alone.

## Architecture Overview

Redoor is one Rust package producing a single binary with two long-lived roles:

- The **server** hosts Axum REST and WebSocket routes, browser authentication, managed-agent supervisors, persistent configuration edits, and the embedded TanStack Router UI.
- The **agent** connects to the server and executes filesystem, process, terminal, log, and transfer operations.
- The shared library contains the **router actor**, wire messages, command/result types, stream framing, terminal/log protocols, and rendezvous registries.
- The **UI** uses generated `ts-rs` data shapes through `ui/src/api-client.ts`, TanStack Router loaders, TanStack Query, and typed WebSocket event parsing.

The principal runtime topology is:

1. An agent authenticates and registers over a control WebSocket (`/ws`).
2. The server's single-owner router actor stores live connections, known-agent inventory, pending command replies, transfer state, progress, and UI subscribers.
3. A second persistent agent WebSocket carries bounded binary transfer frames. Terminal and agent-log sessions use separate ephemeral WebSockets paired through one-time tokens.
4. Managed local and SSH agents are represented both by watchdog supervisors and router inventory records.
5. REST handlers translate browser operations into router messages and then manually map `CommandResult` variants to endpoint-specific responses.

Several foundations are strong and worth preserving:

- The binary data lane is separated from control traffic and generally uses bounded queues with explicit backpressure (`src/transfer_protocol.rs:10-16`, `src/server/agent_transfers.rs:127-160`).
- The router actor gives correlated routing state a clear single owner (`src/actors/router/mod.rs:178-332`).
- Socket generations and IDs protect many replacement and delayed-teardown paths (`src/agent/actor.rs:113-115`, `src/agent/actor.rs:149-158`, `src/actors/router/agents.rs:381-417`).
- Upload readiness is an explicit cross-socket barrier (`src/actors/router/messages.rs:249-281`, `src/actors/router/transfers/upload.rs:84-109`).
- Terminal sizes, command error categories, copy source identity, and many REST response shapes already encode useful invariants (`src/terminal_protocol.rs:35-65`, `src/commands.rs:398-416`, `src/commands.rs:470-498`).
- Generated TypeScript response types and runtime Zod checks for WebSocket events reduce some cross-language drift (`ui/src/api-client.ts:1-59`, `ui/src/refresh-listener.ts:8-14`, `ui/src/components/log-viewer.tsx:13-26`).

The main architectural weakness is that these strong local mechanisms are not consistently applied to the complete lifecycle. Some critical transitions are still best-effort, some identity and readiness relationships are represented as independent fields, and several data/error paths bypass the bounded or typed boundaries established elsewhere.

## Findings

### High 1: The Control Plane Still Carries Unbounded Directory Payloads

**Classification:** Confirmed correctness defect.

**Evidence:**

- `ls` accumulates every directory entry into a `Vec` and returns it as one command response (`src/commands/handler.rs:173-220`, `src/commands/handler.rs:233-241`).
- Those results are serialized as one control `CommandResponse` (`src/agent/protocol.rs:227-244`).
- The same control plane also lets the server queue outbound commands in an unbounded channel (`src/actors/router/state.rs:24-38`, `src/actors/session.rs:47-49`, `src/actors/session.rs:281-285`), so neither direction has a protocol-wide small-message invariant.
- By contrast, the repository's intended large-payload boundary is a 64 KiB framed, bounded transfer lane (`src/streaming.rs:6-10`, `src/transfer_protocol.rs:15-16`).

**Consequence:** A directory with a very large entry count can allocate the complete result on the agent, allocate it again during JSON serialization and WebSocket handling, and occupy the control socket with one large frame. Independently, requests headed toward a slow agent can accumulate in the unbounded server-side control queue. This violates the repository's memory-restraint and control-responsiveness architecture. It can cause process memory exhaustion, control socket failure due to message limits, or starvation of lifecycle traffic.

**Missing invariant or boundary:** The control protocol lacks a mechanically enforced rule that every control message has a small bounded size. Unbounded collections are not confined to a bounded or paginated response model.

**Incremental fix:** Add pagination or an explicit maximum plus continuation token to `Ls`; do not return an unbounded directory in one control response. Finally, set an explicit small maximum control WebSocket message size on both peers so violations fail at the boundary rather than after large allocations.

### High 2: A Control Socket Is Not Bound To One Registered Agent Identity

**Classification:** Confirmed correctness defect.

**Evidence:**

- Session state stores `agent_id` as an `Option`, but registration is accepted whenever another `AgentRegister` frame arrives; there is no unregistered/registered phase check (`src/actors/session.rs:35-58`, `src/actors/session.rs:68-154`). A second registration overwrites `self.agent_id` at line 153.
- Shutdown unregisters only the last ID stored in the session (`src/actors/session.rs:220-230`). A prior ID registered by the same socket can therefore remain in router inventory with a dead receiver.
- After registration, `TransferReady`, `CommandResponse`, `TransferProgressUpdate`, and `AgentUnregister` continue to trust the `agent_id` carried inside each frame instead of deriving it from the authenticated session (`src/actors/session.rs:155-215`).
- `route_response` removes a pending REST request by globally allocated `request_id` before checking that `response.agent_id` equals the stored owner (`src/actors/router/mod.rs:123-149`).
- Request IDs are predictable process-wide counters (`src/actors/router/state.rs:307-308`, `src/actors/router/state.rs:336-340`).
- Managed ownership is looked up using `agent_name`, while routing is keyed by independently supplied `agent_id` (`src/actors/session.rs:103-110`, `src/actors/router/agents.rs:208-217`). The protocol permits those values to differ even though normal agents construct both from the same name (`src/agent/actor.rs:429-437`).

**Consequence:** A valid-token but malformed, compromised, or incompatible agent can register multiple logical agents on one socket, leave an orphaned connected inventory row, report lifecycle events as another agent, or consume another agent's pending command response by sending its request ID. This is both a cross-agent integrity issue and a lifecycle leak. The shared agent token currently grants admission, but it should not make frame-supplied identities authoritative after admission.

**Missing invariant or boundary:** One authenticated control socket must transition exactly once from `Unregistered` to `Registered { agent_id, managed_owner }`; every later frame must be attributed to that bound identity. The stable routing ID, display name, and managed-supervisor key also need an explicit equality or mapping rule.

**Incremental fix:** Replace `agent_id: Option<AgentId>` with a session phase enum and reject/close on a second registration. Validate the registration identity rule once (the minimal current rule is `agent_id == AgentId::from(agent_name.clone())`). For post-registration messages, remove or ignore wire `agent_id` fields at the server session boundary and construct router messages with the bound ID. Before removing any pending reply, verify both request ID and bound agent identity. Add protocol tests using a raw WebSocket client that re-registers and sends another agent's response ID.

### High 3: Lossless Router Transitions Use A Best-Effort Mailbox API

**Classification:** Confirmed correctness defect under mailbox saturation.

**Evidence:**

- `RouterHandle::send` calls `try_send` and deliberately collapses both `Full` and `Closed` into the same error (`src/actors/router/mod.rs:47-53`).
- Registration uses that method, ignores its result, and still marks the session registered (`src/actors/session.rs:136-153`).
- Command responses, progress updates, explicit unregister, and disconnect cleanup also use it and ignore failure (`src/actors/session.rs:155-163`, `src/actors/session.rs:188-215`, `src/actors/session.rs:220-230`).
- Background transfer completion paths use the same best-effort send after bytes have already crossed the downstream boundary (`src/actors/router/transfers/upload.rs:186-205`, `src/actors/router/transfers/download.rs:177-196`, `src/actors/router/transfers/copy.rs:456-482`).
- The mailbox is bounded to 1024 messages (`src/actors/router/mod.rs:32-33`, `src/actors/router/mod.rs:95-108`), so `Full` is an expected overload state rather than an impossible condition.
- `TransferReady` already documents why dropping a lifecycle event is incorrect and uses `send_async` instead (`src/actors/session.rs:164-186`), but the same reasoning is not applied to registration, final responses, and teardown.

**Consequence:** Under load, an authenticated registration can be silently lost while the socket believes it is registered; a final command response can be dropped and leave REST pending until timeout; disconnect cleanup can be skipped and leave connected inventory or transfer state behind; and a transfer can deliver bytes but never commit its progress/terminal transition. Callers may receive errors describing a stopped router even though the router was merely busy.

**Missing invariant or boundary:** Lifecycle and completion messages require at-least-once enqueue semantics or explicit rejection before side effects. Only telemetry/coalescible refresh notifications may be lossy.

**Incremental fix:** Split the API by semantics instead of by convenience: expose awaited `send_control`/`request` for registration, response, completion, and teardown; reserve `try_send_coalesced` only for refresh/progress hints. Make session shutdown async so it can await unregister before dropping socket ownership. For `Drop`-initiated cancellation, use a separate cancellation token/registry or spawn a small awaited enqueue task rather than silently using `try_send`. Inject a small mailbox capacity in tests and deterministically saturate it to verify every lifecycle transition either commits or returns an explicit error.

### High 4: Tar Producer Failures Are Converted Into Successful Downloads

**Classification:** Confirmed correctness defect.

**Evidence:**

- Directory tar creation runs in `spawn_blocking`; any error from `write_directory_tar` is only logged (`src/agent/transfers/download.rs:433-451`).
- The async consumer interprets channel closure as normal EOF (`src/agent/transfers/download.rs:453-475`).
- It then emits the last buffered bytes, or an empty terminal chunk, with normal success semantics and logs completion (`src/agent/transfers/download.rs:496-511`).
- The server marks a download complete whenever it receives a non-error `is_last` chunk (`src/actors/router/transfers/download.rs:274-295`).
- Tar creation can fail after sending partial bytes, for example on an unreadable entry, a disappearing file, or an unsupported symlink/special entry (`src/agent/transfers/download.rs:82-129`).

**Consequence:** REST directory downloads can return HTTP 200 with a truncated/corrupt gzip-compressed tar while progress says `completed`. For cross-agent copies, the destination extractor may catch some truncation, but the source protocol still falsely claims success and error behavior depends on downstream tar parsing.

**Missing invariant or boundary:** The blocking producer's terminal `Result` is not part of the async stream state machine. Channel closure ambiguously means either successful completion or producer failure.

**Incremental fix:** Have the blocking task return or send a typed completion result. Emit a normal `is_last` frame only after `write_directory_tar` succeeds; on failure emit an `is_error` frame with a structured error category and clean up the active download. Add an integration test that makes a directory entry fail after at least one tar chunk has been produced and asserts a failed HTTP body/progress state rather than `completed`.

### High 5: One-Time Download Tokens Can Authorize Multiple Concurrent Full Downloads

**Classification:** Confirmed correctness defect.

**Evidence:**

- Authorization only calls `contains`, which does not consume or reserve the token (`src/server/raw.rs:106-124`, `src/one_time_token_registry.rs:59-66`).
- Consumption happens later from `Drop` after body delivery is recorded (`src/server/raw.rs:27-55`, `src/server/raw.rs:244-252`).
- Two concurrent requests can therefore both pass `contains` before either body guard drops, and both can receive the complete file.
- The registry's concurrency test only proves that one later `record_downloaded_range` call wins removal; it does not prevent both callers from receiving bytes (`src/one_time_token_registry.rs:186-214`).
- Unused tokens also have no TTL or global/per-path cap (`src/one_time_token_registry.rs:18-43`).

**Consequence:** The advertised one-time bearer credential is replayable during an overlap window. A recipient can intentionally start multiple downloads or race another consumer. Unused tokens can also accumulate for the process lifetime.

**Missing invariant or boundary:** Token state needs an atomic lifecycle such as `Available -> Leased(range/request) -> AvailableForResume | Complete | Expired`; authorization and lease acquisition cannot be separate operations.

**Incremental fix:** Replace `contains` with an atomic `acquire` that records an active lease before starting metadata/stream work. Permit retry/resume only according to an explicit lease release and covered-range policy, and reject overlapping active use. Add expiry and bounded retention. Test two requests synchronized before body consumption and assert that exactly one is authorized, not merely that exactly one removes the registry entry afterward.

### Medium 1: `Connected` Simultaneously Means Control-Live And Transfer-Ready

**Classification:** Confirmed correctness defect.

**Evidence:**

- Registration intentionally avoids `Connected` until the transfer socket is installed, stating that clients gate transfers on this status (`src/actors/router/agents.rs:116-119`, `src/actors/router/agents.rs:186-197`, `src/actors/router/agents.rs:365-378`).
- Transfer loss removes `connection.transfer` and cleans up payload work, but does not demote known-agent status (`src/actors/router/agents.rs:381-417`).
- Managed lifecycle projection explicitly preserves `Connected` once reached even when `transfer_ready` is false (`src/actors/router/agents.rs:487-501`).
- The UI treats `status === "connected"` as sufficient for browser, upload, and terminal affordances (`ui/src/routes/__root.tsx:179-193`, `ui/src/routes/__root.tsx:282-309`, `ui/src/routes/agents.$agentId.tsx:11-19`).

**Consequence:** During transfer reconnection, the public contract says an agent is ready even though new upload/download/copy starts return `TransferConnectionUnavailable`. The same enum is trying to represent process intent, control connectivity, and full data-plane readiness, so callers cannot distinguish a usable agent from a degraded one.

**Missing invariant or boundary:** Public readiness must be derived from orthogonal lifecycle facts, or represented by states that make degraded control-only connectivity explicit. `Connected` cannot both guarantee and not guarantee transfer availability.

**Incremental fix:** Introduce either a `Degraded`/`ControlConnected` public state or a separate generated `transfer_ready` capability, and derive it from live router state instead of storing a second mutable status copy. Keep watchdog process states (`stopped`, `starting`) separate from socket readiness. Update UI gating and add a transfer-socket interruption test that observes the interim public state before reconnection.

### Medium 2: REST Cancellation And Router Operation Lifetime Are Not Coupled

**Classification:** Confirmed retention behavior with broader design risk.

**Evidence:**

- `RouterHandle::request` applies a timeout only around the caller's one-shot receiver; timeout drops the receiver but sends no cancellation to the router (`src/actors/router/mod.rs:64-84`).
- A normal command stores its reply sender in `pending_rest` with no deadline or cancellation handle (`src/actors/router/state.rs:101-107`, `src/actors/router/agents.rs:558-578`).
- That state is removed only by a response or agent cleanup (`src/actors/router/mod.rs:123-150`, `src/actors/router/cleanup.rs:11-34`). A connected agent that never responds leaves the entry indefinitely even after the HTTP timeout.
- The agent spawns a detached task for every command, with no general concurrency cap or request cancellation; only file search has a specialized supersession signal (`src/agent/protocol.rs:263-327`, `src/agent/state.rs:351-352`, `src/agent/state.rs:384-397`).

**Consequence:** Timed-out or disconnected REST callers do not stop remote work. Pending sender entries and potentially expensive agent tasks can accumulate while the agent remains connected. Repeated requests can become an admission-control bypass and make later control commands less responsive.

**Missing invariant or boundary:** A routed operation lacks one owner-defined lifecycle covering `Queued -> Running -> Completed | Canceled | TimedOut`, with cancellation propagated to both router state and agent work.

**Incremental fix:** Add a router-side deadline/cancellation message for every command request, remove pending entries when the receiver closes or deadline expires, and introduce a general `CancelCommand { request_id }` protocol for cancellable work. Put a semaphore or bounded task set around agent command execution, with small lifecycle commands kept on a reserved path. Reuse the existing upload cancel-guard pattern rather than adding endpoint-specific timeout cleanup.

### Medium 3: Tar Upload Backpressure Blocks A Tokio Worker Thread

**Classification:** Confirmed concurrency defect.

**Evidence:**

- Tar extraction correctly runs in `spawn_blocking` and receives through a bounded `std::sync::mpsc::sync_channel` (`src/agent/transfers/upload.rs:149-171`).
- The async `TarUploadWorker::process` calls the synchronous blocking `SyncSender::send` directly (`src/agent/transfers/upload.rs:375-383`, `src/agent/transfers/upload.rs:435-443`).
- The destination unpacker can block on filesystem work while the queue is full, so this send can block a Tokio runtime worker for an unbounded period.

**Consequence:** Several slow tar uploads can occupy Tokio workers and delay control messages, reconnect handling, terminal/log tasks, and cancellation. The design preserves byte backpressure but applies it at the wrong scheduler boundary.

**Missing invariant or boundary:** Blocking adapters must never make a blocking wait from an async runtime worker. Backpressure crossing async/sync code needs an explicit bridge.

**Incremental fix:** Move the blocking send into `spawn_blocking`, or preferably use a Tokio bounded channel and an `AsyncRead`-to-blocking-reader bridge whose blocking side waits from the blocking pool. Preserve the current bounded capacity. Add a stress test with multiple deliberately slow extractors and assert a control command remains responsive.

### Medium 4: Completed Transfer History Is An Unbounded In-Memory Store

**Classification:** Design risk.

**Evidence:**

- `TransferProgressStore.entries` is a `HashMap` with no retention metadata or bound (`src/actors/router/state.rs:264-274`).
- Start paths insert a new entry for every transfer (`src/actors/router/progress.rs:64-137`, `src/actors/router/progress.rs:139-203`).
- Completion and error paths mutate entries but deliberately retain them (`src/actors/router/progress.rs:267-345`).
- The list endpoint clones and returns the complete map every time (`src/actors/router/progress.rs:356-360`, `src/server/transfers.rs:13-33`).

**Consequence:** A long-running server grows memory and response cost with every upload, download, copy, and move. UI polling then repeatedly serializes and parses the entire process-lifetime history. This conflicts with support for memory-restrained environments.

**Missing invariant or boundary:** Progress history has no ownership/retention policy separating active state from bounded historical observability.

**Incremental fix:** Keep active transfers in the current map and move terminal entries into a bounded newest-first history (count and/or age based). Return a bounded page from REST with a cursor if more history is needed. Ensure any resume lookup has its own short-lived index instead of relying on unlimited history (`src/actors/router/progress.rs:68-94`).

### Medium 5: Managed-Agent Persistence And Runtime Registration Are Not One Recoverable Transaction

**Classification:** Design risk with concrete partial-failure states.

**Evidence:**

- Create handlers append the TOML entry first and then register the supervisor/router inventory (`src/server/agent_configuration.rs:122-152`, `src/server/agent_configuration.rs:190-215`).
- `register_agent` spawns and stores the supervisor before requesting router inventory registration (`src/server/watchdog.rs:51-105`).
- If either runtime step fails or times out, create returns 500 but does not remove the newly persisted row or the already registered supervisor.
- Uniqueness checks inspect router inventory only (`src/server/agent_configuration.rs:540-557`), so a supervisor-only partial state is not detected consistently.
- Update paths contain explicit retry/reconciliation helpers (`src/server/agent_configuration.rs:333-467`), but create does not have equivalent staged cleanup.

**Consequence:** A transient router overload or task failure can leave TOML, watchdog registry, and router inventory disagreeing. The client sees a failed create, retry behavior becomes ambiguous, and a restart may materialize an entry that the failed response implied was not created.

**Missing invariant or boundary:** Durable configuration, supervisor ownership, and router inventory are three projections of one managed-agent aggregate, but there is no transaction guard or idempotent reconciliation operation spanning them.

**Incremental fix:** Introduce a staged registration guard that knows which steps committed and compensates on failure while `config_edit_lock` is held. At minimum, remove a newly appended row if runtime registration fails and remove a newly spawned supervisor if router registration fails. Prefer one idempotent `reconcile_managed_agent(config)` operation used by startup, create, update, and retry, with uniqueness checked across all three stores.

### Medium 6: Authentication Policy Is Duplicated As A String Path Classifier

**Classification:** Design risk.

**Evidence:**

- `build_app` declares public agent transports, browser APIs, WebSockets, login, and the UI in one flat router before applying a single authentication middleware (`src/server/routes.rs:36-178`).
- The middleware independently reconstructs which paths are public with exact strings and prefix/suffix checks (`src/server/auth.rs:497-512`).
- One-time raw download authorization adds a second method/URI classifier outside the route itself (`src/server/auth.rs:514-550`).
- The same agent file resource is split across modules (`raw` owns GET/PUT while `files` owns DELETE) and all endpoint paths are centralized in the large route function (`src/server/routes.rs:23-30`, `src/server/routes.rs:111-169`).

**Consequence:** Adding, renaming, or nesting a transport endpoint requires synchronized edits in routing and authentication code, but the compiler cannot enforce that synchronization. A mismatch can either expose a browser endpoint or break agent connectivity. Flat route assembly also makes trust boundaries harder to review than domain behavior.

**Missing invariant or boundary:** Public versus browser-authenticated access should be represented by router composition, not inferred later from URI text.

**Incremental fix:** Build separate `public_transport_router`, `browser_api_router`, and UI fallback routers. Apply authentication only to the browser router with `route_layer`, and keep one-time-token authorization inside a narrowly scoped raw-download handler/layer. Within the protected router, nest resource routers by domain (`agents`, `transfers`, `server`, `user-state`) so route ownership follows behavior rather than the current flat import list.

### Medium 7: User-State Writes Are Only Serialized Inside One Browser Context

**Classification:** Confirmed concurrent-write defect.

**Evidence:**

- The UI's module-level promise chain serializes writes only within one loaded JavaScript context (`ui/src/user-state.ts:70-74`, `ui/src/user-state.ts:114-135`). Separate tabs and API clients have independent chains.
- The server has no user-state write lock in `ServerState` (`src/server/state.rs:14-43`).
- Every request writes the same fixed `.state.json.tmp` with truncate, then renames it (`src/server/user_state.rs:53-79`, `src/server/user_state.rs:92-103`).

**Consequence:** Concurrent writes from two tabs can truncate/write the same temporary file, race rename, return spurious failures, or persist bytes from the wrong request. Even after unique temp files, whole-document replacements from stale tabs remain silent last-writer-wins data loss.

**Missing invariant or boundary:** The server does not provide serializable replacement of one account's state document. Client-side ordering cannot enforce a server resource invariant.

**Incremental fix:** Use a unique sibling temp file per write and a server-side per-account mutex around read/replace/rename. If multiple-tab edits must preserve independent fields, add a document version/ETag and reject stale replacements with 409; otherwise document and test serialized last-writer-wins behavior.

### Medium 8: Command And Streaming Error Contracts Are Only Partially Typed

**Classification:** Design risk with currently inconsistent mappings.

**Evidence:**

- `Command` and `CommandResult` are independent enums, so invalid command/result pairings are representable (`src/commands.rs:129-236`, `src/commands.rs:500-538`).
- Generic pending replies store only `Sender<CommandResult>` (`src/actors/router/state.rs:101-107`), and REST handlers repeatedly match the expected variant and synthesize an "unexpected response" 500 (examples: `src/server/agents/files.rs:45-109`, `src/server/files.rs:31-68`, `src/server/agents.rs:309-341`).
- Structured `CommandErrorKind` is centrally mapped to HTTP status (`src/commands.rs:470-498`, `src/server/responses.rs:22-30`).
- Immediate download failures bypass that contract as text in an error stream frame; the REST layer infers 404/403 by searching English phrases (`src/server/raw.rs:380-416`).

**Consequence:** A protocol addition must update dispatch, result construction, summaries, multiple REST matches, and sometimes text heuristics. Error status can differ between metadata/control and streaming paths for the same filesystem failure. OS wording or context changes can turn a 404/403 into 500.

**Missing invariant or boundary:** Each operation should define its request, success type, error type, and streaming setup/terminal semantics together. Transport should not erase structured error categories.

**Incremental fix:** First add `CommandErrorKind` (or a dedicated `StreamErrorKind`) to stream error framing and delete text-based HTTP classification. Then introduce typed router request adapters for repeated one-shot operations, where an adapter validates one expected result variant and returns `Result<T, CommandFailure>`; keep the wire enums but centralize each command/result association once. Do not add one wrapper per handler unless it removes an existing repeated match/status mapping.

### Low 1: Generated Type Shapes Do Not Cover Endpoint Or Full Runtime Contracts

**Classification:** Design risk.

**Evidence:**

- Rust exports many data shapes through `ts-rs`, and the UI imports them (`src/commands.rs:540-1018`, `ui/src/api-client.ts:1-59`).
- Endpoint paths, methods, query parameters, and response associations are nevertheless hand-authored separately in Rust routes and the 1,000-line UI client (`src/server/routes.rs:40-169`, `ui/src/api-client.ts:345-732`, `ui/src/api-client.ts:772-997`).
- Runtime validation is manually recreated for selected WebSocket types (`ui/src/refresh-listener.ts:8-14`, `ui/src/components/log-viewer.tsx:13-22`) but ordinary REST success responses are cast from `response.json()` without validation (`ui/src/api-client.ts:735-743`).
- The UI introduces parallel JSON aliases for generated transfer/copy/move types without changing representation (`ui/src/api-client.ts:116-143`, `ui/src/api-client.ts:933-945`).

**Consequence:** Rust and TypeScript compile independently against matching field declarations, but a route rename, method change, query change, wrong response variant, or stale generated binding is not checked end-to-end. The large hand-built client becomes the de facto API schema.

**Missing invariant or boundary:** There is no single machine-checked contract covering route + method + request + success + error, and no standard policy for runtime validation at untrusted browser boundaries.

**Incremental fix:** Start with contract tests that enumerate every `ApiClient` method against the Axum application and validate representative JSON with generated types/schemas. Remove redundant JSON aliases. If endpoint count continues growing, generate an OpenAPI document/client or a smaller checked endpoint descriptor layer; do not replace the current client wholesale unless generation can preserve streaming and WebSocket-specific behavior.

## Worthwhile Abstraction Opportunities

These opportunities are justified by repeated behavior or an existing invariant; they are not recommendations for broad framework-building.

### 1. A Typed Agent Session Phase

`SessionRuntime` should own `Unregistered` versus `Registered` as an enum, with the registered variant containing the authoritative `AgentId`, watchdog handle, and socket identity. This would remove repeated payload identity checks, prevent re-registration, and make shutdown ownership unambiguous. It directly addresses High 2 rather than merely shortening code.

### 2. A Router Operation Record With Cancellation

Pending REST replies, direct downloads, direct uploads, and copy phases each independently track owner IDs, request IDs, completion channels, cancellation, and terminal cleanup (`src/actors/router/state.rs:101-150`, `src/actors/router/state.rs:205-255`). A small common operation header containing owner, phase/deadline, and cancellation reason would make cleanup and timeout enforcement consistent while leaving payload-specific state in the existing registries. Avoid one giant transfer enum; reuse only the lifecycle fields and transition checks that are genuinely common.

### 3. A Reusable One-Time WebSocket Rendezvous Core

Terminal and log registries repeat pending maps, per-agent/global caps, token validation, one-shot socket handoff, timeout cleanup, and agent cleanup (`src/terminal_registry.rs:11-134`, `src/log_registry.rs:10-171`). Their server setup modules also repeat first-frame authentication and two-socket relay lifecycle (`src/server/terminals.rs:101-267`, `src/server/agent_logs.rs:79-223`). Extract a generic pending rendezvous core parameterized by ID and attached-state cleanup policy. Keep terminal frame validation and log event validation in their domain modules; those behaviors are distinct and should not be generalized.

### 4. A Structured Blocking-Worker Bridge

Tar upload and tar download each bridge blocking `tar` APIs to async channels in different ways (`src/agent/transfers/upload.rs:127-171`, `src/agent/transfers/download.rs:244-269`, `src/agent/transfers/download.rs:433-451`). A reusable bridge should carry bounded chunks, typed terminal result, and cancellation while ensuring all blocking waits stay in `spawn_blocking`. This concrete abstraction would fix both High 4 and Medium 3.

### 5. Typed One-Shot Command Adapters

Many handlers repeat `router.request -> expected CommandResult -> CommandErrorKind mapping -> unexpected variant` (`src/server/agents/files.rs:45-318`, `src/server/files.rs:23-191`, `src/server/agent_helpers.rs:16-55`). Introduce adapters only for repeated protocol operations such as metadata, path mutation, and agent details. Each adapter should own the expected result association and structured failure, while endpoint modules continue to own domain-specific HTTP responses. This improves correctness without hiding all REST behavior behind a generic dispatcher.

### 6. Trust-Boundary Subrouters

Public agent transport, authenticated browser APIs, and static UI service are behaviorally distinct. Separate Axum subrouters would make middleware placement and endpoint ownership visible in module structure. Resource routers can then be nested under `agents`, `transfers`, `server`, and `user-state`, eliminating the current authentication path classifier and reducing the cost of reviewing a new endpoint.

### 7. One Managed-Agent Reconciliation Service

Startup registration, create, update, delete, and retry all synchronize TOML, watchdogs, and router inventory through partially different code paths (`src/server/watchdog.rs:21-105`, `src/server/agent_configuration.rs:122-311`, `src/server/agent_configuration.rs:391-467`). A single idempotent reconciliation method, called under the existing config edit lock, would provide a concrete aggregate boundary and remove partial-state handling duplication.

## Testing And Verification Recommendations

1. **Session identity state machine:** Use a raw valid-token control WebSocket to register twice, send a response with another agent ID, send a predictable foreign request ID, and disconnect. Assert that the second registration is rejected and no orphaned/foreign state changes.
2. **Mailbox saturation:** Make router mailbox capacity injectable in tests. Fill it without sleeps, then exercise registration, command completion, transfer completion, and disconnect. Assert that events await capacity or fail before side effects; no active map entries remain.
3. **Tar producer failure:** Stream a directory where a later entry becomes unreadable/disappears or is unsupported after initial output. Assert the REST body fails, progress becomes errored, and cross-agent copy does not publish a destination.
4. **Tar upload scheduler isolation:** Run enough slow extraction workers to fill bridge queues, then issue agent details/restart/cancel. Assert bounded latency for control operations.
5. **Transfer readiness projection:** Interrupt only the payload socket while keeping control alive. Assert public inventory becomes degraded/not-transfer-ready, new transfers fail predictably, and readiness returns after reconnection.
6. **Command timeout cancellation:** Add a command fixture that waits on a cancellation token. Disconnect or time out the REST caller, then assert router pending state and agent task count return to baseline.
7. **Retention bounds:** Generate more terminal transfer records than the configured history limit. Assert active records are never evicted, old terminal records are pruned deterministically, and list response size remains bounded.
8. **One-time token lease:** Synchronize two requests with the same token before either consumes its body. Assert only one acquires the lease; then cover interruption and non-overlapping range resume.
9. **Managed-agent fault injection:** Inject failures after TOML append, after supervisor registration, and before router inventory acknowledgement. Assert create is either fully visible/durable or fully compensated, and retry converges without restart.
10. **User-state concurrency:** Send concurrent writes from separate clients. Assert every response reflects the defined serialization policy, no shared temp-file error occurs, and the final file is valid JSON with a deterministic winner or 409 stale-write response.
11. **Protocol property tests:** Generate legal and illegal stream sequences (duplicate/out-of-order indices, wrong payload kind, missing final frame, error after data) and assert all receivers reach one terminal state with cleanup. Current WebSocket ordering makes some invalid sequences unlikely, but explicit validation protects future multiplexing and malformed peers.
12. **API contract verification:** Add an integration suite that covers every public `ApiClient` method's path, method, request body, status, and response shape. Include generated bindings freshness in CI and validate selected large/nullable numeric fields at the browser boundary.

## Residual Risks

- This was a static review; scheduler-dependent races may exist in watchdog process handling, SSH relay teardown, terminal PTY ownership, and restart/re-exec behavior beyond the paths examined.
- Platform-specific behavior was not executed on Linux PAM/systemd, macOS launchd, Android, or a real SSH host. Those paths contain ownership and blocking boundaries that require runtime verification.
- Filesystem mutation safety was sampled through move/copy identity and tar destination handling, but this was not a complete security audit of symlink, mount-boundary, permission, and TOCTOU behavior.
- Browser authentication, cookie persistence, CORS/proxy deployment, and one-time links were reviewed only where they intersect architecture; a dedicated security review may find additional concerns.
- The UI was reviewed primarily for API ownership and contract flow. Component rendering, accessibility, route-level cache behavior, and Playwright coverage were not exhaustively assessed.
- Existing tests provide substantial happy-path and interruption coverage, but many lifecycle tests observe eventual state rather than forcing exact actor interleavings. Fault injection and deterministic mailbox/channel control are needed to validate the proposed invariants.

## Finding Counts

- Critical: 0
- High: 5
- Medium: 8
- Low: 1
- Total: 14
