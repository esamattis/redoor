//! What one commit changed: its tree compared with its first parent's, below one path. A
//! range compares its newer end with its start instead, so several commits read as one, and
//! a symmetric range `A...B` compares A with an in-memory merge of B into A, so a branch shows
//! exactly what merging it now would change.

use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use gix::bstr::ByteSlice;

use redoor_core::log;
use redoor_protocol::{
    api::git::{
        GitChangeState, GitDiffResult,
        commit::{GitCommitDiffResponse, GitCommitFileChange, GitCommitRange},
        worktree::GitDiffRequest,
    },
    wire::{command::CommandErrorKind, log::Level, request::CommandError},
};

use super::{
    GitFailure,
    diff::{DiffBudget, DiffSource, read_object_blob},
    internal_failure,
    revision::{RangeSides, RevisionBase, RevisionPath, commit_summary, tree_entry},
    run_blocking,
};

/// How long the merge of a symmetric range may take before the diff falls back to the merge
/// base. Merges of huge or wildly diverged histories can take long, and a diff that never
/// arrives is worse than the slightly noisier merge-base diff.
const MERGE_PREVIEW_BUDGET: Duration = Duration::from_secs(10);
/// Object cache for the merge, which reads the same trees on both sides of it. Small, because
/// agents may run with little memory, but enough to keep the trees of a typical change.
const MERGE_OBJECT_CACHE_BYTES: usize = 4 * 1024 * 1024;
/// Blobs larger than this are treated as binary by the merge preview instead of being loaded
/// and merged, and loading one anyway fails the merge. The repository's `core.bigFileThreshold`
/// defaults to 512 MiB, far more than a memory-constrained agent can hold for a few files at
/// once just to open a comparison.
const MERGE_PREVIEW_BLOB_BYTES: u64 = 16 * 1024 * 1024;
/// How many bytes of blobs the merge preview may load in total. Rename detection keeps every
/// blob it compared in its cache until the merge ends, so many blobs below the per-blob limit
/// could still exhaust a memory-constrained agent; a merge that needs more falls back instead.
const MERGE_PREVIEW_READ_BYTES: u64 = 256 * 1024 * 1024;
/// How many bytes of merged blobs the preview may write into the handle's object memory, where
/// they stay until the diff is done. A merge that needs more fails and falls back to the merge
/// base, so many medium-sized merged files cannot exhaust a memory-constrained agent either.
const MERGE_PREVIEW_WRITE_BYTES: u64 = 64 * 1024 * 1024;

/// Bounds on a merge preview's time and memory, past which it falls back to the merge base.
/// They are values rather than constants so tests can make a merge exceed them without a slow
/// or huge repository.
#[derive(Clone, Copy)]
struct MergeLimits {
    deadline: Instant,
    /// Largest blob the merge loads.
    blob_bytes: u64,
    /// Most blob bytes the merge loads in total.
    read_bytes: u64,
    /// Most bytes of merged blobs the merge writes into object memory.
    write_bytes: u64,
}

impl MergeLimits {
    /// The limits of a merge preview that starts now.
    fn starting_now() -> Self {
        Self {
            deadline: Instant::now() + MERGE_PREVIEW_BUDGET,
            blob_bytes: MERGE_PREVIEW_BLOB_BYTES,
            read_bytes: MERGE_PREVIEW_READ_BYTES,
            write_bytes: MERGE_PREVIEW_WRITE_BYTES,
        }
    }

    /// The size above which the merge treats a blob as binary: the repository's configured
    /// threshold where it is smaller, since a repository may want less loaded, but never more
    /// than the preview's own limit. A configured 0 means unlimited, so the limit applies.
    fn blob_threshold(&self, configured: u64) -> u64 {
        if configured == 0 {
            self.blob_bytes
        } else {
            configured.min(self.blob_bytes)
        }
    }
}

/// One side of a changed file: its mode and object, or nothing when the side lacks the file.
type Side = Option<(gix::objs::tree::EntryMode, gix::ObjectId)>;

/// One changed file before its patch is formatted.
struct FileChange {
    relative: String,
    old: Side,
    new: Side,
}

/// The two trees a commit diff compares, and what the response says about how they were
/// chosen.
struct Comparison<'repo> {
    /// The commit reported as compared with: the first parent, a range's start, A of a merge
    /// preview, or the merge base it fell back to.
    parent: Option<gix::Commit<'repo>>,
    old_root: Option<gix::Tree<'repo>>,
    new_root: gix::Tree<'repo>,
    /// Repository-relative paths the merge preview could not merge cleanly, each with why, in
    /// words for the user.
    conflicted: HashMap<String, String>,
    merge_preview: bool,
}

/// Diffs the commit a revision names against its first parent, or a range's newer end
/// against its start, below one path.
pub(crate) async fn commit_diff(
    path: String,
    rev: String,
) -> Result<GitCommitDiffResponse, CommandError> {
    run_blocking(move |interrupt| {
        commit_diff_blocking(&path, &rev, &interrupt, MergeLimits::starting_now())
    })
    .await
}

/// Collects the changed files, then formats each within the shared batch budget.
///
/// `merge_limits` bound a symmetric range's merge.
fn commit_diff_blocking(
    path: &str,
    rev: &str,
    interrupt: &AtomicBool,
    merge_limits: MergeLimits,
) -> Result<GitCommitDiffResponse, GitFailure> {
    let target = RevisionPath::open(path, rev)?;
    // A merge preview writes merged blobs and trees. Keeping writes in this handle's memory
    // leaves the repository's object database untouched, since viewing must never change
    // the repository, and every read below goes through the same handle so the diff sees them.
    let mut repo = target.repository.repo.clone().with_object_memory();
    repo.object_cache_size_if_unset(MERGE_OBJECT_CACHE_BYTES);
    let repo = &repo;
    let commit = repo
        .find_commit(target.commit_id)
        .map_err(|error| internal_failure("read Git commit", error))?;
    let comparison = compare(repo, &target, &commit, rev, interrupt, merge_limits)?;

    let mut changes = collect_changes(
        repo,
        &target.relative,
        comparison.old_root.as_ref(),
        &comparison.new_root,
        interrupt,
    )?;
    // Collection stops one change past the limit, so this keeps the files the traversal met
    // first and orders only those.
    let truncated = changes.len() > GitDiffRequest::MAX_FILES;
    changes.truncate(GitDiffRequest::MAX_FILES);
    changes.sort_by(|left, right| left.relative.cmp(&right.relative));

    let mut budget = DiffBudget::new();
    let mut files = Vec::with_capacity(changes.len());
    for change in changes {
        if interrupt.load(Ordering::Acquire) {
            return Err(GitFailure::new(
                CommandErrorKind::Canceled,
                "Git commit diff was canceled",
            ));
        }
        let result = if change.relative.chars().any(char::is_control) {
            GitDiffResult::UnsupportedEntry
        } else {
            budget.compare(
                side_source(repo, change.old)?,
                side_source(repo, change.new)?,
                &change.relative,
            )?
        };
        files.push(GitCommitFileChange {
            path: target.worktree_path(&change.relative).display().to_string(),
            change: change_state(change.old, change.new),
            conflicted: comparison.conflicted.contains_key(&change.relative),
            conflict_reason: comparison.conflicted.get(&change.relative).cloned(),
            repository_relative_path: change.relative,
            result,
        });
    }
    let truncated =
        add_unlisted_conflicts(&target, &comparison.conflicted, &mut files) || truncated;

    let range = match target.base {
        RevisionBase::FirstParent => None,
        RevisionBase::Commit(_) | RevisionBase::Empty => Some(GitCommitRange {
            base: comparison.parent.as_ref().map(commit_summary).transpose()?,
            merge_base: false,
            merge_preview: false,
        }),
        // The merge base is named even when A is what the diff compared with, because it is
        // where the branch split off and the history-style diff starts there.
        RevisionBase::MergeBase { base, .. } => Some(GitCommitRange {
            base: Some(commit_summary(&find_commit(repo, base)?)?),
            merge_base: true,
            merge_preview: comparison.merge_preview,
        }),
    };

    Ok(GitCommitDiffResponse {
        commit: commit_summary(&commit)?,
        body: commit_body(&commit)?,
        parent_id: comparison.parent.map(|parent| parent.id.to_string()),
        range,
        repository_root: target.repository.root.display().to_string(),
        repository_relative_path: target.relative.clone(),
        files,
        truncated,
    })
}

/// Chooses the trees to compare for the revision's kind.
///
/// Merges are shown against their first parent, the branch they were merged into, and a
/// range against its start, so its commits read as one change. A symmetric range is shown as
/// a merge preview, falling back to its merge base when the merge fails or runs out of time.
fn compare<'repo>(
    repo: &'repo gix::Repository,
    target: &RevisionPath,
    commit: &gix::Commit<'repo>,
    rev: &str,
    interrupt: &AtomicBool,
    merge_limits: MergeLimits,
) -> Result<Comparison<'repo>, GitFailure> {
    let commit_tree = commit
        .tree()
        .map_err(|error| internal_failure("read Git commit tree", error))?;
    let parent_id = match target.base {
        RevisionBase::FirstParent => commit.parent_ids().next().map(gix::Id::detach),
        RevisionBase::Commit(id) => Some(id),
        RevisionBase::Empty => None,
        RevisionBase::MergeBase { base, left } => {
            let preview = MergePreview {
                repo,
                limits: merge_limits,
                read: Cell::new(0),
                interrupt,
            };
            match preview.merge(base, left, target.commit_id, rev) {
                Ok((merged_tree, conflicted)) => {
                    let parent = find_commit(repo, left)?;
                    return Ok(Comparison {
                        old_root: Some(commit_tree_of(&parent)?),
                        parent: Some(parent),
                        new_root: repo
                            .find_tree(merged_tree)
                            .map_err(|error| internal_failure("read merged Git tree", error))?,
                        conflicted,
                        merge_preview: true,
                    });
                }
                Err(error) => {
                    if interrupt.load(Ordering::Acquire) {
                        return Err(GitFailure::new(
                            CommandErrorKind::Canceled,
                            "Git commit diff was canceled",
                        ));
                    }
                    // Rare enough that a log line is all the diagnosis it gets; the view
                    // only says that it shows the merge-base diff instead.
                    log!(
                        Level::Warning,
                        "Git merge preview fell back to the merge base: rev={rev} error={error}"
                    );
                    Some(base)
                }
            }
        }
    };
    let parent = parent_id.map(|id| find_commit(repo, id)).transpose()?;
    let old_root = parent.as_ref().map(commit_tree_of).transpose()?;
    Ok(Comparison {
        parent,
        old_root,
        new_root: commit_tree,
        conflicted: HashMap::new(),
        merge_preview: false,
    })
}

/// Lists the conflicts the diff did not, and reports whether any were left out for lack of
/// room.
///
/// A conflict can resolve to exactly A's version, for example when A changed a file the branch
/// deleted and the merge keeps A's change. Comparing A with the merge then shows no change at
/// that path, so without its own row the user would never learn that merging conflicts there.
/// Such rows count as unmodified with no diff; their reason says what conflicts.
fn add_unlisted_conflicts(
    target: &RevisionPath,
    conflicted: &HashMap<String, String>,
    files: &mut Vec<GitCommitFileChange>,
) -> bool {
    let listed: HashSet<String> = files
        .iter()
        .map(|file| file.repository_relative_path.clone())
        .collect();
    let mut unlisted: Vec<_> = conflicted
        .iter()
        .filter(|(path, _)| is_below(&target.relative, path) && !listed.contains(*path))
        .collect();
    if unlisted.is_empty() {
        return false;
    }
    unlisted.sort();
    let mut truncated = false;
    for (path, reason) in unlisted {
        if files.len() >= GitDiffRequest::MAX_FILES {
            truncated = true;
            break;
        }
        files.push(GitCommitFileChange {
            path: target.worktree_path(path).display().to_string(),
            repository_relative_path: path.clone(),
            change: GitChangeState::Unmodified,
            result: GitDiffResult::NoChanges,
            conflicted: true,
            conflict_reason: Some(reason.clone()),
        });
    }
    files.sort_by(|left, right| {
        left.repository_relative_path
            .cmp(&right.repository_relative_path)
    });
    truncated
}

/// Tells whether a repository-relative path lies at or below the browsed path, since the diff
/// only covers that part of the repository.
fn is_below(relative: &str, path: &str) -> bool {
    relative.is_empty()
        || path
            .strip_prefix(relative)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// Reads a commit the diff compares with.
fn find_commit(repo: &gix::Repository, id: gix::ObjectId) -> Result<gix::Commit<'_>, GitFailure> {
    repo.find_commit(id)
        .map_err(|error| internal_failure("read Git parent commit", error))
}

/// Reads the tree of a commit the diff compares with.
fn commit_tree_of<'repo>(commit: &gix::Commit<'repo>) -> Result<gix::Tree<'repo>, GitFailure> {
    commit
        .tree()
        .map_err(|error| internal_failure("read Git parent tree", error))
}

/// Merges the sides of a symmetric range like `git merge-tree --write-tree A B`, within a
/// time budget and only into the repository handle's object memory.
///
/// It also serves as the object store the merge reads through, so every object read checks
/// the deadline, the request's cancellation and the blob size limits. gix has no other way to
/// stop a merge midway, and reads happen throughout it, so a slow merge ends soon after its
/// budget runs out. Rename detection and blob merges read through it too, which makes it the
/// one place that sees every blob loaded, including those a `diff.<name>.binary=false` driver
/// makes gix load regardless of their size.
struct MergePreview<'a> {
    repo: &'a gix::Repository,
    limits: MergeLimits,
    /// Blob bytes loaded so far, checked against the read limit.
    read: Cell<u64>,
    interrupt: &'a AtomicBool,
}

impl MergePreview<'_> {
    /// Merges `right` into `left` with `base` as their common ancestor and returns the merged
    /// tree and the repository-relative paths left with unresolved conflicts, each with the
    /// reason the user is shown for it.
    ///
    /// Conflicting files keep their conflict markers in the merged tree, labelled with the
    /// range's sides as typed, so their diff shows what conflicts. gix's conflict list rather
    /// than the content tells which files those are, because content can contain marker-like
    /// lines of its own.
    fn merge(
        &self,
        base: gix::ObjectId,
        left: gix::ObjectId,
        right: gix::ObjectId,
        rev: &str,
    ) -> Result<(gix::ObjectId, HashMap<String, String>), gix::Error> {
        let repo = self.repo;
        let tree_of = |id: gix::ObjectId| -> Result<gix::ObjectId, gix::Error> {
            Ok(repo.find_commit(id)?.tree_id()?.detach())
        };
        let (base_tree, left_tree, right_tree) = (tree_of(base)?, tree_of(left)?, tree_of(right)?);
        let sides = RangeSides::parse(rev);
        let labels = gix::merge::blob::builtin_driver::text::Labels {
            ancestor: Some("merge base".into()),
            current: sides.as_ref().map(|sides| sides.left.into()),
            other: sides.as_ref().map(|sides| sides.right.into()),
        };
        let options: gix::merge::tree::Options = repo.tree_merge_options()?;
        let mut diff_cache = repo.diff_resource_cache_for_tree_diff()?;
        let threshold = &mut diff_cache.filter.options.large_file_threshold_bytes;
        *threshold = self.limits.blob_threshold(*threshold);
        let blob_merge = repo.merge_resource_cache(Default::default())?;
        // Rebuilt without the repository's `merge.<name>.driver` commands, so merely opening a
        // comparison never runs a configured program, which could also hang past the deadline.
        // Paths naming such a driver merge with the built-in text driver instead. The `ToGit`
        // mode keeps `merge.renormalize` from running `filter.<name>` commands as well; blobs
        // come from the object database, which `ToGit` passes through unfiltered.
        let mut blob_merge = gix::merge::blob::Platform::new(
            blob_merge.filter,
            gix::merge::blob::pipeline::Mode::ToGit,
            blob_merge.attr_stack,
            Vec::new(),
            blob_merge.options,
        );
        let threshold = &mut blob_merge.filter.options.large_file_threshold_bytes;
        *threshold = self.limits.blob_threshold(*threshold);
        let mut written = 0u64;
        let mut outcome = gix::merge::plumbing::tree(
            &base_tree,
            &left_tree,
            &right_tree,
            labels,
            self,
            |content| {
                self.check()?;
                written += content.len() as u64;
                if written > self.limits.write_bytes {
                    return Err(gix::error::message(
                        "Git merge preview wrote more merged content than it may hold in memory",
                    )
                    .into());
                }
                Ok(repo.write_blob(content)?.detach())
            },
            &mut Default::default(),
            &mut diff_cache,
            &mut blob_merge,
            options.into(),
        )?;
        let unresolved = gix::merge::plumbing::tree::TreatAsUnresolved::git();
        let left_tree = repo.find_tree(left_tree)?;
        let base_name = sides.as_ref().map_or_else(
            || "the base".to_string(),
            |sides| short_ref_name(sides.left),
        );
        let mut conflicted = HashMap::new();
        for conflict in outcome
            .conflicts
            .iter()
            .filter(|conflict| conflict.is_unresolved(unresolved))
        {
            let reason = conflict_reason(conflict, &left_tree, &base_name)?;
            for location in [conflict.ours.location(), conflict.theirs.location()] {
                if let Ok(location) = location.to_str() {
                    conflicted.insert(location.to_string(), reason.clone());
                }
            }
        }
        let tree = outcome
            .tree
            .write(|tree| gix::objs::Write::write(repo, tree))?;
        Ok((tree, conflicted))
    }

    /// Fails the read in progress once the request is canceled or the budget is spent, which
    /// aborts the merge.
    fn check(&self) -> Result<(), gix::Error> {
        if self.interrupt.load(Ordering::Acquire) {
            return Err(gix::error::message("Git merge preview was canceled").into());
        }
        if Instant::now() >= self.limits.deadline {
            return Err(gix::error::message("Git merge preview ran out of time").into());
        }
        Ok(())
    }
}

impl gix::objs::Find for MergePreview<'_> {
    /// Reads an object for the merge unless it has to stop.
    fn try_find<'buffer>(
        &self,
        id: &gix::hash::oid,
        buffer: &'buffer mut Vec<u8>,
    ) -> Result<Option<gix::objs::Data<'buffer>>, gix::Error> {
        self.check()?;
        // The header tells the size before the blob is loaded, so an oversized one is never
        // held in memory. Trees are not counted: the object cache bounds them, while loaded
        // blobs pile up in rename detection's cache.
        if let Some(header) = gix::objs::FindHeader::try_header(self.repo, id)?
            && header.kind == gix::objs::Kind::Blob
        {
            if header.size > self.limits.blob_bytes {
                return Err(gix::error::message(
                    "Git merge preview would load a blob larger than it may hold in memory",
                )
                .into());
            }
            let read = self.read.get() + header.size;
            if read > self.limits.read_bytes {
                return Err(gix::error::message(
                    "Git merge preview would load more content than it may hold in memory",
                )
                .into());
            }
            self.read.set(read);
        }
        gix::objs::Find::try_find(self.repo, id, buffer)
    }
}

impl gix::objs::FindHeader for MergePreview<'_> {
    /// Reads an object header for the merge unless it has to stop.
    fn try_header(&self, id: &gix::hash::oid) -> Result<Option<gix::objs::Header>, gix::Error> {
        self.check()?;
        gix::objs::FindHeader::try_header(self.repo, id)
    }
}

/// What one side of a merge did to a conflicting path, in the words the conflict reason uses.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SideAction {
    Add,
    Delete,
    Modify,
    Rename,
    Copy,
}

impl SideAction {
    /// Classifies one side's change from gix's conflict record.
    fn of(change: &gix::diff::tree_with_rewrites::Change) -> Self {
        use gix::diff::tree_with_rewrites::Change;
        match change {
            Change::Addition { .. } => Self::Add,
            Change::Deletion { .. } => Self::Delete,
            Change::Modification { .. } => Self::Modify,
            Change::Rewrite { copy: true, .. } => Self::Copy,
            Change::Rewrite { copy: false, .. } => Self::Rename,
        }
    }

    /// The verb for the branch, which is about to do this by merging.
    fn present(self) -> &'static str {
        match self {
            Self::Add => "adds",
            Self::Delete => "deletes",
            Self::Modify => "changes",
            Self::Rename => "renames",
            Self::Copy => "copies",
        }
    }

    /// The verb for the base, which already did this.
    fn past(self) -> &'static str {
        match self {
            Self::Add => "added",
            Self::Delete => "deleted",
            Self::Modify => "changed",
            Self::Rename => "renamed",
            Self::Copy => "copied",
        }
    }
}

/// Explains a conflict in terms of what each side did, with A as the base the branch merges
/// into and B as "your branch", so the user learns what to resolve without running the merge.
///
/// gix may store the two changes swapped relative to A and B, and keeps which way private, so
/// the side that made a change is found by checking which change A's tree reflects.
fn conflict_reason(
    conflict: &gix::merge::plumbing::tree::Conflict,
    left_tree: &gix::Tree<'_>,
    base_name: &str,
) -> Result<String, gix::Error> {
    let ours_is_left = is_left_change(&conflict.ours, left_tree)?;
    let theirs_is_left = is_left_change(&conflict.theirs, left_tree)?;
    let (left, right) = match (ours_is_left, theirs_is_left) {
        (true, false) => (&conflict.ours, &conflict.theirs),
        (false, true) => (&conflict.theirs, &conflict.ours),
        // Neither or both match A, so there is no telling who did what.
        _ => {
            return Ok(format!(
                "Your branch and {base_name} changed this file in ways that do not merge cleanly."
            ));
        }
    };
    let (left, right) = (SideAction::of(left), SideAction::of(right));
    Ok(match (right, left) {
        (SideAction::Modify, SideAction::Modify) => format!(
            "Your branch and {base_name} both changed the same lines of this file since the branch split off."
        ),
        (SideAction::Add, SideAction::Add) => {
            format!("Your branch and {base_name} both added this file with different contents.")
        }
        (right, left) if right == left => format!(
            "Your branch and {base_name} both {} this file differently since the branch split off.",
            left.past()
        ),
        (right, left) => format!(
            "Your branch {} this file, but {base_name} {} it since the branch split off.",
            right.present(),
            left.past()
        ),
    })
}

/// Tells whether A's tree holds the result of a change, which makes it A's side of the
/// conflict: A lacks the path it deleted and has the object it added, modified or moved.
fn is_left_change(
    change: &gix::diff::tree_with_rewrites::Change,
    left_tree: &gix::Tree<'_>,
) -> Result<bool, gix::Error> {
    use gix::diff::tree_with_rewrites::Change;
    let location = change.location();
    let entry = match location.to_str() {
        Ok(location) => left_tree.lookup_entry_by_path(location)?,
        Err(_) => return Ok(false),
    };
    Ok(match change {
        Change::Deletion { .. } => entry.is_none(),
        Change::Addition { id, .. }
        | Change::Modification { id, .. }
        | Change::Rewrite { id, .. } => entry.is_some_and(|entry| entry.object_id() == *id),
    })
}

/// Shortens a side of the range as the user would name it, without the `refs/…/` namespace
/// and with commit ids cut to the usual short form, so reasons stay readable on phones.
fn short_ref_name(name: &str) -> String {
    let name = ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .unwrap_or(name);
    if name.len() >= 40 && name.chars().all(|char| char.is_ascii_hexdigit()) {
        name[..7].to_string()
    } else {
        name.to_string()
    }
}

/// Reads the message below the summary line, trimmed so a trailing newline or blank
/// padding does not render as empty space under the title.
fn commit_body(commit: &gix::Commit<'_>) -> Result<String, GitFailure> {
    let message = commit
        .message()
        .map_err(|error| internal_failure("read Git commit message", error))?;
    Ok(message
        .body
        .map(|body| body.trim().to_str_lossy().into_owned())
        .unwrap_or_default())
}

/// Finds the files that differ below `relative`, diffing only the selected subtree so a
/// large commit elsewhere in the repository costs nothing.
///
/// Changes are visited one at a time and at most one more than the response can show is
/// kept, so a commit touching millions of files neither fills memory nor outlives a
/// canceled request.
fn collect_changes<'repo>(
    repo: &'repo gix::Repository,
    relative: &str,
    old_root: Option<&gix::Tree<'repo>>,
    new_root: &gix::Tree<'repo>,
    interrupt: &AtomicBool,
) -> Result<Vec<FileChange>, GitFailure> {
    let old_entry = match old_root {
        Some(tree) => tree_entry(tree, relative)?,
        None => None,
    };
    let new_entry = tree_entry(new_root, relative)?;
    let old_side = non_tree_side(&old_entry);
    let new_side = non_tree_side(&new_entry);

    let mut files = Vec::new();
    if !relative.is_empty() && (old_side.is_some() || new_side.is_some()) && old_side != new_side {
        // The path itself is a file on at least one side. When the other side is a directory,
        // the file's deletion or addition is listed next to the directory's contents below.
        files.push(FileChange {
            relative: relative.to_string(),
            old: old_side,
            new: new_side,
        });
    }

    let old_tree = subtree(repo, relative, old_root, old_entry)?;
    let new_tree = subtree(repo, relative, Some(new_root), new_entry)?;
    if old_tree.is_none() && new_tree.is_none() {
        return Ok(files);
    }
    let empty_tree = repo.empty_tree();
    let old_tree = old_tree.unwrap_or_else(|| empty_tree.clone());
    let new_tree = new_tree.unwrap_or(empty_tree);

    let prefix = if relative.is_empty() {
        String::new()
    } else {
        format!("{relative}/")
    };
    let mut canceled = false;
    let mut reached_limit = false;
    let traversal = old_tree
        .changes()
        .map_err(|error| internal_failure("prepare Git tree diff", error))?
        .options(|options| {
            options.track_path().track_rewrites(None);
        })
        .for_each_to_obtain_tree(&new_tree, |change| {
            use gix::object::tree::diff::Change;
            if interrupt.load(Ordering::Acquire) {
                canceled = true;
                return Ok(std::ops::ControlFlow::Break(()));
            }
            let (location, old, new) = match change {
                Change::Addition {
                    location,
                    entry_mode,
                    id,
                    ..
                } => (location, None, Some((entry_mode, id.detach()))),
                Change::Deletion {
                    location,
                    entry_mode,
                    id,
                    ..
                } => (location, Some((entry_mode, id.detach())), None),
                Change::Modification {
                    location,
                    previous_entry_mode,
                    previous_id,
                    entry_mode,
                    id,
                } => (
                    location,
                    Some((previous_entry_mode, previous_id.detach())),
                    Some((entry_mode, id.detach())),
                ),
                // Rewrite tracking is disabled above, so renames arrive as deletion plus addition.
                Change::Rewrite { .. } => return Ok(std::ops::ControlFlow::Continue(())),
            };
            // Trees are reported alongside their files; only the files carry content.
            let old = old.filter(|(mode, _)| !mode.is_tree());
            let new = new.filter(|(mode, _)| !mode.is_tree());
            if old.is_none() && new.is_none() {
                return Ok(std::ops::ControlFlow::Continue(()));
            }
            let Ok(location) = location.to_str() else {
                return Ok(std::ops::ControlFlow::Continue(()));
            };
            files.push(FileChange {
                relative: format!("{prefix}{location}"),
                old,
                new,
            });
            // One change past the limit is enough to report the response as truncated.
            reached_limit = files.len() > GitDiffRequest::MAX_FILES;
            Ok(if reached_limit {
                std::ops::ControlFlow::Break(())
            } else {
                std::ops::ControlFlow::Continue(())
            })
        });
    if canceled {
        return Err(GitFailure::new(
            CommandErrorKind::Canceled,
            "Git commit diff was canceled",
        ));
    }
    // gix reports a traversal stopped by the callback as an error, which here only means the
    // limit was reached.
    if !reached_limit {
        traversal.map_err(|error| internal_failure("diff Git trees", error))?;
    }
    Ok(files)
}

/// Returns one side's entry at the browsed path when it is not a directory, the only case
/// where the path itself is a changed file rather than a tree of them.
fn non_tree_side(entry: &Option<gix::objs::tree::Entry>) -> Side {
    entry
        .as_ref()
        .filter(|entry| !entry.mode.is_tree())
        .map(|entry| (entry.mode, entry.oid))
}

/// Selects the tree to diff on one side: the root for the repository itself, the entry's tree
/// for a directory, or nothing when that side has no directory at the path.
fn subtree<'repo>(
    repo: &'repo gix::Repository,
    relative: &str,
    root: Option<&gix::Tree<'repo>>,
    entry: Option<gix::objs::tree::Entry>,
) -> Result<Option<gix::Tree<'repo>>, GitFailure> {
    match (root, entry) {
        (Some(root), _) if relative.is_empty() => Ok(Some(root.clone())),
        (_, Some(entry)) if entry.mode.is_tree() => repo
            .find_tree(entry.oid)
            .map(Some)
            .map_err(|error| internal_failure("read Git tree", error)),
        _ => Ok(None),
    }
}

/// Reads one side's blob within the per-file bound; symlinks and submodules have no text diff.
fn side_source(repo: &gix::Repository, side: Side) -> Result<DiffSource, GitFailure> {
    match side {
        None => Ok(DiffSource::Missing),
        Some((mode, id)) if mode.is_blob() => read_object_blob(repo, id),
        Some(_) => Ok(DiffSource::Unsupported),
    }
}

/// Classifies a file change in the same vocabulary as worktree status.
fn change_state(old: Side, new: Side) -> GitChangeState {
    match (old, new) {
        (None, _) => GitChangeState::Added,
        (_, None) => GitChangeState::Deleted,
        (Some((old_mode, _)), Some((new_mode, _))) if old_mode.kind() != new_mode.kind() => {
            if old_mode.is_blob() && new_mode.is_blob() {
                // Only the executable bit changed, which Git still calls a modification.
                GitChangeState::Modified
            } else {
                GitChangeState::TypeChanged
            }
        }
        _ => GitChangeState::Modified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
    use std::{path::Path, process::Command};

    /// Runs git in `dir` with a fixed identity and returns its trimmed output, so fixtures do
    /// not depend on the host config.
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed: {output:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    /// Writes `contents` to `relative` below `root`.
    fn write(root: &Path, relative: &str, contents: &str) {
        std::fs::write(root.join(relative), contents).unwrap();
    }

    /// Commits every change in the worktree.
    fn commit(root: &Path, message: &str) {
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", message]);
    }

    /// A repository whose `main` has one commit and a `feature` branch split from it.
    fn fixture() -> TempDir {
        let temp = TempDir::create();
        let root = temp.path();
        git(root, &["init", "-q", "-b", "main"]);
        write(root, "shared.txt", "one\ntwo\nthree\n");
        write(root, "other.txt", "base\n");
        commit(root, "initial");
        git(root, &["branch", "feature"]);
        temp
    }

    /// Diffs `rev` at the repository root with the full merge budget.
    fn diff(root: &Path, rev: &str) -> GitCommitDiffResponse {
        diff_with_limits(root, rev, MergeLimits::starting_now())
    }

    /// Diffs `rev` at the repository root with given merge limits.
    fn diff_with_limits(root: &Path, rev: &str, limits: MergeLimits) -> GitCommitDiffResponse {
        commit_diff_blocking(
            &root.display().to_string(),
            rev,
            &AtomicBool::new(false),
            limits,
        )
        .unwrap()
    }

    /// The repository-relative paths a diff lists.
    fn paths(response: &GitCommitDiffResponse) -> Vec<&str> {
        response
            .files
            .iter()
            .map(|file| file.repository_relative_path.as_str())
            .collect()
    }

    /// The unified diff of one listed file.
    fn patch<'a>(response: &'a GitCommitDiffResponse, relative: &str) -> &'a str {
        let file = response
            .files
            .iter()
            .find(|file| file.repository_relative_path == relative)
            .unwrap();
        let GitDiffResult::Text { unified_diff, .. } = &file.result else {
            panic!("expected a text diff, got {:?}", file.result);
        };
        unified_diff
    }

    /// Work that reached main as a squash shows up again in a merge-base diff, but only the
    /// branch's newer work shows in the merge preview.
    #[test]
    fn squash_merged_work_cancels_out() {
        let temp = fixture();
        let root = temp.path();
        git(root, &["checkout", "-q", "feature"]);
        write(root, "landed.txt", "landed\n");
        commit(root, "work that gets squashed");
        git(root, &["checkout", "-q", "main"]);
        git(root, &["merge", "-q", "--squash", "feature"]);
        commit(root, "squash");
        git(root, &["checkout", "-q", "feature"]);
        write(root, "extension.txt", "new\n");
        commit(root, "extension");

        let response = diff(root, "main...feature");
        // The squashed file is already on main, so only the extension remains to merge.
        assert_eq!(paths(&response), ["extension.txt"]);
        let range = response.range.as_ref().unwrap();
        // The merge succeeded, so the view must not report a fallback.
        assert!(range.merge_preview);
        assert!(range.merge_base);
        // The header still names the merge base, the commit both branches split from.
        let main_root = git(root, &["rev-parse", "main~1"]);
        assert_eq!(range.base.as_ref().unwrap().id, main_root);
        // Deleted files link to the compared side, which is main's tree in a merge preview.
        assert_eq!(
            response.parent_id.as_deref(),
            Some(git(root, &["rev-parse", "main"]).as_str())
        );
    }

    /// Main's own newer work is not shown reversed, as a plain `main..feature` diff would.
    #[test]
    fn unrelated_main_commits_do_not_show() {
        let temp = fixture();
        let root = temp.path();
        write(root, "other.txt", "changed on main\n");
        write(root, "main-only.txt", "main\n");
        commit(root, "main moves on");
        git(root, &["checkout", "-q", "feature"]);
        write(root, "shared.txt", "one\ntwo changed\nthree\n");
        commit(root, "feature work");

        let response = diff(root, "main...feature");
        // Only the branch's file is listed; main's additions and edits are already in A.
        assert_eq!(paths(&response), ["shared.txt"]);
        // Nothing conflicts, so no file is labelled as such.
        assert!(response.files.iter().all(|file| !file.conflicted));
        // The patch is the branch's change applied on top of main.
        assert!(patch(&response, "shared.txt").contains("+two changed"));
    }

    /// A change to the same lines on both sides is labelled as a conflict and shows the
    /// markers, without writing the merge result into the repository.
    #[test]
    fn conflicting_changes_are_marked() {
        let temp = fixture();
        let root = temp.path();
        write(root, "shared.txt", "one\nmain side\nthree\n");
        commit(root, "main edit");
        git(root, &["checkout", "-q", "feature"]);
        write(root, "shared.txt", "one\nfeature side\nthree\n");
        write(root, "clean.txt", "clean\n");
        commit(root, "feature edit");
        let objects_before = git(root, &["count-objects", "-v"]);

        let response = diff(root, "main...feature");
        assert_eq!(paths(&response), ["clean.txt", "shared.txt"]);
        let conflicted: Vec<_> = response
            .files
            .iter()
            .filter(|file| file.conflicted)
            .map(|file| file.repository_relative_path.as_str())
            .collect();
        // Only the file both sides edited conflicts; the branch's new file merges cleanly.
        assert_eq!(conflicted, ["shared.txt"]);
        // The diff shows the markers, labelled with the range's sides as typed.
        let shared = patch(&response, "shared.txt");
        assert!(shared.contains("+<<<<<<< main"), "{shared}");
        assert!(shared.contains("+>>>>>>> feature"), "{shared}");
        // Viewing must never write to the repository, so merged objects stay in memory.
        assert_eq!(git(root, &["count-objects", "-v"]), objects_before);
        // Listed conflicts also say why, naming main as the side merged into.
        let reason = response
            .files
            .iter()
            .find(|file| file.repository_relative_path == "shared.txt")
            .and_then(|file| file.conflict_reason.as_deref());
        assert_eq!(
            reason,
            Some(
                "Your branch and main both changed the same lines of this file since the branch split off."
            )
        );
    }

    /// A conflict whose merge keeps main's version leaves nothing to diff, yet still gets a
    /// row saying what conflicts, or the user would never learn about it.
    #[test]
    fn conflict_resolving_to_main_is_listed_with_reason() {
        let temp = fixture();
        let root = temp.path();
        write(
            root,
            "shared.txt",
            "one
main side
three
",
        );
        commit(root, "main edit");
        git(root, &["checkout", "-q", "feature"]);
        std::fs::remove_file(root.join("shared.txt")).unwrap();
        commit(root, "feature deletes");

        let response = diff(root, "refs/heads/main...feature");
        let file = response
            .files
            .iter()
            .find(|file| file.repository_relative_path == "shared.txt")
            .expect("the conflicted file must be listed even without a diff");
        // The badge comes from this flag, and the header counts it.
        assert!(file.conflicted);
        // The merge kept main's file, so nothing changes compared with main.
        assert_eq!(file.change, GitChangeState::Unmodified);
        assert_eq!(file.result, GitDiffResult::NoChanges);
        // The reason is all the view can show, so it must say who did what, with the
        // ref shortened as people name it.
        assert_eq!(
            file.conflict_reason.as_deref(),
            Some("Your branch deletes this file, but main changed it since the branch split off.")
        );
        // Unlisted conflicts follow the browsed path like any other change: inside it,
        // never in a sibling that merely shares the prefix.
        assert!(is_below("", "shared.txt"));
        assert!(is_below("dir", "dir/shared.txt"));
        assert!(!is_below("dir", "dir2/shared.txt"));
    }

    /// The reason tells the sides apart when the branch changes a file main deleted.
    #[test]
    fn conflict_reason_names_the_side_that_deleted() {
        let temp = fixture();
        let root = temp.path();
        std::fs::remove_file(root.join("shared.txt")).unwrap();
        commit(root, "main deletes");
        git(root, &["checkout", "-q", "feature"]);
        write(
            root,
            "shared.txt",
            "one
feature side
three
",
        );
        commit(root, "feature edit");

        let response = diff(root, "main...feature");
        let file = response
            .files
            .iter()
            .find(|file| file.repository_relative_path == "shared.txt")
            .unwrap();
        // gix may hold the two changes in either order, so this guards the side detection.
        assert!(file.conflicted);
        assert_eq!(
            file.conflict_reason.as_deref(),
            Some("Your branch changes this file, but main deleted it since the branch split off.")
        );
    }

    /// A merge that cannot finish in time falls back to the merge-base diff and says so.
    #[test]
    fn merge_out_of_time_falls_back_to_merge_base() {
        let temp = fixture();
        let root = temp.path();
        git(root, &["checkout", "-q", "feature"]);
        write(root, "landed.txt", "landed\n");
        commit(root, "work that gets squashed");
        git(root, &["checkout", "-q", "main"]);
        git(root, &["merge", "-q", "--squash", "feature"]);
        commit(root, "squash");

        // A deadline already passed makes the merge's first object read fail.
        let response = diff_with_limits(
            root,
            "main...feature",
            MergeLimits {
                deadline: Instant::now(),
                ..MergeLimits::starting_now()
            },
        );
        let range = response.range.as_ref().unwrap();
        // The view must learn that the diff is the noisier merge-base comparison.
        assert!(!range.merge_preview);
        // The merge-base diff lists the squashed work again, unlike a merge preview.
        assert_eq!(paths(&response), ["landed.txt"]);
        // The compared commit is the merge base, which the fallback diffed from.
        assert_eq!(
            response.parent_id.as_deref(),
            Some(range.base.as_ref().unwrap().id.as_str())
        );
    }

    /// A configured external merge driver must never run just because a comparison was
    /// opened; the built-in text merge takes its place.
    #[test]
    fn merge_preview_never_runs_merge_drivers() {
        let temp = fixture();
        let root = temp.path();
        let marker = root.join("driver-ran");
        let command = format!("touch '{}'; false", marker.display());
        git(root, &["config", "merge.evil.driver", &command]);
        // Both sides carry the attribute, as when it was committed before they split.
        write(root, ".gitattributes", "* merge=evil\n");
        commit(root, "attributes");
        git(root, &["branch", "-f", "feature"]);
        write(root, "shared.txt", "one\nmain side\nthree\n");
        commit(root, "main edit");
        git(root, &["checkout", "-q", "feature"]);
        write(root, "shared.txt", "one\nfeature side\nthree\n");
        commit(root, "feature edit");

        let response = diff(root, "main...feature");
        // The driver was dropped, not the merge, so the preview still succeeds.
        assert!(response.range.as_ref().unwrap().merge_preview);
        // The built-in text driver merged the file instead, leaving its usual markers.
        assert!(patch(&response, "shared.txt").contains("+<<<<<<< main"));
        // The configured command would have created the marker had it run.
        assert!(!marker.exists());
    }

    /// A merge writing more merged content than the agent may hold falls back to the merge
    /// base instead.
    #[test]
    fn merge_over_write_limit_falls_back_to_merge_base() {
        let temp = fixture();
        let root = temp.path();
        write(root, "shared.txt", "zero\none\ntwo\nthree\n");
        commit(root, "main edit");
        git(root, &["checkout", "-q", "feature"]);
        write(root, "shared.txt", "one\ntwo\nthree\nfour\n");
        commit(root, "feature edit");

        // Both sides changed the file, so the merge must write a merged blob, which is longer
        // than this limit.
        let response = diff_with_limits(
            root,
            "main...feature",
            MergeLimits {
                write_bytes: 4,
                ..MergeLimits::starting_now()
            },
        );
        // The view must learn that the diff is the merge-base comparison.
        assert!(!response.range.as_ref().unwrap().merge_preview);
        // The compared commit is the merge base, which the fallback diffed from.
        let range = response.range.as_ref().unwrap();
        assert_eq!(
            response.parent_id.as_deref(),
            Some(range.base.as_ref().unwrap().id.as_str())
        );
    }

    /// A diff driver forcing text makes rename detection load blobs of any size, so the
    /// preview's own read check must still refuse one over the per-blob limit.
    #[test]
    fn forced_text_blob_over_limit_falls_back_to_merge_base() {
        let temp = fixture();
        let root = temp.path();
        let big = "line of a large file\n".repeat(200);
        write(root, "big.txt", &big);
        commit(root, "big file");
        git(root, &["branch", "-f", "feature"]);
        write(root, "other.txt", "changed on main\n");
        commit(root, "main edit");
        git(root, &["checkout", "-q", "feature"]);
        // Renaming with an edit leaves rename detection to compare the blobs' contents.
        std::fs::remove_file(root.join("big.txt")).unwrap();
        write(root, "moved.txt", &format!("{big}one more line\n"));
        commit(root, "move big file");
        let limits = MergeLimits {
            blob_bytes: 1024,
            ..MergeLimits::starting_now()
        };

        // Without the driver the pipeline only reads the large blobs' headers.
        let response = diff_with_limits(root, "main...feature", limits);
        assert!(response.range.as_ref().unwrap().merge_preview);

        git(root, &["config", "diff.forcetext.binary", "false"]);
        write(root, ".gitattributes", "* diff=forcetext\n");
        commit(root, "force text diffs");
        let response = diff_with_limits(root, "main...feature", limits);
        // The driver made gix load a blob over the limit, which must fail the merge rather
        // than hold the blob in memory.
        assert!(!response.range.as_ref().unwrap().merge_preview);
    }

    /// Many blobs below the per-blob limit together must not exceed the total read limit.
    #[test]
    fn merge_over_read_limit_falls_back_to_merge_base() {
        let temp = fixture();
        let root = temp.path();
        write(root, "shared.txt", "zero\none\ntwo\nthree\n");
        commit(root, "main edit");
        git(root, &["checkout", "-q", "feature"]);
        write(root, "shared.txt", "one\ntwo\nthree\nfour\n");
        commit(root, "feature edit");

        // Merging the file loads its three versions, more than this limit allows.
        let response = diff_with_limits(
            root,
            "main...feature",
            MergeLimits {
                read_bytes: 16,
                ..MergeLimits::starting_now()
            },
        );
        // The view must learn that the diff is the merge-base comparison.
        assert!(!response.range.as_ref().unwrap().merge_preview);
    }

    /// A repository's smaller big-file threshold is kept, and an unlimited one is capped.
    #[test]
    fn blob_threshold_never_exceeds_either_limit() {
        let limits = MergeLimits::starting_now();
        // A repository asking for less loaded keeps its smaller threshold.
        assert_eq!(limits.blob_threshold(1024), 1024);
        // A larger configured threshold, like Git's default, is lowered to the preview's.
        assert_eq!(
            limits.blob_threshold(512 * 1024 * 1024),
            MERGE_PREVIEW_BLOB_BYTES
        );
        // Zero means unlimited in Git, which the preview must not allow.
        assert_eq!(limits.blob_threshold(0), MERGE_PREVIEW_BLOB_BYTES);
    }

    /// Two-dot ranges stay literal history diffs rather than merge previews.
    #[test]
    fn two_dot_ranges_are_not_merge_previews() {
        let temp = fixture();
        let root = temp.path();
        git(root, &["checkout", "-q", "feature"]);
        write(root, "feature.txt", "new\n");
        commit(root, "feature work");

        let response = diff(root, "main..feature");
        let range = response.range.as_ref().unwrap();
        // Only symmetric ranges are previews of a merge.
        assert!(!range.merge_preview);
        assert!(!range.merge_base);
        assert_eq!(paths(&response), ["feature.txt"]);
    }
}
