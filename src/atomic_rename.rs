use crate::{Level, log};
use std::path::{Path, PathBuf};

/// Describes a platform rename outcome without imposing copy or cleanup policy on callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicRenameOutcome {
    /// The source now occupies the destination name and the original source name is gone.
    Renamed,
    /// The destination name was occupied, so neither the source nor destination was changed.
    DestinationExists,
    /// The source or one of the parent directories disappeared before the move could complete.
    Missing,
    /// The source and destination are on different filesystems and cannot be renamed directly.
    CrossDevice,
    /// The platform or filesystem cannot perform the requested flagged rename operation.
    Unsupported,
}

/// Distinguishes replacement publication from exchange so callers know where cleanup is required.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplacementRenameOutcome {
    /// The source replaced the destination and the original source name is gone.
    Renamed,
    /// The entries swapped names, leaving the displaced destination at the original source path.
    Exchanged,
    /// The source and destination are on different filesystems and require a copy-based transfer.
    CrossDevice,
    /// Ordinary replacement rename cannot replace the destination entry type with the source type.
    Incompatible,
}

/// Moves an entry only when the destination name is unused using the strongest available primitive.
///
/// Filesystems such as NFS can reject atomic rename flags while supporting ordinary metadata
/// operations. In that case regular files first retain atomic no-replacement publication through a
/// hard link, while directories and filesystems without hard links use checked ordinary rename.
pub async fn rename_without_replacement(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> std::io::Result<AtomicRenameOutcome> {
    let source = source.as_ref().to_path_buf();
    let destination = destination.as_ref().to_path_buf();
    let outcome =
        rename_with_mode(source.clone(), destination.clone(), RenameMode::NoReplace).await?;
    if outcome != AtomicRenameOutcome::Unsupported {
        return Ok(outcome);
    }

    log!(
        Level::Debug,
        "Atomic no-replace rename unsupported; using shared filesystem fallback: source={}, destination={}",
        source.display(),
        destination.display()
    );
    rename_without_replacement_fallback(&source, &destination).await
}

/// Preserves no-replacement semantics where possible when a filesystem rejects rename flags.
///
/// Regular files use atomic hard-link creation followed by source unlinking when available. Other
/// entries and filesystems without hard links use a destination check followed by ordinary rename;
/// that path has a narrow replacement race if an unrelated process creates the destination between
/// the two operations.
async fn rename_without_replacement_fallback(
    source: &Path,
    destination: &Path,
) -> std::io::Result<AtomicRenameOutcome> {
    let source_metadata = match tokio::fs::symlink_metadata(source).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AtomicRenameOutcome::Missing);
        }
        Err(error) => return Err(error),
    };

    if source_metadata.is_file() {
        return rename_file_without_replacement(source, destination).await;
    }
    rename_entry_after_destination_check(source, destination).await
}

/// Uses hard-link creation as an atomic no-replacement publication for regular files.
async fn rename_file_without_replacement(
    source: &Path,
    destination: &Path,
) -> std::io::Result<AtomicRenameOutcome> {
    match tokio::fs::hard_link(source, destination).await {
        Ok(()) => {}
        Err(error) if hard_link_is_unsupported(&error) => {
            log!(
                Level::Debug,
                "Hard-link no-replace fallback unsupported; using checked ordinary rename: source={}, destination={}, error={}",
                source.display(),
                destination.display(),
                error
            );
            return rename_entry_after_destination_check(source, destination).await;
        }
        Err(error) => return classify_fallback_error(error),
    }
    tokio::fs::remove_file(source).await?;
    log!(
        Level::Debug,
        "Shared no-replace fallback linked and unlinked file: source={}, destination={}",
        source.display(),
        destination.display()
    );
    Ok(AtomicRenameOutcome::Renamed)
}

/// Identifies filesystems that can rename regular files but cannot create hard links.
fn hard_link_is_unsupported(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::EPERM | libc::ENOSYS | libc::EOPNOTSUPP)
    )
}

/// Uses ordinary rename only after verifying that a non-file destination is currently absent.
async fn rename_entry_after_destination_check(
    source: &Path,
    destination: &Path,
) -> std::io::Result<AtomicRenameOutcome> {
    match tokio::fs::symlink_metadata(destination).await {
        Ok(_) => return Ok(AtomicRenameOutcome::DestinationExists),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    match tokio::fs::rename(source, destination).await {
        Ok(()) => {
            log!(
                Level::Debug,
                "Shared no-replace fallback used checked ordinary rename: source={}, destination={}",
                source.display(),
                destination.display()
            );
            Ok(AtomicRenameOutcome::Renamed)
        }
        Err(error) => classify_fallback_error(error),
    }
}

/// Converts fallback operation errors into the same outcomes as platform rename primitives.
fn classify_fallback_error(error: std::io::Error) -> std::io::Result<AtomicRenameOutcome> {
    match error.raw_os_error() {
        Some(libc::EEXIST | libc::ENOTEMPTY | libc::EISDIR | libc::ENOTDIR) => {
            Ok(AtomicRenameOutcome::DestinationExists)
        }
        Some(libc::ENOENT) => Ok(AtomicRenameOutcome::Missing),
        Some(libc::EXDEV) => Ok(AtomicRenameOutcome::CrossDevice),
        _ => Err(error),
    }
}

/// Replaces a destination through exchange when possible and ordinary rename when flags are unsupported.
///
/// The ordinary rename fallback retains fast server-side NFS moves. Callers receive `Exchanged`
/// only when the displaced destination still occupies the source name and therefore needs cleanup.
pub async fn rename_with_replacement(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    destination_exists: bool,
) -> std::io::Result<ReplacementRenameOutcome> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    if destination_exists {
        match exchange_existing_paths(source, destination).await? {
            AtomicRenameOutcome::Renamed => return Ok(ReplacementRenameOutcome::Exchanged),
            AtomicRenameOutcome::CrossDevice => {
                return Ok(ReplacementRenameOutcome::CrossDevice);
            }
            AtomicRenameOutcome::Missing => {}
            AtomicRenameOutcome::Unsupported | AtomicRenameOutcome::DestinationExists => {
                log!(
                    Level::Debug,
                    "Atomic exchange unsupported; using shared replacement rename fallback: source={}, destination={}",
                    source.display(),
                    destination.display()
                );
            }
        }
    }

    match tokio::fs::rename(source, destination).await {
        Ok(()) => Ok(ReplacementRenameOutcome::Renamed),
        Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
            Ok(ReplacementRenameOutcome::CrossDevice)
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EEXIST | libc::ENOTEMPTY | libc::EISDIR | libc::ENOTDIR)
            ) =>
        {
            Ok(ReplacementRenameOutcome::Incompatible)
        }
        Err(error) => Err(error),
    }
}

/// Atomically swaps two existing entries so callers can implement replacement cleanup safely.
pub async fn exchange_existing_paths(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> std::io::Result<AtomicRenameOutcome> {
    rename_with_mode(
        source.as_ref().to_path_buf(),
        destination.as_ref().to_path_buf(),
        RenameMode::Exchange,
    )
    .await
}

#[derive(Clone, Copy)]
enum RenameMode {
    NoReplace,
    Exchange,
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
/// Moves path conversion and the synchronous platform call off Tokio's worker threads.
async fn rename_with_mode(
    source: PathBuf,
    destination: PathBuf,
    mode: RenameMode,
) -> std::io::Result<AtomicRenameOutcome> {
    tokio::task::spawn_blocking(move || rename_with_mode_blocking(source, destination, mode))
        .await
        .map_err(std::io::Error::other)?
}

#[cfg(any(target_os = "linux", target_os = "android"))]
/// Uses the syscall directly because musl does not expose glibc's `renameat2` wrapper.
fn rename_with_mode_blocking(
    source: PathBuf,
    destination: PathBuf,
    mode: RenameMode,
) -> std::io::Result<AtomicRenameOutcome> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: both pointers reference live NUL-terminated CStrings, all integer values are valid
    // renameat2 arguments, and the syscall retains no pointers.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            match mode {
                RenameMode::NoReplace => libc::RENAME_NOREPLACE,
                RenameMode::Exchange => libc::RENAME_EXCHANGE,
            },
        )
    };
    classify_result(result)
}

#[cfg(target_os = "macos")]
/// Uses Darwin's exclusive and swap rename modes without adding replacement policy.
fn rename_with_mode_blocking(
    source: PathBuf,
    destination: PathBuf,
    mode: RenameMode,
) -> std::io::Result<AtomicRenameOutcome> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: both pointers reference live NUL-terminated CStrings and renamex_np retains neither.
    let result = unsafe {
        libc::renamex_np(
            source.as_ptr(),
            destination.as_ptr(),
            match mode {
                RenameMode::NoReplace => libc::RENAME_EXCL,
                RenameMode::Exchange => libc::RENAME_SWAP,
            },
        )
    };
    classify_result(result as libc::c_long)
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
/// Converts platform errno values into semantic outcomes shared by move and trash.
fn classify_result(result: libc::c_long) -> std::io::Result<AtomicRenameOutcome> {
    if result == 0 {
        return Ok(AtomicRenameOutcome::Renamed);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EEXIST) => Ok(AtomicRenameOutcome::DestinationExists),
        Some(libc::ENOENT) => Ok(AtomicRenameOutcome::Missing),
        Some(libc::EXDEV) => Ok(AtomicRenameOutcome::CrossDevice),
        #[cfg(any(target_os = "linux", target_os = "android"))]
        Some(libc::ENOSYS | libc::EINVAL) => Ok(AtomicRenameOutcome::Unsupported),
        #[cfg(target_os = "macos")]
        Some(libc::ENOTSUP | libc::EINVAL) => Ok(AtomicRenameOutcome::Unsupported),
        _ => Err(error),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
/// Reports unsupported rather than silently degrading atomic no-replace semantics.
async fn rename_with_mode(
    _source: PathBuf,
    _destination: PathBuf,
    _mode: RenameMode,
) -> std::io::Result<AtomicRenameOutcome> {
    Ok(AtomicRenameOutcome::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[tokio::test]
    async fn no_replace_preserves_an_existing_destination() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("source");
        let destination = temp_dir.path().join("destination");
        tokio::fs::write(&source, "source").await.unwrap();
        tokio::fs::write(&destination, "destination").await.unwrap();

        let outcome = rename_without_replacement(&source, &destination)
            .await
            .unwrap();

        assert_eq!(outcome, AtomicRenameOutcome::DestinationExists);
        assert_eq!(tokio::fs::read_to_string(source).await.unwrap(), "source");
        assert_eq!(
            tokio::fs::read_to_string(destination).await.unwrap(),
            "destination"
        );
    }

    #[tokio::test]
    async fn fallback_moves_file_with_atomic_destination_creation() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("fallback-file-source");
        let destination = temp_dir.path().join("fallback-file-destination");
        tokio::fs::write(&source, "source").await.unwrap();
        let source_metadata = tokio::fs::symlink_metadata(&source).await.unwrap();

        let outcome = rename_without_replacement_fallback(&source, &destination)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            AtomicRenameOutcome::Renamed,
            "the regular-file fallback should publish a missing destination"
        );
        assert!(
            !tokio::fs::try_exists(&source).await.unwrap(),
            "hard-link publication must remove the old source name"
        );
        assert_eq!(
            tokio::fs::symlink_metadata(&destination)
                .await
                .unwrap()
                .len(),
            source_metadata.len(),
            "the destination must reference the completed source inode contents"
        );
    }

    #[tokio::test]
    async fn fallback_file_collision_preserves_both_entries() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("fallback-file-source");
        let destination = temp_dir.path().join("fallback-file-destination");
        tokio::fs::write(&source, "source").await.unwrap();
        tokio::fs::write(&destination, "destination").await.unwrap();

        let outcome = rename_without_replacement_fallback(&source, &destination)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            AtomicRenameOutcome::DestinationExists,
            "atomic hard-link creation must classify a destination collision"
        );
        assert_eq!(
            tokio::fs::read_to_string(&source).await.unwrap(),
            "source",
            "a rejected file fallback must preserve its source"
        );
        assert_eq!(
            tokio::fs::read_to_string(&destination).await.unwrap(),
            "destination",
            "a rejected file fallback must preserve competing destination data"
        );
    }

    #[test]
    fn unsupported_hard_links_select_checked_rename() {
        assert!(
            hard_link_is_unsupported(&std::io::Error::from_raw_os_error(libc::EOPNOTSUPP)),
            "filesystems without hard-link support must continue to the ordinary rename fallback"
        );
        assert!(
            !hard_link_is_unsupported(&std::io::Error::from_raw_os_error(libc::EACCES)),
            "permission failures must remain errors instead of weakening publication semantics"
        );
    }

    #[tokio::test]
    async fn fallback_moves_directory_with_checked_rename() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("fallback-directory-source");
        let destination = temp_dir.path().join("fallback-directory-destination");
        tokio::fs::create_dir(&source).await.unwrap();
        tokio::fs::write(source.join("child"), "source")
            .await
            .unwrap();

        let outcome = rename_without_replacement_fallback(&source, &destination)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            AtomicRenameOutcome::Renamed,
            "the directory fallback should rename an unoccupied entry"
        );
        assert!(
            !tokio::fs::try_exists(&source).await.unwrap(),
            "ordinary rename must remove the directory's source name"
        );
        assert_eq!(
            tokio::fs::read_to_string(destination.join("child"))
                .await
                .unwrap(),
            "source",
            "checked rename must preserve the complete directory tree"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fallback_moves_symlink_without_dereferencing_it() {
        let temp_dir = TempDir::create();
        let target = temp_dir.path().join("target");
        let source = temp_dir.path().join("fallback-symlink-source");
        let destination = temp_dir.path().join("fallback-symlink-destination");
        tokio::fs::write(&target, "target").await.unwrap();
        tokio::fs::symlink(&target, &source).await.unwrap();

        let outcome = rename_without_replacement_fallback(&source, &destination)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            AtomicRenameOutcome::Renamed,
            "the symlink fallback should rename the link entry"
        );
        assert!(
            tokio::fs::symlink_metadata(&destination)
                .await
                .unwrap()
                .file_type()
                .is_symlink(),
            "the fallback must not replace a symlink with its target"
        );
        assert_eq!(
            tokio::fs::read_link(&destination).await.unwrap(),
            target,
            "the renamed symlink must retain its original target"
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn exchange_supports_different_entry_types() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("source");
        let destination = temp_dir.path().join("destination");
        tokio::fs::create_dir(&source).await.unwrap();
        tokio::fs::write(source.join("child"), "source")
            .await
            .unwrap();
        tokio::fs::write(&destination, "destination").await.unwrap();

        let outcome = exchange_existing_paths(&source, &destination)
            .await
            .unwrap();

        assert_eq!(outcome, AtomicRenameOutcome::Renamed);
        assert_eq!(
            tokio::fs::read_to_string(destination.join("child"))
                .await
                .unwrap(),
            "source"
        );
        assert_eq!(
            tokio::fs::read_to_string(source).await.unwrap(),
            "destination"
        );
    }
}
