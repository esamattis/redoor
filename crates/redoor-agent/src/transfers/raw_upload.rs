//! Raw file uploads staged in a hidden sibling file and published through the router gate.

use super::upload::{PublicationGate, SinkError, UploadSink};
use crate::errors::AgentCommandError;
use crate::ownership::{OwnershipPlan, ResolvedOwnership};
use crate::runtime::cancel::CancelReasonCell;
use redoor_core::destination::{check_existing_destination, place_temp_at_destination};
use redoor_core::log;
use redoor_core::staging::{StagingKind, StagingPath};
use redoor_protocol::wire::command::{MoveSourceIdentity, UploadPrecondition};
use redoor_protocol::wire::partials::CancelReason;
use redoor_protocol::{
    api::{files::CreationOwnershipOptions, transfers::CopyExistingMode},
    ids::RequestId,
    wire::{command::CommandErrorKind, log::Level},
};
use std::path::Path;
use tokio::{
    fs::{File, OpenOptions},
    io::AsyncWriteExt,
};
use tokio_util::sync::CancellationToken;

/// Captures metadata only from a regular destination entry and never from a symlink target.
async fn existing_destination_metadata(
    path: &Path,
) -> std::io::Result<Option<(std::fs::Permissions, u32, u32)>> {
    use std::os::unix::fs::MetadataExt;

    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some((
            metadata.permissions(),
            metadata.uid(),
            metadata.gid(),
        ))),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Reserves a new sibling staging file without following a colliding symlink: `create_new`
/// refuses any existing entry, so ownership only ever covers a file this upload created.
async fn create_staging_file(
    path: &Path,
    executable: bool,
) -> std::io::Result<(StagingPath, File)> {
    StagingPath::create_sibling(path, StagingKind::Upload, |candidate| async move {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            // Apply execute permissions at creation so the OS retains the umask and ACLs.
            .mode(if executable { 0o777 } else { 0o666 })
            .open(candidate)
            .await
    })
    .await
}

/// Refuses an upload whose destination no longer has the state the server read.
///
/// Runs once before staging, so a stale save fails before its body is streamed, and again
/// right before the rename, which keeps the window for a concurrent writer as small as the
/// filesystem allows.
async fn check_precondition(
    path: &Path,
    precondition: Option<&UploadPrecondition>,
) -> Result<(), AgentCommandError> {
    let Some(precondition) = precondition else {
        return Ok(());
    };
    let current = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Some(MoveSourceIdentity::from_metadata(&metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(AgentCommandError::new(
                CommandErrorKind::from_io_error(&error),
                format!("Failed to inspect upload destination: {error}"),
            ));
        }
    };
    match (precondition, current) {
        (UploadPrecondition::MustNotExist, None) => Ok(()),
        (UploadPrecondition::MustNotExist, Some(_)) => Err(AgentCommandError::new(
            CommandErrorKind::AlreadyExists,
            format!("Destination already exists: {}", path.display()),
        )),
        (UploadPrecondition::Matches { identity }, Some(current)) if *identity == current => Ok(()),
        (UploadPrecondition::Matches { .. }, _) => Err(AgentCommandError::new(
            CommandErrorKind::SourceChanged,
            format!(
                "File changed on the device since it was read: {}",
                path.display()
            ),
        )),
    }
}

/// Replaces or creates one file through a hidden sibling staging file.
pub(crate) struct RawFileSink {
    /// Durable staging of a resumable copy; `None` for browser uploads.
    partial: Option<crate::transfers::partials::PartialOutput>,
    /// Why the request was canceled, which decides whether a partial survives a refused
    /// publication.
    reason: Option<CancelReasonCell>,
    path: String,
    request_id: RequestId,
    on_existing: CopyExistingMode,
    staging: StagingPath,
    file: File,
    existing_permissions: Option<std::fs::Permissions>,
    ownership: ResolvedOwnership,
    /// Checked again right before the rename; see [`check_precondition`].
    precondition: Option<UploadPrecondition>,
}

impl RawFileSink {
    /// Validates the destination and reserves staging before the server starts streaming.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn prepare(
        request_id: RequestId,
        path: String,
        on_existing: CopyExistingMode,
        ownership: CreationOwnershipOptions,
        partial: Option<Box<redoor_protocol::wire::partials::PartialTransfer>>,
        executable: bool,
        precondition: Option<UploadPrecondition>,
        services: &crate::commands::ctx::AgentServices,
    ) -> Result<Self, AgentCommandError> {
        let destination = Path::new(&path);
        check_precondition(destination, precondition.as_ref()).await?;
        // The precondition decides replacement: a new file must be published without
        // replacing anything, and a matching file is replaced whatever the caller asked.
        // A file merge is one rename over the old file, so readers never see it missing;
        // an override would move the old file aside first.
        let on_existing = match precondition {
            Some(UploadPrecondition::MustNotExist) => CopyExistingMode::Error,
            Some(UploadPrecondition::Matches { .. }) => CopyExistingMode::Merge,
            None => on_existing,
        };
        check_existing_destination(destination, on_existing, false)
            .await
            .map_err(|error| AgentCommandError::new(error.kind(), error.to_string()))?;
        let existing_metadata =
            existing_destination_metadata(destination)
                .await
                .map_err(|error| {
                    AgentCommandError::new(
                        CommandErrorKind::from_io_error(&error),
                        format!("Failed to inspect upload destination: {error}"),
                    )
                })?;
        let existing_ids = existing_metadata.as_ref().map(|(_, uid, gid)| (*uid, *gid));
        let ownership = OwnershipPlan::resolve(ownership, existing_ids)
            .await
            .map_err(|error| AgentCommandError::new(error.kind(), error.to_string()))?;
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        let ownership = ownership
            .for_parent(parent)
            .await
            .map_err(|error| AgentCommandError::new(error.kind(), error.to_string()))?;
        let partial = match partial {
            Some(transfer) => Some(
                crate::transfers::partials::PartialOutput::prepare(
                    services.partial_store.clone(),
                    services
                        .destination_locks
                        .acquire(&transfer.signed.authorization.dest_path)
                        .map_err(|error| {
                            AgentCommandError::new(CommandErrorKind::Conflict, error.to_string())
                        })?,
                    *transfer,
                )
                .await
                .map_err(|error| {
                    AgentCommandError::new(
                        CommandErrorKind::from_io_error(&error),
                        error.to_string(),
                    )
                })?,
            ),
            None => None,
        };
        let (staging, file) = match &partial {
            Some(output) => (
                StagingPath::retained(std::path::PathBuf::from(&output.manifest.partial_path)),
                output.file.try_clone().await.map_err(|error| {
                    AgentCommandError::new(
                        CommandErrorKind::from_io_error(&error),
                        error.to_string(),
                    )
                })?,
            ),
            None => create_staging_file(destination, executable)
                .await
                .map_err(|error| {
                    AgentCommandError::new(
                        CommandErrorKind::from_io_error(&error),
                        format!("Failed to create file: {error}"),
                    )
                })?,
        };
        log!(
            Level::Info,
            "Started raw upload: request_id={}, path={}, temp_path={}, on_existing={:?}",
            request_id,
            path,
            staging.path().display(),
            on_existing
        );
        Ok(Self {
            partial,
            reason: None,
            path,
            request_id,
            on_existing,
            staging,
            file,
            existing_permissions: existing_metadata.map(|(permissions, _, _)| permissions),
            ownership,
            precondition,
        })
    }

    /// Stores cancellation disposition before the driver takes ownership of the context.
    pub(crate) fn with_reason(mut self, reason: Option<CancelReasonCell>) -> Self {
        self.reason = reason;
        self
    }

    /// Logs a publication-phase failure and discards staging before it is reported.
    async fn fail(self, kind: CommandErrorKind, message: String) -> AgentCommandError {
        redoor_core::log_failure!(
            Level::Error,
            "Upload finalize failed: request_id={}, path={}, temp_path={}, error={}",
            self.request_id,
            self.path,
            self.staging.path().display(),
            message
        );
        // The router, which knows the partial exists, tells the user it was kept.
        if let Some(output) = self.partial {
            let _ = output.stop(CancelReason::Disconnected).await;
        } else {
            self.staging.discard().await;
        }
        AgentCommandError::new(kind, message)
    }
}

impl UploadSink for RawFileSink {
    /// Appends chunk bytes to the staging file.
    async fn write(&mut self, data: Vec<u8>, _cancel: &CancellationToken) -> Result<(), SinkError> {
        self.file.write_all(&data).await.map_err(|error| {
            let message = format!("Failed to write upload chunk: {error}");
            redoor_core::log_failure!(
                Level::Error,
                "Upload write failed: request_id={}, path={}, error={}",
                self.request_id,
                self.path,
                message
            );
            SinkError::Failed(AgentCommandError::new(
                CommandErrorKind::from_io_error(&error),
                message,
            ))
        })
    }

    /// Applies ownership and permissions to staging, waits for router authorization, then places.
    async fn commit(mut self, gate: PublicationGate<'_>) -> Result<(), AgentCommandError> {
        if let Err(error) = self.file.flush().await {
            let kind = CommandErrorKind::from_io_error(&error);
            return Err(self
                .fail(kind, format!("Failed to flush uploaded file: {error}"))
                .await);
        }
        if !gate.authorize().await {
            let reason = self
                .reason
                .as_ref()
                .map_or(CancelReason::Canceled, CancelReasonCell::load);
            self.stop(reason).await?;
            return Err(AgentCommandError::new(
                if reason == CancelReason::Paused {
                    CommandErrorKind::Paused
                } else {
                    CommandErrorKind::Canceled
                },
                "Upload publication was not authorized",
            ));
        }
        if let Err(error) = self.ownership.apply(self.staging.path()).await {
            let kind = error.kind();
            return Err(self
                .fail(
                    kind,
                    format!("Failed to set uploaded file ownership: {error}"),
                )
                .await);
        }
        if let Some(permissions) = self.existing_permissions.clone()
            && let Err(error) = tokio::fs::set_permissions(self.staging.path(), permissions).await
        {
            let kind = CommandErrorKind::from_io_error(&error);
            return Err(self
                .fail(
                    kind,
                    format!("Failed to set uploaded file permissions: {error}"),
                )
                .await);
        }
        if let Err(error) =
            check_precondition(Path::new(&self.path), self.precondition.as_ref()).await
        {
            let message = error.to_string();
            return Err(self.fail(error.kind(), message).await);
        }
        if let Err(error) = place_temp_at_destination(
            self.staging.path(),
            Path::new(&self.path),
            self.on_existing,
            false,
        )
        .await
        {
            let kind = error.kind();
            return Err(self
                .fail(kind, format!("Failed to finalize uploaded file: {error}"))
                .await);
        }
        self.staging.keep();
        if let Some(output) = self.partial {
            output.published().await;
        }
        Ok(())
    }

    /// Durable abort completes before the driver's terminal result acknowledges pause.
    async fn stop(
        mut self,
        reason: redoor_protocol::wire::partials::CancelReason,
    ) -> Result<(), AgentCommandError> {
        if let Some(output) = self.partial {
            if reason != CancelReason::Canceled {
                // The sink's cloned Tokio handle owns pending writes; drain it before fsync.
                self.file.flush().await.map_err(|error| {
                    AgentCommandError::new(CommandErrorKind::Internal, error.to_string())
                })?;
            }
            output.stop(reason).await.map_err(|error| {
                AgentCommandError::new(
                    CommandErrorKind::Internal,
                    format!("Failed to persist partial: {error}"),
                )
            })
        } else {
            self.staging.discard().await;
            Ok(())
        }
    }

    /// Closes and removes the staging file.
    async fn abort(self) {
        let _ = self.stop(CancelReason::Canceled).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ctx::CommandCtx;
    use crate::runtime::cancel::CancelRegistry;
    use crate::runtime::responder::ResultLedger;
    use crate::transfers::upload::UploadDriver;
    use redoor_core::test_support::TempDir;
    use redoor_protocol::wire::request::CommandError;
    use redoor_protocol::wire::{AgentToServer, policy::UploadKind, stream::StreamChunk};
    use std::os::unix::fs::{PermissionsExt, symlink};

    /// Waits for the real worker's publication request so cancellation cannot depend on IO timing.
    #[tokio::test]
    async fn cancellation_at_raw_publication_gate_preserves_destination_and_cleans_staging() {
        let temp = TempDir::create();
        let destination = temp.path().join("destination");
        tokio::fs::write(&destination, b"original").await.unwrap();
        let request_id = RequestId::new(3);
        let (mut ctx, mut frames) = CommandCtx::detached(request_id);
        let registry = CancelRegistry::new(None);
        let registration = registry.register(request_id).unwrap();
        ctx.cancel = registration.token().clone();
        ctx.registration = Some(registration);
        let routes = ctx.services.upload_routes.clone();
        let prepared = RawFileSink::prepare(
            request_id,
            destination.display().to_string(),
            CopyExistingMode::Override,
            CreationOwnershipOptions::default(),
            None,
            false,
            None,
            &ctx.services,
        )
        .await;
        let task = tokio::spawn(
            UploadDriver::new(
                UploadKind::RawUpload,
                destination.display().to_string(),
                ctx,
            )
            .run(prepared),
        );
        // Readiness precedes any chunk.
        assert!(matches!(
            frames.recv().await.unwrap().as_message(),
            Some(AgentToServer::Credit { .. })
        ));
        let (control, _control_frames) = tokio::sync::mpsc::channel(1);
        routes
            .route_chunk(
                StreamChunk::data(request_id, b"replacement".to_vec(), true),
                &control,
                &ResultLedger::default(),
            )
            .await;
        // Raw finalization must ask the router before changing the destination.
        assert!(matches!(
            frames.recv().await.unwrap().as_message(),
            Some(AgentToServer::PublishRequest { .. })
        ));

        // The post-body worker must retain cancellation ownership.
        assert!(registry.cancel_with_reason(&request_id, CancelReason::Canceled));
        let result = task.await.unwrap();

        // Canceling a publication wait must produce failure rather than success.
        assert!(matches!(result, Err(CommandError { .. })));
        // Post-body cancellation must never overwrite the existing file.
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"original");
        let mut entries = tokio::fs::read_dir(temp.path()).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            names.push(entry.file_name());
        }
        // Canceled raw finalization must remove all owned staging siblings.
        assert_eq!(names, vec![destination.file_name().unwrap().to_os_string()]);
    }

    #[tokio::test]
    async fn permission_capture_uses_destination_entry_without_following_symlinks() {
        let temp = TempDir::create();
        let target = temp.path().join("target");
        let peer = temp.path().join("peer");
        let valid_link = temp.path().join("valid-link");
        let dangling_link = temp.path().join("dangling-link");
        tokio::fs::write(&target, b"target").await.unwrap();
        tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751))
            .await
            .unwrap();
        tokio::fs::hard_link(&target, &peer).await.unwrap();
        symlink(&target, &valid_link).unwrap();
        symlink("missing", &dangling_link).unwrap();

        let regular = existing_destination_metadata(&target)
            .await
            .unwrap()
            .unwrap()
            .0;
        let hard_link = existing_destination_metadata(&peer)
            .await
            .unwrap()
            .unwrap()
            .0;

        // A regular entry keeps its own previous mode for replacement publication.
        assert_eq!(regular.mode() & 0o777, 0o751);
        // A hard-link name directly identifies a regular entry and supplies the same mode.
        assert_eq!(hard_link.mode() & 0o777, 0o751);
        // A valid symlink must not leak its target mode into the replacement file.
        assert!(
            existing_destination_metadata(&valid_link)
                .await
                .unwrap()
                .is_none()
        );
        // A dangling symlink is still an entry and must likewise provide no target metadata.
        assert!(
            existing_destination_metadata(&dangling_link)
                .await
                .unwrap()
                .is_none()
        );
    }

    /// A child process isolates the umask from other tests and Tokio's filesystem workers.
    #[tokio::test]
    async fn executable_staging_respects_umask() {
        if std::env::var_os("REDOOR_TEST_EXECUTABLE_UMASK").is_none() {
            let status = tokio::process::Command::new("sh")
                .args(["-c", "umask 0111; exec \"$@\"", "sh"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "transfers::raw_upload::tests::executable_staging_respects_umask",
                    "--nocapture",
                ])
                .env("REDOOR_TEST_EXECUTABLE_UMASK", "1")
                .status()
                .await
                .unwrap();
            // Only the isolated child changes the process-wide permission policy.
            assert!(status.success());
            return;
        }
        let temp = TempDir::create();
        // The test masks directory execute bits too; make only the fixture parent usable.
        tokio::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let (staging, file) = create_staging_file(&temp.path().join("script"), true)
            .await
            .unwrap();
        let mode = file.metadata().await.unwrap().permissions().mode() & 0o777;
        // Readability must not restore execute bits explicitly forbidden by the umask.
        assert_eq!(mode, 0o666);
        drop(file);
        staging.discard().await;
    }

    /// Vault saves rely on these answers to refuse overwriting a newer or unexpected file.
    #[tokio::test]
    async fn precondition_detects_existing_and_replaced_destinations() {
        let temp = TempDir::create();
        let destination = temp.path().join("secret.redoorvault");
        // No precondition and a missing file both leave creation allowed.
        assert!(check_precondition(&destination, None).await.is_ok());
        assert!(
            check_precondition(&destination, Some(&UploadPrecondition::MustNotExist))
                .await
                .is_ok()
        );

        tokio::fs::write(&destination, b"first").await.unwrap();
        let identity = MoveSourceIdentity::from_metadata(
            &tokio::fs::symlink_metadata(&destination).await.unwrap(),
        );
        let matches = UploadPrecondition::Matches {
            identity: identity.clone(),
        };
        // Creating over an existing file must be refused as an existing destination.
        assert_eq!(
            check_precondition(&destination, Some(&UploadPrecondition::MustNotExist))
                .await
                .unwrap_err()
                .kind(),
            CommandErrorKind::AlreadyExists
        );
        // The file the server read is still in place, so replacing it is allowed.
        assert!(
            check_precondition(&destination, Some(&matches))
                .await
                .is_ok()
        );

        // Another writer replaces the file the way every vault save does: through a rename.
        let other = temp.path().join("other");
        tokio::fs::write(&other, b"second").await.unwrap();
        tokio::fs::rename(&other, &destination).await.unwrap();
        // A different inode means a newer version, which a stale save must not replace.
        assert_eq!(
            check_precondition(&destination, Some(&matches))
                .await
                .unwrap_err()
                .kind(),
            CommandErrorKind::SourceChanged
        );

        tokio::fs::remove_file(&destination).await.unwrap();
        // A removed file is also a change, not a reason to recreate it.
        assert_eq!(
            check_precondition(&destination, Some(&matches))
                .await
                .unwrap_err()
                .kind(),
            CommandErrorKind::SourceChanged
        );
    }

    #[tokio::test]
    async fn staging_creation_reserves_a_new_regular_sibling() {
        let temp = TempDir::create();
        let destination = temp.path().join("destination");

        let (staging, file) = create_staging_file(&destination, false).await.unwrap();
        drop(file);

        // The reserved staging entry must be a newly created regular file.
        assert!(
            tokio::fs::symlink_metadata(staging.path())
                .await
                .unwrap()
                .is_file()
        );
        staging.discard().await;
    }
}
