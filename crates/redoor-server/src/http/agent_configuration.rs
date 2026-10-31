//! REST endpoints that create, edit and remove server-managed local and SSH agents in the
//! TOML config.

use crate::actors::router::{RouterMsg, UnregisterManagedAgentRequest};
use axum::{Json, extract::State as AxumState, http::StatusCode};
use redoor_protocol::api::agents::{
    AgentConnectionStatus, AgentInfoResponse, CreateLocalAgentRequest, CreateLocalAgentResponse,
    CreateSshAgentRequest, CreateSshAgentResponse, DeleteManagedAgentResponse,
    DeleteSshAgentRequest, ManagedLocalAgentConfigurationResponse,
    ManagedSshAgentConfigurationResponse, UpdateLocalAgentRequest, UpdateLocalAgentResponse,
    UpdateSshAgentRequest, UpdateSshAgentResponse,
};
use redoor_protocol::ids::{AgentId, validate_device_name};

use redoor_core::config::{
    AgentConfig, LocalAgentConfig, SshBackedAgentConfig, append_local_agent, append_ssh_agent,
    edit_local_agent, edit_ssh_agent, parse_config_file,
};

use super::{
    access::ResolvedDevice, agents::list_agent_snapshots, error::ApiError, state::ServerState,
};

/// Route: `POST /api/v1/agents` persists and immediately registers one SSH-backed agent.
pub(crate) async fn create_ssh_agent_handler(
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<CreateSshAgentRequest>,
) -> Result<(StatusCode, Json<CreateSshAgentResponse>), ApiError> {
    let agent = create_ssh_agent(&state, request).await?;
    Ok((StatusCode::CREATED, Json(CreateSshAgentResponse { agent })))
}

/// Route: `GET /api/v1/agents/{agent}/configuration` returns editable SSH TOML fields.
pub(crate) async fn get_ssh_agent_configuration_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<ManagedSshAgentConfigurationResponse>, ApiError> {
    let config = find_ssh_agent(&state, &agent_id).await?;
    let has_pinned_host_key = super::ssh_keys::account_keys(&state)?
        .pinned_host_key(&agent_id)
        .await
        .map_err(internal_error)?
        .is_some();
    Ok(Json(ManagedSshAgentConfigurationResponse {
        has_pinned_host_key,
        ..ManagedSshAgentConfigurationResponse::from(config)
    }))
}

/// Route: `PUT /api/v1/agents/{agent}` replaces one stopped SSH-backed TOML entry.
pub(crate) async fn update_ssh_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<UpdateSshAgentRequest>,
) -> Result<Json<UpdateSshAgentResponse>, ApiError> {
    super::ssh_keys::complete_operation(async move {
        let agent = update_ssh_agent(&state, &agent_id, request).await?;
        Ok(Json(UpdateSshAgentResponse { agent }))
    })
    .await
}

/// Route: `DELETE /api/v1/agents/{agent}` removes one stopped SSH-backed TOML entry. The
/// optional body carries an encrypted managed key's file key, so its line can be removed
/// from the device.
pub(crate) async fn delete_ssh_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    request: Option<Json<DeleteSshAgentRequest>>,
) -> Result<Json<DeleteManagedAgentResponse>, ApiError> {
    let request = request.map(|Json(request)| request).unwrap_or_default();
    super::ssh_keys::complete_operation(async move {
        delete_managed_agent(
            &state,
            &agent_id,
            ManagedAgentKind::Ssh,
            request.current_file_key.as_deref(),
        )
        .await?;
        Ok(Json(DeleteManagedAgentResponse { deleted: true }))
    })
    .await
}

/// Route: `POST /api/v1/local-agents` persists and immediately registers one local agent.
pub(crate) async fn create_local_agent_handler(
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<CreateLocalAgentRequest>,
) -> Result<(StatusCode, Json<CreateLocalAgentResponse>), ApiError> {
    let agent = create_local_agent(&state, request).await?;
    Ok((
        StatusCode::CREATED,
        Json(CreateLocalAgentResponse { agent }),
    ))
}

/// Route: `DELETE /api/v1/local-agents/{agent}` removes one stopped local TOML entry.
pub(crate) async fn delete_local_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<DeleteManagedAgentResponse>, ApiError> {
    super::ssh_keys::complete_operation(async move {
        delete_managed_agent(&state, &agent_id, ManagedAgentKind::Local, None).await?;
        Ok(Json(DeleteManagedAgentResponse { deleted: true }))
    })
    .await
}

/// Route: `GET /api/v1/local-agents/{agent}/configuration` returns editable local TOML fields.
pub(crate) async fn get_local_agent_configuration_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<ManagedLocalAgentConfigurationResponse>, ApiError> {
    let config = find_local_agent(&state, &agent_id).await?;
    Ok(Json(ManagedLocalAgentConfigurationResponse::from(config)))
}

/// Route: `PUT /api/v1/local-agents/{agent}` replaces one stopped local TOML entry.
pub(crate) async fn update_local_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<UpdateLocalAgentRequest>,
) -> Result<Json<UpdateLocalAgentResponse>, ApiError> {
    let agent = update_local_agent(&state, &agent_id, request).await?;
    Ok(Json(UpdateLocalAgentResponse { agent }))
}

/// Serializes persistence and runtime registration so effective names stay unique.
///
/// The server owns managed ids, so the id is generated here and never taken from the request.
async fn create_ssh_agent(
    state: &ServerState,
    request: CreateSshAgentRequest,
) -> Result<AgentInfoResponse, ApiError> {
    let mut config = validate_request(request)?;
    let agent_id = AgentId::generate();
    config.id = Some(agent_id.clone());
    let agent_config = AgentConfig::SshBacked(config.clone());
    let name = agent_config.effective_name();
    let _edit_guard = state.config_edit_lock.lock().await;

    let registered_id = with_name_reserved(state, &agent_id, &name, async {
        append_ssh_agent(&state.config_path, &config)
            .await
            .map_err(internal_error)?;
        state
            .launcher
            .register(agent_config, &state.watchdog_registry, &state.router_ref)
            .await
            .map_err(internal_error)
    })
    .await?;

    Ok(stopped_agent_response(
        registered_id,
        name,
        config.home,
        Some(config.target),
    ))
}

/// Replaces durable and runtime configuration while the old supervisor is dormant.
///
/// The request rebuilds the whole entry, so the id is carried over from the stored entry
/// like the password; dropping it would make the next start assign a new id and silently
/// break every token scope that refers to the device. `managed_ssh_key` is carried over the same
/// way, otherwise any edit, even a rename, would drop the managed key and fall back to the
/// server user's credentials.
///
/// A new username points at another account where the key is not installed, so the key is
/// dropped but the pinned host key stays (same machine). A new target may be another
/// machine, so the pin is dropped too and the next setup asks for confirmation again.
async fn update_ssh_agent(
    state: &ServerState,
    agent_id: &AgentId,
    request: UpdateSshAgentRequest,
) -> Result<AgentInfoResponse, ApiError> {
    let clear_password = request.clear_password.unwrap_or(false);
    let mut config = validate_update_request(request)?;
    let _operation = state.ssh_key_operations.begin(agent_id)?;
    let _edit_guard = state.config_edit_lock.lock().await;
    let existing_config = find_ssh_agent(state, agent_id).await?;
    config.id = existing_config.id;
    config.password =
        apply_password_update(config.password, clear_password, existing_config.password);
    let target_changed = config.target != existing_config.target;
    let username_changed = config.username != existing_config.username;
    config.managed_ssh_key =
        existing_config.managed_ssh_key && !target_changed && !username_changed;
    if config.managed_ssh_key && config.password.is_some() {
        return Err(ApiError::bad_request(
            "This device logs in with a managed SSH key; remove the key before setting a password",
        ));
    }
    let agent_config = AgentConfig::SshBacked(config.clone());
    let name = agent_config.effective_name();
    with_name_reserved(state, agent_id, &name, async {
        stop_for_configuration_change(state, agent_id).await?;
        edit_ssh_agent(&state.config_path, agent_id, Some(&config))
            .await
            .map_err(internal_error)?;
        replace_runtime_agent(state, agent_id, agent_config).await
    })
    .await?;
    // Deleted only after the config stopped pointing at them, for every account: none of
    // their keys is installed for the new target or login.
    if target_changed {
        state
            .ssh_keys
            .delete_device_for_all_accounts(agent_id)
            .await
            .map_err(internal_error)?;
    } else if username_changed {
        // Also clears a key file a crashed setup may have left without the config using it.
        state
            .ssh_keys
            .delete_keys_for_all_accounts(agent_id)
            .await
            .map_err(internal_error)?;
    }
    Ok(stopped_agent_response(
        agent_id.clone(),
        name,
        config.home,
        Some(config.target),
    ))
}

/// Serializes persistence and runtime registration so effective names stay unique.
///
/// The server owns managed ids, so the id is generated here and never taken from the request.
async fn create_local_agent(
    state: &ServerState,
    request: CreateLocalAgentRequest,
) -> Result<AgentInfoResponse, ApiError> {
    let mut config = validate_local_request(request)?;
    let agent_id = AgentId::generate();
    config.id = Some(agent_id.clone());
    let agent_config = AgentConfig::Local(config.clone());
    let name = agent_config.effective_name();
    let _edit_guard = state.config_edit_lock.lock().await;

    let registered_id = with_name_reserved(state, &agent_id, &name, async {
        append_local_agent(&state.config_path, &config)
            .await
            .map_err(internal_error)?;
        state
            .launcher
            .register(agent_config, &state.watchdog_registry, &state.router_ref)
            .await
            .map_err(internal_error)
    })
    .await?;

    Ok(stopped_agent_response(
        registered_id,
        name,
        config.home,
        None,
    ))
}

/// Replaces durable and runtime local configuration while the old supervisor is dormant.
///
/// Carries the stored id over for the same reason as [`update_ssh_agent`].
async fn update_local_agent(
    state: &ServerState,
    agent_id: &AgentId,
    request: UpdateLocalAgentRequest,
) -> Result<AgentInfoResponse, ApiError> {
    let mut config = validate_local_update_request(request)?;
    let _edit_guard = state.config_edit_lock.lock().await;
    let existing_config = find_local_agent(state, agent_id).await?;
    config.id = existing_config.id;
    let agent_config = AgentConfig::Local(config.clone());
    let name = agent_config.effective_name();
    with_name_reserved(state, agent_id, &name, async {
        stop_for_configuration_change(state, agent_id).await?;
        edit_local_agent(&state.config_path, agent_id, Some(&config))
            .await
            .map_err(internal_error)?;
        replace_runtime_agent(state, agent_id, agent_config).await
    })
    .await?;
    Ok(stopped_agent_response(
        agent_id.clone(),
        name,
        config.home,
        None,
    ))
}

/// Deletes durable configuration only after confirming no managed process is running.
///
/// `current_file_key` unlocks an encrypted managed key, so its line can be removed from the
/// device; the credential is resolved before the device is stopped, which releases a held
/// key.
async fn delete_managed_agent(
    state: &ServerState,
    agent_id: &AgentId,
    expected_kind: ManagedAgentKind,
    current_file_key: Option<&str>,
) -> Result<(), ApiError> {
    let _operation = state.ssh_key_operations.begin(agent_id)?;
    let _edit_guard = state.config_edit_lock.lock().await;
    let configured = find_configured_agent(state, agent_id).await?;
    if let Some(config) = &configured {
        if !expected_kind.matches_config(config) {
            return Err(expected_kind.not_found(agent_id));
        }
    } else {
        let inventory = list_agent_snapshots(state).await?;
        let retained = inventory
            .iter()
            .find(|agent| &agent.id == agent_id && agent.configuration_editable);
        if !retained.is_some_and(|agent| expected_kind.matches_inventory(agent)) {
            return Err(expected_kind.not_found(agent_id));
        }
    }

    let removal = match &configured {
        Some(AgentConfig::SshBacked(config)) if config.managed_ssh_key => {
            let device = super::ssh_keys::managed_key_device_for(state, config.clone())?;
            let credential =
                super::ssh_keys::removal_credential(state, &device, current_file_key).await?;
            Some((device, credential))
        }
        _ => None,
    };
    stop_for_configuration_change(state, agent_id).await?;
    match &configured {
        Some(AgentConfig::SshBacked(_)) => {
            edit_ssh_agent(&state.config_path, agent_id, None)
                .await
                .map_err(internal_error)?;
        }
        Some(AgentConfig::Local(_)) => {
            edit_local_agent(&state.config_path, agent_id, None)
                .await
                .map_err(internal_error)?;
        }
        None => {}
    }
    let runtime_result = unregister_runtime_agent(state, agent_id).await;
    // Remote cleanup must follow route ownership, lifecycle checks and persistence, so a
    // rejected deletion or failed write cannot revoke a device that still exists.
    drop(_edit_guard);
    // Like the "Remove key" action, and after the lock, because reaching the device
    // includes network round trips and the lock blocks every device start. Best effort:
    // the device may be gone for good, and its private key is deleted with it either way,
    // so a line left behind can no longer be used.
    if let Some((device, credential)) = removal
        && let Some(error) = device.remove_from_device(credential.as_ref()).await
    {
        redoor_core::log_failure!(
            Level::Warn,
            "Deleting a device whose SSH key could not be removed from it: device={}, error={}",
            agent_id,
            error
        );
    }
    // A deleted device's keys and pins must never be picked up by a later device; ids are
    // never reused, so this only keeps the data dir tidy. Every account's are deleted;
    // other accounts' remote lines are left for the multi-account work.
    state
        .ssh_keys
        .delete_device_for_all_accounts(agent_id)
        .await
        .map_err(internal_error)?;
    runtime_result
}

/// Distinguishes route ownership so SSH and local resources cannot delete each other.
#[derive(Clone, Copy)]
enum ManagedAgentKind {
    Ssh,
    Local,
}

impl ManagedAgentKind {
    /// Matches durable configuration before any destructive operation begins.
    fn matches_config(self, config: &AgentConfig) -> bool {
        matches!(
            (self, config),
            (Self::Ssh, AgentConfig::SshBacked(_)) | (Self::Local, AgentConfig::Local(_))
        )
    }

    /// Recovers the resource kind from retained inventory during an idempotent delete retry.
    fn matches_inventory(self, agent: &AgentInfoResponse) -> bool {
        match self {
            Self::Ssh => agent.ssh_target.is_some(),
            Self::Local => agent.ssh_target.is_none(),
        }
    }

    /// Uses resource-specific wording so a cross-kind route does not reveal another collection.
    fn not_found(self, agent_id: &AgentId) -> ApiError {
        let kind = match self {
            Self::Ssh => "SSH",
            Self::Local => "local",
        };
        ApiError::not_found(format!("Managed {kind} agent '{agent_id}' was not found"))
    }
}

/// Swaps the dormant supervisor and inventory row for ones built from the new entry.
///
/// The id stays the same, so a retry after a partial failure simply runs this again: removing
/// an already removed supervisor and row is a no-op.
pub(super) async fn replace_runtime_agent(
    state: &ServerState,
    agent_id: &AgentId,
    config: AgentConfig,
) -> Result<(), ApiError> {
    unregister_runtime_agent(state, agent_id).await?;
    state
        .launcher
        .register(config, &state.watchdog_registry, &state.router_ref)
        .await
        .map_err(internal_error)?;
    Ok(())
}

/// Removes the dormant supervisor and retained router inventory together. A replaced or
/// removed supervisor no longer runs the device, so its held SSH key is dropped too.
async fn unregister_runtime_agent(state: &ServerState, agent_id: &AgentId) -> Result<(), ApiError> {
    state.watchdog_registry.remove_stopped(agent_id.as_str())?;
    state.held_ssh_keys.release_device(agent_id);
    state
        .router_ref
        .request(|reply| {
            RouterMsg::UnregisterManagedAgent(UnregisterManagedAgentRequest {
                agent_id: agent_id.clone(),
                reply,
            })
        })
        .await
        .map_err(|error| {
            ApiError::internal(format!("Failed to unregister managed inventory: {error}"))
        })
}

/// Settles any delayed start before persistence while the shared edit lock blocks new starts.
///
/// The device's held SSH key is dropped first: an edited, deleted or rekeyed device must be
/// unlocked again by the next browser Start.
pub(super) async fn stop_for_configuration_change(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<(), ApiError> {
    state.held_ssh_keys.release_device(agent_id);
    let Some(handle) = state.watchdog_registry.lookup(agent_id.as_str()) else {
        // A retry after persist+remove must not 404 just because the supervisor is already gone.
        return Ok(());
    };
    match tokio::time::timeout(std::time::Duration::from_secs(10), handle.shutdown()).await {
        Ok(Ok(())) => Ok(()),
        // A dead supervisor channel means the previous attempt already tore the task down.
        Ok(Err(_)) => Ok(()),
        Err(_) => Err(ApiError::status(
            StatusCode::GATEWAY_TIMEOUT,
            format!("Timed out stopping managed agent: {agent_id}"),
        )),
    }
}

/// Reloads the source of truth so edits include values unavailable in public inventory.
pub(super) async fn find_ssh_agent(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<SshBackedAgentConfig, ApiError> {
    match find_configured_agent(state, agent_id).await? {
        Some(AgentConfig::SshBacked(config)) => Ok(config),
        Some(AgentConfig::Local(_)) | None => Err(ApiError::not_found(format!(
            "Managed SSH agent '{agent_id}' was not found"
        ))),
    }
}

/// Reloads local TOML fields and refuses to treat an SSH row as a local edit.
async fn find_local_agent(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<LocalAgentConfig, ApiError> {
    match find_configured_agent(state, agent_id).await? {
        Some(AgentConfig::Local(config)) => Ok(config),
        Some(AgentConfig::SshBacked(_)) | None => Err(ApiError::not_found(format!(
            "Managed local agent '{agent_id}' was not found"
        ))),
    }
}

/// Distinguishes a missing row from a local entry so SSH APIs cannot mutate non-SSH agents.
pub(super) async fn find_configured_agent(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<Option<AgentConfig>, ApiError> {
    let config = parse_config_file(&state.config_path)
        .await
        .map_err(internal_error)?;
    Ok(config
        .agents
        .into_iter()
        .find(|config| config.id() == Some(agent_id)))
}

/// Runs a create or rename while the router holds `name` for `agent_id`.
///
/// The edit stops the agent and rewrites the config before the inventory row carries the
/// new name; the reservation keeps a standalone agent from taking the name in that window,
/// so a name in a request always points to exactly one device. The reservation is dropped
/// afterwards either way: on success the managed row holds the name itself.
pub(super) async fn with_name_reserved<T>(
    state: &ServerState,
    agent_id: &AgentId,
    name: &str,
    operation: impl std::future::Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    let reserved = state
        .router_ref
        .request(|reply| RouterMsg::ReserveName {
            agent_id: agent_id.clone(),
            name: name.to_string(),
            reply,
        })
        .await?;
    if let Err(holder) = reserved {
        return Err(ApiError::conflict(format!(
            "Device name '{name}' is already used by device '{holder}'"
        )));
    }
    let result = operation.await;
    // Best effort: a stopped router has no reservations left to release.
    let _ = state
        .router_ref
        .send_async(RouterMsg::ReleaseName {
            agent_id: agent_id.clone(),
        })
        .await;
    result
}

/// Maps unexpected persistence/runtime failures to one consistent REST error shape.
fn internal_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(error.to_string())
}

/// Builds the public dormant projection shared by create and update responses.
fn stopped_agent_response(
    agent_id: AgentId,
    name: String,
    home: Option<String>,
    ssh_target: Option<String>,
) -> AgentInfoResponse {
    AgentInfoResponse {
        id: agent_id,
        name,
        cwd: home,
        managed: true,
        configuration_editable: true,
        ssh_target,
        status: AgentConnectionStatus::Stopped,
        connected_at: None,
        connection_id: None,
        last_seen_at: None,
        connection_issue: None,
        provisioning_status: Vec::new(),
        binary: None,
        supports_native_open: false,
        supports_move_to_trash: false,
        supports_trash: false,
        supports_upload_preconditions: false,
        uid: None,
        is_root: false,
        duplicate_id: None,
    }
}

/// Trims optional local fields; nothing is required because hostname/home/stdio already have
/// defaults. The id is never part of the request: the server creates it on add and copies it
/// on edit.
fn validate_local_request(request: CreateLocalAgentRequest) -> Result<LocalAgentConfig, ApiError> {
    let name = validated_name(request.name)?;
    Ok(LocalAgentConfig {
        id: None,
        name,
        home: optional_text(request.home),
        log: optional_text(request.log),
    })
}

/// Applies the same normalization to the distinct local update wire type.
fn validate_local_update_request(
    request: UpdateLocalAgentRequest,
) -> Result<LocalAgentConfig, ApiError> {
    validate_local_request(CreateLocalAgentRequest {
        name: request.name,
        home: request.home,
        log: request.log,
    })
}

/// Normalizes optional text and rejects values that would create unusable TOML entries.
fn validate_request(request: CreateSshAgentRequest) -> Result<SshBackedAgentConfig, ApiError> {
    let target = request.target.trim().to_string();
    if target.is_empty() {
        return Err(ApiError::bad_request("SSH target is required"));
    }
    if request.ssh_port == Some(0) {
        return Err(ApiError::bad_request(
            "SSH port must be between 1 and 65535",
        ));
    }
    let name = validated_name(request.name)?;
    let config = SshBackedAgentConfig {
        id: None,
        target,
        username: optional_text(request.username),
        ssh_port: request.ssh_port,
        name,
        remote_bin: optional_text(request.remote_bin),
        home: optional_text(request.home),
        log: optional_text(request.log),
        password: optional_password(request.password),
        // Never part of a request: only enrollment sets it and edits copy it over.
        managed_ssh_key: false,
    };
    // Without an explicit name the target host becomes the name, so it must pass the rules too.
    validate_device_name(&AgentConfig::SshBacked(config.clone()).effective_name())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(config)
}

/// Applies common SSH validation to the distinct update wire type.
fn validate_update_request(
    request: UpdateSshAgentRequest,
) -> Result<SshBackedAgentConfig, ApiError> {
    validate_request(CreateSshAgentRequest {
        target: request.target,
        username: request.username,
        ssh_port: request.ssh_port,
        name: request.name,
        remote_bin: request.remote_bin,
        home: request.home,
        log: request.log,
        password: request.password,
        clear_password: request.clear_password,
    })
}

/// Trims an optional name and checks the device name rules, so a name that would break
/// `device:path`, URLs or name-or-id lookups never reaches the config.
fn validated_name(value: Option<String>) -> Result<Option<String>, ApiError> {
    let name = optional_text(value);
    if let Some(name) = &name {
        validate_device_name(name).map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    Ok(name)
}

/// Resolves keep / replace / clear without forcing the browser to echo the stored secret.
fn apply_password_update(
    incoming: Option<String>,
    clear_password: bool,
    existing: Option<String>,
) -> Option<String> {
    if clear_password {
        None
    } else {
        incoming.or(existing)
    }
}

/// Treats whitespace-only optional form fields as omitted settings.
fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

/// Keeps leading or trailing spaces that are part of the password, unlike other form fields.
fn optional_password(value: Option<String>) -> Option<String> {
    value.and_then(|value| (!value.is_empty()).then_some(value))
}
