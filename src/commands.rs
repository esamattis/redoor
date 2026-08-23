mod file_search;
mod handler;
mod identity;
mod metadata;

use crate::types::{AgentId, SocketId, TransferId, UnixTimestampMillis, UnixTimestampSeconds};
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

/// Replacement JSON document written through to the login account's state file.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateUserStateRequest {
    /// Uninterpreted JSON that replaces the previous document.
    #[ts(type = "unknown")]
    pub state: serde_json::Value,
}

/// JSON document restored from the login account's state file so the UI can hydrate preferences.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserStateResponse {
    /// Uninterpreted JSON previously persisted for this account.
    #[ts(type = "unknown")]
    pub state: serde_json::Value,
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
        /// Keeps the deadline agent-local so traversal stops even if the REST caller disconnects.
        #[serde(default = "default_file_search_timeout_seconds")]
        timeout_seconds: u64,
        /// Hidden directories are opt-in because they often contain large caches and metadata trees.
        #[serde(default)]
        include_hidden: bool,
        /// Git ignore rules are enabled by default so searches match repository expectations.
        #[serde(default = "default_true")]
        respect_gitignore: bool,
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
    /// Moves one file or directory locally, preferring an atomic filesystem rename.
    LocalMove {
        source_path: String,
        dest_path: String,
        source_is_directory: bool,
        /// Prevents either rename or fallback cleanup from acting on a replacement source.
        expected_identity: MoveSourceIdentity,
        /// Controls replacement when the destination path already exists.
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
        dir: String,
        old: String,
        new: String,
    },
    Metadata {
        path: String,
    },
    /// Reads the stable filesystem identity needed to delete only the source that was copied.
    MoveMetadata {
        path: String,
    },
    /// Removes a move source only while it still has the identity captured before copying.
    DeleteMoveSource {
        path: String,
        expected_identity: MoveSourceIdentity,
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

/// Preserves the public REST default when a newer agent receives a command from an older server.
fn default_file_search_timeout_seconds() -> u64 {
    5
}

/// Preserves default-enabled command options when older senders omit them.
fn default_true() -> bool {
    true
}

impl Command {
    /// Short operator-facing label without large or sensitive payloads.
    pub fn summary(&self) -> String {
        match self {
            Self::Ls { path } => match path {
                Some(path) => format!("Ls path={path}"),
                None => "Ls path=.".to_string(),
            },
            Self::FileSearch {
                path,
                query,
                timeout_seconds,
                include_hidden,
                respect_gitignore,
            } => {
                format!(
                    "FileSearch path={path} query={query} timeout={timeout_seconds}s include_hidden={include_hidden} respect_gitignore={respect_gitignore}"
                )
            }
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
            Self::LocalMove {
                source_path,
                dest_path,
                source_is_directory,
                on_existing,
                ..
            } => format!(
                "LocalMove source={source_path} dest={dest_path} directory={source_is_directory} on_existing={on_existing:?}"
            ),
            Self::RawDelete { path } => format!("RawDelete path={path}"),
            Self::CreateDirectory { path } => format!("CreateDirectory path={path}"),
            Self::RenamePath { dir, old, new } => {
                format!("RenamePath dir={dir} old={old} new={new}")
            }
            Self::Metadata { path } => format!("Metadata path={path}"),
            Self::MoveMetadata { path } => format!("MoveMetadata path={path}"),
            Self::DeleteMoveSource { path, .. } => format!("DeleteMoveSource path={path}"),
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
    #[ts(type = "number")]
    pub duration_ms: u64,
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

/// Returns move-specific metadata without exposing filesystem identity through the public API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveMetadataResult {
    pub file_size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub identity: MoveSourceIdentity,
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
    ServiceUnavailable,
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
    /// Carries whether renameat2 published the destination so the public row can hide copy speeds.
    LocalMove {
        atomic: bool,
    },
    RawDelete,
    CreateDirectory,
    RenamePath,
    Metadata(MetadataResponse),
    MoveMetadata(MoveMetadataResult),
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

/// Describes one SSH-backed managed agent to persist and register at runtime.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateSshAgentRequest {
    /// SSH host, alias, or destination accepted by the local OpenSSH client.
    pub target: String,
    /// Optional explicit SSH username instead of the target or SSH config default.
    pub username: Option<String>,
    /// Optional explicit SSH port instead of the SSH config default.
    pub ssh_port: Option<u16>,
    /// Stable managed-agent name; defaults to the target hostname when omitted.
    pub name: Option<String>,
    /// Optional path where the remote Redoor binary is installed.
    pub remote_bin: Option<String>,
    /// Optional initial browser directory advertised before the first connection.
    pub home: Option<String>,
    /// Optional local path receiving SSH subprocess diagnostics.
    pub log: Option<String>,
    /// New password to persist; omit or send empty on update to keep the existing secret.
    pub password: Option<String>,
    /// When true, drop any stored password so key or ssh-agent auth is used.
    /// Separate from an omitted password because that still means "keep" on update.
    pub clear_password: Option<bool>,
}

/// Returns the newly visible dormant inventory record after persistence succeeds.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateSshAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Returns the editable TOML fields for one SSH-backed managed agent.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ManagedSshAgentConfigurationResponse {
    /// SSH host, alias, or destination accepted by the local OpenSSH client.
    pub target: String,
    /// Optional explicit SSH username instead of the target or SSH config default.
    pub username: Option<String>,
    /// Optional explicit SSH port instead of the SSH config default.
    pub ssh_port: Option<u16>,
    /// Stable managed-agent name; defaults to the target hostname when omitted.
    pub name: Option<String>,
    /// Optional path where the remote Redoor binary is installed.
    pub remote_bin: Option<String>,
    /// Optional initial browser directory advertised before the first connection.
    pub home: Option<String>,
    /// Optional local path receiving SSH subprocess diagnostics.
    pub log: Option<String>,
    /// Always null on GET so the stored SSH password is never sent to the browser.
    pub password: Option<String>,
    /// Reports whether a password is stored so the edit form can choose the matching auth radio.
    pub has_password: bool,
}

/// Returns the replacement dormant inventory record after an SSH configuration edit.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateSshAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Describes one local managed agent to persist and register at runtime.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateLocalAgentRequest {
    /// Stable managed-agent name; defaults to the server hostname when omitted.
    pub name: Option<String>,
    /// Optional initial browser directory advertised before the first connection.
    pub home: Option<String>,
    /// Optional local path receiving the spawned agent process diagnostics.
    pub log: Option<String>,
}

/// Returns the newly visible dormant inventory record after local persistence succeeds.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateLocalAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Returns the editable TOML fields for one local managed agent.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ManagedLocalAgentConfigurationResponse {
    /// Stable managed-agent name; defaults to the server hostname when omitted.
    pub name: Option<String>,
    /// Optional initial browser directory advertised before the first connection.
    pub home: Option<String>,
    /// Optional local path receiving the spawned agent process diagnostics.
    pub log: Option<String>,
}

/// Returns the replacement dormant inventory record after a local configuration edit.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateLocalAgentResponse {
    pub agent: AgentInfoResponse,
}

/// Confirms that a managed entry and its dormant runtime registration were removed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeleteManagedAgentResponse {
    pub deleted: bool,
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

/// One sticky provisioning line so the starting UI can show SSH progress without a log stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProvisioningStatusMessage {
    /// Operator-facing step text accumulated for the current start attempt.
    pub message: String,
    /// Server-side millisecond stamp so elapsed labels can show secs + ms.
    pub at: UnixTimestampMillis,
}

/// Summarizes one known agent without requiring a current WebSocket connection.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentInfoResponse {
    pub id: AgentId,
    pub name: String,
    pub cwd: Option<String>,
    pub managed: bool,
    /// Whether this managed TOML entry can be edited or deleted from the UI.
    pub configuration_editable: bool,
    /// Configured SSH destination so list views can label remotes without a second request.
    pub ssh_target: Option<String>,
    pub status: AgentConnectionStatus,
    pub connected_at: Option<UnixTimestampSeconds>,
    /// Current WebSocket generation; changes whenever this agent reconnects.
    pub connection_id: Option<SocketId>,
    pub last_seen_at: Option<UnixTimestampSeconds>,
    pub connection_issue: Option<String>,
    /// Ordered SSH start steps for the current attempt; empty for local or dormant agents.
    pub provisioning_status: Vec<ProvisioningStatusMessage>,
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
    /// Current filesystems are optional on the wire so newer servers can still inspect older agents.
    #[serde(default)]
    pub mount_points: Vec<MountPoint>,
}

/// Describes one mounted filesystem for capacity checks and direct browser navigation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MountPoint {
    /// Absolute path where the filesystem is mounted.
    pub path: String,
    /// Bytes available to the user running the agent, when reported by the platform.
    #[ts(type = "number | null")]
    pub available_bytes: Option<u64>,
    /// Total filesystem capacity in bytes, when reported by the platform.
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    /// Filesystem format such as ext4, tmpfs, APFS, or NTFS.
    pub mount_type: Option<String>,
}

impl MountPoint {
    /// Hides pseudo-filesystems that add noise without representing operator-managed storage.
    pub fn is_visible(&self) -> bool {
        !matches!(
            self.mount_type.as_deref(),
            Some(
                "devpts"
                    | "devtmpfs"
                    | "proc"
                    | "fuse.lxcfs"
                    | "sysfs"
                    | "efivarfs"
                    | "cgroup2"
                    | "fusectl"
                    | "pstore"
                    | "debugfs"
                    | "securityfs"
                    | "tmpfs"
                    | "mqueue"
                    | "binfmt_misc"
            )
        )
    }
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

/// Keeps rename inside one directory so the operation remains an atomic metadata change.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenamePathRequest {
    pub dir: String,
    pub old: String,
    pub new: String,
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

/// Starts one logical move between agent filesystem endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MoveFileRequest {
    pub source: CopyEndpoint,
    pub dest: CopyEndpoint,
    /// What to do when `dest.path` already exists.
    #[serde(default)]
    pub on_existing: CopyExistingMode,
}

/// Returns the public id used to follow asynchronous move progress.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MoveFileResponse {
    pub move_request_id: TransferId,
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
    /// Agent inventory changed and agent-dependent route data may need reloading.
    AgentsChanged,
    /// Filesystem state changed and the active route may need reloading.
    RoutesChanged,
    /// Transfer progress changed without requiring unrelated route loaders to rerun.
    TransfersChanged,
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
    /// Stamped only after a same-agent renameat2 so the UI can label it and skip copy speeds.
    pub atomic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
    Copy,
    Move,
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
            Self::RawDownload { path } => format!("ok RawDownload path={path}"),
            Self::TarDownload { path } => format!("ok TarDownload path={path}"),
            Self::RawUpload => "ok RawUpload".to_string(),
            Self::TarUpload => "ok TarUpload".to_string(),
            Self::LocalCopyFile => "ok LocalCopyFile".to_string(),
            Self::LocalCopyDirectory => "ok LocalCopyDirectory".to_string(),
            Self::LocalMove { atomic } => format!("ok LocalMove atomic={atomic}"),
            Self::RawDelete => "ok RawDelete".to_string(),
            Self::CreateDirectory => "ok CreateDirectory".to_string(),
            Self::RenamePath => "ok RenamePath".to_string(),
            Self::Metadata(_) => "ok Metadata".to_string(),
            Self::MoveMetadata(_) => "ok MoveMetadata".to_string(),
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
    use crate::test_support::TempDir;

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
        let temp = TempDir::create();
        let temp_path = temp.path().join("delete-test.txt");

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
        let temp = TempDir::create();
        let temp_dir = temp.path().join("delete-dir-test");
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
        let temp = TempDir::create();
        let nested_dir = temp.path().join("nested").join("child");

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
    }

    #[tokio::test]
    async fn test_rename_path_command() {
        let handler = CommandHandler::new();
        let temp = TempDir::create();
        let source_path = temp.path().join("before.txt");
        let dest_path = temp.path().join("after.txt");
        tokio::fs::write(&source_path, "rename me")
            .await
            .expect("source file should be created");

        let result = handler
            .execute(Command::RenamePath {
                dir: temp.path().to_string_lossy().to_string(),
                old: "before.txt".to_string(),
                new: "after.txt".to_string(),
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
                assert!(
                    details.mount_points.iter().any(|mount| mount.path == "/"),
                    "the filesystem root should be present in mount details"
                );
                assert!(
                    details.mount_points.iter().all(|mount| {
                        mount.available_bytes.zip(mount.total_bytes).is_none_or(
                            |(available_bytes, total_bytes)| available_bytes <= total_bytes,
                        )
                    }),
                    "available mount capacity should not exceed total capacity"
                );
                assert!(
                    details.mount_points.iter().all(MountPoint::is_visible),
                    "virtual device, process, and LXC filesystems should stay hidden"
                );
                // Binary identity must match the same bake used by the server home page.
                assert_eq!(details.binary, current_binary_identity());
            }
            _ => panic!("Expected GetAgentDetails result"),
        }
    }

    /// Keeps the shared agent, server, and UI exclusion contract exact.
    #[test]
    fn test_mount_point_visibility() {
        for mount_type in [
            "devpts",
            "devtmpfs",
            "proc",
            "fuse.lxcfs",
            "sysfs",
            "efivarfs",
            "cgroup2",
            "fusectl",
            "pstore",
            "debugfs",
            "securityfs",
            "tmpfs",
            "mqueue",
            "binfmt_misc",
        ] {
            let mount = MountPoint {
                path: "/ignored".to_string(),
                available_bytes: Some(0),
                total_bytes: Some(0),
                mount_type: Some(mount_type.to_string()),
            };
            assert!(
                !mount.is_visible(),
                "{mount_type} should be excluded from mount inventory"
            );
        }

        let storage_mount = MountPoint {
            path: "/".to_string(),
            available_bytes: Some(1),
            total_bytes: Some(2),
            mount_type: Some("ext4".to_string()),
        };
        assert!(
            storage_mount.is_visible(),
            "storage filesystems should remain visible"
        );
    }
}
