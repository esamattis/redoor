//! Recursive uploads reuse agent extraction and staging without buffering or precomputing archive size.

use super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    error::ApiError,
    services::upload::{AgentUpload, UploadStart},
    state::ServerState,
};
use crate::http::access::ResolvedDevice;
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use redoor_protocol::wire::request;
use redoor_protocol::{
    api::transfers::{ArchiveUploadResponse, CopyExistingMode},
    wire::command::Command,
};

/// Defaults to strict creation so replacing an existing destination requires an explicit choice.
#[derive(serde::Deserialize)]
pub(crate) struct ArchiveQuery {
    #[serde(default)]
    on_existing: CopyExistingMode,
}

/// PUT /api/v1/agents/{agent}/archive/{*path} accepts plain tar members relative to the resulting directory.
///
/// Returns success only after extraction and conflict-policy placement finish on the agent.
pub(crate) async fn upload_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    Query(query): Query<ArchiveQuery>,
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<ArchiveUploadResponse>, ApiError> {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let request_guard = state.upload_requests.reserve(agent_id.owner(), &headers)?;
    let command = Command::TarUpload(request::TarUpload {
        path: path.clone(),
        on_existing: query.on_existing,
    });
    let upload = AgentUpload::start(&state.router_ref, agent_id, command, path.clone(), 0).await?;
    let UploadStart::Ready(mut upload) = upload else {
        return Ok(Json(ArchiveUploadResponse {
            path,
            bytes_written: 0,
        }));
    };
    if let Some(guard) = &request_guard {
        guard.activate(upload.request_id().as_transfer_id())?;
    }
    upload.forward_body(body).await?;
    let bytes_written = upload.finish().await?;
    Ok(Json(ArchiveUploadResponse {
        path,
        bytes_written,
    }))
}
