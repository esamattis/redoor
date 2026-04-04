**Review Goals**

- Keep memory usage low across the Rust server and agent architecture.
- Ensure large file transfers do not accumulate extra memory when connections are slow.
- Check whether backpressure is preserved across REST handlers, websocket framing, actor routing, and tar/file streaming paths.

**Findings**

1. High: the central `RouterActor` awaits slow binary sends, so one transfer can stall unrelated routing work.

All binary forwarding goes through `RouterActor::send_agent_binary`, which awaits `outgoing_binary.send(...)` on a channel of capacity 1 (`src/actors/router.rs:330-336`, `src/actors/session.rs:185`). That awaited send is used for REST uploads (`src/actors/router.rs:1789-1839`) and cross-agent copy forwarding (`src/actors/router.rs:743-749`).

Because this happens inside the singleton router actor, a slow destination websocket can block the router from processing unrelated messages: command dispatch, responses, transfer progress, cancellation, and other agents' work. The design intentionally keeps websocket binary queues tiny, which is good for memory, but awaiting them from the central coordinator turns backpressure into global head-of-line blocking.

This is primarily a responsiveness issue, but it also matters for memory because blocked routing delays cleanup and cancellation handling elsewhere in the system.

2. Medium: tar streaming bridges are bounded by item count, not by bytes, so their memory cap depends on `tar` write behavior.

Tar download bridges blocking `tar::Builder` output into `mpsc::channel<Vec<u8>>(8)` through `ChannelTarWriter`, which forwards each `write(buf)` call as `buf.to_vec()` (`src/bin/redoor-agent.rs:42-58`, `src/bin/redoor-agent.rs:1009-1018`). Tar upload uses `std::sync::sync_channel<Vec<u8>>(8)` for the unpack side (`src/bin/redoor-agent.rs:790-797`).

These channels are bounded in number of queued items, but not in bytes per item. If the tar library emits large write buffers, resident memory can spike to roughly "8 queued tar buffers + current working buffers" with no explicit byte ceiling. In practice this may be fine, but the memory bound is implicit and delegated to another library's chunking behavior instead of being owned by this code.

If low-memory behavior is a hard requirement, the tar bridge should normalize writes into an explicit maximum chunk size before queueing.

3. Medium: same-agent directory copy materializes the full tree in memory before copying.

`build_directory_copy_plan` walks the entire source tree and stores every directory and file path in `Vec<PathBuf>` collections before any copy begins (`src/bin/redoor-agent.rs:397-458`). `local_copy_directory` waits for that full plan and then executes it (`src/bin/redoor-agent.rs:601-757`).

This is not on the network transfer path, but it is an architectural memory hotspot for large trees. A directory with millions of entries can consume substantial memory before the first byte is copied. The cross-agent tar path is streaming-oriented; the same-agent directory path is not.

4. Medium: the transfer path performs multiple small heap copies per websocket frame.

`StreamChunkFrames` copies each frame payload into a new `Vec<u8>` (`src/streaming.rs:219-227`). Serialization allocates another `Vec<u8>` in `to_bytes` (`src/streaming.rs:113-125`). Parsing allocates again in `from_bytes` (`src/streaming.rs:131-170`). Both server and agent websocket readers also copy binary frames with `bytes.to_vec()` before handing them to actors (`src/actors/session.rs:220-223`, `src/bin/redoor-agent.rs:2078-2080`).

The 8 KiB frame cap keeps this from becoming a catastrophic per-frame memory problem, and the choice clearly favors control-message responsiveness (`src/streaming.rs:8-10`). Still, under sustained high-throughput transfers this creates avoidable allocator churn and extra CPU work.

5. Low: there are additional unbounded channels outside the file data path.

The server session text lane is unbounded (`src/actors/session.rs:184`) and UI subscribers are also fed through an unbounded channel (`src/main.rs:254`). These are not the main large-file risk, but they weaken the overall low-memory story because bursts of control or UI traffic have no local backpressure boundary.

**Strengths**

- The upload path is mostly well-bounded end to end. The HTTP body is consumed incrementally (`src/main.rs:990-1030`), upload frames are capped to 8 KiB (`src/streaming.rs:219-227`), the server-to-agent binary lane is bounded (`src/actors/session.rs:185`), and the agent upload workers consume through bounded channels of size 8 (`src/bin/redoor-agent.rs:1725-1727`, `src/bin/redoor-agent.rs:1796-1798`).
- The server-side raw download path is now chunk-bounded end to end. The REST handler uses `mpsc::channel(1)` (`src/main.rs:786-801`), the router stores bounded download senders and finishes chunk forwarding asynchronously (`src/actors/router.rs:967-1170`), and websocket ingress waits for an ack before accepting the next binary frame into the session actor (`src/actors/session.rs:203-229`). That closes the previously unbounded server buffering gap for slow HTTP clients.
- Agent-side downloads are streamed from disk with a reusable read buffer and only one pending chunk retained before framing (`src/bin/redoor-agent.rs:1857-1974`). That is a good low-memory shape.
- Cancellation for aborted downloads is implemented, not just implied. When the HTTP response body is dropped, the bounded download sender reports closure, the router marks the transfer canceled and notifies the agent, and the agent download loop observes cancellation via `watch` (`src/actors/router.rs:1066-1139`, `src/bin/redoor-agent.rs:1603-1617`, `src/bin/redoor-agent.rs:1899-1917`).
- Temp-file and temp-directory plus atomic rename patterns are used consistently for uploads and local copies, which avoids partial final artifacts (`src/bin/redoor-agent.rs:1292-1334`, `src/bin/redoor-agent.rs:1114-1174`, `src/bin/redoor-agent.rs:340-395`).
- The small 8 KiB websocket frame size is a deliberate tradeoff to keep control traffic preemptible during long transfers (`src/streaming.rs:8-10`). That part of the design is sound.

**Overall**

The architecture is mostly stream-oriented and shows clear intent to keep transfer memory small, especially on the agent side. The largest previously identified memory break, the server raw-download path's unbounded buffering between websocket ingress and HTTP egress, has been fixed: slow HTTP clients now apply backpressure instead of allowing queued `StreamChunk`s to grow without bound on the server.

The main remaining architectural concern is that the singleton router still directly awaits slow binary sends on the outbound agent websocket path. That preserves local backpressure, but at the cost of making unrelated control-plane work depend on the slowest active transfer. With the raw-download buffering issue resolved, the remaining memory concerns are mostly boundedness and efficiency tuning rather than a fundamental unbounded-buffer flaw in the file transfer path.
