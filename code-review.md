**Review Goals**

- Keep memory usage low across the Rust server and agent architecture.
- Ensure large file transfers do not accumulate extra memory when connections are slow.
- Check whether backpressure is preserved across REST handlers, websocket framing, actor routing, and tar/file streaming paths.

**Findings**

1. Critical: server-side download buffering is unbounded, so a slow HTTP client can grow memory without a hard cap.

The raw download handler creates an `mpsc::unbounded_channel<StreamChunk>` and hands that sender to the router for the lifetime of the download (`src/main.rs:786-801`). The router then forwards every received agent chunk into that unbounded queue with `chunk_sender.send(chunk.clone())` (`src/actors/router.rs:955-1024`).

This means the agent-to-server websocket path can stay productive while the server-to-HTTP-client path is slow. For a large download over a slow connection, memory usage grows with queued `StreamChunk`s on the server. The existing cancel path only triggers after the HTTP body side is dropped (`src/actors/router.rs:1017-1050`), so a merely slow client is enough to accumulate memory.

This is the largest mismatch with the stated architecture goal. The queue between websocket ingress and HTTP egress should be byte-bounded or chunk-bounded so backpressure reaches the agent before server memory grows.

2. High: the central `RouterActor` awaits slow binary sends, so one transfer can stall unrelated routing work.

All binary forwarding goes through `RouterActor::send_agent_binary`, which awaits `outgoing_binary.send(...)` on a channel of capacity 1 (`src/actors/router.rs:318-333`, `src/actors/session.rs:183`). That awaited send is used for REST uploads (`src/actors/router.rs:1693-1743`) and cross-agent copy forwarding (`src/actors/router.rs:731-738`).

Because this happens inside the singleton router actor, a slow destination websocket can block the router from processing unrelated messages: command dispatch, responses, transfer progress, cancellation, and other agents' work. The design intentionally keeps websocket binary queues tiny, which is good for memory, but awaiting them from the central coordinator turns backpressure into global head-of-line blocking.

This is primarily a responsiveness issue, but it also matters for memory because blocked routing delays cleanup and cancellation handling elsewhere in the system.

3. Medium: tar streaming bridges are bounded by item count, not by bytes, so their memory cap depends on `tar` write behavior.

Tar download bridges blocking `tar::Builder` output into `mpsc::channel<Vec<u8>>(8)` through `ChannelTarWriter`, which forwards each `write(buf)` call as `buf.to_vec()` (`src/bin/redoor-agent.rs:37-58`, `src/bin/redoor-agent.rs:1009-1018`). Tar upload uses `std::sync::sync_channel<Vec<u8>>(8)` for the unpack side (`src/bin/redoor-agent.rs:790-797`).

These channels are bounded in number of queued items, but not in bytes per item. If the tar library emits large write buffers, resident memory can spike to roughly "8 queued tar buffers + current working buffers" with no explicit byte ceiling. In practice this may be fine, but the memory bound is implicit and delegated to another library's chunking behavior instead of being owned by this code.

If low-memory behavior is a hard requirement, the tar bridge should normalize writes into an explicit maximum chunk size before queueing.

4. Medium: same-agent directory copy materializes the full tree in memory before copying.

`build_directory_copy_plan` walks the entire source tree and stores every directory and file path in `Vec<PathBuf>` collections before any copy begins (`src/bin/redoor-agent.rs:397-458`). `local_copy_directory` waits for that full plan and then executes it (`src/bin/redoor-agent.rs:601-757`).

This is not on the network transfer path, but it is an architectural memory hotspot for large trees. A directory with millions of entries can consume substantial memory before the first byte is copied. The cross-agent tar path is streaming-oriented; the same-agent directory path is not.

5. Medium: the transfer path performs multiple small heap copies per websocket frame.

`StreamChunkFrames` copies each frame payload into a new `Vec<u8>` (`src/streaming.rs:219-227`). Serialization allocates another `Vec<u8>` in `to_bytes` (`src/streaming.rs:113-125`). Parsing allocates again in `from_bytes` (`src/streaming.rs:131-170`). Both server and agent websocket readers also copy binary frames with `bytes.to_vec()` before handing them to actors (`src/actors/session.rs:217-218`, `src/bin/redoor-agent.rs:2078-2080`).

The 8 KiB frame cap keeps this from becoming a catastrophic per-frame memory problem, and the choice clearly favors control-message responsiveness (`src/streaming.rs:8-10`). Still, under sustained high-throughput transfers this creates avoidable allocator churn and extra CPU work.

6. Low: there are additional unbounded channels outside the file data path.

The server session text lane is unbounded (`src/actors/session.rs:182`) and UI subscribers are also fed through an unbounded channel (`src/main.rs:254`). These are not the main large-file risk, but they weaken the overall low-memory story because bursts of control or UI traffic have no local backpressure boundary.

**Strengths**

- The upload path is mostly well-bounded end to end. The HTTP body is consumed incrementally (`src/main.rs:990-1030`), upload frames are capped to 8 KiB (`src/streaming.rs:219-227`), the server-to-agent binary lane is bounded (`src/actors/session.rs:183`), and the agent upload workers consume through bounded channels of size 8 (`src/bin/redoor-agent.rs:1725-1727`, `src/bin/redoor-agent.rs:1796-1798`).
- Agent-side downloads are streamed from disk with a reusable read buffer and only one pending chunk retained before framing (`src/bin/redoor-agent.rs:1857-1974`). That is a good low-memory shape.
- Cancellation for aborted downloads is implemented, not just implied. When the HTTP response body is dropped, the server notifies the agent and the agent download loop observes cancellation via `watch` (`src/actors/router.rs:1017-1050`, `src/bin/redoor-agent.rs:1603-1617`, `src/bin/redoor-agent.rs:1899-1917`).
- Temp-file and temp-directory plus atomic rename patterns are used consistently for uploads and local copies, which avoids partial final artifacts (`src/bin/redoor-agent.rs:1292-1334`, `src/bin/redoor-agent.rs:1114-1174`, `src/bin/redoor-agent.rs:340-395`).
- The small 8 KiB websocket frame size is a deliberate tradeoff to keep control traffic preemptible during long transfers (`src/streaming.rs:8-10`). That part of the design is sound.

**Overall**

The architecture is mostly stream-oriented and shows clear intent to keep transfer memory small, especially on the agent side. The main architectural break is the server download path: it converts a bounded websocket stream into an unbounded in-memory queue before the HTTP body. As written, large downloads to slow clients can consume unbounded server memory even though the surrounding components are otherwise carefully chunked.

The second major concern is that the singleton router directly awaits slow binary sends. That preserves local backpressure, but at the cost of making unrelated control-plane work depend on the slowest active transfer. If those two issues are fixed, the remaining memory concerns are mostly secondary tuning and edge cases rather than fundamental architectural problems.
