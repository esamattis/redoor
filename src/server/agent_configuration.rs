use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor::commands::{
    AgentConnectionStatus, AgentInfoResponse, CreateSshAgentRequest, CreateSshAgentResponse,
    ErrorResponse,
};

use crate::{
    config::{AgentConfig, append_ssh_agent},
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
