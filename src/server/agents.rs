use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{
        AgentInfoResponse, AgentListResponse, Command, CommandResult, ErrorResponse,
        RestartResponse, ServerInfoResponse, ShutdownAgentResponse, StartAgentResponse,
    },
    types::AgentId,
};

use super::{
    agent_helpers::get_agent_details, responses::command_error_status, state::ServerState,
};

mod files;
mod open_path;
mod upgrade;

pub(crate) use files::{
    cat_agent_handler, echo_agent_handler, file_search_agent_handler, ls_agent_handler,
    metadata_agent_handler,
};
pub(crate) use open_path::open_path_agent_handler;
pub(crate) use upgrade::upgrade_agent_handler;

/// Route: `GET /api/v1/server` — identity and agent bootstrap settings for the authenticated UI.
pub(crate) async fn server_info_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let binary = redoor::commands::current_binary_identity();
    // Home page shows which on-disk binary is serving so upgrades can be verified.
    let (exe_path, external_ip) = tokio::join!(
        redoor::commands::current_exe_path(),
        redoor::commands::external_ip()
    );
    (
        StatusCode::OK,
        Json(ServerInfoResponse {
            app_name: state.app_name.clone(),
            agent_token: state.auth.agent_token().to_string(),
            config_path: state.config_path.display().to_string(),
            exe_path,
            auth_mode: state.auth_mode.clone(),
            external_ip,
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            version: binary.version,
            git_rev: binary.git_rev,
            git_dirty: binary.git_dirty,
            version_dirty: binary.version_dirty,
            build_mode: binary.build_mode,
            build_date: binary.build_date,
        }),
    )
        .into_response()
}

/// Loads and sorts retained inventory so every client receives stable ordering.
pub(super) async fn list_agent_snapshots(
    state: &ServerState,
) -> Result<Vec<AgentInfoResponse>, String> {
    let mut agents = state
        .router_ref
        .request(5000, |reply| actors::router::RouterMsg::GetAgentList {
            reply,
        })
        .await
        .map_err(|error| format!("Failed to get agents: {error:?}"))?
        .into_iter()
        .map(|agent| AgentInfoResponse {
            id: agent.id,
            name: agent.name,
            cwd: agent.default_directory,
            managed: agent.managed,
            configuration_editable: agent.configuration_editable,
            status: agent.status,
            connected_at: agent.connected_at,
            connection_id: agent.connection_id,
            last_seen_at: agent.last_seen_at,
            connection_issue: agent.connection_issue,
            binary: agent.binary,
            supports_self_exec: agent.supports_self_exec,
            supports_native_open: agent.supports_native_open,
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(agents)
}

/// Route: `GET /api/v1/agents` returns configured, connected, and previously seen agents.
pub(crate) async fn list_agents_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match list_agent_snapshots(&state).await {
        Ok(agents) => (StatusCode::OK, Json(AgentListResponse { agents })).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response(),
    }
}

/// Finds one retained inventory record while preserving unknown/unmanaged distinctions.
async fn managed_agent_snapshot(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<AgentInfoResponse, (StatusCode, ErrorResponse)> {
    let agents = list_agent_snapshots(state)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, ErrorResponse { error }))?;
    let agent = agents
        .into_iter()
        .find(|agent| &agent.id == agent_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                ErrorResponse {
                    error: format!("Agent not found: {agent_id}"),
                },
            )
        })?;
    if !agent.managed {
        return Err((
            StatusCode::CONFLICT,
            ErrorResponse {
                error: format!("Agent is external and cannot be managed: {agent_id}"),
            },
        ));
    }
    Ok(agent)
}

/// Waits until the router has projected a control snapshot and completed socket cleanup.
async fn apply_managed_snapshot(
    state: &ServerState,
    agent_id: AgentId,
    snapshot: redoor::watchdog::WatchdogSnapshot,
) -> Result<(), String> {
    state
        .router_ref
        .request(5000, |reply| {
            actors::router::RouterMsg::ApplyManagedLifecycle(
                actors::router::ApplyManagedLifecycleRequest {
                    agent_id,
                    snapshot,
                    reply: Some(reply),
                },
            )
        })
        .await
        .map_err(|error| format!("Failed to update managed inventory: {error:?}"))
}

/// Route: `POST /api/v1/agents/{agent}/start` accepts desired-running without waiting for connection.
pub(crate) async fn start_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    // Configuration edits hold this lock through shutdown and runtime replacement, so a
    // delayed tab start cannot land behind shutdown and revive the old supervisor.
    let _edit_guard = state.config_edit_lock.lock().await;
    let agent_id = AgentId::from(agent);
    let mut snapshot = match managed_agent_snapshot(&state, &agent_id).await {
        Ok(snapshot) => snapshot,
        Err((status, error)) => return (status, Json(error)).into_response(),
    };
    let Some(watchdog) = state.watchdog_registry.lookup(&snapshot.name) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Managed supervisor unavailable: {agent_id}"),
            }),
        )
            .into_response();
    };
    if let Err(error) = watchdog.start() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response();
    }
    let lifecycle = watchdog.snapshot();
    if let Err(error) = apply_managed_snapshot(&state, agent_id.clone(), lifecycle.clone()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response();
    }
    snapshot.status = lifecycle.status;
    snapshot.connection_issue = lifecycle.connection_issue;
    if snapshot.status != redoor::commands::AgentConnectionStatus::Connected {
        snapshot.connected_at = None;
    }
    (StatusCode::OK, Json(StartAgentResponse { agent: snapshot })).into_response()
}

/// Route: `POST /api/v1/agents/{agent}/shutdown` waits for owned child cleanup with a bound.
pub(crate) async fn shutdown_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    // Configuration replacement also mutates this supervisor; sharing the lock prevents
    // shutdown from racing a persist-then-register and reviving the outgoing identity.
    let _edit_guard = state.config_edit_lock.lock().await;
    let agent_id = AgentId::from(agent);
    let snapshot = match managed_agent_snapshot(&state, &agent_id).await {
        Ok(snapshot) => snapshot,
        Err((status, error)) => return (status, Json(error)).into_response(),
    };
    let Some(watchdog) = state.watchdog_registry.lookup(&snapshot.name) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Managed supervisor unavailable: {agent_id}"),
            }),
        )
            .into_response();
    };
    match tokio::time::timeout(std::time::Duration::from_secs(10), watchdog.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error }),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(ErrorResponse {
                    error: format!("Timed out shutting down managed agent: {agent_id}"),
                }),
            )
                .into_response();
        }
    }
    if let Err(error) = apply_managed_snapshot(&state, agent_id.clone(), watchdog.snapshot()).await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response();
    }
    match list_agent_snapshots(&state).await {
        Ok(agents) => match agents.into_iter().find(|agent| agent.id == agent_id) {
            Some(agent) => (StatusCode::OK, Json(ShutdownAgentResponse { agent })).into_response(),
            None => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Managed inventory disappeared: {agent_id}"),
                }),
            )
                .into_response(),
        },
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response(),
    }
}

/// Route: `GET /api/v1/agents/{agent}`
pub(crate) async fn get_agent_details_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());

    match get_agent_details(&state, &agent_id).await {
        Ok(details) => {
            if details.name.is_empty() {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: format!("Agent not found: {}", agent),
                    }),
                )
                    .into_response()
            } else {
                (StatusCode::OK, Json(details)).into_response()
            }
        }
        Err(response) => response,
    }
}

/// Route: `POST /api/v1/agents/{agent}/restart` asks the process to exec itself in place.
pub(crate) async fn restart_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent);
    match state
        .router_ref
        .request(5000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id,
                command: Command::Restart,
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::Restart) => {
            (StatusCode::OK, Json(RestartResponse { restarting: true })).into_response()
        }
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected response from agent restart".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to restart agent: {error:?}"),
            }),
        )
            .into_response(),
    }
}
