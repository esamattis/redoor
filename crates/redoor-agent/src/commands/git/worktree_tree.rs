//! The working tree as a Git tree: HEAD's tree with every uncommitted change applied, so a
//! commit diff can compare "everything I would commit" with another commit, or merge it.
//!
//! Only trees are written, and only into the repository handle's object memory, so building
//! one never changes the repository. File contents stay on disk: a file's blob id is hashed by
//! streaming it, and the file is read again only when a merge or a diff needs its content.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt, fs::PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

use gix::bstr::ByteSlice;

use redoor_protocol::wire::command::CommandErrorKind;

use super::{
    GitFailure, check_interrupt,
    diff::{DiffSource, worktree_blob},
    internal_failure, io_failure,
    status::{MAX_GIT_STATUS_ENTRIES, StatusCollection, collect_status},
};

/// A file of the working tree that a built tree refers to by id, although no object database
/// holds that id, because its content exists only on disk.
#[derive(Debug, Clone)]
struct WorktreeBlob {
    /// The absolute path of the file or symlink on disk.
    path: PathBuf,
    /// The size the id was hashed with, which object headers report without reading the file.
    size: u64,
    /// True for a symlink, whose blob is the link target rather than the file it points to.
    symlink: bool,
}

/// HEAD's tree with the working tree's state applied at every path `git status` lists, in
/// the handle's object memory, and where the content of each uncommitted file lives.
///
/// "Working tree" means what `git add -A && git commit` would record: staged, unstaged and
/// untracked files that are not ignored, each as it is on disk now. Contents go through no
/// clean filters or line-ending conversion, because those can run repository-configured
/// commands, which merely opening a comparison must never do.
pub(super) struct WorktreeTree {
    /// The built root tree, readable only through the handle it was built with.
    pub(super) tree_id: gix::ObjectId,
    /// Files whose blob is not in the object database, by the id the tree refers to them by.
    blobs: HashMap<gix::ObjectId, WorktreeBlob>,
    /// True when status listed more changed paths than one tree is built from, so some
    /// uncommitted changes are left at their HEAD version.
    pub(super) truncated: bool,
}

impl WorktreeTree {
    /// Builds the tree from the same status walk the Changes view lists, so both agree on which
    /// files changed, without reading any file into memory as a whole.
    ///
    /// `repo` must keep written objects in memory, since the tree and its subtrees are written
    /// through it.
    pub(super) fn build(
        repo: &gix::Repository,
        root: &Path,
        head_tree: gix::ObjectId,
        interrupt: &Arc<AtomicBool>,
    ) -> Result<Self, GitFailure> {
        // The merge needs the whole working tree even when a subdirectory is browsed, so the
        // walk covers the repository, bounded like the Changes view. Ignored paths are kept so
        // a file untracked with `git rm --cached` and then ignored is known to stay deleted.
        let StatusCollection {
            changes,
            overflowed,
            ..
        } = collect_status(
            repo,
            |_| true,
            true,
            MAX_GIT_STATUS_ENTRIES,
            Vec::new(),
            interrupt.clone(),
        )?;
        let index = repo
            .index_or_empty()
            .map_err(|error| internal_failure("open Git index", error))?;
        // Git keeps the recorded executable bit where the filesystem cannot store one, such as
        // shared storage on Android, so the disk's bits are trusted only when Git trusts them.
        let file_mode = repo
            .config_snapshot()
            .boolean("core.fileMode")
            .unwrap_or(true);
        let mut editor = repo
            .edit_tree(head_tree)
            .map_err(|error| internal_failure("read Git HEAD tree", error))?
            // The plain editor writes trees whose blobs no object database holds; the checked
            // one refuses them, but these blobs are served from disk instead.
            .detach();
        let mut blobs = HashMap::new();
        // Status collapses an ignored directory to one entry, while files of it that left the
        // index are still listed as staged deletions below it, so those are matched by their
        // ignored ancestor.
        let ignored: HashSet<&[u8]> = changes
            .iter()
            .filter(|(_, status)| status.is_ignored())
            .map(|(path, _)| path.as_slice())
            .collect();
        // Status lists paths in order, so a file that became a directory is removed before
        // the files below it are added.
        for (relative, status) in &changes {
            check_interrupt(interrupt, "Git commit diff")?;
            // Status already left out paths that are not UTF-8.
            let Ok(relative) = relative.as_bstr().to_str() else {
                continue;
            };
            let components = relative.split('/');
            let path = root.join(relative);
            let edit = match std::fs::symlink_metadata(&path) {
                // An ignored path is never in the index, so `git add -A` leaves it out even
                // though it is on disk; one HEAD still has is a staged deletion.
                _ if status.is_ignored()
                    || (index.entry_by_path(relative.as_bytes().as_bstr()).is_none()
                        && has_ignored_ancestor(&ignored, relative)) =>
                {
                    None
                }
                Ok(metadata) => Self::disk_entry(
                    repo, &index, relative, &path, &metadata, file_mode, interrupt,
                )?,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(libc::ENOTDIR) =>
                {
                    None
                }
                Err(error) => return Err(io_failure("inspect Git worktree file", error)),
            };
            let result = match edit {
                Some((kind, id, blob)) => {
                    if let Some(blob) = blob
                        && !repo.has_object(id)
                    {
                        blobs.insert(id, blob);
                    }
                    editor.upsert(components, kind, id).map(|_| ())
                }
                // Never a whole directory: status lists the files below a tracked one itself.
                None => editor.remove_if_leaf(components).map(|_| ()),
            };
            result.map_err(|error| internal_failure("edit Git worktree tree", error))?;
        }
        let tree_id = editor
            .write(|tree| repo.write_object(tree).map(gix::Id::detach))
            .map_err(|error| internal_failure("write Git worktree tree", error))?;
        Ok(Self {
            tree_id,
            blobs,
            truncated: overflowed,
        })
    }

    /// Reads what one listed path is on disk as a tree entry, or `None` when Git would not
    /// record anything there, such as for a FIFO or an untracked nested repository.
    fn disk_entry(
        repo: &gix::Repository,
        index: &gix::index::State,
        relative: &str,
        path: &Path,
        metadata: &std::fs::Metadata,
        file_mode: bool,
        interrupt: &AtomicBool,
    ) -> Result<
        Option<(
            gix::objs::tree::EntryKind,
            gix::ObjectId,
            Option<WorktreeBlob>,
        )>,
        GitFailure,
    > {
        use gix::objs::tree::EntryKind;
        let index_entry = index.entry_by_path(relative.as_bytes().as_bstr());
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            let target = std::fs::read_link(path)
                .map_err(|error| io_failure("read Git worktree symlink", error))?;
            let target = target.as_os_str().as_bytes();
            let id = gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, target)
                .map_err(|error| internal_failure("hash Git worktree symlink", error))?;
            let blob = WorktreeBlob {
                path: path.to_path_buf(),
                size: target.len() as u64,
                symlink: true,
            };
            return Ok(Some((EntryKind::Link, id, Some(blob))));
        }
        if file_type.is_file() {
            let executable = if file_mode {
                metadata.permissions().mode() & 0o111 != 0
            } else {
                index_entry.is_some_and(|entry| {
                    entry
                        .mode
                        .to_tree_entry_mode()
                        .is_some_and(|mode| mode.is_executable())
                })
            };
            let (id, size) = hash_file(repo, path, interrupt)?;
            let kind = if executable {
                EntryKind::BlobExecutable
            } else {
                EntryKind::Blob
            };
            let blob = WorktreeBlob {
                path: path.to_path_buf(),
                size,
                symlink: false,
            };
            return Ok(Some((kind, id, Some(blob))));
        }
        // A submodule's checkout is its own repository; the commit its index entry records
        // stands for it, as `git status` compares it with that.
        if file_type.is_dir()
            && let Some(entry) = index_entry
            && entry
                .mode
                .to_tree_entry_mode()
                .is_some_and(|mode| mode.is_commit())
        {
            return Ok(Some((EntryKind::Commit, entry.id, None)));
        }
        Ok(None)
    }

    /// The object header a merge asks for before loading an uncommitted file, so files it
    /// only passes along are never read.
    pub(super) fn header(&self, id: &gix::hash::oid) -> Option<gix::objs::Header> {
        self.blobs.get(id).map(|blob| gix::objs::Header {
            kind: gix::objs::Kind::Blob,
            size: blob.size,
        })
    }

    /// Loads an uncommitted file into `buffer` for a merge that has to combine it with the
    /// other side, or `None` when `id` is not one. Callers check the size from [`Self::header`]
    /// first, and the read stops at that size, so a file that grew since it was hashed is
    /// never held whole.
    pub(super) fn read(
        &self,
        id: &gix::hash::oid,
        buffer: &mut Vec<u8>,
    ) -> Option<std::io::Result<()>> {
        let blob = self.blobs.get(id)?;
        buffer.clear();
        Some(blob.read(buffer))
    }

    /// Reads one side of a changed file for its diff: from disk, with the same bounds as the
    /// Changes view, when the tree refers to an uncommitted file, otherwise `None` so the
    /// caller reads the object database.
    pub(super) fn diff_source(
        &self,
        id: &gix::hash::oid,
    ) -> Option<Result<DiffSource, GitFailure>> {
        let blob = self.blobs.get(id)?;
        // Symlinks have no text diff, like everywhere else in the Git view.
        Some(if blob.symlink {
            Ok(DiffSource::Unsupported)
        } else {
            worktree_blob(&blob.path)
        })
    }
}

impl WorktreeBlob {
    /// Reads exactly the hashed size, failing when the file changed size since, because the
    /// merge would otherwise combine content that does not match its id.
    fn read(&self, buffer: &mut Vec<u8>) -> std::io::Result<()> {
        if self.symlink {
            buffer.extend_from_slice(std::fs::read_link(&self.path)?.as_os_str().as_bytes());
        } else {
            open_no_follow(&self.path)?
                .take(self.size + 1)
                .read_to_end(buffer)?;
        }
        if buffer.len() as u64 != self.size {
            return Err(std::io::Error::other(
                "working tree file changed while it was compared",
            ));
        }
        Ok(())
    }
}

/// Tells whether a directory above `relative` is one status reported as ignored, which makes
/// a file there that is not in the index one `git add -A` leaves out.
fn has_ignored_ancestor(ignored: &HashSet<&[u8]>, relative: &str) -> bool {
    relative
        .match_indices('/')
        .any(|(end, _)| ignored.contains(&relative.as_bytes()[..end]))
}

/// Opens a working tree file without following a symlink in its place, which would make the
/// comparison read some other file.
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

/// Computes a file's blob id by streaming it through the hasher, so even a file far larger
/// than the agent's memory gets an id without being loaded, and returns the size it hashed.
fn hash_file(
    repo: &gix::Repository,
    path: &Path,
    interrupt: &AtomicBool,
) -> Result<(gix::ObjectId, u64), GitFailure> {
    let file = open_no_follow(path).map_err(|error| io_failure("open Git worktree file", error))?;
    let size = file
        .metadata()
        .map_err(|error| io_failure("inspect Git worktree file", error))?
        .len();
    let mut reader = std::io::BufReader::new(file);
    let id = gix::objs::compute_stream_hash(
        repo.object_hash(),
        gix::objs::Kind::Blob,
        &mut reader,
        size,
        &mut gix::progress::Discard,
        interrupt,
    )
    .map_err(|error| {
        if interrupt.load(std::sync::atomic::Ordering::Acquire) {
            GitFailure::new(CommandErrorKind::Canceled, "Git commit diff was canceled")
        } else {
            internal_failure("hash Git worktree file", error)
        }
    })?;
    Ok((id, size))
}
