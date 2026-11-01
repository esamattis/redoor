//! Atomic retry control for a managed agent's current startup attempt.

use crate::http::access::ResolvedDevice;
use axum::{Json, extract::State as AxumState};
use redoor_protocol::api::agents::{RetryAgentStartRequest, RetryAgentStartResponse};

use super::{
    agents::{
        apply_managed_snapshot, current_agent_snapshot, evict_managed_snapshot,
        managed_agent_snapshot, managed_watchdog,
    },
    error::ApiError,
    state::ServerState,
};

/// Route: `POST /api/v1/agents/{agent}/retry-start` replaces one managed startup attempt.
///
/// Like Start, a device with a vault-encrypted SSH key the server does not hold needs the
/// key's file key, or the retry fails at once with `ssh_key_locked`: retrying without the
/// key would only end in the same wait for it.
pub(crate) async fn retry_agent_start_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    request: Option<Json<RetryAgentStartRequest>>,
) -> Result<Json<RetryAgentStartResponse>, ApiError> {
    let request = request.map(|Json(request)| request).unwrap_or_default();
    // Configuration replacement and lifecycle controls must resolve against one supervisor identity.
    let _edit_guard = state.config_edit_lock.lock().await;
    let snapshot = managed_agent_snapshot(&state, &agent_id).await?;
    let watchdog = managed_watchdog(&state, &snapshot)?;
    super::ssh_keys::unlock_for_start(&state, &agent_id, request.ssh_key_file_key.as_deref())
        .await?;

    let mut retry_snapshot = watchdog.snapshot();
    retry_snapshot.status = redoor_protocol::api::agents::AgentConnectionStatus::Starting;
    retry_snapshot.connection_issue = None;
    retry_snapshot.provisioning_status.clear();
    retry_snapshot.socket_id = None;
    // Bounded like shutdown: this handler holds the configuration lock, so a supervisor that
    // never acknowledges must not freeze every lifecycle and configuration route.
    let (retry_result, eviction_result) = tokio::join!(
        tokio::time::timeout(std::time::Duration::from_secs(10), watchdog.retry_startup()),
        evict_managed_snapshot(&state, agent_id.clone(), retry_snapshot),
    );
    retry_result.map_err(|_| {
        ApiError::status(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            format!("Timed out retrying managed agent startup: {agent_id}"),
        )
    })??;
    eviction_result?;

    apply_managed_snapshot(&state, agent_id.clone(), watchdog.snapshot()).await?;
    Ok(Json(RetryAgentStartResponse {
        agent: current_agent_snapshot(&state, &agent_id).await?,
    }))
}
