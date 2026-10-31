//! Streamed raw file upload endpoint.

use crate::http::access::ResolvedDevice;
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
};
use headers::HeaderMap;
use redoor_protocol::wire::request;
use redoor_protocol::{
    api::files::{CreationOwnershipOptions, RawUploadResponse},
    wire::command::Command,
};

use super::super::{
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    error::ApiError,
    services::upload::{AgentUpload, UploadStart},
    state::ServerState,
};

/// Selects creation metadata and replacement behavior for one raw upload.
#[derive(serde::Deserialize)]
pub(crate) struct RawUploadQueryParams {
    /// Defaults to strict creation so replacing an existing file requires an explicit choice.
    #[serde(default)]
    pub(crate) on_existing: redoor_protocol::api::transfers::CopyExistingMode,
    /// Accepts either a user name or numeric UID for the new file.
    pub(crate) owner: Option<String>,
    /// Accepts either a group name or numeric GID for the new file.
    pub(crate) group: Option<String>,
    /// Lets callers explicitly request or disable parent-owner inheritance.
    pub(crate) inherit_owner: Option<bool>,
    /// Lets callers explicitly request or disable parent-group inheritance.
    pub(crate) inherit_group: Option<bool>,
}

impl RawUploadQueryParams {
    /// Restores the shared ownership value after top-level query parsing handles booleans.
    fn ownership(&self) -> CreationOwnershipOptions {
        CreationOwnershipOptions {
            owner: self.owner.clone(),
            group: self.group.clone(),
            inherit_owner: self.inherit_owner,
            inherit_group: self.inherit_group,
        }
    }
}

/// Parses the required byte count shared by streamed write endpoints.
pub(crate) fn required_content_length(
    headers: &HeaderMap,
    operation: &str,
) -> Result<u64, ApiError> {
    let Some(header_value) = headers.get(axum::http::header::CONTENT_LENGTH) else {
        return Err(ApiError::status(
            StatusCode::LENGTH_REQUIRED,
            format!("Content-Length header is required for {operation}"),
        ));
    };
    header_value
        .to_str()
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ApiError::bad_request("Invalid Content-Length header"))
}

/// Route: `PUT /api/v1/agents/{agent}/raw/{*path}`
pub(crate) async fn raw_agent_put_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    Query(params): Query<RawUploadQueryParams>,
    AxumState(state): AxumState<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<RawUploadResponse>, ApiError> {
    let path = absolute_path_from_url(path.unwrap_or_default());
    let ownership = params.ownership();
    ownership.validate().map_err(ApiError::bad_request)?;
    let total_bytes = required_content_length(&headers, "uploads")?;
    let request_guard = state.upload_requests.reserve(&headers)?;
    let command = Command::RawUpload(request::RawUpload {
        partial: None,
        path: path.clone(),
        on_existing: params.on_existing,
        ownership,
        executable: false,
        precondition: None,
    });
    let upload = AgentUpload::start(
        &state.router_ref,
        agent_id,
        command,
        path.clone(),
        total_bytes,
    )
    .await?;
    let UploadStart::Ready(mut upload) = upload else {
        return Ok(Json(RawUploadResponse {
            path,
            bytes_written: 0,
        }));
    };
    if let Some(guard) = &request_guard {
        guard.activate(upload.request_id().as_transfer_id())?;
    }
    upload.forward_body(body).await?;
    let bytes_written = upload.finish().await?;
    Ok(Json(RawUploadResponse {
        path,
        bytes_written,
    }))
}
