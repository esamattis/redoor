//! Per-account editor buffers of open files, one file per buffer in the account's
//! `editor-buffers` directory.
//!
//! Buffers are separate from the user state document because that document is replaced
//! whole on every preference change: keeping buffers there would rewrite every buffer on each
//! debounced keystroke and let two browsers overwrite each other's unrelated buffers.
//!
//! Buffers belong to one user, who edits from one computer at a time, so the store is plain
//! last-writer-wins: every write gets a new server-assigned version that browsers compare to
//! notice a buffer written on another computer. The open files list in the user state decides
//! which buffers may stay: replacing the user state deletes the buffers of files that are no
//! longer open, as a backstop to browsers deleting the buffer of a file they close.

use std::{collections::HashSet, path::PathBuf};

use axum::{
    Json,
    extract::{Path, State},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use redoor_protocol::api::editor_buffers::{
    DeleteEditorBufferResponse, EditorBuffer, EditorBufferResponse, PutEditorBufferRequest,
    PutEditorBufferResponse,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    error::ApiError,
    state::ServerState,
    user_state::{account_directory, prepare_account_directory, write_private_file_atomically},
};

/// Longest accepted buffer key, generous for an agent id plus a deep path.
const MAX_KEY_BYTES: usize = 8 * 1024;

/// Directory, inside the account directory, that holds one file per buffer.
const BUFFERS_DIRECTORY: &str = "editor-buffers";

/// The on-disk record. The key is stored alongside the data so a read can verify that the
/// hashed file name really belongs to the requested key.
#[derive(Serialize, Deserialize)]
struct StoredEditorBuffer {
    key: String,
    version: u64,
    data: serde_json::Value,
}

/// Route: `GET /api/v1/user/editor-buffers/{key}` returns the stored buffer or null.
pub(crate) async fn get_editor_buffer_handler(
    State(state): State<ServerState>,
    Path(encoded_key): Path<String>,
) -> Result<Json<EditorBufferResponse>, ApiError> {
    let key = decode_key(&encoded_key)?;
    let path = buffer_path(&state, &key)?;
    let buffer = read_buffer(&path, &key).await?.map(|stored| EditorBuffer {
        version: stored.version,
        data: stored.data,
    });

    Ok(Json(EditorBufferResponse { key, buffer }))
}

/// Route: `PUT /api/v1/user/editor-buffers/{key}` replaces a buffer (last writer wins) and
/// returns its new version.
pub(crate) async fn put_editor_buffer_handler(
    State(state): State<ServerState>,
    Path(encoded_key): Path<String>,
    Json(request): Json<PutEditorBufferRequest>,
) -> Result<Json<PutEditorBufferResponse>, ApiError> {
    let key = decode_key(&encoded_key)?;
    // A vault file's draft is plaintext; the browser never sends it, and this keeps a buggy
    // client from writing it to the server's disk anyway.
    if redoor_vault::is_vault_path(&key) {
        return Err(ApiError::bad_request(
            "Editor buffers of vault files are never stored",
        ));
    }
    let path = buffer_path(&state, &key)?;
    // Serializes writes, so versions only grow and a cleanup cannot interleave with a write.
    let _guard = state.editor_buffer_lock.lock().await;
    let previous = read_buffer(&path, &key).await?.map(|stored| stored.version);

    let stored = StoredEditorBuffer {
        key: key.clone(),
        version: next_version(previous),
        data: request.data,
    };

    write_buffer(&state, &path, &stored).await?;

    Ok(Json(PutEditorBufferResponse {
        key,
        version: stored.version,
    }))
}

/// Route: `DELETE /api/v1/user/editor-buffers/{key}` forgets a buffer when its file is closed.
pub(crate) async fn delete_editor_buffer_handler(
    State(state): State<ServerState>,
    Path(encoded_key): Path<String>,
) -> Result<Json<DeleteEditorBufferResponse>, ApiError> {
    let key = decode_key(&encoded_key)?;
    let path = buffer_path(&state, &key)?;
    let _guard = state.editor_buffer_lock.lock().await;

    let deleted = match tokio::fs::remove_file(&path).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(ApiError::internal(format!(
                "Failed to delete editor buffer: {error}"
            )));
        }
    };

    Ok(Json(DeleteEditorBufferResponse { key, deleted }))
}

/// Deletes the buffers of files that are not in the open files list of `user_state`. Called
/// with the buffer lock held, right after the user state is replaced, so a file closed in
/// any browser loses its buffer even if that browser's own delete never arrived.
pub(super) async fn delete_closed_buffers(
    paths: &redoor_core::paths::AppPaths,
    username: &str,
    user_state: &serde_json::Value,
) -> anyhow::Result<()> {
    let directory = account_directory(paths, username)?.join(BUFFERS_DIRECTORY);
    let open: HashSet<String> = open_file_keys(user_state)
        .iter()
        .map(|key| buffer_file_name(key))
        .collect();
    let mut entries = match tokio::fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };

        // File names are key hashes, so no buffer has to be read to know whom it belongs to.
        if name.ends_with(".json") && !open.contains(name) {
            match tokio::fs::remove_file(entry.path()).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    Ok(())
}

/// One entry of the UI's `openFiles` list; other fields are the UI's business.
#[derive(Deserialize)]
struct OpenFileEntry {
    #[serde(rename = "agentId")]
    agent_id: String,
    path: String,
}

/// The buffer keys (`<agentId>:<path>`, as the UI builds them) of the open files list.
/// Malformed entries are skipped, so they cannot keep a buffer alive.
fn open_file_keys(user_state: &serde_json::Value) -> HashSet<String> {
    let Some(entries) = user_state
        .get("openFiles")
        .and_then(serde_json::Value::as_array)
    else {
        return HashSet::new();
    };

    entries
        .iter()
        .filter_map(|entry| serde_json::from_value::<OpenFileEntry>(entry.clone()).ok())
        .map(|entry| format!("{}:{}", entry.agent_id, entry.path))
        .collect()
}

/// Keys travel base64url-encoded, so a path containing `/` stays one URL segment.
fn decode_key(encoded_key: &str) -> Result<String, ApiError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded_key)
        .map_err(|_| ApiError::bad_request("Editor buffer key must be base64url encoded"))?;
    let key = String::from_utf8(bytes)
        .map_err(|_| ApiError::bad_request("Editor buffer key must be UTF-8"))?;

    if key.is_empty() || key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "Editor buffer key must be non-empty, printable and at most 8 KiB",
        ));
    }

    Ok(key)
}

/// Names the file by the key's SHA-256, so no key, however crafted, can leave the directory
/// or collide with the temporary files written next to it.
fn buffer_path(state: &ServerState, key: &str) -> Result<PathBuf, ApiError> {
    let directory = account_directory(&state.runtime.paths, state.auth.username())
        .map_err(|error| ApiError::internal(error.to_string()))?
        .join(BUFFERS_DIRECTORY);

    Ok(directory.join(buffer_file_name(key)))
}

/// The SHA-256 hex file name of a key, shared by lookups and the closed-file cleanup.
fn buffer_file_name(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    format!("{name}.json")
}

/// Reads a stored buffer, treating a missing file as absent and a file written for another
/// key (a hash collision) as absent too, rather than handing out someone else's buffer.
async fn read_buffer(
    path: &std::path::Path,
    key: &str,
) -> Result<Option<StoredEditorBuffer>, ApiError> {
    let contents = match tokio::fs::read(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ApiError::internal(format!(
                "Failed to read editor buffer: {error}"
            )));
        }
    };
    let stored: StoredEditorBuffer = serde_json::from_slice(&contents)
        .map_err(|error| ApiError::internal(format!("Stored editor buffer is invalid: {error}")))?;

    Ok((stored.key == key).then_some(stored))
}

/// Writes a buffer atomically inside the private account directory.
async fn write_buffer(
    state: &ServerState,
    path: &std::path::Path,
    stored: &StoredEditorBuffer,
) -> Result<(), ApiError> {
    let write = async {
        let account =
            prepare_account_directory(&state.runtime.paths, state.auth.username()).await?;
        let directory = account.join(BUFFERS_DIRECTORY);
        tokio::fs::create_dir_all(&directory).await?;
        #[cfg(unix)]
        super::user_state::ensure_private_directory(&directory).await?;
        let contents = serde_json::to_vec(stored)?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow::anyhow!("editor buffer path has no file name"))?;
        let temporary = directory.join(format!(".{file_name}.tmp"));
        write_private_file_atomically(&temporary, path, &contents).await
    };

    write.await.map_err(|error: anyhow::Error| {
        ApiError::internal(format!("Failed to save editor buffer: {error}"))
    })
}

/// A new version: the wall clock in milliseconds, but always above the previous version, so
/// versions keep growing even within one millisecond or if the clock steps back. Being
/// time-based, a buffer deleted and written again never repeats a version a browser saw.
fn next_version(previous: Option<u64>) -> u64 {
    let now = u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or(0);

    previous.map_or(now, |previous| now.max(previous + 1))
}
