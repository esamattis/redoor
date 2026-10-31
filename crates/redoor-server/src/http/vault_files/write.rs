//! Encrypted writes: editor saves, uploads, rewraps and re-encryptions.
//!
//! Every write uses the current key generation (anything else is `stale_vault_key`) and
//! publishes through a raw upload whose precondition the agent checks right before the
//! rename, so a failed write leaves the previous file intact and a stale one is a conflict.

use std::io::Cursor;

use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use futures_util::TryStreamExt;
use redoor_core::vault::{
    CHUNK_SIZE, DecryptingReader, EncryptingReader, FileKey, PAYLOAD_SALT_LEN, VaultFormatError,
    VaultPreamble, payload_len, random_base64url,
};
use redoor_protocol::api::{
    transfers::CopyExistingMode,
    vault::{
        ApiErrorCode, ReencryptVaultFileRequest, RewrapVaultFileRequest, VAULT_PAYLOAD_ALG,
        VAULT_WRAP_ALG, VaultDocument, VaultFileHeader, VaultFileWriteResponse, VaultKeyWrap,
        VaultObjectKind, VaultPayloadParams,
    },
};
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::{
    command::{Command, CommandErrorKind, UploadPrecondition},
    request,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::io::StreamReader;

use super::{
    KEY_HEADER, REVISION_HEADER, VaultSource, file_changed, file_key, format_error,
    require_revision, required_header, revision, vault_path,
};
use crate::http::{
    access::ResolvedDevice,
    agent_client::MoveMetadata,
    agent_helpers::AgentFilePath,
    error::ApiError,
    raw::upload::required_content_length,
    services::upload::{AgentUpload, UploadStart},
    state::ServerState,
    upload_requests::UploadRequestGuard,
};

/// Carries the generation that wraps the file key of a `fetch` write.
const KEY_ID_HEADER: &str = "redoor-vault-key-id";
/// Carry the file key wrapped with that generation.
const WRAP_IV_HEADER: &str = "redoor-vault-wrap-iv";
const WRAP_CT_HEADER: &str = "redoor-vault-wrap-ct";

/// The key material of a `fetch` write: the file key and its wrap under `key_id`.
struct WriteKeys {
    key: FileKey,
    key_id: String,
    wrap: VaultKeyWrap,
}

impl WriteKeys {
    /// Reads the write headers.
    fn from_headers(headers: &HeaderMap) -> Result<Self, ApiError> {
        Ok(Self {
            key: file_key(required_header(headers, KEY_HEADER)?)?,
            key_id: required_header(headers, KEY_ID_HEADER)?.to_string(),
            wrap: VaultKeyWrap {
                alg: VAULT_WRAP_ALG.to_string(),
                iv: required_header(headers, WRAP_IV_HEADER)?.to_string(),
                ct: required_header(headers, WRAP_CT_HEADER)?.to_string(),
            },
        })
    }
}

/// The preamble of a new file version: a fresh payload salt, the vault's id and label,
/// and the browser's wrap of the new file key.
fn new_preamble(
    document: &VaultDocument,
    keys: &WriteKeys,
    kind: VaultObjectKind,
    context: std::collections::BTreeMap<String, String>,
) -> Result<VaultPreamble, ApiError> {
    VaultPreamble::build(
        VaultFileHeader {
            vault_id: document.vault_id.clone(),
            vault_label: document.label.clone(),
            key_id: keys.key_id.clone(),
            kind,
            context,
            wrap: keys.wrap.clone(),
            payload: VaultPayloadParams {
                alg: VAULT_PAYLOAD_ALG.to_string(),
                chunk_size: CHUNK_SIZE as u32,
                salt: random_base64url(PAYLOAD_SALT_LEN),
            },
        },
        &keys.key,
    )
    .map_err(|error| match error {
        // The wrap is the only browser input in the header.
        VaultFormatError::InvalidHeader(message) => ApiError::coded(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::VaultInvalid,
            format!("Invalid file key wrap: {message}"),
        ),
        error => format_error(error),
    })
}

/// Refuses agents that would ignore the write precondition.
async fn require_preconditions(state: &ServerState, agent_id: &AgentId) -> Result<(), ApiError> {
    let entry = crate::http::trash::inventory_entry(state, agent_id).await?;
    if entry.supports_upload_preconditions {
        Ok(())
    } else {
        Err(ApiError::coded(
            StatusCode::CONFLICT,
            ApiErrorCode::AgentUpgradeRequired,
            "Upgrade this device's agent to write vault files",
        ))
    }
}

/// The identity of the file on the device, checked against the revision the browser read.
async fn current_identity(
    state: &ServerState,
    agent_id: &AgentId,
    path: &str,
    expected: &str,
) -> Result<redoor_protocol::wire::command::MoveSourceIdentity, ApiError> {
    let metadata = state
        .agents
        .call(
            agent_id,
            MoveMetadata {
                path: path.to_string(),
            },
        )
        .await
        .map_err(|error| match error {
            // A removed file is a change too.
            ApiError::Command {
                kind: CommandErrorKind::NotFound,
                ..
            } => file_changed(),
            error => error,
        })?;
    require_revision(&metadata.identity, expected)?;
    Ok(metadata.identity)
}

/// Maps agent write failures: a failed precondition is the vault's own conflict.
fn write_error(error: ApiError) -> ApiError {
    match error {
        ApiError::Command {
            kind: CommandErrorKind::SourceChanged,
            ..
        } => file_changed(),
        error => error,
    }
}

/// A failed read of the write's source: corruption keeps its code, anything else is the
/// client's body failing.
fn source_error(error: std::io::Error) -> ApiError {
    match VaultFormatError::from_io(&error) {
        Some(error) => format_error(error),
        None => ApiError::bad_request(format!("Failed to read the content: {error}")),
    }
}

/// One encrypted write: the destination, its precondition and the exact ciphertext size.
struct Publication<'a> {
    state: &'a ServerState,
    agent_id: &'a AgentId,
    path: String,
    precondition: Option<UploadPrecondition>,
    on_existing: CopyExistingMode,
    total_bytes: u64,
}

impl Publication<'_> {
    /// Streams `source` into a raw upload and reports the new revision.
    async fn run(
        self,
        mut source: impl AsyncRead + Unpin,
        request_guard: Option<&UploadRequestGuard>,
    ) -> Result<VaultFileWriteResponse, ApiError> {
        let command = Command::RawUpload(request::RawUpload {
            partial: None,
            path: self.path.clone(),
            on_existing: self.on_existing,
            ownership: Default::default(),
            executable: false,
            precondition: self.precondition,
        });
        let upload = AgentUpload::start(
            &self.state.router_ref,
            self.agent_id.clone(),
            command,
            self.path.clone(),
            self.total_bytes,
        )
        .await
        .map_err(write_error)?;
        let UploadStart::Ready(mut upload) = upload else {
            return Err(ApiError::internal("A vault file is never empty"));
        };
        if let Some(guard) = request_guard {
            guard.activate(upload.request_id().as_transfer_id())?;
        }
        // Holds ciphertext only, so it needs no zeroing.
        let mut buffer = vec![0u8; CHUNK_SIZE];
        loop {
            let read = source.read(&mut buffer).await.map_err(source_error)?;
            if read == 0 {
                break;
            }
            upload.send(&buffer[..read]).await.map_err(write_error)?;
        }
        let bytes_written = upload.finish().await.map_err(write_error)?;
        // Read right after publishing: another writer in this window makes the next save
        // conflict, never get lost.
        let revision = self
            .state
            .agents
            .call(
                self.agent_id,
                MoveMetadata {
                    path: self.path.clone(),
                },
            )
            .await
            .ok()
            .map(|metadata| revision(&metadata.identity));
        Ok(VaultFileWriteResponse {
            path: self.path,
            bytes_written,
            revision,
        })
    }
}

/// Turns a request body into an `AsyncRead`.
fn body_reader(body: Body) -> impl AsyncRead + Unpin {
    StreamReader::new(body.into_data_stream().map_err(std::io::Error::other))
}

/// Route: `PUT /api/v1/agents/{agent}/vault/edit/{*path}`: an editor save. The body is the
/// plaintext; the browser generated a new file key and wrapped it with the current
/// generation, and `Redoor-Vault-Revision` names the version it edited.
pub(crate) async fn edit_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<VaultFileWriteResponse>, ApiError> {
    let path = vault_path(path)?;
    let keys = WriteKeys::from_headers(&headers)?;
    let expected = required_header(&headers, REVISION_HEADER)?;
    let plaintext = required_content_length(&headers, "vault saves")?;
    let document = state.vault.require_current(&keys.key_id).await?;
    require_preconditions(&state, &agent_id).await?;
    let identity = current_identity(&state, &agent_id, &path, expected).await?;
    let preamble = new_preamble(&document, &keys, VaultObjectKind::File, Default::default())?;
    let total_bytes = preamble.len() as u64 + payload_len(plaintext);
    let encrypting =
        EncryptingReader::new(body_reader(body), &preamble, &keys.key).map_err(format_error)?;
    let source = Cursor::new(preamble.to_bytes()).chain(encrypting);
    Publication {
        state: &state,
        agent_id: &agent_id,
        path,
        precondition: Some(UploadPrecondition::Matches { identity }),
        on_existing: CopyExistingMode::Override,
        total_bytes,
    }
    .run(source, None)
    .await
    .map(Json)
}

/// Replacement behavior of an encrypted upload.
#[derive(serde::Deserialize)]
pub(crate) struct UploadQuery {
    /// Strict creation by default, like plain uploads.
    #[serde(default)]
    on_existing: CopyExistingMode,
}

/// Route: `PUT /api/v1/agents/{agent}/vault/raw/{*path}`: an encrypted upload, also used to
/// create a new vault file. The path already carries the `.redoorvault` suffix.
pub(crate) async fn upload_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    Query(query): Query<UploadQuery>,
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<VaultFileWriteResponse>, ApiError> {
    let path = vault_path(path)?;
    let keys = WriteKeys::from_headers(&headers)?;
    let plaintext = required_content_length(&headers, "uploads")?;
    let document = state.vault.require_current(&keys.key_id).await?;
    require_preconditions(&state, &agent_id).await?;
    let request_guard = state.upload_requests.reserve(&headers)?;
    let preamble = new_preamble(&document, &keys, VaultObjectKind::File, Default::default())?;
    let total_bytes = preamble.len() as u64 + payload_len(plaintext);
    let encrypting =
        EncryptingReader::new(body_reader(body), &preamble, &keys.key).map_err(format_error)?;
    let source = Cursor::new(preamble.to_bytes()).chain(encrypting);
    let (precondition, on_existing) = match query.on_existing {
        CopyExistingMode::Error => (
            Some(UploadPrecondition::MustNotExist),
            CopyExistingMode::Error,
        ),
        // A whole-file replacement; merging means the same for one file.
        CopyExistingMode::Override | CopyExistingMode::Merge => (None, CopyExistingMode::Override),
    };
    Publication {
        state: &state,
        agent_id: &agent_id,
        path,
        precondition,
        on_existing,
        total_bytes,
    }
    .run(source, request_guard.as_ref())
    .await
    .map(Json)
}

/// Opens a file for a rewrite and checks it is still the version the browser read and
/// belongs to this vault.
async fn open_for_rewrite(
    state: &ServerState,
    agent_id: &AgentId,
    path: &str,
    expected_revision: &str,
) -> Result<VaultSource, ApiError> {
    let source = VaultSource::open(state, agent_id, path, false).await?;
    require_revision(&source.identity, expected_revision)?;
    state
        .vault
        .require_readable(source.preamble.header())
        .await?;
    source.plaintext_len()?;
    Ok(source)
}

/// Route: `POST /api/v1/agents/{agent}/vault/rewrap/{*path}`: moves a file to the current
/// generation by replacing only its header. The old MAC is checked with the file key,
/// which proves the key belongs to this file, and the payload bytes are copied unchanged:
/// nothing is decrypted.
pub(crate) async fn rewrap_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    State(state): State<ServerState>,
    Json(request): Json<RewrapVaultFileRequest>,
) -> Result<Json<VaultFileWriteResponse>, ApiError> {
    let path = vault_path(path)?;
    let key = file_key(&request.file_key)?;
    let document = state.vault.require_current(&request.key_id).await?;
    require_preconditions(&state, &agent_id).await?;
    let source = open_for_rewrite(&state, &agent_id, &path, &request.expected_revision).await?;
    source.preamble.verify(&key).map_err(format_error)?;
    let old = source.preamble.header().clone();
    let preamble = VaultPreamble::build(
        VaultFileHeader {
            vault_label: document.label.clone(),
            key_id: request.key_id,
            wrap: request.wrap,
            ..old
        },
        &key,
    )
    .map_err(format_error)?;
    let total_bytes = preamble.len() as u64 + source.payload_len();
    let identity = source.identity.clone();
    let payload = Cursor::new(preamble.to_bytes()).chain(source.reader);
    Publication {
        state: &state,
        agent_id: &agent_id,
        path,
        precondition: Some(UploadPrecondition::Matches { identity }),
        on_existing: CopyExistingMode::Override,
        total_bytes,
    }
    .run(payload, None)
    .await
    .map(Json)
}

/// Route: `POST /api/v1/agents/{agent}/vault/reencrypt/{*path}`: decrypts with the old file
/// key and encrypts with a new one, as a stream, for files a compromised server may have
/// seen the key of.
pub(crate) async fn reencrypt_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    State(state): State<ServerState>,
    Json(request): Json<ReencryptVaultFileRequest>,
) -> Result<Json<VaultFileWriteResponse>, ApiError> {
    let path = vault_path(path)?;
    let old_key = file_key(&request.file_key)?;
    let keys = WriteKeys {
        key: file_key(&request.new_file_key)?,
        key_id: request.key_id,
        wrap: request.wrap,
    };
    let document = state.vault.require_current(&keys.key_id).await?;
    require_preconditions(&state, &agent_id).await?;
    let source = open_for_rewrite(&state, &agent_id, &path, &request.expected_revision).await?;
    let plaintext = source.plaintext_len()?;
    let old = source.preamble.header().clone();
    let preamble = new_preamble(&document, &keys, old.kind, old.context)?;
    let total_bytes = preamble.len() as u64 + payload_len(plaintext);
    let identity = source.identity.clone();
    let decrypting =
        DecryptingReader::new(source.reader, &source.preamble, &old_key).map_err(format_error)?;
    let encrypting =
        EncryptingReader::new(decrypting, &preamble, &keys.key).map_err(format_error)?;
    let payload = Cursor::new(preamble.to_bytes()).chain(encrypting);
    Publication {
        state: &state,
        agent_id: &agent_id,
        path,
        precondition: Some(UploadPrecondition::Matches { identity }),
        on_existing: CopyExistingMode::Override,
        total_bytes,
    }
    .run(payload, None)
    .await
    .map(Json)
}
