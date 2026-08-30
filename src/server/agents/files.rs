use crate::server::{
    agent_helpers::{AgentFilePath, absolute_path_from_url, require_absolute_path},
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
    commands::{
        Command, CommandResult, EchoRequest, EchoResponse, ErrorResponse, FindRequest,
        LsDirectoryResponse, LsFileResponse,
    },
    types::AgentId,
};

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

/// Route: `POST /api/v1/find`
pub(crate) async fn file_search_agent_handler(
    AxumState(state): AxumState<ServerState>,
    Json(search): Json<FindRequest>,
) -> impl IntoResponse {
    if !(1..=60).contains(&search.timeout) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "File search timeout must be between 1 and 60 seconds".to_string(),
            }),
        )
            .into_response();
    }

    let path = match require_absolute_path(search.path) {
        Ok(path) => path,
        Err(response) => return *response,
    };
    let agent_id = search.agent;
    let request_timeout_ms = (search.timeout + 2) * 1000;
    match state
        .router_ref
        .request(request_timeout_ms, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::FileSearch {
                    path,
                    query: search.query,
                    timeout_seconds: search.timeout,
                    include_hidden: search.include_hidden,
                    respect_gitignore: search.respect_gitignore,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::FileSearch(result)) => (StatusCode::OK, Json(result)).into_response(),
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
                error: format!("Failed to execute file search command: {error:?}"),
            }),
        )
            .into_response(),
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
