//! Commands the server sends to agents and the shared types their responses use.

use crate::api::files::LsEntry;
use crate::wire::request;
use serde::{Deserialize, Serialize};

/// Every operation the server can ask an agent to perform; one enum keeps the wire contract
/// and the agent's dispatch match exhaustive. Each variant's payload is the request struct
/// that also names the command's response type (see [`request::AgentRequest`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    ListPartials(request::ListPartials),
    ProbePartial(request::ProbePartial),
    ReadPartial(request::ReadPartial),
    DeletePartial(request::DeletePartial),
    PersistPartial(request::PersistPartial),
    HashSegments(request::HashSegments),
    Exec(request::Exec),
    Ls(request::Ls),
    FileSearch(request::FileSearch),
    ContentGrep(request::ContentGrep),
    RawDownload(request::RawDownload),
    TarDownload(request::TarDownload),
    RawUpload(request::RawUpload),
    EditFile(request::EditFile),
    TarUpload(request::TarUpload),
    LocalCopyFile(request::LocalCopyFile),
    LocalCopyDirectory(request::LocalCopyDirectory),
    LocalMove(request::LocalMove),
    RawDelete(request::RawDelete),
    Trash(request::Trash),
    ListTrash(request::ListTrash),
    EmptyTrash(request::EmptyTrash),
    RestoreTrash(request::RestoreTrash),
    CreateDirectory(request::CreateDirectory),
    RenamePath(request::RenamePath),
    ChownPath(request::ChownPath),
    ChmodPath(request::ChmodPath),
    ListAccounts(request::ListAccounts),
    Metadata(request::Metadata),
    DirectorySize(request::DirectorySize),
    GitContext(request::GitContext),
    GitStatus(request::GitStatus),
    GitDiff(request::GitDiff),
    GitRevisionTree(request::GitRevisionTree),
    GitRevisionContent(request::GitRevisionContent),
    GitCommitDiff(request::GitCommitDiff),
    GitLog(request::GitLog),
    GitCommitNeighbors(request::GitCommitNeighbors),
    GitRefList(request::GitRefList),
    GitWorktreeList(request::GitWorktreeList),
    GitWorktreeStatus(request::GitWorktreeStatus),
    GitRevisionStat(request::GitRevisionStat),
    GitDownload(request::GitDownload),
    MoveMetadata(request::MoveMetadata),
    DeleteMoveSource(request::DeleteMoveSource),
    OpenPath(request::OpenPath),
    Echo(request::Echo),
    GetAgentDetails(request::GetAgentDetails),
    GetLoggingLevel(request::GetLoggingLevel),
    SetLoggingLevel(request::SetLoggingLevel),
    Restart(request::Restart),
    SelfExec(request::SelfExec),
}

impl Command {
    /// Short operator-facing label without large or sensitive payloads.
    pub fn summary(&self) -> String {
        match self {
            Self::ListPartials(_) => "ListPartials".into(),
            Self::ProbePartial(_) => "ProbePartial".into(),
            Self::ReadPartial(_) => "ReadPartial".into(),
            Self::DeletePartial(_) => "DeletePartial".into(),
            Self::PersistPartial(_) => "PersistPartial".into(),
            Self::HashSegments(_) => "HashSegments".into(),
            Self::Ls(request) => match &request.path {
                Some(path) => format!("Ls path={path}"),
                None => "Ls path=.".to_string(),
            },
            Self::FileSearch(request) => format!(
                "FileSearch path={} query={} timeout={}s include_hidden={} respect_gitignore={} case_sensitivity={:?} directories_only={}",
                request.path,
                request.query,
                request.timeout_seconds,
                request.include_hidden,
                request.respect_gitignore,
                request.case_sensitivity,
                request.directories_only
            ),
            Self::ContentGrep(request) => format!(
                "ContentGrep path={} query={} timeout={}s include_hidden={} respect_gitignore={} fixed_string={} case_sensitivity={:?} before_context={} after_context={}",
                request.path,
                request.query,
                request.timeout_seconds,
                request.include_hidden,
                request.respect_gitignore,
                request.fixed_string,
                request.case_sensitivity,
                request.before_context,
                request.after_context
            ),
            Self::RawDownload(request) => {
                let path = &request.path;
                match (request.range_start, request.range_end) {
                    (Some(start), Some(end)) => {
                        format!("RawDownload path={path} range={start}-{end}")
                    }
                    (Some(start), None) => format!("RawDownload path={path} range_start={start}"),
                    (None, Some(end)) => format!("RawDownload path={path} range_end={end}"),
                    (None, None) => format!("RawDownload path={path}"),
                }
            }
            Self::TarDownload(request) => format!(
                "TarDownload path={} include_root={}",
                request.path, request.include_root
            ),
            Self::Exec(_) => "Exec".to_owned(),
            Self::RawUpload(request) => format!(
                "RawUpload path={} on_existing={:?}",
                request.path, request.on_existing
            ),
            Self::EditFile(request) => format!("EditFile path={}", request.path),
            Self::TarUpload(request) => format!(
                "TarUpload path={} on_existing={:?}",
                request.path, request.on_existing
            ),
            Self::LocalCopyFile(request) => format!(
                "LocalCopyFile source={} dest={} on_existing={:?}",
                request.source_path, request.dest_path, request.on_existing
            ),
            Self::LocalCopyDirectory(request) => format!(
                "LocalCopyDirectory source={} dest={} on_existing={:?}",
                request.source_path, request.dest_path, request.on_existing
            ),
            Self::LocalMove(request) => format!(
                "LocalMove source={} dest={} directory={} on_existing={:?}",
                request.source_path,
                request.dest_path,
                request.source_is_directory,
                request.on_existing
            ),
            Self::RawDelete(request) => format!("RawDelete path={}", request.path),
            Self::Trash(request) => format!("Trash path={}", request.path),
            Self::ListTrash(_) => "ListTrash".to_string(),
            Self::EmptyTrash(_) => "EmptyTrash".to_string(),
            Self::RestoreTrash(request) => format!(
                "RestoreTrash location={} item={} destination={}",
                request.location_id, request.item_id, request.destination_path
            ),
            Self::CreateDirectory(request) => format!("CreateDirectory path={}", request.path),
            Self::RenamePath(request) => format!(
                "RenamePath dir={} old={} new={}",
                request.dir, request.old, request.new
            ),
            Self::ChownPath(request) => format!(
                "ChownPath path={} owner={:?} group={:?}",
                request.path, request.owner, request.group
            ),
            Self::ChmodPath(request) => format!(
                "ChmodPath path={} permissions={:#o}",
                request.path, request.permissions
            ),
            Self::ListAccounts(_) => "ListAccounts".to_string(),
            Self::Metadata(request) => format!("Metadata path={}", request.path),
            Self::DirectorySize(request) => format!(
                "DirectorySize path={} timeout={}s",
                request.path, request.timeout_seconds
            ),
            Self::GitContext(request) => format!("GitContext path={}", request.path),
            Self::GitStatus(request) => format!("GitStatus path={}", request.path),
            Self::GitDiff(request) => format!(
                "GitDiff files={} mode={:?}",
                request.files.len(),
                request.mode
            ),
            Self::GitRevisionTree(request) => {
                format!("GitRevisionTree path={} rev={}", request.path, request.rev)
            }
            Self::GitRevisionContent(request) => {
                format!(
                    "GitRevisionContent path={} rev={}",
                    request.path, request.rev
                )
            }
            Self::GitCommitDiff(request) => {
                format!("GitCommitDiff path={} rev={}", request.path, request.rev)
            }
            Self::GitLog(request) => format!(
                "GitLog path={} rev={} skip={} limit={}",
                request.path,
                request.rev.as_deref().unwrap_or("HEAD"),
                request.page.skip,
                request.page.limit
            ),
            Self::GitCommitNeighbors(request) => {
                format!(
                    "GitCommitNeighbors path={} rev={}",
                    request.path, request.rev
                )
            }
            Self::GitRefList(request) => format!(
                "GitRefList path={} kind={:?} sort={:?} skip={} limit={}",
                request.path, request.kind, request.sort, request.page.skip, request.page.limit
            ),
            Self::GitWorktreeList(request) => format!("GitWorktreeList path={}", request.path),
            Self::GitWorktreeStatus(request) => format!("GitWorktreeStatus path={}", request.path),
            Self::GitRevisionStat(request) => {
                format!("GitRevisionStat path={} rev={}", request.path, request.rev)
            }
            Self::GitDownload(request) => format!(
                "GitDownload path={} rev={} include_root={}",
                request.path, request.rev, request.include_root
            ),
            Self::MoveMetadata(request) => format!("MoveMetadata path={}", request.path),
            Self::DeleteMoveSource(request) => format!("DeleteMoveSource path={}", request.path),
            Self::OpenPath(request) => format!("OpenPath path={}", request.path),
            // Echo bodies can be large or sensitive, so only the command name is logged.
            Self::Echo(_) => "Echo".to_string(),
            Self::GetAgentDetails(_) => "GetAgentDetails".to_string(),
            Self::GetLoggingLevel(_) => "GetLoggingLevel".to_string(),
            Self::SetLoggingLevel(request) => format!("SetLoggingLevel level={}", request.level),
            Self::Restart(_) => "Restart".to_string(),
            Self::SelfExec(request) => format!("SelfExec path={}", request.path),
        }
    }
}

/// Carries directory metadata with its entries so clients can show either a list or details.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LsDirectoryResult {
    pub files: Vec<LsEntry>,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub permissions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Carries file metadata from an agent without requiring the server to inspect the remote filesystem.
pub struct LsFileResult {
    pub size: u64,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub permissions: u32,
}

/// Identifies one filesystem object strongly enough to refuse deletion after path replacement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoveSourceIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanoseconds: i64,
    pub is_directory: bool,
}

impl MoveSourceIdentity {
    /// Captures the identity from one metadata read so every move, trash restore and conditional
    /// source deletion compares the same fields.
    #[cfg(unix)]
    pub fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;

        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            is_directory: metadata.is_dir(),
        }
    }
}

/// Returns move-specific metadata without exposing filesystem identity through the public API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveMetadataResult {
    pub file_size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub identity: MoveSourceIdentity,
}

/// What a path is at a Git revision, as far as copying or downloading it is concerned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GitRevisionStatKind {
    /// A regular or executable file, with its size read from the object header.
    File {
        size: u64,
        /// Git's `100755` mode, so a restored script is still runnable.
        executable: bool,
    },
    Directory,
    /// Symlinks and submodules have no content a copy could write, so callers refuse them.
    Symlink,
    Submodule,
}

/// Answers [`request::GitRevisionStat`]: the entry kind and the commit the revision named.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRevisionStatResult {
    pub commit_id: String,
    pub kind: GitRevisionStatKind,
    /// Whether [`request::GitRevisionStat::replace_target`] contains the repository's
    /// worktree root once both are resolved through the agent's filesystem. A committed tree
    /// has no `.git`, so replacing such a directory with it would delete the repository; the
    /// server refuses that.
    pub replaces_repository: bool,
}

/// Agent's echo reply, used to verify the command round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EchoResult {
    pub message: String,
}

/// Classifies command failures so transports do not depend on OS-specific text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandErrorKind {
    NotFound,
    PermissionDenied,
    NotADirectory,
    IsDirectory,
    AlreadyExists,
    Conflict,
    InvalidInput,
    ServiceUnavailable,
    /// The server canceled the request before it finished.
    Canceled,
    /// Durable destination persistence is the explicit acknowledgement of pause.
    Paused,
    /// Resume authorization no longer identifies the opened source file.
    SourceChanged,
    Internal,
}

impl CommandErrorKind {
    /// Converts one I/O failure into a stable command error kind.
    pub fn from_io_error(error: &std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound,
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            std::io::ErrorKind::NotADirectory => Self::NotADirectory,
            std::io::ErrorKind::IsADirectory => Self::IsDirectory,
            std::io::ErrorKind::AlreadyExists => Self::AlreadyExists,
            std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
                Self::InvalidInput
            }
            _ => Self::Internal,
        }
    }

    /// Severity a command failure of this kind is logged at.
    ///
    /// Only failures an operator must fix (broken permissions, internal faults) reach error
    /// level; outcomes users resolve themselves, like missing paths or name conflicts, would
    /// otherwise drown real problems in default logs.
    pub fn log_level(&self) -> crate::wire::log::Level {
        use crate::wire::log::Level;
        match self {
            Self::Internal | Self::PermissionDenied => Level::Error,
            Self::ServiceUnavailable => Level::Warning,
            Self::Canceled | Self::Paused => Level::Debug,
            Self::NotFound
            | Self::NotADirectory
            | Self::IsDirectory
            | Self::AlreadyExists
            | Self::Conflict
            | Self::InvalidInput
            | Self::SourceChanged => Level::Info,
        }
    }
}
