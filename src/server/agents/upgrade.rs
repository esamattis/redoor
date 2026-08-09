use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    Level, actors,
    commands::{Command, CommandResult, ErrorResponse, UpgradeAgentRequest, UpgradeAgentResponse},
    log,
    types::AgentId,
};

use super::list_agent_snapshots;
use crate::server::{
    agent_helpers::get_agent_details,
    raw::{AgentUpload, AgentUploadStartError},
    responses::command_error_status,
    state::ServerState,
};

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
            Err(error) => crate::server::responses::router_error_response(error),
        },
    }
}

/// Maps binary selection failures to stable operator-facing upgrade responses.
fn upgrade_binary_error_response(
    error: crate::binaries::UpgradeBinaryError,
) -> axum::response::Response {
    let status = match error {
        crate::binaries::UpgradeBinaryError::InvalidVersion { .. }
        | crate::binaries::UpgradeBinaryError::UnsupportedPlatform { .. } => {
            StatusCode::BAD_REQUEST
        }
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

/// Rejects a running server executable that cannot target the agent CPU.
fn running_server_architecture_error(agent_arch: &str) -> Option<axum::response::Response> {
    if agent_arch == std::env::consts::ARCH {
        return None;
    }
    Some(
        (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: format!(
                    "Cannot install the running server binary: server architecture is {}, but agent architecture is {agent_arch}",
                    std::env::consts::ARCH
                ),
            }),
        )
            .into_response(),
    )
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
    log!(
        Level::Info,
        "Uploading agent upgrade binary: agent_id={}, source={}, destination={}, bytes={}",
        agent_id,
        source_path.display(),
        destination_path,
        total_bytes
    );
    let mut upload = AgentUpload::start(
        state,
        agent_id.clone(),
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
        (CommandResult::RawUpload, _) => {
            log!(
                Level::Info,
                "Agent upgrade binary upload completed: agent_id={}, destination={}, bytes={}",
                agent_id,
                destination_path,
                total_bytes
            );
            Ok(())
        }
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

/// Route: `POST /api/v1/agents/{agent}/upgrade` installs and execs a selected release.
pub(crate) async fn upgrade_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<UpgradeAgentRequest>,
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
    let (source_path, target_version, binary_source) = match request {
        UpgradeAgentRequest::PublishedRelease { target_version } => {
            log!(
                Level::Info,
                "Preparing agent upgrade: agent_id={}, current_version={}, target_version={}, source=published_release, os={}, arch={}, executable={}",
                agent_id,
                details.binary.version,
                target_version,
                details.os,
                details.arch,
                details.exe_path
            );
            let source_path = match crate::binaries::ensure_local_binary(
                &target_version,
                &details.os,
                &details.arch,
            )
            .await
            {
                Ok(source_path) => source_path,
                Err(error) => {
                    log!(
                        Level::Info,
                        "Agent upgrade binary preparation failed: agent_id={}, target_version={}, source=published_release, os={}, arch={}, error={}",
                        agent_id,
                        target_version,
                        details.os,
                        details.arch,
                        error
                    );
                    return upgrade_binary_error_response(error);
                }
            };
            (source_path, target_version, "published_release")
        }
        UpgradeAgentRequest::RunningServer => {
            let server_binary = redoor::commands::current_binary_identity();
            log!(
                Level::Info,
                "Preparing agent upgrade: agent_id={}, current_version={}, target_version={}, source=running_server, os={}, arch={}, executable={}",
                agent_id,
                details.binary.version,
                server_binary.version,
                details.os,
                details.arch,
                details.exe_path
            );
            if let Some(response) = running_server_architecture_error(&details.arch) {
                log!(
                    Level::Info,
                    "Running server binary architecture mismatch: agent_id={}, server_arch={}, agent_arch={}",
                    agent_id,
                    std::env::consts::ARCH,
                    details.arch
                );
                return response;
            }
            let source_path = redoor::commands::current_exe_path().await;
            if source_path == "unknown" {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Cannot locate the running server binary".to_string(),
                    }),
                )
                    .into_response();
            }
            (
                std::path::PathBuf::from(source_path),
                server_binary.version,
                "running_server",
            )
        }
    };
    log!(
        Level::Info,
        "Agent upgrade binary ready: agent_id={}, target_version={}, source_kind={}, os={}, arch={}, path={}",
        agent_id,
        target_version,
        binary_source,
        details.os,
        details.arch,
        source_path.display()
    );
    if let Err(response) =
        upload_upgrade_binary(&state, agent_id.clone(), &source_path, &details.exe_path).await
    {
        log!(
            Level::Info,
            "Agent upgrade binary upload failed: agent_id={}, target_version={}, source={}",
            agent_id,
            target_version,
            binary_source
        );
        return response;
    }
    log!(
        Level::Info,
        "Requesting upgraded agent self-exec: agent_id={}, target_version={}, source={}, executable={}",
        agent_id,
        target_version,
        binary_source,
        details.exe_path
    );
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::SelfExec {
                    path: details.exe_path,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::SelfExec { .. }) => {
            log!(
                Level::Info,
                "Agent acknowledged upgrade self-exec: agent_id={}, target_version={}",
                agent_id,
                target_version
            );
            (
                StatusCode::OK,
                Json(UpgradeAgentResponse {
                    upgrading: true,
                    target_version,
                }),
            )
                .into_response()
        }
        Ok(CommandResult::Error { kind, message }) => {
            log!(
                Level::Info,
                "Agent upgrade self-exec rejected: agent_id={}, target_version={}, kind={:?}, error={}",
                agent_id,
                target_version,
                kind,
                message
            );
            (
                command_error_status(&kind),
                Json(ErrorResponse { error: message }),
            )
                .into_response()
        }
        Ok(_) => {
            log!(
                Level::Info,
                "Agent upgrade self-exec returned an unexpected response: agent_id={}, target_version={}",
                agent_id,
                target_version
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected response from agent self-exec".to_string(),
                }),
            )
                .into_response()
        }
        Err(error) => {
            log!(
                Level::Info,
                "Agent upgrade self-exec request failed: agent_id={}, target_version={}, error={:?}",
                agent_id,
                target_version,
                error
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to self-exec upgraded agent: {error:?}"),
                }),
            )
                .into_response()
        }
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

    /// Running binaries are rejected before upload when their CPU target differs.
    #[tokio::test]
    async fn running_server_binary_requires_matching_architecture() {
        let mismatching_arch = if std::env::consts::ARCH == "x86_64" {
            "aarch64"
        } else {
            "x86_64"
        };
        let response = running_server_architecture_error(mismatching_arch).unwrap();
        // A conflict identifies a valid force operation that is unsafe for this agent.
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let error: ErrorResponse = serde_json::from_slice(&body).unwrap();
        // Both architectures let operators understand why the force action was blocked.
        assert_eq!(
            error.error,
            format!(
                "Cannot install the running server binary: server architecture is {}, but agent architecture is {mismatching_arch}",
                std::env::consts::ARCH
            )
        );
        // A matching architecture is allowed to proceed to binary selection.
        assert!(running_server_architecture_error(std::env::consts::ARCH).is_none());
    }
}
