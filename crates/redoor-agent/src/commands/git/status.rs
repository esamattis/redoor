//! Worktree context and status: how the checked-out files relate to HEAD and the index.

use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

use gix::bstr::ByteSlice;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use redoor_core::log;

use redoor_protocol::{
    api::git::{
        GitChangeState,
        worktree::{
            GitConflictState, GitContextResponse, GitEntryType, GitStatusEntry, GitStatusEntryKind,
            GitStatusResponse, GitTrackingState,
        },
    },
    wire::{command::CommandErrorKind, log::Level, request::CommandError},
};

use super::{
    GitFailure, RepositoryPath, discover_repository, head_tree, internal_failure, io_failure,
    run_blocking, utf8_relative, validate_absolute_path,
};

/// Bounds status memory and the size of its WebSocket response.
pub(crate) const MAX_GIT_STATUS_ENTRIES: usize = 5_000;

/// Accumulates the two independent status comparisons for one path.
pub(super) struct StatusAccumulator {
    pub(super) index_state: GitChangeState,
    pub(super) worktree_state: GitChangeState,
    pub(super) conflict_state: Option<GitConflictState>,
    original_path: Option<String>,
    entry_kind: GitStatusEntryKind,
    ignored: bool,
}

/// Returns bounded status entries together with omission and truncation metadata.
pub(super) struct StatusCollection {
    pub(super) changes: BTreeMap<Vec<u8>, StatusAccumulator>,
    pub(super) omitted_non_utf8_entries: usize,
    pub(super) overflowed: bool,
}

impl Default for StatusAccumulator {
    /// Starts each changed path with explicit unchanged sides.
    fn default() -> Self {
        Self {
            index_state: GitChangeState::Unmodified,
            worktree_state: GitChangeState::Unmodified,
            conflict_state: None,
            original_path: None,
            entry_kind: GitStatusEntryKind::File,
            ignored: false,
        }
    }
}

/// Runs repository context inspection away from Tokio workers.
pub(crate) async fn context(path: String) -> Result<GitContextResponse, CommandError> {
    run_blocking(move |interrupt| context_blocking(path, interrupt)).await
}

/// Runs a bounded status walk of one directory away from Tokio workers.
///
/// When `cancel` fires (the browser left the Git view or the connection ended) the walk is
/// dropped at once, which interrupts gix instead of letting a large checkout keep the disk
/// and a command slot busy for an answer nobody reads.
pub(crate) async fn status(
    path: String,
    cancel: &CancellationToken,
) -> Result<GitStatusResponse, CommandError> {
    let started_at = Instant::now();
    let walk = run_blocking({
        let path = path.clone();
        move |interrupt| status_blocking(path, interrupt)
    });
    let Some(result) = cancel.run_until_cancelled(walk).await else {
        // Lets an operator confirm that leaving the Git view stops the walk on the agent.
        log!(
            Level::Debug,
            "Git status canceled: path={path} elapsed_ms={}",
            started_at.elapsed().as_millis()
        );
        return Err(CommandError::new(
            CommandErrorKind::Canceled,
            "Git status was canceled",
        ));
    };
    result
}

/// Discovers repository context and classifies the exact requested path.
fn context_blocking(
    path: String,
    interrupt: Arc<AtomicBool>,
) -> Result<GitContextResponse, GitFailure> {
    let requested = validate_absolute_path(&path)?;
    let Some(repository) = discover_repository(requested.clone())? else {
        return Ok(GitContextResponse::OutsideWorktree);
    };

    let entry_type = entry_type(&requested)?;
    let relative = utf8_relative(&repository.relative)?;
    let tracking_state = if entry_type == GitEntryType::Directory {
        None
    } else {
        Some(classify_tracking(
            &repository,
            relative.as_bytes(),
            interrupt,
        )?)
    };
    let head = HeadState::read(&repository.repo)?;
    Ok(GitContextResponse::InsideWorktree {
        entry_type,
        tracking_state,
        repository_root: repository.root.display().to_string(),
        repository_relative_path: relative,
        branch_name: head.branch_name,
        head_commit_id: head.commit_id,
    })
}

/// Produces deterministic merged status while retaining non-UTF-8 omission accounting.
fn status_blocking(
    path: String,
    interrupt: Arc<AtomicBool>,
) -> Result<GitStatusResponse, GitFailure> {
    let requested = validate_absolute_path(&path)?;
    let metadata =
        std::fs::metadata(&requested).map_err(|error| io_failure("read Git status path", error))?;
    if !metadata.is_dir() {
        return Err(GitFailure::new(
            CommandErrorKind::NotADirectory,
            "Git status path must be a directory",
        ));
    }
    let repository = discover_repository(requested.clone())?.ok_or_else(|| {
        GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Path is not inside a non-bare Git worktree",
        )
    })?;
    let selected_relative = utf8_relative(&repository.relative)?;
    let selected_bytes = selected_relative.as_bytes().to_vec();
    let StatusCollection {
        mut changes,
        omitted_non_utf8_entries,
        overflowed,
    } = collect_status(
        &repository.repo,
        |path| {
            selected_bytes.is_empty()
                || path == selected_bytes
                || path
                    .strip_prefix(selected_bytes.as_slice())
                    .is_some_and(|suffix| suffix.starts_with(b"/"))
        },
        false,
        MAX_GIT_STATUS_ENTRIES + 1,
        // Limiting gix to the directory keeps a status of a small subdirectory from walking
        // the whole checkout; the prefix filter above stays as a guard on what is reported.
        directory_pathspec(&selected_relative),
        interrupt,
    )?;
    let prefix = if selected_relative.is_empty() {
        None
    } else {
        Some(format!("{selected_relative}/"))
    };

    let mut entries = Vec::new();
    let mut truncated = overflowed;
    for (relative_bytes, status) in &mut changes {
        let Some(relative) = relative_bytes.as_bstr().to_str().ok() else {
            continue;
        };
        let selected = selected_relative.is_empty()
            || relative == selected_relative
            || prefix
                .as_ref()
                .is_some_and(|prefix| relative.starts_with(prefix));
        if !selected || status.ignored {
            continue;
        }
        if entries.len() == MAX_GIT_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(GitStatusEntry {
            path: repository
                .root
                .join(Path::new(relative))
                .display()
                .to_string(),
            repository_relative_path: relative.to_string(),
            original_path: status.original_path.take(),
            index_state: status.index_state,
            worktree_state: status.worktree_state,
            conflict_state: status.conflict_state,
            entry_kind: status.entry_kind,
        });
    }

    let head = HeadState::read(&repository.repo)?;

    Ok(GitStatusResponse {
        path: requested.display().to_string(),
        repository_root: repository.root.display().to_string(),
        branch_name: head.branch_name,
        detached_head_id: head.detached.then_some(head.commit_id).flatten(),
        // Upstream graph traversal is intentionally omitted when it isn't cheaply available locally.
        upstream: None,
        ahead: None,
        behind: None,
        entries,
        truncated,
        omitted_non_utf8_entries,
    })
}

/// Limits a status walk to the repository-relative `directory`, or walks everything at the
/// repository root. The trailing slash keeps a sibling such as `src-old` out of a walk of
/// `src`, and `literal` keeps glob characters in names from widening it.
pub(super) fn directory_pathspec(directory: &str) -> Vec<gix::bstr::BString> {
    if directory.is_empty() {
        return Vec::new();
    }
    vec![format!(":(top,literal){directory}/").into()]
}

/// What HEAD names, read once so context and status describe it the same way.
struct HeadState {
    /// The short name of the checked-out branch, absent when HEAD is detached.
    branch_name: Option<String>,
    /// The commit HEAD resolves to, absent on an unborn branch.
    commit_id: Option<String>,
    detached: bool,
}

impl HeadState {
    /// Reads HEAD without touching the index or worktree, so it is cheap on every navigation.
    fn read(repo: &gix::Repository) -> Result<Self, GitFailure> {
        let head = repo
            .head()
            .map_err(|error| internal_failure("read repository HEAD", error))?;
        let branch_name = head.referent_name().and_then(|name| {
            name.shorten()
                .to_str()
                .ok()
                .map(std::string::ToString::to_string)
        });
        Ok(Self {
            branch_name,
            commit_id: head.id().map(|id| id.to_string()),
            detached: head.is_detached(),
        })
    }
}

/// Classifies the requested filesystem node without following symlink targets.
fn entry_type(path: &Path) -> Result<GitEntryType, GitFailure> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(GitEntryType::Symlink),
        Ok(metadata) if metadata.is_file() => Ok(GitEntryType::File),
        Ok(metadata) if metadata.is_dir() => Ok(GitEntryType::Directory),
        Ok(_) => Ok(GitEntryType::Other),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GitEntryType::Missing),
        Err(error) => Err(io_failure("inspect Git context path", error)),
    }
}

/// Classifies one file using the same gix status/exclude walk as directory status.
pub(super) fn classify_tracking(
    repository: &RepositoryPath,
    target: &[u8],
    interrupt: Arc<AtomicBool>,
) -> Result<GitTrackingState, GitFailure> {
    let mut pattern = b":(top,literal)".to_vec();
    pattern.extend_from_slice(target);
    let StatusCollection { changes, .. } = collect_status(
        &repository.repo,
        |path| path == target,
        true,
        1,
        vec![pattern.into()],
        interrupt,
    )?;
    if let Some(status) = changes.get(target) {
        if status.ignored {
            return Ok(GitTrackingState::Ignored);
        }
        if status.index_state == GitChangeState::Unmodified
            && status.worktree_state == GitChangeState::Added
        {
            return Ok(GitTrackingState::Untracked);
        }
        if (status.index_state == GitChangeState::Deleted
            || status.worktree_state == GitChangeState::Deleted)
            && !repository.requested.exists()
        {
            return Ok(GitTrackingState::Deleted);
        }
        return Ok(GitTrackingState::Tracked);
    }
    let index_contains = repository
        .repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index", error))?
        .entry_by_path(target.as_bstr())
        .is_some();
    let head_contains = match head_tree(&repository.repo)? {
        Some(tree) => tree
            .lookup_entry_by_path(&repository.relative)
            .map_err(|error| internal_failure("lookup HEAD entry", error))?
            .is_some(),
        None => false,
    };
    if index_contains || head_contains {
        Ok(if repository.requested.exists() {
            GitTrackingState::Tracked
        } else {
            GitTrackingState::Deleted
        })
    } else {
        Ok(GitTrackingState::Untracked)
    }
}

/// Walks both status comparisons with ignored files visible for direct context classification.
pub(super) fn collect_status(
    repo: &gix::Repository,
    include_path: impl Fn(&[u8]) -> bool,
    include_ignored: bool,
    max_entries: usize,
    patterns: Vec<gix::bstr::BString>,
    interrupt: Arc<AtomicBool>,
) -> Result<StatusCollection, GitFailure> {
    let mut changes = BTreeMap::new();
    let mut omitted = 0;
    let mut overflowed = false;
    let walk = StatusWalk {
        patterns,
        untracked: gix::status::UntrackedFiles::Files,
        renames: gix::status::tree_index::TrackRenames::Disabled,
    };
    walk.run(repo, interrupt, |item| {
        let path = item.location().to_vec();
        if !include_path(&path) {
            return;
        }
        if path.as_bstr().to_str().is_err() {
            omitted += 1;
            return;
        }
        if !include_ignored && is_ignored_item(&item) {
            return;
        }
        let status = changes
            .entry(path)
            .or_insert_with(StatusAccumulator::default);
        status.apply(item);
        if changes.len() > max_entries {
            changes.pop_last();
            overflowed = true;
        }
    })?;
    Ok(StatusCollection {
        changes,
        omitted_non_utf8_entries: omitted,
        overflowed,
    })
}

/// What one gix status walk looks at and how it reports it. The Git view lists every
/// untracked file on its own, while the file list only needs to know that a directory is
/// untracked, so the callers pick different shapes of the same walk.
pub(super) struct StatusWalk {
    /// Pathspecs that limit the walk; empty walks the whole worktree.
    pub(super) patterns: Vec<gix::bstr::BString>,
    /// Whether untracked directories are reported as one entry or file by file.
    pub(super) untracked: gix::status::UntrackedFiles,
    /// Whether staged renames are paired up, which costs blob comparisons.
    pub(super) renames: gix::status::tree_index::TrackRenames,
}

impl StatusWalk {
    /// Streams every status item to `visit`, so callers can fold the walk into whatever
    /// bounded shape they answer with instead of holding every changed path at once.
    ///
    /// Ignored paths are always emitted, collapsed to the directory a pattern matched, so an
    /// ignored `node_modules/` costs one entry rather than a walk through it.
    pub(super) fn run(
        self,
        repo: &gix::Repository,
        interrupt: Arc<AtomicBool>,
        mut visit: impl FnMut(gix::status::Item),
    ) -> Result<(), GitFailure> {
        let platform = repo
            .status(gix::progress::Discard)
            .map_err(|error| internal_failure("prepare Git status", error))?
            .untracked_files(self.untracked)
            .dirwalk_options(|options| options.emit_ignored(Some(Default::default())))
            .tree_index_track_renames(self.renames)
            .should_interrupt_owned(interrupt);
        let iterator = platform
            .into_iter(self.patterns)
            .map_err(|error| internal_failure("start Git status", error))?;
        for item in iterator {
            visit(item.map_err(|error| internal_failure("walk Git status", error))?);
        }
        Ok(())
    }
}

impl StatusAccumulator {
    /// Merges one side of the comparison into the path's state; the two sides arrive as
    /// separate items in no fixed order.
    pub(super) fn apply(&mut self, item: gix::status::Item) {
        match item {
            gix::status::Item::TreeIndex(change) => apply_tree_index(self, change),
            gix::status::Item::IndexWorktree(change) => apply_index_worktree(self, change),
        }
    }

    /// True when Git ignores the path, so it is neither tracked nor offered for adding.
    pub(super) fn is_ignored(&self) -> bool {
        self.ignored
    }

    /// True for a path Git does not track and does not ignore.
    pub(super) fn is_untracked(&self) -> bool {
        !self.ignored
            && self.index_state == GitChangeState::Unmodified
            && self.worktree_state == GitChangeState::Added
            && self.conflict_state.is_none()
    }

    /// Where a staged rename or copy came from, repository-relative.
    pub(super) fn original_path(&self) -> Option<&str> {
        self.original_path.as_deref()
    }
}

/// Identifies ignored dirwalk items before they consume bounded status capacity.
pub(super) fn is_ignored_item(item: &gix::status::Item) -> bool {
    matches!(
        item,
        gix::status::Item::IndexWorktree(
            gix::status::index_worktree::Item::DirectoryContents { entry, .. }
        ) if matches!(entry.status, gix_dir::entry::Status::Ignored(_))
    )
}

/// Maps one HEAD-to-index change into the public status model.
fn apply_tree_index(status: &mut StatusAccumulator, change: gix::diff::index::Change) {
    use gix::diff::index::Change;
    match change {
        Change::Addition { entry_mode, .. } => {
            status.index_state = GitChangeState::Added;
            status.entry_kind = tree_mode_kind(entry_mode);
        }
        Change::Deletion { entry_mode, .. } => {
            status.index_state = GitChangeState::Deleted;
            status.entry_kind = tree_mode_kind(entry_mode);
        }
        Change::Modification {
            previous_entry_mode,
            entry_mode,
            ..
        } => {
            status.index_state = if previous_entry_mode == entry_mode {
                GitChangeState::Modified
            } else {
                GitChangeState::TypeChanged
            };
            status.entry_kind = tree_mode_kind(entry_mode);
        }
        Change::Rewrite {
            source_location,
            copy,
            entry_mode,
            ..
        } => {
            status.index_state = if copy {
                GitChangeState::Copied
            } else {
                GitChangeState::Renamed
            };
            status.original_path = source_location.to_str().ok().map(str::to_string);
            status.entry_kind = tree_mode_kind(entry_mode);
        }
    }
}

/// Maps one index-to-worktree change, including ignored and conflict markers.
fn apply_index_worktree(status: &mut StatusAccumulator, change: gix::status::index_worktree::Item) {
    if let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = &change {
        status.ignored = matches!(entry.status, gix_dir::entry::Status::Ignored(_));
        status.entry_kind = match entry.disk_kind {
            Some(gix_dir::entry::Kind::Symlink) => GitStatusEntryKind::Symlink,
            Some(gix_dir::entry::Kind::Repository) => GitStatusEntryKind::Submodule,
            Some(gix_dir::entry::Kind::File) => GitStatusEntryKind::File,
            _ => GitStatusEntryKind::Other,
        };
    }
    use gix::status::index_worktree::iter::Summary;
    match change.summary() {
        Some(Summary::Removed) => status.worktree_state = GitChangeState::Deleted,
        Some(Summary::Added) | Some(Summary::IntentToAdd) => {
            status.worktree_state = GitChangeState::Added
        }
        Some(Summary::Modified) => status.worktree_state = GitChangeState::Modified,
        Some(Summary::TypeChange) => status.worktree_state = GitChangeState::TypeChanged,
        Some(Summary::Renamed) => status.worktree_state = GitChangeState::Renamed,
        Some(Summary::Copied) => status.worktree_state = GitChangeState::Copied,
        Some(Summary::Conflict) => status.conflict_state = Some(GitConflictState::Conflicted),
        None => {}
    }
}

/// Converts a Git tree/index mode into a stable browser entry kind.
fn tree_mode_kind(mode: gix::index::entry::Mode) -> GitStatusEntryKind {
    let mode = mode.to_tree_entry_mode();
    match mode {
        Some(mode) if mode.is_commit() => GitStatusEntryKind::Submodule,
        Some(mode) if mode.is_link() => GitStatusEntryKind::Symlink,
        Some(mode) if mode.is_blob() => GitStatusEntryKind::File,
        _ => GitStatusEntryKind::Other,
    }
}
