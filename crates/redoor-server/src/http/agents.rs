//! REST endpoints for agent inventory, details and process lifecycle (start, shutdown,
//! restart), plus the per-agent filesystem routes in its submodules.

use crate::actors;
use crate::http::access::ResolvedDevice;
use axum::{Extension, Json, extract::State as AxumState, http::StatusCode};
use redoor_protocol::{
    api::{
        agents::{
            AgentDetailsResponse, AgentInfoResponse, AgentListResponse, ShutdownAgentResponse,
            StartAgentRequest, StartAgentResponse,
        },
        server::RestartResponse,
    },
    ids::AgentId,
};

use super::{access::Principal, agent_client::Restart, error::ApiError, state::ServerState};
use crate::watchdog::WatchdogHandle;

mod accounts;
mod chmod;
mod chown;
mod content_grep;
mod directory_size;
mod files;
mod open_path;
mod upgrade;

pub(crate) use accounts::accounts_handler;
pub(crate) use chmod::chmod_path_handler;
pub(crate) use chown::chown_path_handler;
pub(crate) use content_grep::content_grep_handler;
pub(crate) use directory_size::directory_size_handler;
pub(crate) use files::{
    echo_agent_handler, file_search_agent_handler, ls_agent_handler, metadata_agent_handler,
};
pub(crate) use open_path::open_path_agent_handler;
pub(crate) use upgrade::upgrade_agent_handler;

/// Loads and sorts retained inventory so every client receives stable ordering.
pub(super) async fn list_agent_snapshots(
    state: &ServerState,
) -> Result<Vec<AgentInfoResponse>, ApiError> {
    let mut agents = state
        .agents
        .inventory()
        .await?
        .into_iter()
        .map(AgentInfoResponse::from)
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(agents)
}

/// Route: `GET /api/v1/agents` returns configured, connected, and previously seen agents,
/// limited to the devices an access token may see.
pub(crate) async fn list_agents_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<AgentListResponse>, ApiError> {
    let agents = list_agent_snapshots(&state)
        .await?
        .into_iter()
        .filter(|agent| principal.can_see(&agent.id))
        .collect();
    Ok(Json(AgentListResponse { agents }))
}

/// Finds one retained inventory record while preserving unknown/unmanaged distinctions.
pub(super) async fn managed_agent_snapshot(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<AgentInfoResponse, ApiError> {
    let agent = list_agent_snapshots(state)
        .await?
        .into_iter()
        .find(|agent| &agent.id == agent_id)
        .ok_or_else(|| ApiError::not_found(format!("Agent not found: {agent_id}")))?;
    if !agent.managed {
        return Err(ApiError::conflict(format!(
            "Agent is external and cannot be managed: {agent_id}"
        )));
    }
    Ok(agent)
}

/// Returns the supervisor of a managed inventory record.
///
/// Inventory and registry are updated together, so a miss means server state is
/// inconsistent rather than that the client asked for something unknown.
pub(super) fn managed_watchdog(
    state: &ServerState,
    agent: &AgentInfoResponse,
) -> Result<WatchdogHandle, ApiError> {
    state
        .watchdog_registry
        .lookup(agent.id.as_str())
        .ok_or_else(|| ApiError::internal(format!("Managed supervisor unavailable: {}", agent.id)))
}

/// Waits until the router has projected a control snapshot and completed socket cleanup.
pub(super) async fn apply_managed_snapshot(
    state: &ServerState,
    agent_id: AgentId,
    snapshot: crate::watchdog::WatchdogSnapshot,
) -> Result<(), ApiError> {
    apply_managed_snapshot_with_eviction(state, agent_id, snapshot, false).await
}

/// Fences retry against the router's old socket before a replacement can register.
pub(super) async fn evict_managed_snapshot(
    state: &ServerState,
    agent_id: AgentId,
    snapshot: crate::watchdog::WatchdogSnapshot,
) -> Result<(), ApiError> {
    apply_managed_snapshot_with_eviction(state, agent_id, snapshot, true).await
}

/// Projects one lifecycle snapshot with optional retry-specific connection cleanup.
async fn apply_managed_snapshot_with_eviction(
    state: &ServerState,
    agent_id: AgentId,
    snapshot: crate::watchdog::WatchdogSnapshot,
    evict_existing: bool,
) -> Result<(), ApiError> {
    state
        .router_ref
        .request(|reply| {
            actors::router::RouterMsg::ApplyManagedLifecycle(
                actors::router::ApplyManagedLifecycleRequest {
                    agent_id,
                    snapshot,
                    evict_existing,
                    reply: Some(reply),
                },
            )
        })
        .await
        .map_err(|error| ApiError::internal(format!("Failed to update managed inventory: {error}")))
}

/// Re-reads the sorted inventory row of one agent after a lifecycle change.
pub(super) async fn current_agent_snapshot(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<AgentInfoResponse, ApiError> {
    list_agent_snapshots(state)
        .await?
        .into_iter()
        .find(|agent| &agent.id == agent_id)
        .ok_or_else(|| ApiError::internal(format!("Managed inventory disappeared: {agent_id}")))
}

/// Route: `POST /api/v1/agents/{agent}/start` accepts desired-running without waiting for connection.
///
/// A device with a vault-encrypted SSH key needs its file key in the optional body, unless
/// the server already holds the key; otherwise the start fails at once with
/// `ssh_key_locked`, before the watchdog is touched.
pub(crate) async fn start_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    request: Option<Json<StartAgentRequest>>,
) -> Result<Json<StartAgentResponse>, ApiError> {
    let request = request.map(|Json(request)| request).unwrap_or_default();
    // Configuration edits hold this lock through shutdown and runtime replacement, so a
    // delayed tab start cannot land behind shutdown and revive the old supervisor.
    let _edit_guard = state.config_edit_lock.lock().await;
    let mut snapshot = managed_agent_snapshot(&state, &agent_id).await?;
    let watchdog = managed_watchdog(&state, &snapshot)?;
    let was_running = watchdog.snapshot().desired_running;
    super::ssh_keys::unlock_for_start(&state, &agent_id, request.ssh_key_file_key.as_deref())
        .await?;
    // Reconnects use the keys and pin of the account that started the device.
    state
        .held_ssh_keys
        .record_start(&agent_id, state.auth.username());
    if let Err(error) = watchdog.start().await {
        // A device that did not start must not keep a key unlocked for token starts.
        if !was_running {
            state.held_ssh_keys.release_device(&agent_id);
        }
        return Err(error.into());
    }
    let lifecycle = watchdog.snapshot();
    apply_managed_snapshot(&state, agent_id.clone(), lifecycle.clone()).await?;
    snapshot.status = lifecycle.status;
    snapshot.connection_issue = lifecycle.connection_issue;
    snapshot.provisioning_status = lifecycle.provisioning_status;
    if snapshot.status != redoor_protocol::api::agents::AgentConnectionStatus::Connected {
        snapshot.connected_at = None;
    }
    Ok(Json(StartAgentResponse { agent: snapshot }))
}

/// Route: `POST /api/v1/agents/{agent}/shutdown` waits for owned child cleanup with a bound.
pub(crate) async fn shutdown_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<ShutdownAgentResponse>, ApiError> {
    // Configuration replacement also mutates this supervisor; sharing the lock prevents
    // shutdown from racing a persist-then-register and reviving the outgoing identity.
    let _edit_guard = state.config_edit_lock.lock().await;
    let snapshot = managed_agent_snapshot(&state, &agent_id).await?;
    let watchdog = managed_watchdog(&state, &snapshot)?;
    // A stopped device must be unlocked again by the next browser Start, so its held SSH
    // key goes first; later reconnect attempts of the stopping cycle find it locked.
    state.held_ssh_keys.release_device(&agent_id);
    tokio::time::timeout(std::time::Duration::from_secs(10), watchdog.shutdown())
        .await
        .map_err(|_| {
            ApiError::status(
                StatusCode::GATEWAY_TIMEOUT,
                format!("Timed out shutting down managed agent: {agent_id}"),
            )
        })??;
    apply_managed_snapshot(&state, agent_id.clone(), watchdog.snapshot()).await?;
    Ok(Json(ShutdownAgentResponse {
        agent: current_agent_snapshot(&state, &agent_id).await?,
    }))
}

/// Route: `GET /api/v1/agents/{agent}`
pub(crate) async fn get_agent_details_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<AgentDetailsResponse>, ApiError> {
    let details = state.agents.agent_details(&agent_id).await?;
    if details.name.is_empty() {
        return Err(ApiError::not_found(format!("Agent not found: {agent_id}")));
    }
    Ok(Json(details))
}

/// Route: `POST /api/v1/agents/{agent}/restart` asks the process to exec itself in place.
pub(crate) async fn restart_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<RestartResponse>, ApiError> {
    state.agents.call(&agent_id, Restart {}).await?;
    Ok(Json(RestartResponse { restarting: true }))
}
