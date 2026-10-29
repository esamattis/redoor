//! Agent-side command implementations, grouped by domain, behind one dispatch table.
//!
//! [`RunCommand`] is the only place that maps a wire command to its implementation; the runtime
//! dispatcher handles admission, cancellation, logging and the response around it.

pub(crate) mod content_grep;
pub(crate) mod ctx;
pub(crate) mod file_search;
mod fs;
pub(crate) mod git;
mod host;
mod metadata;

use crate::transfers::{
    download, edit::EditSession, raw_upload::RawFileSink, tar_upload::TarDirectorySink,
    upload::UploadDriver,
};
use ctx::{CommandCtx, Reply};
use redoor_protocol::wire::{
    command::Command,
    policy::UploadKind,
    request::{self, AgentRequest},
};
use std::future::Future;

/// Executes one wire command with its dispatcher-provided context.
pub(crate) trait RunCommand {
    /// Runs the command to completion and reports how its outcome is delivered.
    fn run(self, ctx: CommandCtx) -> impl Future<Output = Reply> + Send;
}

impl RunCommand for Command {
    /// The single exhaustive mapping from wire commands to their domain implementations.
    ///
    /// Each arm answers through `Reply::of::<R>` (or `Reply::stream::<R>`) for its own request
    /// type `R`, so the compiler checks that a command can only return its own response.
    async fn run(self, ctx: CommandCtx) -> Reply {
        match self {
            Command::ListPartials(_) => Reply::of::<request::ListPartials>(
                crate::transfers::partials::list(
                    &ctx.services.partial_store,
                    &ctx.services.destination_locks,
                )
                .await,
            ),
            Command::ProbePartial(request) => {
                let key = redoor_core::partials::PartialStore::key(&request.dest_path);
                let result = if ctx.services.destination_locks.contains(&request.dest_path) {
                    Ok(None)
                } else {
                    ctx.services
                        .partial_store
                        .probe(&key)
                        .await
                        .map_err(|error| request::CommandError::io("Probe partial", error))
                };
                Reply::of::<request::ProbePartial>(result)
            }
            Command::ReadPartial(request) => {
                let result = ctx
                    .services
                    .partial_store
                    .probe(&request.key)
                    .await
                    .map(|record| {
                        record.filter(|record| {
                            !ctx.services
                                .destination_locks
                                .contains(&record.manifest.signed.authorization.dest_path)
                        })
                    })
                    .map_err(|error| request::CommandError::io("Read partial", error));
                Reply::of::<request::ReadPartial>(result)
            }
            Command::DeletePartial(request) => {
                let result = async {
                    if let Some(record) = ctx
                        .services
                        .partial_store
                        .probe(&request.key)
                        .await
                        .map_err(|error| request::CommandError::io("Read partial", error))?
                    {
                        let _guard = ctx
                            .services
                            .destination_locks
                            .acquire(&record.manifest.signed.authorization.dest_path)
                            .map_err(|error| request::CommandError::io("Discard partial", error))?;
                        ctx.services
                            .partial_store
                            .discard(&request.key)
                            .await
                            .map_err(|error| request::CommandError::io("Discard partial", error))?;
                    } else {
                        // Invalid or missing output must still release its stale metadata.
                        ctx.services
                            .partial_store
                            .forget(&request.key)
                            .await
                            .map_err(|error| {
                                request::CommandError::io("Discard manifest", error)
                            })?;
                    }
                    Ok(())
                }
                .await;
                Reply::of::<request::DeletePartial>(result)
            }
            Command::PersistPartial(request) => {
                let result = async {
                    let mut manifest = ctx
                        .services
                        .partial_store
                        .read(&request.key)
                        .await
                        .map_err(|error| request::CommandError::io("Read partial", error))?;
                    let _guard = ctx
                        .services
                        .destination_locks
                        .acquire(&manifest.signed.authorization.dest_path)
                        .map_err(|error| request::CommandError::io("Persist partial", error))?;
                    if let Some(signed) = request.signed {
                        let saved = &manifest.signed.authorization;
                        let current = &signed.authorization;
                        if saved.dest_agent_id != current.dest_agent_id
                            || saved.dest_path != current.dest_path
                            || saved.source_agent_id != current.source_agent_id
                            || saved.source_path != current.source_path
                            || saved.source_identity != current.source_identity
                        {
                            return Err(request::CommandError::new(
                                redoor_protocol::wire::command::CommandErrorKind::InvalidInput,
                                "Partial changed during verification",
                            ));
                        }
                        manifest.signed = *signed;
                        ctx.services
                            .partial_store
                            .write(&manifest)
                            .await
                            .map_err(|error| {
                                request::CommandError::io("Save partial authorization", error)
                            })?;
                    }
                    ctx.services
                        .partial_store
                        .persist(&request.key)
                        .await
                        .map_err(|error| request::CommandError::io("Persist partial", error))
                }
                .await;
                Reply::of::<request::PersistPartial>(result)
            }
            Command::HashSegments(request) => Reply::of::<request::HashSegments>(
                crate::transfers::partials::hash(
                    request,
                    &ctx.services.partial_store,
                    &ctx.services.destination_locks,
                    &ctx.cancel,
                )
                .await,
            ),

            Command::Exec(request::Exec { request: exec }) => match ctx.into_output() {
                Ok(output) => crate::exec::run(exec, output.stream, output.registration).await,
                Err(error) => Reply::failure(error),
            },
            Command::Ls(request::Ls { path }) => Reply::of::<request::Ls>(fs::ls(path).await),
            Command::FileSearch(request::FileSearch {
                path,
                query,
                timeout_seconds,
                include_hidden,
                respect_gitignore,
                case_sensitivity,
                directories_only,
            }) => Reply::of::<request::FileSearch>(
                file_search::execute(
                    file_search::FileSearchRequest {
                        path,
                        query,
                        timeout_seconds,
                        include_hidden,
                        respect_gitignore,
                        case_sensitivity,
                        directories_only,
                    },
                    &ctx.cancel,
                )
                .await,
            ),
            Command::ContentGrep(request::ContentGrep {
                path,
                query,
                timeout_seconds,
                include_hidden,
                respect_gitignore,
                fixed_string,
                case_sensitivity,
                before_context,
                after_context,
            }) => Reply::of::<request::ContentGrep>(
                content_grep::execute(
                    content_grep::ContentGrepRequest {
                        path,
                        query,
                        timeout_seconds,
                        include_hidden,
                        respect_gitignore,
                        fixed_string,
                        case_sensitivity,
                        before_context,
                        after_context,
                    },
                    &ctx.cancel,
                    ctx.services.grep_slots.clone(),
                )
                .await,
            ),
            Command::RawDownload(request::RawDownload {
                expected_identity,
                path,
                range_start,
                range_end,
            }) => {
                download::download_file(path, range_start, range_end, expected_identity, ctx).await
            }
            Command::TarDownload(request::TarDownload { path, include_root }) => {
                download::download_directory(path, include_root, ctx).await
            }
            Command::RawUpload(request::RawUpload {
                partial,
                path,
                on_existing,
                ownership,
                executable,
            }) => {
                let prepared = RawFileSink::prepare(
                    ctx.responder.request_id(),
                    path.clone(),
                    on_existing,
                    ownership,
                    partial,
                    executable,
                    &ctx.services,
                )
                .await
                .map(|sink| {
                    sink.with_reason(
                        ctx.registration
                            .as_ref()
                            .map(|registration| registration.reason_cell()),
                    )
                });
                Reply::of::<request::RawUpload>(
                    UploadDriver::new(UploadKind::RawUpload, path, ctx)
                        .run(prepared)
                        .await,
                )
            }
            Command::EditFile(request::EditFile { path }) => {
                let prepared = EditSession::open(ctx.responder.request_id(), path.clone()).await;
                Reply::of::<request::EditFile>(
                    UploadDriver::new(UploadKind::EditFile, path, ctx)
                        .run(prepared)
                        .await,
                )
            }
            Command::TarUpload(request::TarUpload { path, on_existing }) => {
                let prepared = TarDirectorySink::prepare(
                    ctx.responder.request_id(),
                    path.clone(),
                    on_existing,
                )
                .await;
                Reply::of::<request::TarUpload>(
                    UploadDriver::new(UploadKind::TarUpload, path, ctx)
                        .run(prepared)
                        .await,
                )
            }
            Command::LocalCopyFile(request::LocalCopyFile {
                partial,
                source_path,
                dest_path,
                on_existing,
            }) => {
                let mut context = ctx.copy_context();
                context.partial = partial.as_deref();
                Reply::of::<request::LocalCopyFile>(
                    context
                        .copy_command(source_path, dest_path, on_existing, false)
                        .await,
                )
            }
            Command::LocalCopyDirectory(request::LocalCopyDirectory {
                source_path,
                dest_path,
                on_existing,
            }) => Reply::of::<request::LocalCopyDirectory>(
                ctx.copy_context()
                    .copy_command(source_path, dest_path, on_existing, true)
                    .await,
            ),
            Command::LocalMove(request::LocalMove {
                partial,
                source_path,
                dest_path,
                source_is_directory,
                expected_identity,
                on_existing,
            }) => {
                let mut context = ctx.copy_context();
                context.partial = partial.as_deref();
                Reply::of::<request::LocalMove>(
                    context
                        .move_command(
                            source_path,
                            dest_path,
                            source_is_directory,
                            expected_identity,
                            on_existing,
                        )
                        .await,
                )
            }
            Command::RawDelete(request::RawDelete { path }) => {
                Reply::of::<request::RawDelete>(fs::raw_delete(path).await)
            }
            Command::Trash(request::Trash { path }) => {
                Reply::of::<request::Trash>(ctx.services.trash.move_to_trash(path).await)
            }
            Command::ListTrash(_) => {
                Reply::of::<request::ListTrash>(ctx.services.trash.list().await)
            }
            Command::EmptyTrash(_) => {
                Reply::of::<request::EmptyTrash>(ctx.services.trash.empty().await)
            }
            Command::RestoreTrash(request::RestoreTrash {
                location_id,
                item_id,
                destination_path,
            }) => Reply::of::<request::RestoreTrash>(
                ctx.services
                    .trash
                    .restore(&location_id, &item_id, destination_path, ctx.copy_context())
                    .await,
            ),
            Command::CreateDirectory(request::CreateDirectory { path, ownership }) => {
                Reply::of::<request::CreateDirectory>(fs::create_directory(path, ownership).await)
            }
            Command::RenamePath(request::RenamePath { dir, old, new }) => {
                Reply::of::<request::RenamePath>(fs::rename_path(dir, old, new).await)
            }
            Command::ChownPath(request::ChownPath { path, owner, group }) => {
                Reply::of::<request::ChownPath>(fs::chown_path(path, owner, group).await)
            }
            Command::ChmodPath(request::ChmodPath { path, permissions }) => {
                Reply::of::<request::ChmodPath>(fs::chmod_path(path, permissions).await)
            }
            Command::ListAccounts(_) => {
                Reply::of::<request::ListAccounts>(host::list_accounts().await)
            }
            Command::Metadata(request::Metadata { path }) => {
                Reply::of::<request::Metadata>(metadata::execute(path).await)
            }
            Command::DirectorySize(request::DirectorySize {
                path,
                timeout_seconds,
            }) => Reply::of::<request::DirectorySize>(
                fs::directory_size(path, timeout_seconds, &ctx.cancel).await,
            ),
            Command::GitContext(request::GitContext { path }) => {
                Reply::of::<request::GitContext>(git::status::context(path).await)
            }
            Command::GitStatus(request::GitStatus { path }) => {
                Reply::of::<request::GitStatus>(git::status::status(path).await)
            }
            Command::GitDiff(request::GitDiff { files, mode }) => {
                Reply::of::<request::GitDiff>(git::diff::diff(files, mode).await)
            }
            Command::GitRevisionTree(request::GitRevisionTree { path, rev }) => {
                Reply::of::<request::GitRevisionTree>(git::tree::tree(path, rev).await)
            }
            Command::GitRevisionContent(request::GitRevisionContent { path, rev }) => {
                Reply::of::<request::GitRevisionContent>(git::tree::content(path, rev).await)
            }
            Command::GitCommitDiff(request::GitCommitDiff { path, rev }) => {
                Reply::of::<request::GitCommitDiff>(git::commit_diff::commit_diff(path, rev).await)
            }
            Command::GitLog(request::GitLog { path, rev, page }) => {
                Reply::of::<request::GitLog>(git::history::log(path, rev, page).await)
            }
            Command::GitCommitNeighbors(request::GitCommitNeighbors { path, rev }) => {
                Reply::of::<request::GitCommitNeighbors>(git::history::neighbors(path, rev).await)
            }
            Command::GitRefList(request::GitRefList {
                path,
                kind,
                sort,
                page,
            }) => Reply::of::<request::GitRefList>(git::refs::list(path, kind, sort, page).await),
            Command::GitWorktreeList(request::GitWorktreeList { path }) => {
                Reply::of::<request::GitWorktreeList>(git::worktree_list::list(path).await)
            }
            Command::GitWorktreeStatus(request::GitWorktreeStatus { paths }) => {
                Reply::of::<request::GitWorktreeStatus>(git::worktree_status::statuses(paths).await)
            }
            Command::GitRevisionStat(request::GitRevisionStat {
                path,
                rev,
                replace_target,
            }) => Reply::of::<request::GitRevisionStat>(
                git::export::stat(path, rev, replace_target).await,
            ),
            Command::GitDownload(request::GitDownload {
                path,
                rev,
                include_root,
            }) => download::download_git_revision(path, rev, include_root, ctx).await,
            Command::MoveMetadata(request::MoveMetadata { path }) => {
                Reply::of::<request::MoveMetadata>(fs::move_metadata(path).await)
            }
            Command::DeleteMoveSource(request::DeleteMoveSource {
                path,
                expected_identity,
            }) => Reply::of::<request::DeleteMoveSource>(
                fs::delete_move_source(path, expected_identity).await,
            ),
            Command::OpenPath(request::OpenPath { path }) => {
                Reply::of::<request::OpenPath>(host::open_path(path).await)
            }
            Command::Echo(request::Echo { request: echo }) => {
                Reply::of::<request::Echo>(host::echo(echo).await)
            }
            Command::GetAgentDetails(_) => Reply::of::<request::GetAgentDetails>(
                host::get_agent_details(&ctx.services.loaded_config_path).await,
            ),
            Command::GetLoggingLevel(_) => {
                Reply::of::<request::GetLoggingLevel>(Ok(redoor_core::logging::level()))
            }
            Command::SetLoggingLevel(request::SetLoggingLevel { level }) => {
                Reply::of::<request::SetLoggingLevel>(host::set_logging_level(level))
            }
            Command::Restart(_) => Reply::Reexec {
                outcome: request::Restart::encode(Ok(())),
                path: None,
            },
            Command::SelfExec(request::SelfExec { path }) => match host::self_exec(path) {
                Ok(path) => Reply::Reexec {
                    outcome: request::SelfExec::encode(Ok(())),
                    path: Some(path),
                },
                Err(error) => Reply::failure(error),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RunCommand;
    use super::ctx::{CommandCtx, Reply};
    use redoor_core::identity::current_binary_identity;
    use redoor_core::test_support::TempDir;
    use redoor_protocol::{
        api::{agents::MountPoint, files::CreationOwnershipOptions},
        ids::RequestId,
        wire::{
            command::{Command, CommandErrorKind},
            request::{self, AgentRequest, CommandError, DecodeError, LsResponse},
        },
    };

    /// Runs one control-lane request through the real dispatch table without a connection
    /// and decodes its typed response, as the server would.
    async fn run<R: AgentRequest>(request: R) -> Result<R::Response, CommandError> {
        let (ctx, _frames) = CommandCtx::detached(RequestId::new(1));
        let command: Command = request.into();
        let outcome = match command.run(ctx).await {
            Reply::Result(outcome) | Reply::Reexec { outcome, .. } => outcome,
            Reply::Stream { .. } => panic!("control commands answer directly"),
        };
        match R::decode(outcome) {
            Ok(response) => Ok(response),
            Err(DecodeError::Failed(error)) => Err(error),
            Err(DecodeError::Malformed(error)) => panic!("malformed response: {error}"),
        }
    }

    #[tokio::test]
    async fn test_ls_command() {
        let result = run(request::Ls { path: None }).await;

        match result {
            Ok(LsResponse::Directory(ls_result)) => {
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
        let path = "nonexistent-directory-for-ls-context";
        let result = run(request::Ls {
            path: Some(path.to_string()),
        })
        .await;

        match result {
            Err(CommandError { kind, message }) => {
                // The stable kind lets the REST layer return a useful status without parsing text.
                assert_eq!(kind, CommandErrorKind::NotFound);
                // Naming the attempted path makes remote filesystem failures actionable.
                assert!(message.contains(path), "ls error should include its path");
            }
            _ => panic!("Expected Error"),
        }
    }

    #[tokio::test]
    async fn test_raw_delete_command() {
        let temp = TempDir::create();
        let temp_path = temp.path().join("delete-test.txt");

        tokio::fs::write(&temp_path, "delete me")
            .await
            .expect("temporary file should be created");

        let result = run(request::RawDelete {
            path: temp_path.to_string_lossy().to_string(),
        })
        .await;

        match result {
            Ok(()) => {
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

        let result = run(request::RawDelete {
            path: temp_dir.to_string_lossy().to_string(),
        })
        .await;

        match result {
            Ok(()) => {
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
    async fn test_create_directory_command() {
        let temp = TempDir::create();
        let nested_dir = temp.path().join("nested").join("child");

        let result = run(request::CreateDirectory {
            path: nested_dir.to_string_lossy().to_string(),
            ownership: CreationOwnershipOptions::default(),
        })
        .await;

        match result {
            Ok(()) => {
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
        let temp = TempDir::create();
        let source_path = temp.path().join("before.txt");
        let dest_path = temp.path().join("after.txt");
        tokio::fs::write(&source_path, "rename me")
            .await
            .expect("source file should be created");

        let result = run(request::RenamePath {
            dir: temp.path().to_string_lossy().to_string(),
            old: "before.txt".to_string(),
            new: "after.txt".to_string(),
        })
        .await;

        match result {
            Ok(()) => {
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
    async fn test_chmod_path_preserves_special_bits() {
        let temp = TempDir::create();
        let path = temp.path().join("mode.txt");
        tokio::fs::write(&path, "mode")
            .await
            .expect("chmod fixture should be created");
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .expect("chmod fixture metadata should be readable")
            .permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o4644);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .expect("setuid fixture mode should apply");

        let result = run(request::ChmodPath {
            path: path.to_string_lossy().to_string(),
            permissions: 0o600,
        })
        .await;

        match result {
            Ok(response) => {
                assert_eq!(
                    response.permissions, 0o600,
                    "the response must echo the ordinary bits the grid requested"
                );
                let mode = tokio::fs::metadata(&path)
                    .await
                    .expect("chmod result metadata should be readable")
                    .permissions();
                let mode = std::os::unix::fs::PermissionsExt::mode(&mode);
                assert_eq!(
                    mode & 0o777,
                    0o600,
                    "disk rwx bits must match the requested ordinary mode"
                );
                assert_eq!(
                    mode & 0o7000,
                    0o4000,
                    "setuid must survive an ordinary-mode chmod"
                );
            }
            other => panic!("Expected ChmodPath, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_chown_path_rejects_non_root() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        let temp = TempDir::create();
        let path = temp.path().join("owned.txt");
        tokio::fs::write(&path, "owned")
            .await
            .expect("chown fixture should be created");

        let result = run(request::ChownPath {
            path: path.to_string_lossy().to_string(),
            owner: Some(String::from("0")),
            group: None,
        })
        .await;

        match result {
            Err(CommandError {
                kind: CommandErrorKind::PermissionDenied,
                ..
            }) => {}
            other => panic!("non-root chown must be PermissionDenied, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_get_agent_details_command() {
        let result = run(request::GetAgentDetails {}).await;

        match result {
            Ok(details) => {
                assert!(details.pid > 0, "PID should be positive");
                assert!(!details.cwd.is_empty(), "CWD should not be empty");
                // Detached test services record no loaded config, so the path stays empty.
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
                assert_eq!(
                    details.uid,
                    nix::unistd::Uid::effective().as_raw(),
                    "details uid must come from Uid::effective rather than $USER"
                );
                assert_eq!(
                    details.is_root,
                    nix::unistd::Uid::effective().is_root(),
                    "details root identity must come from Uid::effective rather than username"
                );
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
}
