use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    Ls { path: Option<String> },
    Cat { path: String },
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
#[serde(tag = "type")]
pub enum CommandResult {
    Ls(LsResult),
    Cat(CatResult),
    Error { message: String },
}

pub struct CommandHandler;

impl CommandHandler {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, command: Command) -> CommandResult {
        match command {
            Command::Ls { path } => self.ls(path),
            Command::Cat { path } => self.cat(path),
        }
    }

    fn ls(&self, path: Option<String>) -> CommandResult {
        let path = path.unwrap_or_else(|| ".".to_string());
        let path_obj = Path::new(&path);

        match std::fs::read_dir(path_obj) {
            Ok(entries) => {
                let files: Vec<String> = entries
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| {
                        entry.file_name().into_string().ok().map(|name| {
                            let metadata = entry.metadata().ok();
                            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                            if is_dir { format!("{}/", name) } else { name }
                        })
                    })
                    .collect();

                CommandResult::Ls(LsResult { files })
            }
            Err(e) => CommandResult::Error {
                message: format!("Failed to read directory: {}", e),
            },
        }
    }

    fn cat(&self, path: String) -> CommandResult {
        let path_obj = Path::new(&path);

        match std::fs::read_to_string(path_obj) {
            Ok(content) => CommandResult::Cat(CatResult { content, path }),
            Err(e) => CommandResult::Error {
                message: format!("Failed to read file: {}", e),
            },
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
}
