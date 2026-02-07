# Conditional Content-Disposition and MIME Type Detection via Metadata Command

## Overview

This plan describes modifications to implement conditional Content-Disposition header and accurate MIME type detection by creating a new Metadata command that the agent executes to provide file information including MIME type and file size.

## Current Implementation

The `raw_agent_handler` function in `src/main.rs` (lines 330-420) handles file streaming requests at the route `/api/v1/agents/{agent}/raw/{*path}`. Currently:

- The handler always sets `Content-Type: application/octet-stream`
- The handler always adds a `Content-Disposition` header with `attachment; filename="..."`
- Query parameters are not accessed
- File metadata (MIME type, size) is not retrieved from the agent
- No `Content-Length` header is set

The agent's `raw_download` function in `src/bin/redoor-agent.rs` handles file streaming but does not provide metadata before streaming begins.

## Requirements

1. **Conditional Content-Disposition**: Add the `Content-Disposition` header only when the URL contains `download=1` query string
2. **MIME Type Detection**: Detect the correct `Content-Type` based on the file by having the agent determine it
3. **Content-Length Header**: Add `Content-Length` header with the actual file size from the agent
4. **Metadata Command**: Create a new command that the agent executes to return file metadata before streaming

## Implementation Steps

### Step 1: Create Query Parameter Struct

Define a struct to deserialize query parameters using Axum's `Query` extractor.

```rust
#[derive(Deserialize)]
struct RawQueryParams {
    download: Option<String>,
}
```

### Step 2: Add Metadata Command to commands.rs

Add the Metadata variant to the `Command` enum in `src/commands.rs`:

```rust
pub enum Command {
    Ls { path: Option<String> },
    Cat { path: String },
    RawDownload { path: String },
    Metadata { path: String },  // New command
    Echo { request: EchoRequest },
    AgentInfo,
    GetAgentDetails,
}
```

### Step 3: Add Metadata Response Type

Add the response struct and variant in `src/commands.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MetadataResponse {
    pub path: String,
    pub mime_type: String,
    pub file_size: u64,
}

// Add to CommandResult enum:
pub enum CommandResult {
    LsDirectory(LsDirectoryResult),
    LsFile(LsFileResult),
    Cat(CatResult),
    RawDownload { path: String },
    Metadata(MetadataResponse),  // New variant
    Echo(EchoResult),
    AgentInfo(AgentInfoResult),
    GetAgentDetails(AgentDetailsResponse),
    Error { message: String },
}
```

### Step 4: Implement Metadata Command Handler

Implement the `metadata` method in `CommandHandler` in `src/commands.rs`:

```rust
async fn metadata(&self, path: String) -> CommandResult {
    use std::path::Path;
    use std::os::unix::fs::MetadataExt;

    match tokio::fs::metadata(&path).await {
        Ok(metadata) => {
            // Determine MIME type from file extension
            let mime_type = Path::new(&path)
                .extension()
                .and_then(|ext| ext.to_str())
                .and_then(|ext| mime_guess::from_ext(ext).first())
                .map(|mime| mime.to_string())
                .unwrap_or_else(|| "application/octet-stream".to_string());

            let file_size = metadata.size();

            CommandResult::Metadata(MetadataResponse {
                path,
                mime_type,
                file_size,
            })
        }
        Err(e) => CommandResult::Error {
            message: format!("Failed to get file metadata: {}", e),
        },
    }
}
```

Add the match arm to the `execute` method:

```rust
pub async fn execute(&self, command: Command) -> CommandResult {
    match command {
        Command::Ls { path } => self.ls(path).await,
        Command::Cat { path } => self.cat(path).await,
        Command::RawDownload { path } => self.raw_download(path).await,
        Command::Metadata { path } => self.metadata(path).await,  // New arm
        Command::Echo { request } => self.echo(request).await,
        Command::AgentInfo => self.agent_info().await,
        Command::GetAgentDetails => self.get_agent_details().await,
    }
}
```

### Step 5: Update Handler Signature

Modify the `raw_agent_handler` function signature in `src/main.rs` to include the `Query` extractor:

```rust
async fn raw_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    Query(params): Query<RawQueryParams>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse
```

### Step 6: Call Metadata Command Before Streaming

Before initiating the stream, call the Metadata command to get file information. This should be done before the existing streaming setup:

```rust
// Get file metadata first
let metadata = match call_t!(
    &state.router_ref,
    |reply| actors::router::RouterMsg::ExecuteCommandRest {
        agent_id: agent.clone(),
        command: Command::Metadata { path: path.clone() },
        reply,
    },
    5000
) {
    Ok(CommandResult::Metadata(metadata)) => metadata,
    Ok(CommandResult::Error { message }) => {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: message }),
        ).into_response();
    }
    Ok(_) => {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected response type from metadata command".to_string(),
            }),
        ).into_response();
    }
    Err(e) => {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get file metadata: {:?}", e),
            }),
        ).into_response();
    }
};
```

### Step 7: Build Response with Metadata

Modify the response building logic to use the metadata:

```rust
let mut response_builder = Response::builder()
    .status(StatusCode::OK)
    .header("Content-Type", metadata.mime_type)
    .header("Content-Length", metadata.file_size.to_string());

// Add Content-Disposition only if download=1 query parameter is present
if params.download.as_deref() == Some("1") {
    let filename = path.split('/').last().unwrap_or("file");
    response_builder = response_builder.header(
        "Content-Disposition",
        format!("attachment; filename=\"{}\"", filename),
    );
}

response_builder
    .body(Body::from_stream(
        stream.map(|v| Ok::<_, std::io::Error>(v)),
    ))
    .unwrap()
    .into_response()
```

### Step 8: Generate TypeScript Bindings

Run the script to generate TypeScript bindings for the new `MetadataResponse` type:

```bash
./scripts/generate-ts-bindings
```

### Step 9: Build and Test

Run the build and test script:

```bash
./scripts/build-and-test
```

## Code Changes Required

**File**: `src/commands.rs`

**Changes**:
1. Add `Metadata { path: String }` variant to `Command` enum
2. Add `Metadata(MetadataResponse)` variant to `CommandResult` enum
3. Add `MetadataResponse` struct with `#[ts(export)]` derive macro
4. Implement `metadata` method in `CommandHandler` that uses `mime_guess` and gets file size
5. Add match arm for `Command::Metadata` in `execute` method

**File**: `src/main.rs`

**Changes**:
1. Add `use serde::Deserialize;` import (if not already present)
2. Add `RawQueryParams` struct definition before handlers
3. Update `raw_agent_handler` signature to include `Query(params): Query<RawQueryParams>`
4. Add metadata retrieval logic before streaming setup (before line 351)
5. Modify the response builder to use `metadata.mime_type` and `metadata.file_size`
6. Make Content-Disposition header conditional based on query parameter

**File**: `bindings/` (generated)

**Changes**:
1. TypeScript bindings will be regenerated to include `MetadataResponse` interface

## Testing Considerations

- Test with `download=1` query parameter: Verify Content-Disposition header is present
- Test without `download=1` query parameter: Verify Content-Disposition header is absent
- Test with various file extensions (`.txt`, `.pdf`, `.jpg`, `.png`, `.html`): Verify correct MIME types in response headers
- Test with unknown file extension: Verify fallback to `application/octet-stream`
- Test Content-Length header: Verify it matches the actual file size
- Test with non-existent file: Verify proper error handling
- Ensure streaming functionality still works correctly after the changes
- Verify that the Metadata command works correctly on the agent side