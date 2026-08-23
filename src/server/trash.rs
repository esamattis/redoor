use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors,
    commands::{
        Command, CommandResult, ErrorResponse, RestoreTrashItemRequest, RestoreTrashItemResponse,
    },
    types::AgentId,
};

use super::{agents::list_agent_snapshots, responses::command_error_status, state::ServerState};

/// Rejects unsupported or disconnected agents before sending commands they cannot understand.
pub(crate) async fn require_trash_support(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<(), Response> {
    let agents = list_agent_snapshots(state).await.map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response()
    })?;
    let Some(agent) = agents.into_iter().find(|agent| &agent.id == agent_id) else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Agent not found".to_string(),
            }),
        )
            .into_response());
    };
    if !agent.supports_trash {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Agent does not support trash operations".to_string(),
            }),
        )
            .into_response());
    }
    Ok(())
}

/// Route: `GET /api/v1/agents/{agent}/trash` lists freshly discovered trash inventory.
pub(crate) async fn list_trash_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    let agent_id = AgentId::from(agent);
    if let Err(response) = require_trash_support(&state, &agent_id).await {
        return response;
    }
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::ListTrash,
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::TrashList(response)) => (StatusCode::OK, Json(response)).into_response(),
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => unexpected_response("Unexpected trash list response"),
        Err(error) => unexpected_response(&format!("Failed to list trash: {error:?}")),
    }
}

/// Route: `POST /api/v1/agents/{agent}/trash/restore` restores one opaque inventory item.
pub(crate) async fn restore_trash_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<RestoreTrashItemRequest>,
) -> Response {
    if request.location_id.is_empty() || request.item_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Trash location and item identifiers are required".to_string(),
            }),
        )
            .into_response();
    }
    let agent_id = AgentId::from(agent);
    if let Err(response) = require_trash_support(&state, &agent_id).await {
        return response;
    }
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::RestoreTrash {
                    location_id: request.location_id,
                    item_id: request.item_id,
                },
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::RestoreTrash { path }) => {
            (StatusCode::OK, Json(RestoreTrashItemResponse { path })).into_response()
        }
        Ok(CommandResult::Error { kind, message }) => (
            command_error_status(&kind),
            Json(ErrorResponse { error: message }),
        )
            .into_response(),
        Ok(_) => unexpected_response("Unexpected trash restore response"),
        Err(error) => unexpected_response(&format!("Failed to restore trash item: {error:?}")),
    }
}

/// Builds a consistent structured response for router and protocol mismatches.
fn unexpected_response(error: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: error.to_string(),
        }),
    )
        .into_response()
}
