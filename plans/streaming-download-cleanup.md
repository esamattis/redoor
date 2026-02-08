# Streaming Download Cleanup


One low-priority improvement to the raw streaming file download pipeline. This plan builds on top of `plans/fix-streaming-download-reliability.md` and assumes those changes land first.

## Prerequisites

The reliability plan changes types that this plan also touches:

- `rest_streaming_responses` becomes `HashMap<u64, (String, Sender<StreamChunk>)>` (already updated to use StreamChunk)
- `RouteStreamChunk` message carries a `StreamChunk` struct (already updated)
- The REST handler stream loop already yields `Result<Bytes, io::Error>` and checks `is_error`

## Files to Change

- `src/actors/session.rs` — change `outgoing_binary` to bounded channel

---



## Fix: Unbounded binary channel in SessionActor

### Current behavior

In `src/actors/session.rs`, the `handle_websocket` function (line 201) creates an unbounded channel for outgoing binary frames:

```rust
let (tx_binary, mut rx_binary) = mpsc::unbounded_channel::<Vec<u8>>();
```

This channel is stored as `outgoing_binary` in `SessionState` and consumed by a background task that forwards binary frames to the WebSocket sender. Currently nothing in the codebase sends `SessionMsg::OutgoingBinary` messages (verified by grep — no code calls `cast(SessionMsg::OutgoingBinary(...))`), so this channel is unused. However, it is wired up and available for future use, so it should be bounded to prevent unbounded memory growth if binary streaming to agents is added later.

The JSON outgoing channel (`tx` / `outgoing`) is also unbounded (line 200):

```rust
let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
```

This channel carries serialized command messages to the agent. Commands are sent one-at-a-time from REST API calls, so in practice this doesn't accumulate. However, for consistency, it should also be bounded.

### Changes

**`src/actors/session.rs` — `SessionState` field types**

Change both outgoing channel types from unbounded to bounded:

```rust
pub struct SessionState {
    pub socket_id: String,
    pub router_ref: ActorRef<RouterMsg>,
    pub agent_id: Option<String>,
    pub outgoing: mpsc::Sender<Message>,
    pub outgoing_binary: mpsc::Sender<Vec<u8>>,
}
```

**`src/actors/session.rs` — `SessionActor` Arguments type**

Update the tuple type:

```rust
type Arguments = (
    String,
    ActorRef<RouterMsg>,
    mpsc::Sender<Message>,
    mpsc::Sender<Vec<u8>>,
);
```

**`src/actors/session.rs` — `handle_websocket` function**

Replace unbounded channels with bounded ones. Use a capacity of 64 to allow reasonable buffering without unbounded growth:

```rust
let (tx, mut rx) = mpsc::channel::<Message>(64);
let (tx_binary, mut rx_binary) = mpsc::channel::<Vec<u8>>(64);
```

**`src/actors/session.rs` — `OutgoingMessage` and `OutgoingBinary` handlers**

The `send()` method on bounded `mpsc::Sender` is async and returns a `Result`. Since these are called inside the actor's `handle` method (which is already async), change from `send` (which is sync-only on unbounded) to the appropriate send. Use `try_send()` to avoid blocking the actor on a full channel:

```rust
SessionMsg::OutgoingMessage(msg) => {
    // ... existing logging ...
    if let Err(e) = state.outgoing.try_send(msg) {
        log!(Level::Warning, "Outgoing message channel full or closed: {}", e);
    }
}
SessionMsg::OutgoingBinary(bytes) => {
    if let Err(e) = state.outgoing_binary.try_send(bytes) {
        log!(Level::Warning, "Outgoing binary channel full or closed: {}", e);
    }
}
```

The consolidation channel `tx_out` (line 202) is also unbounded but it merges both text and binary frames into a single send stream. It should also be bounded for the same reason:

```rust
// Before:
let (tx_out, mut rx_out) = mpsc::unbounded_channel::<WsMessage>();

// After:
let (tx_out, mut rx_out) = mpsc::channel::<WsMessage>(128);
```

The two forwarding tasks that send into `tx_out` should use `try_send()` as well since they run in spawned tasks and dropping a frame is preferable to blocking indefinitely:

```rust
// Text forwarding task:
tokio::spawn(async move {
    while let Some(msg) = rx.recv().await {
        if let Ok(json) = serde_json::to_string(&msg) {
            if tx_out_clone.try_send(WsMessage::Text(json.into())).is_err() {
                break;
            }
        }
    }
});

// Binary forwarding task:
tokio::spawn(async move {
    while let Some(bytes) = rx_binary.recv().await {
        if tx_out_clone2.try_send(WsMessage::Binary(bytes.into())).is_err() {
            break;
        }
    }
});
```

---
