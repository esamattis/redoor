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
        EchoResponse, ErrorResponse, LsDirectoryResponse, LsFileResponse, RestartResponse,
        ServerInfoResponse, ShutdownAgentResponse, StartAgentResponse, UpgradeAgentResponse,
    },
    types::AgentId,
};

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url, get_agent_details},
    raw::{AgentUpload, AgentUploadStartError},
    responses::command_error_status,
    state::ServerState,
};

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
            connection_id: agent.connection_id,
            last_seen_at: agent.last_seen_at,
            connection_issue: agent.connection_issue,
            binary: agent.binary,
            supports_self_exec: agent.supports_self_exec,
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

/// Maps upload setup completion into the normal command/router error JSON contract.
fn upgrade_upload_start_error(error: AgentUploadStartError) -> axum::response::Response {
    match error {
        AgentUploadStartError::Response(response) => response,
        AgentUploadStartError::Finished(completion) => match *completion {
            Ok(CommandResult::Error { kind, message }) => (
                command_error_status(&kind),
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
            Ok(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected early upgrade upload completion".to_string(),
                }),
            )
                .into_response(),
            Err(error) => super::responses::router_error_response(error),
        },
    }
}

/// Maps binary selection failures to stable operator-facing upgrade responses.
fn upgrade_binary_error_response(
    error: crate::binaries::UpgradeBinaryError,
) -> axum::response::Response {
    let status = match error {
        crate::binaries::UpgradeBinaryError::DirtyPlatformMismatch { .. } => StatusCode::CONFLICT,
        crate::binaries::UpgradeBinaryError::UnsupportedPlatform { .. } => StatusCode::BAD_REQUEST,
        crate::binaries::UpgradeBinaryError::Provision(_) => StatusCode::BAD_GATEWAY,
    };
    (
        status,
        Json(ErrorResponse {
            error: error.to_string(),
        }),
    )
        .into_response()
}

/// Streams one local executable through the same bounded transfer producer as HTTP PUT.
async fn upload_upgrade_binary(
    state: &ServerState,
    agent_id: AgentId,
    source_path: &std::path::Path,
    destination_path: &str,
) -> Result<(), axum::response::Response> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(source_path).await.map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: format!("Failed to open upgrade binary: {error}"),
            }),
        )
            .into_response()
    })?;
    let total_bytes = file
        .metadata()
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: format!("Failed to inspect upgrade binary: {error}"),
                }),
            )
                .into_response()
        })?
        .len();
    let mut upload = AgentUpload::start(
        state,
        agent_id,
        Command::RawUpload {
            path: destination_path.to_string(),
        },
        destination_path.to_string(),
        total_bytes,
    )
    .await
    .map_err(upgrade_upload_start_error)?;
    let mut buffer = vec![0; redoor::streaming::CHUNK_SIZE];
    loop {
        let bytes_read = file.read(&mut buffer).await.map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: format!("Failed to read upgrade binary: {error}"),
                }),
            )
                .into_response()
        })?;
        if bytes_read == 0 {
            break;
        }
        upload.send(&buffer[..bytes_read]).await?;
    }
    match upload.finish().await? {
        (CommandResult::RawUpload, _) => Ok(()),
        (CommandResult::Error { kind, message }, _) => Err((
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response()),
        _ => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected upgrade upload completion".to_string(),
            }),
        )
            .into_response()),
    }
}

/// Route: `POST /api/v1/agents/{agent}/upgrade` installs and execs the server's build.
pub(crate) async fn upgrade_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let agent_id = AgentId::from(agent.clone());
    let snapshot = match list_agent_snapshots(&state).await {
        Ok(agents) => agents.into_iter().find(|entry| entry.id == agent_id),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error }),
            )
                .into_response();
        }
    };
    let Some(snapshot) = snapshot else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent not found: {agent}"),
            }),
        )
            .into_response();
    };
    if snapshot.status != redoor::commands::AgentConnectionStatus::Connected {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: format!("Agent is not connected: {agent}"),
            }),
        )
            .into_response();
    }
    if !snapshot.supports_self_exec {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: format!(
                    "Agent does not support safe self-exec upgrades: {agent}. Install a current Redoor agent manually, reconnect it, and retry the upgrade."
                ),
            }),
        )
            .into_response();
    }
    let details = match get_agent_details(&state, &agent_id).await {
        Ok(details) => details,
        Err(response) => return response,
    };
    if details.exe_path == "unknown" || !std::path::Path::new(&details.exe_path).is_absolute() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Agent executable path is unusable: {}", details.exe_path),
            }),
        )
            .into_response();
    }
    let server_binary = redoor::commands::current_binary_identity();
    let selected = match crate::binaries::binary_for_connected_agent(
        &server_binary,
        &details.os,
        &details.arch,
    )
    .await
    {
        Ok(selected) => selected,
        Err(error) => return upgrade_binary_error_response(error),
    };
    let source_path = match selected {
        crate::binaries::UpgradeBinary::ExactServer { path }
        | crate::binaries::UpgradeBinary::CachedRelease { path } => path,
    };
    if let Err(response) =
        upload_upgrade_binary(&state, agent_id.clone(), &source_path, &details.exe_path).await
    {
        return response;
    }
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id,
                command: Command::SelfExec {
                    path: details.exe_path,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::SelfExec { .. }) => (
            StatusCode::OK,
            Json(UpgradeAgentResponse {
                upgrading: true,
                target_version: server_binary.version,
            }),
        )
            .into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected response from agent self-exec".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to self-exec upgraded agent: {error:?}"),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unsupported release pairs return a client error with the exact rejected target.
    #[tokio::test]
    async fn unsupported_upgrade_platform_response_is_actionable() {
        let response = upgrade_binary_error_response(
            crate::binaries::UpgradeBinaryError::UnsupportedPlatform {
                os: "macos".to_string(),
                arch: "x86_64".to_string(),
            },
        );
        // A nonexistent release artifact is a target validation error, not an upstream outage.
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let error: ErrorResponse = serde_json::from_slice(&body).unwrap();
        // Naming the exact pair lets operators select one emitted by release.yml.
        assert_eq!(
            error.error,
            "Unsupported Redoor release platform: macos/x86_64"
        );
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
