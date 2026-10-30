//! The Git state of each entry of one browsed directory, for the file list's status column.
//!
//! Kept out of the directory listing because a status walk can take much longer than reading
//! one directory: the browser shows the list at once and fills the column in when this
//! answers. The walk is limited to the browsed directory with a pathspec, sees ignored paths
//! collapsed to the directory a rule matched (so `node_modules/` costs one entry), and folds
//! every reported path into its direct child, so the answer is bounded by the listing size
//! rather than by how many changes the tree holds.

use std::{
    collections::{BTreeMap, HashMap, hash_map::Entry},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

use gix::bstr::ByteSlice;
use tokio::{sync::Semaphore, time::Instant};
use tokio_util::sync::CancellationToken;

use redoor_core::log;
use redoor_protocol::{
    api::git::directory_entries::{
        GitDescendantChange, GitDirectoryChanges, GitDirectoryEntriesResponse, GitDirectoryEntry,
        GitDirectoryEntryState, MAX_GIT_DIRECTORY_COUNTED_CHANGES,
    },
    wire::{command::CommandErrorKind, log::Level, request::CommandError},
};

use super::{
    GitFailure, RepositoryPath, check_interrupt, discover_repository, internal_failure, io_failure,
    run_blocking,
    status::{StatusAccumulator, StatusWalk, directory_pathspec, is_ignored_item},
    utf8_relative, validate_absolute_path,
};

/// Walks allowed to run at once. Each gix walk already spreads over all cores, so more of
/// them at once only makes the disk seek between directories. Separate from the worktree
/// list's slots, so browsing never waits behind the worktree counts or the other way around.
const DIRECTORY_ENTRIES_SLOTS: usize = 2;

/// Queue shared by every connection, because the disk being walked is shared too.
static DIRECTORY_ENTRIES_PERMITS: Semaphore = Semaphore::const_new(DIRECTORY_ENTRIES_SLOTS);

/// How long one walk may run before it is stopped. The column is a convenience next to a
/// listing that is already on screen, so a checkout too large to walk in this time leaves the
/// column empty rather than holding a slot and the disk for minutes.
const DIRECTORY_ENTRIES_BUDGET: Duration = Duration::from_secs(30);

/// Reads the Git state of the entries of the directory at `path`.
///
/// When `cancel` fires (the browser left the directory or the connection ended) the walk is
/// dropped at once, which interrupts gix and frees its slot for a directory someone still
/// looks at; the empty answer goes to nobody.
pub(crate) async fn entries(
    path: String,
    cancel: &CancellationToken,
) -> Result<GitDirectoryEntriesResponse, CommandError> {
    let started_at = Instant::now();
    let walk = walk_within_budget(
        path.clone(),
        &DIRECTORY_ENTRIES_PERMITS,
        DIRECTORY_ENTRIES_BUDGET,
    );
    let Some(result) = cancel.run_until_cancelled(walk).await else {
        // Lets an operator confirm that leaving a directory stops its walk on the agent.
        log!(
            Level::Debug,
            "Git directory entries canceled: path={path} elapsed_ms={}",
            started_at.elapsed().as_millis()
        );
        return Ok(GitDirectoryEntriesResponse::Entries {
            entries: Vec::new(),
        });
    };
    result
}

/// Waits for a free slot and walks, answering `TimedOut` once `budget` has passed.
///
/// The budget covers the wait for a slot too, because the browser waits for both. Dropping
/// the walk at the deadline interrupts gix through [`run_blocking`]'s guard.
async fn walk_within_budget(
    path: String,
    permits: &Semaphore,
    budget: Duration,
) -> Result<GitDirectoryEntriesResponse, CommandError> {
    let walk = async {
        let _permit = permits.acquire().await.map_err(|_| {
            CommandError::new(
                CommandErrorKind::Internal,
                "Git directory entries queue is unavailable",
            )
        })?;
        run_blocking(move |interrupt| entries_blocking(&path, interrupt)).await
    };
    match tokio::time::timeout(budget, walk).await {
        Ok(result) => result,
        Err(_) => Ok(GitDirectoryEntriesResponse::TimedOut),
    }
}

/// Discovers the repository and classifies the children of the requested directory.
fn entries_blocking(
    path: &str,
    interrupt: Arc<AtomicBool>,
) -> Result<GitDirectoryEntriesResponse, GitFailure> {
    let requested = validate_absolute_path(path)?;
    let metadata = std::fs::metadata(&requested)
        .map_err(|error| io_failure("read Git directory entries path", error))?;
    if !metadata.is_dir() {
        return Err(GitFailure::new(
            CommandErrorKind::NotADirectory,
            "Git directory entries path must be a directory",
        ));
    }
    let Some(repository) = discover_repository(requested)? else {
        return Ok(GitDirectoryEntriesResponse::OutsideWorktree);
    };
    let directory = utf8_relative(&repository.relative)?;
    if is_wholly_ignored(&repository, &directory)? {
        return Ok(GitDirectoryEntriesResponse::Ignored);
    }
    let mut children = ChildStates::new(&directory);
    StatusWalk {
        patterns: directory_pathspec(&directory),
        // A wholly untracked directory is one entry, so a new build output that nobody
        // ignored yet is not walked file by file.
        untracked: gix::status::UntrackedFiles::Collapsed,
        renames: gix::status::tree_index::TrackRenames::Given(Default::default()),
    }
    .run(&repository.repo, interrupt.clone(), |item| {
        children.record(item)
    })?;
    if children.wholly_untracked {
        return untracked_directory_entries(&repository, &directory, &interrupt);
    }
    let response = children.into_response(&repository.root);
    settle_untracked_directories(&repository, &directory, response, &interrupt)
}

/// Turns an untracked directory that holds nothing Git could ever add into an ignored one.
/// Git does not track empty directories, so one whose files are all ignored shows as ignored
/// in `git status --ignored`, but gix still reports it as untracked because of the empty
/// directories inside it.
fn settle_untracked_directories(
    repository: &RepositoryPath,
    directory: &str,
    mut response: GitDirectoryEntriesResponse,
    interrupt: &AtomicBool,
) -> Result<GitDirectoryEntriesResponse, GitFailure> {
    let GitDirectoryEntriesResponse::Entries { entries } = &mut response else {
        return Ok(response);
    };
    if !entries
        .iter()
        .any(|entry| entry.state == GitDirectoryEntryState::Untracked)
    {
        return Ok(response);
    }
    let index = open_index(repository)?;
    let mut excludes = ignore_rules(repository, &index)?;
    for entry in entries
        .iter_mut()
        .filter(|entry| entry.state == GitDirectoryEntryState::Untracked)
    {
        let relative = format!("{directory}/{}", entry.name);
        let path = repository.requested.join(&entry.name);
        if holds_only_ignored_or_empty(&path, &relative, &mut excludes, interrupt)? {
            entry.state = GitDirectoryEntryState::Ignored;
        }
    }
    Ok(response)
}

/// True when `path` is a directory with no file that is not ignored. Stops at the first such
/// file, and never opens an ignored directory, so the cost is bounded by what Git would walk.
fn holds_only_ignored_or_empty(
    path: &Path,
    relative: &str,
    excludes: &mut gix::AttributeStack<'_>,
    interrupt: &AtomicBool,
) -> Result<bool, GitFailure> {
    let mut pending = vec![(path.to_path_buf(), relative.to_string())];
    while let Some((directory, relative)) = pending.pop() {
        let listing = match std::fs::read_dir(&directory) {
            Ok(listing) => listing,
            // Not a directory, or gone: a plain untracked file stays untracked.
            Err(_) => return Ok(false),
        };
        for entry in listing {
            check_interrupt(interrupt, "Git directory entries")?;
            let entry = entry.map_err(|error| io_failure("read untracked directory", error))?;
            let Ok(name) = entry.file_name().into_string() else {
                return Ok(false);
            };
            let is_directory = entry
                .file_type()
                .map_err(|error| io_failure("inspect untracked entry", error))?
                .is_dir();
            let child = format!("{relative}/{name}");
            let mode = if is_directory {
                gix::index::entry::Mode::DIR
            } else {
                gix::index::entry::Mode::FILE
            };
            let excluded = excludes
                .at_entry(child.as_str(), Some(mode))
                .map_err(|error| internal_failure("match Git ignore rules", error))?
                .is_excluded();
            if excluded {
                continue;
            }
            if !is_directory {
                return Ok(false);
            }
            pending.push((entry.path(), child));
        }
    }
    Ok(true)
}

/// Classifies the entries of a directory Git does not track at all. gix reports such a
/// directory as one collapsed entry, which names no children, so its entries are read from
/// disk instead: each is untracked unless an ignore rule matches it. Reading one directory
/// keeps this bounded by the listing size however large the untracked tree is.
fn untracked_directory_entries(
    repository: &RepositoryPath,
    directory: &str,
    interrupt: &AtomicBool,
) -> Result<GitDirectoryEntriesResponse, GitFailure> {
    let index = open_index(repository)?;
    let mut excludes = ignore_rules(repository, &index)?;
    let mut entries = Vec::new();
    let listing = std::fs::read_dir(&repository.requested)
        .map_err(|error| io_failure("read untracked directory", error))?;
    for entry in listing {
        check_interrupt(interrupt, "Git directory entries")?;
        let entry = entry.map_err(|error| io_failure("read untracked directory", error))?;
        // Listings name entries in UTF-8, so a name that is not cannot match a row.
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let is_directory = entry
            .file_type()
            .map_err(|error| io_failure("inspect untracked entry", error))?
            .is_dir();
        let mode = if is_directory {
            gix::index::entry::Mode::DIR
        } else {
            gix::index::entry::Mode::FILE
        };
        let relative = format!("{directory}/{name}");
        let excluded = excludes
            .at_entry(relative.as_str(), Some(mode))
            .map_err(|error| internal_failure("match Git ignore rules", error))?
            .is_excluded();
        let state = if excluded {
            GitDirectoryEntryState::Ignored
        } else {
            GitDirectoryEntryState::Untracked
        };
        entries.push(GitDirectoryEntry { name, state });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    let response = GitDirectoryEntriesResponse::Entries { entries };
    settle_untracked_directories(repository, directory, response, interrupt)
}

/// Opens the index, which an unborn repository may not have yet.
fn open_index(repository: &RepositoryPath) -> Result<gix::worktree::Index, GitFailure> {
    repository
        .repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index", error))
}

/// Loads the ignore rules the way `git status` applies them: per-directory `.gitignore`
/// files, `info/exclude` and the configured global excludes file.
fn ignore_rules<'repo>(
    repository: &'repo RepositoryPath,
    index: &gix::index::State,
) -> Result<gix::AttributeStack<'repo>, GitFailure> {
    repository
        .repo
        .excludes(
            index,
            None,
            gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
        )
        .map_err(|error| internal_failure("read Git ignore rules", error))
}

/// True when an ignore rule matches the directory or one of its parents and Git tracks
/// nothing inside it, so every entry is ignored and the walk can be skipped. Tracked files
/// inside an ignored directory still have a status, so such a directory is walked.
fn is_wholly_ignored(repository: &RepositoryPath, directory: &str) -> Result<bool, GitFailure> {
    if directory.is_empty() {
        return Ok(false);
    }
    let index = open_index(repository)?;
    let prefix = format!("{directory}/");
    if index
        .prefixed_entries(prefix.as_bytes().as_bstr())
        .is_some_and(|entries| !entries.is_empty())
    {
        return Ok(false);
    }
    let mut excludes = ignore_rules(repository, &index)?;
    // Git does not look inside an excluded directory, so a rule on any parent covers it.
    let mut end = 0;
    for component in directory.split('/') {
        end += component.len();
        let ancestor = &directory[..end];
        end += 1;
        let excluded = excludes
            .at_entry(ancestor, Some(gix::index::entry::Mode::DIR))
            .map_err(|error| internal_failure("match Git ignore rules", error))?
            .is_excluded();
        if excluded {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The kind of one changed path below a child directory, as it is counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DescendantKind {
    Untracked,
    Changed,
    Conflicted,
}

impl DescendantKind {
    /// Classifies one status item of a descendant, or `None` for ignored paths, which are
    /// expected inside most trees and do not make a directory look changed.
    fn of(item: &gix::status::Item) -> Option<Self> {
        use gix::status::index_worktree::iter::Summary;
        if is_ignored_item(item) {
            return None;
        }
        Some(match item {
            gix::status::Item::TreeIndex(_) => Self::Changed,
            gix::status::Item::IndexWorktree(change) => match change.summary() {
                Some(Summary::Conflict) => Self::Conflicted,
                Some(Summary::Added) if is_directory_contents(change) => Self::Untracked,
                _ => Self::Changed,
            },
        })
    }

    /// The public name of this kind for the most severe change of a directory.
    fn public(self) -> GitDescendantChange {
        match self {
            Self::Untracked => GitDescendantChange::Untracked,
            Self::Changed => GitDescendantChange::Changed,
            Self::Conflicted => GitDescendantChange::Conflicted,
        }
    }
}

/// True for a dirwalk entry, which is how gix reports untracked and ignored paths.
fn is_directory_contents(change: &gix::status::index_worktree::Item) -> bool {
    matches!(
        change,
        gix::status::index_worktree::Item::DirectoryContents { .. }
    )
}

/// What the walk reported for one direct child of the browsed directory.
#[derive(Default)]
struct ChildState {
    /// Items about the child path itself: a file, a symlink, a submodule, or a directory
    /// gix reported as a whole because it is ignored or untracked.
    own: Option<StatusAccumulator>,
    /// The most severe change below the child, kept even past the counting bound so the mark
    /// stays right in a huge tree.
    most_severe: Option<DescendantKind>,
    /// True once a descendant could not be told apart because of the counting bound.
    truncated: bool,
}

/// Folds the status items of a walk into the direct children of the browsed directory.
struct ChildStates {
    /// The browsed directory's repository-relative path with a trailing slash, or empty at
    /// the repository root.
    prefix: Vec<u8>,
    /// One state per child with any status, so memory follows the listing size.
    children: BTreeMap<String, ChildState>,
    /// Descendant paths already counted, with their child and kind. The two sides of the
    /// comparison report a path separately, so counting needs to know which were seen; the
    /// set is bounded by [`MAX_GIT_DIRECTORY_COUNTED_CHANGES`].
    descendants: HashMap<Vec<u8>, (String, DescendantKind)>,
    /// True when gix reported the browsed directory itself, or a parent, as one untracked
    /// entry, which names none of the children.
    wholly_untracked: bool,
}

impl ChildStates {
    /// Starts empty for the directory at repository-relative `directory`.
    fn new(directory: &str) -> Self {
        let prefix = if directory.is_empty() {
            Vec::new()
        } else {
            format!("{directory}/").into_bytes()
        };
        Self {
            prefix,
            children: BTreeMap::new(),
            descendants: HashMap::new(),
            wholly_untracked: false,
        }
    }

    /// Attributes one status item to the child it lies in.
    fn record(&mut self, item: gix::status::Item) {
        let location = item.location().to_vec();
        if self.contains_browsed_directory(&location) {
            if !is_ignored_item(&item) {
                self.wholly_untracked = true;
            }
            return;
        }
        self.record_rename_source(&item);
        let Some((name, below_child)) = self.child_of(&location) else {
            return;
        };
        if !below_child {
            self.children
                .entry(name)
                .or_default()
                .own
                .get_or_insert_with(StatusAccumulator::default)
                .apply(item);
            return;
        }
        let Some(kind) = DescendantKind::of(&item) else {
            return;
        };
        self.count_descendant(location, name, kind);
    }

    /// Counts a staged rename's source toward the directory it left. gix reports a rename
    /// only at its destination, so without this a directory a file moved out of looks clean.
    /// A source directly in the browsed directory is skipped: it no longer has a row.
    fn record_rename_source(&mut self, item: &gix::status::Item) {
        let gix::status::Item::TreeIndex(gix::diff::index::Change::Rewrite {
            source_location, ..
        }) = item
        else {
            return;
        };
        let location = source_location.to_vec();
        if let Some((name, true)) = self.child_of(&location) {
            self.count_descendant(location, name, DescendantKind::Changed);
        }
    }

    /// Names the direct child `location` lies in and whether it lies below that child,
    /// or `None` when it is outside the browsed directory or the name is not UTF-8.
    fn child_of(&self, location: &[u8]) -> Option<(String, bool)> {
        // The pathspec keeps the walk inside the directory; anything else is not ours.
        let relative = location.strip_prefix(self.prefix.as_slice())?;
        let (name, below_child) = match relative.find_byte(b'/') {
            Some(slash) => (&relative[..slash], slash + 1 < relative.len()),
            None => (relative, false),
        };
        // Listings name entries in UTF-8, so a name that is not cannot match a row.
        let name = name.to_str().ok()?;
        (!name.is_empty()).then(|| (name.to_string(), below_child))
    }

    /// Counts one changed path below the child `name`, keeping the most severe kind.
    fn count_descendant(&mut self, location: Vec<u8>, name: String, kind: DescendantKind) {
        let child = self.children.entry(name.clone()).or_default();
        child.most_severe = child.most_severe.max(Some(kind));
        let full = self.descendants.len() >= MAX_GIT_DIRECTORY_COUNTED_CHANGES;
        match self.descendants.entry(location) {
            Entry::Occupied(mut seen) => {
                let counted = &mut seen.get_mut().1;
                *counted = (*counted).max(kind);
            }
            Entry::Vacant(_) if full => child.truncated = true,
            Entry::Vacant(slot) => {
                slot.insert((name, kind));
            }
        }
    }

    /// True when `location` is the browsed directory or one of its parents, which gix only
    /// reports when it collapsed the whole directory into one entry.
    fn contains_browsed_directory(&self, location: &[u8]) -> bool {
        !self.prefix.is_empty()
            && self
                .prefix
                .strip_prefix(location)
                .is_some_and(|rest| rest.first() == Some(&b'/'))
    }

    /// Builds the answer, sorted by name, with the counts of every child directory.
    fn into_response(self, root: &Path) -> GitDirectoryEntriesResponse {
        let mut counts: HashMap<String, [u32; 3]> = HashMap::new();
        for (child, kind) in self.descendants.into_values() {
            let count = counts.entry(child).or_default();
            count[kind as usize] = count[kind as usize].saturating_add(1);
        }
        let entries = self
            .children
            .into_iter()
            .filter_map(|(name, child)| {
                let state = match (child.own, child.most_severe) {
                    (Some(own), _) if own.is_ignored() => GitDirectoryEntryState::Ignored,
                    (Some(own), _) if own.is_untracked() => GitDirectoryEntryState::Untracked,
                    (Some(own), _) => GitDirectoryEntryState::Changed {
                        index_state: own.index_state,
                        worktree_state: own.worktree_state,
                        conflicted: own.conflict_state.is_some(),
                        original_path: own
                            .original_path()
                            .map(|original| root.join(original).display().to_string()),
                    },
                    (None, Some(most_severe)) => {
                        let [untracked, changed, conflicted] =
                            counts.get(&name).copied().unwrap_or_default();
                        GitDirectoryEntryState::ContainsChanges(GitDirectoryChanges {
                            most_severe: most_severe.public(),
                            changed,
                            untracked,
                            conflicted,
                            truncated: child.truncated,
                        })
                    }
                    (None, None) => return None,
                };
                Some(GitDirectoryEntry { name, state })
            })
            .collect();
        GitDirectoryEntriesResponse::Entries { entries }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
    use redoor_protocol::api::git::GitChangeState;
    use std::process::Command;

    /// Runs git in `dir` with a fixed identity, so fixtures do not depend on the host config.
    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// Writes `contents` to `relative` below `root`, creating parent directories.
    fn write(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// Reads the entries of `relative` below the repository at `root` without a budget.
    fn entries_of(root: &Path, relative: &str) -> GitDirectoryEntriesResponse {
        let path = root.join(relative).display().to_string();
        entries_blocking(&path, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// The listed state of `name`, failing when the answer is not a list of entries.
    fn state_of(
        response: &GitDirectoryEntriesResponse,
        name: &str,
    ) -> Option<GitDirectoryEntryState> {
        let GitDirectoryEntriesResponse::Entries { entries } = response else {
            panic!("expected entries, got {response:?}");
        };
        entries
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.state.clone())
    }

    /// A committed repository whose worktree then gets every kind of change.
    fn fixture() -> TempDir {
        let temp = TempDir::create();
        let root = temp.path();
        git(root, &["init", "-q"]);
        write(
            root,
            ".gitignore",
            "node_modules/
*.log
",
        );
        write(root, "clean.txt", "clean");
        write(root, "modified.txt", "one");
        write(root, "staged.txt", "one");
        write(root, "partly.txt", "one");
        write(
            root,
            "old-name.txt",
            "renamed contents that are long enough",
        );
        write(root, "src/lib.rs", "one");
        write(root, "src/deep/mod.rs", "one");
        write(root, "docs/readme.md", "one");
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "initial"]);

        write(root, "modified.txt", "two");
        write(root, "staged.txt", "two");
        git(root, &["add", "staged.txt"]);
        write(root, "partly.txt", "two");
        git(root, &["add", "partly.txt"]);
        write(root, "partly.txt", "three");
        git(root, &["mv", "old-name.txt", "new-name.txt"]);
        write(root, "added.txt", "new");
        git(root, &["add", "added.txt"]);
        write(root, "untracked.txt", "new");
        write(root, "debug.log", "ignored");
        write(root, "node_modules/pkg/index.js", "ignored");
        write(root, "src/lib.rs", "two");
        write(root, "src/deep/mod.rs", "two");
        write(root, "src/deep/new.rs", "new");
        write(root, "src/fresh/a.rs", "new");
        write(root, "src/fresh/b.rs", "new");
        write(root, "src/trace.log", "ignored");
        write(root, "docs/notes.md", "new");
        write(root, "brand-new/a.txt", "new");
        temp
    }

    /// Changed files report both sides of the comparison and clean files are left out.
    #[test]
    fn files_report_their_own_state() {
        let repo = fixture();
        let response = entries_of(repo.path(), "");

        // A clean tracked file has no symbol, so it is not in the answer at all.
        assert_eq!(state_of(&response, "clean.txt"), None);
        // An unstaged edit is a worktree-side modification.
        assert!(matches!(
            state_of(&response, "modified.txt"),
            Some(GitDirectoryEntryState::Changed {
                index_state: GitChangeState::Unmodified,
                worktree_state: GitChangeState::Modified,
                ..
            })
        ));
        // A staged edit is an index-side modification.
        assert!(matches!(
            state_of(&response, "staged.txt"),
            Some(GitDirectoryEntryState::Changed {
                index_state: GitChangeState::Modified,
                worktree_state: GitChangeState::Unmodified,
                ..
            })
        ));
        // A file edited again after staging has both sides, which reads "partly staged".
        assert!(matches!(
            state_of(&response, "partly.txt"),
            Some(GitDirectoryEntryState::Changed {
                index_state: GitChangeState::Modified,
                worktree_state: GitChangeState::Modified,
                ..
            })
        ));
        // A staged new file is an addition, not an untracked file.
        assert!(matches!(
            state_of(&response, "added.txt"),
            Some(GitDirectoryEntryState::Changed {
                index_state: GitChangeState::Added,
                ..
            })
        ));
        // A staged rename names where it came from, as an absolute path the browser can show.
        assert_eq!(
            state_of(&response, "new-name.txt"),
            Some(GitDirectoryEntryState::Changed {
                index_state: GitChangeState::Renamed,
                worktree_state: GitChangeState::Unmodified,
                conflicted: false,
                original_path: Some(repo.path().join("old-name.txt").display().to_string()),
            })
        );
        // The rename source is gone from the listing, so it gets no row of its own.
        assert_eq!(state_of(&response, "old-name.txt"), None);
        // New and ignored files are told apart.
        assert_eq!(
            state_of(&response, "untracked.txt"),
            Some(GitDirectoryEntryState::Untracked)
        );
        assert_eq!(
            state_of(&response, "debug.log"),
            Some(GitDirectoryEntryState::Ignored)
        );
    }

    /// Directories show their own whole-directory state or a summary of what they contain.
    #[test]
    fn directories_aggregate_their_descendants() {
        let repo = fixture();
        let response = entries_of(repo.path(), "");

        // An ignored directory is ignored as a whole, without counting what is inside.
        assert_eq!(
            state_of(&response, "node_modules"),
            Some(GitDirectoryEntryState::Ignored)
        );
        // A directory with only new files is untracked as a whole, like `git status` shows it.
        assert_eq!(
            state_of(&response, "brand-new"),
            Some(GitDirectoryEntryState::Untracked)
        );
        // Changes at any depth count towards the child they lie in; ignored ones do not, and
        // a wholly untracked subdirectory counts once.
        assert_eq!(
            state_of(&response, "src"),
            Some(GitDirectoryEntryState::ContainsChanges(
                GitDirectoryChanges {
                    most_severe: GitDescendantChange::Changed,
                    changed: 2,
                    untracked: 2,
                    conflicted: 0,
                    truncated: false,
                }
            ))
        );
        // Only new files inside makes the mark say so rather than "changed".
        assert!(matches!(
            state_of(&response, "docs"),
            Some(GitDirectoryEntryState::ContainsChanges(
                GitDirectoryChanges {
                    most_severe: GitDescendantChange::Untracked,
                    untracked: 1,
                    ..
                }
            ))
        ));
    }

    /// A directory a file was renamed out of still shows that it changed.
    #[test]
    fn rename_marks_the_directory_it_left() {
        let temp = TempDir::create();
        let root = temp.path();
        git(root, &["init", "-q"]);
        write(
            root,
            "from/moved.txt",
            "contents long enough to be a rename",
        );
        write(root, "from/kept.txt", "kept");
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "initial"]);
        std::fs::create_dir(root.join("to")).unwrap();
        git(root, &["mv", "from/moved.txt", "to/moved.txt"]);

        let response = entries_of(root, "");

        // gix reports the rename only at its destination, so without counting the source
        // the directory the file left would look clean.
        assert!(matches!(
            state_of(&response, "from"),
            Some(GitDirectoryEntryState::ContainsChanges(
                GitDirectoryChanges {
                    most_severe: GitDescendantChange::Changed,
                    changed: 1,
                    ..
                }
            ))
        ));
        // The destination directory is marked as before.
        assert!(matches!(
            state_of(&response, "to"),
            Some(GitDirectoryEntryState::ContainsChanges(_))
        ));
    }

    /// A subdirectory is walked on its own and its children are named relative to it.
    #[test]
    fn subdirectories_are_scoped() {
        let repo = fixture();
        let response = entries_of(repo.path(), "src");

        // Entries are keyed by their name in the browsed directory.
        assert!(matches!(
            state_of(&response, "lib.rs"),
            Some(GitDirectoryEntryState::Changed { .. })
        ));
        // An ignored file deeper in the tree shows as ignored where it is listed.
        assert_eq!(
            state_of(&response, "trace.log"),
            Some(GitDirectoryEntryState::Ignored)
        );
        assert_eq!(
            state_of(&response, "fresh"),
            Some(GitDirectoryEntryState::Untracked)
        );
        // Changes outside the browsed directory never leak into it.
        assert_eq!(state_of(&response, "modified.txt"), None);
    }

    /// The pathspec keeps a sibling sharing the directory's name prefix out of the walk.
    #[test]
    fn sibling_with_the_same_prefix_is_not_walked() {
        let repo = fixture();
        write(repo.path(), "src-old/x.txt", "new");

        let response = entries_of(repo.path(), "src");

        // `src-old/x.txt` must not be read as a child `-old` or similar of `src`.
        let GitDirectoryEntriesResponse::Entries { entries } = &response else {
            panic!("expected entries");
        };
        assert!(entries.iter().all(|entry| !entry.name.contains("x.txt")));
        assert!(entries.iter().all(|entry| entry.name != "src-old"));
    }

    /// Inside a wholly untracked directory every entry is reported untracked, even though
    /// gix collapses such a directory into one entry when it is reached from above.
    #[test]
    fn untracked_directory_lists_its_entries() {
        let repo = fixture();
        write(repo.path(), "brand-new/nested/b.txt", "new");
        write(repo.path(), "brand-new/skip.log", "ignored");

        let response = entries_of(repo.path(), "brand-new");

        // Each entry of the browsed directory gets the state of its own row.
        assert_eq!(
            state_of(&response, "a.txt"),
            Some(GitDirectoryEntryState::Untracked)
        );
        assert_eq!(
            state_of(&response, "nested"),
            Some(GitDirectoryEntryState::Untracked)
        );
        // An ignored file inside the untracked directory is still told apart.
        assert_eq!(
            state_of(&response, "skip.log"),
            Some(GitDirectoryEntryState::Ignored)
        );
    }

    /// A directory whose files are all ignored by its own `.gitignore`, next to empty
    /// directories, is ignored as a whole like `git status --ignored` shows it.
    #[test]
    fn directory_holding_only_ignored_files_and_empty_directories_is_ignored() {
        let repo = fixture();
        write(
            repo.path(),
            "tool/.gitignore",
            "package.json
.gitignore
",
        );
        write(repo.path(), "tool/package.json", "{}");
        std::fs::create_dir_all(repo.path().join("tool/skills/empty")).unwrap();

        let response = entries_of(repo.path(), "");

        // Git ignores empty directories, so nothing in it is left to be untracked.
        assert_eq!(
            state_of(&response, "tool"),
            Some(GitDirectoryEntryState::Ignored)
        );
    }

    /// Inside an ignored directory every entry is ignored, answered without a walk.
    #[test]
    fn ignored_directory_is_answered_without_walking() {
        let repo = fixture();

        // The browsed directory itself matches an ignore rule.
        assert_eq!(
            entries_of(repo.path(), "node_modules"),
            GitDirectoryEntriesResponse::Ignored
        );
        // A rule on a parent covers every directory below it as Git does.
        assert_eq!(
            entries_of(repo.path(), "node_modules/pkg"),
            GitDirectoryEntriesResponse::Ignored
        );
    }

    /// The ignored-directory shortcut never hides a tracked file inside it.
    #[test]
    fn ignored_directory_with_tracked_files_is_walked() {
        let repo = fixture();
        write(repo.path(), "vendor/kept.txt", "one");
        write(
            repo.path(),
            ".gitignore",
            "node_modules/
*.log
vendor/
",
        );
        git(repo.path(), &["add", "-f", "vendor/kept.txt"]);
        git(repo.path(), &["commit", "-q", "-m", "vendor"]);
        write(repo.path(), "vendor/kept.txt", "two");

        let response = entries_of(repo.path(), "vendor");

        // A force-added file keeps a status even though its directory is ignored.
        assert!(matches!(
            state_of(&response, "kept.txt"),
            Some(GitDirectoryEntryState::Changed { .. })
        ));
    }

    /// An ignored directory reaches the fold as one collapsed entry, not one per file, which
    /// is what keeps a large ignored tree cheap.
    #[test]
    fn ignored_directories_are_collapsed_by_gix() {
        let repo = fixture();
        for index in 0..50 {
            write(repo.path(), &format!("node_modules/many/{index}.js"), "x");
        }
        let repository = discover_repository(repo.path().to_path_buf())
            .unwrap()
            .unwrap();
        let mut ignored = Vec::new();
        StatusWalk {
            patterns: Vec::new(),
            untracked: gix::status::UntrackedFiles::Collapsed,
            renames: gix::status::tree_index::TrackRenames::Disabled,
        }
        .run(&repository.repo, Arc::new(AtomicBool::new(false)), |item| {
            if is_ignored_item(&item) {
                ignored.push(item.location().to_string());
            }
        })
        .unwrap();

        // gix stops at the directory the rule matched instead of listing its 51 files.
        assert!(
            ignored.iter().any(|path| path == "node_modules"),
            "{ignored:?}"
        );
        assert!(
            ignored
                .iter()
                .all(|path| !path.starts_with("node_modules/")),
            "{ignored:?}"
        );
    }

    /// Conflicts are the most severe state for files and for the directories above them.
    #[test]
    fn conflicts_outrank_other_changes() {
        let temp = TempDir::create();
        let root = temp.path();
        git(root, &["init", "-q", "--initial-branch=main"]);
        write(root, "dir/conflict.txt", "base");
        write(root, "dir/other.txt", "base");
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "base"]);
        git(root, &["checkout", "-q", "-b", "side"]);
        write(root, "dir/conflict.txt", "side");
        git(root, &["commit", "-q", "-am", "side"]);
        git(root, &["checkout", "-q", "main"]);
        write(root, "dir/conflict.txt", "main");
        git(root, &["commit", "-q", "-am", "main"]);
        let merge = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "merge", "side"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(!merge.status.success(), "the merge must conflict");
        write(root, "dir/other.txt", "edited");

        let inside = entries_of(root, "dir");
        // The conflicted file itself says so.
        assert!(matches!(
            state_of(&inside, "conflict.txt"),
            Some(GitDirectoryEntryState::Changed {
                conflicted: true,
                ..
            })
        ));

        let above = entries_of(root, "");
        // The directory shows the conflict even though it also holds a plain edit.
        assert_eq!(
            state_of(&above, "dir"),
            Some(GitDirectoryEntryState::ContainsChanges(
                GitDirectoryChanges {
                    most_severe: GitDescendantChange::Conflicted,
                    changed: 1,
                    untracked: 0,
                    conflicted: 1,
                    truncated: false,
                }
            ))
        );
    }

    /// A directory outside any repository has no Git state, which is not an error.
    #[test]
    fn outside_a_worktree_is_not_an_error() {
        let temp = TempDir::create();
        // Keeps discovery from finding a repository that encloses the temp directory.
        let ceiling = temp.path().join("plain");
        std::fs::create_dir(&ceiling).unwrap();
        let response = entries_blocking(
            &ceiling.display().to_string(),
            Arc::new(AtomicBool::new(false)),
        );
        // Hosts that keep their temp directory inside a checkout would see that checkout.
        if discover_repository(ceiling.clone()).unwrap().is_none() {
            assert_eq!(
                response.unwrap(),
                GitDirectoryEntriesResponse::OutsideWorktree
            );
        }
    }

    /// Past the counting bound the mark stays right and the counts say they are partial.
    #[test]
    fn counting_is_bounded_without_losing_the_mark() {
        let mut states = ChildStates::new("");
        states.descendants = (0..MAX_GIT_DIRECTORY_COUNTED_CHANGES)
            .map(|index| {
                let path = format!("full/{index}").into_bytes();
                (path, ("full".to_string(), DescendantKind::Untracked))
            })
            .collect();
        states.children.insert(
            "full".to_string(),
            ChildState {
                most_severe: Some(DescendantKind::Untracked),
                ..ChildState::default()
            },
        );
        // What `record` leaves for a child whose only change came after the bound.
        states.children.insert(
            "late".to_string(),
            ChildState {
                most_severe: Some(DescendantKind::Changed),
                truncated: true,
                ..ChildState::default()
            },
        );

        let response = states.into_response(Path::new("/"));

        // A child first seen after the bound still shows its most severe change.
        assert_eq!(
            state_of(&response, "late"),
            Some(GitDirectoryEntryState::ContainsChanges(
                GitDirectoryChanges {
                    most_severe: GitDescendantChange::Changed,
                    changed: 0,
                    untracked: 0,
                    conflicted: 0,
                    truncated: true,
                }
            ))
        );
        // The counted child keeps its counts.
        assert!(matches!(
            state_of(&response, "full"),
            Some(GitDirectoryEntryState::ContainsChanges(GitDirectoryChanges { untracked, .. }))
                if untracked as usize == MAX_GIT_DIRECTORY_COUNTED_CHANGES
        ));
    }

    /// A canceled request answers at once without taking a slot.
    #[tokio::test]
    async fn canceled_request_answers_without_walking() {
        let cancel = CancellationToken::new();
        cancel.cancel();

        let response = entries("/".to_string(), &cancel).await.unwrap();

        // Nobody waits for the answer, so nothing is reported.
        assert_eq!(
            response,
            GitDirectoryEntriesResponse::Entries {
                entries: Vec::new()
            }
        );
        // The queue is untouched, so directories someone still looks at get every slot.
        assert_eq!(
            DIRECTORY_ENTRIES_PERMITS.available_permits(),
            DIRECTORY_ENTRIES_SLOTS
        );
    }

    /// A walk still queued at the deadline answers `TimedOut` instead of waiting on.
    #[tokio::test(start_paused = true)]
    async fn budget_exhaustion_answers_timed_out() {
        // A queue without free slots keeps the walk waiting, standing in for a walk that
        // runs long; a queue of its own keeps the shared one free for parallel tests.
        let permits = Semaphore::new(0);
        let started = Instant::now();

        let response = walk_within_budget("/".to_string(), &permits, Duration::from_secs(30))
            .await
            .unwrap();

        // The browser learns that the walk did not finish rather than seeing a clean tree.
        assert_eq!(response, GitDirectoryEntriesResponse::TimedOut);
        // The answer comes at the budget, not whenever a slot would free up.
        assert_eq!(started.elapsed(), Duration::from_secs(30));
    }
}
