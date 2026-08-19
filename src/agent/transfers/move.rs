use super::copy::{
    LocalCopyError, LocalCopyResponseContext, validate_local_copy_destination,
    validate_local_copy_parent,
};
use super::destination::{
    DestinationPlaceError, backup_path_for_destination, check_existing_destination,
    destination_entry_exists, remove_existing_path,
};
use crate::agent::{AgentActor, AgentCommandError};
use redoor::commands::{CommandResult, CopyExistingMode, MoveSourceIdentity};
use redoor::{Level, log};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Keeps move-only failures out of the reusable local copy implementation.
#[derive(Debug, Error)]
pub(crate) enum LocalMoveError {
    #[error(transparent)]
    Copy(#[from] LocalCopyError),
    #[error(transparent)]
    Destination(#[from] DestinationPlaceError),
    #[error("Failed to rename move source to destination: {0}")]
    RenameSource(#[source] std::io::Error),
    #[error("Failed to hide the displaced destination after atomic move: {0}")]
    HideDisplacedDestination(#[source] std::io::Error),
    #[error("Failed to delete move source after copying: {0}")]
    DeleteSource(#[source] std::io::Error),
    #[error("Move source changed while it was being copied; refusing to delete it")]
    SourceChanged,
}

impl LocalMoveError {
    /// Maps move failures to the stable protocol kind used by command responses.
    pub(crate) fn kind(&self) -> redoor::commands::CommandErrorKind {
        match self {
            Self::Copy(error) => error.kind(),
            Self::Destination(error) => error.kind(),
            Self::RenameSource(error)
            | Self::HideDisplacedDestination(error)
            | Self::DeleteSource(error) => redoor::commands::CommandErrorKind::from_io_error(error),
            Self::SourceChanged => redoor::commands::CommandErrorKind::InvalidInput,
        }
    }
}

impl AgentActor {
    /// Moves a same-agent path atomically when possible and otherwise copies before deleting.
    pub(crate) async fn local_move(
        &self,
        source_path: String,
        dest_path: String,
        source_is_directory: bool,
        expected_identity: MoveSourceIdentity,
        on_existing: CopyExistingMode,
        response: LocalCopyResponseContext<'_>,
    ) {
        let result = self
            .run_local_move(
                source_path,
                dest_path,
                source_is_directory,
                expected_identity,
                on_existing,
                &response,
            )
            .await;
        let result = match result {
            Ok(atomic) => CommandResult::LocalMove { atomic },
            Err(error) => AgentCommandError::from(error).into(),
        };
        self.send_command_response(
            response.write,
            response.agent_id,
            response.request_id,
            result,
        )
        .await;
    }

    /// Returns whether renameat2 published the destination so callers can stamp the public row.
    async fn run_local_move(
        &self,
        source_path: String,
        dest_path: String,
        source_is_directory: bool,
        expected_identity: MoveSourceIdentity,
        on_existing: CopyExistingMode,
        response: &LocalCopyResponseContext<'_>,
    ) -> Result<bool, LocalMoveError> {
        let source = PathBuf::from(&source_path);
        let dest = PathBuf::from(&dest_path);
        validate_local_copy_destination(&source, &dest, source_is_directory).await?;
        validate_local_copy_parent(&dest).await?;
        check_existing_destination(&dest, on_existing, source_is_directory).await?;

        let source_metadata = tokio::fs::metadata(&source).await.map_err(|error| {
            if source_is_directory {
                LocalMoveError::from(LocalCopyError::AccessSourceDirectory(error))
            } else {
                LocalMoveError::from(LocalCopyError::AccessSourceFile(error))
            }
        })?;
        if source_is_directory != source_metadata.is_dir()
            || (!source_is_directory && !source_metadata.is_file())
        {
            return Err(if source_is_directory {
                LocalCopyError::SourceNotDirectory(source_path).into()
            } else {
                LocalCopyError::SourceNotFile(source_path).into()
            });
        }
        if move_source_identity(&source_metadata) != expected_identity {
            return Err(LocalMoveError::SourceChanged);
        }

        let destination_exists = destination_entry_exists(&dest).await?;
        let dest_parent = dest
            .parent()
            .ok_or_else(|| LocalCopyError::DestinationParentNotFound(dest.display().to_string()))?;
        let dest_parent_metadata = tokio::fs::metadata(dest_parent).await.map_err(|_| {
            LocalCopyError::AccessDestinationParent(dest_parent.display().to_string())
        })?;
        let same_mount = metadata_on_same_mount(&source_metadata, &dest_parent_metadata);

        if can_use_atomic_rename(same_mount, destination_exists, on_existing) {
            match rename_atomically(
                source.clone(),
                dest.clone(),
                destination_exists,
                on_existing == CopyExistingMode::Override,
            )
            .await
            {
                Ok(AtomicRenameResult::Renamed) => return Ok(true),
                Ok(AtomicRenameResult::Exchanged) => {
                    finish_atomic_override(source, dest).await?;
                    return Ok(true);
                }
                Ok(AtomicRenameResult::FallbackRequired) => {}
                Err(error) => return Err(LocalMoveError::RenameSource(error)),
            }
        }

        if source_is_directory {
            self.run_local_copy_directory(source_path.clone(), dest_path, on_existing, response)
                .await?;
            verify_move_source_identity(&source, &expected_identity).await?;
            tokio::fs::remove_dir_all(source)
                .await
                .map_err(LocalMoveError::DeleteSource)?;
        } else {
            self.run_local_copy_file(source_path.clone(), dest_path, on_existing, response)
                .await?;
            verify_move_source_identity(&source, &expected_identity).await?;
            tokio::fs::remove_file(source)
                .await
                .map_err(LocalMoveError::DeleteSource)?;
        }
        Ok(false)
    }
}

/// Identifies one local source for conditional cleanup after copy publication.
fn move_source_identity(metadata: &std::fs::Metadata) -> MoveSourceIdentity {
    use std::os::unix::fs::MetadataExt;

    MoveSourceIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        is_directory: metadata.is_dir(),
    }
}

/// Refuses destructive cleanup if a source pathname now resolves to another object.
async fn verify_move_source_identity(
    source: &Path,
    expected_identity: &MoveSourceIdentity,
) -> Result<(), LocalMoveError> {
    let metadata = tokio::fs::metadata(source)
        .await
        .map_err(LocalMoveError::DeleteSource)?;
    if move_source_identity(&metadata) != *expected_identity {
        return Err(LocalMoveError::SourceChanged);
    }
    Ok(())
}

/// Outcome of a no-replace rename attempt that may require copy semantics instead.
#[derive(Debug)]
enum AtomicRenameResult {
    Renamed,
    Exchanged,
    FallbackRequired,
}

/// Removes the displaced destination from the visible source name without undoing a published move.
async fn finish_atomic_override(source: PathBuf, dest: PathBuf) -> Result<(), LocalMoveError> {
    let mut cleanup_path = None;
    for _ in 0..16 {
        let candidate = backup_path_for_destination(&source);
        match rename_atomically(source.clone(), candidate.clone(), false, false).await {
            Ok(AtomicRenameResult::Renamed) => {
                cleanup_path = Some(candidate);
                break;
            }
            Ok(AtomicRenameResult::FallbackRequired) => {}
            Ok(AtomicRenameResult::Exchanged) => unreachable!("cleanup names are never replaced"),
            Err(error) => {
                restore_after_hide_failure(&source, &dest).await;
                return Err(LocalMoveError::HideDisplacedDestination(error));
            }
        }
    }
    let Some(cleanup_path) = cleanup_path else {
        restore_after_hide_failure(&source, &dest).await;
        return Err(LocalMoveError::HideDisplacedDestination(
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "failed to reserve a unique displaced-destination cleanup path",
            ),
        ));
    };

    if let Err(error) = remove_existing_path(&cleanup_path).await {
        // The move is complete and the source name is gone; hidden cleanup must not report it as failed.
        log!(
            Level::Error,
            "Failed to remove displaced destination after atomic move: path={}, error={}",
            cleanup_path.display(),
            error
        );
    }
    Ok(())
}

/// Rolls back a published exchange when the old destination cannot leave the source name safely.
async fn restore_after_hide_failure(source: &Path, dest: &Path) {
    let restore_result =
        rename_atomically(source.to_path_buf(), dest.to_path_buf(), true, true).await;
    if !matches!(restore_result, Ok(AtomicRenameResult::Exchanged)) {
        // The destination is already published, so preserve the rollback failure for diagnosis.
        log!(
            Level::Error,
            "Failed to restore atomic move after hiding displaced destination failed: source={}, destination={}, result={:?}",
            source.display(),
            dest.display(),
            restore_result
        );
    }
}

#[cfg(target_os = "linux")]
/// Uses `renameat2` to either reserve a missing name or atomically exchange an override target.
async fn rename_atomically(
    source: PathBuf,
    dest: PathBuf,
    mut destination_exists: bool,
    allow_replacement: bool,
) -> std::io::Result<AtomicRenameResult> {
    tokio::task::spawn_blocking(move || {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let dest = CString::new(dest.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        for _ in 0..16 {
            // musl does not export glibc's `renameat2` wrapper, so the Linux syscall is used
            // directly to keep static musl binaries linkable.
            // SAFETY: both pointers come from live NUL-terminated CStrings, the directory
            // descriptors and flag are valid renameat2 values, and the syscall retains neither.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    libc::AT_FDCWD,
                    source.as_ptr(),
                    libc::AT_FDCWD,
                    dest.as_ptr(),
                    if destination_exists {
                        libc::RENAME_EXCHANGE
                    } else {
                        libc::RENAME_NOREPLACE
                    },
                )
            };
            if result == 0 {
                return Ok(if destination_exists {
                    AtomicRenameResult::Exchanged
                } else {
                    AtomicRenameResult::Renamed
                });
            }
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EEXIST) if allow_replacement && !destination_exists => {
                    destination_exists = true;
                }
                Some(libc::ENOENT) if allow_replacement && destination_exists => {
                    destination_exists = false;
                }
                Some(libc::EEXIST) | Some(libc::EXDEV) | Some(libc::ENOSYS)
                | Some(libc::EINVAL) | Some(libc::ENOENT) => {
                    return Ok(AtomicRenameResult::FallbackRequired);
                }
                _ => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "destination changed too frequently to complete an atomic move",
        ))
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(target_os = "macos")]
/// Uses Darwin's exclusive and swap renames to provide the same atomic conflict semantics.
async fn rename_atomically(
    source: PathBuf,
    dest: PathBuf,
    mut destination_exists: bool,
    allow_replacement: bool,
) -> std::io::Result<AtomicRenameResult> {
    tokio::task::spawn_blocking(move || {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let dest = CString::new(dest.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        for _ in 0..16 {
            // SAFETY: both pointers are live NUL-terminated CStrings and renamex_np retains neither.
            let result = unsafe {
                libc::renamex_np(
                    source.as_ptr(),
                    dest.as_ptr(),
                    if destination_exists {
                        libc::RENAME_SWAP
                    } else {
                        libc::RENAME_EXCL
                    },
                )
            };
            if result == 0 {
                return Ok(if destination_exists {
                    AtomicRenameResult::Exchanged
                } else {
                    AtomicRenameResult::Renamed
                });
            }
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EEXIST) if allow_replacement && !destination_exists => {
                    destination_exists = true;
                }
                Some(libc::ENOENT) if allow_replacement && destination_exists => {
                    destination_exists = false;
                }
                Some(libc::EEXIST) | Some(libc::EXDEV) | Some(libc::ENOTSUP)
                | Some(libc::EINVAL) | Some(libc::ENOENT) => {
                    return Ok(AtomicRenameResult::FallbackRequired);
                }
                _ => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "destination changed too frequently to complete an atomic move",
        ))
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
/// Conservatively falls back where atomic exclusive and exchange renames are unavailable.
async fn rename_atomically(
    _source: PathBuf,
    _dest: PathBuf,
    _destination_exists: bool,
    _allow_replacement: bool,
) -> std::io::Result<AtomicRenameResult> {
    Ok(AtomicRenameResult::FallbackRequired)
}

/// Selects atomic rename for new names and for overrides that may exchange any entry types.
fn can_use_atomic_rename(
    same_mount: bool,
    destination_exists: bool,
    on_existing: CopyExistingMode,
) -> bool {
    same_mount && (!destination_exists || on_existing == CopyExistingMode::Override)
}

#[cfg(unix)]
/// Device ids provide a cheap preflight while rename remains authoritative for cross-device races.
fn metadata_on_same_mount(source: &std::fs::Metadata, dest_parent: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    source.dev() == dest_parent.dev()
}

#[cfg(not(unix))]
/// Platforms without device ids conservatively use copy/delete rather than assuming atomicity.
fn metadata_on_same_mount(_source: &std::fs::Metadata, _dest_parent: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_move_requires_same_mount_and_a_rename_compatible_policy() {
        assert!(
            can_use_atomic_rename(true, false, CopyExistingMode::Error),
            "same-mount moves to missing destinations should use atomic rename"
        );
        assert!(
            !can_use_atomic_rename(false, false, CopyExistingMode::Override),
            "different mounts must fall back to copy/delete"
        );
        assert!(
            can_use_atomic_rename(true, true, CopyExistingMode::Override),
            "same-mount overrides should atomically exchange existing destinations"
        );
        assert!(
            !can_use_atomic_rename(true, true, CopyExistingMode::Merge),
            "merge requires copy placement semantics"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_moves_missing_directory() {
        let root = std::env::temp_dir().join(format!(
            "redoor-rename-noreplace-dir-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("rename test root should be created");
        let source = root.join("source-directory");
        let dest = root.join("dest-directory");
        tokio::fs::create_dir(&source)
            .await
            .expect("source directory should be created");
        tokio::fs::write(source.join("value.txt"), "moved")
            .await
            .expect("source child should be written");

        let result = rename_atomically(source.clone(), dest.clone(), false, false)
            .await
            .expect("missing directory destinations should rename");
        assert!(
            matches!(result, AtomicRenameResult::Renamed),
            "same-mount missing directory destinations should use the no-replace syscall"
        );
        assert!(
            !tokio::fs::try_exists(&source).await.expect("source lookup"),
            "a successful atomic directory rename must remove the source path"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest.join("value.txt"))
                .await
                .expect("renamed destination directory should be readable"),
            "moved",
            "destination must contain the renamed source tree"
        );

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("rename test root should be cleaned up");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_moves_missing_destination() {
        let root =
            std::env::temp_dir().join(format!("redoor-rename-noreplace-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("rename test root should be created");
        let source = root.join("source.txt");
        let dest = root.join("dest.txt");
        tokio::fs::write(&source, "moved")
            .await
            .expect("rename source should be written");

        let result = rename_atomically(source.clone(), dest.clone(), false, false)
            .await
            .expect("missing destinations should rename");
        assert!(
            matches!(result, AtomicRenameResult::Renamed),
            "same-mount missing destinations should use the no-replace syscall"
        );
        assert!(
            !tokio::fs::try_exists(&source).await.expect("source lookup"),
            "a successful atomic rename must remove the source path"
        );
        assert_eq!(
            tokio::fs::read_to_string(&dest)
                .await
                .expect("renamed destination should be readable"),
            "moved",
            "destination must contain the renamed source contents"
        );

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("rename test root should be cleaned up");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_without_replacement_refuses_existing_destination() {
        let root =
            std::env::temp_dir().join(format!("redoor-rename-exists-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("rename test root should be created");
        let source = root.join("source.txt");
        let dest = root.join("dest.txt");
        tokio::fs::write(&source, "source")
            .await
            .expect("rename source should be written");
        tokio::fs::write(&dest, "keep")
            .await
            .expect("existing destination should be written");

        let result = rename_atomically(source.clone(), dest.clone(), false, false)
            .await
            .expect("existing destinations should fall back instead of failing the move");
        assert!(
            matches!(result, AtomicRenameResult::FallbackRequired),
            "an occupied destination must not be overwritten by atomic rename"
        );
        assert_eq!(
            tokio::fs::read_to_string(&source)
                .await
                .expect("source should remain after a refused rename"),
            "source",
            "source contents must stay in place when rename is refused"
        );
        assert_eq!(
            tokio::fs::read_to_string(&dest)
                .await
                .expect("destination should remain after a refused rename"),
            "keep",
            "existing destination contents must be preserved"
        );

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("rename test root should be cleaned up");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_exchanges_different_entry_types() {
        let root =
            std::env::temp_dir().join(format!("redoor-rename-exchange-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("rename test root should be created");
        let source = root.join("source-directory");
        let dest = root.join("dest.txt");
        tokio::fs::create_dir(&source)
            .await
            .expect("source directory should be created");
        tokio::fs::write(source.join("value.txt"), "moved")
            .await
            .expect("source child should be written");
        tokio::fs::write(&dest, "displaced")
            .await
            .expect("destination file should be written");

        let result = rename_atomically(source.clone(), dest.clone(), true, true)
            .await
            .expect("different entry types should exchange atomically");

        assert!(
            matches!(result, AtomicRenameResult::Exchanged),
            "an occupied override destination should use an atomic exchange"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest.join("value.txt"))
                .await
                .expect("exchanged destination directory should be readable"),
            "moved",
            "the source directory must occupy the destination name"
        );
        assert_eq!(
            tokio::fs::read_to_string(&source)
                .await
                .expect("displaced destination file should occupy the source name"),
            "displaced",
            "the old destination must be available for cleanup at the source name"
        );

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("rename test root should be cleaned up");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_exchanges_directories() {
        let root = std::env::temp_dir().join(format!(
            "redoor-rename-exchange-dirs-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root)
            .await
            .expect("rename test root should be created");
        let source = root.join("source-directory");
        let dest = root.join("dest-directory");
        tokio::fs::create_dir(&source)
            .await
            .expect("source directory should be created");
        tokio::fs::create_dir(&dest)
            .await
            .expect("destination directory should be created");
        tokio::fs::write(source.join("source.txt"), "moved")
            .await
            .expect("source child should be written");
        tokio::fs::write(dest.join("dest.txt"), "displaced")
            .await
            .expect("destination child should be written");

        let result = rename_atomically(source.clone(), dest.clone(), true, true)
            .await
            .expect("directories should exchange atomically");

        assert!(
            matches!(result, AtomicRenameResult::Exchanged),
            "an occupied override directory should use an atomic exchange"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest.join("source.txt"))
                .await
                .expect("exchanged destination directory should be readable"),
            "moved",
            "the source directory must occupy the destination name"
        );
        assert_eq!(
            tokio::fs::read_to_string(source.join("dest.txt"))
                .await
                .expect("displaced destination directory should occupy the source name"),
            "displaced",
            "the old destination must be available for cleanup at the source name"
        );

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("rename test root should be cleaned up");
    }
}
