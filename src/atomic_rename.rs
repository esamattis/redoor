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
pub async fn rename_no_replace(
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

#[cfg(target_os = "linux")]
/// Uses a held destination directory so path replacement cannot redirect publication.
pub async fn rename_no_replace_at(
    source: impl AsRef<Path>,
    destination_directory: std::fs::File,
    destination_name: std::ffi::OsString,
) -> std::io::Result<AtomicRenameOutcome> {
    let source = source.as_ref().to_path_buf();
    tokio::task::spawn_blocking(move || {
        rename_no_replace_at_blocking(source, destination_directory, destination_name)
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Atomically swaps two existing entries so callers can implement replacement cleanup safely.
pub async fn rename_exchange(
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
/// Calls renameat2 relative to an already-open destination directory descriptor.
fn rename_no_replace_at_blocking(
    source: PathBuf,
    destination_directory: std::fs::File,
    destination_name: std::ffi::OsString,
) -> std::io::Result<AtomicRenameOutcome> {
    use std::{
        ffi::CString,
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
    };

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let destination_name = CString::new(destination_name.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: both path pointers are live NUL-terminated CStrings, the directory descriptor stays
    // open for the call, and renameat2 retains none of these arguments.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            destination_directory.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE,
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
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
        #[cfg(target_os = "linux")]
        Some(libc::ENOSYS | libc::EINVAL) => Ok(AtomicRenameOutcome::Unsupported),
        #[cfg(target_os = "macos")]
        Some(libc::ENOTSUP | libc::EINVAL) => Ok(AtomicRenameOutcome::Unsupported),
        _ => Err(error),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
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

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn no_replace_preserves_an_existing_destination() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("source");
        let destination = temp_dir.path().join("destination");
        tokio::fs::write(&source, "source").await.unwrap();
        tokio::fs::write(&destination, "destination").await.unwrap();

        let outcome = rename_no_replace(&source, &destination).await.unwrap();

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

        let outcome = rename_exchange(&source, &destination).await.unwrap();

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

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn held_destination_directory_prevents_path_redirection() {
        let temp_dir = TempDir::create();
        let source = temp_dir.path().join("source");
        let destination_parent = temp_dir.path().join("destination-parent");
        let moved_parent = temp_dir.path().join("moved-parent");
        let redirect_target = temp_dir.path().join("redirect-target");
        tokio::fs::write(&source, "source").await.unwrap();
        tokio::fs::create_dir(&destination_parent).await.unwrap();
        tokio::fs::create_dir(&redirect_target).await.unwrap();
        let directory = tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&destination_parent)
            .await
            .unwrap()
            .into_std()
            .await;
        tokio::fs::rename(&destination_parent, &moved_parent)
            .await
            .unwrap();
        tokio::fs::symlink(&redirect_target, &destination_parent)
            .await
            .unwrap();

        let outcome =
            rename_no_replace_at(&source, directory, std::ffi::OsString::from("restored"))
                .await
                .unwrap();

        // Publishing through the descriptor must target the directory that was actually opened.
        assert_eq!(outcome, AtomicRenameOutcome::Renamed);
        assert_eq!(
            tokio::fs::read_to_string(moved_parent.join("restored"))
                .await
                .unwrap(),
            "source"
        );
        // Replacing the pathname with a symlink must not redirect the restored payload.
        assert!(
            !tokio::fs::try_exists(redirect_target.join("restored"))
                .await
                .unwrap()
        );
    }
}
