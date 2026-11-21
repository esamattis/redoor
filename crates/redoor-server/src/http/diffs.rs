//! REST endpoint that diffs two editable files, possibly on different agents.

use crate::actors::router::OutputStreamTracking;
use crate::workspaces::AgentKey;
use axum::{Extension, Json, extract::State as AxumState};
use redoor_protocol::wire::request;
use redoor_protocol::{
    api::{
        diffs::{DiffEndpoint, DiffFilesRequest, DiffFilesResponse},
        files::MetadataResponse,
        git::MAX_FULL_CONTEXT_PATCH_BYTES,
        tokens::Permission,
    },
    wire::command::Command,
};

use super::{
    access::Principal, agent_client::Metadata, agent_helpers::require_absolute_path,
    error::ApiError, services::output::OutputStream, state::ServerState,
};

/// The unchanged lines kept around each change when the files are too large to send whole,
/// matching `git diff`.
const DEFAULT_CONTEXT_LINES: usize = 3;

/// Route: `POST /api/v1/diff`; reads both files, so it needs read on both devices.
pub(crate) async fn diff_files_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(mut payload): Json<DiffFilesRequest>,
) -> Result<Json<DiffFilesResponse>, ApiError> {
    let owner = principal.owner();
    // Body fields accept a name or an id; resolving before `require` keeps scope checks on
    // ids, so a name that now belongs to another device cannot slip past a scope.
    payload.left.agent = state
        .agents
        .resolve(owner, payload.left.agent.as_str())
        .await?;
    payload.right.agent = state
        .agents
        .resolve(owner, payload.right.agent.as_str())
        .await?;
    principal.require(&[Permission::FilesRead], &payload.left.agent)?;
    principal.require(&[Permission::FilesRead], &payload.right.agent)?;
    let left = DiffEndpoint {
        path: require_absolute_path(payload.left.path)?,
        agent: payload.left.agent,
    };
    let right = DiffEndpoint {
        path: require_absolute_path(payload.right.path)?,
        agent: payload.right.agent,
    };

    let (left_metadata, right_metadata) = tokio::join!(
        fetch_metadata(&state, owner, &left),
        fetch_metadata(&state, owner, &right)
    );
    let (left_metadata, right_metadata) = (left_metadata?, right_metadata?);
    if !left_metadata.editable || !right_metadata.editable {
        return Err(ApiError::bad_request("Diff supports editable files only"));
    }

    let (left_content, right_content) = tokio::join!(
        download_editable_file(&state, owner, &left, left_metadata.file_size),
        download_editable_file(&state, owner, &right, right_metadata.file_size)
    );
    let (left_content, right_content) = (left_content?, right_content?);
    let text_diff = similar::TextDiff::from_lines(&left_content, &right_content);
    let mut patch = text_diff.unified_diff();
    patch.header(&left.path, &right.path);
    // A file has no more lines than bytes, so this radius keeps every unchanged line without
    // the overflow `usize::MAX` would cause inside `similar`.
    let whole = patch
        .context_radius(left_content.len().max(right_content.len()))
        .to_string();
    // Both files are already in memory, so formatting them whole before checking the size
    // costs little more than the patch the UI would otherwise get.
    let response = if whole.len() <= MAX_FULL_CONTEXT_PATCH_BYTES {
        DiffFilesResponse {
            unified_diff: whole,
            full_context: true,
        }
    } else {
        DiffFilesResponse {
            unified_diff: patch.context_radius(DEFAULT_CONTEXT_LINES).to_string(),
            full_context: false,
        }
    };
    Ok(Json(response))
}

/// Reuses agent metadata so diff eligibility cannot drift from the file editor's gate.
async fn fetch_metadata(
    state: &ServerState,
    owner: &str,
    endpoint: &DiffEndpoint,
) -> Result<MetadataResponse, ApiError> {
    let key = AgentKey::new(owner, endpoint.agent.clone());
    state
        .agents
        .call(
            &key,
            Metadata {
                path: endpoint.path.clone(),
            },
        )
        .await
}

/// Downloads an already size-bounded editable file through the normal agent stream path.
async fn download_editable_file(
    state: &ServerState,
    owner: &str,
    endpoint: &DiffEndpoint,
    expected_size: u64,
) -> Result<String, ApiError> {
    let capacity = usize::try_from(expected_size)
        .map_err(|_| ApiError::bad_request("Editable file size is unsupported"))?;
    let mut stream = OutputStream::open(
        &state.router_ref,
        AgentKey::new(owner, endpoint.agent.clone()),
        Command::RawDownload(request::RawDownload {
            expected_identity: None,
            path: endpoint.path.clone(),
            range_start: None,
            range_end: None,
        }),
        OutputStreamTracking::Download {
            path: endpoint.path.clone(),
            total_bytes: expected_size,
            full_size: Some(expected_size),
            resume_offset: None,
        },
    )
    .await?;
    let read = stream.read_bounded(capacity).await.map_err(|error| {
        let message = error.0.message;
        if message.is_empty() {
            ApiError::bad_request(format!("Failed to download {}", endpoint.path))
        } else {
            ApiError::bad_request(message)
        }
    })?;
    // A grown, shrunk or truncated file no longer matches the metadata the diff was gated on.
    if read.overflowed || !read.completed || read.data.len() != capacity {
        return Err(ApiError::bad_request(
            "File changed while it was being prepared for diff",
        ));
    }
    String::from_utf8(read.data).map_err(|_| {
        ApiError::bad_request("File is no longer editable because it is not valid UTF-8")
    })
}
