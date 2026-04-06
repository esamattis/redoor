# Ractor Review

## Executive Summary

- The actor pattern is a good fit for this codebase, especially for the central router state.
- The `ractor` crate itself is only adding modest value here. Most of the important concurrency, backpressure, and prioritization behavior is already implemented directly with Tokio channels and tasks.
- Full removal is feasible. It looks like a medium-sized refactor, not a rewrite.
- If `ractor` is removed, the replacement should still be manual actors/tasks with message passing. Replacing the router with shared `Mutex` access would be a step backward.

## Where `ractor` Is Used

- `Cargo.toml:20` adds the dependency.
- The server starts a singleton `RouterActor` in `src/main.rs:35-43`.
- REST handlers call the router with `call_t!` in `src/server/agents.rs`, `src/server/files.rs`, `src/server/raw.rs`, `src/server/transfers.rs`, and `src/server/agent_helpers.rs`.
- Agent WebSocket connections spawn one `SessionActor` per socket in `src/actors/session.rs:211-301`.
- The agent binary runs one `AgentActor` in `src/agent/mod.rs:63-77` and `src/agent/actor.rs:27-250`.

In practice, the repo uses only a small subset of the framework:

- `Actor::spawn`
- `ActorRef<T>`
- `cast`
- `call_t!` and `ActorRef::call`
- `RpcReplyPort<T>`
- `pre_start` / `post_stop`

I did not find usage of the parts that usually justify a dedicated actor framework:

- supervision trees
- linked actors
- monitors
- actor registry lookups
- process groups
- factories
- remoting or cluster features

## Real Value It Brings Today

### 1. Single-owner router state

`RouterActor` owns `RouterState` and serializes all updates in one place (`src/actors/router/mod.rs:83-188`, `src/actors/router/state.rs:182-225`). That is a real benefit because the router maintains several correlated maps for agents, direct transfers, copy tracking, progress, and UI subscribers.

This is the strongest reason to keep an actor-shaped design.

### 2. Request/reply ergonomics

`call_t!` plus `RpcReplyPort<T>` makes the REST handlers straightforward. A manual Tokio version would need the same pattern with `oneshot::Sender<T>`, just with a little more boilerplate.

### 3. Lifecycle hooks

The code does get some structure from `pre_start` and `post_stop`:

- router startup and UI refresh task setup in `src/actors/router/mod.rs:88-106`
- session unregister-on-stop behavior in `src/actors/session.rs:176-192`
- agent startup and shutdown logging in `src/agent/actor.rs:32-50` and `src/agent/actor.rs:242-249`

That is useful, but it is convenience rather than unique capability.

## What It Does Not Really Add Here

### 1. Backpressure is not coming from `ractor`

The important backpressure paths are hand-built with Tokio primitives:

- prioritized text vs binary WebSocket output in `src/actors/session.rs:270-299` and `src/agent/actor.rs:89-110`
- bounded download and upload chunk flow through `tokio::sync::mpsc`
- per-chunk acknowledgements on the server-side binary ingress in `src/actors/session.rs:252-261`
- background tasks that forward slow chunk sends and then message the router back in `src/actors/router/transfers/download.rs:135-154`, `src/actors/router/transfers/upload.rs:123-142`, and `src/actors/router/transfers/copy.rs:370-396`

So the hard concurrency work is already manual. `ractor` is mostly a typed mailbox around it.

### 2. The session actor is mostly a thin adapter

`SessionActor` stores only a socket id, optional agent id, the router ref, and outbound channel handles (`src/actors/session.rs:22-45`). Its logic is mostly:

- parse incoming frames
- remember the registered agent id
- forward messages to the router
- unregister on disconnect

That could be implemented cleanly as a normal per-socket task with local mutable state. It does not appear to need a framework actor.

### 3. The agent actor is already only partly actor-isolated

The agent keeps upload and download registries in `Arc<Mutex<HashMap<...>>>` wrappers (`src/agent/state.rs:23-139`). Worker tasks use those registries directly. That means the system is already partly using shared Tokio-era concurrency rather than strict actor isolation.

Because of that, `AgentActor` is not buying strong isolation guarantees. It is mostly serializing connection lifecycle events and WebSocket callbacks.

### 4. The framework can obscure buffering semantics

I verified in the `ractor 0.15.10` dependency source that actor message mailboxes are backed by unbounded channels. That matters because bounded-memory behavior in this repo depends on explicit Tokio channels, not on the actor mailbox.

There is one concrete downside in the current code: agent-side inbound binary frames are cast into the agent actor mailbox first (`src/agent/ws.rs:23-26`, `src/agent/actor.rs:216-218`) and only later forwarded into the bounded per-upload worker channel in `src/agent/protocol.rs:230-285`. That means `ractor` is currently part of a backpressure gap rather than part of the fix.

## Could It Be Removed?

Yes.

The current code is already close to a manual actor implementation. The message enums already exist, the code already uses Tokio channels everywhere that matters, and the router already behaves like a classic single-owner event loop.

What should not happen is replacing the router with `Arc<Mutex<RouterState>>` and letting request handlers mutate it directly. That would make it easier to hold locks across `await`, complicate transfer ordering, and weaken the current clean ownership model.

## What Removal Would Look Like

### 1. Replace `ActorRef<RouterMsg>` with a small `RouterHandle`

`RouterHandle` would wrap a `tokio::sync::mpsc::Sender<RouterMsg>` and expose:

- fire-and-forget `send(...)`
- request/reply helpers that create `oneshot::channel()` and await the result with timeout

That would cover the current `cast` and `call_t!` usage.

### 2. Run the router as a plain Tokio task

Instead of `RouterActor::spawn(...)`, start a `tokio::spawn` loop that owns `RouterState` and matches on `RouterMsg`. The existing router code is already organized exactly that way; most of the logic in `src/actors/router/*` could stay structurally the same.

### 3. Convert `RpcReplyPort<T>` to `oneshot::Sender<T>`

This is mechanical. Most router messages already have a dedicated reply field, so the message shapes are already ready for it.

### 4. Replace `SessionActor` with a normal runtime struct

`handle_websocket()` already owns the WebSocket split halves and the outbound Tokio channels. The actor layer could be removed by keeping `agent_id` as local task state and forwarding directly to the `RouterHandle`.

The only behavior that must be preserved carefully is the acknowledged binary path, because that is what keeps inbound download/copy traffic backpressured.

### 5. Replace `AgentActor` with a normal runtime task

The agent side can be modeled as:

- one task or select loop for connection lifecycle
- one inbound WebSocket read task
- the existing upload/download worker tasks
- direct Tokio channels for self-messaging where needed

The current code already does most of this. Removing `ractor` would mainly mean replacing `cast` with explicit channels and making the bounded-vs-unbounded decisions visible.

### 6. Update tests and docs

- router tests currently spawn `RouterActor` directly in `src/actors/router/mod.rs:202-329`
- README actor-system documentation in `README.md:48-79` would need to be updated

## Migration Difficulty

I would classify this as a medium refactor.

Why it is not tiny:

- `ActorRef<RouterMsg>` is threaded through most server entry points
- the session and agent code both depend on `cast`, `call`, and actor startup/shutdown hooks
- tests currently rely on the router actor API

Why it is still very feasible:

- the message protocol already exists
- the router logic is already centralized
- the expensive or blocking work is already pushed out into Tokio tasks
- advanced `ractor` features are not in play, so there is no supervision tree or registry behavior to recreate

## Recommendation

My conclusion is:

- the actor model is useful here
- the `ractor` crate is not providing enough unique value to feel essential
- full removal is realistic if the team wants lower framework overhead and clearer channel semantics

If the goal is to simplify the system, I would be comfortable planning a removal of `ractor` while preserving the same router/session/agent boundaries as plain Tokio tasks.

## Bottom Line

- Does `ractor` bring value? Yes, but mostly structural and ergonomic value.
- Is that value unique or hard to replace? No.
- Could it be removed by manually implementing the actors? Yes.
- My recommendation: if the team is willing to do a medium-sized refactor, remove the dependency but keep the actor-style architecture.
