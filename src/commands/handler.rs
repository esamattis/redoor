#[cfg(not(target_os = "android"))]
use super::MountPoint;
use super::{
    AgentDetailsResponse, AgentId, AgentInfoResult, Command, CommandErrorKind, CommandResult,
    DirectorySizeError, DirectorySizeResponse, EchoRequest, EchoResult, LsDirectoryResult, LsEntry,
    LsFileResult, MoveMetadataResult, MoveSourceIdentity, UnixTimestampSeconds,
    agent_loaded_config_path, current_binary_identity, current_exe_path, external_ip, file_search,
    git, metadata,
};
use crate::atomic_rename::AtomicRenameOutcome;
use crate::logging::Level;
use std::future::Future;
use tokio::sync::watch;

const DIRECT_DELETE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);
const MOVE_SOURCE_QUARANTINE_ATTEMPTS: usize = 16;
const MAX_MOVE_SOURCE_CLEANUPS: usize = 2;
static MOVE_SOURCE_CLEANUP_PERMITS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_MOVE_SOURCE_CLEANUPS);

/// Converts platform metadata into the identity checked before move-source deletion.
fn move_source_identity(metadata: &std::fs::Metadata) -> MoveSourceIdentity {
    use std::os::unix::fs::MetadataExt;

    MoveSourceIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        is_directory: metadata.is_dir(),
    }
}

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
            Command::LocalMove { .. } => CommandResult::error(
                CommandErrorKind::InvalidInput,
                "LocalMove is handled by the agent runtime",
            ),
            Command::RawDelete { path } => self.raw_delete(path).await,
            Command::Trash { .. }
            | Command::ListTrash
            | Command::EmptyTrash
            | Command::RestoreTrash { .. } => CommandResult::error(
                CommandErrorKind::InvalidInput,
                "Trash commands are handled by the agent runtime",
            ),
            Command::CreateDirectory { path } => self.create_directory(path).await,
            Command::RenamePath { dir, old, new } => self.rename_path(dir, old, new).await,
            Command::Metadata { path } => metadata::execute(path).await,
            Command::DirectorySize {
                path,
                timeout_seconds,
            } => self.directory_size(path, timeout_seconds).await,
            Command::GitContext { path } => git::context(path).await,
            Command::GitStatus { path } => git::status(path).await,
            Command::GitDiff { files, mode } => git::diff(files, mode).await,
            Command::MoveMetadata { path } => self.move_metadata(path).await,
            Command::DeleteMoveSource {
                path,
                expected_identity,
            } => self.delete_move_source(path, expected_identity).await,
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

    /// Bounds recursive metadata traversal so one very large tree cannot occupy a command slot indefinitely.
    async fn directory_size(&self, path: String, timeout_seconds: u64) -> CommandResult {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return CommandResult::error(
                    CommandErrorKind::NotADirectory,
                    format!("Path is not a directory: {path}"),
                );
            }
            Err(error) => {
                return CommandResult::io_error(
                    &format!("Failed to read directory metadata for path {path:?}"),
                    error,
                );
            }
        }

        let cancel = tokio::sync::watch::channel(false).1;
        match tokio::time::timeout(
            std::time::Duration::from_secs(timeout_seconds),
            crate::directory_measurement::measure_directory(
                std::path::Path::new(&path),
                false,
                &cancel,
            ),
        )
        .await
        {
            Ok(Ok(Some(measurement))) => CommandResult::DirectorySize(DirectorySizeResponse {
                path,
                size: measurement.content_bytes,
                errors: measurement
                    .errors
                    .into_iter()
                    .map(|error| DirectorySizeError {
                        path: error.path,
                        error: error.error,
                    })
                    .collect(),
            }),
            Ok(Ok(None)) => CommandResult::error(
                CommandErrorKind::ServiceUnavailable,
                "Directory size calculation was canceled",
            ),
            Ok(Err(error)) => CommandResult::error(
                CommandErrorKind::Internal,
                format!("Failed to calculate directory size for {path:?}: {error}"),
            ),
            Err(_) => CommandResult::error(
                CommandErrorKind::ServiceUnavailable,
                format!("Directory size calculation timed out after {timeout_seconds} seconds"),
            ),
        }
    }

    /// Captures the source identity before a move starts so later deletion is conditional.
    async fn move_metadata(&self, path: String) -> CommandResult {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) => CommandResult::MoveMetadata(MoveMetadataResult {
                file_size: metadata.len(),
                is_file: metadata.is_file(),
                is_dir: metadata.is_dir(),
                identity: move_source_identity(&metadata),
            }),
            Err(error) => CommandResult::io_error(
                &format!("Failed to get move source metadata for path {path:?}"),
                error,
            ),
        }
    }

    /// Deletes only the unchanged source object that the move preflight selected.
    async fn delete_move_source(
        &self,
        path: String,
        expected_identity: MoveSourceIdentity,
    ) -> CommandResult {
        self.delete_move_source_with_cleanup(
            path,
            expected_identity,
            &MOVE_SOURCE_CLEANUP_PERMITS,
            |quarantine_path| async move { crate::safe_fs::safe_rm_all(quarantine_path).await },
        )
        .await
    }

    /// Publishes directory removal by quarantine rename before running best-effort cleanup.
    async fn delete_move_source_with_cleanup<C, F>(
        &self,
        path: String,
        expected_identity: MoveSourceIdentity,
        cleanup_permits: &'static tokio::sync::Semaphore,
        cleanup: C,
    ) -> CommandResult
    where
        C: FnOnce(std::path::PathBuf) -> F,
        F: Future<Output = std::io::Result<()>> + Send + 'static,
    {
        let metadata = match tokio::fs::metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                return CommandResult::io_error(
                    &format!("Failed to verify move source path {path:?}"),
                    error,
                );
            }
        };
        if move_source_identity(&metadata) != expected_identity {
            return CommandResult::error(
                CommandErrorKind::InvalidInput,
                "Move source changed while it was being copied; refusing to delete it",
            );
        }
        if !metadata.is_dir() {
            return match tokio::fs::remove_file(&path).await {
                Ok(()) => CommandResult::RawDelete,
                Err(error) => CommandResult::io_error("Failed to delete move source", error),
            };
        }
        if let Err(error) = crate::safe_fs::validate_recursive_remove(&path).await {
            return CommandResult::io_error("Failed to validate move source deletion", error);
        }

        let quarantine_path = match quarantine_move_source(std::path::Path::new(&path)).await {
            Ok(path) => path,
            Err(error) => {
                return CommandResult::io_error("Failed to quarantine move source", error);
            }
        };
        match cleanup_permits.try_acquire() {
            Ok(cleanup_permit) => {
                let cleanup_future = cleanup(quarantine_path.clone());
                spawn_move_source_cleanup(quarantine_path, cleanup_permit, cleanup_future);
            }
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                crate::log!(
                    Level::Warning,
                    "Move source quarantine cleanup capacity exhausted; leaving path for later recovery: {}",
                    quarantine_path.display()
                );
            }
            Err(tokio::sync::TryAcquireError::Closed) => {
                crate::log!(
                    Level::Error,
                    "Move source quarantine cleanup unavailable; leaving path for later recovery: {}",
                    quarantine_path.display()
                );
            }
        }
        CommandResult::RawDelete
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

    /// Keeps direct REST-backed deletion within its short control-command deadline.
    async fn raw_delete(&self, path: String) -> CommandResult {
        match tokio::fs::metadata(&path).await {
            Ok(metadata) => {
                let delete_result = if metadata.is_dir() {
                    match tokio::time::timeout(
                        DIRECT_DELETE_TIMEOUT,
                        crate::safe_fs::safe_rm_all(&path),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            format!(
                                "recursive deletion exceeded {} seconds and may be partial",
                                DIRECT_DELETE_TIMEOUT.as_secs()
                            ),
                        )),
                    }
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
        #[cfg(not(target_os = "android"))]
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
        #[cfg(target_os = "android")]
        // The mountpoints crate has no Android backend, so capacity is unavailable on this target.
        let mut mount_points: Vec<super::MountPoint> = Vec::new();
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

/// Atomically hides a directory under an exclusive sibling name without replacing another entry.
async fn quarantine_move_source(source: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let parent = source.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("move source has no parent directory: {}", source.display()),
        )
    })?;
    if source.file_name().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("move source has no file name: {}", source.display()),
        ));
    }

    for _ in 0..MOVE_SOURCE_QUARANTINE_ATTEMPTS {
        let quarantine_name = format!(".redoor-move-{}", uuid::Uuid::new_v4().simple());
        let quarantine_path = parent.join(quarantine_name);
        match crate::atomic_rename::rename_no_replace(source, &quarantine_path).await? {
            AtomicRenameOutcome::Renamed => return Ok(quarantine_path),
            AtomicRenameOutcome::DestinationExists => continue,
            AtomicRenameOutcome::Missing => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!(
                        "move source disappeared before quarantine: {}",
                        source.display()
                    ),
                ));
            }
            AtomicRenameOutcome::CrossDevice => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::CrossesDevices,
                    "move source quarantine unexpectedly crossed filesystems",
                ));
            }
            AtomicRenameOutcome::Unsupported => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "atomic no-replace move source quarantine is unsupported",
                ));
            }
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "failed to reserve a unique move source quarantine path",
    ))
}

/// Runs best-effort quarantine deletion under a permit so detached cleanup remains bounded.
fn spawn_move_source_cleanup<F>(
    quarantine_path: std::path::PathBuf,
    cleanup_permit: tokio::sync::SemaphorePermit<'static>,
    cleanup: F,
) where
    F: Future<Output = std::io::Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let _cleanup_permit = cleanup_permit;
        if let Err(error) = cleanup.await {
            crate::log!(
                Level::Error,
                "Failed to clean quarantined move source: path={}, error={}",
                quarantine_path.display(),
                error
            );
        }
    });
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
    use crate::test_support::TempDir;

    /// Verifies a directory disappears from its source name before quarantine cleanup completes.
    #[tokio::test]
    async fn directory_move_source_is_published_deleted_before_cleanup() {
        static CLEANUP_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        let temp = TempDir::create();
        let path = temp.path().join("directory-move-source");
        tokio::fs::create_dir(&path)
            .await
            .expect("move source directory should be created");
        tokio::fs::write(path.join("child"), "copied")
            .await
            .expect("move source child should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let (finished_sender, finished_receiver) = tokio::sync::oneshot::channel();

        let result = CommandHandler::new()
            .delete_move_source_with_cleanup(
                path.display().to_string(),
                move_source_identity(&metadata),
                &CLEANUP_PERMITS,
                move |quarantine_path| async move {
                    started_sender
                        .send(quarantine_path.clone())
                        .expect("cleanup should report its quarantine path");
                    release_receiver
                        .await
                        .expect("test should release quarantine cleanup");
                    crate::safe_fs::safe_rm_all(&quarantine_path).await?;
                    finished_sender
                        .send(())
                        .expect("cleanup should report completion");
                    Ok(())
                },
            )
            .await;
        let quarantine_path = started_receiver
            .await
            .expect("quarantine cleanup should start");

        // The router must receive success without waiting for recursive cleanup.
        assert!(
            matches!(result, CommandResult::RawDelete),
            "directory quarantine should preserve the move deletion response"
        );
        // Atomic quarantine publication removes the user-visible source name first.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "original directory source should disappear before cleanup completes"
        );
        // The blocked cleanup must still own the complete tree under its unique sibling name.
        assert!(
            tokio::fs::try_exists(quarantine_path.join("child"))
                .await
                .expect("quarantine existence check should succeed"),
            "quarantine should retain source contents until cleanup resumes"
        );
        // A sibling quarantine guarantees rename publication cannot cross filesystems.
        assert_eq!(
            quarantine_path.parent(),
            path.parent(),
            "quarantine should share the source parent directory"
        );
        release_sender
            .send(())
            .expect("cleanup should remain blocked after command success");
        finished_receiver
            .await
            .expect("quarantine cleanup should finish after release");
        // Successful best-effort cleanup should remove the hidden quarantine tree.
        assert!(
            !tokio::fs::try_exists(&quarantine_path)
                .await
                .expect("cleaned quarantine existence check should succeed"),
            "completed cleanup should remove the quarantine path"
        );
    }

    /// Verifies a timed-out quarantine cleanup cannot change the published command success.
    #[tokio::test]
    async fn directory_move_source_cleanup_timeout_does_not_fail_the_move() {
        static CLEANUP_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        crate::logging::init(None)
            .await
            .expect("test logger should initialize");
        let temp = TempDir::create();
        let path = temp.path().join("timeout-move-source");
        tokio::fs::create_dir(&path)
            .await
            .expect("move source directory should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let (failed_sender, failed_receiver) = tokio::sync::oneshot::channel();

        let result = CommandHandler::new()
            .delete_move_source_with_cleanup(
                path.display().to_string(),
                move_source_identity(&metadata),
                &CLEANUP_PERMITS,
                move |quarantine_path| async move {
                    failed_sender
                        .send(quarantine_path)
                        .expect("cleanup should report the failed quarantine path");
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "simulated bounded cleanup timeout",
                    ))
                },
            )
            .await;
        let quarantine_path = failed_receiver
            .await
            .expect("timed-out cleanup should complete independently");

        // Cleanup timeout occurs after publication and therefore cannot fail the logical move.
        assert!(
            matches!(result, CommandResult::RawDelete),
            "cleanup timeout should not alter the successful command response"
        );
        // The original source remains absent even when best-effort cleanup leaves quarantine behind.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "cleanup timeout must not restore the original source name"
        );
        // A failed cleanup leaves only the hidden owned path for later operator recovery.
        assert!(
            tokio::fs::try_exists(&quarantine_path)
                .await
                .expect("quarantine existence check should succeed"),
            "timed-out cleanup should leave the quarantined tree intact"
        );
        crate::safe_fs::safe_rm_all(quarantine_path)
            .await
            .expect("test should remove the failed quarantine fixture");
    }

    /// Verifies saturated cleanup capacity neither blocks success nor constructs cleanup work.
    #[tokio::test]
    async fn directory_move_source_succeeds_when_cleanup_capacity_is_saturated() {
        static SATURATED_CLEANUP_PERMITS: tokio::sync::Semaphore =
            tokio::sync::Semaphore::const_new(0);

        crate::logging::init(None)
            .await
            .expect("test logger should initialize");
        let temp = TempDir::create();
        let path = temp.path().join("saturated-move-source");
        tokio::fs::create_dir(&path)
            .await
            .expect("move source directory should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let cleanup_created = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cleanup_created_for_factory = cleanup_created.clone();

        let result = CommandHandler::new()
            .delete_move_source_with_cleanup(
                path.display().to_string(),
                move_source_identity(&metadata),
                &SATURATED_CLEANUP_PERMITS,
                move |_quarantine_path| {
                    cleanup_created_for_factory.store(true, std::sync::atomic::Ordering::SeqCst);
                    async { Ok(()) }
                },
            )
            .await;

        // Capacity exhaustion happens after publication and cannot delay or fail the move.
        assert!(
            matches!(result, CommandResult::RawDelete),
            "saturated cleanup admission should retain move success"
        );
        // Nonblocking admission must not create cleanup work that would wait for a permit.
        assert!(
            !cleanup_created.load(std::sync::atomic::Ordering::SeqCst),
            "cleanup factory should not run without available capacity"
        );
        // The original source name must remain published as deleted despite deferred recovery.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "saturated cleanup should leave the original source absent"
        );

        let mut entries = tokio::fs::read_dir(temp.path())
            .await
            .expect("test parent should remain readable");
        let quarantine_path = entries
            .next_entry()
            .await
            .expect("quarantine listing should succeed")
            .expect("saturated cleanup should leave one quarantine path")
            .path();
        // Capacity exhaustion leaves only a recognizable owned path for later recovery.
        assert!(
            quarantine_path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".redoor-move-")),
            "leftover quarantine should use the owned fixed prefix"
        );
        crate::safe_fs::safe_rm_all(quarantine_path)
            .await
            .expect("test should remove the deferred quarantine fixture");
    }

    /// Verifies quarantine publication remains valid for a maximum-length source component.
    #[tokio::test]
    async fn directory_move_source_with_maximum_length_name_uses_a_short_quarantine() {
        static CLEANUP_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

        let temp = TempDir::create();
        let path = temp.path().join("s".repeat(255));
        tokio::fs::create_dir(&path)
            .await
            .expect("filesystem should accept a 255-byte source name");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let (finished_sender, finished_receiver) = tokio::sync::oneshot::channel();

        let result = CommandHandler::new()
            .delete_move_source_with_cleanup(
                path.display().to_string(),
                move_source_identity(&metadata),
                &CLEANUP_PERMITS,
                move |quarantine_path| async move {
                    started_sender
                        .send(quarantine_path.clone())
                        .expect("cleanup should report its short quarantine path");
                    release_receiver
                        .await
                        .expect("test should release quarantine cleanup");
                    crate::safe_fs::safe_rm_all(quarantine_path).await?;
                    finished_sender
                        .send(())
                        .expect("cleanup should report completion");
                    Ok(())
                },
            )
            .await;
        let quarantine_path = started_receiver
            .await
            .expect("maximum-name quarantine cleanup should start");

        // A source at NAME_MAX must still publish successfully under an independent short name.
        assert!(
            matches!(result, CommandResult::RawDelete),
            "maximum-length source should quarantine successfully"
        );
        let quarantine_name = quarantine_path
            .file_name()
            .expect("quarantine should have a file name")
            .to_string_lossy();
        // Fixed-prefix UUID naming stays well below common supported filesystem component limits.
        assert!(
            quarantine_name.starts_with(".redoor-move-") && quarantine_name.len() < 255,
            "quarantine name should not inherit the source component length"
        );
        // Successful quarantine removes the maximum-length original source pathname immediately.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "maximum-length source should disappear before cleanup"
        );
        release_sender
            .send(())
            .expect("cleanup should remain blocked until assertions finish");
        finished_receiver
            .await
            .expect("maximum-name quarantine cleanup should finish");
    }

    /// Verifies conditional cleanup retains the RawDelete response consumed by the move router.
    #[tokio::test]
    async fn move_source_deletion_returns_the_compatible_response() {
        let temp = TempDir::create();
        let path = temp.path().join("completed-move-source");
        tokio::fs::write(&path, "published at destination")
            .await
            .expect("move source should be created");
        let metadata = tokio::fs::metadata(&path)
            .await
            .expect("move source metadata should be readable");

        let result = CommandHandler::new()
            .execute(Command::DeleteMoveSource {
                path: path.display().to_string(),
                expected_identity: move_source_identity(&metadata),
            })
            .await;

        // The router completes source-deletion state only for the established RawDelete result.
        assert!(
            matches!(result, CommandResult::RawDelete),
            "move source deletion should preserve its wire response"
        );
        // A successful response must mean the identity-verified source pathname is gone.
        assert!(
            !tokio::fs::try_exists(&path)
                .await
                .expect("source existence check should succeed"),
            "move source should be deleted before success is returned"
        );
    }

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

    #[tokio::test]
    async fn move_source_deletion_refuses_a_replacement_path() {
        let temp = TempDir::create();
        let path = temp.path().join("move-identity");
        tokio::fs::write(&path, "original")
            .await
            .expect("original source should be created");
        let original = tokio::fs::metadata(&path)
            .await
            .expect("original metadata should be readable");
        let expected_identity = move_source_identity(&original);
        let original_path = path.with_extension("original");
        tokio::fs::rename(&path, &original_path)
            .await
            .expect("original source should move away from its pathname");
        tokio::fs::write(&path, "replacement")
            .await
            .expect("replacement source should be created");

        let result = CommandHandler::new()
            .execute(Command::DeleteMoveSource {
                path: path.display().to_string(),
                expected_identity,
            })
            .await;

        // A completed destination copy must not authorize deletion of a new object at the old path.
        assert!(
            matches!(
                result,
                CommandResult::Error {
                    kind: CommandErrorKind::InvalidInput,
                    ..
                }
            ),
            "conditional move deletion should reject a replacement source"
        );
        assert_eq!(
            tokio::fs::read_to_string(&path)
                .await
                .expect("replacement source should remain readable"),
            "replacement",
            "identity mismatch must preserve the replacement source"
        );
    }
}
