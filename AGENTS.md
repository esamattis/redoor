# ReDoor Agent Guidelines

Guidance for agentic coding agents working on the ReDoor project.

## Build, Lint, and Test Commands

```bash
cargo build                      # Build project
cargo build --release            # Build with optimizations
cargo build --bin redoor         # Build specific binary
cargo clippy                     # Run linting
cargo fmt                        # Format code
cargo fmt --check                # Check formatting
cargo test                       # Run all tests
cargo test test_name             # Run a single test
cargo test module_name::test_name  # Run tests in module
cargo test -- --nocapture        # Show test output
cargo test --doc                 # Run doc tests
```

## Code Style Guidelines

### Imports and Modules
- Group imports: std crates, external crates, local modules
- Use `use crate::` for local module imports
- Organize alphabetically within groups
- Use `{}` imports for enums/structs

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{Mutex, mpsc};
use crate::types::Message;
```

### Formatting
- 4 spaces for indentation (no tabs)
- Keep lines under 100 characters
- Use `cargo fmt` for automatic formatting
- Use trailing commas in multi-line structures

### Types
- Use `Arc<Mutex<T>>` for shared mutable state
- Use `mpsc::unbounded_channel` for agent communication
- Define type aliases for clarity: `pub type AgentSender = mpsc::UnboundedSender<Message>;`
- Use serde with `#[serde(tag = "type")]` for JSON discriminated unions

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Message {
    #[serde(rename = "agent_register")]
    AgentRegister { agent_id: String, agent_name: String },
}
```

### Naming Conventions
- Modules: `snake_case` (`mod agent_types;`)
- Structs/Enums: `PascalCase` (`struct AppState`)
- Functions: `snake_case` (`fn handle_socket()`)
- Variables: `snake_case` (`agent_id`, `tx_for_recv`)
- Constants: `SCREAMING_SNAKE_CASE`
- Use descriptive names with context (`agent_id_for_recv`)
- Append `_clone` for cloned variables

### Error Handling
- Use `Result<T, E>` for fallible operations
- Use `unwrap()` sparingly (only for impossible-to-fail operations)
- Use `eprintln!()` for error messages to stderr
- Return error responses via protocol messages

```rust
let _ = tx.send(Message::Error {
    message: format!("Agent {} not found", id),
});
```

- Use `if let Ok(...)` for graceful error handling:
```rust
if let Ok(json) = serde_json::to_string(&msg) {
    // handle success
}
```

### Async Patterns
- Use `#[tokio::main]` for async entry points
- Use `tokio::spawn()` for concurrent tasks
- Use `tokio::select!` to wait on multiple operations
- Clone state before moving into async blocks:

```rust
let state_clone = state.clone();
let recv_task = tokio::spawn(async move {
    // use state_clone
});
```

- Use `.clone()` for Arc types before moving into async blocks
- Use `Arc::new(Mutex::new(...))` for shared mutable state

### Function Design
- Keep functions focused on single responsibilities
- Use async functions for I/O operations
- Return `impl IntoResponse` for Axum handlers
- Use `impl Trait` for return types when appropriate

### Library Structure
- Put shared types in `src/lib.rs` with `pub use` re-exports
- Organize modules by functionality (types, commands, etc.)
- Binary-specific code in `src/bin/`
- Use library crate from binaries via `redoor::` prefix

### Adding Commands
1. Add case in `src/commands.rs` `CommandHandler::execute()`:
```rust
match command {
    "ls" => self.ls(args),
    "new_command" => self.new_command(args),
    _ => json!({ "error": format!("Unknown command: {}", command) }),
}
```

2. Implement the command method:
```rust
fn new_command(&self, args: &[String]) -> serde_json::Value {
    json!({ "result": "success" })
}
```

### Testing
- Write unit tests in `#[cfg(test)]` modules within source files
- Write integration tests in `tests/` directory
- Use descriptive test names (`test_agent_registration`)

### WebSocket Protocol
- Messages are JSON with `type` field as discriminator
- Message types in `src/types.rs` and `src/agent_types.rs`
- Server routes messages based on agent_id
- Webapp sends commands, agents respond with results
- Flow: Command -> Execute -> Response

### Commit Guidelines
- Write clear, concise commit messages
- Build and test before committing
- Run `cargo clippy` and `cargo fmt` before committing
