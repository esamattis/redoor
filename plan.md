# ReDoor to Ractor Conversion Plan

The ractor crate is already installed

## Current Architecture Issues

- Centralized shared state with `Arc<Mutex<>>` structures
- Single WebSocket handler managing all logic (~200 lines in `handle_socket`)
- Direct message passing via `mpsc::unbounded_channel`
- No supervision or fault tolerance
- Agent binary uses basic async tasks

---

## Proposed Actor Architecture

### Server Side (3 Actors)

#### 1. RouterActor (Single instance)

**Responsibilities:**
- Track all registered agents (agent_id → agent_name, socket_id)
- Track all connected web clients (for broadcasting)
- Track pending command responses (agent_id → web_client_actor_ref)
- Route commands from web clients to agent sessions
- Route responses from agents back to web clients
- Broadcast agent list updates to web clients

**State:**
```rust
struct RouterState {
    agents: HashMap<String, AgentInfo>,                           // agent_id → info
    web_clients: Vec<ActorRef<SessionMsg>>,                       // all web client actors
    pending_responses: HashMap<String, ActorRef<SessionMsg>>,    // agent_id → web client
}
```

**Messages:**
- `RegisterAgent { agent_id, agent_name, socket_id, session_ref }`
- `UnregisterAgent { agent_id }`
- `RegisterWebClient { session_ref }`
- `UnregisterWebClient { session_ref }`
- `RouteCommand { agent_id, command, args, requester_ref }`
- `RouteResponse { agent_id, result }`

**Supervision:**
- Supervises all SessionActor instances
- Logs failures (no auto-restart per user requirement)

---

#### 2. SessionActor (One per WebSocket connection)

**Responsibilities:**
- Manage the WebSocket connection lifecycle
- Translate between WebSocket messages and actor messages
- Send messages to WebSocket
- Handle connection errors/disconnects

**State:**
```rust
struct SessionState {
    socket_id: String,
    socket_sender: SplitSink<WebSocket, WsMessage>,
    router_ref: ActorRef<RouterMsg>,
    agent_id: Option<String>,    // Only for agent sessions
    is_agent: bool,
}
```

**Messages (received from Router or peer actors):**
- `SendAgentList { agents: HashMap<String, String> }`
- `SendCommand { agent_id, command, args }`
- `SendCommandResponse { agent_id, result }`
- `SendError { message }`

**Internal flow:**
- Receives WebSocket messages → parses → sends to Router
- Receives messages from Router → serializes → sends over WebSocket

**Supervision:**
- Child of RouterActor
- Logs failures on disconnect

---

#### 3. CommandExecutorActor (Single instance)

**Responsibilities:**
- Execute commands asynchronously
- Handle command execution in isolation
- Return errors (no retry per user requirement)
- Maintain stateless design (no history/audit trail)

**State:**
```rust
struct CommandExecutorState;
```

**Messages:**
- `ExecuteCommand { command, args, reply_to: RpcReplyPort<serde_json::Value> }`

**Note:**
- Uses RPC pattern for async responses
- Stateless per user requirement
- Returns errors directly to caller

---

### Agent Side (2 Actors)

#### 1. ConnectionActor (Single instance)

**Responsibilities:**
- Manage WebSocket connection to server
- Handle agent registration on connect
- Translate between WebSocket messages and actor messages
- Handle connection errors/reconnect logic (future)
- Forward server commands to CommandActor

**State:**
```rust
struct ConnectionState {
    server_url: String,
    agent_id: String,
    agent_name: String,
    socket_split: Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    command_actor_ref: Option<ActorRef<CommandMsg>>,
}
```

**Messages:**
- `Connect { server_url, agent_name }`
- `SendRegister`
- `ServerMessage(Message)` - Forwarded from server (AgentRegister, Command, etc.)
- `SendCommandResponse { result }`
- `ConnectionError { error }`

**Supervision:**
- Supervises CommandActor
- Logs failures (no auto-restart per user requirement)

---

#### 2. CommandActor (Single instance)

**Responsibilities:**
- Execute commands received from server
- Maintain stateless design (no history/audit trail per user requirement)
- Forward responses to ConnectionActor for sending to server

**State:**
```rust
struct CommandState;
```

**Messages:**
- `ExecuteCommand { command, args, reply_to: ActorRef<ConnectionMsg> }`
- `CommandResult { result }` - Sent back to ConnectionActor

**Supervision:**
- Child of ConnectionActor
- Stateless per user requirement
- Returns errors directly

---

## Implementation Plan

### Phase 1: Server Foundation

1. Create `src/actors/mod.rs` - Module declarations
2. Create `src/actors/router.rs` - RouterActor implementation
3. Create `src/actors/session.rs` - SessionActor implementation
4. Create `src/actors/command_executor.rs` - CommandExecutorActor implementation
5. Define message types for each actor
6. Implement RouterActor state management
7. Implement SessionActor WebSocket handling
8. Implement CommandExecutorActor with async execution

### Phase 2: Server Integration

1. Refactor `main.rs` to spawn RouterActor on startup
2. Refactor `main.rs` to spawn CommandExecutorActor on startup
3. Update `websocket_handler` to spawn SessionActor per connection
4. Remove `AppState` struct and all `Arc<Mutex<>>` structures
5. Pass Router and CommandExecutor actor references to SessionActors
6. Replace mpsc channels with actor messages
7. Update `lib.rs` to export new actor modules

### Phase 3: Server Message Flow

1. Implement Router's command routing logic
2. Implement agent registration/unregistration flow
3. Implement agent list broadcasting to web clients
4. Implement command response routing back to web clients
5. Connect SessionActor → Router → CommandExecutor flow
6. Handle WebSocket disconnect cleanup

### Phase 4: Agent Foundation

1. Create `src/actors/agent/mod.rs` - Agent module declarations
2. Create `src/actors/agent/connection.rs` - ConnectionActor implementation
3. Create `src/actors/agent/command.rs` - CommandActor implementation
4. Define agent-side message types
5. Implement ConnectionActor WebSocket handling
6. Implement CommandActor with async command execution

### Phase 5: Agent Integration

1. Refactor `src/bin/redoor-agent.rs` to spawn ConnectionActor
2. Refactor `src/bin/redoor-agent.rs` to spawn CommandActor
3. Remove manual async tasks (read_task, stdin_task)
4. Wire ConnectionActor ↔ CommandActor communication
5. Keep CLI argument parsing
6. Update agent to use actor messaging instead of direct mpsc

### Phase 6: Testing & Cleanup

1. Add supervision (Router supervises Sessions, Connection supervises Command)
2. Implement proper error logging for failures
3. Run `cargo clippy` and fix warnings
4. Run `cargo fmt`
5. Run `cargo test`
6. Test server startup and WebSocket connections
7. Test web UI agent registration
8. Test command execution from web UI
9. Test agent disconnect handling
10. Test error handling (invalid agents, failed commands)
11. Remove unused code:
    - Old `AppState` struct
    - Old `AgentSender` type alias
    - Any remaining mpsc channel usage
12. Verify all log messages still work

---

## Key Benefits

- **No shared mutable state** - Each actor owns its state
- **Clear separation of concerns** - Router vs Session vs Executor responsibilities
- **Built-in supervision** - Router supervises Sessions, Connection supervises Command
- **Easier unit testing** - Test actors in isolation
- **Better scalability** - Can add more actors or specialized handlers later
- **Type-safe messaging** - Compile-time checks on message passing
- **Async command execution** - Non-blocking command handling
- **Stateless design** - Simpler state management, no history to maintain

---

## User Decisions

1. **Supervision strategy**: Log failures only (no auto-restart)
2. **Command execution**: Async execution with RPC pattern
3. **State persistence**: Stateless actors (no command history/audit trail)
4. **Error handling**: Return errors directly (no automatic retry)

---

## File Structure After Conversion

```
src/
├── actors/
│   ├── mod.rs
│   ├── router.rs
│   ├── session.rs
│   ├── command_executor.rs
│   └── agent/
│       ├── mod.rs
│       ├── connection.rs
│       └── command.rs
├── bin/
│   └── redoor-agent.rs
├── agent_types.rs
├── commands.rs
├── lib.rs
├── logging.rs
├── main.rs
└── types.rs
```

---

## Migration Notes

- WebSocket message protocol (`Message` enum) stays the same
- Web UI (index.html) requires no changes
- Command logic in `CommandHandler` stays the same
- Logging infrastructure stays the same
- Agent CLI arguments stay the same
