use serde_json::json;
use std::path::Path;

pub struct CommandHandler;

impl CommandHandler {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, command: &str, args: &[String]) -> serde_json::Value {
        match command {
            "ls" => self.ls(args),
            _ => json!({ "error": format!("Unknown command: {}", command) }),
        }
    }

    fn ls(&self, args: &[String]) -> serde_json::Value {
        let path = args.first().map(|s| s.as_str()).unwrap_or(".");

        let path_obj = Path::new(path);

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

                json!({ "files": files })
            }
            Err(e) => json!({ "error": format!("Failed to read directory: {}", e) }),
        }
    }
}
