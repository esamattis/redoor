# Transfer Code Review

## Scope

Reviewed the direct raw upload/download paths, the tar directory upload/download paths, and the router/session framing code that connects them. This is a code-inspection review focused on backpressure, streaming behavior, and memory use.

## Findings

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
