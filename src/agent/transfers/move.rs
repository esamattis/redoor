use super::copy::{
    LocalCopyError, LocalCopyResponseContext, validate_local_copy_destination,
    validate_local_copy_parent,
};
use super::destination::{DestinationPlaceError, check_existing_destination};
use crate::agent::{AgentActor, AgentCommandError};
use redoor::commands::{CommandResult, CopyExistingMode, MoveSourceIdentity};
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
            Self::RenameSource(error) | Self::DeleteSource(error) => {
                redoor::commands::CommandErrorKind::from_io_error(error)
            }
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
            Ok(()) => CommandResult::LocalMove,
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

    /// Keeps source deletion after successful publication while selecting the cheap rename path.
    async fn run_local_move(
        &self,
        source_path: String,
        dest_path: String,
        source_is_directory: bool,
        expected_identity: MoveSourceIdentity,
        on_existing: CopyExistingMode,
        response: &LocalCopyResponseContext<'_>,
    ) -> Result<(), LocalMoveError> {
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

        let destination_exists = tokio::fs::try_exists(&dest)
            .await
            .map_err(DestinationPlaceError::CheckDestinationPath)?;
        let dest_parent = dest
            .parent()
            .ok_or_else(|| LocalCopyError::DestinationParentNotFound(dest.display().to_string()))?;
        let dest_parent_metadata = tokio::fs::metadata(dest_parent).await.map_err(|_| {
            LocalCopyError::AccessDestinationParent(dest_parent.display().to_string())
        })?;
        let same_mount = metadata_on_same_mount(&source_metadata, &dest_parent_metadata);

        if can_use_atomic_rename(same_mount, destination_exists) {
            match rename_without_replacement(source.clone(), dest.clone()).await {
                Ok(AtomicRenameResult::Renamed) => return Ok(()),
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
        Ok(())
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
enum AtomicRenameResult {
    Renamed,
    FallbackRequired,
}

#[cfg(target_os = "linux")]
/// Uses `renameat2` so a destination created after preflight can never be overwritten.
async fn rename_without_replacement(
    source: PathBuf,
    dest: PathBuf,
) -> std::io::Result<AtomicRenameResult> {
    tokio::task::spawn_blocking(move || {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        let dest = CString::new(dest.as_os_str().as_bytes())
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
        // SAFETY: both pointers come from live NUL-terminated CStrings, the directory descriptors
        // and flag are valid renameat2 values, and the syscall does not retain either pointer.
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                dest.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            return Ok(AtomicRenameResult::Renamed);
        }
        let error = std::io::Error::last_os_error();
        if matches!(
            error.raw_os_error(),
            Some(libc::EEXIST) | Some(libc::EXDEV) | Some(libc::ENOSYS)
        ) {
            Ok(AtomicRenameResult::FallbackRequired)
        } else {
            Err(error)
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(not(target_os = "linux"))]
/// Conservatively falls back where an atomic no-replace rename primitive is unavailable.
async fn rename_without_replacement(
    _source: PathBuf,
    _dest: PathBuf,
) -> std::io::Result<AtomicRenameResult> {
    Ok(AtomicRenameResult::FallbackRequired)
}

/// Atomic replacement is avoided for existing destinations so copy conflict semantics stay exact.
fn can_use_atomic_rename(same_mount: bool, destination_exists: bool) -> bool {
    same_mount && !destination_exists
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
    fn atomic_move_requires_same_mount_and_missing_destination() {
        assert!(
            can_use_atomic_rename(true, false),
            "same-mount moves to missing destinations should use atomic rename"
        );
        assert!(
            !can_use_atomic_rename(false, false),
            "different mounts must fall back to copy/delete"
        );
        assert!(
            !can_use_atomic_rename(true, true),
            "existing destinations need copy placement semantics before source deletion"
        );
    }
}
