use redoor::commands::CopyExistingMode;
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
    #[error("Failed to remove existing destination: {0}")]
    RemoveExistingDestination(#[source] std::io::Error),
    #[error("Failed to create destination directory: {0}")]
    CreateDestinationDirectory(String),
    #[error("Failed to merge directory entry from {from} to {to}")]
    MergeEntry { from: String, to: String },
    #[error("Failed to place destination from {from} to {to}")]
    PlaceDestination { from: String, to: String },
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
            | Self::RemoveExistingDestination(error) => {
                redoor::commands::CommandErrorKind::from_io_error(error)
            }
            Self::AlreadyExists(_) => redoor::commands::CommandErrorKind::AlreadyExists,
            Self::TypeMismatch { .. } | Self::UnsupportedMergeEntryType(_) => {
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
    match tokio::fs::try_exists(path).await {
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
        Err(error) => Err(DestinationPlaceError::CheckDestinationPath(error)),
    }
}

/// Ensures merge only runs when source and destination share the same entry kind.
async fn ensure_merge_types_compatible(
    path: &Path,
    source_is_directory: bool,
) -> Result<(), DestinationPlaceError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(DestinationPlaceError::InspectDestinationPath)?;
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

/// Removes one existing file or directory so override can publish a replacement path.
async fn remove_existing_path(path: &Path) -> Result<(), DestinationPlaceError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(DestinationPlaceError::InspectDestinationPath)?;
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(DestinationPlaceError::RemoveExistingDestination)
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(DestinationPlaceError::RemoveExistingDestination)
    }
}

/// Publishes completed temp content to the final path according to the conflict policy.
pub(crate) async fn place_temp_at_destination(
    temp_path: &Path,
    final_path: &Path,
    on_existing: CopyExistingMode,
    content_is_directory: bool,
) -> Result<(), DestinationPlaceError> {
    let exists = match tokio::fs::try_exists(final_path).await {
        Ok(exists) => exists,
        Err(error) => return Err(DestinationPlaceError::CheckDestinationPath(error)),
    };

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
            remove_existing_path(final_path).await?;
            tokio::fs::rename(temp_path, final_path).await.map_err(|_| {
                DestinationPlaceError::PlaceDestination {
                    from: temp_path.display().to_string(),
                    to: final_path.display().to_string(),
                }
            })
        }
        CopyExistingMode::Merge => {
            ensure_merge_types_compatible(final_path, content_is_directory).await?;
            if content_is_directory {
                merge_directory_tree(temp_path, final_path).await?;
                let _ = tokio::fs::remove_dir_all(temp_path).await;
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

/// Copies one finished temp tree into an existing destination directory without deleting dest-only paths.
async fn merge_directory_tree(
    source_root: &Path,
    dest_root: &Path,
) -> Result<(), DestinationPlaceError> {
    let mut pending = vec![PathBuf::new()];

    while let Some(relative_dir) = pending.pop() {
        let source_dir = source_root.join(&relative_dir);
        let dest_dir = dest_root.join(&relative_dir);

        tokio::fs::create_dir_all(&dest_dir).await.map_err(|_| {
            DestinationPlaceError::CreateDestinationDirectory(dest_dir.display().to_string())
        })?;

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
                if tokio::fs::try_exists(&dest_path)
                    .await
                    .map_err(DestinationPlaceError::CheckDestinationPath)?
                {
                    let dest_metadata = tokio::fs::symlink_metadata(&dest_path)
                        .await
                        .map_err(DestinationPlaceError::InspectDestinationPath)?;
                    if !dest_metadata.is_dir() {
                        remove_existing_path(&dest_path).await?;
                    }
                }
                pending.push(relative_path);
                continue;
            }

            if !metadata.is_file() {
                return Err(DestinationPlaceError::UnsupportedMergeEntryType(
                    source_path.display().to_string(),
                ));
            }

            if tokio::fs::try_exists(&dest_path)
                .await
                .map_err(DestinationPlaceError::CheckDestinationPath)?
            {
                let dest_metadata = tokio::fs::symlink_metadata(&dest_path)
                    .await
                    .map_err(DestinationPlaceError::InspectDestinationPath)?;
                if dest_metadata.is_dir() {
                    remove_existing_path(&dest_path).await?;
                }
            }

            if let Some(parent) = dest_path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|_| {
                    DestinationPlaceError::CreateDestinationDirectory(parent.display().to_string())
                })?;
            }

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
