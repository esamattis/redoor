//! Filesystem commands: listing, deletion, creation, renames, ownership and sizes.

use redoor_protocol::wire::log::Level;
use redoor_protocol::{
    api::files::{
        ChmodPathResponse, ChownPathResponse, DirectorySizeError, DirectorySizeResponse, LsEntry,
    },
    ids::UnixTimestampSeconds,
    wire::command::{
        CommandErrorKind, LsDirectoryResult, LsFileResult, MoveMetadataResult, MoveSourceIdentity,
    },
    wire::request::{CommandError, LsResponse},
};
use std::future::Future;
use tokio_util::sync::CancellationToken;

/// Stays under the server's control-command deadline so a slow recursive delete reports a
/// timeout instead of the caller giving up first.
const DIRECT_DELETE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);
/// Retries random quarantine names a few times so a collision cannot loop forever.
const MOVE_SOURCE_QUARANTINE_ATTEMPTS: usize = 16;
/// Limits concurrent background removal of quarantined move sources so cleanup cannot
/// saturate disk IO on constrained agents.
const MAX_MOVE_SOURCE_CLEANUPS: usize = 2;
/// Process-wide gate enforcing `MAX_MOVE_SOURCE_CLEANUPS` across all move commands.
static MOVE_SOURCE_CLEANUP_PERMITS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_MOVE_SOURCE_CLEANUPS);

/// Returns directory entries or file metadata from the requested path.
pub(super) async fn ls(path: Option<String>) -> Result<LsResponse, CommandError> {
    use nix::unistd::{Group, User};
    use std::os::unix::fs::MetadataExt;

    let path = path.unwrap_or_else(|| ".".to_string());

    match tokio::fs::metadata(&path).await {
        Ok(metadata) => {
            if metadata.is_dir() {
                match tokio::fs::read_dir(&path).await {
                    Ok(mut entries) => {
                        let mut files = Vec::new();
                        while let Some(entry) = entries.next_entry().await.ok().flatten() {
                            let entry_metadata = entry.metadata().await.ok();
                            let name = entry.file_name().into_string().ok();

                            if let (Some(entry_metadata), Some(name)) = (entry_metadata, name) {
                                let is_dir = entry_metadata.is_dir();
                                let file_type = if is_dir { "directory" } else { "file" };
                                let size = entry_metadata.size();
                                let uid = entry_metadata.uid();
                                let gid = entry_metadata.gid();
                                let modified_at = UnixTimestampSeconds::new(entry_metadata.mtime());

                                let owner = User::from_uid(nix::unistd::Uid::from_raw(uid))
                                    .ok()
                                    .flatten()
                                    .map(|u| u.name);

                                let group = Group::from_gid(nix::unistd::Gid::from_raw(gid))
                                    .ok()
                                    .flatten()
                                    .map(|g| g.name);

                                files.push(LsEntry {
                                    name,
                                    file_type: file_type.to_string(),
                                    size,
                                    owner,
                                    group,
                                    uid,
                                    gid,
                                    modified_at,
                                });
                            }
                        }

                        let uid = metadata.uid();
                        let gid = metadata.gid();
                        let owner = User::from_uid(nix::unistd::Uid::from_raw(uid))
                            .ok()
                            .flatten()
                            .map(|user| user.name);
                        let group = Group::from_gid(nix::unistd::Gid::from_raw(gid))
                            .ok()
                            .flatten()
                            .map(|group| group.name);

                        Ok(LsResponse::Directory(LsDirectoryResult {
                            files,
                            path,
                            owner,
                            group,
                            uid,
                            gid,
                            permissions: metadata.mode() & 0o777,
                        }))
                    }
                    Err(error) => Err(CommandError::io(
                        &format!("Failed to read directory {path:?}"),
                        error,
                    )),
                }
            } else {
                let size = metadata.size();
                let uid = metadata.uid();
                let gid = metadata.gid();
                let permissions = metadata.mode() & 0o777;

                let owner = User::from_uid(nix::unistd::Uid::from_raw(uid))
                    .ok()
                    .flatten()
                    .map(|u| u.name);

                let group = Group::from_gid(nix::unistd::Gid::from_raw(gid))
                    .ok()
                    .flatten()
                    .map(|g| g.name);

                let executable = is_executable(&path).await;

                Ok(LsResponse::File(LsFileResult {
                    size,
                    path,
                    owner,
                    group,
                    uid,
                    gid,
                    permissions,
                    executable,
                }))
            }
        }
        Err(error) => Err(CommandError::io(
            &format!("Failed to get metadata for path {path:?}"),
            error,
        )),
    }
}

/// Asks the kernel whether the agent's user may run the file. Mode bits alone would say yes
/// for a file only another user or group may run, or one on a `noexec` mount such as
/// Android shared storage, where the shell then refuses it.
async fn is_executable(path: &str) -> bool {
    let path = path.to_string();

    // `access` is a blocking syscall that can stall on a slow network mount.
    redoor_core::logging::spawn_blocking_in_user_scope(move || {
        nix::unistd::access(path.as_str(), nix::unistd::AccessFlags::X_OK).is_ok()
    })
    .await
    .unwrap_or(false)
}

/// Keeps direct REST-backed deletion within its short control-command deadline.
pub(super) async fn raw_delete(path: String) -> Result<(), CommandError> {
    match tokio::fs::metadata(&path).await {
        Ok(metadata) => {
            let delete_result = if metadata.is_dir() {
                match tokio::time::timeout(
                    DIRECT_DELETE_TIMEOUT,
                    redoor_core::safe_fs::safe_rm_all(&path),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!(
                            "recursive deletion exceeded {} seconds and may be partial",
                            DIRECT_DELETE_TIMEOUT.as_secs()
                        ),
                    )),
                }
            } else {
                tokio::fs::remove_file(&path).await
            };

            match delete_result {
                Ok(()) => Ok(()),
                Err(error) => Err(CommandError::io("Failed to delete path", error)),
            }
        }
        Err(error) => Err(CommandError::io(
            "Failed to access path for deletion",
            error,
        )),
    }
}

/// Creates all missing path components for remote directory workflows.
pub(super) async fn create_directory(
    path: String,
    ownership: redoor_protocol::api::files::CreationOwnershipOptions,
) -> Result<(), CommandError> {
    let already_exists = match tokio::fs::symlink_metadata(&path).await {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(CommandError::io("Failed to inspect directory", error)),
    };
    let ownership_plan = match crate::ownership::OwnershipPlan::resolve(ownership, None).await {
        Ok(plan) => plan,
        Err(error) => return Err(CommandError::new(error.kind(), error.to_string())),
    };
    if let Err(error) = tokio::fs::create_dir_all(&path).await {
        return Err(CommandError::io("Failed to create directory", error));
    }
    if already_exists {
        return Ok(());
    }
    let parent = std::path::Path::new(&path)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let resolved_ownership = match ownership_plan.for_parent(parent).await {
        Ok(ownership) => ownership,
        Err(error) => return Err(CommandError::new(error.kind(), error.to_string())),
    };
    match resolved_ownership.apply(std::path::Path::new(&path)).await {
        Ok(()) => Ok(()),
        Err(error) => Err(CommandError::new(error.kind(), error.to_string())),
    }
}

/// Derives both paths from one directory so rename cannot become a cross-directory move.
pub(super) async fn rename_path(dir: String, old: String, new: String) -> Result<(), CommandError> {
    let directory = std::path::Path::new(&dir);
    if !directory.is_absolute() {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            "Rename directory must be absolute",
        ));
    }
    if !is_filename(&old) || !is_filename(&new) {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            "Rename names must each be a single filename",
        ));
    }

    let source_path = directory.join(old);
    let dest_path = directory.join(new);
    match tokio::fs::rename(&source_path, &dest_path).await {
        Ok(()) => Ok(()),
        Err(error) => Err(CommandError::io("Failed to rename path", error)),
    }
}

/// Rejects non-root even for a same-uid no-op because the agent is the trust boundary.
pub(super) async fn chown_path(
    path: String,
    owner: Option<String>,
    group: Option<String>,
) -> Result<ChownPathResponse, CommandError> {
    if !nix::unistd::Uid::effective().is_root() {
        return Err(CommandError::new(
            CommandErrorKind::PermissionDenied,
            "Only a root agent can change ownership",
        ));
    }
    if owner.is_none() && group.is_none() {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            "Owner or group is required",
        ));
    }
    let ownership_plan =
        match crate::ownership::OwnershipPlan::for_existing_entry(owner, group).await {
            Ok(plan) => plan,
            Err(error) => return Err(CommandError::new(error.kind(), error.to_string())),
        };
    match ownership_plan
        .resolved()
        .apply(std::path::Path::new(&path))
        .await
    {
        Ok(()) => {}
        Err(error) => return Err(CommandError::new(error.kind(), error.to_string())),
    }
    match followed_ownership(&path).await {
        Ok((owner, group, uid, gid)) => Ok(ChownPathResponse {
            path,
            owner,
            group,
            uid,
            gid,
        }),
        Err(error) => Err(CommandError::io(
            &format!("Failed to read ownership after chown for path {path:?}"),
            error,
        )),
    }
}

/// Replaces only the nine rwx bits so toggling the grid cannot clear setuid/setgid/sticky.
pub(super) async fn chmod_path(
    path: String,
    permissions: u32,
) -> Result<ChmodPathResponse, CommandError> {
    if permissions > 0o777 {
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            format!("Permissions must be between 0 and 0o777, got {permissions:#o}"),
        ));
    }
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(CommandError::io(
                &format!("Failed to read metadata for path {path:?}"),
                error,
            ));
        }
    };
    let next_mode = (metadata.mode() & !0o777) | (permissions & 0o777);
    let mut next_permissions = metadata.permissions();
    next_permissions.set_mode(next_mode);
    if let Err(error) = tokio::fs::set_permissions(&path, next_permissions).await {
        return Err(CommandError::io(
            &format!("Failed to change permissions for path {path:?}"),
            error,
        ));
    }
    Ok(ChmodPathResponse { path, permissions })
}

/// Bounds recursive metadata traversal so one very large tree cannot occupy a command slot indefinitely.
pub(super) async fn directory_size(
    path: String,
    timeout_seconds: u64,
    cancel: &CancellationToken,
) -> Result<DirectorySizeResponse, CommandError> {
    match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(CommandError::new(
                CommandErrorKind::NotADirectory,
                format!("Path is not a directory: {path}"),
            ));
        }
        Err(error) => {
            return Err(CommandError::io(
                &format!("Failed to read directory metadata for path {path:?}"),
                error,
            ));
        }
    }

    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_seconds),
        redoor_core::directory_measurement::measure_directory(
            std::path::Path::new(&path),
            false,
            cancel,
        ),
    )
    .await
    {
        Ok(Ok(Some(measurement))) => Ok(DirectorySizeResponse {
            path,
            size: measurement.content_bytes,
            errors: measurement
                .errors
                .into_iter()
                .map(|error| DirectorySizeError {
                    path: error.path,
                    error: error.error,
                })
                .collect(),
        }),
        Ok(Ok(None)) => Err(CommandError::new(
            CommandErrorKind::ServiceUnavailable,
            "Directory size calculation was canceled",
        )),
        Ok(Err(error)) => Err(CommandError::new(
            CommandErrorKind::Internal,
            format!("Failed to calculate directory size for {path:?}: {error}"),
        )),
        Err(_) => Err(CommandError::new(
            CommandErrorKind::ServiceUnavailable,
            format!("Directory size calculation timed out after {timeout_seconds} seconds"),
        )),
    }
}

/// Captures the source identity before a move starts so later deletion is conditional.
pub(super) async fn move_metadata(path: String) -> Result<MoveMetadataResult, CommandError> {
    match tokio::fs::metadata(&path).await {
        Ok(metadata) => {
            let identity = MoveSourceIdentity::from_metadata(&metadata);
            redoor_core::log!(
                Level::Debug,
                "Smart move metadata captured: path={}, is_file={}, is_dir={}, file_size={}, identity={:?}",
                path,
                metadata.is_file(),
                metadata.is_dir(),
                metadata.len(),
                identity
            );
            Ok(MoveMetadataResult {
                file_size: metadata.len(),
                is_file: metadata.is_file(),
                is_dir: metadata.is_dir(),
                identity,
            })
        }
        Err(error) => {
            redoor_core::log!(
                Level::Debug,
                "Smart move metadata failed: path={}, error={}",
                path,
                error
            );
            Err(CommandError::io(
                &format!("Failed to get move source metadata for path {path:?}"),
                error,
            ))
        }
    }
}

/// Deletes only the unchanged source object that the move preflight selected.
pub(super) async fn delete_move_source(
    path: String,
    expected_identity: MoveSourceIdentity,
) -> Result<(), CommandError> {
    delete_move_source_with_cleanup(
        path,
        expected_identity,
        &MOVE_SOURCE_CLEANUP_PERMITS,
        |quarantine_path| async move { redoor_core::safe_fs::safe_rm_all(quarantine_path).await },
    )
    .await
}

/// Publishes directory removal by quarantine rename before running best-effort cleanup.
async fn delete_move_source_with_cleanup<C, F>(
    path: String,
    expected_identity: MoveSourceIdentity,
    cleanup_permits: &'static tokio::sync::Semaphore,
    cleanup: C,
) -> Result<(), CommandError>
where
    C: FnOnce(std::path::PathBuf) -> F,
    F: Future<Output = std::io::Result<()>> + Send + 'static,
{
    redoor_core::log!(
        Level::Debug,
        "Smart move source deletion started: path={}, expected_identity={:?}",
        path,
        expected_identity
    );
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            redoor_core::log!(
                Level::Debug,
                "Smart move source deletion could not inspect source: path={}, error={}",
                path,
                error
            );
            return Err(CommandError::io(
                &format!("Failed to verify move source path {path:?}"),
                error,
            ));
        }
    };
    let actual_identity = MoveSourceIdentity::from_metadata(&metadata);
    if actual_identity != expected_identity {
        redoor_core::log!(
            Level::Debug,
            "Smart move source deletion refused after identity change: path={}, expected_identity={:?}, actual_identity={:?}",
            path,
            expected_identity,
            actual_identity
        );
        return Err(CommandError::new(
            CommandErrorKind::InvalidInput,
            "Move source changed while it was being copied; refusing to delete it",
        ));
    }
    if !metadata.is_dir() {
        redoor_core::log!(
            Level::Debug,
            "Smart move deleting file source: path={}, identity={:?}",
            path,
            actual_identity
        );
        return match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(error) => {
                redoor_core::log!(
                    Level::Debug,
                    "Smart move file source deletion failed: path={}, error={}",
                    path,
                    error
                );
                Err(CommandError::io("Failed to delete move source", error))
            }
        };
    }
    if let Err(error) = redoor_core::safe_fs::validate_recursive_remove(&path).await {
        return Err(CommandError::io(
            "Failed to validate move source deletion",
            error,
        ));
    }

    redoor_core::log!(
        Level::Debug,
        "Smart move quarantining directory source: path={}, identity={:?}",
        path,
        actual_identity
    );
    let quarantine_path = match quarantine_move_source(std::path::Path::new(&path)).await {
        Ok(path) => path,
        Err(error) => {
            redoor_core::log!(
                Level::Debug,
                "Smart move source quarantine failed: path={}, error={}",
                path,
                error
            );
            return Err(CommandError::io("Failed to quarantine move source", error));
        }
    };
    match cleanup_permits.try_acquire() {
        Ok(cleanup_permit) => {
            let cleanup_future = cleanup(quarantine_path.clone());
            spawn_move_source_cleanup(quarantine_path, cleanup_permit, cleanup_future);
        }
        Err(tokio::sync::TryAcquireError::NoPermits) => {
            redoor_core::log!(
                Level::Warning,
                "Move source quarantine cleanup capacity exhausted; leaving path for later recovery: {}",
                quarantine_path.display()
            );
        }
        Err(tokio::sync::TryAcquireError::Closed) => {
            let error = anyhow::anyhow!(
                "move source quarantine cleanup is unavailable for {}",
                quarantine_path.display()
            );
            redoor_core::log_error!(
                error,
                "Move source quarantine cleanup unavailable; leaving path for later recovery: {}",
                quarantine_path.display()
            );
        }
    }
    Ok(())
}

/// Re-reads followed metadata so the chown response matches the inode the details view already shows.
async fn followed_ownership(
    path: &str,
) -> std::io::Result<(Option<String>, Option<String>, u32, u32)> {
    use std::os::unix::fs::MetadataExt;

    let metadata = tokio::fs::metadata(path).await?;
    let uid = metadata.uid();
    let gid = metadata.gid();
    let (owner, group) = crate::ownership::names_for_ids(uid, gid)
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok((owner, group, uid, gid))
}

/// Hides a directory under an unpredictable sibling name without requiring renameat2 support.
async fn quarantine_move_source(source: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let parent = source.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("move source has no parent directory: {}", source.display()),
        )
    })?;
    if source.file_name().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("move source has no file name: {}", source.display()),
        ));
    }

    for _ in 0..MOVE_SOURCE_QUARANTINE_ATTEMPTS {
        let quarantine_name = format!(".redoor-move-{}", uuid::Uuid::new_v4().simple());
        let quarantine_path = parent.join(quarantine_name);
        match tokio::fs::symlink_metadata(&quarantine_path).await {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        match tokio::fs::rename(source, &quarantine_path).await {
            Ok(()) => {
                redoor_core::log!(
                    Level::Debug,
                    "Move source quarantined with filesystem rename: source={}, quarantine={}, copy_fallback=false",
                    source.display(),
                    quarantine_path.display()
                );
                return Ok(quarantine_path);
            }
            Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::CrossesDevices,
                    "move source quarantine unexpectedly crossed filesystem boundaries",
                ));
            }
            Err(error) => return Err(error),
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "failed to reserve a unique move source quarantine path",
    ))
}

/// Runs best-effort quarantine deletion under a permit so detached cleanup remains bounded.
fn spawn_move_source_cleanup<F>(
    quarantine_path: std::path::PathBuf,
    cleanup_permit: tokio::sync::SemaphorePermit<'static>,
    cleanup: F,
) where
    F: Future<Output = std::io::Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let _cleanup_permit = cleanup_permit;
        if let Err(error) = cleanup.await {
            redoor_core::log_failure!(
                Level::Error,
                "Failed to clean quarantined move source: path={}, error={}",
                quarantine_path.display(),
                error
            );
        }
    });
}

/// Rejects path syntax so a rename name cannot escape or change its directory.
fn is_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && name != "."
        && name != ".."
        && std::path::Path::new(name)
            .file_name()
            .is_some_and(|part| part == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;

    /// Verifies a directory disappears from its source name before quarantine cleanup completes.
    #[tokio::test]
    async fn directory_move_source_is_published_deleted_before_cleanup() {
        static CLEANUP_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        let temp = TempDir::create();
        let path = temp.path().join("directory-move-source");
        tokio::fs::create_dir(&path)
            .await
            .expect("move source directory should be created");
        tokio::fs::write(path.join("child"), "copied")
            .await
            .expect("move source child should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let (finished_sender, finished_receiver) = tokio::sync::oneshot::channel();

        let result = delete_move_source_with_cleanup(
            path.display().to_string(),
            MoveSourceIdentity::from_metadata(&metadata),
            &CLEANUP_PERMITS,
            move |quarantine_path| async move {
                started_sender
                    .send(quarantine_path.clone())
                    .expect("cleanup should report its quarantine path");
                release_receiver
                    .await
                    .expect("test should release quarantine cleanup");
                redoor_core::safe_fs::safe_rm_all(&quarantine_path).await?;
                finished_sender
                    .send(())
                    .expect("cleanup should report completion");
                Ok(())
            },
        )
        .await;
        let quarantine_path = started_receiver
            .await
            .expect("quarantine cleanup should start");

        // The router must receive success without waiting for recursive cleanup.
        assert!(
            matches!(result, Ok(())),
            "directory quarantine should preserve the move deletion response"
        );
        // Atomic quarantine publication removes the user-visible source name first.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "original directory source should disappear before cleanup completes"
        );
        // The blocked cleanup must still own the complete tree under its unique sibling name.
        assert!(
            tokio::fs::try_exists(quarantine_path.join("child"))
                .await
                .expect("quarantine existence check should succeed"),
            "quarantine should retain source contents until cleanup resumes"
        );
        // A sibling quarantine guarantees rename publication cannot cross filesystems.
        assert_eq!(
            quarantine_path.parent(),
            path.parent(),
            "quarantine should share the source parent directory"
        );
        release_sender
            .send(())
            .expect("cleanup should remain blocked after command success");
        finished_receiver
            .await
            .expect("quarantine cleanup should finish after release");
        // Successful best-effort cleanup should remove the hidden quarantine tree.
        assert!(
            !tokio::fs::try_exists(&quarantine_path)
                .await
                .expect("cleaned quarantine existence check should succeed"),
            "completed cleanup should remove the quarantine path"
        );
    }

    /// Verifies a timed-out quarantine cleanup cannot change the published command success.
    #[tokio::test]
    async fn directory_move_source_cleanup_timeout_does_not_fail_the_move() {
        static CLEANUP_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        let temp = TempDir::create();
        let path = temp.path().join("timeout-move-source");
        tokio::fs::create_dir(&path)
            .await
            .expect("move source directory should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let (failed_sender, failed_receiver) = tokio::sync::oneshot::channel();

        let result = delete_move_source_with_cleanup(
            path.display().to_string(),
            MoveSourceIdentity::from_metadata(&metadata),
            &CLEANUP_PERMITS,
            move |quarantine_path| async move {
                failed_sender
                    .send(quarantine_path)
                    .expect("cleanup should report the failed quarantine path");
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "simulated bounded cleanup timeout",
                ))
            },
        )
        .await;
        let quarantine_path = failed_receiver
            .await
            .expect("timed-out cleanup should complete independently");

        // Cleanup timeout occurs after publication and therefore cannot fail the logical move.
        assert!(
            matches!(result, Ok(())),
            "cleanup timeout should not alter the successful command response"
        );
        // The original source remains absent even when best-effort cleanup leaves quarantine behind.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "cleanup timeout must not restore the original source name"
        );
        // A failed cleanup leaves only the hidden owned path for later operator recovery.
        assert!(
            tokio::fs::try_exists(&quarantine_path)
                .await
                .expect("quarantine existence check should succeed"),
            "timed-out cleanup should leave the quarantined tree intact"
        );
        redoor_core::safe_fs::safe_rm_all(quarantine_path)
            .await
            .expect("test should remove the failed quarantine fixture");
    }

    /// Verifies saturated cleanup capacity neither blocks success nor constructs cleanup work.
    #[tokio::test]
    async fn directory_move_source_succeeds_when_cleanup_capacity_is_saturated() {
        static SATURATED_CLEANUP_PERMITS: tokio::sync::Semaphore =
            tokio::sync::Semaphore::const_new(0);

        let temp = TempDir::create();
        let path = temp.path().join("saturated-move-source");
        tokio::fs::create_dir(&path)
            .await
            .expect("move source directory should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let cleanup_created = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cleanup_created_for_factory = cleanup_created.clone();

        let result = delete_move_source_with_cleanup(
            path.display().to_string(),
            MoveSourceIdentity::from_metadata(&metadata),
            &SATURATED_CLEANUP_PERMITS,
            move |_quarantine_path| {
                cleanup_created_for_factory.store(true, std::sync::atomic::Ordering::SeqCst);
                async { Ok(()) }
            },
        )
        .await;

        // Capacity exhaustion happens after publication and cannot delay or fail the move.
        assert!(
            matches!(result, Ok(())),
            "saturated cleanup admission should retain move success"
        );
        // Nonblocking admission must not create cleanup work that would wait for a permit.
        assert!(
            !cleanup_created.load(std::sync::atomic::Ordering::SeqCst),
            "cleanup factory should not run without available capacity"
        );
        // The original source name must remain published as deleted despite deferred recovery.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "saturated cleanup should leave the original source absent"
        );

        let mut entries = tokio::fs::read_dir(temp.path())
            .await
            .expect("test parent should remain readable");
        let quarantine_path = entries
            .next_entry()
            .await
            .expect("quarantine listing should succeed")
            .expect("saturated cleanup should leave one quarantine path")
            .path();
        // Capacity exhaustion leaves only a recognizable owned path for later recovery.
        assert!(
            quarantine_path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".redoor-move-")),
            "leftover quarantine should use the owned fixed prefix"
        );
        redoor_core::safe_fs::safe_rm_all(quarantine_path)
            .await
            .expect("test should remove the deferred quarantine fixture");
    }

    /// Verifies quarantine publication remains valid for a maximum-length source component.
    #[tokio::test]
    async fn directory_move_source_with_maximum_length_name_uses_a_short_quarantine() {
        static CLEANUP_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        let temp = TempDir::create();
        let path = temp.path().join("s".repeat(255));
        tokio::fs::create_dir(&path)
            .await
            .expect("filesystem should accept a 255-byte source name");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let (finished_sender, finished_receiver) = tokio::sync::oneshot::channel();

        let result = delete_move_source_with_cleanup(
            path.display().to_string(),
            MoveSourceIdentity::from_metadata(&metadata),
            &CLEANUP_PERMITS,
            move |quarantine_path| async move {
                started_sender
                    .send(quarantine_path.clone())
                    .expect("cleanup should report its short quarantine path");
                release_receiver
                    .await
                    .expect("test should release quarantine cleanup");
                redoor_core::safe_fs::safe_rm_all(quarantine_path).await?;
                finished_sender
                    .send(())
                    .expect("cleanup should report completion");
                Ok(())
            },
        )
        .await;
        let quarantine_path = started_receiver
            .await
            .expect("maximum-name quarantine cleanup should start");

        // A source at NAME_MAX must still publish successfully under an independent short name.
        assert!(
            matches!(result, Ok(())),
            "maximum-length source should quarantine successfully"
        );
        let quarantine_name = quarantine_path
            .file_name()
            .expect("quarantine should have a file name")
            .to_string_lossy();
        // Fixed-prefix UUID naming stays well below common supported filesystem component limits.
        assert!(
            quarantine_name.starts_with(".redoor-move-") && quarantine_name.len() < 255,
            "quarantine name should not inherit the source component length"
        );
        // Successful quarantine removes the maximum-length original source pathname immediately.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "maximum-length source should disappear before cleanup"
        );
        release_sender
            .send(())
            .expect("cleanup should remain blocked until assertions finish");
        finished_receiver
            .await
            .expect("maximum-name quarantine cleanup should finish");
    }

    /// Verifies conditional cleanup of a matching source succeeds and removes it.
    #[tokio::test]
    async fn move_source_deletion_removes_a_matching_source() {
        let temp = TempDir::create();
        let path = temp.path().join("completed-move-source");
        tokio::fs::write(&path, "published at destination")
            .await
            .expect("move source should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");

        let result = delete_move_source(
            path.display().to_string(),
            MoveSourceIdentity::from_metadata(&metadata),
        )
        .await;

        // The router completes the move only on a successful deletion result.
        assert!(
            matches!(result, Ok(())),
            "move source deletion should succeed"
        );
        // A successful response must mean the identity-verified source pathname is gone.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "move source should be deleted before success is returned"
        );
    }

    #[tokio::test]
    async fn move_source_deletion_refuses_a_replacement_path() {
        let temp = TempDir::create();
        let path = temp.path().join("move-identity");
        tokio::fs::write(&path, "original")
            .await
            .expect("original source should be created");
        let original = tokio::fs::metadata(&path)
            .await
            .expect("original metadata should be readable");
        let expected_identity = MoveSourceIdentity::from_metadata(&original);
        let original_path = path.with_extension("original");
        tokio::fs::rename(&path, &original_path)
            .await
            .expect("original source should move away from its pathname");
        tokio::fs::write(&path, "replacement")
            .await
            .expect("replacement source should be created");

        let result = delete_move_source(path.display().to_string(), expected_identity).await;

        // A completed destination copy must not authorize deletion of a new object at the old path.
        assert!(
            matches!(
                result,
                Err(CommandError {
                    kind: CommandErrorKind::InvalidInput,
                    ..
                })
            ),
            "conditional move deletion should reject a replacement source"
        );
        assert_eq!(
            tokio::fs::read_to_string(&path)
                .await
                .expect("replacement source should remain readable"),
            "replacement",
            "identity mismatch must preserve the replacement source"
        );
    }
}
