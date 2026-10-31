//! Per-user persisted UI state document stored on the server.

use std::path::{Path, PathBuf};

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use redoor_protocol::api::{
    ErrorResponse,
    user_state::{UpdateUserStateRequest, UserStateResponse},
};

use super::state::ServerState;

/// Route: `GET /api/v1/user/state`
///
/// Missing files become an empty object so first-run clients can apply schema defaults.
pub(crate) async fn get_user_state_handler(State(state): State<ServerState>) -> impl IntoResponse {
    match read_user_state(&state.runtime.paths, state.auth.username()).await {
        Ok(value) => Json(UserStateResponse { state: value }).into_response(),
        Err(error) => state_io_error(error),
    }
}

/// Route: `PUT /api/v1/user/state` replaces the authenticated user's stored document.
///
/// Replaces the on-disk document atomically so a crash cannot leave truncated JSON, then
/// deletes the editor buffers of files the new document no longer lists as open.
pub(crate) async fn update_user_state_handler(
    State(state): State<ServerState>,
    Json(request): Json<UpdateUserStateRequest>,
) -> impl IntoResponse {
    // Held across both steps, so the cleanup sees the list this update wrote, not a later one.
    let _buffers_guard = state.editor_buffer_lock.lock().await;
    let written = async {
        let paths = &state.runtime.paths;
        let username = state.auth.username();
        write_user_state(paths, username, &request.state).await?;
        super::editor_buffers::delete_closed_buffers(paths, username, &request.state).await
    };

    match written.await {
        Ok(()) => Json(UserStateResponse {
            state: request.state,
        })
        .into_response(),
        Err(error) => state_io_error(error),
    }
}

/// Reads the account document, treating a missing file as `{}` rather than an error.
async fn read_user_state(
    paths: &redoor_core::paths::AppPaths,
    username: &str,
) -> anyhow::Result<serde_json::Value> {
    let path = user_state_path(paths, username)?;
    match tokio::fs::read(&path).await {
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
async fn write_user_state(
    paths: &redoor_core::paths::AppPaths,
    username: &str,
    state: &serde_json::Value,
) -> anyhow::Result<()> {
    let path = user_state_path(paths, username)?;
    let account_directory = prepare_account_directory(paths, username).await?;
    let contents = serde_json::to_vec(state)?;
    write_private_file_atomically(&account_directory.join(".state.json.tmp"), &path, &contents)
        .await
}

/// Creates the login account's private directory, so every per-user file (preferences,
/// editor buffers) shares one owner check and mode instead of each writer repeating it.
pub(super) async fn prepare_account_directory(
    paths: &redoor_core::paths::AppPaths,
    username: &str,
) -> anyhow::Result<PathBuf> {
    let account_directory = account_directory(paths, username)?;
    let users_directory = account_directory
        .parent()
        .expect("account directories live under users/");

    tokio::fs::create_dir_all(&account_directory).await?;
    #[cfg(unix)]
    {
        ensure_private_directory(users_directory).await?;
        ensure_private_directory(&account_directory).await?;
    }
    Ok(account_directory)
}

/// Replaces `path` through `temporary_path` in the same directory, so a crash or a
/// concurrent reader never sees a truncated file.
pub(super) async fn write_private_file_atomically(
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

/// Locates the account's preference document inside its private directory.
fn user_state_path(
    paths: &redoor_core::paths::AppPaths,
    username: &str,
) -> anyhow::Result<PathBuf> {
    Ok(account_directory(paths, username)?.join("state.json"))
}

/// Keeps each login name as one path component so a crafted username cannot escape the data dir.
pub(super) fn account_directory(
    paths: &redoor_core::paths::AppPaths,
    username: &str,
) -> anyhow::Result<PathBuf> {
    redoor_core::config::parse_server_username(username)
        .map_err(|_| anyhow::anyhow!("login username cannot be used as a state directory name"))?;
    Ok(paths.data_dir()?.join("users").join(username))
}

/// Writes bytes with mode 0600 so local users cannot read another account's preferences.
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

/// Ensures the users directory is owned by this process user and mode 0700.
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
