use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors,
    commands::{AgentDetailsResponse, Command, CommandResult, ErrorResponse},
    types::AgentId,
};
use std::time::Duration;

use super::{responses::command_error_status, state::ServerState};

fn join_agent_path(cwd: &str, path: &str) -> String {
    format!(
        "{}/{}",
        cwd.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

pub(crate) async fn get_agent_details(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<AgentDetailsResponse, Response> {
    match state
        .router_ref
        .call(
            |reply| {
                actors::router::RouterMsg::ExecuteCommandRest(
                    actors::router::ExecuteCommandRequest {
                        agent_id: agent_id.clone(),
                        command: Command::GetAgentDetails,
                        reply,
                    },
                )
            },
            Duration::from_millis(30000),
        )
        .await
    {
        Ok(CommandResult::GetAgentDetails(details)) => Ok(details),
        Ok(CommandResult::Error { kind, message }) => {
            let status = command_error_status(&kind);
            Err((status, Json(ErrorResponse { error: message })).into_response())
        }
        Ok(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type while fetching agent details".to_string(),
            }),
        )
            .into_response()),
        Err(error) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get agent details: {:?}", error),
            }),
        )
            .into_response()),
    }
}

pub(crate) async fn resolve_agent_path(
    state: &ServerState,
    agent_id: &AgentId,
    path: String,
) -> Result<String, Response> {
    if path.starts_with('/') {
        return Ok(path);
    }

    let details = get_agent_details(state, agent_id).await?;
    Ok(join_agent_path(&details.cwd, &path))
}
