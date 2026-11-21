//! Resumable inventory and actions trust only signed manifests read from agents.

use super::{
    access::Principal,
    agent_client::{DeletePartial, ListPartials, MoveMetadata, ReadPartial},
    agent_helpers::require_absolute_path,
    error::ApiError,
    services::transfer::CopySpec,
    state::ServerState,
};
use crate::actors::router::CopyOperation;
use crate::workspaces::AgentKey;
use axum::{Extension, Json, extract::State};
use redoor_protocol::{
    api::{tokens::Permission, transfers::*},
    wire::partials::PartialOperation,
};

/// Offline agents are skipped because their partials cannot currently be resumed. Tokens
/// only see partials whose source and destination are both in their scope.
pub(crate) async fn list(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<PartialsResponse>, ApiError> {
    let owner = principal.owner().to_string();
    let active = state
        .router_ref
        .request(
            |reply| crate::actors::router::RouterMsg::GetTransferProgress {
                owner: owner.clone(),
                reply,
            },
        )
        .await?;
    let mut partials = Vec::new();
    for agent in state
        .agents
        .inventory(&owner)
        .await?
        .into_iter()
        .filter(|agent| agent.connection_id.is_some() && principal.can_see(&agent.id))
    {
        let agent_key = AgentKey::new(&owner, agent.id.clone());
        let records = match state.agents.call(&agent_key, ListPartials {}).await {
            Ok(records) => records,
            Err(error) => {
                redoor_core::log!(
                    redoor_protocol::wire::log::Level::Info,
                    "Cannot list partials: agent={}, error={}",
                    agent.id,
                    error
                );
                continue;
            }
        };
        for record in records {
            if active.transfers.iter().any(|entry| {
                matches!(
                    entry.state,
                    TransferProgressState::Active | TransferProgressState::Canceling
                ) && entry.dest.as_ref().is_some_and(|dest| {
                    dest.agent == agent.id
                        && dest.path == record.manifest.signed.authorization.dest_path
                })
            }) {
                continue;
            }
            if !state.transfers.verify(&agent.id, &record).await? {
                continue;
            }
            let authorization = record.manifest.signed.authorization;
            if !principal.can_see(&authorization.source_agent_id)
                || !principal.can_see(&authorization.dest_agent_id)
            {
                continue;
            }
            partials.push(ResumableTransfer {
                dest_agent_id: agent.id.clone(),
                key: record.key,
                source: CopyEndpoint {
                    agent: authorization.source_agent_id,
                    path: authorization.source_path,
                },
                dest: CopyEndpoint {
                    agent: authorization.dest_agent_id,
                    path: authorization.dest_path,
                },
                operation: match authorization.operation {
                    PartialOperation::Copy => TransferDirection::Copy,
                    PartialOperation::Move => TransferDirection::Move,
                },
                partial_bytes: record.partial_bytes,
                total_bytes: authorization.source_identity.size,
                updated_at: record.manifest.updated_at,
            });
        }
    }
    Ok(Json(PartialsResponse { partials }))
}

/// Resume re-reads authorization and source metadata rather than trusting the browser.
/// The caller needs the same permissions as starting the transfer afresh.
pub(crate) async fn resume(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(mut request): Json<PartialActionRequest>,
) -> Result<Json<ResumePartialResponse>, ApiError> {
    let owner = principal.owner().to_string();
    // Body fields accept a name or an id; resolving before `require` keeps scope checks on
    // ids, so a name that now belongs to another device cannot slip past a scope.
    request.dest_agent_id = state
        .agents
        .resolve(&owner, request.dest_agent_id.as_str())
        .await?;
    // Reading the partial already touches the destination agent.
    principal.require(&[Permission::FilesWrite], &request.dest_agent_id)?;
    let dest_key = AgentKey::new(&owner, request.dest_agent_id.clone());
    let record = state
        .agents
        .call(&dest_key, ReadPartial { key: request.key })
        .await?
        .ok_or_else(|| ApiError::not_found("Partial not found"))?;
    if !state
        .transfers
        .verify(&request.dest_agent_id, &record)
        .await?
    {
        return Err(ApiError::bad_request("Invalid partial signature"));
    }
    let a = record.manifest.signed.authorization;
    let source_permissions: &[Permission] = match a.operation {
        PartialOperation::Copy => &[Permission::FilesRead],
        PartialOperation::Move => &[
            Permission::FilesRead,
            Permission::FilesWrite,
            Permission::FilesDelete,
        ],
    };
    principal.require(source_permissions, &a.source_agent_id)?;
    principal.require(&[Permission::FilesWrite], &a.dest_agent_id)?;
    let started = state
        .transfers
        .start_copy(CopySpec {
            owner,
            op: match a.operation {
                PartialOperation::Copy => CopyOperation::Copy,
                PartialOperation::Move => CopyOperation::Move,
            },
            source: CopyEndpoint {
                agent: a.source_agent_id,
                path: a.source_path,
            },
            dest: CopyEndpoint {
                agent: a.dest_agent_id,
                path: a.dest_path,
            },
            on_existing: a.on_existing,
            resume: ResumeMode::Auto,
            observe_terminal: false,
        })
        .await?;
    Ok(Json(ResumePartialResponse {
        transfer_id: started.transfer_id,
    }))
}

/// Explicit discard requires no source permission and deletes only agent-owned output.
pub(crate) async fn discard(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(mut request): Json<PartialActionRequest>,
) -> Result<Json<DiscardPartialResponse>, ApiError> {
    let owner = principal.owner();
    // Body fields accept a name or an id; resolving before `require` keeps scope checks on
    // ids, so a name that now belongs to another device cannot slip past a scope.
    request.dest_agent_id = state
        .agents
        .resolve(owner, request.dest_agent_id.as_str())
        .await?;
    principal.require(&[Permission::FilesWrite], &request.dest_agent_id)?;
    let dest_key = AgentKey::new(owner, request.dest_agent_id);
    state
        .agents
        .call(&dest_key, DeletePartial { key: request.key })
        .await?;
    Ok(Json(DiscardPartialResponse { discarded: true }))
}

/// The dialog probes cheaply; expensive prefix verification belongs to the transfer.
pub(crate) async fn preflight(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(mut request): Json<CopyPreflightRequest>,
) -> Result<Json<CopyPreflightResponse>, ApiError> {
    let owner = principal.owner();
    // Body fields accept a name or an id; resolving before `require` keeps scope checks on
    // ids, so a name that now belongs to another device cannot slip past a scope.
    request.source.agent = state
        .agents
        .resolve(owner, request.source.agent.as_str())
        .await?;
    request.dest.agent = state
        .agents
        .resolve(owner, request.dest.agent.as_str())
        .await?;
    principal.require(&[Permission::FilesRead], &request.source.agent)?;
    principal.require(&[Permission::FilesWrite], &request.dest.agent)?;
    let source_path = require_absolute_path(request.source.path)?;
    let dest_path = require_absolute_path(request.dest.path)?;
    let source_key = AgentKey::new(owner, request.source.agent.clone());
    let dest_key = AgentKey::new(owner, request.dest.agent.clone());
    let source = state
        .agents
        .call(
            &source_key,
            MoveMetadata {
                path: source_path.clone(),
            },
        )
        .await?;
    let candidate = if source.is_file {
        state
            .transfers
            .candidate(
                &source_key,
                &source_path,
                &dest_key,
                &dest_path,
                &source.identity,
            )
            .await?
    } else {
        None
    };
    Ok(Json(CopyPreflightResponse {
        resume_candidate: candidate.map(|record| ResumeCandidate {
            partial_bytes: record.partial_bytes,
            total_bytes: record.manifest.signed.authorization.source_identity.size,
            updated_at: record.manifest.updated_at,
        }),
    }))
}
