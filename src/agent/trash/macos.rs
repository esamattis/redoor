use super::TrashError;
use objc2::rc::autoreleasepool;
use objc2_foundation::{
    NSCocoaErrorDomain, NSFileManager, NSFileNoSuchFileError, NSFileReadInvalidFileNameError,
    NSFileReadNoPermissionError, NSFileReadNoSuchFileError, NSFileWriteFileExistsError,
    NSFileWriteInvalidFileNameError, NSFileWriteNoPermissionError, NSURL,
};
use redoor::commands::CommandErrorKind;
use std::path::{Path, PathBuf};

/// Moves one entry with Foundation so macOS selects the correct volume-local Trash.
pub(super) async fn trash(path: PathBuf) -> Result<(), TrashError> {
    trash_with_destination(path).await.map(|_| ())
}

/// Retains Foundation's resulting URL internally so tests can clean the exact native item.
async fn trash_with_destination(path: PathBuf) -> Result<Option<PathBuf>, TrashError> {
    let source = normalized_existing_entry(&path).await?;
    tokio::fs::symlink_metadata(&source)
        .await
        .map_err(|error| TrashError::io("Failed to inspect trash source", error))?;
    tokio::task::spawn_blocking(move || {
        autoreleasepool(|_| {
            let url = NSURL::from_file_path(&source).ok_or_else(|| {
                TrashError::new(
                    CommandErrorKind::InvalidInput,
                    "Trash source cannot be represented as a macOS file URL",
                )
            })?;
            let manager = NSFileManager::defaultManager();
            let mut resulting_url = None;
            manager
                .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting_url))
                .map_err(native_error)?;
            Ok(resulting_url.and_then(|url| url.to_file_path()))
        })
    })
    .await
    .map_err(|error| {
        TrashError::new(
            CommandErrorKind::Internal,
            format!("macOS trash task failed: {error}"),
        )
    })?
}

/// Canonicalizes only the parent so moving a symlink never follows its target.
async fn normalized_existing_entry(path: &Path) -> Result<PathBuf, TrashError> {
    if !path.is_absolute() || path == Path::new("/") {
        return Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash source must be an absolute non-root path",
        ));
    }
    let name = path.file_name().ok_or_else(|| {
        TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash source has no filename",
        )
    })?;
    let parent = path.parent().ok_or_else(|| {
        TrashError::new(CommandErrorKind::InvalidInput, "Trash source has no parent")
    })?;
    let parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(|error| TrashError::io("Failed to resolve trash source parent", error))?;
    Ok(parent.join(name))
}

/// Converts stable Cocoa file errors while preserving native diagnostics for operators.
fn native_error(error: objc2::rc::Retained<objc2_foundation::NSError>) -> TrashError {
    let code = error.code();
    let domain = error.domain();
    let is_cocoa_error = &*domain == unsafe { NSCocoaErrorDomain };
    let kind =
        if is_cocoa_error && (code == NSFileNoSuchFileError || code == NSFileReadNoSuchFileError) {
            CommandErrorKind::NotFound
        } else if is_cocoa_error
            && (code == NSFileReadNoPermissionError || code == NSFileWriteNoPermissionError)
        {
            CommandErrorKind::PermissionDenied
        } else if is_cocoa_error
            && (code == NSFileReadInvalidFileNameError || code == NSFileWriteInvalidFileNameError)
        {
            CommandErrorKind::InvalidInput
        } else if is_cocoa_error && code == NSFileWriteFileExistsError {
            CommandErrorKind::AlreadyExists
        } else {
            CommandErrorKind::Internal
        };
    TrashError::new(
        kind,
        format!(
            "Failed to move source to macOS Trash: domain={}, code={}, description={}",
            domain,
            code,
            error.localizedDescription()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// Removes exactly the native destination returned by Foundation before assertions run.
    async fn remove_trashed_entry(path: &Path) -> std::io::Result<()> {
        let metadata = tokio::fs::symlink_metadata(path).await?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            redoor::safe_fs::safe_rm_all(path).await
        } else {
            tokio::fs::remove_file(path).await
        }
    }

    #[tokio::test]
    async fn native_trash_moves_a_file_and_returns_its_cleanup_path() {
        let temp_dir = TempDir::create();
        let source = temp_dir
            .path()
            .join(format!("redoor-trash-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&source, b"trash contents").await.unwrap();

        let destination = trash_with_destination(source.clone()).await.unwrap();
        let destination_exists = match destination.as_deref() {
            Some(path) => tokio::fs::try_exists(path).await.unwrap_or(false),
            None => false,
        };
        let source_exists = tokio::fs::try_exists(&source).await.unwrap_or(true);
        let cleanup = match destination.as_deref() {
            Some(path) => remove_trashed_entry(path).await,
            None => Ok(()),
        };

        assert!(!source_exists, "Foundation must remove the original entry");
        assert!(
            destination_exists,
            "Foundation must return the moved entry URL"
        );
        assert!(
            cleanup.is_ok(),
            "the exact native Trash item must be removed"
        );
    }

    #[tokio::test]
    async fn native_trash_moves_populated_directories_and_symlinks_themselves() {
        let temp_dir = TempDir::create();
        let directory = temp_dir.path().join(format!(
            "redoor-trash-directory-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir(&directory).await.unwrap();
        tokio::fs::write(directory.join("child.txt"), b"child contents")
            .await
            .unwrap();

        let directory_destination = trash_with_destination(directory.clone())
            .await
            .unwrap()
            .unwrap();
        let child_contents = tokio::fs::read(directory_destination.join("child.txt")).await;
        let directory_cleanup = remove_trashed_entry(&directory_destination).await;

        assert_eq!(
            child_contents.unwrap(),
            b"child contents",
            "populated directories must arrive intact in native Trash"
        );
        assert!(
            directory_cleanup.is_ok(),
            "the exact trashed directory must be removed"
        );

        let target = temp_dir.path().join("symlink-target");
        let symlink = temp_dir.path().join(format!(
            "redoor-trash-symlink-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&target, b"target contents").await.unwrap();
        tokio::fs::symlink(&target, &symlink).await.unwrap();

        let symlink_destination = trash_with_destination(symlink.clone())
            .await
            .unwrap()
            .unwrap();
        let moved_metadata = tokio::fs::symlink_metadata(&symlink_destination).await;
        let target_exists = tokio::fs::try_exists(&target).await.unwrap_or(false);
        let symlink_cleanup = remove_trashed_entry(&symlink_destination).await;

        assert!(
            moved_metadata.unwrap().file_type().is_symlink(),
            "native Trash must move a symlink instead of following it"
        );
        assert!(
            target_exists,
            "moving a symlink must leave its target untouched"
        );
        assert!(
            symlink_cleanup.is_ok(),
            "the exact trashed symlink must be removed"
        );
    }

    #[tokio::test]
    async fn missing_sources_keep_a_stable_not_found_category() {
        let temp_dir = TempDir::create();
        let error = trash_with_destination(temp_dir.path().join("missing"))
            .await
            .unwrap_err();

        assert_eq!(
            error.kind,
            CommandErrorKind::NotFound,
            "missing native sources must map to the REST 404 category"
        );
    }
}
