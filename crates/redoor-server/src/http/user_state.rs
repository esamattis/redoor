//! Per-user persisted UI state document, `<data_dir>/users/<name>/state.json`.
//!
//! Everyone who signs in shares one account (vault, SSH keys, devices), but preferences and
//! the open files list are personal, so each login name gets its own document. The name is
//! the one the session signed in with, so the same person signing in with a TOML password
//! or PAM under the same name keeps one state.

use std::path::{Path, PathBuf};

use axum::{Extension, Json, extract::State, http::StatusCode, response::IntoResponse};
use redoor_protocol::api::{
    ErrorResponse,
    user_state::{UpdateUserStateRequest, UserStateResponse},
};
use sha2::{Digest, Sha256};

use super::{access::Principal, state::ServerState};

/// File name of the UI state document in a user's directory.
const USER_STATE_FILE: &str = "state.json";
/// Directory of the per-user directories inside the data directory.
const USERS_DIRECTORY: &str = "users";

/// Route: `GET /api/v1/user/state`
///
/// Missing files become an empty object so first-run clients can apply schema defaults.
pub(crate) async fn get_user_state_handler(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
) -> impl IntoResponse {
    let user = match principal.session_user() {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    let read = async {
        let directory = user_directory(&state.runtime.paths, &user.name)?;
        read_user_state(&directory.join(USER_STATE_FILE)).await
    };
    match read.await {
        Ok(value) => Json(UserStateResponse { state: value }).into_response(),
        Err(error) => state_io_error(error),
    }
}

/// Route: `PUT /api/v1/user/state` replaces the signed-in user's stored document.
///
/// Replaces the on-disk document atomically so a crash cannot leave truncated JSON, then
/// deletes the user's editor buffers of files the new document no longer lists as open.
pub(crate) async fn update_user_state_handler(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<UpdateUserStateRequest>,
) -> impl IntoResponse {
    let user = match principal.session_user() {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    // Held across both steps, so the cleanup sees the list this update wrote, not a later one.
    let _buffers_guard = state.editor_buffer_lock.lock().await;
    let written = async {
        let directory = prepare_user_directory(&state.runtime.paths, &user.name).await?;
        write_user_state(&directory, &request.state).await?;
        super::editor_buffers::delete_closed_buffers(&directory, &request.state).await
    };

    match written.await {
        Ok(()) => Json(UserStateResponse {
            state: request.state,
        })
        .into_response(),
        Err(error) => state_io_error(error),
    }
}

/// Reads a user's document, treating a missing file as `{}` rather than an error.
async fn read_user_state(path: &Path) -> anyhow::Result<serde_json::Value> {
    match tokio::fs::read(path).await {
        Ok(contents) if contents.is_empty() => Ok(serde_json::json!({})),
        Ok(contents) => serde_json::from_slice(&contents).map_err(|error| {
            anyhow::anyhow!(
                "failed to parse user state file '{}': {error}",
                path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(error) => Err(anyhow::Error::new(error).context(format!(
            "failed to read user state file '{}'",
            path.display()
        ))),
    }
}

/// Writes through a temporary sibling so readers never observe a partial document.
async fn write_user_state(directory: &Path, state: &serde_json::Value) -> anyhow::Result<()> {
    let contents = serde_json::to_vec(state)?;
    write_private_file_atomically(
        &directory.join(".state.json.tmp"),
        &directory.join(USER_STATE_FILE),
        &contents,
    )
    .await
}

/// `<data_dir>/users/<name>`, the directory of one user's personal files (UI state and
/// editor buffers).
///
/// Login names from the config and PAM follow the portable allowlist and are used as they
/// are. OIDC names are whatever the provider sends (an email address, a subject), so any
/// other name becomes `~` and its SHA-256: `~` is outside the allowlist, so such a name can
/// never take another user's directory, and no name can leave `users/`.
pub(crate) fn user_directory(
    paths: &redoor_core::paths::AppPaths,
    name: &str,
) -> anyhow::Result<PathBuf> {
    let component =
        redoor_core::config::parse_server_username(name, "user name").unwrap_or_else(|_| {
            let digest = Sha256::digest(name.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("~{hex}")
        });
    Ok(paths.data_dir()?.join(USERS_DIRECTORY).join(component))
}

/// Creates a user's private directory (and `users/`), so every per-user file shares one
/// owner check and mode instead of each writer repeating it.
pub(crate) async fn prepare_user_directory(
    paths: &redoor_core::paths::AppPaths,
    name: &str,
) -> anyhow::Result<PathBuf> {
    let directory = user_directory(paths, name)?;
    tokio::fs::create_dir_all(&directory).await?;
    #[cfg(unix)]
    {
        let users = directory
            .parent()
            .expect("user directories live under users/");
        ensure_private_directory(users).await?;
        ensure_private_directory(&directory).await?;
    }
    Ok(directory)
}

/// Creates the data directory that holds the shared account files (the vault) before one
/// of them is first written. The files themselves are written 0600, so the data
/// directory's own mode is left to the operator.
pub(crate) async fn prepare_data_directory(
    paths: &redoor_core::paths::AppPaths,
) -> anyhow::Result<PathBuf> {
    let directory = paths.data_dir()?;
    tokio::fs::create_dir_all(&directory).await?;
    Ok(directory)
}

/// Replaces `path` through `temporary_path` in the same directory, so a crash or a
/// concurrent reader never sees a truncated file.
pub(crate) async fn write_private_file_atomically(
    temporary_path: &Path,
    path: &Path,
    contents: &[u8],
) -> anyhow::Result<()> {
    write_private_file(temporary_path, contents).await?;
    tokio::fs::rename(temporary_path, path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

/// Writes bytes with mode 0600 so other local users cannot read anyone's preferences.
async fn write_private_file(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(contents).await?;
    file.sync_all().await?;
    Ok(())
}

/// Ensures a private directory (`users/`, a user's directory, its editor buffers) is owned
/// by this process user and mode 0700.
#[cfg(unix)]
pub(super) async fn ensure_private_directory(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    let metadata = tokio::fs::metadata(path).await?;
    let mode = metadata.mode() & 0o777;
    if mode != 0o700 {
        anyhow::bail!(
            "user state directory '{}' must be mode 0700, found {:o}",
            path.display(),
            mode
        );
    }
    let uid = nix::unistd::Uid::current().as_raw();
    if metadata.uid() != uid {
        anyhow::bail!(
            "user state directory '{}' must be owned by uid {}, found {}",
            path.display(),
            uid,
            metadata.uid()
        );
    }
    Ok(())
}

/// Disk failures stay 500 so clients can retry without treating them as auth or validation errors.
fn state_io_error(error: anyhow::Error) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            code: None,
            error: error.to_string(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Allowlisted names are their own directory, and any other name gets a hashed one that
    /// cannot collide with them or leave `users/`.
    #[test]
    fn user_directories_stay_inside_users() {
        let paths = redoor_core::paths::AppPaths::for_home("redoor-test", Path::new("/home/t"));
        let users = Path::new("/home/t/.local/share/redoor-test/users");
        // A config or PAM login name is used as is, so the directory is recognisable.
        assert_eq!(
            user_directory(&paths, "alice").unwrap(),
            users.join("alice")
        );
        for name in ["alice@example.org", "../alice", "a/b", ".."] {
            let directory = user_directory(&paths, name).unwrap();
            // Every other name stays one hashed component inside `users/`.
            assert_eq!(directory.parent(), Some(users), "{name}");
            assert!(
                directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with('~') && name.len() == 65),
                "{name}"
            );
        }
        // Different names never share a directory.
        assert_ne!(
            user_directory(&paths, "a@example.org").unwrap(),
            user_directory(&paths, "b@example.org").unwrap()
        );
    }
}
