//! REST handlers that open and write `.redoorvault` files on devices.
//!
//! Encryption and decryption run here, as a stream: agents only ever see ciphertext, and
//! the server only gets the key of the one file a request handles, for that request. The
//! browser sends that key in the `Redoor-Vault-Key` header (or a JSON or form field), never
//! in a URL. Plaintext passes through at most one 64 KiB chunk at a time and is never
//! written to a temporary file.
//!
//! Reads check the preamble before the response starts, so every format and vault error is
//! a JSON error with its own code; a payload chunk that fails later can only abort the body.
//! Writes go through the raw upload flow (staging and an atomic rename) with a precondition
//! on the file the browser read, so a failed write never leaves a partial vault file and a
//! stale one never overwrites a newer version.

mod write;

pub(crate) use write::{edit_handler, reencrypt_handler, rewrap_handler, upload_handler};

use axum::{
    Form, Json,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use redoor_core::vault::{
    DecryptingReader, FileKey, MAX_PREAMBLE_LEN, VaultFormatError, VaultPreamble, VaultReadError,
    is_vault_path, plaintext_len,
};
use redoor_protocol::api::vault::{ApiErrorCode, VAULT_FILE_SUFFIX, VaultFileHeaderResponse};
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::{command::Command, command::MoveSourceIdentity, request};
use tokio_util::io::{ReaderStream, StreamReader};

use super::{
    access::ResolvedDevice,
    agent_client::MoveMetadata,
    agent_helpers::{AgentFilePath, absolute_path_from_url},
    error::ApiError,
    raw::{attachment_disposition, ensure_download_started},
    services::output::OutputStream,
    state::ServerState,
};
use crate::actors::router::OutputStreamTracking;

/// Carries the file key of `fetch` requests.
pub(crate) const KEY_HEADER: &str = "redoor-vault-key";
/// Carries the expected revision of a save, and the revision of a read.
pub(crate) const REVISION_HEADER: &str = "redoor-vault-revision";

/// Bytes handed to the HTTP body at a time: one plaintext chunk.
const BODY_CAPACITY: usize = redoor_core::vault::CHUNK_SIZE;

/// The opaque revision of a file: a hash of its identity (device, inode, size, mtime).
/// Every vault write replaces the inode, so a revision changes with every save, and the
/// identity itself stays private to the server.
pub(crate) fn revision(identity: &MoveSourceIdentity) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [
        identity.device,
        identity.inode,
        identity.size,
        identity.modified_seconds as u64,
        identity.modified_nanoseconds as u64,
    ] {
        hasher.update(&value.to_le_bytes());
    }
    hasher.finalize().to_hex()[..32].to_string()
}

/// Accepts only paths with a name before the `.redoorvault` suffix, so the vault endpoints
/// cannot be pointed at ordinary files.
fn vault_path(path: Option<String>) -> Result<String, ApiError> {
    let path = absolute_path_from_url(path.unwrap_or_default());
    if is_vault_path(&path) {
        Ok(path)
    } else {
        Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::NotAVaultPath,
            format!("Vault files must end in {VAULT_FILE_SUFFIX}"),
        ))
    }
}

/// The error each format failure is reported with.
pub(crate) fn format_error(error: VaultFormatError) -> ApiError {
    let code = match &error {
        VaultFormatError::BadMagic => ApiErrorCode::NotAVaultFile,
        VaultFormatError::UnsupportedVersion(_) => ApiErrorCode::VaultFormatUnsupported,
        VaultFormatError::InvalidHeader(_) | VaultFormatError::Truncated => {
            ApiErrorCode::VaultHeaderCorrupted
        }
        VaultFormatError::HeaderMac => ApiErrorCode::VaultHeaderTampered,
        VaultFormatError::CorruptChunk { .. } => ApiErrorCode::VaultPayloadCorrupted,
        VaultFormatError::InvalidKey => {
            return ApiError::coded(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::InvalidVaultFileKey,
                error.to_string(),
            );
        }
    };
    ApiError::coded(StatusCode::UNPROCESSABLE_ENTITY, code, error.to_string())
}

/// Parses a base64url file key.
pub(crate) fn file_key(encoded: &str) -> Result<FileKey, ApiError> {
    FileKey::from_base64url(encoded).map_err(format_error)
}

/// Reads a required ASCII request header.
pub(crate) fn required_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::bad_request(format!("The {name} header is required")))
}

/// Fails when the file changed since the browser read it.
pub(crate) fn require_revision(
    identity: &MoveSourceIdentity,
    expected: &str,
) -> Result<(), ApiError> {
    if revision(identity) == expected {
        Ok(())
    } else {
        Err(file_changed())
    }
}

/// The file changed on the device since it was read.
pub(crate) fn file_changed() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        ApiErrorCode::VaultFileChanged,
        "The file changed on the device since it was opened",
    )
}

/// A vault file on a device, opened for reading: its preamble is parsed and the stream
/// stands at the first payload byte.
pub(crate) struct VaultSource {
    pub(crate) preamble: VaultPreamble,
    pub(crate) identity: MoveSourceIdentity,
    pub(crate) file_size: u64,
    pub(crate) reader: StreamReader<OutputStream, bytes::Bytes>,
}

impl VaultSource {
    /// Opens `path` and reads its preamble. With `header_only`, only the bytes a preamble
    /// can occupy are requested from the agent.
    pub(crate) async fn open(
        state: &ServerState,
        agent_id: &AgentId,
        path: &str,
        header_only: bool,
    ) -> Result<Self, ApiError> {
        let metadata = state
            .agents
            .call(
                agent_id,
                MoveMetadata {
                    path: path.to_string(),
                },
            )
            .await?;
        if !metadata.is_file {
            return Err(ApiError::bad_request(format!("Not a file: {path}")));
        }
        if metadata.file_size == 0 {
            return Err(format_error(VaultFormatError::BadMagic));
        }
        let range_end = header_only.then(|| metadata.file_size.min(MAX_PREAMBLE_LEN as u64));
        let mut output = OutputStream::open(
            &state.router_ref,
            agent_id.clone(),
            Command::RawDownload(request::RawDownload {
                // The bytes must come from the file whose revision the response reports.
                expected_identity: Some(metadata.identity.clone()),
                path: path.to_string(),
                range_start: range_end.map(|_| 0),
                range_end,
            }),
            OutputStreamTracking::Download {
                path: path.to_string(),
                total_bytes: range_end.unwrap_or(metadata.file_size),
                full_size: Some(metadata.file_size),
                resume_offset: None,
            },
        )
        .await?;
        ensure_download_started(&mut output, path).await?;
        let mut reader = StreamReader::new(output);
        let preamble = VaultPreamble::read(&mut reader)
            .await
            .map_err(|error| match error {
                VaultReadError::Format(error) => format_error(error),
                VaultReadError::Io(error) => {
                    ApiError::internal(format!("Failed to read {path}: {error}"))
                }
            })?;
        Ok(Self {
            preamble,
            identity: metadata.identity,
            file_size: metadata.file_size,
            reader,
        })
    }

    /// Payload bytes after the preamble.
    pub(crate) fn payload_len(&self) -> u64 {
        self.file_size.saturating_sub(self.preamble.len() as u64)
    }

    /// The content length, or a corruption error when no plaintext encrypts to the
    /// payload's length (a truncated or padded file).
    pub(crate) fn plaintext_len(&self) -> Result<u64, ApiError> {
        plaintext_len(self.payload_len()).ok_or_else(|| {
            ApiError::coded(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::VaultPayloadCorrupted,
                "The vault file is truncated or has data appended",
            )
        })
    }

    /// Opens the payload for decryption after the vault and MAC checks, in the order of
    /// the error table: vault and generation, then the header MAC with this key.
    async fn decrypt(
        self,
        state: &ServerState,
        key: &FileKey,
    ) -> Result<
        (
            u64,
            String,
            DecryptingReader<StreamReader<OutputStream, bytes::Bytes>>,
        ),
        ApiError,
    > {
        state.vault.require_readable(self.preamble.header()).await?;
        let len = self.plaintext_len()?;
        let revision = revision(&self.identity);
        let reader =
            DecryptingReader::new(self.reader, &self.preamble, key).map_err(format_error)?;
        Ok((len, revision, reader))
    }
}

/// Route: `GET /api/v1/agents/{agent}/vault/header/{*path}`. Reads only the preamble and
/// decrypts nothing, so it works while the vault is locked.
pub(crate) async fn header_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    State(state): State<ServerState>,
) -> Result<Json<VaultFileHeaderResponse>, ApiError> {
    let path = vault_path(path)?;
    let mut source = VaultSource::open(&state, &agent_id, &path, true).await?;
    // Finishing the short range keeps the transfer from being recorded as cancelled.
    let _ = tokio::io::copy(&mut source.reader, &mut tokio::io::sink()).await;
    let plaintext_size = source.plaintext_len()?;
    let key_status = state.vault.key_status(source.preamble.header()).await?;
    Ok(Json(VaultFileHeaderResponse {
        path,
        revision: revision(&source.identity),
        file_size: source.file_size,
        plaintext_size,
        key_status,
        header: source.preamble.header().clone(),
    }))
}

/// Route: `POST /api/v1/agents/{agent}/vault/read/{*path}`: the decrypted content for the
/// editor, with the file key in the `Redoor-Vault-Key` header.
pub(crate) async fn read_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    Path(AgentFilePath { path }): Path<AgentFilePath>,
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let path = vault_path(path)?;
    let key = file_key(required_header(&headers, KEY_HEADER)?)?;
    let source = VaultSource::open(&state, &agent_id, &path, false).await?;
    let (len, revision, reader) = source.decrypt(&state, &key).await?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(REVISION_HEADER, revision)
        .body(Body::from_stream(ReaderStream::with_capacity(
            reader,
            BODY_CAPACITY,
        )))
        .expect("valid response headers"))
}

/// The form a decrypted download posts. A form navigation lets the browser save the
/// response straight to disk as a stream, which `fetch` cannot do.
#[derive(serde::Deserialize)]
pub(crate) struct DownloadForm {
    path: String,
    file_key: String,
}

/// Refuses cross-site form posts. This route takes a form body, which any site can submit
/// with the user's cookies, so it checks where the request came from itself.
fn require_same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let fetch_site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok());
    let same_site = fetch_site.is_none_or(|site| site == "same-origin");
    if same_site && super::websocket_security::is_same_origin(headers) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "Cross-origin vault downloads are refused",
        ))
    }
}

/// Route: `POST /api/v1/agents/{agent}/vault/download`: a decrypted download, saved by the
/// browser without the `.redoorvault` suffix.
pub(crate) async fn download_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
    headers: HeaderMap,
    Form(form): Form<DownloadForm>,
) -> Result<Response, ApiError> {
    require_same_origin(&headers)?;
    let path = form
        .path
        .strip_prefix('/')
        .map(str::to_string)
        .ok_or_else(|| ApiError::bad_request("Filesystem path must be absolute"))
        .and_then(|path| vault_path(Some(path)))?;
    let key = file_key(&form.file_key)?;
    let source = VaultSource::open(&state, &agent_id, &path, false).await?;
    let (len, _, reader) = source.decrypt(&state, &key).await?;
    let name = path.rsplit('/').next().unwrap_or("file");
    let name = name.strip_suffix(VAULT_FILE_SUFFIX).unwrap_or(name);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_DISPOSITION, attachment_disposition(name))
        .body(Body::from_stream(ReaderStream::with_capacity(
            reader,
            BODY_CAPACITY,
        )))
        .expect("valid response headers"))
}
