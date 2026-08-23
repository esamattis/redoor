use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

/// One 512-byte tar record; headers, padding, and the two end blocks are all this size.
const TAR_BLOCK_SIZE: u64 = 512;
/// GNU ustar name field length; longer member names need an extra long-link record.
const TAR_NAME_FIELD_LEN: usize = 100;

/// Carries both user-facing content bytes and transfer-specific archive bytes from one walk.
#[derive(Debug, PartialEq, Eq)]
pub struct DirectoryMeasurement {
    pub content_bytes: u64,
    pub tar_bytes: u64,
    pub tar_complete: bool,
    pub errors: Vec<DirectoryMeasurementError>,
}

/// Identifies one skipped entry without preventing useful totals for the rest of the tree.
#[derive(Debug, PartialEq, Eq)]
pub struct DirectoryMeasurementError {
    pub path: String,
    pub error: String,
}

/// Names the optional top-level archive member so downloads keep the directory name after extraction.
pub fn directory_archive_root(source_path: &Path, include_root: bool) -> Option<PathBuf> {
    include_root.then(|| {
        source_path
            .file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("archive"))
    })
}

/// Maps a source path to the same member path used by the tar writer and size estimator.
pub fn archive_member_path(
    source_root: &Path,
    entry_path: &Path,
    archive_root: Option<&Path>,
) -> Result<PathBuf> {
    let source_relative_path = entry_path
        .strip_prefix(source_root)
        .with_context(|| {
            format!(
                "Failed to strip source prefix {} from {}",
                source_root.display(),
                entry_path.display()
            )
        })?
        .to_path_buf();
    Ok(match archive_root {
        Some(archive_root) => archive_root.join(source_relative_path),
        None => source_relative_path,
    })
}

/// Encodes a member path the same way the tar crate writes it on this platform.
fn tar_path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().replace('\\', "/").into_bytes()
    }
}

/// Rounds a payload up to the next tar block so predicted size matches `tar::Builder`.
fn tar_padded_len(len: u64) -> u64 {
    len.div_ceil(TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
}

/// Counts one archive member as headers plus padded file bytes, including GNU long names.
fn tar_member_encoded_len(archive_path: &Path, content_len: u64) -> u64 {
    let path_bytes = tar_path_bytes(archive_path);
    let long_name_len = if path_bytes.len() >= TAR_NAME_FIELD_LEN {
        TAR_BLOCK_SIZE + tar_padded_len(path_bytes.len() as u64 + 1)
    } else {
        0
    };
    long_name_len + TAR_BLOCK_SIZE + tar_padded_len(content_len)
}

/// Walks metadata once so directory details and tar transfers can use their respective totals.
pub async fn measure_directory(
    source_path: &Path,
    include_root: bool,
    cancel: &watch::Receiver<bool>,
) -> Result<Option<DirectoryMeasurement>> {
    if *cancel.borrow() {
        return Ok(None);
    }

    let archive_root = directory_archive_root(source_path, include_root);
    let mut content_bytes = 0u64;
    let mut tar_bytes = 0u64;
    let mut tar_complete = true;
    let mut errors = Vec::new();
    if let Some(root) = archive_root.as_deref() {
        tar_bytes = tar_bytes.saturating_add(tar_member_encoded_len(root, 0));
    }

    let mut pending = vec![source_path.to_path_buf()];
    while let Some(current_path) = pending.pop() {
        if *cancel.borrow() {
            return Ok(None);
        }

        let mut collected = Vec::new();
        let mut reader = match tokio::fs::read_dir(&current_path).await {
            Ok(reader) => reader,
            Err(error) => {
                errors.push(DirectoryMeasurementError {
                    path: current_path.display().to_string(),
                    error: format!("Failed to read directory: {error}"),
                });
                continue;
            }
        };
        loop {
            match reader.next_entry().await {
                Ok(Some(entry)) => collected.push(entry),
                Ok(None) => break,
                Err(error) => {
                    errors.push(DirectoryMeasurementError {
                        path: current_path.display().to_string(),
                        error: format!("Failed to read directory entry: {error}"),
                    });
                    break;
                }
            }
        }
        collected.sort_by_key(|entry| entry.file_name());

        for entry in collected {
            if *cancel.borrow() {
                return Ok(None);
            }

            let entry_path = entry.path();
            let archive_path =
                match archive_member_path(source_path, &entry_path, archive_root.as_deref()) {
                    Ok(path) => path,
                    Err(error) => {
                        errors.push(DirectoryMeasurementError {
                            path: entry_path.display().to_string(),
                            error: error.to_string(),
                        });
                        continue;
                    }
                };
            let metadata = match tokio::fs::symlink_metadata(&entry_path).await {
                Ok(metadata) => metadata,
                Err(error) => {
                    errors.push(DirectoryMeasurementError {
                        path: entry_path.display().to_string(),
                        error: format!("Failed to read entry metadata: {error}"),
                    });
                    continue;
                }
            };

            if metadata.is_dir() {
                tar_bytes = tar_bytes.saturating_add(tar_member_encoded_len(&archive_path, 0));
                pending.push(entry_path);
            } else if metadata.is_file() {
                content_bytes = content_bytes.saturating_add(metadata.len());
                tar_bytes =
                    tar_bytes.saturating_add(tar_member_encoded_len(&archive_path, metadata.len()));
            } else {
                // Logical size ignores symlinks and special entries to avoid cycles and double counting.
                // The tar writer rejects them, so its estimate must not be published as complete.
                tar_complete = false;
            }
        }
    }

    Ok(Some(DirectoryMeasurement {
        content_bytes,
        tar_bytes: tar_bytes.saturating_add(TAR_BLOCK_SIZE * 2),
        tar_complete,
        errors,
    }))
}
