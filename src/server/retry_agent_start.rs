//! Atomic retry control for a managed agent's current startup attempt.

use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
};
use redoor::{
    commands::{ErrorResponse, RetryAgentStartResponse},
    types::AgentId,
};

use super::{
    agents::{
        apply_managed_snapshot, evict_managed_snapshot, list_agent_snapshots,
        managed_agent_snapshot,
    },
    state::ServerState,
};

/// Route: `POST /api/v1/agents/{agent}/retry-start` replaces one managed startup attempt.
pub(crate) async fn retry_agent_start_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    // Configuration replacement and lifecycle controls must resolve against one supervisor identity.
    let _edit_guard = state.config_edit_lock.lock().await;
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

    let mut retry_snapshot = watchdog.snapshot();
    retry_snapshot.status = redoor::commands::AgentConnectionStatus::Starting;
    retry_snapshot.connection_issue = None;
    retry_snapshot.provisioning_status.clear();
    retry_snapshot.socket_id = None;
    let (retry_result, eviction_result) = tokio::join!(
        watchdog.retry_startup(),
        evict_managed_snapshot(&state, agent_id.clone(), retry_snapshot),
    );
    match retry_result {
        Ok(()) => {}
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error }),
            )
                .into_response();
        }
    }
    if let Err(error) = eviction_result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error }),
        )
            .into_response();
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
            Some(agent) => {
                (StatusCode::OK, Json(RetryAgentStartResponse { agent })).into_response()
            }
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
