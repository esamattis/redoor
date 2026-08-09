use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{
        AgentInfoResponse, AgentListResponse, CatResponse, Command, CommandResult, EchoRequest,
        EchoResponse, ErrorResponse, LsDirectoryResponse, LsFileResponse, ServerInfoResponse,
        ShutdownAgentResponse, StartAgentResponse,
    },
    types::AgentId,
};

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url, get_agent_details},
    responses::command_error_status,
    state::ServerState,
};

/// Route: `GET /api/v1/server` — non-secret identity for the UI home page.
pub(crate) async fn server_info_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let binary = redoor::commands::current_binary_identity();
    // Home page shows which on-disk binary is serving so upgrades can be verified.
    let exe_path = redoor::commands::current_exe_path().await;
    (
        StatusCode::OK,
        Json(ServerInfoResponse {
            config_path: state.config_path.display().to_string(),
            exe_path,
            auth_mode: state.auth_mode.clone(),
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
async fn list_agent_snapshots(state: &ServerState) -> Result<Vec<AgentInfoResponse>, String> {
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
            status: agent.status,
            connected_at: agent.connected_at,
            last_seen_at: agent.last_seen_at,
            connection_issue: agent.connection_issue,
            binary: agent.binary,
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

/// Route: `GET /api/v1/agents/{agent}/ls/{*path}`
pub(crate) async fn ls_agent_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent.clone());
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Ls { path: Some(path) },
                reply,
            })
        })
        .await
    {
        Ok(result) => match result {
            CommandResult::LsDirectory(ls_result) => (
                StatusCode::OK,
                Json(LsDirectoryResponse {
                    files: ls_result.files,
                    path: ls_result.path,
                    owner: ls_result.owner,
                    group: ls_result.group,
                    uid: ls_result.uid,
                    gid: ls_result.gid,
                    permissions: ls_result.permissions,
                }),
            )
                .into_response(),
            CommandResult::LsFile(ls_result) => (
                StatusCode::OK,
                Json(LsFileResponse {
                    size: ls_result.size,
                    path: ls_result.path,
                    owner: ls_result.owner,
                    group: ls_result.group,
                    uid: ls_result.uid,
                    gid: ls_result.gid,
                    permissions: ls_result.permissions,
                }),
            )
                .into_response(),
            CommandResult::Error { kind, message } => {
                let status = command_error_status(&kind);
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(error) => {
            let error_msg = format!("Failed to execute ls command: {:?}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

/// Route: `GET /api/v1/agents/{agent}/cat/{*path}`
pub(crate) async fn cat_agent_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent.clone());
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Cat { path },
                reply,
            })
        })
        .await
    {
        Ok(result) => match result {
            CommandResult::Cat(cat_result) => (
                StatusCode::OK,
                Json(CatResponse {
                    content: cat_result.content,
                    path: cat_result.path,
                }),
            )
                .into_response(),
            CommandResult::Error { kind, message } => {
                let status = command_error_status(&kind);
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(error) => {
            let error_msg = format!("Failed to execute cat command: {:?}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

/// Route: `GET /api/v1/agents/{agent}/metadata/{*path}`
pub(crate) async fn metadata_agent_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent.clone());
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Metadata { path: path.clone() },
                reply,
            })
        })
        .await
    {
        Ok(result) => match result {
            CommandResult::Metadata(mut metadata) => {
                metadata.one_time_tokens = state.one_time_token_registry.list(&agent_id, &path);
                (StatusCode::OK, Json(metadata)).into_response()
            }
            CommandResult::Error { kind, message } => {
                let status = command_error_status(&kind);
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(error) => {
            let error_msg = format!("Failed to execute metadata command: {:?}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

/// Route: `POST /api/v1/agents/{agent}/echo`
pub(crate) async fn echo_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<EchoRequest>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::Echo {
                    request: payload.clone(),
                },
                reply,
            })
        })
        .await
    {
        Ok(result) => match result {
            CommandResult::Echo(echo_result) => (
                StatusCode::OK,
                Json(EchoResponse {
                    message: echo_result.message,
                }),
            )
                .into_response(),
            CommandResult::Error { kind, message } => (
                command_error_status(&kind),
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(error) => {
            let error_msg = format!("Failed to execute echo command: {:?}", error);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}
