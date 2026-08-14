use super::{
    AgentDetailsResponse, AgentId, AgentInfoResult, CatResult, Command, CommandErrorKind,
    CommandResult, EchoRequest, EchoResult, LsDirectoryResult, LsEntry, LsFileResult, MountPoint,
    UnixTimestampSeconds, agent_loaded_config_path, current_binary_identity, current_exe_path,
    external_ip, file_search, metadata,
};
use tokio::sync::watch;

/// Executes agent-local commands while protocol models remain transport-owned.
pub struct CommandHandler;

impl Default for CommandHandler {
    /// Keeps default construction equivalent to explicit handler construction.
    fn default() -> Self {
        Self::new()
    }
}

impl CommandHandler {
    /// Creates the stateless command dispatcher used by agent runtimes.
    pub fn new() -> Self {
        Self
    }

    /// Routes a wire command to its agent-local implementation or runtime marker.
    pub async fn execute(&self, command: Command) -> CommandResult {
        match command {
            Command::Ls { path } => self.ls(path).await,
            Command::FileSearch {
                path,
                query,
                timeout_seconds,
                include_hidden,
                respect_gitignore,
            } => {
                file_search::execute(
                    path,
                    query,
                    timeout_seconds,
                    include_hidden,
                    respect_gitignore,
                )
                .await
            }
            Command::Cat { path } => self.cat(path).await,
            Command::RawDownload {
                path,
                range_start,
                range_end,
            } => self.raw_download(path, range_start, range_end).await,
            Command::TarDownload { path, .. } => self.tar_download(path).await,
            Command::RawUpload { path, .. } => self.raw_upload(path).await,
            Command::TarUpload { path, .. } => self.tar_upload(path).await,
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
            Command::RenamePath { dir, old, new } => self.rename_path(dir, old, new).await,
            Command::Metadata { path } => metadata::execute(path).await,
            Command::OpenPath { .. } => CommandResult::error(
                CommandErrorKind::InvalidInput,
                "OpenPath is handled by the agent runtime",
            ),
            Command::Echo { request } => self.echo(request).await,
            Command::AgentInfo => self.agent_info().await,
            Command::GetAgentDetails => self.get_agent_details().await,
            Command::Restart => CommandResult::Restart,
            Command::SelfExec { path } => {
                if std::path::Path::new(&path).is_absolute() {
                    CommandResult::SelfExec { path }
                } else {
                    CommandResult::error(
                        CommandErrorKind::InvalidInput,
                        "Self-exec path must be absolute",
                    )
                }
            }
        }
    }

    /// Runs recursive search with the agent runtime's per-connection supersession signal.
    pub async fn execute_file_search(
        &self,
        path: String,
        query: String,
        timeout_seconds: u64,
        include_hidden: bool,
        respect_gitignore: bool,
        cancel_receiver: watch::Receiver<bool>,
    ) -> CommandResult {
        file_search::execute_with_cancellation(
            path,
            query,
            timeout_seconds,
            include_hidden,
            respect_gitignore,
            cancel_receiver,
        )
        .await
    }

    /// Returns directory entries or file metadata from the requested path.
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
                                    let modified_at =
                                        UnixTimestampSeconds::new(entry_metadata.mtime());

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
                                        modified_at,
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
                        Err(error) => CommandResult::io_error(
                            &format!("Failed to read directory {path:?}"),
                            error,
                        ),
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
            Err(error) => {
                CommandResult::io_error(&format!("Failed to get metadata for path {path:?}"), error)
            }
        }
    }

    /// Reads text content for commands whose transport expects a complete string.
    async fn cat(&self, path: String) -> CommandResult {
        match tokio::fs::read_to_string(&path).await {
            Ok(content) => CommandResult::Cat(CatResult { content, path }),
            Err(error) => CommandResult::io_error("Failed to read file", error),
        }
    }

    /// Marks a raw download for the streaming agent runtime to fulfill.
    async fn raw_download(
        &self,
        path: String,
        _range_start: Option<u64>,
        _range_end: Option<u64>,
    ) -> CommandResult {
        CommandResult::RawDownload { path }
    }

    /// Marks a tar download for the streaming agent runtime to fulfill.
    async fn tar_download(&self, path: String) -> CommandResult {
        CommandResult::TarDownload { path }
    }

    /// Marks a raw upload for the streaming agent runtime to fulfill.
    async fn raw_upload(&self, _path: String) -> CommandResult {
        CommandResult::RawUpload
    }

    /// Marks a tar upload for the streaming agent runtime to fulfill.
    async fn tar_upload(&self, _path: String) -> CommandResult {
        CommandResult::TarUpload
    }

    /// Removes files or directory trees according to the target metadata.
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

    /// Creates all missing path components for remote directory workflows.
    async fn create_directory(&self, path: String) -> CommandResult {
        match tokio::fs::create_dir_all(&path).await {
            Ok(()) => CommandResult::CreateDirectory,
            Err(error) => CommandResult::io_error("Failed to create directory", error),
        }
    }

    /// Derives both paths from one directory so rename cannot become a cross-directory move.
    async fn rename_path(&self, dir: String, old: String, new: String) -> CommandResult {
        let directory = std::path::Path::new(&dir);
        if !directory.is_absolute() {
            return CommandResult::error(
                CommandErrorKind::InvalidInput,
                "Rename directory must be absolute",
            );
        }
        if !is_filename(&old) || !is_filename(&new) {
            return CommandResult::error(
                CommandErrorKind::InvalidInput,
                "Rename names must each be a single filename",
            );
        }

        let source_path = directory.join(old);
        let dest_path = directory.join(new);
        match tokio::fs::rename(&source_path, &dest_path).await {
            Ok(()) => CommandResult::RenamePath,
            Err(error) => CommandResult::io_error("Failed to rename path", error),
        }
    }

    /// Echoes request content after the optional test-only randomized delay.
    async fn echo(&self, request: EchoRequest) -> CommandResult {
        if request.random_sleep {
            let sleep_ms = fastrand::u64(10..500);
            tokio::time::sleep(tokio::time::Duration::from_millis(sleep_ms)).await;
        }
        CommandResult::Echo(EchoResult {
            message: request.message,
        })
    }

    /// Reports lightweight process and host load information to legacy callers.
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

    /// Collects process identity and host details used by the connected-agent view.
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
        // Mount discovery uses platform blocking APIs, so keep it off the command runtime thread.
        let mut mount_points = match tokio::task::spawn_blocking(mountpoints::mountinfos).await {
            Ok(Ok(mount_infos)) => mount_infos
                .into_iter()
                .map(|mount_info| MountPoint {
                    path: mount_info.path.to_string_lossy().into_owned(),
                    available_bytes: mount_info.avail,
                    total_bytes: mount_info.size,
                    mount_type: mount_info.format,
                })
                .filter(MountPoint::is_visible)
                .collect::<Vec<_>>(),
            Ok(Err(error)) => {
                return CommandResult::error(
                    CommandErrorKind::Internal,
                    format!("Failed to list mount points: {error:?}"),
                );
            }
            Err(error) => {
                return CommandResult::error(
                    CommandErrorKind::Internal,
                    format!("Mount point task failed: {error}"),
                );
            }
        };
        mount_points.sort_by(|left, right| left.path.cmp(&right.path));

        CommandResult::GetAgentDetails(Box::new(AgentDetailsResponse {
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
            mount_points,
        }))
    }
}

/// Rejects path syntax so a rename name cannot escape or change its directory.
fn is_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && name != "."
        && name != ".."
        && std::path::Path::new(name)
            .file_name()
            .is_some_and(|part| part == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transfer_commands_remain_runtime_markers() {
        let handler = CommandHandler::new();

        let result = handler
            .execute(Command::RawDownload {
                path: "test.txt".to_string(),
                range_start: None,
                range_end: None,
            })
            .await;

        // The handler must leave streamed transfer execution to the responsive agent runtime.
        assert!(
            matches!(result, CommandResult::RawDownload { path } if path == "test.txt"),
            "raw downloads should return their runtime marker"
        );
    }

    #[tokio::test]
    async fn self_exec_rejects_relative_paths() {
        let handler = CommandHandler::new();

        let result = handler
            .execute(Command::SelfExec {
                path: "relative-agent".to_string(),
            })
            .await;

        // A relative replacement path could resolve differently after an agent restart.
        assert!(
            matches!(
                result,
                CommandResult::Error {
                    kind: CommandErrorKind::InvalidInput,
                    ..
                }
            ),
            "self-exec should require an absolute path"
        );
    }
}
