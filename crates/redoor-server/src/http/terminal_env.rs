//! REST endpoint that edits a managed device's terminal environment variables, and the
//! environment every new terminal shell is started with.

use super::{
    access::ResolvedDevice, agent_configuration::find_configured_agent, error::ApiError,
    state::ServerState,
};
use axum::{Json, extract::State};
use redoor_protocol::{
    api::terminal_env::{TerminalEnvResponse, UpdateTerminalEnvRequest},
    ids::AgentId,
    wire::terminal::{REDOOR_SERVER_ENV, validate_terminal_env},
};
use std::collections::BTreeMap;

/// Route: `PUT /api/v1/agents/{agent}/terminal-env` replaces the `terminal_env` of a managed
/// SSH or local device.
///
/// Unlike the device edit it does not stop the agent: the variables only reach shells started
/// later, so the running ones keep going. A standalone agent has no entry in the server's
/// config and is reported as not found.
pub(crate) async fn update_terminal_env_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
    Json(request): Json<UpdateTerminalEnvRequest>,
) -> Result<Json<TerminalEnvResponse>, ApiError> {
    validate_terminal_env(&request.env).map_err(ApiError::bad_request)?;
    let _edit_guard = state.config_edit_lock.lock().await;
    if find_configured_agent(&state, &agent_id).await?.is_none() {
        return Err(ApiError::not_found(format!(
            "Managed agent '{agent_id}' was not found"
        )));
    }
    redoor_core::config::set_terminal_env(&state.config_path, &agent_id, &request.env)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(TerminalEnvResponse { env: request.env }))
}

/// The variables a new shell on `agent_id` starts with: the device's `terminal_env` from the
/// config, read on every start so an edit applies to the next shell without a restart, and
/// [`REDOOR_SERVER_ENV`] with this server's hostname.
pub(crate) async fn terminal_shell_env(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<BTreeMap<String, String>, ApiError> {
    let mut env = find_configured_agent(state, agent_id)
        .await?
        .map(|config| config.terminal_env().clone())
        .unwrap_or_default();
    env.insert(
        REDOOR_SERVER_ENV.to_string(),
        super::server_info::server_hostname(),
    );
    Ok(env)
}
