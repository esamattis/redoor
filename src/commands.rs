use crate::types::{TransferId, UnixTimestampSeconds};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
    RawDelete {
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LsDirectoryResult {
    pub files: Vec<LsEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LsFileResult {
    pub size: u64,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CommandResult {
    LsDirectory(LsDirectoryResult),
    LsFile(LsFileResult),
    Cat(CatResult),
    RawDownload { path: String },
    TarDownload { path: String },
    RawUpload,
    TarUpload,
    RawDelete,
    Metadata(MetadataResponse),
    Echo(EchoResult),
    AgentInfo(AgentInfoResult),
    GetAgentDetails(AgentDetailsResponse),
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentListResponse {
    pub agents: Vec<AgentInfoResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentInfoResponse {
    pub id: String,
    pub name: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsDirectoryResponse {
    pub files: Vec<LsEntry>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentDetailsResponse {
    pub id: String,
    pub name: String,
    pub pid: u32,
    pub cwd: String,
    pub load_average_one: f64,
    pub load_average_five: f64,
    pub load_average_fifteen: f64,
    #[ts(type = "number")]
    pub system_uptime: u64,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub username: String,
    pub connected_at: UnixTimestampSeconds,
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
pub struct CopyEndpoint {
    pub agent: String,
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
#[ts(rename_all = "snake_case")]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
    Refresh,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferProgressEntry {
    pub request_id: TransferId,
    pub agent_id: String,
    pub path: String,
    pub source: Option<CopyEndpoint>,
    pub dest: Option<CopyEndpoint>,
    pub direction: TransferDirection,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub transferred_bytes: u64,
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

pub struct CommandHandler;

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
            Command::RawDelete { path } => self.raw_delete(path).await,
            Command::Metadata { path } => self.metadata(path).await,
            Command::Echo { request } => self.echo(request).await,
            Command::AgentInfo => self.agent_info().await,
            Command::GetAgentDetails => self.get_agent_details().await,
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

                            CommandResult::LsDirectory(LsDirectoryResult { files })
                        }
                        Err(e) => CommandResult::Error {
                            message: format!("Failed to read directory: {}", e),
                        },
                    }
                } else {
                    let size = metadata.size();
                    let uid = metadata.uid();
                    let gid = metadata.gid();

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
                    })
                }
            }
            Err(e) => CommandResult::Error {
                message: format!("Failed to get metadata: {}", e),
            },
        }
    }

    async fn cat(&self, path: String) -> CommandResult {
        match tokio::fs::read_to_string(&path).await {
            Ok(content) => CommandResult::Cat(CatResult { content, path }),
            Err(e) => CommandResult::Error {
                message: format!("Failed to read file: {}", e),
            },
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
        match tokio::fs::remove_file(&path).await {
            Ok(()) => CommandResult::RawDelete,
            Err(e) => CommandResult::Error {
                message: format!("Failed to delete file: {}", e),
            },
        }
    }

    async fn detect_mime_type_from_content(path: &str) -> Option<String> {
        // Read first 8KB of file
        let content = match tokio::fs::read(path).await {
            Ok(data) => data,
            Err(_) => return None,
        };

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

        if content.starts_with(b"RIFF") && content.len() >= 8 && &content[8..12] == b"AVI " {
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

                CommandResult::Metadata(MetadataResponse {
                    path,
                    mime_type,
                    file_size,
                    is_file: metadata.is_file(),
                    is_dir: metadata.is_dir(),
                })
            }
            Err(e) => CommandResult::Error {
                message: format!("Failed to get file metadata: {}", e),
            },
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
            id: String::new(),
            name: String::new(),
            pid,
            cwd,
            load_average_one: load_average.0,
            load_average_five: load_average.1,
            load_average_fifteen: load_average.2,
            system_uptime,
            os,
            arch,
            hostname,
            username,
            connected_at: UnixTimestampSeconds::new(0),
        })
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
            CommandResult::Error { message } => {
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
    async fn test_get_agent_details_command() {
        let handler = CommandHandler::new();
        let result = handler.execute(Command::GetAgentDetails).await;

        match result {
            CommandResult::GetAgentDetails(details) => {
                assert!(details.pid > 0, "PID should be positive");
                assert!(!details.cwd.is_empty(), "CWD should not be empty");
                assert!(!details.os.is_empty(), "OS should not be empty");
                assert!(!details.arch.is_empty(), "ARCH should not be empty");
                assert!(!details.hostname.is_empty(), "Hostname should not be empty");
                assert!(!details.username.is_empty(), "Username should not be empty");
            }
            _ => panic!("Expected GetAgentDetails result"),
        }
    }
}
