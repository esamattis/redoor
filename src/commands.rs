use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ls { path: Option<String> },
    Cat { path: String },
    RawDownload { path: String },
    Echo { request: EchoRequest },
    AgentInfo,
    GetAgentDetails,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LsResult {
    pub files: Vec<LsEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatResult {
    pub content: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CommandResult {
    Ls(LsResult),
    Cat(CatResult),
    RawDownload { path: String },
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
    pub size: u64,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsResponse {
    pub files: Vec<LsEntry>,
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
    pub system_uptime: u64,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub username: String,
    pub connected_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorResponse {
    pub error: String,
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
            Command::RawDownload { path } => self.raw_download(path).await,
            Command::Echo { request } => self.echo(request).await,
            Command::AgentInfo => self.agent_info().await,
            Command::GetAgentDetails => self.get_agent_details().await,
        }
    }

    async fn ls(&self, path: Option<String>) -> CommandResult {
        use nix::unistd::{Group, User};
        use std::os::unix::fs::MetadataExt;

        let path = path.unwrap_or_else(|| ".".to_string());

        match tokio::fs::read_dir(&path).await {
            Ok(mut entries) => {
                let mut files = Vec::new();
                while let Some(entry) = entries.next_entry().await.ok().flatten() {
                    let metadata = entry.metadata().await.ok();
                    let name = entry.file_name().into_string().ok();

                    if let (Some(metadata), Some(name)) = (metadata, name) {
                        let is_dir = metadata.is_dir();
                        let file_type = if is_dir { "directory" } else { "file" };
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

                CommandResult::Ls(LsResult { files })
            }
            Err(e) => CommandResult::Error {
                message: format!("Failed to read directory: {}", e),
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

    async fn raw_download(&self, path: String) -> CommandResult {
        CommandResult::RawDownload { path }
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
            connected_at: 0,
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
            CommandResult::Ls(ls_result) => {
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
            _ => panic!("Expected LsResult"),
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
