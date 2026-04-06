# Transfer Code Review

## Scope

Reviewed the direct raw upload/download paths, the tar directory upload/download paths, and the router/session framing code that connects them. This is a code-inspection review focused on backpressure, streaming behavior, and memory use.

## Findings

### High: Agent-side upload ingress is bounded now, but it still drops frames instead of backpressuring

Refs: `src/agent/ws.rs:15-26`, `src/agent/mod.rs:69-74`, `src/agent/mod.rs:95`, `src/agent/protocol.rs:229-279`

The old unbounded `ractor` mailbox is gone. The agent now routes websocket frames through a bounded `tokio::mpsc::channel::<AgentMsg>(256)`, and the raw and tar upload workers still use bounded per-upload chunk queues. However, the websocket read loop still calls `agent_ref.send(...)`, which is implemented with `try_send`, and then ignores the result.

Impact: when file writes or tar extraction slow down, `handle_upload_chunk()` can stall on the bounded per-upload queue as intended, but the websocket reader does not propagate that pressure to the socket. Instead it keeps reading until the shared 256-message agent queue fills, after which inbound binary frames are silently dropped. That makes uploads lossy under load rather than truly backpressured. This still affects raw uploads, tar uploads, and the destination side of remote copy uploads because they all reuse the same ingress path.

Recommendation: make agent-side inbound binary handling acknowledged or otherwise awaitable so the websocket read loop does not read the next frame until the current one has been accepted by the per-upload worker. At minimum, do not ignore `try_send` failures for transfer frames.

### High: Extensionless downloads read the whole file into memory before streaming starts

Refs: `src/server/raw.rs:169-206`, `src/commands.rs:536-541`, `src/server/raw.rs:238-347`

Every raw download does a `Metadata` command before the stream starts. When the file has no extension, `metadata()` falls back to `detect_mime_type_from_content()`, which calls `tokio::fs::read(path).await` even though the comment says it should read only the first 8 KiB.

Impact: downloading a large extensionless file can allocate the entire file on the agent before the first streamed chunk is sent. That undermines the streaming design and can create very large one-request memory spikes. The same issue also affects range requests and `HEAD` requests because they go through the same metadata path.

Recommendation: open the file and read only a small fixed prefix for content sniffing. Do not use `tokio::fs::read` here.

### Medium: Tar upload backpressure is memory-bounded, but it blocks a Tokio worker thread

Refs: `src/agent/transfers/upload.rs:160-166`, `src/agent/transfers/upload.rs:439-446`

The tar upload path uses `std::sync::mpsc::sync_channel(8)` between the async upload worker and the blocking tar extractor. That is good for memory because it caps buffering, but the async worker then calls the blocking `send()` method directly.

Impact: when extraction falls behind, the upload worker blocks a Tokio runtime thread instead of yielding. This does not create unbounded buffering, but it can reduce responsiveness when several tar uploads are active at once.

Recommendation: keep the bounded handoff, but switch to a Tokio channel on the producer side and consume it from the blocking extractor with a blocking receive API.

## What Looks Good

- `src/streaming.rs:6-10` caps transfer frame payloads at 8 KiB, which keeps control messages preemptible during long transfers.
- The direct download path is backpressured end-to-end:
    - agent download workers await the bounded websocket binary lane before reading further (`src/agent/raw.rs:450-458`, `src/agent/transfers/download.rs:247-254`)
    - the server websocket session waits for router acknowledgement on each inbound binary frame (`src/actors/session.rs:252-261`)
    - the router waits for the bounded REST sink to accept each chunk (`src/actors/router/transfers/download.rs:135-148`)
    - the HTTP handler buffers only one `StreamChunk` between the router and the response body (`src/server/raw.rs:238-239`)
- The direct upload path is also backpressured correctly until the bytes cross into the agent process:
    - the HTTP handler waits for router acknowledgement before reading the next request-body chunk (`src/server/raw.rs:457-543`)
    - the router waits for the bounded agent binary lane (`src/server/raw.rs:76-130`, `src/actors/router/transfers/upload.rs:123-133`)
    - both websocket senders prioritize text/control traffic over binary transfer traffic (`src/actors/session.rs:280-296`, `src/agent/actor.rs:93-109`)
- The raw and tar download workers stream incrementally and keep only a small lookahead buffer in memory (`src/agent/raw.rs:392-395`, `src/agent/transfers/download.rs:222-223`).

## Test Gaps

- I did not find toxiproxy/backpressure tests for tar upload/download paths comparable to the existing raw transfer coverage.
- I did not find throttled remote-copy tests that exercise the same backpressure paths when the destination side is slow.

## Assumption

- The first finding assumes dropped websocket binary frames are not tolerated by the upload protocol, which matches the current chunked transfer design.
