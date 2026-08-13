use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::actors::router::{RouterMsg, UnregisterManagedAgentRequest};
use redoor::commands::{
    AgentConnectionStatus, AgentInfoResponse, CreateSshAgentRequest, CreateSshAgentResponse,
    DeleteManagedAgentResponse, ErrorResponse, ManagedSshAgentConfigurationResponse,
    UpdateSshAgentResponse,
};

use crate::{
    config::{
        AgentConfig, append_ssh_agent, delete_ssh_agent, parse_config_file, replace_ssh_agent,
    },
    ssh::SshBackedAgentConfig,
};

use super::{agents::list_agent_snapshots, state::ServerState, watchdog};

/// Route: `POST /api/v1/agents` persists and immediately registers one SSH-backed agent.
pub(crate) async fn create_ssh_agent_handler(
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<CreateSshAgentRequest>,
) -> impl IntoResponse {
    match create_ssh_agent(&state, request).await {
        Ok(agent) => (StatusCode::CREATED, Json(CreateSshAgentResponse { agent })).into_response(),
        Err((status, error)) => (status, Json(ErrorResponse { error })).into_response(),
    }
}

/// Route: `GET /api/v1/agents/{agent}/configuration` returns editable SSH TOML fields.
pub(crate) async fn get_ssh_agent_configuration_handler(
    Path(agent_id): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match find_ssh_agent(&state, &agent_id).await {
        Ok(config) => (
            StatusCode::OK,
            Json(ManagedSshAgentConfigurationResponse::from(config)),
        )
            .into_response(),
        Err((status, error)) => (status, Json(ErrorResponse { error })).into_response(),
    }
}

/// Route: `PUT /api/v1/agents/{agent}` replaces one stopped SSH-backed TOML entry.
pub(crate) async fn update_ssh_agent_handler(
    Path(agent_id): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<CreateSshAgentRequest>,
) -> impl IntoResponse {
    match update_ssh_agent(&state, &agent_id, request).await {
        Ok(agent) => (StatusCode::OK, Json(UpdateSshAgentResponse { agent })).into_response(),
        Err((status, error)) => (status, Json(ErrorResponse { error })).into_response(),
    }
}

/// Route: `DELETE /api/v1/agents/{agent}` removes one stopped SSH-backed TOML entry.
pub(crate) async fn delete_ssh_agent_handler(
    Path(agent_id): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match delete_managed_ssh_agent(&state, &agent_id).await {
        Ok(()) => (
            StatusCode::OK,
            Json(DeleteManagedAgentResponse { deleted: true }),
        )
            .into_response(),
        Err((status, error)) => (status, Json(ErrorResponse { error })).into_response(),
    }
}

/// Serializes persistence and runtime registration so effective names stay unique.
async fn create_ssh_agent(
    state: &ServerState,
    request: CreateSshAgentRequest,
) -> Result<AgentInfoResponse, (StatusCode, String)> {
    let config = validate_request(request).map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    let agent_config = AgentConfig::SshBacked(config.clone());
    let agent_id = watchdog::supervisor_key(&agent_config);
    let _edit_guard = state.config_edit_lock.lock().await;

    let existing = list_agent_snapshots(state)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
    if existing
        .iter()
        .any(|agent| agent.id.to_string() == agent_id)
    {
        return Err((
            StatusCode::CONFLICT,
            format!("Agent '{agent_id}' already exists"),
        ));
    }

    append_ssh_agent(&state.config_path, &config)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let registered_id = watchdog::register_agent(
        agent_config,
        state.port,
        state.auth.agent_token(),
        &state.watchdog_registry,
        &state.router_ref,
    )
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(AgentInfoResponse {
        id: registered_id.clone(),
        name: registered_id.to_string(),
        cwd: config.home,
        managed: true,
        configuration_editable: true,
        status: AgentConnectionStatus::Stopped,
        connected_at: None,
        connection_id: None,
        last_seen_at: None,
        connection_issue: None,
        binary: None,
        supports_self_exec: false,
        supports_native_open: false,
    })
}

/// Replaces durable and runtime configuration while the old supervisor is dormant.
async fn update_ssh_agent(
    state: &ServerState,
    old_id: &str,
    request: CreateSshAgentRequest,
) -> Result<AgentInfoResponse, (StatusCode, String)> {
    let config = validate_request(request).map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    let agent_config = AgentConfig::SshBacked(config.clone());
    let new_id = watchdog::supervisor_key(&agent_config);
    let _edit_guard = state.config_edit_lock.lock().await;
    let _existing_config = find_ssh_agent(state, old_id).await?;
    stop_for_configuration_change(state, old_id).await?;

    if new_id != old_id {
        let existing = list_agent_snapshots(state)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))?;
        if existing.iter().any(|agent| agent.id.to_string() == new_id) {
            return Err((
                StatusCode::CONFLICT,
                format!("Agent '{new_id}' already exists"),
            ));
        }
    }

    replace_ssh_agent(&state.config_path, old_id, &config)
        .await
        .map_err(internal_error)?;
    unregister_runtime_agent(state, old_id).await?;
    let registered_id = watchdog::register_agent(
        agent_config,
        state.port,
        state.auth.agent_token(),
        &state.watchdog_registry,
        &state.router_ref,
    )
    .await
    .map_err(internal_error)?;
    Ok(stopped_agent_response(registered_id, config.home))
}

/// Deletes durable configuration only after confirming no managed process is running.
async fn delete_managed_ssh_agent(
    state: &ServerState,
    agent_id: &str,
) -> Result<(), (StatusCode, String)> {
    let _edit_guard = state.config_edit_lock.lock().await;
    let _existing_config = find_ssh_agent(state, agent_id).await?;
    stop_for_configuration_change(state, agent_id).await?;
    delete_ssh_agent(&state.config_path, agent_id)
        .await
        .map_err(internal_error)?;
    unregister_runtime_agent(state, agent_id).await
}

/// Removes the dormant supervisor and retained router inventory together.
async fn unregister_runtime_agent(
    state: &ServerState,
    agent_id: &str,
) -> Result<(), (StatusCode, String)> {
    state
        .watchdog_registry
        .remove_stopped(agent_id)
        .map_err(internal_error)?;
    state
        .router_ref
        .request(5000, |reply| {
            RouterMsg::UnregisterManagedAgent(UnregisterManagedAgentRequest {
                agent_id: agent_id.to_string().into(),
                reply,
            })
        })
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to unregister managed inventory: {error:?}"),
            )
        })
}

/// Settles any delayed start before persistence while the shared edit lock blocks new starts.
async fn stop_for_configuration_change(
    state: &ServerState,
    agent_id: &str,
) -> Result<(), (StatusCode, String)> {
    let handle = state.watchdog_registry.lookup(agent_id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("Managed SSH agent '{agent_id}' was not found"),
        )
    })?;
    if handle.snapshot().desired_running {
        tokio::time::timeout(std::time::Duration::from_secs(10), handle.shutdown())
            .await
            .map_err(|_| {
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    format!("Timed out stopping managed agent: {agent_id}"),
                )
            })?
            .map_err(internal_error)?;
    }
    Ok(())
}

/// Reloads the source of truth so edits include values unavailable in public inventory.
async fn find_ssh_agent(
    state: &ServerState,
    agent_id: &str,
) -> Result<SshBackedAgentConfig, (StatusCode, String)> {
    let path = state.config_path.to_string_lossy();
    let config = parse_config_file(&path).await.map_err(internal_error)?;
    config
        .agents
        .into_iter()
        .find_map(|config| (watchdog::supervisor_key(&config) == agent_id).then_some(config))
        .and_then(|config| match config {
            AgentConfig::SshBacked(config) => Some(config),
            AgentConfig::Local(_) => None,
        })
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Managed SSH agent '{agent_id}' was not found"),
            )
        })
}

/// Maps unexpected persistence/runtime failures to one consistent REST error shape.
fn internal_error(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// Builds the public dormant projection shared by create and update responses.
fn stopped_agent_response(
    agent_id: redoor::types::AgentId,
    home: Option<String>,
) -> AgentInfoResponse {
    AgentInfoResponse {
        id: agent_id.clone(),
        name: agent_id.to_string(),
        cwd: home,
        managed: true,
        configuration_editable: true,
        status: AgentConnectionStatus::Stopped,
        connected_at: None,
        connection_id: None,
        last_seen_at: None,
        connection_issue: None,
        binary: None,
        supports_self_exec: false,
        supports_native_open: false,
    }
}

/// Normalizes optional text and rejects values that would create unusable TOML entries.
fn validate_request(request: CreateSshAgentRequest) -> Result<SshBackedAgentConfig, String> {
    let target = request.target.trim().to_string();
    if target.is_empty() {
        return Err("SSH target is required".to_string());
    }
    if request.ssh_port == Some(0) {
        return Err("SSH port must be between 1 and 65535".to_string());
    }
    Ok(SshBackedAgentConfig {
        target,
        username: optional_text(request.username),
        ssh_port: request.ssh_port,
        name: optional_text(request.name),
        remote_bin: optional_text(request.remote_bin),
        home: optional_text(request.home),
        log: optional_text(request.log),
        password: optional_password(request.password),
    })
}

/// Treats whitespace-only optional form fields as omitted settings.
fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

/// Keeps leading or trailing spaces that are part of the password, unlike other form fields.
fn optional_password(value: Option<String>) -> Option<String> {
    value.and_then(|value| (!value.is_empty()).then_some(value))
}

impl From<SshBackedAgentConfig> for ManagedSshAgentConfigurationResponse {
    /// Exposes exactly the persisted fields needed to initialize the shared UI form.
    fn from(config: SshBackedAgentConfig) -> Self {
        Self {
            target: config.target,
            username: config.username,
            ssh_port: config.ssh_port,
            name: config.name,
            remote_bin: config.remote_bin,
            home: config.home,
            log: config.log,
            password: config.password,
        }
    }
}
