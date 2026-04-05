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

4. Medium: the transfer path performs multiple small heap copies per websocket frame.

`StreamChunkFrames` copies each frame payload into a new `Vec<u8>` (`src/streaming.rs:219-227`). Serialization allocates another `Vec<u8>` in `to_bytes` (`src/streaming.rs:113-125`). Parsing allocates again in `from_bytes` (`src/streaming.rs:131-170`). Both server and agent websocket readers also copy binary frames with `bytes.to_vec()` before handing them to actors (`src/actors/session.rs:220-223`, `src/bin/redoor-agent.rs:2078-2080`).

The 8 KiB frame cap keeps this from becoming a catastrophic per-frame memory problem, and the choice clearly favors control-message responsiveness (`src/streaming.rs:8-10`). Still, under sustained high-throughput transfers this creates avoidable allocator churn and extra CPU work.

5. Low: there are additional unbounded channels outside the file data path.

The server session text lane is unbounded (`src/actors/session.rs:184`) and UI subscribers are also fed through an unbounded channel (`src/main.rs:254`). These are not the main large-file risk, but they weaken the overall low-memory story because bursts of control or UI traffic have no local backpressure boundary.
