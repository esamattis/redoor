use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, UpgradeAgentResponse},
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
