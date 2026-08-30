use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    responses::command_error_status,
    state::ServerState,
};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    actors,
    commands::{Command, CommandResult, ErrorResponse, GrepRequest, MAX_GREP_CONTEXT_LINES},
    types::AgentId,
};

/// Route: `POST /api/v1/agents/{agent}/grep/{*path}` searches below one filesystem root.
pub(crate) async fn content_grep_handler(
    Path(AgentFilePath { agent, path }): Path<AgentFilePath>,
    AxumState(state): AxumState<ServerState>,
    Json(search): Json<GrepRequest>,
) -> impl IntoResponse {
    if !(1..=60).contains(&search.timeout) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Content grep timeout must be between 1 and 60 seconds".to_string(),
            }),
        )
            .into_response();
    }
    if search.before_context > MAX_GREP_CONTEXT_LINES
        || search.after_context > MAX_GREP_CONTEXT_LINES
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!(
                    "Content grep context must be between 0 and {MAX_GREP_CONTEXT_LINES} lines per direction"
                ),
            }),
        )
            .into_response();
    }

    let path = absolute_path_from_url(path.unwrap_or_default());
    let agent_id = AgentId::from(agent);
    let context_requested = search.before_context > 0 || search.after_context > 0;
    let request_timeout_ms = (search.timeout + 2) * 1000;
    match state
        .router_ref
        .request(request_timeout_ms, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::ContentGrep {
                    path,
                    query: search.query,
                    timeout_seconds: search.timeout,
                    include_hidden: search.include_hidden,
                    respect_gitignore: search.respect_gitignore,
                    fixed_string: search.fixed_string,
                    case_sensitivity: search.case_sensitivity,
                    before_context: search.before_context,
                    after_context: search.after_context,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::ContentGrep(result))
            if context_requested && !result.context_supported =>
        {
            (
                StatusCode::CONFLICT,
                Json(ErrorResponse {
                    error: "The connected agent does not support content grep context; upgrade the agent"
                        .to_string(),
                }),
            )
                .into_response()
        }
        Ok(CommandResult::ContentGrep(result)) => (StatusCode::OK, Json(result)).into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type".to_string(),
            }),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to execute content grep command: {error:?}"),
            }),
        )
            .into_response(),
    }
}
