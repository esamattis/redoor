//! REST routes of systemd unit management, thin adapters over the agent's systemd commands.
//!
//! The routes are session-only (see `access::routes`): access tokens and MCP manage systemd
//! through exec instead. The agent enforces who may act on which manager, so these handlers
//! only map URLs to scopes and pass the agent's typed failures on.

use super::{
    access::ResolvedDevice,
    agent_client::{
        STANDARD_TIMEOUT, SystemdDaemonReload, SystemdJournal, SystemdListUnits, SystemdOverview,
        SystemdPathStatus, SystemdSetLinger, SystemdUnitAction, SystemdUnitDetails,
    },
    error::ApiError,
    services::output::OutputStream,
    state::ServerState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    response::Response,
};
use redoor_protocol::api::systemd::{
    DEFAULT_JOURNAL_LINES, MAX_JOURNAL_LINES, SystemdDaemonReloadResponse, SystemdJournalQuery,
    SystemdLingerRequest, SystemdLingerResponse, SystemdOverviewResponse, SystemdPathStatusQuery,
    SystemdPathStatusResponse, SystemdScope, SystemdUnitActionRequest, SystemdUnitDetailsResponse,
    SystemdUnitListResponse,
};
use serde::Deserialize;

/// The `{unit}` of a system manager route; `{agent}` comes from [`ResolvedDevice`].
#[derive(Deserialize)]
pub(crate) struct SystemUnitPath {
    unit: String,
}

/// The `{user}` of a user manager route.
#[derive(Deserialize)]
pub(crate) struct UserPath {
    user: String,
}

/// The `{user}` and `{unit}` of a user manager unit route.
#[derive(Deserialize)]
pub(crate) struct UserUnitPath {
    user: String,
    unit: String,
}

/// Route: `GET /api/v1/agents/{agent}/systemd` describes the agent account's systemd
/// situation and, for root agents, the other accounts' managers.
pub(crate) async fn systemd_overview_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
) -> Result<Json<SystemdOverviewResponse>, ApiError> {
    Ok(Json(
        state.agents.call(&agent_id, SystemdOverview {}).await?,
    ))
}

/// Route: `GET /api/v1/agents/{agent}/systemd/system/units`.
pub(crate) async fn system_units_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
) -> Result<Json<SystemdUnitListResponse>, ApiError> {
    list_units(&state, &agent_id, SystemdScope::System).await
}

/// Route: `GET /api/v1/agents/{agent}/systemd/user/{user}/units`.
pub(crate) async fn user_units_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(UserPath { user }): Path<UserPath>,
    State(state): State<ServerState>,
) -> Result<Json<SystemdUnitListResponse>, ApiError> {
    list_units(&state, &agent_id, SystemdScope::User { name: user }).await
}

/// Route: `GET /api/v1/agents/{agent}/systemd/system/units/{unit}`.
pub(crate) async fn system_unit_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(SystemUnitPath { unit }): Path<SystemUnitPath>,
    State(state): State<ServerState>,
) -> Result<Json<SystemdUnitDetailsResponse>, ApiError> {
    unit_details(&state, &agent_id, SystemdScope::System, unit).await
}

/// Route: `GET /api/v1/agents/{agent}/systemd/user/{user}/units/{unit}`.
pub(crate) async fn user_unit_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(UserUnitPath { user, unit }): Path<UserUnitPath>,
    State(state): State<ServerState>,
) -> Result<Json<SystemdUnitDetailsResponse>, ApiError> {
    unit_details(&state, &agent_id, SystemdScope::User { name: user }, unit).await
}

/// Route: `POST /api/v1/agents/{agent}/systemd/system/units/{unit}/actions`.
pub(crate) async fn system_unit_action_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(SystemUnitPath { unit }): Path<SystemUnitPath>,
    State(state): State<ServerState>,
    Json(request): Json<SystemdUnitActionRequest>,
) -> Result<Json<SystemdUnitDetailsResponse>, ApiError> {
    unit_action(&state, &agent_id, SystemdScope::System, unit, request).await
}

/// Route: `POST /api/v1/agents/{agent}/systemd/user/{user}/units/{unit}/actions`.
pub(crate) async fn user_unit_action_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(UserUnitPath { user, unit }): Path<UserUnitPath>,
    State(state): State<ServerState>,
    Json(request): Json<SystemdUnitActionRequest>,
) -> Result<Json<SystemdUnitDetailsResponse>, ApiError> {
    unit_action(
        &state,
        &agent_id,
        SystemdScope::User { name: user },
        unit,
        request,
    )
    .await
}

/// Route: `GET /api/v1/agents/{agent}/systemd/system/units/{unit}/journal?lines=`.
pub(crate) async fn system_unit_journal_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(SystemUnitPath { unit }): Path<SystemUnitPath>,
    Query(query): Query<SystemdJournalQuery>,
    State(state): State<ServerState>,
) -> Result<Response, ApiError> {
    journal(&state, agent_id, SystemdScope::System, unit, query).await
}

/// Route: `GET /api/v1/agents/{agent}/systemd/user/{user}/units/{unit}/journal?lines=`.
pub(crate) async fn user_unit_journal_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(UserUnitPath { user, unit }): Path<UserUnitPath>,
    Query(query): Query<SystemdJournalQuery>,
    State(state): State<ServerState>,
) -> Result<Response, ApiError> {
    journal(
        &state,
        agent_id,
        SystemdScope::User { name: user },
        unit,
        query,
    )
    .await
}

/// Route: `POST /api/v1/agents/{agent}/systemd/system/daemon-reload`.
pub(crate) async fn system_daemon_reload_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
) -> Result<Json<SystemdDaemonReloadResponse>, ApiError> {
    daemon_reload(&state, &agent_id, SystemdScope::System).await
}

/// Route: `POST /api/v1/agents/{agent}/systemd/user/{user}/daemon-reload`.
pub(crate) async fn user_daemon_reload_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(UserPath { user }): Path<UserPath>,
    State(state): State<ServerState>,
) -> Result<Json<SystemdDaemonReloadResponse>, ApiError> {
    daemon_reload(&state, &agent_id, SystemdScope::User { name: user }).await
}

/// Route: `PUT /api/v1/agents/{agent}/systemd/user/{user}/linger` enables or disables
/// linger, so the user's manager runs without a login session.
pub(crate) async fn user_linger_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(UserPath { user }): Path<UserPath>,
    State(state): State<ServerState>,
    Json(request): Json<SystemdLingerRequest>,
) -> Result<Json<SystemdLingerResponse>, ApiError> {
    let call = SystemdSetLinger {
        user,
        enabled: request.enabled,
    };
    Ok(Json(state.agents.call(&agent_id, call).await?))
}

/// Route: `GET /api/v1/agents/{agent}/systemd/path-status?path=&user=` tells the editor and
/// the unit file view which managers load a file and whether a daemon-reload is due.
pub(crate) async fn path_status_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Query(SystemdPathStatusQuery { path, user }): Query<SystemdPathStatusQuery>,
    State(state): State<ServerState>,
) -> Result<Json<SystemdPathStatusResponse>, ApiError> {
    Ok(Json(
        state
            .agents
            .call(&agent_id, SystemdPathStatus { path, user })
            .await?,
    ))
}

/// Lists one manager's units.
async fn list_units(
    state: &ServerState,
    agent_id: &redoor_protocol::ids::AgentId,
    scope: SystemdScope,
) -> Result<Json<SystemdUnitListResponse>, ApiError> {
    Ok(Json(
        state
            .agents
            .call(agent_id, SystemdListUnits { scope })
            .await?,
    ))
}

/// Reads one unit's status.
async fn unit_details(
    state: &ServerState,
    agent_id: &redoor_protocol::ids::AgentId,
    scope: SystemdScope,
    unit: String,
) -> Result<Json<SystemdUnitDetailsResponse>, ApiError> {
    Ok(Json(
        state
            .agents
            .call(agent_id, SystemdUnitDetails { scope, unit })
            .await?,
    ))
}

/// Runs one unit action and answers with the unit's status afterwards.
async fn unit_action(
    state: &ServerState,
    agent_id: &redoor_protocol::ids::AgentId,
    scope: SystemdScope,
    unit: String,
    request: SystemdUnitActionRequest,
) -> Result<Json<SystemdUnitDetailsResponse>, ApiError> {
    let call = SystemdUnitAction {
        scope,
        unit,
        action: request.action,
    };
    Ok(Json(state.agents.call(agent_id, call).await?))
}

/// Makes one manager reload its unit files.
async fn daemon_reload(
    state: &ServerState,
    agent_id: &redoor_protocol::ids::AgentId,
    scope: SystemdScope,
) -> Result<Json<SystemdDaemonReloadResponse>, ApiError> {
    state
        .agents
        .call(
            agent_id,
            SystemdDaemonReload {
                scope: scope.clone(),
            },
        )
        .await?;
    Ok(Json(SystemdDaemonReloadResponse { scope }))
}

/// Streams a unit's journal as NDJSON `SystemdJournalEvent` lines: the last lines, then live
/// entries until the client goes away, which stops `journalctl` on the agent.
async fn journal(
    state: &ServerState,
    agent_id: redoor_protocol::ids::AgentId,
    scope: SystemdScope,
    unit: String,
    query: SystemdJournalQuery,
) -> Result<Response, ApiError> {
    let lines = query.lines.unwrap_or(DEFAULT_JOURNAL_LINES);
    if lines > MAX_JOURNAL_LINES {
        return Err(ApiError::bad_request(format!(
            "At most {MAX_JOURNAL_LINES} journal lines can be requested"
        )));
    }
    let command = SystemdJournal { scope, unit, lines }.into();
    let output = OutputStream::open_events(
        &state.router_ref,
        agent_id,
        command,
        STANDARD_TIMEOUT,
        "Journal",
    )
    .await?;
    Ok(output.into_ndjson_response())
}
