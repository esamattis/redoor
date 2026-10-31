//! Schema-driven MCP device tool catalog and authorized dispatch.

use crate::actors::router::{CopyOperation, OutputStreamTracking, RouterMsg};
use base64::{Engine, engine::general_purpose::STANDARD};
use redoor_protocol::wire::request::{self, LsResponse};
use redoor_protocol::{
    api::{
        files::CreationOwnershipOptions,
        search::{CaseSensitivity, FindRequest, GrepRequest},
        tokens::Permission::{
            self, AgentsManage, CommandsExecute, FilesDelete, FilesRead, FilesWrite,
        },
        transfers::{CopyEndpoint, CopyExistingMode},
    },
    ids::{AgentId, RequestId, TransferId},
    wire::{
        command::Command,
        exec::{ExecEvent, ExecRequest},
    },
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::{error::McpError, schema::server_metadata};
use crate::http::{
    access::Principal,
    agent_client::{CreateDirectory, Ls, Metadata, RawDelete, Trash, content_grep, file_search},
    error::ApiError,
    services::{
        output::OutputStream,
        transfer::{CopySpec, StartedCopy},
        upload::{AgentUpload, UploadStart},
    },
    state::ServerState,
};

/// Bounds the `hello` tool's echoed name so the greeting stays small.
const MAX_NAME_LENGTH: usize = 64;
/// Keeps inline MCP reads and writes small; large local transfers belong to the remote CLI.
const INLINE_FILE_LIMIT: usize = 64 * 1024;
/// Truncates directory listings so one large directory cannot blow up an MCP response.
const MAX_DIRECTORY_ENTRIES: usize = 2_000;

/// A compact definition keeps annotations, schemas and permissions consistent with dispatch.
struct ToolDefinition {
    name: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
    required: &'static [&'static str],
    /// What a token must hold (on some device) to use the tool at all; `tools/list` hides the
    /// rest. Each call still checks the permissions on the devices it actually touches.
    permissions: &'static [Permission],
}

/// Single source for the advertised tool catalog and the names accepted by dispatch.
const TOOLS: &[ToolDefinition] = &[
    ToolDefinition {
        name: "hello",
        description: "Return a bounded greeting without accessing devices.",
        read_only: true,
        destructive: false,
        required: &[],
        permissions: &[],
    },
    ToolDefinition {
        name: "list_devices",
        description: "List devices visible to this token.",
        read_only: true,
        destructive: false,
        required: &[],
        permissions: &[],
    },
    ToolDefinition {
        name: "get_device",
        description: "Get one visible device.",
        read_only: true,
        destructive: false,
        required: &["device_id"],
        permissions: &[],
    },
    ToolDefinition {
        name: "run_command",
        description: "Run an argv-based non-PTY command.",
        read_only: false,
        destructive: true,
        required: &["device_id", "argv", "cwd"],
        permissions: &[CommandsExecute],
    },
    ToolDefinition {
        name: "get_operation",
        description: "Read the state of an operation this token started.",
        read_only: true,
        destructive: false,
        required: &["operation_id"],
        permissions: &[],
    },
    ToolDefinition {
        name: "read_command_output",
        description: "Read bounded retained command output.",
        read_only: true,
        destructive: false,
        required: &["operation_id"],
        permissions: &[CommandsExecute],
    },
    ToolDefinition {
        name: "cancel_operation",
        description: "Request cancellation of owned work.",
        read_only: false,
        destructive: true,
        required: &["operation_id"],
        permissions: &[],
    },
    ToolDefinition {
        name: "list_directory",
        description: "List a bounded remote directory.",
        read_only: true,
        destructive: false,
        required: &["device_id", "path"],
        permissions: &[FilesRead],
    },
    ToolDefinition {
        name: "stat_path",
        description: "Read remote path metadata.",
        read_only: true,
        destructive: false,
        required: &["device_id", "path"],
        permissions: &[FilesRead],
    },
    ToolDefinition {
        name: "read_file",
        description: "Read a bounded remote file range.",
        read_only: true,
        destructive: false,
        required: &["device_id", "path"],
        permissions: &[FilesRead],
    },
    ToolDefinition {
        name: "write_file",
        description: "Write bounded content using explicit conflict policy.",
        read_only: false,
        destructive: true,
        required: &["device_id", "path", "content", "on_existing"],
        permissions: &[FilesWrite],
    },
    ToolDefinition {
        name: "copy_path",
        description: "Copy a file or directory through the streaming pipeline.",
        read_only: false,
        destructive: false,
        required: &["source", "destination", "on_existing"],
        permissions: &[FilesRead, FilesWrite],
    },
    ToolDefinition {
        name: "move_path",
        description: "Atomically rename or copy then delete a path.",
        read_only: false,
        destructive: true,
        required: &["source", "destination", "on_existing"],
        permissions: &[FilesRead, FilesWrite, FilesDelete],
    },
    ToolDefinition {
        name: "delete_path",
        description: "Trash or permanently delete an explicit path.",
        read_only: false,
        destructive: true,
        required: &["device_id", "path", "mode", "recursive"],
        permissions: &[FilesDelete],
    },
    ToolDefinition {
        name: "create_directory",
        description: "Create a remote directory.",
        read_only: false,
        destructive: false,
        required: &["device_id", "path"],
        permissions: &[FilesWrite],
    },
    ToolDefinition {
        name: "search_paths",
        description: "Search names below one absolute root.",
        read_only: true,
        destructive: false,
        required: &["device_id", "root", "query"],
        permissions: &[FilesRead],
    },
    ToolDefinition {
        name: "search_contents",
        description: "Search bounded text matches below one root.",
        read_only: true,
        destructive: false,
        required: &["device_id", "root", "query"],
        permissions: &[FilesRead],
    },
    ToolDefinition {
        name: "start_managed_agent",
        description: "Set a managed device's desired state to running.",
        read_only: false,
        destructive: false,
        required: &["device_id"],
        permissions: &[AgentsManage],
    },
    ToolDefinition {
        name: "stop_managed_agent",
        description: "Stop a managed device and wait for cleanup.",
        read_only: false,
        destructive: true,
        required: &["device_id"],
        permissions: &[AgentsManage],
    },
];

/// Returns deterministic schemas for the tools this token's permissions allow, so the model
/// only sees what it can actually do.
pub(super) fn list_result(
    principal: &Principal,
    params: &Value,
    id: &Value,
) -> Result<Value, McpError> {
    let object = object(params, "params", id)?;
    if object.get("cursor").is_some_and(|cursor| !cursor.is_null()) {
        return Err(invalid("The tool catalog has one page", id));
    }
    let tools = TOOLS.iter().filter(|tool| tool.permissions.iter().all(|permission| principal.holds(*permission))).map(|tool| json!({
        "name": tool.name, "description": tool.description,
        "inputSchema": {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":input_properties(tool.name),"required":tool.required,"additionalProperties":true},
        "outputSchema": {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"},
        "annotations": {"readOnlyHint":tool.read_only,"destructiveHint":tool.destructive,"idempotentHint":tool.read_only,"openWorldHint":tool.name == "run_command"}
    })).collect::<Vec<_>>();
    Ok(
        json!({"resultType":"complete","tools":tools,"ttlMs":300000,"cacheScope":"private","_meta":server_metadata()}),
    )
}

/// Dispatches one authorized tool without loopback HTTP or retained client session state.
pub(super) async fn call_result(
    state: &ServerState,
    principal: &Principal,
    params: &Value,
    id: &Value,
) -> Result<Value, McpError> {
    let request = object(params, "params", id)?;
    let name = string(request, "name", id)?;
    if !TOOLS.iter().any(|tool| tool.name == name) {
        return Err(invalid(format!("Unknown tool: {name}"), id));
    }
    let empty = Value::Object(Map::new());
    let args = object(
        request.get("arguments").unwrap_or(&empty),
        "tool arguments",
        id,
    )?;
    let result = match name {
        "hello" => hello(args, id)?,
        "list_devices" => list_devices(state, principal, id).await?,
        "get_device" => get_device(state, principal, args, id).await?,
        "run_command" => run_command(state, principal, args, id).await?,
        "get_operation" => get_operation(state, principal, args, id).await?,
        "read_command_output" => read_command_output(state, principal, args, id).await?,
        "cancel_operation" => cancel_operation(state, principal, args, id).await?,
        "list_directory" => list_directory(state, principal, args, id).await?,
        "stat_path" => stat_path(state, principal, args, id).await?,
        "read_file" => read_file(state, principal, args, id).await?,
        "write_file" => write_file(state, principal, args, id).await?,
        "copy_path" => transfer(state, principal, args, id, false).await?,
        "move_path" => transfer(state, principal, args, id, true).await?,
        "delete_path" => delete_path(state, principal, args, id).await?,
        "create_directory" => create_directory(state, principal, args, id).await?,
        "search_paths" => search_paths(state, principal, args, id).await?,
        "search_contents" => search_contents(state, principal, args, id).await?,
        "start_managed_agent" => managed_agent(state, principal, args, id, true).await?,
        "stop_managed_agent" => managed_agent(state, principal, args, id, false).await?,
        _ => unreachable!(),
    };
    Ok(complete(name, result))
}

/// Builds the required property subset while keeping optional arguments forward-compatible.
fn input_properties(name: &str) -> Value {
    let mut result = Map::new();
    for key in TOOLS
        .iter()
        .find(|tool| tool.name == name)
        .into_iter()
        .flat_map(|tool| tool.required)
    {
        result.insert(
            (*key).to_string(),
            match *key {
                "argv" => json!({"type":"array","items":{"type":"string"},"minItems":1}),
                "source" | "destination" => {
                    json!({"type":"object","required":["device_id","path"]})
                }
                "recursive" => json!({"type":"boolean"}),
                // Clients may pass a name for convenience; the id keeps working after renames.
                "device_id" => json!({
                    "type":"string",
                    "description":"Device id (stable across renames) or current device name"
                }),
                _ => json!({"type":"string"}),
            },
        );
    }
    if matches!(name, "copy_path" | "move_path") {
        result.insert(
            "resume".into(),
            json!({"type":"string", "enum":["auto", "restart"], "default":"auto"}),
        );
    }
    Value::Object(result)
}
/// Wraps structured tool output with a concise human-readable MCP summary.
fn complete(name: &str, value: Value) -> Value {
    let summary = if name == "hello" {
        value
            .get("greeting")
            .and_then(Value::as_str)
            .unwrap_or("Hello from Redoor!")
            .to_string()
    } else {
        format!("{name} completed")
    };
    json!({"resultType":"complete","content":[{"type":"text","text":summary}],"structuredContent":value,"isError":false,"_meta":server_metadata()})
}
/// Keeps the protocol smoke test harmless and independently bounded.
fn hello(args: &Map<String, Value>, id: &Value) -> Result<Value, McpError> {
    if args.keys().any(|key| key != "name") {
        return Err(invalid("hello accepts only the optional name argument", id));
    }
    let greeting = match args.get("name") {
        None => "Hello from Redoor!".to_string(),
        Some(Value::String(name))
            if !name.is_empty() && name.chars().count() <= MAX_NAME_LENGTH =>
        {
            format!("Hello, {name}, from Redoor!")
        }
        _ => return Err(invalid("hello name must contain 1 to 64 characters", id)),
    };
    Ok(json!({"greeting":greeting}))
}

/// Filters retained inventory before serialization so disallowed IDs are never disclosed.
async fn list_devices(
    state: &ServerState,
    principal: &Principal,
    id: &Value,
) -> Result<Value, McpError> {
    let devices = crate::http::agents::list_agent_snapshots(state)
        .await
        .map_err(|error| op(error.to_string(), id))?
        .into_iter()
        .filter(|agent| principal.can_see(&agent.id))
        .map(device_json)
        .collect::<Vec<_>>();
    Ok(json!({"devices":devices}))
}
/// Returns one in-scope device without exposing connection configuration.
async fn get_device(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let device = string(args, "device_id", id)?;
    let agent_id = authorize_device(state, principal, &[], device, id).await?;
    let agent = crate::http::agents::list_agent_snapshots(state)
        .await
        .map_err(|error| op(error.to_string(), id))?
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| op("Device not found", id))?;
    Ok(json!({"device":device_json(agent)}))
}
/// Reduces the REST inventory model to the safe MCP device contract.
fn device_json(agent: redoor_protocol::api::agents::AgentInfoResponse) -> Value {
    json!({"device_id":agent.id,"display_name":agent.name,"status":agent.status,"managed":agent.managed,"default_working_directory":agent.cwd,"supported_features":{"trash":agent.supports_move_to_trash,"trash_restore":agent.supports_trash}})
}

/// Admits foreground or independently owned background non-PTY execution.
async fn run_command(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let device = string(args, "device_id", id)?.to_string();
    let agent_id = authorize_device(state, principal, &[CommandsExecute], &device, id).await?;
    let argv = args
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("argv must be an array", id))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid("argv values must be strings", id))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cwd = absolute(string(args, "cwd", id)?, id)?.to_string();
    let env = args
        .get("environment")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), value.to_string()))
                        .ok_or_else(|| invalid("environment values must be strings", id))
                })
                .collect()
        })
        .transpose()?
        .unwrap_or_default();
    let timeout_ms = args
        .get("deadline_ms")
        .and_then(Value::as_u64)
        .unwrap_or(30_000);
    let output_limit = args
        .get("output_limit")
        .and_then(Value::as_u64)
        .unwrap_or(64 * 1024)
        .min(state.mcp.operations.per_job_quota() as u64) as usize;
    let background = args
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("foreground")
        == "background";
    let request = ExecRequest {
        argv,
        cwd: Some(cwd),
        env,
        timeout_ms: Some(timeout_ms),
    };
    request.validate().map_err(|error| invalid(error, id))?;
    let record = state
        .mcp
        .operations
        .create(owner(principal, id)?, vec![agent_id.to_string()], "command")
        .await
        .map_err(|error| {
            op(
                format!("Failed recording operation admission: {error:#}"),
                id,
            )
        })?;
    let (output, terminal) =
        match OutputStream::open_execution(&state.router_ref, agent_id, request).await {
            Ok(value) => value,
            Err(error) => {
                let mut current = record.lock().await;
                current.state = "failed".to_string();
                current.terminal =
                    Some(json!({"reason":"admission_failed","error":error.to_string()}));
                drop(current);
                let _ = state.mcp.operations.update(&record).await;
                return Err(op("Execution admission failed", id));
            }
        };
    let remote_id = output.request_id();
    {
        let mut record = record.lock().await;
        record.remote_id = Some(remote_id.0);
        record.state = "running".to_string();
    }
    state
        .mcp
        .operations
        .update(&record)
        .await
        .map_err(|error| op(format!("Failed persisting execution: {error:#}"), id))?;
    let operation_id = record.lock().await.id;
    let task = drain_execution(
        state.mcp.operations.clone(),
        record.clone(),
        output,
        terminal,
        output_limit,
    );
    if background {
        tokio::spawn(task);
        Ok(json!({"operation_id":operation_id,"state":"running"}))
    } else {
        task.await;
        let record = record.lock().await;
        operation_json(&record)
    }
}

/// Drains output under backpressure even after the retention quota is exhausted.
///
/// The agent sends the exit status as its result after the output, so the output is read to
/// its end first and the status is then taken from the terminal lane.
async fn drain_execution(
    operations: super::operations::OperationRegistry,
    record: std::sync::Arc<tokio::sync::Mutex<super::operations::OperationRecord>>,
    mut output: OutputStream,
    mut terminal: tokio::sync::watch::Receiver<Option<ExecEvent>>,
    limit: usize,
) {
    while let Some(item) = output.recv().await {
        let failed = match item {
            Ok(chunk) => operations
                .append_output(&record, &chunk.data, limit)
                .await
                .is_err(),
            Err(_) => true,
        };
        if failed {
            record.lock().await.state = "failed".to_string();
        }
    }
    let event = loop {
        let current = terminal.borrow_and_update().clone();
        if current.is_some() {
            break current;
        }
        // A closed lane means the router dropped the execution without a result.
        if terminal.changed().await.is_err() {
            break None;
        }
    };
    if let Some(event) = event {
        finish_execution(&operations, &record, event).await;
        output.disarm();
        return;
    }
    let mut current = record.lock().await;
    if current.terminal.is_none() {
        current.state = "unknown".to_string();
    }
    drop(current);
    let _ = operations.update(&record).await;
}

/// Records only an agent terminal acknowledgement as proof of process termination.
async fn finish_execution(
    operations: &super::operations::OperationRegistry,
    record: &std::sync::Arc<tokio::sync::Mutex<super::operations::OperationRecord>>,
    event: ExecEvent,
) {
    let mut current = record.lock().await;
    current.state = match event {
        ExecEvent::Exit { .. } => "completed",
        ExecEvent::Canceled => "canceled",
        ExecEvent::TimedOut => "timed_out",
        _ => "failed",
    }
    .to_string();
    current.remote_id = None;
    current.terminal = serde_json::to_value(event).ok();
    drop(current);
    let _ = operations.update(record).await;
}
/// Resolves an operation only for the token that started it; rotation keeps the token id.
async fn owned_operation(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<std::sync::Arc<tokio::sync::Mutex<super::operations::OperationRecord>>, McpError> {
    let operation_id = Uuid::parse_str(string(args, "operation_id", id)?)
        .map_err(|_| invalid("operation_id must be a UUID", id))?;
    let record = state
        .mcp
        .operations
        .get(operation_id)
        .await
        .map_err(|error| op(format!("Failed reading operation registry: {error:#}"), id))?
        .ok_or_else(|| McpError::operation_not_found("Operation not found", Some(id.clone())))?;
    if principal.token_id() != Some(record.lock().await.owner_token) {
        return Err(McpError::forbidden(
            "Operation belongs to another token",
            Some(id.clone()),
        ));
    }
    Ok(record)
}
/// Returns durable state without depending on the router's prunable transfer history.
async fn get_operation(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let record = owned_operation(state, principal, args, id).await?;
    {
        let current = record.lock().await;
        recheck_operation_access(principal, &current, id)?;
    }
    let record = record.lock().await;
    operation_json(&record)
}

/// Drains a retained terminal notification independently of client polling and router history.
async fn collect_transfer(
    operations: super::operations::OperationRegistry,
    record: std::sync::Arc<tokio::sync::Mutex<super::operations::OperationRecord>>,
    mut terminal: tokio::sync::watch::Receiver<
        Option<redoor_protocol::api::transfers::TransferProgressEntry>,
    >,
) {
    loop {
        let transfer = terminal.borrow_and_update().clone();
        if let Some(transfer) = transfer {
            let mut current = record.lock().await;
            current.state = match transfer.state {
                redoor_protocol::api::transfers::TransferProgressState::Canceled => "canceled",
                redoor_protocol::api::transfers::TransferProgressState::Errored => "failed",
                redoor_protocol::api::transfers::TransferProgressState::Completed => "completed",
                _ => "unknown",
            }
            .to_string();
            current.remote_id = None;
            current.terminal = Some(json!({
                "transferred_bytes": transfer.transferred_bytes,
                "total_bytes": transfer.total_bytes,
                "error": transfer.error,
                "atomic": transfer.atomic
            }));
            drop(current);
            if let Err(error) = operations.update(&record).await {
                redoor_core::log!(
                    redoor_protocol::wire::log::Level::Error,
                    "Failed persisting MCP transfer completion: {error:#}"
                );
            }
            return;
        }
        if terminal.changed().await.is_err() {
            let mut current = record.lock().await;
            current.state = "unknown".to_string();
            current.remote_id = None;
            drop(current);
            let _ = operations.update(&record).await;
            return;
        }
    }
}
/// Serializes lifecycle metadata without embedding retained output.
fn operation_json(record: &super::operations::OperationRecord) -> Result<Value, McpError> {
    Ok(
        json!({"operation_id":record.id,"kind":record.kind,"state":record.state,"termination":record.terminal,"output_size":record.output_size,"output_truncated":record.output_truncated,"cancel_requested":record.cancel_requested}),
    )
}
/// Reads one bounded binary-safe page from an owned command spool.
async fn read_command_output(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let record = owned_operation(state, principal, args, id).await?;
    let record = {
        let current = record.lock().await;
        recheck_operation_access(principal, &current, id)?;
        current.clone()
    };
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(64 * 1024)
        .min(64 * 1024) as usize;
    let end = offset.saturating_add(limit).min(record.output_size);
    let data = state
        .mcp
        .operations
        .read_output(&record, offset, limit)
        .await
        .map_err(|error| op(format!("Failed reading retained output: {error}"), id))?;
    Ok(
        json!({"operation_id":record.id,"offset":offset,"next_offset":end,"more":end<record.output_size,"encoding":"base64","content":STANDARD.encode(data),"truncated":record.output_truncated}),
    )
}
/// Routes cancellation to the underlying execution or transfer without claiming termination.
async fn cancel_operation(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let record = owned_operation(state, principal, args, id).await?;
    let mut current = record.lock().await;
    recheck_operation_access(principal, &current, id)?;
    if !matches!(
        current.state.as_str(),
        "admitted" | "running" | "canceling" | "unknown"
    ) {
        return Ok(json!({
            "operation_id": current.id,
            "cancellation_accepted": false,
            "termination_acknowledged": true
        }));
    }
    current.cancel_requested = true;
    let operation_id = current.id;
    let kind = current.kind.clone();
    let remote_id = current.remote_id;
    let device = current.device_ids.first().cloned();
    drop(current);
    state
        .mcp
        .operations
        .update(&record)
        .await
        .map_err(|error| op(format!("Failed persisting cancellation: {error:#}"), id))?;
    let accepted = match (kind.as_str(), remote_id, device.as_deref()) {
        ("command", Some(remote), Some(device)) => state
            .agents
            .cancel_execution(AgentId::unchecked(device), RequestId::new(remote))
            .await
            .map_err(|error| op(error.to_string(), id))?,
        ("copy" | "move", Some(remote), _) => state
            .router_ref
            .request(|reply| RouterMsg::CancelPublicTransfer {
                transfer_id: TransferId::new(remote),
                reply,
            })
            .await
            .is_ok_and(|result| result.is_ok()),
        _ => false,
    };
    let current = record.lock().await;
    Ok(
        json!({"operation_id":operation_id,"cancellation_accepted":accepted,"termination_acknowledged":matches!(current.state.as_str(),"canceled"|"completed"|"failed"|"timed_out"|"interrupted")}),
    )
}

/// Bounds remote directory serialization independently of agent result size.
async fn list_directory(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let (device, path) = device_path(args, id)?;
    let agent_id = authorize_device(state, principal, &[FilesRead], device, id).await?;
    let call = Ls {
        path: Some(path.to_string()),
    };
    match state
        .agents
        .call(&agent_id, call)
        .await
        .map_err(|error| op(error.to_string(), id))?
    {
        LsResponse::Directory(mut result) => {
            let truncated = result.files.len() > MAX_DIRECTORY_ENTRIES;
            result.files.truncate(MAX_DIRECTORY_ENTRIES);
            Ok(json!({"path":result.path,"entries":result.files,"truncated":truncated}))
        }
        LsResponse::File(_) => Err(op("Path is not a directory", id)),
    }
}
/// Maps agent metadata to a credential-free path contract.
async fn stat_path(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let (device, path) = device_path(args, id)?;
    let agent_id = authorize_device(state, principal, &[FilesRead], device, id).await?;
    let result = state
        .agents
        .call(
            &agent_id,
            Metadata {
                path: path.to_string(),
            },
        )
        .await
        .map_err(|error| op(error.to_string(), id))?;
    Ok(
        json!({"path":result.path,"size":result.file_size,"is_file":result.is_file,"is_directory":result.is_dir,"mime_type":result.mime_type}),
    )
}
/// Reads one inline file page and preserves an exact byte continuation offset.
async fn read_file(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let (device, path) = device_path(args, id)?;
    let agent_id = authorize_device(state, principal, &[FilesRead], device, id).await?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(64 * 1024)
        .min(64 * 1024) as usize;
    let encoding = args
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let mut stream = OutputStream::open(
        &state.router_ref,
        agent_id,
        Command::RawDownload(request::RawDownload {
            expected_identity: None,
            path: path.to_string(),
            range_start: Some(offset),
            // One byte past the page tells whether more content follows.
            range_end: Some(offset.saturating_add(limit as u64).saturating_add(1)),
        }),
        OutputStreamTracking::Download {
            path: path.to_string(),
            total_bytes: limit as u64 + 1,
            full_size: None,
            resume_offset: Some(offset),
        },
    )
    .await
    .map_err(|error| op(error.to_string(), id))?;
    let page = stream
        .read_bounded(limit)
        .await
        .map_err(|error| op(error.0.message, id))?;
    // Dropping the stream cancels the agent if it still streams the look-ahead byte.
    drop(stream);
    let (bytes, more) = (page.data, page.overflowed);
    let next_offset = offset + bytes.len() as u64;
    let content = match encoding {
        "base64" => STANDARD.encode(&bytes),
        "text" => String::from_utf8(bytes)
            .map_err(|_| invalid("Requested range is not valid UTF-8; use base64", id))?,
        _ => return Err(invalid("encoding must be text or base64", id)),
    };
    Ok(
        json!({"path":path,"offset":offset,"next_offset":next_offset,"more":more,"encoding":encoding,"content":content}),
    )
}
/// Sends bounded inline content through the shared streamed upload service.
async fn write_file(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let (device, path) = device_path(args, id)?;
    let agent_id = authorize_device(state, principal, &[FilesWrite], device, id).await?;
    let encoding = args
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let content = string(args, "content", id)?;
    let bytes = if encoding == "base64" {
        STANDARD
            .decode(content)
            .map_err(|_| invalid("content is not valid base64", id))?
    } else {
        content.as_bytes().to_vec()
    };
    if bytes.len() > INLINE_FILE_LIMIT {
        return Err(invalid(
            "Inline writes are limited to 65536 bytes; use `redoor remote cp` for larger files",
            id,
        ));
    }
    let command = Command::RawUpload(request::RawUpload {
        partial: None,
        path: path.to_string(),
        on_existing: conflict_mode(string(args, "on_existing", id)?, id)?,
        ownership: CreationOwnershipOptions::default(),
        executable: false,
        precondition: None,
    });
    let written = write_inline(state, agent_id, path, command, &bytes)
        .await
        .map_err(|error| op(error.to_string(), id))?;
    Ok(json!({"path":path,"bytes_written":written}))
}

/// Writes bounded inline bytes through the shared streamed upload and returns the bytes written.
async fn write_inline(
    state: &ServerState,
    agent_id: AgentId,
    path: &str,
    command: Command,
    bytes: &[u8],
) -> Result<u64, ApiError> {
    let upload = AgentUpload::start(
        &state.router_ref,
        agent_id,
        command,
        path.to_string(),
        bytes.len() as u64,
    )
    .await?;
    let UploadStart::Ready(mut upload) = upload else {
        return Ok(0);
    };
    upload.send(bytes).await?;
    upload.finish().await
}

/// Authorizes both endpoints before admitting copy or move work idempotently.
async fn transfer(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
    is_move: bool,
) -> Result<Value, McpError> {
    let source = object(
        args.get("source")
            .ok_or_else(|| invalid("source is required", id))?,
        "source",
        id,
    )?;
    let destination = object(
        args.get("destination")
            .ok_or_else(|| invalid("destination is required", id))?,
        "destination",
        id,
    )?;
    let source_device = string(source, "device_id", id)?;
    let source_path = absolute(string(source, "path", id)?, id)?;
    let destination_device = string(destination, "device_id", id)?;
    let destination_path = absolute(string(destination, "path", id)?, id)?;
    let (source_permissions, destination_permissions) = transfer_permissions(is_move);
    let source_id =
        authorize_device(state, principal, source_permissions, source_device, id).await?;
    let destination_id = authorize_device(
        state,
        principal,
        destination_permissions,
        destination_device,
        id,
    )
    .await?;
    let owner = owner(principal, id)?;
    let mode = conflict_mode(string(args, "on_existing", id)?, id)?;
    let kind = if is_move { "move" } else { "copy" };
    let fingerprint = json!({"kind": kind, "arguments": args}).to_string();
    let key = args.get("idempotency_key").and_then(Value::as_str);
    let _admission = if let Some(key) = key {
        Some(state.mcp.operations.lock_admission(owner, key).await)
    } else {
        None
    };
    if let Some(key) = key {
        match state
            .mcp
            .operations
            .idempotent_result(owner, key, &fingerprint)
            .await
        {
            Ok(Some(result)) => return Ok(result),
            Err(()) => {
                return Err(invalid(
                    "idempotency_key was already used with different arguments",
                    id,
                ));
            }
            Ok(None) => {}
        }
    }
    let record = state
        .mcp
        .operations
        .create(
            owner,
            vec![source_id.to_string(), destination_id.to_string()],
            kind,
        )
        .await
        .map_err(|error| {
            op(
                format!("Failed recording transfer admission: {error:#}"),
                id,
            )
        })?;
    let result = json!({"operation_id":record.lock().await.id,"state":"running"});
    // Persist the reservation before remote work so an ambiguous admission cannot be repeated.
    if let Some(key) = key {
        state
            .mcp
            .operations
            .remember(owner, key.to_string(), fingerprint, result.clone())
            .await
            .map_err(|error| {
                op(
                    format!("Failed persisting idempotency record: {error:#}"),
                    id,
                )
            })?;
    }
    let spec = CopySpec {
        op: if is_move {
            CopyOperation::Move
        } else {
            CopyOperation::Copy
        },
        source: CopyEndpoint {
            agent: source_id,
            path: source_path.to_string(),
        },
        dest: CopyEndpoint {
            agent: destination_id,
            path: destination_path.to_string(),
        },
        on_existing: mode,
        resume: match args.get("resume") {
            None => redoor_protocol::api::transfers::ResumeMode::Auto,
            Some(Value::String(mode)) if mode == "auto" => {
                redoor_protocol::api::transfers::ResumeMode::Auto
            }
            Some(Value::String(mode)) if mode == "restart" => {
                redoor_protocol::api::transfers::ResumeMode::Restart
            }
            _ => return Err(invalid("resume must be auto or restart", id)),
        },
        observe_terminal: true,
    };
    let (remote_id, terminal) = match state.transfers.start_copy(spec).await {
        Ok(StartedCopy {
            transfer_id,
            terminal: Some(terminal),
        }) => (transfer_id.0, terminal),
        Ok(StartedCopy { terminal: None, .. }) => {
            return Err(op("Transfer admission lost its terminal observer", id));
        }
        Err(error) => {
            let mut current = record.lock().await;
            current.state = "failed".to_string();
            current.terminal = Some(json!({"reason":"admission_failed","error":error.to_string()}));
            drop(current);
            let _ = state.mcp.operations.update(&record).await;
            // Keyed callers share the durable admission even when its remote start fails.
            return if key.is_some() {
                Ok(result)
            } else {
                Err(op("Transfer admission failed", id))
            };
        }
    };
    {
        let mut record = record.lock().await;
        record.remote_id = Some(remote_id);
        record.state = "running".to_string();
    }
    tokio::spawn(collect_transfer(
        state.mcp.operations.clone(),
        record.clone(),
        terminal,
    ));
    state
        .mcp
        .operations
        .update(&record)
        .await
        .map_err(|error| op(format!("Failed persisting transfer: {error:#}"), id))?;
    Ok(result)
}
/// Requires explicit deletion mode and recursive intent before mutation.
async fn delete_path(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let (device, path) = device_path(args, id)?;
    let agent_id = authorize_device(state, principal, &[FilesDelete], device, id).await?;
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("recursive must be an explicit boolean", id))?;
    if !recursive {
        let metadata = state
            .agents
            .call(
                &agent_id,
                Metadata {
                    path: path.to_string(),
                },
            )
            .await
            .map_err(|error| op(error.to_string(), id))?;
        if metadata.is_dir {
            return Err(invalid(
                "recursive must be true when deleting a directory",
                id,
            ));
        }
    }
    let to_trash = match string(args, "mode", id)? {
        "permanent" => false,
        "trash" => true,
        _ => return Err(invalid("mode must be trash or permanent", id)),
    };
    let deleted = if to_trash {
        let call = Trash {
            path: path.to_string(),
        };
        state.agents.call(&agent_id, call).await
    } else {
        let call = RawDelete {
            path: path.to_string(),
        };
        state.agents.call(&agent_id, call).await
    };
    deleted.map_err(|error| op(error.to_string(), id))?;
    Ok(json!({"path":path,"deleted":true}))
}
/// Creates one absolute directory through the same agent command used by REST.
async fn create_directory(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let (device, path) = device_path(args, id)?;
    let agent_id = authorize_device(state, principal, &[FilesWrite], device, id).await?;
    let call = CreateDirectory {
        path: path.to_string(),
        ownership: CreationOwnershipOptions::default(),
    };
    state
        .agents
        .call(&agent_id, call)
        .await
        .map_err(|error| op(error.to_string(), id))?;
    Ok(json!({"path":path,"created":true}))
}
/// Runs the existing bounded platform-aware path search implementation.
async fn search_paths(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let device = string(args, "device_id", id)?;
    let root = absolute(string(args, "root", id)?, id)?;
    let agent_id = authorize_device(state, principal, &[FilesRead], device, id).await?;
    let timeout = args
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 60);
    let call = file_search(
        root.to_string(),
        FindRequest {
            query: string(args, "query", id)?.to_string(),
            timeout,
            include_hidden: args
                .get("include_hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            respect_gitignore: args
                .get("respect_gitignore")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            case_sensitivity: case_sensitivity(args, id)?,
            directories_only: false,
        },
    );
    let mut result = state
        .agents
        .call(&agent_id, call)
        .await
        .map_err(|error| op(error.to_string(), id))?;
    let omitted = result.results.len().saturating_sub(2000);
    result.results.truncate(2000);
    Ok(
        json!({"matches":result.results,"timed_out":result.timed_out,"truncated":omitted>0,"omitted":omitted,"matching":"substring path/name matching using the connected agent's platform rules"}),
    )
}
/// Runs bounded grep while preserving regex, ignore, case, and context controls.
async fn search_contents(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
) -> Result<Value, McpError> {
    let device = string(args, "device_id", id)?;
    let root = absolute(string(args, "root", id)?, id)?;
    let agent_id = authorize_device(state, principal, &[FilesRead], device, id).await?;
    let timeout = args
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 60);
    let request = GrepRequest {
        query: string(args, "query", id)?.to_string(),
        timeout,
        include_hidden: args
            .get("include_hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        respect_gitignore: args
            .get("respect_gitignore")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        fixed_string: args
            .get("fixed_string")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        case_sensitivity: case_sensitivity(args, id)?,
        before_context: args
            .get("before_context")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(20),
        after_context: args
            .get("after_context")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(20),
    };
    let call = content_grep(root.to_string(), request);
    let result = state
        .agents
        .call(&agent_id, call)
        .await
        .map_err(|error| op(error.to_string(), id))?;
    serde_json::to_value(result).map_err(|error| op(error.to_string(), id))
}
/// Applies existing watchdog desired-state semantics only to configured managed devices.
async fn managed_agent(
    state: &ServerState,
    principal: &Principal,
    args: &Map<String, Value>,
    id: &Value,
    start: bool,
) -> Result<Value, McpError> {
    let device = string(args, "device_id", id)?;
    let agent_id = authorize_device(state, principal, &[AgentsManage], device, id).await?;
    let snapshot = crate::http::agents::managed_agent_snapshot(state, &agent_id)
        .await
        .map_err(|error| op(error.to_string(), id))?;
    let watchdog = state
        .watchdog_registry
        .lookup(snapshot.id.as_str())
        .ok_or_else(|| op("Managed supervisor unavailable", id))?;
    if start {
        watchdog
            .start()
            .await
            .map_err(|error| op(error.to_string(), id))?;
        crate::http::agents::apply_managed_snapshot(state, agent_id.clone(), watchdog.snapshot())
            .await
            .map_err(|error| op(error.to_string(), id))?;
        Ok(json!({"device_id":agent_id,"accepted":true,"poll_device":true}))
    } else {
        tokio::time::timeout(std::time::Duration::from_secs(10), watchdog.shutdown())
            .await
            .map_err(|_| op("Timed out stopping managed agent", id))?
            .map_err(|error| op(error.to_string(), id))?;
        crate::http::agents::apply_managed_snapshot(state, agent_id.clone(), watchdog.snapshot())
            .await
            .map_err(|error| op(error.to_string(), id))?;
        Ok(json!({"device_id":agent_id,"cleanup_complete":true}))
    }
}
/// Rechecks the token's current permissions and scope rather than trusting admission-time
/// authority, so editing a token also limits access to the work it already started.
fn recheck_operation_access(
    principal: &Principal,
    record: &super::operations::OperationRecord,
    id: &Value,
) -> Result<(), McpError> {
    match (record.kind.as_str(), record.device_ids.as_slice()) {
        ("command", [device]) => require(principal, &[CommandsExecute], device, id),
        (kind @ ("copy" | "move"), [source, destination]) => {
            let (source_permissions, destination_permissions) =
                transfer_permissions(kind == "move");
            require(principal, source_permissions, source, id)?;
            require(principal, destination_permissions, destination, id)
        }
        _ => Err(McpError::forbidden(
            "Operation is not accessible with this token",
            Some(id.clone()),
        )),
    }
}

/// Source and destination permissions of a copy or move: a move also removes the source.
fn transfer_permissions(is_move: bool) -> (&'static [Permission], &'static [Permission]) {
    if is_move {
        (&[FilesRead, FilesWrite, FilesDelete], &[FilesWrite])
    } else {
        (&[FilesRead], &[FilesWrite])
    }
}

/// Applies `Principal::require` to a device id stored in an operation record and reports
/// denial as an MCP error.
fn require(
    principal: &Principal,
    permissions: &[Permission],
    device: &str,
    id: &Value,
) -> Result<(), McpError> {
    principal
        .require(permissions, &AgentId::unchecked(device))
        .map_err(|error| McpError::denied(error, id))
}

/// Resolves an MCP device argument (a name or an id) and applies `Principal::require` to the
/// resolved id, so the scope check never sees a name that may now belong to another device.
async fn authorize_device(
    state: &ServerState,
    principal: &Principal,
    permissions: &[Permission],
    device: &str,
    id: &Value,
) -> Result<AgentId, McpError> {
    let agent_id = state
        .agents
        .resolve(device)
        .await
        .map_err(|error| op(error.to_string(), id))?;
    principal
        .require(permissions, &agent_id)
        .map_err(|error| McpError::denied(error, id))?;
    Ok(agent_id)
}

/// The token that owns new operations; MCP only admits token principals.
fn owner(principal: &Principal, id: &Value) -> Result<Uuid, McpError> {
    principal
        .token_id()
        .ok_or_else(|| McpError::forbidden("MCP requires an access token", Some(id.clone())))
}

/// Parses the shared search case vocabulary without silent fallback for invalid values.
fn case_sensitivity(args: &Map<String, Value>, id: &Value) -> Result<CaseSensitivity, McpError> {
    match args
        .get("case_sensitivity")
        .and_then(Value::as_str)
        .unwrap_or("smart")
    {
        "sensitive" => Ok(CaseSensitivity::Sensitive),
        "insensitive" => Ok(CaseSensitivity::Insensitive),
        "smart" => Ok(CaseSensitivity::Smart),
        _ => Err(invalid(
            "case_sensitivity must be smart, sensitive, or insensitive",
            id,
        )),
    }
}
/// Converts explicit MCP conflict policy into the existing transfer policy.
fn conflict_mode(value: &str, id: &Value) -> Result<CopyExistingMode, McpError> {
    match value {
        "error" | "create" => Ok(CopyExistingMode::Error),
        "replace" | "override" => Ok(CopyExistingMode::Override),
        "merge" => Ok(CopyExistingMode::Merge),
        _ => Err(invalid("on_existing must be error, replace, or merge", id)),
    }
}
/// Parses the repeated explicit device/absolute-path pair used by file tools.
fn device_path<'a>(
    args: &'a Map<String, Value>,
    id: &Value,
) -> Result<(&'a str, &'a str), McpError> {
    Ok((
        string(args, "device_id", id)?,
        absolute(string(args, "path", id)?, id)?,
    ))
}
/// Rejects cwd-dependent and NUL-containing remote path syntax.
fn absolute<'a>(path: &'a str, id: &Value) -> Result<&'a str, McpError> {
    if !path.starts_with('/') || path.contains('\0') {
        Err(invalid("path must be absolute and contain no NUL", id))
    } else {
        Ok(path)
    }
}
/// Provides uniform object validation for schema-driven dispatch.
fn object<'a>(
    value: &'a Value,
    name: &str,
    id: &Value,
) -> Result<&'a Map<String, Value>, McpError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{name} must be an object"), id))
}
/// Extracts a nonempty string while retaining the JSON-RPC request identifier.
fn string<'a>(object: &'a Map<String, Value>, key: &str, id: &Value) -> Result<&'a str, McpError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{key} must be a nonempty string"), id))
}
/// Constructs an argument error associated with this request.
fn invalid(message: impl Into<String>, id: &Value) -> McpError {
    McpError::invalid_params(message, Some(id.clone()))
}
/// Constructs a remote-operation error associated with this request.
fn op(message: impl Into<String>, id: &Value) -> McpError {
    McpError::operation(message, Some(id.clone()))
}
