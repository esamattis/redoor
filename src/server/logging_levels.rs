use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse},
    logging::{self, LoggingLevelRequest, LoggingLevelResponse},
    types::AgentId,
};

use super::{responses::command_error_status, state::ServerState};

const LOGGING_LEVEL_REQUEST_TIMEOUT_MS: u64 = 5_000;

/// Returns the threshold used by all subsequent server log macro calls.
pub(crate) async fn get_server_logging_level_handler() -> Json<LoggingLevelResponse> {
    Json(LoggingLevelResponse {
        level: logging::level(),
    })
}

/// Changes only process-lifetime server state so startup configuration remains untouched.
pub(crate) async fn update_server_logging_level_handler(
    Json(request): Json<LoggingLevelRequest>,
) -> Json<LoggingLevelResponse> {
    logging::set_level(request.level);
    Json(LoggingLevelResponse {
        level: request.level,
    })
}

/// Reads the threshold over the connected agent's authoritative command socket.
pub(crate) async fn get_agent_logging_level_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    execute_agent_logging_command(&state, AgentId::from(agent), Command::GetLoggingLevel).await
}

/// Updates a connected agent without coupling the setting to its ephemeral log-stream socket.
pub(crate) async fn update_agent_logging_level_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<LoggingLevelRequest>,
) -> Response {
    execute_agent_logging_command(
        &state,
        AgentId::from(agent),
        Command::SetLoggingLevel {
            level: request.level,
        },
    )
    .await
}

/// Maps command and router failures to the same typed REST errors as other agent controls.
async fn execute_agent_logging_command(
    state: &ServerState,
    agent_id: AgentId,
    command: Command,
) -> Response {
    match state
        .router_ref
        .request(LOGGING_LEVEL_REQUEST_TIMEOUT_MS, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id,
                command,
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::LoggingLevel(level)) => {
            Json(LoggingLevelResponse { level }).into_response()
        }
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type while changing logging level".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: format!("Agent logging level is unavailable: {error:?}"),
            }),
        )
            .into_response(),
    }
}
