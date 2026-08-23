use std::path::{Path, PathBuf};

/// Owns an isolated filesystem root so test fixtures are removed even after a panic.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Creates the directory synchronously so ownership begins before a test can create fixtures.
    pub(crate) fn create() -> Self {
        let path = std::env::temp_dir().join(format!(
            "redoor-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).expect("temporary test directory should be created");
        Self { path }
    }

    /// Returns the owned root without allowing callers to replace its cleanup target.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    /// Uses synchronous I/O because destructors cannot await panic-safe fixture cleanup.
    fn drop(&mut self) {
        if let Err(error) = remove_tree(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            let message = format!(
                "failed to remove temporary test directory {}: {error}",
                self.path.display()
            );
            if std::thread::panicking() {
                eprintln!("{message}");
            } else {
                panic!("{message}");
            }
        }
    }
}

/// Removes an owned tree without following symlinks or calling an unguarded recursive remover.
fn remove_tree(path: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_dir() {
        return std::fs::remove_file(path);
    }

    make_directory_accessible(path, &metadata)?;
    for entry in std::fs::read_dir(path)? {
        remove_tree(&entry?.path())?;
    }
    std::fs::remove_dir(path)
}

/// Restores owner access so permission tests cannot prevent their fixture from being reclaimed.
#[cfg(unix)]
fn make_directory_accessible(path: &Path, metadata: &std::fs::Metadata) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = metadata.permissions().mode();
    if mode & 0o700 != 0o700 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o700))?;
    }
    Ok(())
}

/// Leaves ordinary directory permissions unchanged on platforms without Unix modes.
#[cfg(not(unix))]
fn make_directory_accessible(_path: &Path, _metadata: &std::fs::Metadata) -> std::io::Result<()> {
    Ok(())
}
