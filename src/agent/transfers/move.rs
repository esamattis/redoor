use super::copy::{
    LocalCopyError, LocalCopyResponseContext, validate_local_copy_destination,
    validate_local_copy_parent,
};
use super::destination::{
    DestinationPlaceError, backup_path_for_destination, check_existing_destination,
    destination_entry_exists, remove_existing_path,
};
use crate::agent::{AgentActor, AgentCommandError};
use redoor::atomic_rename::{
    AtomicRenameOutcome, ReplacementRenameOutcome, exchange_existing_paths,
    rename_with_replacement, rename_without_replacement,
};
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
                PathBuf::from(&source_path),
                PathBuf::from(&dest_path),
                source_is_directory,
                expected_identity,
                on_existing,
                &response,
            )
            .await;
        let result = match result {
            Ok(atomic) => {
                log!(
                    Level::Debug,
                    "Smart move completed: source={}, dest={}, atomic={}, method={}",
                    source_path,
                    dest_path,
                    atomic,
                    if atomic {
                        "filesystem_rename"
                    } else {
                        "transfer_copy_delete"
                    }
                );
                CommandResult::LocalMove { atomic }
            }
            Err(error) => {
                log!(
                    Level::Debug,
                    "Smart move failed: source={}, dest={}, error={}",
                    source_path,
                    dest_path,
                    error
                );
                AgentCommandError::from(error).into()
            }
        };
        self.send_command_response(
            response.write,
            response.agent_id,
            response.request_id,
            result,
        )
        .await;
    }

    /// Returns whether a filesystem rename published the destination for public progress stamping.
    pub(crate) async fn run_local_move(
        &self,
        source: PathBuf,
        dest: PathBuf,
        source_is_directory: bool,
        expected_identity: MoveSourceIdentity,
        on_existing: CopyExistingMode,
        response: &LocalCopyResponseContext<'_>,
    ) -> Result<bool, LocalMoveError> {
        log!(
            Level::Debug,
            "Smart move started: source={}, dest={}, directory={}, on_existing={:?}, expected_identity={:?}",
            source.display(),
            dest.display(),
            source_is_directory,
            on_existing,
            expected_identity
        );
        validate_local_copy_destination(&source, &dest, source_is_directory).await?;
        super::copy::ensure_local_copy_active(&response.cancel)?;
        validate_local_copy_parent(&dest).await?;
        super::copy::ensure_local_copy_active(&response.cancel)?;
        check_existing_destination(&dest, on_existing, source_is_directory).await?;
        super::copy::ensure_local_copy_active(&response.cancel)?;
        let source_metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| {
                if source_is_directory {
                    LocalMoveError::from(LocalCopyError::AccessSourceDirectory(error))
                } else {
                    LocalMoveError::from(LocalCopyError::AccessSourceFile(error))
                }
            })?;
        super::copy::ensure_local_copy_active(&response.cancel)?;
        {
            use std::os::unix::fs::MetadataExt;
            log!(
                Level::Debug,
                "Smart move source inspected: source={}, device={}, inode={}, directory={}, symlink={}, file={}, size={}, mtime={}.{}",
                source.display(),
                source_metadata.dev(),
                source_metadata.ino(),
                source_metadata.is_dir(),
                source_metadata.file_type().is_symlink(),
                source_metadata.is_file(),
                source_metadata.len(),
                source_metadata.mtime(),
                source_metadata.mtime_nsec()
            );
        }
        if source_is_directory != source_metadata.is_dir()
            || (!source_is_directory
                && !source_metadata.is_file()
                && !source_metadata.file_type().is_symlink())
        {
            log!(
                Level::Debug,
                "Smart move source type mismatch: source={}, expected_directory={}, is_dir={}, is_file={}, is_symlink={}",
                source.display(),
                source_is_directory,
                source_metadata.is_dir(),
                source_metadata.is_file(),
                source_metadata.file_type().is_symlink()
            );
            return Err(if source_is_directory {
                LocalCopyError::SourceNotDirectory(source.display().to_string()).into()
            } else {
                LocalCopyError::SourceNotFile(source.display().to_string()).into()
            });
        }
        if !move_source_matches_identity(&source, &source_metadata, &expected_identity).await? {
            log!(
                Level::Debug,
                "Smart move source identity mismatch before rename: source={}, expected_identity={:?}, actual_identity={:?}",
                source.display(),
                expected_identity,
                move_source_identity(&source_metadata)
            );
            return Err(LocalMoveError::SourceChanged);
        }
        let destination_exists = destination_entry_exists(&dest).await?;
        super::copy::ensure_local_copy_active(&response.cancel)?;
        let dest_parent = dest
            .parent()
            .ok_or_else(|| LocalCopyError::DestinationParentNotFound(dest.display().to_string()))?;
        let dest_parent_metadata = tokio::fs::metadata(dest_parent).await.map_err(|_| {
            LocalCopyError::AccessDestinationParent(dest_parent.display().to_string())
        })?;
        super::copy::ensure_local_copy_active(&response.cancel)?;
        let same_mount = metadata_on_same_mount(&source_metadata, &dest_parent_metadata);
        let atomic_rename = can_use_atomic_rename(same_mount, destination_exists, on_existing);
        {
            use std::os::unix::fs::MetadataExt;
            log!(
                Level::Debug,
                "Smart move placement decided: source={}, dest={}, dest_parent={}, source_device={}, dest_parent_device={}, same_mount={}, destination_exists={}, on_existing={:?}, atomic_rename={}",
                source.display(),
                dest.display(),
                dest_parent.display(),
                source_metadata.dev(),
                dest_parent_metadata.dev(),
                same_mount,
                destination_exists,
                on_existing,
                atomic_rename
            );
        }

        if atomic_rename {
            log!(
                Level::Debug,
                "Smart move attempting atomic rename: source={}, dest={}, destination_exists={}, on_existing={:?}",
                source.display(),
                dest.display(),
                destination_exists,
                on_existing
            );
            match rename_same_filesystem(
                source.clone(),
                dest.clone(),
                destination_exists,
                on_existing,
            )
            .await
            {
                Ok(SameFilesystemRenameResult::Renamed) => {
                    log!(
                        Level::Debug,
                        "Smart move atomic rename published destination: source={}, dest={}, method=rename",
                        source.display(),
                        dest.display()
                    );
                    return Ok(true);
                }
                Ok(SameFilesystemRenameResult::Exchanged) => {
                    log!(
                        Level::Debug,
                        "Smart move atomic exchange published destination: source={}, dest={}",
                        source.display(),
                        dest.display()
                    );
                    finish_atomic_override(source, dest).await?;
                    return Ok(true);
                }
                Ok(SameFilesystemRenameResult::CopyRequired) => {
                    log!(
                        Level::Debug,
                        "Smart move atomic rename requested copy/delete fallback: source={}, dest={}",
                        source.display(),
                        dest.display()
                    );
                }
                Err(error) => {
                    log!(
                        Level::Debug,
                        "Smart move atomic rename failed: source={}, dest={}, error={}",
                        source.display(),
                        dest.display(),
                        error
                    );
                    return Err(LocalMoveError::RenameSource(error));
                }
            }
        }

        let copy_kind = if source_metadata.file_type().is_symlink() {
            "symlink"
        } else if source_is_directory {
            "directory"
        } else {
            "file"
        };
        log!(
            Level::Debug,
            "Smart move using copy/delete: source={}, dest={}, kind={}, copy_fallback=true",
            source.display(),
            dest.display(),
            copy_kind
        );
        if source_metadata.file_type().is_symlink() {
            self.run_local_copy_symlink(source.clone(), dest, on_existing, response)
                .await?;
            super::copy::ensure_local_copy_active(&response.cancel)?;
            verify_move_source_identity(&source, &expected_identity).await?;
            log!(
                Level::Debug,
                "Smart move deleting copied symlink source: source={}",
                source.display()
            );
            tokio::fs::remove_file(source)
                .await
                .map_err(LocalMoveError::DeleteSource)?;
        } else if source_is_directory {
            self.run_local_copy_directory(source.clone(), dest, on_existing, response)
                .await?;
            // Cancellation after destination publication still wins before destructive source deletion.
            super::copy::ensure_local_copy_active(&response.cancel)?;
            verify_move_source_identity(&source, &expected_identity).await?;
            log!(
                Level::Debug,
                "Smart move deleting copied directory source: source={}",
                source.display()
            );
            redoor::safe_fs::safe_rm_all(source)
                .await
                .map_err(LocalMoveError::DeleteSource)?;
        } else {
            self.run_local_copy_file(source.clone(), dest, on_existing, response)
                .await?;
            // Source preservation is the final cancel boundary for cross-device file moves.
            super::copy::ensure_local_copy_active(&response.cancel)?;
            verify_move_source_identity(&source, &expected_identity).await?;
            log!(
                Level::Debug,
                "Smart move deleting copied file source: source={}",
                source.display()
            );
            tokio::fs::remove_file(source)
                .await
                .map_err(LocalMoveError::DeleteSource)?;
        }
        Ok(false)
    }
}

/// Identifies one local source for conditional cleanup after copy publication.
pub(crate) fn move_source_identity(metadata: &std::fs::Metadata) -> MoveSourceIdentity {
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
    let metadata = tokio::fs::symlink_metadata(source).await.map_err(|error| {
        log!(
            Level::Debug,
            "Smart move source disappeared before deletion: source={}, error={}",
            source.display(),
            error
        );
        LocalMoveError::DeleteSource(error)
    })?;
    if !move_source_matches_identity(source, &metadata, expected_identity).await? {
        log!(
            Level::Debug,
            "Smart move source identity mismatch before deletion: source={}, expected_identity={:?}, actual_identity={:?}",
            source.display(),
            expected_identity,
            move_source_identity(&metadata)
        );
        return Err(LocalMoveError::SourceChanged);
    }
    Ok(())
}

/// Accepts legacy target identity for symlink moves while trash restore tracks the link itself.
async fn move_source_matches_identity(
    source: &Path,
    entry_metadata: &std::fs::Metadata,
    expected_identity: &MoveSourceIdentity,
) -> Result<bool, LocalMoveError> {
    let entry_identity = move_source_identity(entry_metadata);
    if entry_identity == *expected_identity {
        log!(
            Level::Debug,
            "Smart move source identity matched entry: source={}, identity={:?}",
            source.display(),
            entry_identity
        );
        return Ok(true);
    }
    if !entry_metadata.file_type().is_symlink() {
        log!(
            Level::Debug,
            "Smart move source identity did not match non-symlink entry: source={}, expected_identity={:?}, actual_identity={:?}",
            source.display(),
            expected_identity,
            entry_identity
        );
        return Ok(false);
    }
    let target_metadata = tokio::fs::metadata(source)
        .await
        .map_err(LocalMoveError::DeleteSource)?;
    let target_identity = move_source_identity(&target_metadata);
    let matched = target_identity == *expected_identity;
    log!(
        Level::Debug,
        "Smart move source identity compared through symlink target: source={}, matched={}, expected_identity={:?}, entry_identity={:?}, target_identity={:?}",
        source.display(),
        matched,
        expected_identity,
        entry_identity,
        target_identity
    );
    Ok(matched)
}

/// Separates completed same-filesystem renames from authoritative cross-device copy fallback.
#[derive(Debug)]
enum SameFilesystemRenameResult {
    Renamed,
    Exchanged,
    CopyRequired,
}

/// Removes the displaced destination from the visible source name without undoing a published move.
async fn finish_atomic_override(source: PathBuf, dest: PathBuf) -> Result<(), LocalMoveError> {
    let mut cleanup_path = None;
    for _ in 0..16 {
        let candidate = backup_path_for_destination(&source);
        match tokio::fs::symlink_metadata(&candidate).await {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                restore_after_hide_failure(&source, &dest).await;
                return Err(LocalMoveError::HideDisplacedDestination(error));
            }
        }
        match tokio::fs::rename(&source, &candidate).await {
            Ok(()) => {
                log!(
                    Level::Debug,
                    "Smart move hid displaced destination: source={}, dest={}, cleanup={}",
                    source.display(),
                    dest.display(),
                    candidate.display()
                );
                cleanup_path = Some(candidate);
                break;
            }
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
        redoor::log_failure!(
            Level::Error,
            "Failed to remove displaced destination after atomic move: path={}, error={}",
            cleanup_path.display(),
            error
        );
    } else {
        log!(
            Level::Debug,
            "Smart move removed displaced destination: cleanup={}",
            cleanup_path.display()
        );
    }
    Ok(())
}

/// Rolls back a published exchange when the old destination cannot leave the source name safely.
async fn restore_after_hide_failure(source: &Path, dest: &Path) {
    let restore_result = exchange_existing_paths(source, dest).await;
    if !matches!(restore_result, Ok(AtomicRenameOutcome::Renamed)) {
        // The destination is already published, so preserve the rollback failure for diagnosis.
        redoor::log_failure!(
            Level::Error,
            "Failed to restore atomic move after hiding displaced destination failed: source={}, destination={}, result={:?}",
            source.display(),
            dest.display(),
            restore_result
        );
    }
}

/// Applies destination policy while retaining the smart move transfer fallback when required.
async fn rename_same_filesystem(
    source: PathBuf,
    dest: PathBuf,
    destination_exists: bool,
    on_existing: CopyExistingMode,
) -> std::io::Result<SameFilesystemRenameResult> {
    log!(
        Level::Debug,
        "Smart move same-filesystem rename started: source={}, dest={}, destination_exists={}, on_existing={:?}",
        source.display(),
        dest.display(),
        destination_exists,
        on_existing
    );
    if on_existing == CopyExistingMode::Override {
        return match rename_with_replacement(&source, &dest, destination_exists).await? {
            ReplacementRenameOutcome::Renamed => Ok(SameFilesystemRenameResult::Renamed),
            ReplacementRenameOutcome::Exchanged => Ok(SameFilesystemRenameResult::Exchanged),
            ReplacementRenameOutcome::CrossDevice | ReplacementRenameOutcome::Incompatible => {
                Ok(SameFilesystemRenameResult::CopyRequired)
            }
        };
    }
    let outcome = rename_without_replacement(&source, &dest).await?;
    log!(
        Level::Debug,
        "Smart move no-replace rename outcome: source={}, dest={}, outcome={:?}",
        source.display(),
        dest.display(),
        outcome
    );
    classify_strict_rename_outcome(outcome, on_existing, &source, &dest)
}

/// Converts strict conditional outcomes without silently weakening no-replacement semantics.
fn classify_strict_rename_outcome(
    outcome: AtomicRenameOutcome,
    on_existing: CopyExistingMode,
    source: &Path,
    dest: &Path,
) -> std::io::Result<SameFilesystemRenameResult> {
    let result = match outcome {
        AtomicRenameOutcome::Renamed => Ok(SameFilesystemRenameResult::Renamed),
        AtomicRenameOutcome::DestinationExists if on_existing == CopyExistingMode::Merge => {
            Ok(SameFilesystemRenameResult::CopyRequired)
        }
        AtomicRenameOutcome::DestinationExists => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!(
                "move destination appeared before rename: {}",
                dest.display()
            ),
        )),
        AtomicRenameOutcome::Missing => Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "move source disappeared before rename: {}",
                source.display()
            ),
        )),
        AtomicRenameOutcome::CrossDevice => Ok(SameFilesystemRenameResult::CopyRequired),
        AtomicRenameOutcome::Unsupported => Ok(SameFilesystemRenameResult::CopyRequired),
    };
    match &result {
        Ok(classified) => log!(
            Level::Debug,
            "Smart move classified no-replace outcome: source={}, dest={}, outcome={:?}, on_existing={:?}, result={:?}",
            source.display(),
            dest.display(),
            outcome,
            on_existing,
            classified
        ),
        Err(error) => log!(
            Level::Debug,
            "Smart move classified no-replace failure: source={}, dest={}, outcome={:?}, on_existing={:?}, error={}",
            source.display(),
            dest.display(),
            outcome,
            on_existing,
            error
        ),
    }
    result
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
    use crate::test_support::TempDir;

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

    #[test]
    fn unsupported_merge_rename_requests_existing_transfer_fallback() {
        let result = classify_strict_rename_outcome(
            AtomicRenameOutcome::Unsupported,
            CopyExistingMode::Merge,
            Path::new("/source"),
            Path::new("/destination"),
        );

        let result = result.expect("unsupported no-replace should select the existing transfer");
        assert!(
            matches!(result, SameFilesystemRenameResult::CopyRequired),
            "merge must retain its copy/delete fallback when conditional rename is unavailable"
        );
    }

    #[test]
    fn authoritative_cross_device_rename_requests_existing_transfer_path() {
        let result = classify_strict_rename_outcome(
            AtomicRenameOutcome::CrossDevice,
            CopyExistingMode::Error,
            Path::new("/source"),
            Path::new("/destination"),
        )
        .expect("cross-device rename should select the transfer path");

        assert!(
            matches!(result, SameFilesystemRenameResult::CopyRequired),
            "an authoritative filesystem boundary must request the existing transfer path"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_moves_missing_directory() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("rename-noreplace-dir");
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

        let result =
            rename_same_filesystem(source.clone(), dest.clone(), false, CopyExistingMode::Error)
                .await
                .expect("missing directory destinations should rename");
        assert!(
            matches!(result, SameFilesystemRenameResult::Renamed),
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
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_moves_missing_destination() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("rename-noreplace");
        tokio::fs::create_dir_all(&root)
            .await
            .expect("rename test root should be created");
        let source = root.join("source.txt");
        let dest = root.join("dest.txt");
        tokio::fs::write(&source, "moved")
            .await
            .expect("rename source should be written");

        let result =
            rename_same_filesystem(source.clone(), dest.clone(), false, CopyExistingMode::Error)
                .await
                .expect("missing destinations should rename");
        assert!(
            matches!(result, SameFilesystemRenameResult::Renamed),
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
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_without_replacement_refuses_existing_destination() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("rename-exists");
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

        let error =
            rename_same_filesystem(source.clone(), dest.clone(), false, CopyExistingMode::Error)
                .await
                .expect_err("existing destinations must fail strict rename");
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists,
            "a destination race must remain a conflict rather than selecting copy/delete"
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
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_exchanges_different_entry_types() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("rename-exchange");
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

        let result = rename_same_filesystem(
            source.clone(),
            dest.clone(),
            true,
            CopyExistingMode::Override,
        )
        .await
        .expect("different entry types should exchange atomically");

        assert!(
            matches!(result, SameFilesystemRenameResult::Exchanged),
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
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn atomic_rename_exchanges_directories() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("rename-exchange-dirs");
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

        let result = rename_same_filesystem(
            source.clone(),
            dest.clone(),
            true,
            CopyExistingMode::Override,
        )
        .await
        .expect("directories should exchange atomically");

        assert!(
            matches!(result, SameFilesystemRenameResult::Exchanged),
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
    }
}
