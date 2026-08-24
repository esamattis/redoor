use std::path::{Path, PathBuf};

/// Describes a platform rename outcome without imposing copy or cleanup policy on callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicRenameOutcome {
    Renamed,
    DestinationExists,
    Missing,
    CrossDevice,
    Unsupported,
}

/// Atomically moves an entry only when the destination name is still unused.
pub async fn rename_without_replacement(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> std::io::Result<AtomicRenameOutcome> {
    rename_with_mode(
        source.as_ref().to_path_buf(),
        destination.as_ref().to_path_buf(),
        RenameMode::NoReplace,
    )
    .await
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
