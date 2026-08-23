use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use gix::bstr::ByteSlice;

use super::{
    CommandErrorKind, CommandResult, GitChangeState, GitConflictState, GitContextResponse,
    GitDiffMode, GitDiffResponse, GitDiffResult, GitEntryType, GitFileDiff, GitStatusEntry,
    GitStatusEntryKind, GitStatusResponse, GitTrackingState,
};

/// Matches the editor's existing per-file safety policy for both sides of a diff.
const MAX_DIFF_INPUT_BYTES: u64 = 2 * 1024 * 1024;
/// Prevents a bounded pair of inputs from expanding into an unexpectedly large control frame.
const MAX_UNIFIED_DIFF_BYTES: usize = 4 * 1024 * 1024;
/// Bounds status memory and the size of its WebSocket response.
pub(crate) const MAX_GIT_STATUS_ENTRIES: usize = 5_000;

/// Carries an agent-command failure with its stable transport classification.
#[derive(Debug)]
struct GitFailure {
    kind: CommandErrorKind,
    message: String,
}

impl GitFailure {
    /// Creates a failure without forcing callers to repeat message conversion.
    fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Converts one blocking-domain failure into the shared wire result.
    fn into_command_result(self) -> CommandResult {
        CommandResult::error(self.kind, self.message)
    }
}

/// Owns repository discovery output only within one blocking operation.
struct RepositoryPath {
    repo: gix::Repository,
    root: PathBuf,
    requested: PathBuf,
    relative: PathBuf,
}

/// Keeps size and entry-kind classifications out of the command-error channel.
enum DiffSource {
    Missing,
    Content(Vec<u8>),
    TooLarge,
    Unsupported,
}

/// Accumulates the two independent status comparisons for one path.
struct StatusAccumulator {
    index_state: GitChangeState,
    worktree_state: GitChangeState,
    conflict_state: Option<GitConflictState>,
    original_path: Option<String>,
    entry_kind: GitStatusEntryKind,
    ignored: bool,
}

/// Returns bounded status entries together with omission and truncation metadata.
struct StatusCollection {
    changes: BTreeMap<Vec<u8>, StatusAccumulator>,
    omitted_non_utf8_entries: usize,
    overflowed: bool,
}

/// Signals gix workers when the async command waiting for them is dropped.
struct CancellationGuard(Arc<AtomicBool>);

impl Drop for CancellationGuard {
    /// Stops cancellable repository walks instead of orphaning them after request cancellation.
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Collects formatter output without allowing a control response to exceed its hard limit.
struct LimitedWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for LimitedWriter {
    /// Rejects a chunk before it can grow the response beyond the configured limit.
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(buffer.len()) > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::FileTooLarge,
                "unified diff exceeds its output limit",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    /// In-memory output has no pending data to flush.
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
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
pub(crate) async fn context(path: String) -> CommandResult {
    run_blocking(move |interrupt| context_blocking(path, interrupt)).await
}

/// Runs a bounded full-repository status walk away from Tokio workers.
pub(crate) async fn status(path: String) -> CommandResult {
    run_blocking(move |interrupt| status_blocking(path, interrupt)).await
}

/// Runs ordered object reads, worktree reads, and text diffing away from Tokio workers.
pub(crate) async fn diff(files: Vec<String>, mode: GitDiffMode) -> CommandResult {
    run_blocking(move |interrupt| diff_blocking(files, mode, interrupt)).await
}

/// Joins one complete gix operation and preserves panics as structured internal errors.
async fn run_blocking(
    operation: impl FnOnce(Arc<AtomicBool>) -> Result<CommandResult, GitFailure> + Send + 'static,
) -> CommandResult {
    let interrupt = Arc::new(AtomicBool::new(false));
    let guard = CancellationGuard(interrupt.clone());
    let result = tokio::task::spawn_blocking(move || operation(interrupt)).await;
    drop(guard);
    match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => error.into_command_result(),
        Err(error) => CommandResult::error(
            CommandErrorKind::Internal,
            format!("Git inspection task failed: {error}"),
        ),
    }
}

/// Discovers repository context and classifies the exact requested path.
fn context_blocking(path: String, interrupt: Arc<AtomicBool>) -> Result<CommandResult, GitFailure> {
    let requested = validate_absolute_path(&path)?;
    let Some(repository) = discover_repository(requested.clone())? else {
        return Ok(CommandResult::GitContext(
            GitContextResponse::OutsideWorktree,
        ));
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
    Ok(CommandResult::GitContext(
        GitContextResponse::InsideWorktree {
            entry_type,
            tracking_state,
            repository_root: repository.root.display().to_string(),
            repository_relative_path: relative,
        },
    ))
}

/// Produces deterministic merged status while retaining non-UTF-8 omission accounting.
fn status_blocking(path: String, interrupt: Arc<AtomicBool>) -> Result<CommandResult, GitFailure> {
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
        Vec::new(),
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

    let head = repository
        .repo
        .head()
        .map_err(|error| internal_failure("read repository HEAD", error))?;
    let branch_name = head.referent_name().and_then(|name| {
        name.shorten()
            .to_str()
            .ok()
            .map(std::string::ToString::to_string)
    });
    let detached_head_id = head
        .is_detached()
        .then(|| head.id().map(|id| id.to_string()))
        .flatten();

    Ok(CommandResult::GitStatus(GitStatusResponse {
        path: requested.display().to_string(),
        repository_root: repository.root.display().to_string(),
        branch_name,
        detached_head_id,
        // Upstream graph traversal is intentionally omitted when it isn't cheaply available locally.
        upstream: None,
        ahead: None,
        behind: None,
        entries,
        truncated,
        omitted_non_utf8_entries,
    }))
}

/// Produces bounded comparisons in request order so directory views remain stable.
fn diff_blocking(
    files: Vec<String>,
    mode: GitDiffMode,
    interrupt: Arc<AtomicBool>,
) -> Result<CommandResult, GitFailure> {
    let diffs = files
        .into_iter()
        .map(|path| diff_file_blocking(path, mode, interrupt.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CommandResult::GitDiff(GitDiffResponse { diffs }))
}

/// Compares one requested path while retaining explicit non-text outcomes per file.
fn diff_file_blocking(
    path: String,
    mode: GitDiffMode,
    interrupt: Arc<AtomicBool>,
) -> Result<GitFileDiff, GitFailure> {
    let requested = validate_absolute_path(&path)?;
    let repository = discover_repository(requested.clone())?.ok_or_else(|| {
        GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Path is not inside a non-bare Git worktree",
        )
    })?;
    let relative = utf8_relative(&repository.relative)?;
    if relative.is_empty() {
        return Err(GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Git diff path must select a file",
        ));
    }
    if relative.chars().any(char::is_control) {
        return Ok(GitFileDiff {
            path,
            result: GitDiffResult::UnsupportedEntry,
        });
    }
    let tracking = classify_tracking(&repository, relative.as_bytes(), interrupt)?;
    let early_result = match tracking {
        GitTrackingState::Untracked if mode == GitDiffMode::Staged => {
            Some(GitDiffResult::NoChanges)
        }
        GitTrackingState::Untracked => None,
        GitTrackingState::Ignored => Some(GitDiffResult::Ignored),
        GitTrackingState::Tracked | GitTrackingState::Deleted => None,
    };
    if let Some(result) = early_result {
        return Ok(GitFileDiff { path, result });
    }
    if path_declared_binary(&repository.repo, &repository.relative)? {
        return Ok(GitFileDiff {
            path,
            result: GitDiffResult::Binary,
        });
    }

    let head_source = if tracking == GitTrackingState::Untracked {
        DiffSource::Missing
    } else {
        head_blob(&repository.repo, &repository.relative)?
    };
    let right_source = match mode {
        GitDiffMode::Full => worktree_blob(&requested)?,
        GitDiffMode::Staged => index_blob(&repository.repo, relative.as_bytes())?,
    };
    let result = compare_sources(head_source, right_source, &relative)?;
    Ok(GitFileDiff { path, result })
}

/// Validates and lexically normalizes absolute paths at the command trust boundary.
fn validate_absolute_path(path: &str) -> Result<PathBuf, GitFailure> {
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
fn discover_repository(requested: PathBuf) -> Result<Option<RepositoryPath>, GitFailure> {
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
    let repo = match gix::discover(&discovery_path) {
        Ok(repo) => repo,
        Err(gix::discover::Error::Discover(
            gix::discover::upwards::Error::NoGitRepository { .. }
            | gix::discover::upwards::Error::NoGitRepositoryWithinCeiling { .. }
            | gix::discover::upwards::Error::NoGitRepositoryWithinFs { .. },
        )) => return Ok(None),
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

/// Converts a repository-relative API path without lossy link generation.
fn utf8_relative(path: &Path) -> Result<String, GitFailure> {
    path.to_str()
        .map(|path| path.replace(std::path::MAIN_SEPARATOR, "/"))
        .ok_or_else(|| {
            GitFailure::new(
                CommandErrorKind::InvalidInput,
                "Requested Git path is not valid UTF-8",
            )
        })
}

/// Classifies one file using the same gix status/exclude walk as directory status.
fn classify_tracking(
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
fn collect_status(
    repo: &gix::Repository,
    include_path: impl Fn(&[u8]) -> bool,
    include_ignored: bool,
    max_entries: usize,
    patterns: Vec<gix::bstr::BString>,
    interrupt: Arc<AtomicBool>,
) -> Result<StatusCollection, GitFailure> {
    let platform = repo
        .status(gix::progress::Discard)
        .map_err(|error| internal_failure("prepare Git status", error))?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .dirwalk_options(|options| options.emit_ignored(Some(Default::default())))
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
        .should_interrupt_owned(interrupt);
    let iterator = platform
        .into_iter(patterns)
        .map_err(|error| internal_failure("start Git status", error))?;
    let mut changes = BTreeMap::new();
    let mut omitted = 0;
    let mut overflowed = false;
    for item in iterator {
        let item = item.map_err(|error| internal_failure("walk Git status", error))?;
        let path = item.location().to_vec();
        if !include_path(&path) {
            continue;
        }
        if path.as_bstr().to_str().is_err() {
            omitted += 1;
            continue;
        }
        if !include_ignored && is_ignored_item(&item) {
            continue;
        }
        let status = changes
            .entry(path)
            .or_insert_with(StatusAccumulator::default);
        match item {
            gix::status::Item::TreeIndex(change) => apply_tree_index(status, change),
            gix::status::Item::IndexWorktree(change) => apply_index_worktree(status, change),
        }
        if changes.len() > max_entries {
            changes.pop_last();
            overflowed = true;
        }
    }
    Ok(StatusCollection {
        changes,
        omitted_non_utf8_entries: omitted,
        overflowed,
    })
}

/// Identifies ignored dirwalk items before they consume bounded status capacity.
fn is_ignored_item(item: &gix::status::Item) -> bool {
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

/// Returns the HEAD tree while distinguishing an unborn branch from repository corruption.
fn head_tree(repo: &gix::Repository) -> Result<Option<gix::Tree<'_>>, GitFailure> {
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

/// Reads a bounded blob from HEAD, treating only an unborn HEAD as an empty side.
fn head_blob(repo: &gix::Repository, relative: &Path) -> Result<DiffSource, GitFailure> {
    let tree = match head_tree(repo)? {
        Some(tree) => tree,
        None => return Ok(DiffSource::Missing),
    };
    let Some(entry) = tree
        .lookup_entry_by_path(relative)
        .map_err(|error| internal_failure("lookup Git HEAD file", error))?
    else {
        return Ok(DiffSource::Missing);
    };
    if !entry.mode().is_blob() {
        return Ok(DiffSource::Unsupported);
    }
    read_object_blob(repo, entry.object_id())
}

/// Reads a bounded stage-zero index blob and rejects conflicts or special entry kinds.
fn index_blob(repo: &gix::Repository, relative: &[u8]) -> Result<DiffSource, GitFailure> {
    let index = repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index", error))?;
    if index
        .entries()
        .iter()
        .any(|entry| entry.path(&index) == relative.as_bstr() && entry.flags.stage_raw() != 0)
    {
        return Ok(DiffSource::Unsupported);
    }
    let Some(entry) = index.entry_by_path(relative.as_bstr()) else {
        return Ok(DiffSource::Missing);
    };
    let mode = entry.mode.to_tree_entry_mode();
    if !mode.is_some_and(|mode| mode.is_blob()) {
        return Ok(DiffSource::Unsupported);
    }
    read_object_blob(repo, entry.id)
}

/// Checks object size before decompression so oversized repository blobs remain bounded.
fn read_object_blob(repo: &gix::Repository, id: gix::ObjectId) -> Result<DiffSource, GitFailure> {
    let header = repo
        .find_header(id)
        .map_err(|error| internal_failure("read Git object header", error))?;
    if header.size() > MAX_DIFF_INPUT_BYTES {
        return Ok(DiffSource::TooLarge);
    }
    let object = repo
        .find_object(id)
        .map_err(|error| internal_failure("read Git blob", error))?;
    Ok(DiffSource::Content(object.detach().data))
}

/// Reads a worktree file with metadata and post-read bounds, never following symlinks.
fn worktree_blob(path: &Path) -> Result<DiffSource, GitFailure> {
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiffSource::Missing);
        }
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Ok(DiffSource::Unsupported);
        }
        Err(error) => return Err(io_failure("open Git worktree file", error)),
    };
    let metadata = file
        .metadata()
        .map_err(|error| io_failure("inspect open Git worktree file", error))?;
    if !metadata.is_file() {
        return Ok(DiffSource::Unsupported);
    }
    if metadata.len() > MAX_DIFF_INPUT_BYTES {
        return Ok(DiffSource::TooLarge);
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_DIFF_INPUT_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| io_failure("read Git worktree file", error))?;
    if data.len() as u64 > MAX_DIFF_INPUT_BYTES {
        return Ok(DiffSource::TooLarge);
    }
    Ok(DiffSource::Content(data))
}

/// Formats bounded UTF-8 blobs as unified text with Git-style path headers.
fn compare_sources(
    left: DiffSource,
    right: DiffSource,
    relative: &str,
) -> Result<GitDiffResult, GitFailure> {
    if matches!(left, DiffSource::TooLarge) || matches!(right, DiffSource::TooLarge) {
        return Ok(GitDiffResult::TooLarge);
    }
    if matches!(left, DiffSource::Unsupported) || matches!(right, DiffSource::Unsupported) {
        return Ok(GitDiffResult::UnsupportedEntry);
    }
    let left = match left {
        DiffSource::Content(content) => content,
        DiffSource::Missing => Vec::new(),
        DiffSource::TooLarge | DiffSource::Unsupported => unreachable!("classified above"),
    };
    let right = match right {
        DiffSource::Content(content) => content,
        DiffSource::Missing => Vec::new(),
        DiffSource::TooLarge | DiffSource::Unsupported => unreachable!("classified above"),
    };
    if left == right {
        return Ok(GitDiffResult::NoChanges);
    }
    if left.contains(&0) || right.contains(&0) {
        return Ok(GitDiffResult::Binary);
    }
    let (Ok(left), Ok(right)) = (std::str::from_utf8(&left), std::str::from_utf8(&right)) else {
        return Ok(GitDiffResult::Binary);
    };
    let text_diff = similar::TextDiff::from_lines(left, right);
    let mut unified_diff = text_diff.unified_diff();
    unified_diff.header(&format!("a/{relative}"), &format!("b/{relative}"));
    let mut output = LimitedWriter {
        bytes: Vec::new(),
        limit: MAX_UNIFIED_DIFF_BYTES,
    };
    if unified_diff.to_writer(&mut output).is_err() {
        return Ok(GitDiffResult::TooLarge);
    }
    let patch = String::from_utf8(output.bytes)
        .map_err(|error| internal_failure("encode unified Git diff", error))?;
    Ok(GitDiffResult::Text {
        unified_diff: patch,
    })
}

/// Honors Git's built-in `-diff` binary declaration without invoking configured drivers.
fn path_declared_binary(repo: &gix::Repository, relative: &Path) -> Result<bool, GitFailure> {
    let index = repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index for attributes", error))?;
    let mut attributes = repo
        .attributes_only(
            &index,
            gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping,
        )
        .map_err(|error| internal_failure("prepare Git attributes", error))?;
    let mut matches = attributes.selected_attribute_matches(["diff"]);
    attributes
        .at_path(relative, None)
        .map_err(|error| io_failure("read Git attributes", error))?
        .matching_attributes(&mut matches);
    Ok(matches
        .iter_selected()
        .next()
        .is_some_and(|attribute| attribute.assignment.state.is_unset()))
}

/// Maps filesystem failures without parsing platform-specific strings.
fn io_failure(context: &str, error: std::io::Error) -> GitFailure {
    GitFailure::new(
        CommandErrorKind::from_io_error(&error),
        format!("Failed to {context}: {error}"),
    )
}

/// Maps gix failures to internal errors while retaining actionable operation context.
fn internal_failure(context: &str, error: impl std::fmt::Display) -> GitFailure {
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

    /// Covers explicit no-change, binary, and Git-style unified patch outcomes.
    #[test]
    fn bounded_diff_formatter_classifies_content() {
        // Equal content has a semantic result instead of an empty ambiguous patch.
        assert_eq!(
            compare_sources(
                DiffSource::Content(b"same\n".to_vec()),
                DiffSource::Content(b"same\n".to_vec()),
                "file.txt"
            )
            .unwrap(),
            GitDiffResult::NoChanges
        );
        // NUL bytes identify binary data before line formatting.
        assert_eq!(
            compare_sources(
                DiffSource::Content(vec![0]),
                DiffSource::Content(vec![1]),
                "file.bin"
            )
            .unwrap(),
            GitDiffResult::Binary
        );
        let result = compare_sources(
            DiffSource::Content(b"old\n".to_vec()),
            DiffSource::Content(b"new\n".to_vec()),
            "nested/file.txt",
        )
        .unwrap();
        let GitDiffResult::Text { unified_diff } = result else {
            panic!("changed UTF-8 should produce text");
        };
        // Git-style labels let the existing renderer identify the browser path.
        assert!(unified_diff.contains("--- a/nested/file.txt"));
        assert!(unified_diff.contains("+++ b/nested/file.txt"));
        // Signed lines preserve replacement direction for patch consumers.
        assert!(unified_diff.contains("-old\n+new"));
    }

    /// Verifies the formatter preserves missing-final-newline markers needed for exact display.
    #[test]
    fn bounded_diff_formatter_marks_missing_final_newlines() {
        let result = compare_sources(
            DiffSource::Content(b"old".to_vec()),
            DiffSource::Content(b"new".to_vec()),
            "file.txt",
        )
        .unwrap();
        let GitDiffResult::Text { unified_diff } = result else {
            panic!("changed UTF-8 should produce text");
        };
        // The marker tells users the visible line ending is absent rather than hidden.
        assert!(unified_diff.contains("\\ No newline at end of file"));
    }

    /// Ensures formatter chunks cannot allocate beyond the control-response budget.
    #[test]
    fn limited_writer_rejects_output_over_its_limit() {
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            limit: 3,
        };
        // Output up to the limit is retained normally.
        assert_eq!(writer.write(b"abc").unwrap(), 3);
        // The overflowing chunk is rejected without partially growing the response.
        assert_eq!(
            writer.write(b"d").unwrap_err().kind(),
            std::io::ErrorKind::FileTooLarge
        );
        assert_eq!(writer.bytes, b"abc");
    }
}
