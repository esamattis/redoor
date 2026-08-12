mod file_search;
mod handler;
mod identity;
mod metadata;

use crate::types::{AgentId, SocketId, TransferId, UnixTimestampSeconds};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use handler::CommandHandler;
pub use identity::{
    BinaryIdentity, ServerBuildMode, agent_loaded_config_path, current_binary_identity,
    current_exe_path, external_ip, set_agent_loaded_config_path,
};

/// Carries credentials to the login endpoint without putting secrets in the URL.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Confirms which configured account now owns the browser session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginResponse {
    pub username: String,
}

/// Confirms that both the browser cookie and its server-side session were removed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogoutResponse {
    pub logged_out: bool,
}

/// How browser login credentials are sourced for this server process.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ServerAuthMode {
    /// Username and password come from the server TOML config.
    Toml,
    /// Username/password are verified against the process owner's Linux PAM account.
    Pam,
}

/// Server identity and authenticated agent bootstrap settings shown on the UI home page.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerInfoResponse {
    /// Filesystem and service namespace selected by `REDOOR_APP_NAME`.
    pub app_name: String,
    /// Shared registration secret included so the authenticated UI can render a working agent config.
    pub agent_token: String,
    /// Absolute path of the TOML config file this process loaded.
    pub config_path: String,
    /// Absolute path of the running server binary.
    pub exe_path: String,
    /// Whether login uses TOML credentials or system PAM.
    pub auth_mode: ServerAuthMode,
    /// Primary non-loopback IP selected from the server's local routing table.
    pub external_ip: Option<String>,
    /// Operating system of the running server executable.
    pub os: String,
    /// CPU architecture of the running server executable.
    pub arch: String,
    /// `CARGO_PKG_VERSION` baked into this binary.
    pub version: String,
    /// Full git commit SHA (or `unknown` when git metadata was unavailable at build).
    pub git_rev: String,
    /// True when the working tree had uncommitted changes at build time.
    pub git_dirty: bool,
    /// True when HEAD was not tagged `v{version}` at build time.
    pub version_dirty: bool,
    /// Whether this binary was compiled as debug or release.
    pub build_mode: ServerBuildMode,
    /// UTC compile timestamp (`YYYY-MM-DDTHH:MM:SSZ`) or `unknown`.
    pub build_date: String,
}

/// Confirms a server or agent accepted a restart request before its connection closes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RestartResponse {
    pub restarting: bool,
}

/// Selects which server-side executable should replace a connected agent.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "source", rename_all = "snake_case")]
#[ts(tag = "source", rename_all = "snake_case")]
pub enum UpgradeAgentRequest {
    /// Downloads or reuses a published release for the agent platform.
    PublishedRelease { target_version: String },
    /// Force-installs the exact executable currently running the server.
    RunningServer,
}

/// Confirms the agent acknowledged execution of the newly installed target version.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpgradeAgentResponse {
    pub upgrading: bool,
    pub target_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ls {
        path: Option<String>,
    },
    FileSearch {
        path: String,
        query: String,
    },
    Cat {
        path: String,
    },
    RawDownload {
        path: String,
        range_start: Option<u64>,
        range_end: Option<u64>,
    },
    TarDownload {
        path: String,
        /// Includes the source directory itself for archives intended for user extraction.
        #[serde(default)]
        include_root: bool,
    },
    RawUpload {
        path: String,
        /// Controls replacement when the destination already exists.
        /// Defaults to override so direct HTTP raw uploads keep replacing files.
        #[serde(default = "CopyExistingMode::override_mode")]
        on_existing: CopyExistingMode,
    },
    TarUpload {
        path: String,
        /// Controls replacement when the destination already exists.
        /// Defaults to error so directory placement stays non-destructive unless copy asks otherwise.
        #[serde(default)]
        on_existing: CopyExistingMode,
    },
    LocalCopyFile {
        source_path: String,
        dest_path: String,
        /// Controls replacement when the destination already exists.
        #[serde(default)]
        on_existing: CopyExistingMode,
    },
    LocalCopyDirectory {
        source_path: String,
        dest_path: String,
        /// Controls replacement when the destination already exists.
        #[serde(default)]
        on_existing: CopyExistingMode,
    },
    RawDelete {
        path: String,
    },
    CreateDirectory {
        path: String,
    },
    RenamePath {
        source_path: String,
        dest_path: String,
    },
    Metadata {
        path: String,
    },
    OpenPath {
        path: String,
    },
    Echo {
        request: EchoRequest,
    },
    AgentInfo,
    GetAgentDetails,
    Restart,
    SelfExec {
        path: String,
    },
}

impl Command {
    /// Short operator-facing label without large or sensitive payloads.
    pub fn summary(&self) -> String {
        match self {
            Self::Ls { path } => match path {
                Some(path) => format!("Ls path={path}"),
                None => "Ls path=.".to_string(),
            },
            Self::FileSearch { path, query } => {
                format!("FileSearch path={path} query={query}")
            }
            Self::Cat { path } => format!("Cat path={path}"),
            Self::RawDownload {
                path,
                range_start,
                range_end,
            } => match (range_start, range_end) {
                (Some(start), Some(end)) => {
                    format!("RawDownload path={path} range={start}-{end}")
                }
                (Some(start), None) => format!("RawDownload path={path} range_start={start}"),
                (None, Some(end)) => format!("RawDownload path={path} range_end={end}"),
                (None, None) => format!("RawDownload path={path}"),
            },
            Self::TarDownload { path, include_root } => {
                format!("TarDownload path={path} include_root={include_root}")
            }
            Self::RawUpload { path, on_existing } => {
                format!("RawUpload path={path} on_existing={on_existing:?}")
            }
            Self::TarUpload { path, on_existing } => {
                format!("TarUpload path={path} on_existing={on_existing:?}")
            }
            Self::LocalCopyFile {
                source_path,
                dest_path,
                on_existing,
            } => format!(
                "LocalCopyFile source={source_path} dest={dest_path} on_existing={on_existing:?}"
            ),
            Self::LocalCopyDirectory {
                source_path,
                dest_path,
                on_existing,
            } => format!(
                "LocalCopyDirectory source={source_path} dest={dest_path} on_existing={on_existing:?}"
            ),
            Self::RawDelete { path } => format!("RawDelete path={path}"),
            Self::CreateDirectory { path } => format!("CreateDirectory path={path}"),
            Self::RenamePath {
                source_path,
                dest_path,
            } => format!("RenamePath source={source_path} dest={dest_path}"),
            Self::Metadata { path } => format!("Metadata path={path}"),
            Self::OpenPath { path } => format!("OpenPath path={path}"),
            // Echo bodies can be large or sensitive, so only the command name is logged.
            Self::Echo { .. } => "Echo".to_string(),
            Self::AgentInfo => "AgentInfo".to_string(),
            Self::GetAgentDetails => "GetAgentDetails".to_string(),
            Self::Restart => "Restart".to_string(),
            Self::SelfExec { path } => format!("SelfExec path={path}"),
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

/// Describes one matching remote path without requiring additional metadata calls.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileSearchEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String,
}

/// Returns the best paths discovered before traversal completed or reached its deadline.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileSearchResponse {
    pub results: Vec<FileSearchEntry>,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatResult {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MetadataResponse {
    pub path: String,
    pub mime_type: String,
    #[ts(type = "number")]
    pub file_size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    /// True only when the agent verified the whole file is UTF-8 and small enough to edit safely.
    pub editable: bool,
    /// True only when the agent verified content magic bytes and size allow in-browser image viewing.
    pub viewable_image: bool,
    /// Outstanding process-local download tokens for this exact agent and path.
    pub one_time_tokens: Vec<String>,
}

/// Returns the opaque single-use credential without exposing registry internals.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateOneTimeTokenResponse {
    /// UUID accepted once by the matching agent raw-download path.
    pub one_time_token: String,
}

/// Identifies one agent-side file participating in a server-generated diff.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DiffEndpoint {
    pub agent: AgentId,
    pub path: String,
}

/// Selects two ordered files without requiring them to share an agent or path.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DiffFilesRequest {
    pub left: DiffEndpoint,
    pub right: DiffEndpoint,
}

/// Returns text in the conventional unified diff representation used by patch tools.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DiffFilesResponse {
    pub unified_diff: String,
}

/// Confirms that the agent's graphical desktop accepted a path-open request.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenPathResponse {
    /// The absolute path passed to the platform's native launcher.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EchoResult {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfoResult {
    pub pid: u32,
    pub cwd: String,
    pub load_average: (f64, f64, f64),
    pub system_uptime: u64,
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
    InvalidInput,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CommandResult {
    LsDirectory(LsDirectoryResult),
    LsFile(LsFileResult),
    FileSearch(FileSearchResponse),
    Cat(CatResult),
    RawDownload {
        path: String,
    },
    TarDownload {
        path: String,
    },
    RawUpload,
    TarUpload,
    LocalCopyFile,
    LocalCopyDirectory,
    RawDelete,
    CreateDirectory,
    RenamePath,
    Metadata(MetadataResponse),
    OpenPath,
    Echo(EchoResult),
    AgentInfo(AgentInfoResult),
    GetAgentDetails(Box<AgentDetailsResponse>),
    Restart,
    SelfExec {
        path: String,
    },
    Error {
        kind: CommandErrorKind,
        message: String,
    },
}

/// Returns the complete in-process inventory rather than only live sockets.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentListResponse {
    pub agents: Vec<AgentInfoResponse>,
}

/// Identifies the user-visible connection lifecycle independently from ownership.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionStatus {
    Stopped,
    Starting,
    Connected,
    Disconnected,
}

/// Summarizes one known agent without requiring a current WebSocket connection.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentInfoResponse {
    pub id: AgentId,
    pub name: String,
    pub cwd: Option<String>,
    pub managed: bool,
    pub status: AgentConnectionStatus,
    pub connected_at: Option<UnixTimestampSeconds>,
    /// Current WebSocket generation; changes whenever this agent reconnects.
    pub connection_id: Option<SocketId>,
    pub last_seen_at: Option<UnixTimestampSeconds>,
    pub connection_issue: Option<String>,
    /// Binary identity from the latest registration; absent until first connect.
    pub binary: Option<BinaryIdentity>,
    /// Whether the latest agent session can safely complete an in-place upgrade.
    pub supports_self_exec: bool,
    /// Whether the latest agent session can launch paths in a graphical desktop.
    pub supports_native_open: bool,
}

/// Confirms that a managed supervisor accepted an idempotent start request.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Confirms that intentional shutdown completed child cleanup.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ShutdownAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Describes one directory entry completely enough to render and sort a file list.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String,
    #[ts(type = "number")]
    pub size: u64,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub modified_at: UnixTimestampSeconds,
}

/// Exposes directory entries and metadata so clients can provide alternate directory views.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsDirectoryResponse {
    pub files: Vec<LsEntry>,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub permissions: u32,
}

/// Exposes remote file metadata needed by clients to present a useful detail view.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsFileResponse {
    #[ts(type = "number")]
    pub size: u64,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub permissions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CatResponse {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EchoRequest {
    pub message: String,
    #[serde(default)]
    pub random_sleep: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EchoResponse {
    pub message: String,
}

/// Connected-agent detail view including the same binary identity as the server home.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentDetailsResponse {
    pub id: AgentId,
    pub name: String,
    pub pid: u32,
    pub cwd: String,
    /// Absolute path of the TOML config file this agent loaded, or empty when none.
    pub config_path: String,
    /// Absolute path of the running agent binary.
    pub exe_path: String,
    pub load_average_one: f64,
    pub load_average_five: f64,
    pub load_average_fifteen: f64,
    #[ts(type = "number")]
    pub system_uptime: u64,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    /// Primary non-loopback IP selected from the agent's local routing table.
    pub external_ip: Option<String>,
    pub username: String,
    pub connected_at: UnixTimestampSeconds,
    /// Compile-time identity of the agent binary currently serving this connection.
    pub binary: BinaryIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RawUploadResponse {
    pub path: String,
    #[ts(type = "number")]
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RawDeleteResponse {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateDirectoryResponse {
    pub path: String,
}

/// Carries both absolute paths needed for one agent-side filesystem rename.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenamePathRequest {
    pub source_path: String,
    pub dest_path: String,
}

/// Confirms the source path was atomically moved to the requested destination.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenamePathResponse {
    pub source_path: String,
    pub dest_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CopyEndpoint {
    pub agent: AgentId,
    pub path: String,
}

/// Controls what copy does when the destination path already exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum CopyExistingMode {
    /// Fail the copy and leave the destination untouched.
    #[default]
    Error,
    /// Replace the destination path entirely with the source contents.
    Override,
    /// Merge source contents into the destination tree; conflicting files are replaced.
    Merge,
}

impl CopyExistingMode {
    /// Default used by direct raw uploads so existing HTTP clients keep overwriting files.
    pub const fn override_mode() -> Self {
        Self::Override
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CopyFileRequest {
    pub source: CopyEndpoint,
    pub dest: CopyEndpoint,
    /// What to do when `dest.path` already exists. Omitted requests keep the historical error behavior.
    #[serde(default)]
    pub on_existing: CopyExistingMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CopyFileResponse {
    pub copy_request_id: TransferId,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferProgressListResponse {
    pub transfers: Vec<TransferProgressEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferProgressUpdate {
    pub agent_id: AgentId,
    pub request_id: TransferId,
    #[ts(type = "number")]
    pub transferred_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
    Refresh,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferProgressEntry {
    pub request_id: TransferId,
    pub agent_id: AgentId,
    pub path: String,
    pub source: Option<CopyEndpoint>,
    pub dest: Option<CopyEndpoint>,
    pub direction: TransferDirection,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub transferred_bytes: u64,
    pub started_at: UnixTimestampSeconds,
    pub ended_at: Option<UnixTimestampSeconds>,
    pub state: TransferProgressState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
    Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TransferProgressState {
    Active,
    Errored,
    Completed,
}

impl CommandResult {
    /// Short operator-facing outcome without dumping large command payloads.
    pub fn summary(&self) -> String {
        match self {
            Self::LsDirectory(_) => "ok LsDirectory".to_string(),
            Self::LsFile(_) => "ok LsFile".to_string(),
            Self::FileSearch(result) => format!(
                "ok FileSearch results={} timed_out={}",
                result.results.len(),
                result.timed_out
            ),
            Self::Cat(_) => "ok Cat".to_string(),
            Self::RawDownload { path } => format!("ok RawDownload path={path}"),
            Self::TarDownload { path } => format!("ok TarDownload path={path}"),
            Self::RawUpload => "ok RawUpload".to_string(),
            Self::TarUpload => "ok TarUpload".to_string(),
            Self::LocalCopyFile => "ok LocalCopyFile".to_string(),
            Self::LocalCopyDirectory => "ok LocalCopyDirectory".to_string(),
            Self::RawDelete => "ok RawDelete".to_string(),
            Self::CreateDirectory => "ok CreateDirectory".to_string(),
            Self::RenamePath => "ok RenamePath".to_string(),
            Self::Metadata(_) => "ok Metadata".to_string(),
            Self::OpenPath => "ok OpenPath".to_string(),
            Self::Echo(_) => "ok Echo".to_string(),
            Self::AgentInfo(_) => "ok AgentInfo".to_string(),
            Self::GetAgentDetails(_) => "ok GetAgentDetails".to_string(),
            Self::Restart => "ok Restart".to_string(),
            Self::SelfExec { path } => format!("ok SelfExec path={path}"),
            Self::Error { kind, message } => {
                format!("error kind={kind:?} message={message}")
            }
        }
    }

    /// Builds one structured command failure when the caller already knows the error kind.
    pub fn error(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self::Error {
            kind,
            message: message.into(),
        }
    }

    /// Builds one structured command failure from an I/O error.
    pub fn io_error(context: &str, error: std::io::Error) -> Self {
        let kind = CommandErrorKind::from_io_error(&error);
        Self::Error {
            kind,
            message: format!("{}: {}", context, error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_ls_command() {
        let handler = CommandHandler::new();
        let result = handler.execute(Command::Ls { path: None }).await;

        match result {
            CommandResult::LsDirectory(ls_result) => {
                assert!(!ls_result.files.is_empty(), "ls should return files");
                assert!(
                    !ls_result.path.is_empty(),
                    "directory path should be populated"
                );
                assert!(
                    ls_result.permissions > 0,
                    "directory permissions should be populated"
                );
                let first_file = &ls_result.files[0];
                assert!(
                    first_file.file_type == "file" || first_file.file_type == "directory",
                    "file_type should be 'file' or 'directory'"
                );
                assert!(first_file.uid > 0, "uid should be populated");
                assert!(first_file.gid > 0, "gid should be populated");
                assert!(!first_file.name.is_empty(), "name should not be empty");
            }
            _ => panic!("Expected LsDirectoryResult"),
        }
    }

    #[tokio::test]
    async fn test_ls_error_includes_requested_path() {
        let handler = CommandHandler::new();
        let path = "nonexistent-directory-for-ls-context";
        let result = handler
            .execute(Command::Ls {
                path: Some(path.to_string()),
            })
            .await;

        match result {
            CommandResult::Error { kind, message } => {
                // The stable kind lets the REST layer return a useful status without parsing text.
                assert_eq!(kind, CommandErrorKind::NotFound);
                // Naming the attempted path makes remote filesystem failures actionable.
                assert!(message.contains(path), "ls error should include its path");
            }
            _ => panic!("Expected Error"),
        }
    }

    #[tokio::test]
    async fn test_cat_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Cat {
                path: "Cargo.toml".to_string(),
            })
            .await;

        match result {
            CommandResult::Cat(cat_result) => {
                assert!(cat_result.content.contains("[package]"));
            }
            _ => panic!("Expected CatResult"),
        }
    }

    #[tokio::test]
    async fn test_cat_nonexistent_file() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Cat {
                path: "nonexistent_file.txt".to_string(),
            })
            .await;

        match result {
            CommandResult::Error { kind, message } => {
                // The typed kind keeps missing-file failures stable across OS error text changes.
                assert_eq!(kind, CommandErrorKind::NotFound);
                assert!(message.contains("Failed to read file"));
            }
            _ => panic!("Expected Error"),
        }
    }

    #[tokio::test]
    async fn test_raw_download_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::RawDownload {
                path: "test.txt".to_string(),
                range_start: None,
                range_end: None,
            })
            .await;

        match result {
            CommandResult::RawDownload { path } => {
                assert_eq!(path, "test.txt");
            }
            _ => panic!("Expected RawDownload"),
        }
    }

    #[tokio::test]
    async fn test_tar_download_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::TarDownload {
                path: "test-dir".to_string(),
                include_root: false,
            })
            .await;

        match result {
            CommandResult::TarDownload { path } => {
                assert_eq!(path, "test-dir");
            }
            _ => panic!("Expected TarDownload"),
        }
    }

    #[test]
    fn test_tar_download_defaults_to_excluding_root() {
        let command: Command = serde_json::from_str(r#"{"type":"TarDownload","path":"test-dir"}"#)
            .expect("legacy tar download command should deserialize");

        match command {
            Command::TarDownload { include_root, .. } => {
                // Missing fields from older servers must retain the flat archive used by copies.
                assert!(!include_root);
            }
            _ => panic!("Expected TarDownload"),
        }
    }

    #[tokio::test]
    async fn test_tar_upload_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::TarUpload {
                path: "test-dir".to_string(),
                on_existing: CopyExistingMode::Error,
            })
            .await;

        match result {
            CommandResult::TarUpload => {}
            _ => panic!("Expected TarUpload"),
        }
    }

    #[tokio::test]
    async fn test_raw_upload_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::RawUpload {
                path: "upload.txt".to_string(),
                on_existing: CopyExistingMode::Override,
            })
            .await;

        match result {
            CommandResult::RawUpload => {}
            _ => panic!("Expected RawUpload"),
        }
    }

    #[tokio::test]
    async fn test_raw_delete_command() {
        let handler = CommandHandler::new();
        let temp_path = std::env::temp_dir().join(format!(
            "redoor-delete-test-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after Unix epoch")
                .as_nanos()
        ));

        tokio::fs::write(&temp_path, "delete me")
            .await
            .expect("temporary file should be created");

        let result = handler
            .execute(Command::RawDelete {
                path: temp_path.to_string_lossy().to_string(),
            })
            .await;

        match result {
            CommandResult::RawDelete => {
                assert!(
                    !tokio::fs::try_exists(&temp_path)
                        .await
                        .expect("file existence should be queryable"),
                    "file should be removed"
                );
            }
            _ => panic!("Expected RawDelete"),
        }
    }

    #[tokio::test]
    async fn test_raw_delete_command_removes_directory_recursively() {
        let handler = CommandHandler::new();
        let temp_dir = std::env::temp_dir().join(format!(
            "redoor-delete-dir-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after Unix epoch")
                .as_nanos()
        ));
        let nested_dir = temp_dir.join("nested");
        let nested_file = nested_dir.join("file.txt");

        tokio::fs::create_dir_all(&nested_dir)
            .await
            .expect("temporary directory should be created");
        tokio::fs::write(&nested_file, "delete me")
            .await
            .expect("temporary nested file should be created");

        let result = handler
            .execute(Command::RawDelete {
                path: temp_dir.to_string_lossy().to_string(),
            })
            .await;

        match result {
            CommandResult::RawDelete => {
                assert!(
                    !tokio::fs::try_exists(&temp_dir)
                        .await
                        .expect("directory existence should be queryable"),
                    "directory should be removed recursively"
                );
            }
            _ => panic!("Expected RawDelete"),
        }
    }

    #[tokio::test]
    async fn test_echo_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Echo {
                request: EchoRequest {
                    message: "hello world".to_string(),
                    random_sleep: false,
                },
            })
            .await;

        match result {
            CommandResult::Echo(echo_result) => {
                assert_eq!(echo_result.message, "hello world");
            }
            _ => panic!("Expected EchoResult"),
        }
    }

    #[tokio::test]
    async fn test_create_directory_command() {
        let handler = CommandHandler::new();
        let temp_dir = std::env::temp_dir().join(format!(
            "redoor-create-dir-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after Unix epoch")
                .as_nanos()
        ));
        let nested_dir = temp_dir.join("nested").join("child");

        let result = handler
            .execute(Command::CreateDirectory {
                path: nested_dir.to_string_lossy().to_string(),
            })
            .await;

        match result {
            CommandResult::CreateDirectory => {
                assert!(
                    tokio::fs::try_exists(&nested_dir)
                        .await
                        .expect("directory existence should be queryable"),
                    "directory should be created recursively"
                );
            }
            _ => panic!("Expected CreateDirectory"),
        }

        tokio::fs::remove_dir_all(&temp_dir)
            .await
            .expect("temporary directory should be removable");
    }

    #[tokio::test]
    async fn test_rename_path_command() {
        let handler = CommandHandler::new();
        let temp_dir = std::env::temp_dir().join(format!(
            "redoor-rename-path-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after Unix epoch")
                .as_nanos()
        ));
        let source_path = temp_dir.join("before.txt");
        let dest_path = temp_dir.join("after.txt");
        tokio::fs::create_dir_all(&temp_dir)
            .await
            .expect("temporary directory should be created");
        tokio::fs::write(&source_path, "rename me")
            .await
            .expect("source file should be created");

        let result = handler
            .execute(Command::RenamePath {
                source_path: source_path.to_string_lossy().to_string(),
                dest_path: dest_path.to_string_lossy().to_string(),
            })
            .await;

        match result {
            CommandResult::RenamePath => {
                assert!(
                    !tokio::fs::try_exists(&source_path)
                        .await
                        .expect("source existence should be queryable"),
                    "the source path should disappear after rename"
                );
                assert_eq!(
                    tokio::fs::read_to_string(&dest_path)
                        .await
                        .expect("renamed file should remain readable"),
                    "rename me",
                    "rename should preserve file contents"
                );
            }
            _ => panic!("Expected RenamePath"),
        }

        tokio::fs::remove_dir_all(&temp_dir)
            .await
            .expect("temporary directory should be removable");
    }

    #[tokio::test]
    async fn test_get_agent_details_command() {
        let handler = CommandHandler::new();
        let result = handler.execute(Command::GetAgentDetails).await;

        match result {
            CommandResult::GetAgentDetails(details) => {
                assert!(details.pid > 0, "PID should be positive");
                assert!(!details.cwd.is_empty(), "CWD should not be empty");
                // Unit tests do not call set_agent_loaded_config_path, so path stays empty.
                assert!(
                    details.config_path.is_empty(),
                    "config_path should be empty without agent startup registration"
                );
                // Absolute binary path lets operators confirm which file is running.
                assert!(
                    details.exe_path.starts_with('/'),
                    "exe_path should be absolute, got {}",
                    details.exe_path
                );
                assert!(!details.os.is_empty(), "OS should not be empty");
                assert!(!details.arch.is_empty(), "ARCH should not be empty");
                assert!(!details.hostname.is_empty(), "Hostname should not be empty");
                assert!(!details.username.is_empty(), "Username should not be empty");
                // Binary identity must match the same bake used by the server home page.
                assert_eq!(details.binary, current_binary_identity());
            }
            _ => panic!("Expected GetAgentDetails result"),
        }
    }
}
