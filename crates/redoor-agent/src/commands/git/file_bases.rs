//! The committed and staged text of one file, for the editor's Git gutter.
//!
//! The browser diffs these texts against the editor buffer itself, so the gutter follows
//! unsaved edits without asking the agent again. HEAD is sent only when it differs from the
//! index, which is the usual case of nothing staged costing a single copy of the file.

use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

use gix::bstr::ByteSlice;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use redoor_core::log;
use redoor_protocol::{
    api::git::{
        file_bases::{GitFileBasesResponse, GitHeadBase, MAX_GIT_FILE_BASES_ENCODED_BYTES},
        worktree::GitTrackingState,
    },
    wire::{command::CommandErrorKind, log::Level, request::CommandError},
};

use super::{
    GitFailure, check_interrupt,
    diff::{DiffSource, json_encoded_len, path_declared_binary, read_object_blob},
    discover_repository, head_tree, internal_failure, io_failure, run_blocking,
    status::classify_tracking,
    utf8_relative, validate_absolute_path,
};

/// Reads the texts the editor compares the file at `path` with.
///
/// When `cancel` fires (the file was closed or the connection ended) the read is dropped at
/// once, which interrupts the ignore check's walk, so switching quickly between files never
/// queues reads nobody waits for.
pub(crate) async fn bases(
    path: String,
    cancel: &CancellationToken,
) -> Result<GitFileBasesResponse, CommandError> {
    let started_at = Instant::now();
    let read = run_blocking({
        let path = path.clone();
        move |interrupt| bases_blocking(&path, interrupt)
    });
    let Some(result) = cancel.run_until_cancelled(read).await else {
        // Lets an operator confirm that leaving a file stops its read on the agent.
        log!(
            Level::Debug,
            "Git file bases canceled: path={path} elapsed_ms={}",
            started_at.elapsed().as_millis()
        );
        return Err(CommandError::new(
            CommandErrorKind::Canceled,
            "Reading the Git file bases was canceled",
        ));
    };
    result
}

/// Where one side of the comparison lives, resolved before any blob is inflated.
enum BaseObject {
    /// The side has no entry for the path.
    Missing,
    /// A regular file blob.
    Blob(gix::ObjectId),
    /// A symlink, submodule or tree, which has no lines to compare.
    Unsupported,
}

impl BaseObject {
    /// The blob id, or none for a missing entry, used to tell whether HEAD equals the index.
    fn id(&self) -> Option<gix::ObjectId> {
        match self {
            Self::Blob(id) => Some(*id),
            Self::Missing | Self::Unsupported => None,
        }
    }
}

/// Answers in a fixed order: repository, file kind, conflicts, ignore rules, then the texts.
/// Cheap header checks run before inflating anything, so a large blob is never read whole.
fn bases_blocking(
    path: &str,
    interrupt: Arc<AtomicBool>,
) -> Result<GitFileBasesResponse, GitFailure> {
    let requested = validate_absolute_path(path)?;
    let Some(repository) = discover_repository(requested.clone())? else {
        return Ok(GitFileBasesResponse::OutsideWorktree);
    };
    let relative = utf8_relative(&repository.relative)?;
    if relative.is_empty() {
        return Err(GitFailure::new(
            CommandErrorKind::InvalidInput,
            "Git file bases path must select a file",
        ));
    }
    // The editor shows a symlink's target, while Git stores the link text, so their lines
    // have nothing to do with each other.
    match std::fs::symlink_metadata(&requested) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Ok(GitFileBasesResponse::Unsupported);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_failure("inspect Git file", error)),
    }

    let repo = &repository.repo;
    let index = repo
        .index_or_empty()
        .map_err(|error| internal_failure("open Git index", error))?;
    let relative_bytes = relative.as_bytes().as_bstr();
    if index
        .entries()
        .iter()
        .any(|entry| entry.path(&index) == relative_bytes && entry.flags.stage_raw() != 0)
    {
        return Ok(GitFileBasesResponse::Conflicted);
    }
    let index_object = match index.entry_by_path(relative_bytes) {
        None => BaseObject::Missing,
        Some(entry)
            if entry
                .mode
                .to_tree_entry_mode()
                .is_some_and(|mode| mode.is_blob()) =>
        {
            BaseObject::Blob(entry.id)
        }
        Some(_) => BaseObject::Unsupported,
    };
    drop(index);
    // Only a path the index does not track can be ignored, so tracked files skip the walk.
    if matches!(index_object, BaseObject::Missing)
        && classify_tracking(&repository, relative.as_bytes(), interrupt.clone())?
            == GitTrackingState::Ignored
    {
        return Ok(GitFileBasesResponse::Ignored);
    }
    let head_object = head_object(repo, &repository.relative)?;
    if matches!(index_object, BaseObject::Unsupported)
        || matches!(head_object, BaseObject::Unsupported)
        || path_declared_binary(repo, &repository.relative)?
    {
        return Ok(GitFileBasesResponse::Unsupported);
    }
    check_interrupt(&interrupt, "Reading the Git file bases")?;

    let index_text = match read_text(repo, &index_object)? {
        BaseText::Text(text) => text,
        BaseText::TooLarge => return Ok(GitFileBasesResponse::TooLarge),
        BaseText::Unsupported => return Ok(GitFileBasesResponse::Unsupported),
    };
    let head = if head_object.id() == index_object.id() {
        GitHeadBase::SameAsIndex
    } else {
        match read_text(repo, &head_object)? {
            BaseText::Text(None) => GitHeadBase::Missing,
            BaseText::Text(Some(content)) => GitHeadBase::Text { content },
            BaseText::TooLarge => return Ok(GitFileBasesResponse::TooLarge),
            BaseText::Unsupported => return Ok(GitFileBasesResponse::Unsupported),
        }
    };
    let head_text = match &head {
        GitHeadBase::Text { content } => Some(content.as_str()),
        GitHeadBase::SameAsIndex | GitHeadBase::Missing => None,
    };
    let encoded = [index_text.as_deref(), head_text]
        .into_iter()
        .flatten()
        .map(|text| json_encoded_len(text.as_bytes()))
        .sum::<usize>();
    if encoded > MAX_GIT_FILE_BASES_ENCODED_BYTES {
        return Ok(GitFileBasesResponse::TooLarge);
    }
    Ok(GitFileBasesResponse::Bases {
        index: index_text,
        head,
    })
}

/// Finds the path in the HEAD tree, treating an unborn branch as not having it.
fn head_object(repo: &gix::Repository, relative: &Path) -> Result<BaseObject, GitFailure> {
    let Some(tree) = head_tree(repo)? else {
        return Ok(BaseObject::Missing);
    };
    let entry = tree
        .lookup_entry_by_path(relative)
        .map_err(|error| internal_failure("lookup Git HEAD file", error))?;
    Ok(match entry {
        None => BaseObject::Missing,
        Some(entry) if entry.mode().is_blob() => BaseObject::Blob(entry.object_id()),
        Some(_) => BaseObject::Unsupported,
    })
}

/// One side's text, or why it cannot be compared line by line.
enum BaseText {
    /// The text, or none when the side has no entry.
    Text(Option<String>),
    TooLarge,
    Unsupported,
}

/// Inflates one side within the editor's size limit and keeps only UTF-8 text without NUL
/// bytes, the same gate the editor and the diff view apply.
fn read_text(repo: &gix::Repository, object: &BaseObject) -> Result<BaseText, GitFailure> {
    let id = match object {
        BaseObject::Missing => return Ok(BaseText::Text(None)),
        BaseObject::Unsupported => return Ok(BaseText::Unsupported),
        BaseObject::Blob(id) => *id,
    };
    Ok(match read_object_blob(repo, id)? {
        DiffSource::Content(bytes) if !bytes.contains(&0) => match String::from_utf8(bytes) {
            Ok(text) => BaseText::Text(Some(text)),
            Err(_) => BaseText::Unsupported,
        },
        DiffSource::TooLarge => BaseText::TooLarge,
        DiffSource::Missing => BaseText::Text(None),
        DiffSource::Content(_) | DiffSource::Unsupported => BaseText::Unsupported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
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

    /// Reads the bases of `relative` below the repository at `root`.
    fn bases_of(root: &Path, relative: &str) -> GitFileBasesResponse {
        let path = root.join(relative).display().to_string();
        bases_blocking(&path, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// A repository with one committed file and an ignore rule.
    fn fixture() -> TempDir {
        let temp = TempDir::create();
        let root = temp.path();
        git(root, &["init", "-q"]);
        write(root, ".gitignore", "*.log\n");
        write(root, "file.txt", "one\ntwo\n");
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "initial"]);
        temp
    }

    /// With nothing staged, HEAD is not sent again.
    #[test]
    fn unstaged_change_sends_the_index_once() {
        let repo = fixture();
        write(repo.path(), "file.txt", "one\nchanged\n");

        // The worktree text is never sent: the browser compares its own buffer.
        assert_eq!(
            bases_of(repo.path(), "file.txt"),
            GitFileBasesResponse::Bases {
                index: Some("one\ntwo\n".to_string()),
                head: GitHeadBase::SameAsIndex,
            }
        );
    }

    /// A staged change carries both texts, so staged lines can be told from unstaged ones.
    #[test]
    fn staged_change_sends_head_and_index() {
        let repo = fixture();
        write(repo.path(), "file.txt", "one\nstaged\n");
        git(repo.path(), &["add", "file.txt"]);

        assert_eq!(
            bases_of(repo.path(), "file.txt"),
            GitFileBasesResponse::Bases {
                index: Some("one\nstaged\n".to_string()),
                head: GitHeadBase::Text {
                    content: "one\ntwo\n".to_string()
                },
            }
        );
    }

    /// New files have no bases, which makes every line count as added.
    #[test]
    fn untracked_and_newly_staged_files() {
        let repo = fixture();
        write(repo.path(), "new.txt", "fresh\n");

        // Untracked: neither side has the file.
        assert_eq!(
            bases_of(repo.path(), "new.txt"),
            GitFileBasesResponse::Bases {
                index: None,
                head: GitHeadBase::SameAsIndex,
            }
        );

        git(repo.path(), &["add", "new.txt"]);

        // Staged as new: the index has it while HEAD does not.
        assert_eq!(
            bases_of(repo.path(), "new.txt"),
            GitFileBasesResponse::Bases {
                index: Some("fresh\n".to_string()),
                head: GitHeadBase::Missing,
            }
        );
    }

    /// Ignored files, files outside a repository and non-text blobs get no gutter.
    #[test]
    fn files_without_line_bases() {
        let repo = fixture();
        write(repo.path(), "debug.log", "ignored\n");
        write(repo.path(), "binary.bin", "a\0b");
        git(repo.path(), &["add", "binary.bin"]);

        // An ignore rule means there is nothing to compare with.
        assert_eq!(
            bases_of(repo.path(), "debug.log"),
            GitFileBasesResponse::Ignored
        );
        // A blob with NUL bytes has no lines the editor could show.
        assert_eq!(
            bases_of(repo.path(), "binary.bin"),
            GitFileBasesResponse::Unsupported
        );

        let outside = TempDir::create();
        write(outside.path(), "plain.txt", "plain\n");

        // Outside a worktree is an answer, not an error.
        assert_eq!(
            bases_of(outside.path(), "plain.txt"),
            GitFileBasesResponse::OutsideWorktree
        );
    }

    /// A symlink's blob is its target path, which has nothing to do with the shown text.
    #[test]
    fn symlinks_are_unsupported() {
        let repo = fixture();
        std::os::unix::fs::symlink("file.txt", repo.path().join("link.txt")).unwrap();
        git(repo.path(), &["add", "link.txt"]);

        assert_eq!(
            bases_of(repo.path(), "link.txt"),
            GitFileBasesResponse::Unsupported
        );
    }

    /// During a merge conflict the index has no single staged text to compare with.
    #[test]
    fn conflicts_are_reported() {
        let repo = fixture();
        git(repo.path(), &["checkout", "-q", "-b", "other"]);
        write(repo.path(), "file.txt", "one\nother\n");
        git(repo.path(), &["commit", "-q", "-am", "other"]);
        git(repo.path(), &["checkout", "-q", "-"]);
        write(repo.path(), "file.txt", "one\nmain\n");
        git(repo.path(), &["commit", "-q", "-am", "main"]);
        // The merge fails on the conflict, which is the state under test.
        let _ = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "merge",
                "-q",
                "other",
            ])
            .current_dir(repo.path())
            .output()
            .unwrap();

        assert_eq!(
            bases_of(repo.path(), "file.txt"),
            GitFileBasesResponse::Conflicted
        );
    }

    /// A canceled request answers at once with a cancellation instead of reading.
    #[tokio::test]
    async fn canceled_request_answers_without_reading() {
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = bases("/".to_string(), &cancel).await.unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Canceled);
    }
}
