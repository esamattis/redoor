//! REST endpoints for listing, emptying and restoring agent trash.

use crate::http::access::ResolvedDevice;
use axum::{Json, extract::State as AxumState};
use redoor_protocol::{
    api::{
        agents::AgentInfoResponse,
        trash::{
            EmptyTrashResponse, RestoreTrashItemRequest, RestoreTrashItemResponse,
            TrashListResponse,
        },
    },
    ids::AgentId,
};

use super::{
    agent_client::{EmptyTrash, ListTrash, RestoreTrash},
    agents::list_agent_snapshots,
    error::ApiError,
    state::ServerState,
};

/// Finds the retained inventory row whose registration decides which trash commands it knows.
pub(crate) async fn inventory_entry(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<AgentInfoResponse, ApiError> {
    list_agent_snapshots(state)
        .await?
        .into_iter()
        .find(|agent| &agent.id == agent_id)
        .ok_or_else(|| ApiError::not_found("Agent not found"))
}

/// Rejects unsupported or disconnected agents before sending commands they cannot understand.
pub(crate) async fn require_trash_inventory_support(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<(), ApiError> {
    if !inventory_entry(state, agent_id).await?.supports_trash {
        return Err(ApiError::bad_request(
            "Agent does not support trash operations",
        ));
    }
    Ok(())
}

/// Allows move-only providers without exposing inventory and restore commands to them.
pub(crate) async fn require_move_to_trash_support(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<(), ApiError> {
    if !inventory_entry(state, agent_id)
        .await?
        .supports_move_to_trash
    {
        return Err(ApiError::bad_request(
            "Agent does not support moving entries to trash",
        ));
    }
    Ok(())
}

/// Route: `GET /api/v1/agents/{agent}/trash` lists freshly discovered trash inventory.
pub(crate) async fn list_trash_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<TrashListResponse>, ApiError> {
    require_trash_inventory_support(&state, &agent_id).await?;
    Ok(Json(state.agents.call(&agent_id, ListTrash {}).await?))
}

/// Route: `DELETE /api/v1/agents/{agent}/trash` permanently removes every trash entry.
pub(crate) async fn empty_trash_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<EmptyTrashResponse>, ApiError> {
    require_trash_inventory_support(&state, &agent_id).await?;
    let emptied = state.agents.call(&agent_id, EmptyTrash {}).await?;
    Ok(Json(EmptyTrashResponse {
        deleted_items: emptied.deleted_items,
    }))
}

/// Route: `POST /api/v1/agents/{agent}/trash/restore` restores one opaque inventory item.
pub(crate) async fn restore_trash_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<RestoreTrashItemRequest>,
) -> Result<Json<RestoreTrashItemResponse>, ApiError> {
    if request.location_id.is_empty()
        || request.item_id.is_empty()
        || request.destination_path.is_empty()
    {
        return Err(ApiError::bad_request(
            "Trash location, item, and restore destination are required",
        ));
    }
    require_trash_inventory_support(&state, &agent_id).await?;
    let call = RestoreTrash {
        location_id: request.location_id,
        item_id: request.item_id,
        destination_path: request.destination_path,
    };
    let restored = state.agents.call(&agent_id, call).await?;
    Ok(Json(RestoreTrashItemResponse {
        path: restored.path,
    }))
}
