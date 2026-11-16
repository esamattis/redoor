//! Exporting committed content for downloads and copies: what a path is at a revision, and
//! its bytes as one file or as a tar archive of a directory.
//!
//! gix inflates a whole object to read it, which would put a large committed file into memory
//! at once. Loose objects and undeltified pack entries are plain zlib streams, so they are
//! inflated here incrementally instead. Git stores large files undeltified, so those stream
//! in bounded memory; only deltified blobs, whose base must be in memory to apply the delta
//! anyway, are read through gix, and only under an allocation limit.

use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom, Write},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

use flate2::bufread::ZlibDecoder;
use gix::odb::pack;

use redoor_protocol::wire::{
    command::{CommandErrorKind, GitRevisionStatKind, GitRevisionStatResult},
    request::CommandError,
};

use super::{
    GitFailure, check_interrupt, internal_failure, io_failure,
    revision::{RevisionPath, tree_entry},
    run_blocking,
    tree::{missing_at_revision, object_size},
};

/// Deltified blobs are rebuilt in memory by gix together with their base; larger ones would
/// risk the memory of small devices, so they are refused with an explanation.
const MAX_DELTA_BLOB_BYTES: u64 = 64 * 1024 * 1024;
/// gix's limit on any single allocation while rebuilding a delta. A blob under
/// [`MAX_DELTA_BLOB_BYTES`] can still sit on a much larger base or chain of intermediates,
/// and gix resolves a chain in one buffer of twice its largest object plus the deltas, so
/// the result size alone does not bound memory. Room for two maximal objects and their
/// deltas keeps every accepted blob readable.
const DELTA_ALLOC_LIMIT_BYTES: u64 = MAX_DELTA_BLOB_BYTES * 5 / 2;
/// A loose object header is `blob <decimal size>\0`, far shorter than this.
const MAX_LOOSE_HEADER_BYTES: usize = 32;
/// A pack entry header is one type-and-size varint, at most 10 bytes for a 64-bit size.
const MAX_PACK_HEADER_BYTES: usize = 16;
/// The pack entry type of an undeltified blob.
const PACK_BLOB_TYPE: u8 = 3;
/// Read buffer for compressed input, so inflating does not issue one syscall per few bytes.
const COMPRESSED_BUFFER_BYTES: usize = 64 * 1024;

/// Describes what a path is at a revision and the commit the revision resolved to, and
/// whether replacing `replace_target` with it would delete the repository.
pub(crate) async fn stat(
    path: String,
    rev: String,
    replace_target: Option<String>,
) -> Result<GitRevisionStatResult, CommandError> {
    run_blocking(move |_| stat_blocking(&path, &rev, replace_target.as_deref())).await
}

/// Writes the committed file at `path`, or an archive of the committed directory, into
/// `writer`; runs on a blocking thread and stops at the next entry once `interrupt` is set.
pub(crate) fn export(
    path: &str,
    rev: &str,
    include_root: bool,
    writer: impl Write,
    interrupt: &Arc<AtomicBool>,
) -> Result<(), CommandError> {
    export_blocking(path, rev, include_root, writer, interrupt)
        .map_err(GitFailure::into_command_error)
}

/// Resolves the path at the revision and classifies its entry without inflating blobs.
fn stat_blocking(
    path: &str,
    rev: &str,
    replace_target: Option<&str>,
) -> Result<GitRevisionStatResult, GitFailure> {
    let target = RevisionPath::open(path, rev)?;
    let repo = &target.repository.repo;
    let commit = target.commit()?;
    let root = commit
        .tree()
        .map_err(|error| internal_failure("read Git commit tree", error))?;
    let kind = match tree_entry(&root, &target.relative)? {
        // The repository root is the commit's tree itself.
        None if target.relative.is_empty() => GitRevisionStatKind::Directory,
        None => return Err(missing_at_revision(&target.relative, rev)),
        Some(entry) if entry.mode.is_tree() => GitRevisionStatKind::Directory,
        Some(entry) if entry.mode.is_link() => GitRevisionStatKind::Symlink,
        Some(entry) if entry.mode.is_commit() => GitRevisionStatKind::Submodule,
        Some(entry) => GitRevisionStatKind::File {
            size: object_size(repo, entry.oid)?,
            executable: entry.mode.is_executable(),
        },
    };
    let replaces_repository = match replace_target {
        Some(replace_target) => contains_worktree(replace_target, &target.repository.root)?,
        None => false,
    };
    Ok(GitRevisionStatResult {
        commit_id: commit.id.to_string(),
        kind,
        replaces_repository,
    })
}

/// Tells whether replacing `target` would remove the worktree at `root`, resolving symlinks
/// and `..` the way publishing the copy will, since a lexical comparison misses aliases.
fn contains_worktree(target: &str, root: &Path) -> Result<bool, GitFailure> {
    match std::fs::symlink_metadata(target) {
        // Publication renames the final entry itself, so replacing a symlink cannot delete
        // its target. Parent symlinks still need resolving for an actual directory.
        Ok(metadata) if !metadata.is_dir() => return Ok(false),
        Ok(_) => {}
        // Uploads require existing parents and never publish through a missing component.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_failure("inspect copy destination", error)),
    }
    let resolved = std::fs::canonicalize(target)
        .map_err(|error| io_failure("resolve copy destination", error))?;
    Ok(root.starts_with(resolved))
}

/// Streams one committed file, or archives one committed directory, into `writer`.
fn export_blocking(
    path: &str,
    rev: &str,
    include_root: bool,
    mut writer: impl Write,
    interrupt: &AtomicBool,
) -> Result<(), GitFailure> {
    let target = RevisionPath::open(path, rev)?;
    let repo = &target.repository.repo;
    let commit = target.commit()?;
    let root = commit
        .tree()
        .map_err(|error| internal_failure("read Git commit tree", error))?;
    let mut blobs = BlobStore::new(repo)?;
    let tree_id = match tree_entry(&root, &target.relative)? {
        None if target.relative.is_empty() => root.id,
        None => return Err(missing_at_revision(&target.relative, rev)),
        Some(entry) if entry.mode.is_tree() => entry.oid,
        Some(entry) if entry.mode.is_link() || entry.mode.is_commit() => {
            return Err(GitFailure::new(
                CommandErrorKind::InvalidInput,
                "Only files and directories can be copied or downloaded from a Git revision",
            ));
        }
        Some(entry) => {
            let (_, mut reader) = blobs.open(entry.oid)?;
            std::io::copy(&mut reader, &mut writer)
                .map_err(|error| io_failure("stream committed file", error))?;
            return writer
                .flush()
                .map_err(|error| io_failure("stream committed file", error));
        }
    };
    // Git records no modification times, so every member gets the commit time, like
    // `git archive`.
    let mtime = commit
        .time()
        .map(|time| u64::try_from(time.seconds).unwrap_or_default())
        .unwrap_or_default();
    let root_name = include_root.then(|| {
        target
            .worktree_path(&target.relative)
            .file_name()
            .map_or_else(|| PathBuf::from("archive"), PathBuf::from)
    });
    let mut archive = TreeArchive {
        repo,
        blobs,
        builder: tar::Builder::new(writer),
        mtime,
        interrupt,
    };
    let prefix = match root_name {
        Some(name) => {
            archive.append_directory(&name)?;
            name
        }
        None => PathBuf::new(),
    };
    archive.append_tree(tree_id, &prefix)?;
    archive
        .builder
        .into_inner()
        .and_then(|mut writer| writer.flush())
        .map_err(|error| io_failure("finish Git archive", error))
}

/// Writes a committed tree as a tar stream, one blob at a time.
struct TreeArchive<'repo, W: Write> {
    repo: &'repo gix::Repository,
    blobs: BlobStore<'repo>,
    builder: tar::Builder<W>,
    mtime: u64,
    interrupt: &'repo AtomicBool,
}

impl<W: Write> TreeArchive<'_, W> {
    /// Appends every member of `tree_id` below `prefix`, depth first in Git's stored order,
    /// so the same tree always produces the same archive.
    ///
    /// Symlinks are skipped because copy destinations only extract files and directories,
    /// and a submodule becomes an empty directory, as in a fresh clone or `git archive`.
    fn append_tree(&mut self, tree_id: gix::ObjectId, prefix: &Path) -> Result<(), GitFailure> {
        check_interrupt(self.interrupt, "Git archive")?;
        // The entries are detached so the tree's data is released before descending.
        let entries = self
            .repo
            .find_tree(tree_id)
            .map_err(|error| internal_failure("read Git tree", error))?
            .iter()
            .map(|entry| entry.map(|entry| gix::objs::tree::Entry::from(entry.detach())))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| internal_failure("decode Git tree", error))?;
        for entry in entries {
            // A crafted tree could name `..` or embed a separator to escape the archive root.
            let name: &[u8] = &entry.filename;
            if name.is_empty() || name == b"." || name == b".." || name.contains(&b'/') {
                continue;
            }
            let path = prefix.join(OsStr::from_bytes(name));
            if entry.mode.is_tree() {
                self.append_directory(&path)?;
                self.append_tree(entry.oid, &path)?;
            } else if entry.mode.is_commit() {
                self.append_directory(&path)?;
            } else if entry.mode.is_blob() {
                self.append_blob(&path, entry.oid, entry.mode.is_executable())?;
            }
        }
        Ok(())
    }

    /// Appends one directory member.
    fn append_directory(&mut self, path: &Path) -> Result<(), GitFailure> {
        let mut header = self.header(tar::EntryType::Directory, 0o755, 0);
        self.builder
            .append_data(&mut header, path, std::io::empty())
            .map_err(|error| io_failure("append directory to Git archive", error))
    }

    /// Appends one file member, streaming its content from the object database.
    fn append_blob(
        &mut self,
        path: &Path,
        id: gix::ObjectId,
        executable: bool,
    ) -> Result<(), GitFailure> {
        check_interrupt(self.interrupt, "Git archive")?;
        let (size, reader) = self.blobs.open(id)?;
        let mode = if executable { 0o755 } else { 0o644 };
        let mut header = self.header(tar::EntryType::Regular, mode, size);
        self.builder
            .append_data(&mut header, path, reader)
            .map_err(|error| io_failure("append file to Git archive", error))
    }

    /// Builds a member header with the archive's shared ownership and time.
    fn header(&self, kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_size(size);
        header.set_mtime(self.mtime);
        header
    }
}

/// Opens committed blobs as readers, preferring incremental inflation over gix's whole-object
/// reads. Pack indexes are opened once per export, since an archive reads many blobs.
struct BlobStore<'repo> {
    repo: &'repo gix::Repository,
    /// The repository's object directory followed by its alternates, in lookup order.
    object_directories: Vec<PathBuf>,
    /// Pack indexes per object directory, opened when that directory is first searched.
    indexes: HashMap<PathBuf, Vec<pack::index::File>>,
    /// The repository reopened with [`Self::delta_alloc_limit`], when a delta is first read;
    /// gix fixes the limit when it opens the object store.
    limited: Option<gix::Repository>,
    /// Bytes gix may allocate at once while rebuilding a delta.
    delta_alloc_limit: u64,
}

impl<'repo> BlobStore<'repo> {
    /// Collects the object directories gix itself would search.
    fn new(repo: &'repo gix::Repository) -> Result<Self, GitFailure> {
        let objects = repo.objects.store_ref().path().to_path_buf();
        let current_dir = std::env::current_dir().unwrap_or_else(|_| objects.clone());
        let mut object_directories = vec![objects.clone()];
        object_directories.extend(
            gix::odb::alternate::resolve(objects, &current_dir)
                .map_err(|error| internal_failure("resolve Git alternates", error))?,
        );
        Ok(Self {
            repo,
            object_directories,
            indexes: HashMap::new(),
            limited: None,
            delta_alloc_limit: DELTA_ALLOC_LIMIT_BYTES,
        })
    }

    /// Returns a blob's size and a reader that yields exactly that many bytes or fails.
    fn open(&mut self, id: gix::ObjectId) -> Result<(u64, Box<dyn Read + 'repo>), GitFailure> {
        let header = self
            .repo
            .find_header(id)
            .map_err(|error| internal_failure("read Git object header", error))?;
        if header.kind() != gix::object::Kind::Blob {
            return Err(GitFailure::new(
                CommandErrorKind::InvalidInput,
                "Git tree entry does not name a file",
            ));
        }
        let size = header.size();
        let stream = match self.stream(id, size)? {
            Some(stream) => stream,
            None => self.read_into_memory(id, size)?,
        };
        Ok((
            size,
            Box::new(ExactLength {
                inner: stream.take(size),
                remaining: size,
            }),
        ))
    }

    /// Finds the blob as a loose object or an undeltified pack entry and returns its inflating
    /// stream, or `None` when only gix can rebuild it.
    fn stream(
        &mut self,
        id: gix::ObjectId,
        size: u64,
    ) -> Result<Option<Box<dyn Read + 'repo>>, GitFailure> {
        let hex = id.to_hex().to_string();
        for directory in self.object_directories.clone() {
            let loose = directory.join(&hex[..2]).join(&hex[2..]);
            match File::open(&loose) {
                Ok(file) => return open_loose(file, size).map(Some),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_failure("open loose Git object", error)),
            }
            let object_hash = self.repo.object_hash();
            let indexes = match self.indexes.entry(directory.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(open_pack_indexes(&directory, object_hash)?)
                }
            };
            for index in indexes.iter() {
                let Some(position) = index.lookup(id) else {
                    continue;
                };
                let offset = index.pack_offset_at_index(position);
                return open_packed(&index.path().with_extension("pack"), offset);
            }
        }
        Ok(None)
    }

    /// Reads a deltified blob through gix, which needs it and its bases in memory, so only up
    /// to [`MAX_DELTA_BLOB_BYTES`] and with every allocation of the rebuild capped.
    fn read_into_memory(
        &mut self,
        id: gix::ObjectId,
        size: u64,
    ) -> Result<Box<dyn Read + 'repo>, GitFailure> {
        if size > MAX_DELTA_BLOB_BYTES {
            return Err(GitFailure::new(
                CommandErrorKind::InvalidInput,
                format!(
                    "This {size}-byte file is stored as a Git delta, which cannot be read from \
history in bounded memory; files up to {MAX_DELTA_BLOB_BYTES} bytes are supported"
                ),
            ));
        }
        let limited = match &mut self.limited {
            Some(limited) => limited,
            None => {
                let mut options = self.repo.open_options().clone();
                // gix applies object environment overrides after API config overrides.
                // Preserve trust and other permissions, but keep GIT_ALLOC_LIMIT from
                // raising the memory ceiling of this export.
                options.permissions.env.objects = gix::sec::Permission::Deny;
                self.limited.insert(
                    gix::open_opts(
                        self.repo.git_dir(),
                        options.config_overrides([format!(
                            "gitoxide.objects.allocLimit={}",
                            self.delta_alloc_limit
                        )]),
                    )
                    .map_err(|error| {
                        internal_failure("open Git repository for delta reads", error)
                    })?,
                )
            }
        };
        let object = limited.find_object(id).map_err(|error| {
            let allocation_limit = error.classify().any(|classification| {
                classification.class()
                    == gix::error::Class::ResourceExhaustion(
                        gix::error::ResourceExhaustionKind::AllocationLimit,
                    )
            });
            if allocation_limit {
                GitFailure::new(
                    CommandErrorKind::InvalidInput,
                    format!(
                        "This {size}-byte file is stored as a Git delta whose bases need more than \
{} bytes of memory to rebuild: {error}",
                        self.delta_alloc_limit
                    ),
                )
            } else {
                internal_failure("read deltified Git blob", error)
            }
        })?;
        Ok(Box::new(std::io::Cursor::new(object.detach().data)))
    }
}

/// Opens every pack index of one object directory.
fn open_pack_indexes(
    directory: &Path,
    object_hash: gix::hash::Kind,
) -> Result<Vec<pack::index::File>, GitFailure> {
    let entries = match std::fs::read_dir(directory.join("pack")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_failure("list Git packs", error)),
    };
    let mut indexes = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| io_failure("list Git packs", error))?
            .path();
        if path.extension() != Some(OsStr::new("idx")) {
            continue;
        }
        indexes.push(
            pack::index::File::at(&path, object_hash)
                .map_err(|error| internal_failure("open Git pack index", error))?,
        );
    }
    Ok(indexes)
}

/// Opens a loose object's zlib stream positioned after its `blob <size>\0` header.
fn open_loose<'a>(file: File, size: u64) -> Result<Box<dyn Read + 'a>, GitFailure> {
    let mut decoder = ZlibDecoder::new(BufReader::with_capacity(COMPRESSED_BUFFER_BYTES, file));
    let mut header = Vec::with_capacity(MAX_LOOSE_HEADER_BYTES);
    let mut byte = [0_u8; 1];
    loop {
        decoder
            .read_exact(&mut byte)
            .map_err(|error| io_failure("read loose Git object header", error))?;
        if byte[0] == 0 {
            break;
        }
        if header.len() == MAX_LOOSE_HEADER_BYTES {
            return Err(corrupt_object("loose object header is too long"));
        }
        header.push(byte[0]);
    }
    if header != format!("blob {size}").as_bytes() {
        return Err(corrupt_object(
            "loose object header does not match its index",
        ));
    }
    Ok(Box::new(decoder))
}

/// Opens a pack entry's zlib stream when the entry is an undeltified blob, or `None` for a
/// delta that only gix can apply.
fn open_packed<'a>(
    pack_path: &Path,
    offset: pack::data::Offset,
) -> Result<Option<Box<dyn Read + 'a>>, GitFailure> {
    let mut file = File::open(pack_path).map_err(|error| io_failure("open Git pack", error))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_failure("seek Git pack", error))?;
    let mut header = [0_u8; MAX_PACK_HEADER_BYTES];
    let read = read_up_to(&mut file, &mut header)?;
    let header_length = header[..read]
        .iter()
        .position(|byte| byte & 0x80 == 0)
        .ok_or_else(|| corrupt_object("pack entry header is truncated"))?
        + 1;
    if (header[0] >> 4) & 0b111 != PACK_BLOB_TYPE {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(offset + header_length as u64))
        .map_err(|error| io_failure("seek Git pack", error))?;
    Ok(Some(Box::new(ZlibDecoder::new(BufReader::with_capacity(
        COMPRESSED_BUFFER_BYTES,
        file,
    )))))
}

/// Fills as much of `buffer` as the file has, so a short final entry still parses.
fn read_up_to(file: &mut File, buffer: &mut [u8]) -> Result<usize, GitFailure> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(io_failure("read Git pack", error)),
        }
    }
    Ok(filled)
}

/// Reports an object store that does not match its own index as corrupt.
fn corrupt_object(detail: &str) -> GitFailure {
    GitFailure::new(
        CommandErrorKind::Internal,
        format!("Git object store is corrupt: {detail}"),
    )
}

/// Fails a blob stream that ends before its recorded size, so a truncated object can never
/// pass as a complete file or misalign the tar members after it.
struct ExactLength<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> Read for ExactLength<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 || buffer.is_empty() {
            return Ok(0);
        }
        let read = self.inner.read(buffer)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                format!(
                    "Git object ended {} bytes before its recorded size",
                    self.remaining
                ),
            ));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::{TempDir, git_command};
    use std::process::Command;

    /// Runs git in `dir`; the fixtures use the real CLI so loose, packed and deltified objects
    /// are laid out exactly as Git writes them.
    fn git(dir: &Path, args: &[&str]) {
        let status = git_command()
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "core.bigFileThreshold=1k",
            ])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    /// A repository with a large file, a small file that changes, a symlink and a subdirectory.
    fn fixture() -> TempDir {
        let temp = TempDir::create();
        let dir = temp.path();
        git(dir, &["init", "-q"]);
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/big.bin"), vec![7_u8; 300_000]).unwrap();
        std::fs::write(dir.join("text.txt"), "first\n".repeat(100)).unwrap();
        std::os::unix::fs::symlink("text.txt", dir.join("link")).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "one"]);
        std::fs::write(dir.join("text.txt"), "first\n".repeat(101)).unwrap();
        git(dir, &["commit", "-q", "-am", "two"]);
        temp
    }

    /// Exports `path` at `rev` into memory.
    fn exported(path: &Path, rev: &str, include_root: bool) -> Vec<u8> {
        let mut out = Vec::new();
        export_blocking(
            path.to_str().unwrap(),
            rev,
            include_root,
            &mut out,
            &AtomicBool::new(false),
        )
        .unwrap();
        out
    }

    /// Loose and packed objects (deltified or not) stream the same committed bytes.
    #[test]
    fn files_stream_from_loose_and_packed_objects() {
        let temp = fixture();
        let dir = temp.path();
        // Loose objects inflate incrementally.
        assert_eq!(
            exported(&dir.join("text.txt"), "HEAD~1", false),
            "first\n".repeat(100).as_bytes()
        );
        git(dir, &["gc", "-q", "--aggressive"]);
        // After gc the old version is usually a delta, the new one a base or the reverse;
        // both must read back exactly.
        assert_eq!(
            exported(&dir.join("text.txt"), "HEAD~1", false),
            "first\n".repeat(100).as_bytes()
        );
        assert_eq!(
            exported(&dir.join("text.txt"), "HEAD", false),
            "first\n".repeat(101).as_bytes()
        );
        // Files above the big-file threshold are packed undeltified and stream from the pack.
        assert_eq!(
            exported(&dir.join("sub/big.bin"), "HEAD", false),
            vec![7_u8; 300_000]
        );
    }

    /// Each storage form takes its intended path: loose and undeltified packed blobs stream,
    /// and only deltas fall back to gix.
    #[test]
    fn storage_forms_choose_their_read_path() {
        let temp = fixture();
        let dir = temp.path();
        let repo = gix::open(dir).unwrap();
        let blob = |rev: &str| repo.rev_parse_single(rev).unwrap().detach();
        let (old_text, big) = (blob("HEAD~1:text.txt"), blob("HEAD:sub/big.bin"));
        let size = |id| repo.find_header(id).unwrap().size();
        let mut store = BlobStore::new(&repo).unwrap();
        // Before packing every object is loose and streams.
        assert!(store.stream(old_text, size(old_text)).unwrap().is_some());
        git(dir, &["gc", "-q", "--aggressive"]);
        let repo = gix::open(dir).unwrap();
        let mut store = BlobStore::new(&repo).unwrap();
        // A file above the big-file threshold is packed whole, so it streams from the pack.
        assert!(store.stream(big, size(big)).unwrap().is_some());
        let deltas = [old_text, blob("HEAD:text.txt")]
            .into_iter()
            .filter(|id| store.stream(*id, size(*id)).unwrap().is_none())
            .count();
        // Two near-identical small versions pack as a base and a delta; the delta needs gix.
        assert_eq!(deltas, 1);
    }

    /// Delta rebuilds run under gix's allocation limit, which also bounds bases and
    /// intermediates larger than the blob being read.
    #[test]
    fn delta_reads_respect_the_allocation_limit() {
        let temp = fixture();
        let dir = temp.path();
        git(dir, &["gc", "-q", "--aggressive"]);
        let repo = gix::open(dir).unwrap();
        let mut store = BlobStore::new(&repo).unwrap();
        let delta = ["HEAD~1:text.txt", "HEAD:text.txt"]
            .into_iter()
            .map(|rev| repo.rev_parse_single(rev).unwrap().detach())
            .find(|id| {
                let size = repo.find_header(*id).unwrap().size();
                store.stream(*id, size).unwrap().is_none()
            })
            .unwrap();
        let size = repo.find_header(delta).unwrap().size();
        store.delta_alloc_limit = 64;
        // A blob far below the size cap still fails when rebuilding it needs more memory.
        let error = store.read_into_memory(delta, size).err().unwrap();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }

    /// Environment tests run in a child so inherited Git settings cannot affect other tests.
    #[test]
    fn delta_allocation_limit_ignores_environment() {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "commands::git::export::tests::delta_reads_respect_the_allocation_limit",
                "--nocapture",
            ])
            .env("GIT_ALLOC_LIMIT", "1g")
            .status()
            .unwrap();
        // Even an environment ceiling above the test's cap must not permit reconstruction.
        assert!(status.success());
    }

    /// Corrupt or missing objects are internal failures, rather than unsupported blob sizes.
    #[test]
    fn delta_read_preserves_nonallocation_failures() {
        let temp = fixture();
        let repo = gix::open(temp.path()).unwrap();
        let mut store = BlobStore::new(&repo).unwrap();
        let missing = gix::ObjectId::null(repo.object_hash());
        let error = store.read_into_memory(missing, 1).err().unwrap();
        // A missing object must not tell users that increasing a memory limit would help.
        assert_eq!(error.kind, CommandErrorKind::Internal);
        assert!(error.message.contains("read deltified Git blob"));
    }

    /// Directories archive files and subdirectories but leave out symlinks.
    #[test]
    fn directories_archive_files_without_symlinks() {
        let temp = fixture();
        let dir = temp.path();
        let archive = exported(dir, "HEAD~1", true);
        let mut names = tar::Archive::new(archive.as_slice())
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().display().to_string())
            .collect::<Vec<_>>();
        names.sort();
        let root = dir.file_name().unwrap().to_str().unwrap();
        // The root directory wraps everything for user extraction, and the symlink is skipped
        // because copy destinations only accept files and directories.
        assert_eq!(
            names,
            [
                root.to_string(),
                format!("{root}/sub"),
                format!("{root}/sub/big.bin"),
                format!("{root}/text.txt"),
            ]
        );
    }

    /// Stat names the resolved commit and refuses nothing, leaving policy to the caller.
    #[test]
    fn stat_classifies_entries() {
        let temp = fixture();
        let dir = temp.path();
        let stat =
            |path: &str| stat_blocking(dir.join(path).to_str().unwrap(), "HEAD", None).unwrap();
        // File sizes come from object headers.
        assert_eq!(
            stat("text.txt").kind,
            GitRevisionStatKind::File {
                size: 606,
                executable: false
            }
        );
        // Directories and symlinks are told apart so copies pick tar or refuse.
        assert_eq!(stat("sub").kind, GitRevisionStatKind::Directory);
        assert_eq!(stat("link").kind, GitRevisionStatKind::Symlink);
        // The commit id lets later reads ignore a branch that moves meanwhile.
        assert_eq!(stat("sub").commit_id.len(), 40);
    }

    /// Replacement targets are resolved through the filesystem, so an alias of the worktree
    /// or one of its parents is recognized as containing the repository.
    #[test]
    fn stat_resolves_replacement_targets() {
        let temp = fixture();
        let dir = temp.path();
        let outside = TempDir::create();
        let alias = outside.path().join("alias");
        std::os::unix::fs::symlink(dir.parent().unwrap(), &alias).unwrap();
        let name = dir.file_name().unwrap().to_str().unwrap();
        let replaces = |target: String| {
            stat_blocking(dir.join("sub").to_str().unwrap(), "HEAD", Some(&target))
                .unwrap()
                .replaces_repository
        };
        // The worktree itself and its parents hold `.git`.
        assert!(replaces(dir.display().to_string()));
        assert!(replaces(dir.parent().unwrap().display().to_string()));
        // A symlinked parent reaches the same worktree under another name.
        assert!(replaces(alias.join(name).display().to_string()));
        // A final symlink is replaced as an entry rather than deleting its target.
        let final_link = outside.path().join("repository-link");
        std::os::unix::fs::symlink(dir, &final_link).unwrap();
        assert!(!replaces(final_link.display().to_string()));
        // Missing parents make publication fail; lexical normalization must not invent them.
        assert!(!replaces(format!("{}/missing/../{name}", alias.display())));
        // Directories inside the worktree and missing paths hold no `.git`.
        assert!(!replaces(dir.join("sub").display().to_string()));
        assert!(!replaces(dir.join("missing").display().to_string()));
    }
}
