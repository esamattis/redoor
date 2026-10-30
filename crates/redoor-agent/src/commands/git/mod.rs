//! Git commands, one submodule per feature area so new Git features get their own module.
//! This module holds the plumbing every area shares: the failure type, the blocking runner,
//! path validation and repository discovery.

pub(crate) mod commit_diff;
pub(crate) mod diff;
pub(crate) mod directory_entries;
pub(crate) mod export;
pub(crate) mod history;
pub(crate) mod refs;
pub(crate) mod revision;
pub(crate) mod status;
pub(crate) mod tree;
pub(crate) mod worktree_list;
pub(crate) mod worktree_status;

use redoor_protocol::wire::{command::CommandErrorKind, request::CommandError};
use std::{
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// Carries an agent-command failure with its stable transport classification.
#[derive(Debug)]
pub(super) struct GitFailure {
    kind: CommandErrorKind,
    message: String,
}

impl GitFailure {
    /// Creates a failure without forcing callers to repeat message conversion.
    pub(super) fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Converts one blocking-domain failure into the shared wire error.
    fn into_command_error(self) -> CommandError {
        CommandError::new(self.kind, self.message)
    }
}

/// Owns repository discovery output only within one blocking operation.
pub(super) struct RepositoryPath {
    pub(super) repo: gix::Repository,
    pub(super) root: PathBuf,
    pub(super) requested: PathBuf,
    pub(super) relative: PathBuf,
}

/// Signals gix workers when the async command waiting for them is dropped.
struct CancellationGuard(Arc<AtomicBool>);

impl Drop for CancellationGuard {
    /// Stops cancellable repository walks instead of orphaning them after request cancellation.
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Joins one complete gix operation and preserves panics as structured internal errors.
pub(super) async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce(Arc<AtomicBool>) -> Result<T, GitFailure> + Send + 'static,
) -> Result<T, CommandError> {
    let interrupt = Arc::new(AtomicBool::new(false));
    let guard = CancellationGuard(interrupt.clone());
    let result = tokio::task::spawn_blocking(move || operation(interrupt)).await;
    drop(guard);
    match result {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(error.into_command_error()),
        Err(error) => Err(CommandError::new(
            CommandErrorKind::Internal,
            format!("Git inspection task failed: {error}"),
        )),
    }
}

/// Validates and lexically normalizes absolute paths at the command trust boundary.
pub(super) fn validate_absolute_path(path: &str) -> Result<PathBuf, GitFailure> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Git path must be absolute",
        ));
    }
    let mut normalized = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) => {
                return Err(GitFailure::new(
                    CommandErrorKind::InvalidInput,
                    "Unsupported absolute Git path",
                ));
            }
        }
    }
    Ok(normalized)
}

/// Starts discovery at the nearest existing parent so deleted tracked files remain inspectable.
pub(super) fn discover_repository(
    requested: PathBuf,
) -> Result<Option<RepositoryPath>, GitFailure> {
    let mut discovery_path = requested.clone();
    loop {
        match std::fs::symlink_metadata(&discovery_path) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    discovery_path.pop();
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !discovery_path.pop() {
                    return Ok(None);
                }
            }
            Err(error) => return Err(io_failure("inspect Git discovery path", error)),
        }
    }
    discover_repository_from(&discovery_path, requested)
}

/// Discovers the repository containing an absolute path for commands that only make sense
/// inside one, such as history and ref listings.
pub(super) fn discover_required_repository(path: &str) -> Result<RepositoryPath, GitFailure> {
    discover_repository(validate_absolute_path(path)?)?.ok_or_else(|| {
        GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Path is not inside a non-bare Git worktree",
        )
    })
}

/// Discovers the repository enclosing an existing directory and locates `requested` in it.
///
/// Separate from [`discover_repository`] so history browsing can search upwards from a nested
/// repository's parent, reaching the superproject whose commits record the nested one.
pub(super) fn discover_repository_from(
    discovery_path: &Path,
    requested: PathBuf,
) -> Result<Option<RepositoryPath>, GitFailure> {
    let repo = match gix::discover(discovery_path) {
        Ok(repo) => repo,
        // gix reports every failure as one error type, so "no repository here" is told apart
        // from real failures by the upward-search error it wraps.
        Err(error)
            if matches!(
                error.downcast_any_ref::<gix::discover::upwards::Error>(),
                Some(
                    gix::discover::upwards::Error::NoGitRepository { .. }
                        | gix::discover::upwards::Error::NoGitRepositoryWithinCeiling { .. }
                        | gix::discover::upwards::Error::NoGitRepositoryWithinFs { .. }
                )
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(internal_failure("discover Git repository", error)),
    };
    let Some(root) = repo.workdir().map(Path::to_path_buf) else {
        return Ok(None);
    };
    let root = normalize_existing_root(root)?;
    let relative = requested
        .strip_prefix(&root)
        .map_err(|_| {
            GitFailure::new(
                CommandErrorKind::InvalidInput,
                "Requested path resolves outside the discovered Git worktree",
            )
        })?
        .to_path_buf();
    Ok(Some(RepositoryPath {
        repo,
        root,
        requested,
        relative,
    }))
}

/// Canonicalizes only the existing repository root while leaving deleted descendants lexical.
fn normalize_existing_root(root: PathBuf) -> Result<PathBuf, GitFailure> {
    std::fs::canonicalize(root).map_err(|error| io_failure("canonicalize Git worktree root", error))
}

/// Converts a repository-relative API path without lossy link generation.
pub(super) fn utf8_relative(path: &Path) -> Result<String, GitFailure> {
    path.to_str()
        .map(|path| path.replace(std::path::MAIN_SEPARATOR, "/"))
        .ok_or_else(|| {
            GitFailure::new(
                CommandErrorKind::InvalidInput,
                "Requested Git path is not valid UTF-8",
            )
        })
}

/// Returns the HEAD tree while distinguishing an unborn branch from repository corruption.
pub(super) fn head_tree(repo: &gix::Repository) -> Result<Option<gix::Tree<'_>>, GitFailure> {
    let head = repo
        .head()
        .map_err(|error| internal_failure("read repository HEAD", error))?;
    if head.id().is_none() {
        return Ok(None);
    }
    repo.head_tree()
        .map(Some)
        .map_err(|error| internal_failure("read repository HEAD tree", error))
}

/// Stops a long repository walk once the request waiting for it is gone.
pub(super) fn check_interrupt(interrupt: &AtomicBool, operation: &str) -> Result<(), GitFailure> {
    if interrupt.load(Ordering::Acquire) {
        return Err(GitFailure::new(
            CommandErrorKind::Canceled,
            format!("{operation} was canceled"),
        ));
    }
    Ok(())
}

/// Maps filesystem failures without parsing platform-specific strings.
pub(super) fn io_failure(context: &str, error: std::io::Error) -> GitFailure {
    GitFailure::new(
        CommandErrorKind::from_io_error(&error),
        format!("Failed to {context}: {error}"),
    )
}

/// Maps gix failures to internal errors while retaining actionable operation context.
pub(super) fn internal_failure(context: &str, error: impl std::fmt::Display) -> GitFailure {
    GitFailure::new(
        CommandErrorKind::Internal,
        format!("Failed to {context}: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Confirms lexical normalization prevents parent components from escaping the absolute root.
    #[test]
    fn absolute_path_normalization_is_literal() {
        // Normalization makes repository prefix filtering independent of cwd.
        assert_eq!(
            validate_absolute_path("/tmp/repo/dir/../file").unwrap(),
            PathBuf::from("/tmp/repo/file")
        );
        // Relative command payloads must still fail when they bypass REST validation.
        assert!(validate_absolute_path("tmp/repo").is_err());
    }
}
