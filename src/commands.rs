use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ls { path: Option<String> },
    Cat { path: String },
    Echo { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LsResult {
    pub files: Vec<String>,
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
#[serde(tag = "type")]
pub enum CommandResult {
    Ls(LsResult),
    Cat(CatResult),
    Echo(EchoResult),
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
pub struct LsResponse {
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CatResponse {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EchoResponse {
    pub message: String,
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
            Command::Echo { message } => self.echo(message).await,
        }
    }

    async fn ls(&self, path: Option<String>) -> CommandResult {
        let path = path.unwrap_or_else(|| ".".to_string());

        match tokio::fs::read_dir(&path).await {
            Ok(mut entries) => {
                let mut files = Vec::new();
                while let Some(entry) = entries.next_entry().await.ok().flatten() {
                    let metadata = entry.metadata().await.ok();
                    let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                    let name = entry.file_name().into_string().ok();
                    if let Some(name) = name {
                        if is_dir {
                            files.push(format!("{}/", name));
                        } else {
                            files.push(name);
                        }
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

    async fn echo(&self, message: String) -> CommandResult {
        CommandResult::Echo(EchoResult { message })
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
                assert!(!ls_result.files.is_empty());
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
    async fn test_echo_command() {
        let handler = CommandHandler::new();
        let result = handler
            .execute(Command::Echo {
                message: "hello world".to_string(),
            })
            .await;

        match result {
            CommandResult::Echo(echo_result) => {
                assert_eq!(echo_result.message, "hello world");
            }
            _ => panic!("Expected EchoResult"),
        }
    }
}
