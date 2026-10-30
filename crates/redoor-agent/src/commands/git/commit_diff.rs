//! What one commit changed: its tree compared with its first parent's, below one path. A
//! range compares its newer end with its start instead, so several commits read as one, and
//! a symmetric range with the merge base of its sides, so a branch shows only its own work.

use std::sync::atomic::{AtomicBool, Ordering};

use gix::bstr::ByteSlice;

use redoor_protocol::{
    api::git::{
        GitChangeState, GitDiffResult,
        commit::{GitCommitDiffResponse, GitCommitFileChange, GitCommitRange},
        worktree::GitDiffRequest,
    },
    wire::{command::CommandErrorKind, request::CommandError},
};

use super::{
    GitFailure,
    diff::{DiffBudget, DiffSource, read_object_blob},
    internal_failure,
    revision::{RevisionBase, RevisionPath, commit_summary, tree_entry},
    run_blocking,
};

/// One side of a changed file: its mode and object, or nothing when the side lacks the file.
type Side = Option<(gix::objs::tree::EntryMode, gix::ObjectId)>;

/// One changed file before its patch is formatted.
struct FileChange {
    relative: String,
    old: Side,
    new: Side,
}

/// Diffs the commit a revision names against its first parent, or a range's newer end
/// against its start, below one path.
pub(crate) async fn commit_diff(
    path: String,
    rev: String,
) -> Result<GitCommitDiffResponse, CommandError> {
    run_blocking(move |interrupt| commit_diff_blocking(&path, &rev, &interrupt)).await
}

/// Collects the changed files, then formats each within the shared batch budget.
fn commit_diff_blocking(
    path: &str,
    rev: &str,
    interrupt: &AtomicBool,
) -> Result<GitCommitDiffResponse, GitFailure> {
    let target = RevisionPath::open(path, rev)?;
    let repo = &target.repository.repo;
    let commit = target.commit()?;
    let new_root = commit
        .tree()
        .map_err(|error| internal_failure("read Git commit tree", error))?;
    // Merges are shown against their first parent, the branch they were merged into, and a
    // range against its start (or its merge base), so its commits read as one change.
    let parent_id = match target.base {
        RevisionBase::FirstParent => commit.parent_ids().next().map(gix::Id::detach),
        RevisionBase::Commit(id) | RevisionBase::MergeBase(id) => Some(id),
        RevisionBase::Empty => None,
    };
    let parent = parent_id
        .map(|id| {
            repo.find_commit(id)
                .map_err(|error| internal_failure("read Git parent commit", error))
        })
        .transpose()?;
    let old_root = parent
        .as_ref()
        .map(|parent| {
            parent
                .tree()
                .map_err(|error| internal_failure("read Git parent tree", error))
        })
        .transpose()?;

    let mut changes = collect_changes(
        repo,
        &target.relative,
        old_root.as_ref(),
        &new_root,
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
            repository_relative_path: change.relative,
            result,
        });
    }

    let range = if target.base.is_range() {
        Some(GitCommitRange {
            base: parent.as_ref().map(commit_summary).transpose()?,
            merge_base: matches!(target.base, RevisionBase::MergeBase(_)),
        })
    } else {
        None
    };

    Ok(GitCommitDiffResponse {
        commit: commit_summary(&commit)?,
        body: commit_body(&commit)?,
        parent_id: parent.map(|parent| parent.id.to_string()),
        range,
        repository_root: target.repository.root.display().to_string(),
        repository_relative_path: target.relative.clone(),
        files,
        truncated,
    })
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
