use crate::types::{AgentId, SocketId, TransferId, UnixTimestampSeconds};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// Cargo profile the binary was compiled with (`debug` vs `release`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ServerBuildMode {
    /// Unoptimized developer build (`cargo build` / `cargo test`).
    Debug,
    /// Optimized production build (`cargo build --release`).
    Release,
    /// Profile string from Cargo was not `debug` or `release`.
    Unknown,
}

/// Non-secret compile-time identity shared by server and agent binaries.
///
/// Kept identical on both sides so the UI can compare a connected agent against
/// the server and flag mismatched or dirty builds without probing the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BinaryIdentity {
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

/// Reads compile-time identity baked by `build.rs` for the running binary.
pub fn current_binary_identity() -> BinaryIdentity {
    BinaryIdentity {
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_rev: env!("REDOOR_GIT_REV").to_string(),
        git_dirty: env!("REDOOR_GIT_DIRTY") == "1",
        version_dirty: env!("REDOOR_VERSION_DIRTY") == "1",
        build_mode: match env!("REDOOR_BUILD_PROFILE") {
            "release" => ServerBuildMode::Release,
            "debug" => ServerBuildMode::Debug,
            _ => ServerBuildMode::Unknown,
        },
        build_date: env!("REDOOR_BUILD_DATE").to_string(),
    }
}

/// Absolute filesystem path of the running binary for operator diagnostics.
///
/// Prefer the canonical path so `/proc/self/exe`-style links resolve to a real file.
pub async fn current_exe_path() -> String {
    match std::env::current_exe() {
        Ok(path) => match tokio::fs::canonicalize(&path).await {
            Ok(canonical) => canonical.display().to_string(),
            Err(_) => path.display().to_string(),
        },
        Err(_) => "unknown".to_string(),
    }
}

/// Resolves and caches the primary non-loopback IP selected by the local routing table.
pub async fn external_ip() -> Option<String> {
    static EXTERNAL_IP: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();

    EXTERNAL_IP
        .get_or_init(|| async {
            let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.ok()?;
            // UDP connect only asks the kernel to choose a route; it sends no network traffic.
            socket.connect("1.1.1.1:80").await.ok()?;
            let address = socket.local_addr().ok()?.ip();
            (!address.is_loopback() && !address.is_unspecified()).then(|| address.to_string())
        })
        .await
        .clone()
}

/// Process-local agent config path recorded once at agent startup.
///
/// Empty when the agent was launched from CLI/env only without loading a TOML file.
static AGENT_LOADED_CONFIG_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Records the config file this agent process loaded, when any.
///
/// Called once during agent startup so `GetAgentDetails` can surface it without
/// threading config state through every command handler call site.
pub fn set_agent_loaded_config_path(path: Option<std::path::PathBuf>) {
    let value = path
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let _ = AGENT_LOADED_CONFIG_PATH.set(value);
}

/// Absolute path of the TOML file this agent loaded, or empty when none was used.
pub fn agent_loaded_config_path() -> String {
    AGENT_LOADED_CONFIG_PATH.get().cloned().unwrap_or_default()
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ls {
        path: Option<String>,
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
    },
    RawUpload {
        path: String,
    },
    TarUpload {
        path: String,
    },
    LocalCopyFile {
        source_path: String,
        dest_path: String,
    },
    LocalCopyDirectory {
        source_path: String,
        dest_path: String,
    },
    RawDelete {
        path: String,
    },
    CreateDirectory {
        path: String,
    },
    Metadata {
        path: String,
    },
    Echo {
        request: EchoRequest,
    },
    AgentInfo,
    GetAgentDetails,
    Restart,
}

impl Command {
    /// Short operator-facing label without large or sensitive payloads.
    pub fn summary(&self) -> String {
        match self {
            Self::Ls { path } => match path {
                Some(path) => format!("Ls path={path}"),
                None => "Ls path=.".to_string(),
            },
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
            Self::TarDownload { path } => format!("TarDownload path={path}"),
            Self::RawUpload { path } => format!("RawUpload path={path}"),
            Self::TarUpload { path } => format!("TarUpload path={path}"),
            Self::LocalCopyFile {
                source_path,
                dest_path,
            } => format!("LocalCopyFile source={source_path} dest={dest_path}"),
            Self::LocalCopyDirectory {
                source_path,
                dest_path,
            } => format!("LocalCopyDirectory source={source_path} dest={dest_path}"),
            Self::RawDelete { path } => format!("RawDelete path={path}"),
            Self::CreateDirectory { path } => format!("CreateDirectory path={path}"),
            Self::Metadata { path } => format!("Metadata path={path}"),
            // Echo bodies can be large or sensitive, so only the command name is logged.
            Self::Echo { .. } => "Echo".to_string(),
            Self::AgentInfo => "AgentInfo".to_string(),
            Self::GetAgentDetails => "GetAgentDetails".to_string(),
            Self::Restart => "Restart".to_string(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatResult {
    pub content: String,
    pub path: String,
}

/// Keeps in-browser text editing away from multi-megabyte payloads.
const MAX_EDITABLE_FILE_BYTES: u64 = 2 * 1024 * 1024;

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
    Metadata(MetadataResponse),
    Echo(EchoResult),
    AgentInfo(AgentInfoResult),
    GetAgentDetails(AgentDetailsResponse),
    Restart,
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CopyEndpoint {
    pub agent: AgentId,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CopyFileRequest {
    pub source: CopyEndpoint,
    pub dest: CopyEndpoint,
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
            Self::Cat(_) => "ok Cat".to_string(),
            Self::RawDownload { path } => format!("ok RawDownload path={path}"),
            Self::TarDownload { path } => format!("ok TarDownload path={path}"),
            Self::RawUpload => "ok RawUpload".to_string(),
            Self::TarUpload => "ok TarUpload".to_string(),
            Self::LocalCopyFile => "ok LocalCopyFile".to_string(),
            Self::LocalCopyDirectory => "ok LocalCopyDirectory".to_string(),
            Self::RawDelete => "ok RawDelete".to_string(),
            Self::CreateDirectory => "ok CreateDirectory".to_string(),
            Self::Metadata(_) => "ok Metadata".to_string(),
            Self::Echo(_) => "ok Echo".to_string(),
            Self::AgentInfo(_) => "ok AgentInfo".to_string(),
            Self::GetAgentDetails(_) => "ok GetAgentDetails".to_string(),
            Self::Restart => "ok Restart".to_string(),
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

pub struct CommandHandler;

impl Default for CommandHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandHandler {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, command: Command) -> CommandResult {
        match command {
            Command::Ls { path } => self.ls(path).await,
            Command::Cat { path } => self.cat(path).await,
            Command::RawDownload {
                path,
                range_start,
                range_end,
            } => self.raw_download(path, range_start, range_end).await,
            Command::TarDownload { path } => self.tar_download(path).await,
            Command::RawUpload { path } => self.raw_upload(path).await,
            Command::TarUpload { path } => self.tar_upload(path).await,
            Command::LocalCopyFile { .. } => CommandResult::error(
                CommandErrorKind::InvalidInput,
                "LocalCopyFile is handled by the agent runtime",
            ),
            Command::LocalCopyDirectory { .. } => CommandResult::error(
                CommandErrorKind::InvalidInput,
                "LocalCopyDirectory is handled by the agent runtime",
            ),
            Command::RawDelete { path } => self.raw_delete(path).await,
            Command::CreateDirectory { path } => self.create_directory(path).await,
            Command::Metadata { path } => self.metadata(path).await,
            Command::Echo { request } => self.echo(request).await,
            Command::AgentInfo => self.agent_info().await,
            Command::GetAgentDetails => self.get_agent_details().await,
            Command::Restart => CommandResult::Restart,
        }
    }

    async fn ls(&self, path: Option<String>) -> CommandResult {
        use nix::unistd::{Group, User};
        use std::os::unix::fs::MetadataExt;

        let path = path.unwrap_or_else(|| ".".to_string());

        match tokio::fs::metadata(&path).await {
            Ok(metadata) => {
                if metadata.is_dir() {
                    match tokio::fs::read_dir(&path).await {
                        Ok(mut entries) => {
                            let mut files = Vec::new();
                            while let Some(entry) = entries.next_entry().await.ok().flatten() {
                                let entry_metadata = entry.metadata().await.ok();
                                let name = entry.file_name().into_string().ok();

                                if let (Some(entry_metadata), Some(name)) = (entry_metadata, name) {
                                    let is_dir = entry_metadata.is_dir();
                                    let file_type = if is_dir { "directory" } else { "file" };
                                    let size = entry_metadata.size();
                                    let uid = entry_metadata.uid();
                                    let gid = entry_metadata.gid();

                                    let owner = User::from_uid(nix::unistd::Uid::from_raw(uid))
                                        .ok()
                                        .flatten()
                                        .map(|u| u.name);

                                    let group = Group::from_gid(nix::unistd::Gid::from_raw(gid))
                                        .ok()
                                        .flatten()
                                        .map(|g| g.name);

                                    files.push(LsEntry {
                                        name,
                                        file_type: file_type.to_string(),
                                        size,
                                        owner,
                                        group,
                                        uid,
                                        gid,
                                    });
                                }
                            }

                            let uid = metadata.uid();
                            let gid = metadata.gid();
                            let owner = User::from_uid(nix::unistd::Uid::from_raw(uid))
                                .ok()
                                .flatten()
                                .map(|user| user.name);
                            let group = Group::from_gid(nix::unistd::Gid::from_raw(gid))
                                .ok()
                                .flatten()
                                .map(|group| group.name);

                            CommandResult::LsDirectory(LsDirectoryResult {
                                files,
                                path,
                                owner,
                                group,
                                uid,
                                gid,
                                permissions: metadata.mode() & 0o777,
                            })
                        }
                        Err(error) => CommandResult::io_error("Failed to read directory", error),
                    }
                } else {
                    let size = metadata.size();
                    let uid = metadata.uid();
                    let gid = metadata.gid();
                    let permissions = metadata.mode() & 0o777;

                    let owner = User::from_uid(nix::unistd::Uid::from_raw(uid))
                        .ok()
                        .flatten()
                        .map(|u| u.name);

                    let group = Group::from_gid(nix::unistd::Gid::from_raw(gid))
                        .ok()
                        .flatten()
                        .map(|g| g.name);

                    CommandResult::LsFile(LsFileResult {
                        size,
                        path,
                        owner,
                        group,
                        uid,
                        gid,
                        permissions,
                    })
                }
            }
            Err(error) => CommandResult::io_error("Failed to get metadata", error),
        }
    }

    async fn cat(&self, path: String) -> CommandResult {
        match tokio::fs::read_to_string(&path).await {
            Ok(content) => CommandResult::Cat(CatResult { content, path }),
            Err(error) => CommandResult::io_error("Failed to read file", error),
        }
    }

    async fn raw_download(
        &self,
        path: String,
        _range_start: Option<u64>,
        _range_end: Option<u64>,
    ) -> CommandResult {
        CommandResult::RawDownload { path }
    }

    async fn tar_download(&self, path: String) -> CommandResult {
        CommandResult::TarDownload { path }
    }

    async fn raw_upload(&self, _path: String) -> CommandResult {
        CommandResult::RawUpload
    }

    async fn tar_upload(&self, _path: String) -> CommandResult {
        CommandResult::TarUpload
    }

    async fn raw_delete(&self, path: String) -> CommandResult {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) => {
                let delete_result = if metadata.is_dir() {
                    tokio::fs::remove_dir_all(&path).await
                } else {
                    tokio::fs::remove_file(&path).await
                };

                match delete_result {
                    Ok(()) => CommandResult::RawDelete,
                    Err(error) => CommandResult::io_error("Failed to delete path", error),
                }
            }
            Err(error) => CommandResult::io_error("Failed to access path for deletion", error),
        }
    }

    async fn create_directory(&self, path: String) -> CommandResult {
        match tokio::fs::create_dir_all(&path).await {
            Ok(()) => CommandResult::CreateDirectory,
            Err(error) => CommandResult::io_error("Failed to create directory", error),
        }
    }

    /// Marks a file editable only after size and full-content UTF-8 checks succeed,
    /// ignoring extensions so binary data cannot open in the text editor.
    async fn is_file_editable(path: &str, file_size: u64, is_file: bool) -> bool {
        if !is_file || file_size > MAX_EDITABLE_FILE_BYTES {
            return false;
        }

        match tokio::fs::read(path).await {
            Ok(bytes) => std::str::from_utf8(&bytes).is_ok(),
            Err(_) => false,
        }
    }

    /// Sniffs a small file prefix so extensionless downloads can set a MIME type
    /// without buffering the entire file before streaming starts.
    async fn detect_mime_type_from_content(path: &str) -> Option<String> {
        use tokio::{fs::File, io::AsyncReadExt};

        const MIME_SNIFF_BYTES: usize = 8 * 1024;

        let mut file = match File::open(path).await {
            Ok(file) => file,
            Err(_) => return None,
        };

        let mut content = [0_u8; MIME_SNIFF_BYTES];
        let mut bytes_read = 0;

        while bytes_read < content.len() {
            let read = match file.read(&mut content[bytes_read..]).await {
                Ok(read) => read,
                Err(_) => return None,
            };

            if read == 0 {
                break;
            }

            bytes_read += read;
        }

        let content = &content[..bytes_read];

        // Check for shebang pattern at the start (scripts without extension)
        if content.starts_with(b"#!") {
            return Some("text/plain".to_string());
        }

        // Check for UTF-8 BOM
        if content.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Some("text/plain".to_string());
        }

        // Check for common binary magic numbers
        if content.starts_with(b"%PDF") {
            return Some("application/pdf".to_string());
        }

        if content.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            return Some("image/png".to_string());
        }

        if content.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Some("image/jpeg".to_string());
        }

        if content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a") {
            return Some("image/gif".to_string());
        }

        if content.starts_with(b"PK\x03\x04") || content.starts_with(b"PK\x05\x06") {
            return Some("application/zip".to_string());
        }

        if content.starts_with(&[0x7F, 0x45, 0x4C, 0x46]) {
            return Some("application/x-executable".to_string());
        }

        if content.starts_with(&[0x00, 0x61, 0x73, 0x6D]) {
            return Some("application/wasm".to_string());
        }

        if content.starts_with(b"\x1F\x8B") {
            return Some("application/gzip".to_string());
        }

        if content.starts_with(b"BZh") {
            return Some("application/x-bzip2".to_string());
        }

        if content.starts_with(&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
            return Some("application/x-xz".to_string());
        }

        if content.starts_with(b"Rar!") || content.starts_with(b"Rar\x1A\x07") {
            return Some("application/x-rar-compressed".to_string());
        }

        if content.starts_with(b"\x37\x7A\xBC\xAF\x27\x1C") {
            return Some("application/x-7z-compressed".to_string());
        }

        if content.starts_with(b"fLaC") {
            return Some("audio/flac".to_string());
        }

        if content.starts_with(b"ID3")
            || content.starts_with(&[0xFF, 0xFB])
            || content.starts_with(&[0xFF, 0xF3])
            || content.starts_with(&[0xFF, 0xF2])
        {
            return Some("audio/mpeg".to_string());
        }

        if content.starts_with(b"\x00\x00\x00 ftyp")
            || content.starts_with(b"\x00\x00\x00\x18ftyp")
            || content.starts_with(b"\x00\x00\x00\x14ftyp")
        {
            return Some("video/mp4".to_string());
        }

        if content.starts_with(b"RIFF") && content.len() >= 12 && &content[8..12] == b"AVI " {
            return Some("video/x-msvideo".to_string());
        }

        None
    }

    async fn metadata(&self, path: String) -> CommandResult {
        use std::os::unix::fs::MetadataExt;
        use std::path::Path;

        match tokio::fs::metadata(&path).await {
            Ok(metadata) => {
                // Determine MIME type from file extension or content
                let mime_type = match Path::new(&path)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .and_then(|ext| mime_guess::from_ext(ext).first())
                    .map(|mime| mime.to_string())
                {
                    Some(mime) => mime,
                    None => {
                        // No extension found, try content-based detection
                        Self::detect_mime_type_from_content(&path)
                            .await
                            .unwrap_or_else(|| "application/octet-stream".to_string())
                    }
                };

                let file_size = metadata.size();
                let is_file = metadata.is_file();
                let is_dir = metadata.is_dir();
                let editable = Self::is_file_editable(&path, file_size, is_file).await;

                CommandResult::Metadata(MetadataResponse {
                    path,
                    mime_type,
                    file_size,
                    is_file,
                    is_dir,
                    editable,
                    // Agents cannot observe server-local credentials; the HTTP handler fills these.
                    one_time_tokens: Vec::new(),
                })
            }
            Err(error) => CommandResult::io_error("Failed to get file metadata", error),
        }
    }

    async fn echo(&self, request: EchoRequest) -> CommandResult {
        if request.random_sleep {
            let sleep_ms = fastrand::u64(10..500);
            tokio::time::sleep(tokio::time::Duration::from_millis(sleep_ms)).await;
        }
        CommandResult::Echo(EchoResult {
            message: request.message,
        })
    }

    async fn agent_info(&self) -> CommandResult {
        use std::env;
        use sysinfo::System;

        let pid = std::process::id();
        let cwd = env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        let mut sys = System::new_all();
        sys.refresh_all();
        let load_avg = System::load_average();
        let load_average = (load_avg.one, load_avg.five, load_avg.fifteen);
        let system_uptime = System::uptime();

        CommandResult::AgentInfo(AgentInfoResult {
            pid,
            cwd,
            load_average,
            system_uptime,
        })
    }

    async fn get_agent_details(&self) -> CommandResult {
        use std::env;
        use sysinfo::System;

        let pid = std::process::id();
        let cwd = env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        // Operators need the on-disk binary path when diagnosing upgrades and restarts.
        let (exe_path, external_ip) = tokio::join!(current_exe_path(), external_ip());
        // Empty when the agent was launched without a TOML file (CLI/env only).
        let config_path = agent_loaded_config_path();

        let mut sys = System::new_all();
        sys.refresh_all();
        let load_avg = System::load_average();
        let load_average = (load_avg.one, load_avg.five, load_avg.fifteen);
        let system_uptime = System::uptime();

        let os = std::env::consts::OS.to_string();
        let arch = std::env::consts::ARCH.to_string();
        let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
        let username = env::var("USER").unwrap_or_else(|_| "unknown".to_string());

        CommandResult::GetAgentDetails(AgentDetailsResponse {
            id: AgentId::from(""),
            name: String::new(),
            pid,
            cwd,
            config_path,
            exe_path,
            load_average_one: load_average.0,
            load_average_five: load_average.1,
            load_average_fifteen: load_average.2,
            system_uptime,
            os,
            arch,
            hostname,
            external_ip,
            username,
            connected_at: UnixTimestampSeconds::new(0),
            // Agent process reports its own baked identity; router may also rewrite from registration.
            binary: current_binary_identity(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_detect_mime_type_from_content_reads_only_prefix() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            CommandHandler::detect_mime_type_from_content("/dev/zero"),
        )
        .await;

        // This must complete promptly so extensionless metadata requests do not wait for EOF on
        // special files or buffer unbounded content before the download stream can start.
        assert!(
            result.is_ok(),
            "content sniffing should only read a bounded prefix"
        );
        assert_eq!(
            result.unwrap(),
            None,
            "zero-filled content should not match a known MIME"
        );
    }

    #[tokio::test]
    async fn test_metadata_marks_utf8_text_editable() {
        let path = std::env::temp_dir().join(format!(
            "redoor-metadata-editable-{}.bin",
            std::process::id()
        ));
        tokio::fs::write(&path, "hello plain text")
            .await
            .expect("write text");

        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Metadata {
                path: path.to_string_lossy().into_owned(),
            })
            .await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // Extensionless UTF-8 content must still be editable for the UI editor gate.
                assert!(metadata.editable);
                assert!(metadata.is_file);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_metadata_rejects_invalid_utf8_as_not_editable() {
        let path =
            std::env::temp_dir().join(format!("redoor-metadata-binary-{}.txt", std::process::id()));
        tokio::fs::write(&path, [0xff, 0xfe, 0xfd])
            .await
            .expect("write binary");

        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Metadata {
                path: path.to_string_lossy().into_owned(),
            })
            .await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // A .txt suffix must not override invalid UTF-8 content.
                assert!(!metadata.editable);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_metadata_rejects_large_utf8_as_not_editable() {
        let path =
            std::env::temp_dir().join(format!("redoor-metadata-large-{}.txt", std::process::id()));
        let large = vec![b'a'; (MAX_EDITABLE_FILE_BYTES as usize) + 1];
        tokio::fs::write(&path, large).await.expect("write large");

        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Metadata {
                path: path.to_string_lossy().into_owned(),
            })
            .await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // Size gating avoids loading multi-megabyte bodies into the browser textarea.
                assert!(!metadata.editable);
                assert!(metadata.file_size > MAX_EDITABLE_FILE_BYTES);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

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
            })
            .await;

        match result {
            CommandResult::TarDownload { path } => {
                assert_eq!(path, "test-dir");
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
