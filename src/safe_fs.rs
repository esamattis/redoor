use std::{
    io,
    path::{Component, Path, PathBuf},
    time::Duration,
};

static EFFECTIVE_USER_HOME: tokio::sync::OnceCell<PathBuf> = tokio::sync::OnceCell::const_new();

/// Leaves a generous ceiling for large owned cleanup trees while preventing permanent stalls.
const RECURSIVE_REMOVE_TIMEOUT: Duration = Duration::from_secs(300);

/// Recursively removes a directory only after excluding filesystem root and the effective user's home.
pub async fn safe_rm_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref().to_path_buf();
    tokio::time::timeout(RECURSIVE_REMOVE_TIMEOUT, remove_validated_tree(&path))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "recursive removal exceeded {} seconds and may be partial: {}",
                    RECURSIVE_REMOVE_TIMEOUT.as_secs(),
                    path.display()
                ),
            )
        })?
}

/// Validates the target before deleting it through cancellable, entry-by-entry filesystem calls.
async fn remove_validated_tree(path: &Path) -> io::Result<()> {
    validate_recursive_remove(path).await?;

    if tokio::fs::symlink_metadata(path)
        .await?
        .file_type()
        .is_symlink()
    {
        return tokio::fs::remove_file(path).await;
    }

    remove_tree_iteratively(path).await
}

/// Applies recursive deletion guards before callers rename or remove a protected path.
pub async fn validate_recursive_remove(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let absolute_path = absolute_lexical_path(path)?;
    let home = effective_user_home().await?;
    let absolute_home = absolute_lexical_path(&home)?;

    refuse_protected_path(&absolute_path, &absolute_home)?;

    let canonical_path = match tokio::fs::canonicalize(path).await {
        Ok(path) => Some(path),
        // Missing temp paths must retain remove_dir_all's ordinary NotFound behavior.
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if let Some(canonical_path) = canonical_path {
        let canonical_home = match tokio::fs::canonicalize(&home).await {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => absolute_home,
            Err(error) => return Err(error),
        };
        refuse_protected_path(&canonical_path, &canonical_home)?;
    }
    Ok(())
}

/// Uses an explicit stack so cancellation stops traversal instead of leaving an opaque recursive job running.
async fn remove_tree_iteratively(path: &Path) -> io::Result<()> {
    let mut pending_directories = vec![path.to_path_buf()];
    let mut directories_to_remove = Vec::new();

    while let Some(directory) = pending_directories.pop() {
        directories_to_remove.push(directory.clone());
        let mut entries = tokio::fs::read_dir(&directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_type = entry.file_type().await?;
            if file_type.is_dir() && !file_type.is_symlink() {
                pending_directories.push(entry_path);
            } else {
                tokio::fs::remove_file(entry_path).await?;
            }
        }
    }

    for directory in directories_to_remove.into_iter().rev() {
        tokio::fs::remove_dir(directory).await?;
    }
    Ok(())
}

/// Looks up the effective account off-runtime because NSS-backed user resolution may block.
async fn effective_user_home() -> io::Result<PathBuf> {
    EFFECTIVE_USER_HOME
        .get_or_try_init(|| async {
            let uid = nix::unistd::Uid::effective();
            tokio::task::spawn_blocking(move || nix::unistd::User::from_uid(uid))
                .await
                .map_err(|error| {
                    io::Error::other(format!("failed to join home directory lookup: {error}"))
                })?
                .map_err(|error| {
                    io::Error::other(format!("failed to look up effective user: {error}"))
                })?
                .map(|user| user.dir)
                .ok_or_else(|| {
                    io::Error::other(format!("no system user exists for effective UID {uid}"))
                })
        })
        .await
        .cloned()
}

/// Produces a stable lexical form so aliases such as `/tmp/..` cannot bypass protected-path checks.
fn absolute_lexical_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();

    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }

    Ok(normalized)
}

/// Returns a permission-style error before the caller can reach a protected directory remover.
fn refuse_protected_path(path: &Path, home: &Path) -> io::Result<()> {
    if path.parent().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "refusing to recursively remove filesystem root: {}",
                path.display()
            ),
        ));
    }
    if path == home {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "refusing to recursively remove the current user's home directory: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// Proves lexical root aliases are rejected by validation without calling a remover on root.
    #[test]
    fn refuses_lexical_root_aliases_without_deleting() {
        let root =
            absolute_lexical_path(Path::new("/tmp/../")).expect("root alias should normalize");
        let error = refuse_protected_path(&root, Path::new("/safe-test-home"))
            .expect_err("filesystem root must be refused");

        assert_eq!(
            error.kind(),
            io::ErrorKind::PermissionDenied,
            "root refusal should be exposed as an io permission error"
        );
    }

    /// Proves lexical home aliases are rejected using an inert path rather than the real home.
    #[test]
    fn refuses_lexical_home_aliases_without_deleting() {
        let home = Path::new("/safe-test-home");
        let alias = absolute_lexical_path(Path::new("/safe-test-home/nested/.."))
            .expect("home alias should normalize");
        let error = refuse_protected_path(&alias, home)
            .expect_err("current user's home directory must be refused");

        assert_eq!(
            error.kind(),
            io::ErrorKind::PermissionDenied,
            "home refusal should be exposed as an io permission error"
        );
    }

    /// Proves canonical symlink aliases are rejected while all paths remain inside an inert fixture.
    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_a_symlink_alias_of_home_without_deleting() {
        let temp_dir = TempDir::create();
        let fixture = temp_dir.path().join("symlink-fixture");
        let home = fixture.join("fake-home");
        let alias = fixture.join("home-alias");
        tokio::fs::create_dir_all(&home)
            .await
            .expect("fake home should be created");
        tokio::fs::symlink(&home, &alias)
            .await
            .expect("home alias should be created");
        let canonical_alias = tokio::fs::canonicalize(&alias)
            .await
            .expect("home alias should canonicalize");
        let canonical_home = tokio::fs::canonicalize(&home)
            .await
            .expect("fake home should canonicalize");

        let error = refuse_protected_path(&canonical_alias, &canonical_home)
            .expect_err("a symlink resolving to home must be refused");
        assert_eq!(
            error.kind(),
            io::ErrorKind::PermissionDenied,
            "canonical home refusal should be exposed as an io permission error"
        );
        assert!(
            tokio::fs::try_exists(&home)
                .await
                .expect("fake home should remain checkable"),
            "refusal must leave the protected directory untouched"
        );

        safe_rm_all(&fixture)
            .await
            .expect("the inert symlink fixture should be removable");
    }

    /// Proves the public utility still removes ordinary trees after completing its safety checks.
    #[tokio::test]
    async fn removes_an_ordinary_directory_tree() {
        let temp_dir = TempDir::create();
        let directory = temp_dir.path().join("ordinary-tree");
        tokio::fs::create_dir_all(directory.join("nested"))
            .await
            .expect("test tree should be created");
        tokio::fs::write(directory.join("nested/file"), b"safe to remove")
            .await
            .expect("test file should be created");

        safe_rm_all(&directory)
            .await
            .expect("ordinary test tree should be removed");

        assert!(
            !tokio::fs::try_exists(&directory)
                .await
                .expect("removed directory should be checkable"),
            "safe_rm_all should remove the complete ordinary tree"
        );
    }

    /// Proves recursive cleanup unlinks directory symlinks without deleting their external targets.
    #[cfg(unix)]
    #[tokio::test]
    async fn does_not_follow_directory_symlinks() {
        let temp_dir = TempDir::create();
        let directory = temp_dir.path().join("tree-with-link");
        let external = temp_dir.path().join("external");
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("tree containing the link should be created");
        tokio::fs::create_dir_all(&external)
            .await
            .expect("external target should be created");
        tokio::fs::write(external.join("must-remain"), b"external")
            .await
            .expect("external target content should be created");
        tokio::fs::symlink(&external, directory.join("external-link"))
            .await
            .expect("directory symlink should be created");

        safe_rm_all(&directory)
            .await
            .expect("tree containing a directory symlink should be removable");

        assert!(
            tokio::fs::try_exists(external.join("must-remain"))
                .await
                .expect("external target content should remain checkable"),
            "recursive cleanup must not follow directory symlinks"
        );
    }
}
