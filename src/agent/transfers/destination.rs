use redoor::commands::CopyExistingMode;
use redoor::{Level, log};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Keeps destination conflict handling typed so copy and upload share one policy.
#[derive(Debug, Error)]
pub(crate) enum DestinationPlaceError {
    #[error("Destination already exists: {0}")]
    AlreadyExists(String),
    #[error("Failed to check destination path: {0}")]
    CheckDestinationPath(#[source] std::io::Error),
    #[error("Failed to inspect destination path: {0}")]
    InspectDestinationPath(#[source] std::io::Error),
    #[error("Cannot merge {source_kind} source onto {dest_kind} destination: {path}")]
    TypeMismatch {
        path: String,
        source_kind: &'static str,
        dest_kind: &'static str,
    },
    #[error("Cannot merge onto symlink destination: {0}")]
    SymlinkDestination(String),
    #[error("Failed to remove existing destination: {0}")]
    RemoveExistingDestination(#[source] std::io::Error),
    #[error("Failed to create destination directory: {0}")]
    CreateDestinationDirectory(String),
    #[error("Failed to merge directory entry from {from} to {to}")]
    MergeEntry { from: String, to: String },
    #[error("Failed to place destination from {from} to {to}")]
    PlaceDestination { from: String, to: String },
    #[error("Failed to move existing destination aside before override: {0}")]
    BackupExistingDestination(#[source] std::io::Error),
    #[error("Failed to read merge source directory: {0}")]
    ReadMergeSourceDirectory(String),
    #[error("Failed to read merge source entry: {0}")]
    ReadMergeSourceEntry(String),
    #[error("Unsupported merge source entry type: {0}")]
    UnsupportedMergeEntryType(String),
}

impl DestinationPlaceError {
    /// Maps one placement failure to the stable command error kind carried over the protocol.
    pub(crate) fn kind(&self) -> redoor::commands::CommandErrorKind {
        match self {
            Self::CheckDestinationPath(error)
            | Self::InspectDestinationPath(error)
            | Self::RemoveExistingDestination(error)
            | Self::BackupExistingDestination(error) => {
                redoor::commands::CommandErrorKind::from_io_error(error)
            }
            Self::AlreadyExists(_) => redoor::commands::CommandErrorKind::AlreadyExists,
            Self::TypeMismatch { .. }
            | Self::SymlinkDestination(_)
            | Self::UnsupportedMergeEntryType(_) => {
                redoor::commands::CommandErrorKind::InvalidInput
            }
            Self::CreateDestinationDirectory(_)
            | Self::MergeEntry { .. }
            | Self::PlaceDestination { .. }
            | Self::ReadMergeSourceDirectory(_)
            | Self::ReadMergeSourceEntry(_) => redoor::commands::CommandErrorKind::Internal,
        }
    }
}

/// Validates an already-present destination against the requested conflict policy before work starts.
pub(crate) async fn check_existing_destination(
    path: &Path,
    on_existing: CopyExistingMode,
    source_is_directory: bool,
) -> Result<(), DestinationPlaceError> {
    match destination_entry_exists(path).await {
        Ok(false) => Ok(()),
        Ok(true) => match on_existing {
            CopyExistingMode::Error => Err(DestinationPlaceError::AlreadyExists(
                path.display().to_string(),
            )),
            CopyExistingMode::Override => Ok(()),
            CopyExistingMode::Merge => {
                ensure_merge_types_compatible(path, source_is_directory).await
            }
        },
        Err(error) => Err(error),
    }
}

/// Detects directory entries without following symlinks so dangling links still conflict.
pub(crate) async fn destination_entry_exists(path: &Path) -> Result<bool, DestinationPlaceError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(DestinationPlaceError::CheckDestinationPath(error)),
    }
}

/// Ensures merge only runs when source and destination share the same non-symlink entry kind.
///
/// Symlink destinations are rejected so merge never writes through a user-controlled link.
async fn ensure_merge_types_compatible(
    path: &Path,
    source_is_directory: bool,
) -> Result<(), DestinationPlaceError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(DestinationPlaceError::InspectDestinationPath)?;
    if metadata.is_symlink() {
        return Err(DestinationPlaceError::SymlinkDestination(
            path.display().to_string(),
        ));
    }

    let dest_is_directory = metadata.is_dir();
    if source_is_directory == dest_is_directory {
        return Ok(());
    }

    Err(DestinationPlaceError::TypeMismatch {
        path: path.display().to_string(),
        source_kind: if source_is_directory {
            "directory"
        } else {
            "file"
        },
        dest_kind: if dest_is_directory {
            "directory"
        } else {
            "file"
        },
    })
}

/// Removes one existing file, symlink, or directory so placement can publish a replacement path.
pub(crate) async fn remove_existing_path(path: &Path) -> Result<(), DestinationPlaceError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(DestinationPlaceError::InspectDestinationPath)?;
    // Symlinks report as non-directories even when they point at directories, so remove_file
    // drops the link itself instead of deleting the link target tree.
    if metadata.is_dir() {
        redoor::safe_fs::safe_rm_all(path)
            .await
            .map_err(DestinationPlaceError::RemoveExistingDestination)
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(DestinationPlaceError::RemoveExistingDestination)
    }
}

/// Builds a uniquely named sibling path used to hold the previous destination during override.
pub(crate) fn backup_path_for_destination(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("destination");
    let backup_name = format!(".{file_name}.redoor-override-backup-{}", fastrand::u64(..));
    match path.parent() {
        Some(parent) => parent.join(backup_name),
        None => PathBuf::from(backup_name),
    }
}

/// Publishes temp content by moving the old destination aside first so a failed rename can restore it.
async fn publish_over_existing_with_backup(
    temp_path: &Path,
    final_path: &Path,
) -> Result<(), DestinationPlaceError> {
    let backup_path = backup_path_for_destination(final_path);

    tokio::fs::rename(final_path, &backup_path)
        .await
        .map_err(DestinationPlaceError::BackupExistingDestination)?;

    match tokio::fs::rename(temp_path, final_path).await {
        Ok(()) => {
            if let Err(error) = remove_existing_path(&backup_path).await {
                // The new destination is already published; keep the successful result and surface cleanup loss in logs.
                log!(
                    Level::Error,
                    "Failed to remove destination backup after override: backup={}, error={}",
                    backup_path.display(),
                    error
                );
            }
            Ok(())
        }
        Err(_) => {
            if let Err(error) = tokio::fs::rename(&backup_path, final_path).await {
                // Both publish and restore failed; the prior content may only exist at the backup path.
                log!(
                    Level::Error,
                    "Failed to restore destination backup after override publish failure: backup={}, destination={}, error={}",
                    backup_path.display(),
                    final_path.display(),
                    error
                );
            }
            Err(DestinationPlaceError::PlaceDestination {
                from: temp_path.display().to_string(),
                to: final_path.display().to_string(),
            })
        }
    }
}

/// Publishes completed temp content to the final path according to the conflict policy.
pub(crate) async fn place_temp_at_destination(
    temp_path: &Path,
    final_path: &Path,
    on_existing: CopyExistingMode,
    content_is_directory: bool,
) -> Result<(), DestinationPlaceError> {
    let exists = destination_entry_exists(final_path).await?;

    if !exists {
        return tokio::fs::rename(temp_path, final_path).await.map_err(|_| {
            DestinationPlaceError::PlaceDestination {
                from: temp_path.display().to_string(),
                to: final_path.display().to_string(),
            }
        });
    }

    match on_existing {
        CopyExistingMode::Error => Err(DestinationPlaceError::AlreadyExists(
            final_path.display().to_string(),
        )),
        CopyExistingMode::Override => {
            publish_over_existing_with_backup(temp_path, final_path).await
        }
        CopyExistingMode::Merge => {
            ensure_merge_types_compatible(final_path, content_is_directory).await?;
            if content_is_directory {
                merge_directory_tree(temp_path, final_path).await?;
                let _ = redoor::safe_fs::safe_rm_all(temp_path).await;
                Ok(())
            } else {
                // File merge replaces the destination file contents atomically via rename.
                tokio::fs::rename(temp_path, final_path).await.map_err(|_| {
                    DestinationPlaceError::PlaceDestination {
                        from: temp_path.display().to_string(),
                        to: final_path.display().to_string(),
                    }
                })
            }
        }
    }
}

/// Ensures one merge destination directory exists as a real directory, never through a symlink.
async fn prepare_merge_directory(dest_dir: &Path) -> Result<(), DestinationPlaceError> {
    match tokio::fs::symlink_metadata(dest_dir).await {
        Ok(metadata) => {
            if metadata.is_symlink() || !metadata.is_dir() {
                // Drop links and non-directories so later writes cannot escape through the old entry.
                remove_existing_path(dest_dir).await?;
                tokio::fs::create_dir(dest_dir).await.map_err(|_| {
                    DestinationPlaceError::CreateDestinationDirectory(
                        dest_dir.display().to_string(),
                    )
                })?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(dest_dir).await.map_err(|_| {
                DestinationPlaceError::CreateDestinationDirectory(dest_dir.display().to_string())
            })?;
            // create_dir_all can recreate a path that races into a symlink; reject that outcome.
            let metadata = tokio::fs::symlink_metadata(dest_dir)
                .await
                .map_err(DestinationPlaceError::InspectDestinationPath)?;
            if metadata.is_symlink() || !metadata.is_dir() {
                return Err(DestinationPlaceError::SymlinkDestination(
                    dest_dir.display().to_string(),
                ));
            }
            Ok(())
        }
        Err(error) => Err(DestinationPlaceError::InspectDestinationPath(error)),
    }
}

/// Removes symlink or directory conflicts at a file destination so copy never writes through a link.
async fn prepare_merge_file_destination(dest_path: &Path) -> Result<(), DestinationPlaceError> {
    match tokio::fs::symlink_metadata(dest_path).await {
        Ok(metadata) => {
            if metadata.is_symlink() || metadata.is_dir() {
                remove_existing_path(dest_path).await?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DestinationPlaceError::InspectDestinationPath(error)),
    }
}

/// Copies one finished temp tree into an existing destination directory without deleting dest-only paths.
async fn merge_directory_tree(
    source_root: &Path,
    dest_root: &Path,
) -> Result<(), DestinationPlaceError> {
    // Re-check the root so placement never merges through a destination symlink.
    ensure_merge_types_compatible(dest_root, true).await?;

    let mut pending = vec![PathBuf::new()];

    while let Some(relative_dir) = pending.pop() {
        let source_dir = source_root.join(&relative_dir);
        let dest_dir = dest_root.join(&relative_dir);

        prepare_merge_directory(&dest_dir).await?;

        let mut entries = tokio::fs::read_dir(&source_dir).await.map_err(|_| {
            DestinationPlaceError::ReadMergeSourceDirectory(source_dir.display().to_string())
        })?;

        while let Some(entry) = entries.next_entry().await.map_err(|_| {
            DestinationPlaceError::ReadMergeSourceEntry(source_dir.display().to_string())
        })? {
            let file_name = entry.file_name();
            let relative_path = relative_dir.join(&file_name);
            let source_path = source_root.join(&relative_path);
            let dest_path = dest_root.join(&relative_path);
            let metadata = entry.metadata().await.map_err(|_| {
                DestinationPlaceError::ReadMergeSourceEntry(source_path.display().to_string())
            })?;

            if metadata.is_dir() {
                // Child preparation happens when the directory is visited so nested symlinks are replaced first.
                pending.push(relative_path);
                continue;
            }

            if !metadata.is_file() {
                return Err(DestinationPlaceError::UnsupportedMergeEntryType(
                    source_path.display().to_string(),
                ));
            }

            prepare_merge_file_destination(&dest_path).await?;

            tokio::fs::copy(&source_path, &dest_path)
                .await
                .map_err(|_| DestinationPlaceError::MergeEntry {
                    from: source_path.display().to_string(),
                    to: dest_path.display().to_string(),
                })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use redoor::commands::CommandErrorKind;

    #[tokio::test]
    async fn merge_rejects_symlink_destination_root() {
        let temp_dir = TempDir::create();
        let external = temp_dir.path().join("external");
        let dest_link = temp_dir.path().join("dest-link");
        let temp_root = temp_dir.path().join("temp-root");

        tokio::fs::create_dir_all(&external)
            .await
            .expect("external directory should be created");
        tokio::fs::write(external.join("secret.txt"), "external-secret")
            .await
            .expect("external file should be created");
        tokio::fs::symlink(&external, &dest_link)
            .await
            .expect("destination symlink should be created");

        tokio::fs::create_dir_all(&temp_root)
            .await
            .expect("temp root should be created");
        tokio::fs::write(temp_root.join("from-source.txt"), "source-payload")
            .await
            .expect("temp source file should be created");

        let error =
            place_temp_at_destination(&temp_root, &dest_link, CopyExistingMode::Merge, true)
                .await
                .expect_err("merge must reject a destination root symlink");

        assert!(
            matches!(error, DestinationPlaceError::SymlinkDestination(_)),
            "symlink destinations should map to a dedicated invalid-input failure"
        );
        assert_eq!(
            error.kind(),
            CommandErrorKind::InvalidInput,
            "callers should see InvalidInput for symlink merge destinations"
        );
        assert_eq!(
            tokio::fs::read_to_string(external.join("secret.txt"))
                .await
                .expect("external content should remain readable"),
            "external-secret",
            "rejected merge must not write into the symlink target"
        );
        assert!(
            !tokio::fs::try_exists(external.join("from-source.txt"))
                .await
                .expect("external path should stay inspectable"),
            "source files must not appear outside the requested destination"
        );
    }

    #[tokio::test]
    async fn merge_replaces_nested_destination_symlink_instead_of_following_it() {
        let temp_dir = TempDir::create();
        let external = temp_dir.path().join("external");
        let dest_root = temp_dir.path().join("dest-root");
        let temp_root = temp_dir.path().join("temp-root");

        tokio::fs::create_dir_all(&external)
            .await
            .expect("external directory should be created");
        tokio::fs::write(external.join("secret.txt"), "external-secret")
            .await
            .expect("external file should be created");

        tokio::fs::create_dir_all(&dest_root)
            .await
            .expect("destination root should be created");
        tokio::fs::symlink(&external, dest_root.join("linked"))
            .await
            .expect("nested destination symlink should be created");
        tokio::fs::write(dest_root.join("dest-only.txt"), "dest-only")
            .await
            .expect("dest-only file should be created");

        tokio::fs::create_dir_all(temp_root.join("linked"))
            .await
            .expect("temp linked directory should be created");
        tokio::fs::write(temp_root.join("linked").join("file.txt"), "from-source")
            .await
            .expect("temp nested file should be created");

        place_temp_at_destination(&temp_root, &dest_root, CopyExistingMode::Merge, true)
            .await
            .expect("merge should succeed by replacing nested symlinks");

        let linked_meta = tokio::fs::symlink_metadata(dest_root.join("linked"))
            .await
            .expect("merged linked path should exist");
        assert!(
            linked_meta.is_dir() && !linked_meta.is_symlink(),
            "merge must replace the nested symlink with a real directory"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest_root.join("linked").join("file.txt"))
                .await
                .expect("merged nested file should be readable"),
            "from-source",
            "source content should land inside the destination tree"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest_root.join("dest-only.txt"))
                .await
                .expect("dest-only file should survive merge"),
            "dest-only",
            "merge must keep destination-only entries"
        );
        assert_eq!(
            tokio::fs::read_to_string(external.join("secret.txt"))
                .await
                .expect("external content should remain readable"),
            "external-secret",
            "merge must not write through the former nested symlink"
        );
        assert!(
            !tokio::fs::try_exists(external.join("file.txt"))
                .await
                .expect("external path should stay inspectable"),
            "source files must not escape into the old symlink target"
        );
    }

    #[tokio::test]
    async fn merge_replaces_nested_file_symlink_instead_of_writing_through_it() {
        let temp_dir = TempDir::create();
        let external_file = temp_dir.path().join("external-file");
        let dest_root = temp_dir.path().join("dest-root");
        let temp_root = temp_dir.path().join("temp-root");

        tokio::fs::write(&external_file, "external-secret")
            .await
            .expect("external file should be created");
        tokio::fs::create_dir_all(&dest_root)
            .await
            .expect("destination root should be created");
        tokio::fs::symlink(&external_file, dest_root.join("linked.txt"))
            .await
            .expect("nested file symlink should be created");

        tokio::fs::create_dir_all(&temp_root)
            .await
            .expect("temp root should be created");
        tokio::fs::write(temp_root.join("linked.txt"), "from-source")
            .await
            .expect("temp file should be created");

        place_temp_at_destination(&temp_root, &dest_root, CopyExistingMode::Merge, true)
            .await
            .expect("merge should replace nested file symlinks");

        let linked_meta = tokio::fs::symlink_metadata(dest_root.join("linked.txt"))
            .await
            .expect("merged file path should exist");
        assert!(
            linked_meta.is_file() && !linked_meta.is_symlink(),
            "merge must replace the file symlink with a regular file"
        );
        assert_eq!(
            tokio::fs::read_to_string(dest_root.join("linked.txt"))
                .await
                .expect("merged file should be readable"),
            "from-source"
        );
        assert_eq!(
            tokio::fs::read_to_string(&external_file)
                .await
                .expect("external file should remain readable"),
            "external-secret",
            "merge must not truncate or overwrite the old symlink target"
        );
    }

    #[tokio::test]
    async fn override_restores_destination_when_publish_fails() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("override-restore");
        tokio::fs::create_dir(&root)
            .await
            .expect("override test root should be created");
        let dest = root.join("dest");
        let missing_temp = root.join("missing-temp");

        tokio::fs::write(&dest, "original-contents")
            .await
            .expect("destination file should be created");

        let error =
            place_temp_at_destination(&missing_temp, &dest, CopyExistingMode::Override, false)
                .await
                .expect_err("override must fail when the temp path cannot be published");

        assert!(
            matches!(error, DestinationPlaceError::PlaceDestination { .. }),
            "a failed temp publish should surface as a placement error"
        );
        assert_eq!(
            tokio::fs::read_to_string(&dest)
                .await
                .expect("destination should be restored after failed override"),
            "original-contents",
            "failed override must restore the previous destination from its backup"
        );

        let file_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .expect("temp destination name should stay utf-8");
        let mut entries = tokio::fs::read_dir(&root)
            .await
            .expect("temp parent should stay readable");
        while let Some(entry) = entries
            .next_entry()
            .await
            .expect("temp directory iteration should succeed")
        {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !entry_name.contains(&format!(".{file_name}.redoor-override-backup-")),
                "successful restore should not leave override backup siblings behind"
            );
        }
    }

    #[tokio::test]
    async fn override_replaces_destination_and_removes_backup() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("override-success");
        tokio::fs::create_dir(&root)
            .await
            .expect("override test root should be created");
        let dest = root.join("dest");
        let temp = root.join("temp");

        tokio::fs::write(&dest, "old-contents")
            .await
            .expect("destination file should be created");
        tokio::fs::write(&temp, "new-contents")
            .await
            .expect("temp file should be created");

        place_temp_at_destination(&temp, &dest, CopyExistingMode::Override, false)
            .await
            .expect("override should publish the temp file");

        assert_eq!(
            tokio::fs::read_to_string(&dest)
                .await
                .expect("new destination contents should be readable"),
            "new-contents"
        );

        let file_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .expect("temp destination name should stay utf-8");
        let mut entries = tokio::fs::read_dir(&root)
            .await
            .expect("temp parent should stay readable");
        while let Some(entry) = entries
            .next_entry()
            .await
            .expect("temp directory iteration should succeed")
        {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !entry_name.contains(&format!(".{file_name}.redoor-override-backup-")),
                "successful override should delete the temporary backup sibling"
            );
        }
    }

    #[tokio::test]
    async fn check_existing_destination_rejects_merge_onto_symlink() {
        let temp_dir = TempDir::create();
        let external = temp_dir.path().join("external");
        let dest_link = temp_dir.path().join("dest-link");

        tokio::fs::create_dir_all(&external)
            .await
            .expect("external directory should be created");
        tokio::fs::symlink(&external, &dest_link)
            .await
            .expect("destination symlink should be created");

        let error = check_existing_destination(&dest_link, CopyExistingMode::Merge, true)
            .await
            .expect_err("preflight merge checks should reject symlink destinations");

        assert!(
            matches!(error, DestinationPlaceError::SymlinkDestination(_)),
            "preflight should use the symlink-destination error"
        );
    }
}
