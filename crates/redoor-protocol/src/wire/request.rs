//! One struct per agent command, each tied to the response type its success carries.
//!
//! A command used to answer with one shared result enum, so every receiver had to match the
//! variant it expected and handle "unexpected result type" for all the others. Here the
//! response type is part of the request's type ([`AgentRequest::Response`]): the agent can only
//! answer a request with its own response, and the server decodes exactly that type.
//!
//! The structs are the payloads of the [`Command`] enum's variants, so the command JSON on the
//! wire is unchanged (`{"type":"Ls","path":...}`).

use crate::api::agents::{AgentAccountsResponse, AgentDetailsResponse, EchoRequest};
use crate::api::files::{
    ChmodPathResponse, ChownPathResponse, CreationOwnershipOptions, DirectorySizeResponse,
    MetadataResponse,
};
use crate::api::git::GitPage;
use crate::api::git::commit::GitCommitDiffResponse;
use crate::api::git::directory_entries::GitDirectoryEntriesResponse;
use crate::api::git::history::{GitCommitNeighborsResponse, GitLogResponse};
use crate::api::git::refs::{GitBranchScope, GitRefListKind, GitRefListResponse, GitRefSort};
use crate::api::git::revision::{GitRevisionContentResponse, GitRevisionTreeResponse};
use crate::api::git::worktree::{
    GitContextResponse, GitDiffMode, GitDiffResponse, GitStatusResponse,
};
use crate::api::git::worktree_list::GitWorktreeListResponse;
use crate::api::git::worktree_status::GitWorktreeStatusResponse;
use crate::api::search::{CaseSensitivity, ContentGrepResponse, FileSearchResponse};
use crate::api::transfers::CopyExistingMode;
use crate::api::trash::TrashListResponse;
use crate::wire::command::{
    Command, CommandErrorKind, EchoResult, GitRevisionStatResult, LsDirectoryResult, LsFileResult,
    MoveMetadataResult, MoveSourceIdentity,
};
use crate::wire::exec::{ExecEvent, ExecRequest};
use crate::wire::log::Level;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// A command together with the type of its successful response.
pub trait AgentRequest: Into<Command> {
    /// What the agent returns in `result.ok` when the request succeeds.
    type Response: Serialize + DeserializeOwned + Send + 'static;

    /// Encodes the agent's outcome for the wire. A response that cannot be serialized is
    /// reported as an internal error rather than as a malformed success.
    fn encode(result: Result<Self::Response, CommandError>) -> CommandOutcome {
        match result {
            Ok(response) => match serde_json::to_value(response) {
                Ok(value) => CommandOutcome::Ok(value),
                Err(error) => CommandOutcome::Error(CommandError::new(
                    CommandErrorKind::Internal,
                    format!("Failed to encode the response: {error}"),
                )),
            },
            Err(error) => CommandOutcome::Error(error),
        }
    }

    /// Decodes the outcome of this request; a success payload that is not this request's
    /// response type is a protocol violation.
    fn decode(outcome: CommandOutcome) -> Result<Self::Response, DecodeError> {
        match outcome {
            CommandOutcome::Ok(value) => serde_json::from_value(value)
                .map_err(|error| DecodeError::Malformed(error.to_string())),
            CommandOutcome::Error(error) => Err(DecodeError::Failed(error)),
        }
    }
}

/// Why a request's outcome did not yield its response.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// The agent reported a failure.
    #[error("{}", .0.message)]
    Failed(CommandError),
    /// The agent's success payload is not the request's response type.
    #[error("malformed response: {0}")]
    Malformed(String),
}

/// A failed command: a stable kind for status mapping plus a human-readable message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandError {
    pub kind: CommandErrorKind,
    pub message: String,
}

impl CommandError {
    /// Builds one failure whose kind the caller already knows.
    pub fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Builds one failure from an I/O error, keeping its kind for status mapping.
    pub fn io(context: &str, error: std::io::Error) -> Self {
        Self::new(
            CommandErrorKind::from_io_error(&error),
            format!("{context}: {error}"),
        )
    }
}

/// The body of a `result` frame: the request's response, or its failure.
///
/// Flattened into the frame, so it reads `{"type":"result","id":7,"ok":{...}}` or
/// `{"type":"result","id":7,"error":{"kind":"...","message":"..."}}`. The success payload stays
/// untyped until the receiver, which knows the request, decodes it with
/// [`AgentRequest::decode`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CommandOutcome {
    Ok(serde_json::Value),
    Error(CommandError),
}

impl CommandOutcome {
    /// Builds a failed outcome.
    pub fn error(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self::Error(CommandError::new(kind, message))
    }

    /// The failure, if the request failed.
    pub fn failure(&self) -> Option<&CommandError> {
        match self {
            Self::Ok(_) => None,
            Self::Error(error) => Some(error),
        }
    }

    /// Short operator-facing outcome; responses are not logged because they can be large or
    /// sensitive.
    pub fn summary(&self) -> String {
        match self {
            Self::Ok(_) => "ok".to_string(),
            Self::Error(CommandError { kind, message }) => {
                format!("error kind={kind:?} message={message}")
            }
        }
    }
}

/// What `Ls` found at a path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LsResponse {
    Directory(LsDirectoryResult),
    File(LsFileResult),
}

/// Result of a local move.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalMoveResponse {
    /// Whether a filesystem rename published the destination, so copy speeds stay hidden.
    pub atomic: bool,
}

/// Result of emptying the trash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmptyTrashResponse {
    pub deleted_items: u64,
}

/// Result of restoring one trash item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreTrashResponse {
    /// Where the item was restored to.
    pub path: String,
}

/// Runs a process without a PTY and streams its output events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exec {
    pub request: ExecRequest,
}

/// Lists a directory or describes a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ls {
    pub path: Option<String>,
}

/// Searches path names below a root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSearch {
    pub path: String,
    pub query: String,
    /// Keeps the deadline agent-local so traversal stops even if the REST caller disconnects.
    pub timeout_seconds: u64,
    /// Hidden directories are opt-in because they often contain large caches and metadata trees.
    pub include_hidden: bool,
    /// Git ignore rules are usually on so searches match repository expectations.
    pub respect_gitignore: bool,
    /// Smart case keeps lowercase searches forgiving while uppercase remains intentional.
    pub case_sensitivity: CaseSensitivity,
    /// Filtering during traversal keeps the result limit for directories. Defaults to false so
    /// a server of this release can still talk to an agent of the previous one.
    #[serde(default)]
    pub directories_only: bool,
}

/// Searches physical file lines without making the server read remote content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentGrep {
    pub path: String,
    pub query: String,
    /// Keeps the whole operation, including exclusive-slot waiting, agent-local and bounded.
    pub timeout_seconds: u64,
    /// Hidden directories are opt-in to avoid unexpectedly scanning cache trees.
    pub include_hidden: bool,
    /// Repository ignore rules are usually on to match recursive filename search.
    pub respect_gitignore: bool,
    /// Literal matching is opt-in so existing callers keep regex semantics.
    pub fixed_string: bool,
    /// Smart case keeps lowercase searches forgiving while uppercase remains intentional.
    pub case_sensitivity: CaseSensitivity,
    /// Preceding physical lines are opt-in and bounded to keep each match response small.
    pub before_context: u64,
    /// Following physical lines are opt-in and bounded to keep each match response small.
    pub after_context: u64,
}

/// Streams one file, or a byte range of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawDownload {
    pub path: String,
    pub range_start: Option<u64>,
    pub range_end: Option<u64>,
    /// Ranged resume must read the same source admitted by the server.
    #[serde(default)]
    pub expected_identity: Option<MoveSourceIdentity>,
}

/// Streams a directory as a tar archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TarDownload {
    pub path: String,
    /// Includes the source directory itself for archives intended for user extraction.
    pub include_root: bool,
}

/// Receives one file and publishes it at `path`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawUpload {
    pub path: String,
    /// Controls replacement when the destination already exists.
    pub on_existing: CopyExistingMode,
    /// Applies only to the uploaded destination entry, not its parent directories.
    pub ownership: CreationOwnershipOptions,
    /// Present only for agent-to-agent file copies, which stage into a resumable partial.
    #[serde(default)]
    pub partial: Option<Box<crate::wire::partials::PartialTransfer>>,
    /// Makes a newly created file executable, for sources that record the bit apart from the
    /// filesystem, like Git history. A replaced file keeps its own permissions either way.
    #[serde(default)]
    pub executable: bool,
}

/// Rewrites one existing regular-file inode after staging the complete body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditFile {
    pub path: String,
}

/// Receives a tar archive and extracts it as the directory `path`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TarUpload {
    pub path: String,
    /// Controls replacement when the destination already exists.
    pub on_existing: CopyExistingMode,
}

/// Copies one file within the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCopyFile {
    pub source_path: String,
    pub dest_path: String,
    /// Controls replacement when the destination already exists.
    pub on_existing: CopyExistingMode,
    /// Present for file copies, which stage into a resumable partial.
    #[serde(default)]
    pub partial: Option<Box<crate::wire::partials::PartialTransfer>>,
}

/// Copies one directory tree within the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCopyDirectory {
    pub source_path: String,
    pub dest_path: String,
    /// Controls replacement when the destination already exists.
    pub on_existing: CopyExistingMode,
}

/// Moves one file or directory locally, preferring an atomic filesystem rename.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalMove {
    pub source_path: String,
    pub dest_path: String,
    pub source_is_directory: bool,
    /// Prevents either rename or fallback cleanup from acting on a replacement source.
    pub expected_identity: MoveSourceIdentity,
    /// Controls replacement when the destination path already exists.
    pub on_existing: CopyExistingMode,
    /// Present for file copies, which stage into a resumable partial.
    #[serde(default)]
    pub partial: Option<Box<crate::wire::partials::PartialTransfer>>,
}

/// Deletes a path permanently, recursively for directories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawDelete {
    pub path: String,
}

/// Moves one filesystem entry into the platform trash without copy/delete fallback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trash {
    pub path: String,
}

/// Returns the platform-neutral inventory discovered by the agent at command time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListTrash {}

/// Permanently removes every payload and metadata entry from discovered trash locations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmptyTrash {}

/// Restores one opaque inventory item to an explicit user-selected destination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreTrash {
    pub location_id: String,
    pub item_id: String,
    pub destination_path: String,
}

/// Creates a directory and its missing parents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDirectory {
    pub path: String,
    /// Applies only to the requested directory after recursive parent creation.
    pub ownership: CreationOwnershipOptions,
}

/// Renames one entry within a directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenamePath {
    pub dir: String,
    pub old: String,
    pub new: String,
}

/// Changes owner and/or group of an existing path, following the same inode `ls` displays.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChownPath {
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// Replaces the ordinary rwx bits of an existing path without clearing setuid/setgid/sticky.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChmodPath {
    pub path: String,
    pub permissions: u32,
}

/// Enumerates host user and group names for root-only ownership editors.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListAccounts {}

/// Reads the metadata the file browser shows for one path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metadata {
    pub path: String,
}

/// Calculates recursive regular-file bytes without delaying directory navigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectorySize {
    pub path: String,
    /// Keeps expensive walks bounded on the agent even if the REST request disconnects.
    pub timeout_seconds: u64,
}

/// Discovers repository membership and classification for one browser path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitContext {
    pub path: String,
}

/// Lists bounded repository changes below one browser directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub path: String,
}

/// Reads the Git state of each direct child of one browser directory for the file list's
/// status column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDirectoryEntries {
    pub path: String,
}

/// Compares ordered files with HEAD using the selected Git source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiff {
    pub files: Vec<String>,
    pub mode: GitDiffMode,
}

/// Describes one path as it was committed at a revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRevisionTree {
    pub path: String,
    pub rev: String,
}

/// Reads one committed text file for the read-only editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRevisionContent {
    pub path: String,
    pub rev: String,
}

/// Diffs the commit a revision names against its first parent, or a range `A..B` against its
/// start, below one path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitDiff {
    pub path: String,
    pub rev: String,
}

/// Describes what a path is at a revision and the commit the revision resolved to, so a copy
/// or download from history can pick its transport and then read exactly that commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRevisionStat {
    pub path: String,
    pub rev: String,
    /// A destination on this agent that a copy of the revision would replace. Only the agent
    /// can resolve symlinks and `..` in it, which a lexical check on the server would miss.
    #[serde(default)]
    pub replace_target: Option<String>,
}

/// Streams a file's committed content, or a committed directory as a tar archive, so history
/// can be downloaded and copied without loading whole objects into memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDownload {
    pub path: String,
    /// Normally the commit id [`GitRevisionStat`] resolved, so a moving branch cannot change
    /// what is streamed between the inspection and the transfer.
    pub rev: String,
    /// Includes the directory itself for archives intended for user extraction, like
    /// [`TarDownload`].
    pub include_root: bool,
}

/// Finds the commits before and after the one a revision names in the path's history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitNeighbors {
    pub path: String,
    pub rev: String,
}

/// Lists one page of the commits that changed a path, starting at a revision or HEAD.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLog {
    pub path: String,
    pub rev: Option<String>,
    pub page: GitPage,
}

/// Lists one page of the branches or tags of the repository containing a path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRefList {
    pub path: String,
    pub kind: GitRefListKind,
    /// Defaults to the recent order so a server older than the option still gets a listing.
    #[serde(default)]
    pub sort: GitRefSort,
    /// Which branches a branch listing reads; tag listings ignore it. Defaults to both so a
    /// server older than the option still gets every branch.
    #[serde(default)]
    pub scope: GitBranchScope,
    pub page: GitPage,
}

/// Lists the main and linked worktrees of the repository containing a path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitWorktreeList {
    pub path: String,
}

/// Counts the uncommitted changes of the checkouts containing the paths, as many as fit the
/// agent's time budget.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitWorktreeStatus {
    pub paths: Vec<String>,
}

/// Reads the stable filesystem identity needed to delete only the source that was copied.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveMetadata {
    pub path: String,
}

/// Removes a move source only while it still has the identity captured before copying.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteMoveSource {
    pub path: String,
    pub expected_identity: MoveSourceIdentity,
}

/// Opens a path with the agent host's desktop handler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenPath {
    pub path: String,
}

/// Echoes a message back, to verify the command round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Echo {
    pub request: EchoRequest,
}

/// Reads the agent's runtime details.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GetAgentDetails {}

/// Reads the process-wide threshold from the agent that owns this connection.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GetLoggingLevel {}

/// Changes logging admission for subsequent events in the connected agent process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetLoggingLevel {
    pub level: Level,
}

/// Restarts the agent process.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Restart {}

/// Replaces the agent process with the binary at `path` (an upgrade).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelfExec {
    pub path: String,
}

/// Lists inactive durable outputs without scanning destination trees.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListPartials {}

/// Inspects one destination before offering resume to the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbePartial {
    pub dest_path: String,
}

/// Reads the manifest again so resume never trusts client-provided endpoints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadPartial {
    pub key: String,
}

/// Removes a still-owned partial by opaque key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletePartial {
    pub key: String,
}

/// Pause during verification still needs an explicit durable destination acknowledgement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistPartial {
    pub key: String,
    /// Verification precedes upload preparation, so pause must save the current operation policy.
    #[serde(default)]
    pub signed: Option<Box<crate::wire::partials::SignedPartial>>,
}

/// One bounded segment per reply allows comparison to stop at the first mismatch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashSegments {
    /// File to hash when `partial_key` is absent.
    pub path: String,
    pub start: u64,
    pub end: u64,
    /// Hashes the destination partial of this manifest instead of `path`.
    pub partial_key: Option<String>,
    /// Fails with `SourceChanged` when the opened source is no longer the admitted one.
    pub expected_identity: Option<MoveSourceIdentity>,
}

/// Ties each request struct to its [`Command`] variant and its response type.
macro_rules! agent_requests {
    ($($request:ident => $response:ty),* $(,)?) => {
        $(
            impl From<$request> for Command {
                /// Wraps the request in its command variant.
                fn from(request: $request) -> Self {
                    Command::$request(request)
                }
            }

            impl AgentRequest for $request {
                type Response = $response;
            }
        )*
    };
}

agent_requests! {
    ListPartials => Vec<crate::wire::partials::PartialRecord>,
    ProbePartial => Option<crate::wire::partials::PartialRecord>,
    ReadPartial => Option<crate::wire::partials::PartialRecord>,
    DeletePartial => (),
    PersistPartial => (),
    HashSegments => String,
    Exec => ExecEvent,
    Ls => LsResponse,
    FileSearch => FileSearchResponse,
    ContentGrep => ContentGrepResponse,
    RawDownload => (),
    TarDownload => (),
    RawUpload => (),
    EditFile => (),
    TarUpload => (),
    LocalCopyFile => (),
    LocalCopyDirectory => (),
    LocalMove => LocalMoveResponse,
    RawDelete => (),
    Trash => (),
    ListTrash => TrashListResponse,
    EmptyTrash => EmptyTrashResponse,
    RestoreTrash => RestoreTrashResponse,
    CreateDirectory => (),
    RenamePath => (),
    ChownPath => ChownPathResponse,
    ChmodPath => ChmodPathResponse,
    ListAccounts => AgentAccountsResponse,
    Metadata => MetadataResponse,
    DirectorySize => DirectorySizeResponse,
    GitContext => GitContextResponse,
    GitStatus => GitStatusResponse,
    GitDirectoryEntries => GitDirectoryEntriesResponse,
    GitDiff => GitDiffResponse,
    GitRevisionTree => GitRevisionTreeResponse,
    GitRevisionContent => GitRevisionContentResponse,
    GitCommitDiff => GitCommitDiffResponse,
    GitLog => GitLogResponse,
    GitCommitNeighbors => GitCommitNeighborsResponse,
    GitRefList => GitRefListResponse,
    GitWorktreeList => GitWorktreeListResponse,
    GitWorktreeStatus => GitWorktreeStatusResponse,
    GitRevisionStat => GitRevisionStatResult,
    GitDownload => (),
    MoveMetadata => MoveMetadataResult,
    DeleteMoveSource => (),
    OpenPath => (),
    Echo => EchoResult,
    GetAgentDetails => AgentDetailsResponse,
    GetLoggingLevel => Level,
    SetLoggingLevel => Level,
    Restart => (),
    SelfExec => (),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::RequestId;
    use crate::wire::AgentToServer;
    use serde_json::{Value, json};

    /// Sends `sample` as request `R`'s response through a real `result` frame and decodes it
    /// back as the receiver does, returning the decoded value re-serialized for comparison.
    fn through_result_frame<R: AgentRequest>(sample: Value) -> Value {
        let response: R::Response =
            serde_json::from_value(sample).expect("sample must be the request's response type");
        let frame = AgentToServer::Result {
            id: RequestId::new(1),
            outcome: R::encode(Ok(response)),
        };
        let text = serde_json::to_string(&frame).unwrap();
        let AgentToServer::Result { outcome, .. } = serde_json::from_str(&text).unwrap() else {
            panic!("a result frame decodes as a result frame");
        };
        serde_json::to_value(R::decode(outcome).expect("the response decodes")).unwrap()
    }

    /// Asserts that `sample` survives the result frame unchanged as request `R`'s response.
    fn assert_round_trip<R: AgentRequest>(sample: Value) {
        // The receiver must get exactly what the agent answered, whatever the response type.
        assert_eq!(
            through_result_frame::<R>(sample.clone()),
            sample,
            "{}",
            std::any::type_name::<R>()
        );
    }

    /// Every request type's response decodes from its `result` frame.
    #[test]
    fn every_response_type_round_trips() {
        let ls_entry_free_directory = json!({"kind": "directory", "files": [], "path": "/tmp",
            "owner": null, "group": null, "uid": 1, "gid": 1, "permissions": 493});
        assert_round_trip::<Ls>(ls_entry_free_directory);
        assert_round_trip::<Ls>(json!({"kind": "file", "size": 3, "path": "/tmp/a",
            "owner": "me", "group": "us", "uid": 1, "gid": 1, "permissions": 420}));
        assert_round_trip::<Exec>(json!({"type": "exit", "code": 0, "signal": null}));
        assert_round_trip::<FileSearch>(json!({"results": [], "timed_out": false,
            "duration_ms": 4}));
        assert_round_trip::<ContentGrep>(json!({"results": [],
            "timed_out": false, "cancelled": false, "truncated": false,
            "omitted_long_lines": 0, "duration_ms": 4}));
        for unit in [
            through_result_frame::<RawDownload>(Value::Null),
            through_result_frame::<TarDownload>(Value::Null),
            through_result_frame::<GitDownload>(Value::Null),
            through_result_frame::<RawUpload>(Value::Null),
            through_result_frame::<EditFile>(Value::Null),
            through_result_frame::<TarUpload>(Value::Null),
            through_result_frame::<LocalCopyFile>(Value::Null),
            through_result_frame::<LocalCopyDirectory>(Value::Null),
            through_result_frame::<RawDelete>(Value::Null),
            through_result_frame::<Trash>(Value::Null),
            through_result_frame::<CreateDirectory>(Value::Null),
            through_result_frame::<RenamePath>(Value::Null),
            through_result_frame::<DeleteMoveSource>(Value::Null),
            through_result_frame::<OpenPath>(Value::Null),
            through_result_frame::<Restart>(Value::Null),
            through_result_frame::<SelfExec>(Value::Null),
        ] {
            // Requests without a payload answer with `ok: null`.
            assert_eq!(unit, Value::Null);
        }
        assert_round_trip::<LocalMove>(json!({"atomic": true}));
        assert_round_trip::<GitRevisionStat>(json!({"commit_id": "abc",
            "kind": {"type": "file", "size": 3, "executable": true},
            "replaces_repository": false}));
        assert_round_trip::<GitRevisionStat>(json!({"commit_id": "abc",
            "kind": {"type": "directory"}, "replaces_repository": true}));
        assert_round_trip::<ListTrash>(json!({"locations": []}));
        assert_round_trip::<EmptyTrash>(json!({"deleted_items": 3}));
        assert_round_trip::<RestoreTrash>(json!({"path": "/tmp/restored"}));
        assert_round_trip::<ChownPath>(json!({"path": "/tmp/a", "owner": "me", "group": null,
            "uid": 1, "gid": 2}));
        assert_round_trip::<ChmodPath>(json!({"path": "/tmp/a", "permissions": 420}));
        assert_round_trip::<ListAccounts>(json!({"users": [], "groups": [],
            "truncated": false}));
        assert_round_trip::<Metadata>(json!({"path": "/tmp/a", "mime_type": "text/plain",
            "file_size": 3, "is_file": true, "is_dir": false, "editable": true,
            "viewable_image": false, "one_time_tokens": []}));
        assert_round_trip::<DirectorySize>(json!({"path": "/tmp", "size": 9, "errors": []}));
        assert_round_trip::<GitContext>(json!({"status": "outside_worktree"}));
        assert_round_trip::<GitStatus>(json!({"path": "/repo", "repository_root": "/repo",
            "branch_name": "main", "detached_head_id": null, "upstream": null, "ahead": null,
            "behind": null, "entries": [], "truncated": false,
            "omitted_non_utf8_entries": 0}));
        assert_round_trip::<GitDirectoryEntries>(json!({"status": "entries", "entries": [
            {"name": "a.txt", "state": {"type": "changed", "index_state": "renamed",
                "worktree_state": "modified", "conflicted": false,
                "original_path": "/repo/b.txt"}},
            {"name": "dir", "state": {"type": "contains_changes", "most_severe": "changed",
                "changed": 1, "untracked": 2, "conflicted": 0, "truncated": false}},
            {"name": "build", "state": {"type": "ignored"}}]}));
        assert_round_trip::<GitDirectoryEntries>(json!({"status": "timed_out"}));
        assert_round_trip::<GitDiff>(json!({"diffs": []}));
        let commit = json!({"id": "abc", "summary": "first", "author_name": "A",
            "author_email": "a@example.invalid", "authored_at": 1, "parent_ids": []});
        assert_round_trip::<GitRevisionTree>(json!({"rev": "main", "commit": commit,
            "repository_root": "/repo", "path": "/repo/a", "repository_relative_path": "a",
            "entry": {"type": "file", "size": 3, "executable": false, "editable": true,
            "blob_id": "def"}}));
        assert_round_trip::<GitRevisionContent>(json!({"path": "/repo/a", "commit_id": "abc",
            "content": "a\n"}));
        assert_round_trip::<GitCommitDiff>(json!({"commit": commit, "body": "", "parent_id": null,
            "range": {"base": null, "merge_base": true},
            "repository_root": "/repo", "repository_relative_path": "", "files": [],
            "truncated": false}));
        assert_round_trip::<GitLog>(json!({"repository_root": "/repo",
            "repository_relative_path": "a", "commits": [commit], "has_more": true}));
        assert_round_trip::<GitCommitNeighbors>(json!({"older": commit, "newer": null}));
        assert_round_trip::<GitRefList>(json!({"repository_root": "/repo", "refs": [{
            "name": "main", "full_name": "refs/heads/main", "kind": "branch", "is_head": true,
            "is_default": true, "commit": commit}], "total": 1, "has_more": false}));
        assert_round_trip::<GitWorktreeList>(json!({"repository_root": "/repo", "worktrees": [{
            "path": "/repo", "is_main": true, "is_current": true, "branch_name": "main",
            "head_commit": commit, "last_activity_at": 1, "locked": false, "missing": false}],
            "truncated": false}));
        assert_round_trip::<GitWorktreeStatus>(json!({"statuses": [
            {"path": "/repo", "result": {"type": "counted", "changed": 1, "untracked": 2,
                "truncated": false}},
            {"path": "/gone", "result": {"type": "failed", "message": "not a repository"}}]}));
        assert_round_trip::<MoveMetadata>(json!({"file_size": 3, "is_file": true,
            "is_dir": false, "identity": {"device": 1, "inode": 2, "size": 3,
            "modified_seconds": 4, "modified_nanoseconds": 5, "is_directory": false}}));
        assert_round_trip::<Echo>(json!({"message": "hello"}));
        assert_round_trip::<GetAgentDetails>(json!({"id": "agent", "name": "agent", "pid": 1,
            "cwd": "/", "config_path": "", "exe_path": "/bin/redoor", "load_average_one": 0.5,
            "load_average_five": 0.25, "load_average_fifteen": 0.125, "system_uptime": 9,
            "os": "linux", "arch": "x86_64", "hostname": "host", "external_ip": null,
            "username": "me", "connected_at": 0, "binary": {"version": "1", "git_rev": "abc",
            "git_dirty": false, "version_dirty": false, "build_mode": "debug",
            "build_date": "2026-10-10"}, "mount_points": [], "uid": 1000, "is_root": false}));
        assert_round_trip::<GetLoggingLevel>(json!("debug"));
        assert_round_trip::<SetLoggingLevel>(json!("info"));
    }

    /// A failure travels as `error` and decodes to the agent's kind and message.
    #[test]
    fn errors_decode_with_their_kind() {
        let outcome = Metadata::encode(Err(CommandError::new(
            CommandErrorKind::PermissionDenied,
            "denied",
        )));
        // REST maps the kind to a status, so it must survive the frame unchanged.
        assert_eq!(
            Metadata::decode(outcome).unwrap_err(),
            DecodeError::Failed(CommandError::new(
                CommandErrorKind::PermissionDenied,
                "denied"
            ))
        );
    }

    /// A success payload of the wrong type is reported as malformed, not misread.
    #[test]
    fn wrong_response_type_is_malformed() {
        let outcome = CommandOutcome::Ok(json!({"message": "an echo, not metadata"}));
        // The receiver knows which request it sent, so any other shape is a protocol fault.
        assert!(matches!(
            Metadata::decode(outcome),
            Err(DecodeError::Malformed(_))
        ));
    }

    /// Commands keep their wire JSON: the request structs are the variants' payloads.
    #[test]
    fn command_json_is_unchanged_by_request_structs() {
        let cases: [(Command, Value); 4] = [
            (ListTrash {}.into(), json!({"type": "ListTrash"})),
            (
                Ls {
                    path: Some("/tmp".to_string()),
                }
                .into(),
                json!({"type": "Ls", "path": "/tmp"}),
            ),
            (
                Echo {
                    request: EchoRequest {
                        message: "m".to_string(),
                        random_sleep: false,
                    },
                }
                .into(),
                json!({"type": "Echo", "request": {"message": "m", "random_sleep": false}}),
            ),
            (
                SetLoggingLevel { level: Level::Info }.into(),
                json!({"type": "SetLoggingLevel", "level": "info"}),
            ),
        ];
        for (command, expected) in cases {
            // Each command still serializes as `{"type": <variant>, ...fields}`.
            assert_eq!(serde_json::to_value(&command).unwrap(), expected);
            // And decodes back to the same command.
            let decoded: Command = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
        }
    }
}
