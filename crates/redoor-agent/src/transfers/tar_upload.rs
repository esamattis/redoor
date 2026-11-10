//! Tar directory uploads extracted into a hidden sibling directory before placement.

use super::bounded_tar::{BoundedTarReader, InvalidMetadata, InvalidTermination};
use super::upload::{PublicationGate, SinkError, UploadSink};
use crate::errors::AgentCommandError;
use bytes::Bytes;
use redoor_core::destination::{
    DestinationPlaceError, check_existing_destination, place_temp_at_destination,
};
use redoor_core::log;
use redoor_core::staging::{StagingKind, StagingPath};
use redoor_protocol::{
    api::transfers::CopyExistingMode,
    ids::RequestId,
    wire::{command::CommandErrorKind, log::Level},
};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Bounded queue between the async receive loop and the blocking extractor.
const EXTRACTOR_QUEUE_CAPACITY: usize = 8;

/// Keeps tar upload failures typed so the API layer never depends on parsing text.
#[derive(Debug, Error)]
pub(crate) enum TarUploadError {
    #[error("Tar entry path escapes destination: {0}")]
    EscapingTarEntryPath(String),
    #[error("Tar entry path cannot be empty")]
    EmptyTarEntryPath,
    #[error("Destination parent not found for {0}")]
    DestinationParentNotFound(String),
    #[error("Failed to access destination parent: {0}")]
    AccessDestinationParent(#[source] std::io::Error),
    #[error("Destination parent is not a directory: {0}")]
    DestinationParentNotDirectory(String),
    #[error(transparent)]
    DestinationPlacement(#[from] DestinationPlaceError),
    #[error("Failed to create temp directory: {0}")]
    CreateTempDirectory(#[source] std::io::Error),
    #[error("Failed to read tar entries")]
    ReadTarEntries,
    #[error("Failed to read tar entry")]
    ReadTarEntry,
    #[error("{0}")]
    InvalidTarMetadata(String),
    #[error("{0}")]
    InvalidTarTermination(String),
    #[error("Unsupported tar entry type: {0:?}")]
    UnsupportedTarEntryType(tar::EntryType),
    #[error("Failed to read tar entry path")]
    ReadTarEntryPath,
    #[error("Failed to create destination directory: {0}")]
    CreateDestinationDirectory(String),
    #[error("Failed to unpack tar entry to {0}")]
    UnpackTarEntry(String),
    #[error("Tar extraction worker failed: {0}")]
    ExtractionWorkerFailed(String),
}

impl TarUploadError {
    /// Maps one tar-upload failure to the stable command error kind carried over the protocol.
    pub(crate) fn kind(&self) -> CommandErrorKind {
        match self {
            Self::AccessDestinationParent(error) | Self::CreateTempDirectory(error) => {
                CommandErrorKind::from_io_error(error)
            }
            Self::DestinationPlacement(error) => error.kind(),
            Self::DestinationParentNotDirectory(_) => CommandErrorKind::NotADirectory,
            Self::EscapingTarEntryPath(_)
            | Self::EmptyTarEntryPath
            | Self::InvalidTarMetadata(_)
            | Self::InvalidTarTermination(_)
            | Self::DestinationParentNotFound(_)
            | Self::UnsupportedTarEntryType(_) => CommandErrorKind::InvalidInput,
            Self::ReadTarEntries
            | Self::ReadTarEntry
            | Self::ReadTarEntryPath
            | Self::CreateDestinationDirectory(_)
            | Self::UnpackTarEntry(_)
            | Self::ExtractionWorkerFailed(_) => CommandErrorKind::Internal,
        }
    }
}

impl From<TarUploadError> for AgentCommandError {
    /// Keeps tar failures typed until they cross the protocol boundary.
    fn from(error: TarUploadError) -> Self {
        Self::new(error.kind(), error.to_string())
    }
}

/// Rejects tar entry paths that could escape the destination directory during extraction.
fn sanitize_tar_entry_path(entry_path: &Path) -> Result<PathBuf, TarUploadError> {
    let mut sanitized = PathBuf::new();

    for component in entry_path.components() {
        match component {
            Component::Normal(part) => sanitized.push(part),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(TarUploadError::EscapingTarEntryPath(
                    entry_path.display().to_string(),
                ));
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        return Err(TarUploadError::EmptyTarEntryPath);
    }

    Ok(sanitized)
}

/// Extracts tar bytes from the async-safe chunk channel into the temp destination directory.
fn unpack_tar_stream_into_directory(
    chunk_receiver: mpsc::Receiver<Bytes>,
    destination_root: &Path,
) -> Result<(), TarUploadError> {
    struct ChannelTarReader {
        chunk_receiver: mpsc::Receiver<Bytes>,
        current_chunk: Bytes,
        offset: usize,
        finished: bool,
    }

    impl std::io::Read for ChannelTarReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }

            loop {
                if self.offset < self.current_chunk.len() {
                    let remaining = self.current_chunk.len() - self.offset;
                    let bytes_to_copy = remaining.min(buf.len());
                    buf[..bytes_to_copy].copy_from_slice(
                        &self.current_chunk[self.offset..self.offset + bytes_to_copy],
                    );
                    self.offset += bytes_to_copy;
                    return Ok(bytes_to_copy);
                }

                if self.finished {
                    return Ok(0);
                }

                match self.chunk_receiver.blocking_recv() {
                    Some(chunk) => {
                        self.current_chunk = chunk;
                        self.offset = 0;
                    }
                    None => {
                        self.finished = true;
                        return Ok(0);
                    }
                }
            }
        }
    }

    let reader = ChannelTarReader {
        chunk_receiver,
        current_chunk: Bytes::new(),
        offset: 0,
        finished: false,
    };
    let mut archive = tar::Archive::new(BoundedTarReader::new(reader));
    let entries = archive
        .entries()
        .map_err(|_| TarUploadError::ReadTarEntries)?;

    for entry_result in entries {
        let mut entry = entry_result.map_err(|error| {
            match error
                .get_ref()
                .and_then(|source| source.downcast_ref::<InvalidMetadata>())
            {
                Some(error) => TarUploadError::InvalidTarMetadata(error.to_string()),
                None => match error
                    .get_ref()
                    .and_then(|source| source.downcast_ref::<InvalidTermination>())
                {
                    Some(error) => TarUploadError::InvalidTarTermination(error.to_string()),
                    None => TarUploadError::ReadTarEntry,
                },
            }
        })?;

        let entry_type = entry.header().entry_type();
        if !(entry_type.is_dir() || entry_type.is_file()) {
            return Err(TarUploadError::UnsupportedTarEntryType(entry_type));
        }

        let entry_path = entry.path().map_err(|_| TarUploadError::ReadTarEntryPath)?;
        let sanitized_path = sanitize_tar_entry_path(&entry_path)?;
        let output_path = destination_root.join(&sanitized_path);

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| {
                TarUploadError::CreateDestinationDirectory(parent.display().to_string())
            })?;
        }

        if entry_type.is_dir() {
            std::fs::create_dir_all(&output_path).map_err(|_| {
                TarUploadError::CreateDestinationDirectory(output_path.display().to_string())
            })?;
            continue;
        }

        entry
            .unpack(&output_path)
            .map_err(|_| TarUploadError::UnpackTarEntry(output_path.display().to_string()))?;
    }

    archive
        .into_inner()
        .finish()
        .map_err(|error| TarUploadError::InvalidTarTermination(error.to_string()))
}

/// Streams tar bytes into a blocking extractor that writes a hidden staging directory.
pub(crate) struct TarDirectorySink {
    path: String,
    request_id: RequestId,
    on_existing: CopyExistingMode,
    staging: StagingPath,
    chunk_sender: Option<mpsc::Sender<Bytes>>,
    unpacker: Option<JoinHandle<Result<(), TarUploadError>>>,
}

impl TarDirectorySink {
    /// Validates the destination, creates staging and starts the extractor before readiness.
    pub(crate) async fn prepare(
        request_id: RequestId,
        path: String,
        on_existing: CopyExistingMode,
    ) -> Result<Self, AgentCommandError> {
        let destination = PathBuf::from(&path);
        let parent = destination
            .parent()
            .ok_or_else(|| TarUploadError::DestinationParentNotFound(path.clone()))?
            .to_path_buf();
        let parent_metadata = tokio::fs::metadata(&parent)
            .await
            .map_err(TarUploadError::AccessDestinationParent)?;
        if !parent_metadata.is_dir() {
            return Err(TarUploadError::DestinationParentNotDirectory(
                parent.display().to_string(),
            )
            .into());
        }
        check_existing_destination(&destination, on_existing, true)
            .await
            .map_err(TarUploadError::from)?;

        // `create_dir` refuses existing names, so a collision retries with a fresh name
        // instead of failing the upload.
        let (staging, ()) = StagingPath::create_sibling(
            &destination,
            StagingKind::UploadDirectory,
            tokio::fs::create_dir,
        )
        .await
        .map_err(TarUploadError::CreateTempDirectory)?;
        let (chunk_sender, chunk_receiver) = mpsc::channel::<Bytes>(EXTRACTOR_QUEUE_CAPACITY);
        let root = staging.path().to_path_buf();
        let unpacker = tokio::task::spawn_blocking(move || {
            unpack_tar_stream_into_directory(chunk_receiver, &root)
        });
        log!(
            Level::Info,
            "Started tar upload: request_id={}, path={}, temp_path={}, on_existing={:?}",
            request_id,
            path,
            staging.path().display(),
            on_existing
        );
        Ok(Self {
            path,
            request_id,
            on_existing,
            staging,
            chunk_sender: Some(chunk_sender),
            unpacker: Some(unpacker),
        })
    }

    /// Closes the tar input and joins the blocking extractor before its tree can be touched.
    async fn join_unpacker(&mut self) -> Result<(), TarUploadError> {
        self.chunk_sender.take();
        let Some(unpacker) = self.unpacker.take() else {
            return Err(TarUploadError::ExtractionWorkerFailed(
                "extractor was already joined".to_string(),
            ));
        };
        match unpacker.await {
            Ok(result) => result,
            Err(error) => Err(TarUploadError::ExtractionWorkerFailed(error.to_string())),
        }
    }
}

impl UploadSink for TarDirectorySink {
    /// Forwards bytes to the extractor while a full queue stays interruptible by cancellation.
    async fn write(&mut self, data: Bytes, cancel: &CancellationToken) -> Result<(), SinkError> {
        if data.is_empty() {
            return Ok(());
        }
        let Some(chunk_sender) = self.chunk_sender.as_ref() else {
            return Err(SinkError::Failed(AgentCommandError::new(
                CommandErrorKind::Internal,
                "Failed to forward tar upload chunk to unpacker: extractor input is closed",
            )));
        };
        tokio::select! {
            _ = cancel.cancelled() => Err(SinkError::Canceled),
            result = chunk_sender.send(data) => result.map_err(|error| {
                SinkError::Failed(AgentCommandError::new(
                    CommandErrorKind::Internal,
                    format!("Failed to forward tar upload chunk to unpacker: {error}"),
                ))
            }),
        }
    }

    /// Joins extraction, then publishes the tree only after router authorization.
    async fn commit(mut self, gate: PublicationGate<'_>) -> Result<(), AgentCommandError> {
        let unpack_result = self.join_unpacker().await;
        // The extractor owned the tree until joined. A cancel received meanwhile must discard
        // it, never publish it over the destination.
        if gate.is_canceled() {
            self.staging.discard().await;
            return Err(AgentCommandError::new(
                CommandErrorKind::InvalidInput,
                "Upload canceled before publication",
            ));
        }
        if let Err(error) = unpack_result {
            self.staging.discard().await;
            return Err(error.into());
        }
        if !gate.authorize().await {
            self.staging.discard().await;
            return Err(AgentCommandError::new(
                CommandErrorKind::InvalidInput,
                "Upload publication was not authorized",
            ));
        }
        if let Err(error) = place_temp_at_destination(
            self.staging.path(),
            Path::new(&self.path),
            self.on_existing,
            true,
        )
        .await
        {
            self.staging.discard().await;
            return Err(TarUploadError::from(error).into());
        }
        self.staging.keep();
        Ok(())
    }

    /// Stops and joins the extractor before removing the tree it was writing.
    async fn abort(mut self) {
        if let Err(error) = self.join_unpacker().await {
            log!(
                Level::Warning,
                "Tar upload extractor failed while stopping: request_id={}, path={}, error={}",
                self.request_id,
                self.path,
                error
            );
        }
        self.staging.discard().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::responder::Responder;
    use crate::transfers::upload::UploadRoutes;
    use redoor_core::test_support::TempDir;
    use redoor_protocol::wire::AgentToServer;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    /// Bounded validation must preserve ordinary, GNU and PAX paths through real extraction.
    #[tokio::test]
    async fn metadata_validation_preserves_supported_long_paths() {
        for format in ["ordinary", "ustar", "gnu", "pax"] {
            let temp = TempDir::create();
            let name = if format == "ordinary" {
                "short/file".to_string()
            } else {
                format!("{}/{}/file", "a".repeat(80), "b".repeat(80))
            };
            let mut builder = tar::Builder::new(Vec::new());
            if format == "pax" {
                builder
                    .append_pax_extensions([("path", name.as_bytes())])
                    .unwrap();
            }
            let mut header = if format == "ustar" {
                tar::Header::new_ustar()
            } else {
                tar::Header::new_gnu()
            };
            header.set_mode(0o600);
            header.set_size(7);
            builder
                .append_data(
                    &mut header,
                    if format == "pax" {
                        "placeholder"
                    } else {
                        &name
                    },
                    b"payload".as_slice(),
                )
                .unwrap();
            let bytes = builder.into_inner().unwrap();
            let (sender, receiver) = mpsc::channel(1);
            sender.send(Bytes::from(bytes)).await.unwrap();
            drop(sender);
            let root = temp.path().to_path_buf();
            tokio::task::spawn_blocking(move || unpack_tar_stream_into_directory(receiver, &root))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                tokio::fs::read(temp.path().join(name)).await.unwrap(),
                b"payload",
                "validation must retain the dependency's supported path interpretation for {format}"
            );
        }
    }

    /// Builds a sink over an existing staging tree and a caller-controlled extractor.
    fn sink_over(
        destination: &Path,
        staging: &Path,
        on_existing: CopyExistingMode,
        chunk_sender: Option<mpsc::Sender<Bytes>>,
        unpacker: JoinHandle<Result<(), TarUploadError>>,
    ) -> TarDirectorySink {
        TarDirectorySink {
            path: destination.display().to_string(),
            request_id: RequestId::new(4),
            on_existing,
            staging: StagingPath::new(staging.to_path_buf()),
            chunk_sender,
            unpacker: Some(unpacker),
        }
    }

    /// A completed extractor is still reversible until the router grants placement.
    #[tokio::test]
    async fn denied_archive_publication_preserves_destination_and_cleans_staging() {
        let temp = TempDir::create();
        let destination = temp.path().join("destination");
        let staging = temp.path().join("staging");
        tokio::fs::create_dir(&destination).await.unwrap();
        tokio::fs::write(destination.join("original"), b"keep")
            .await
            .unwrap();
        tokio::fs::create_dir(&staging).await.unwrap();
        tokio::fs::write(staging.join("replacement"), b"new")
            .await
            .unwrap();
        let routes = UploadRoutes::default();
        let (responder, mut frames) = Responder::recording(RequestId::new(4), 2);
        let cancel = CancellationToken::new();
        let sink = sink_over(
            &destination,
            &staging,
            CopyExistingMode::Merge,
            None,
            tokio::spawn(async { Ok(()) }),
        );
        let commit = {
            let routes = routes.clone();
            tokio::spawn(async move {
                sink.commit(PublicationGate::new(&routes, &responder, &cancel))
                    .await
            })
        };

        // Completed extraction must not begin even a merge before router authorization.
        assert!(matches!(
            frames.recv().await.unwrap().as_message(),
            Some(AgentToServer::PublishRequest { .. })
        ));
        // Simulate cancellation winning in the router before its separate cancel control arrives.
        routes.resolve_publication(RequestId::new(4), false);
        let result = commit.await.unwrap();

        // A denied publication is reported as a failure.
        assert!(result.is_err());
        // Denied publication must leave destination-only content intact.
        assert_eq!(
            tokio::fs::read(destination.join("original")).await.unwrap(),
            b"keep"
        );
        // Denied publication must not merge any staged entries.
        assert!(
            !tokio::fs::try_exists(destination.join("replacement"))
                .await
                .unwrap()
        );
        // A router denial must release the owned extracted tree.
        assert!(!tokio::fs::try_exists(staging).await.unwrap());
    }

    /// Holds extraction after body completion to reproduce cancellation before overwrite deterministically.
    #[tokio::test]
    async fn cancellation_during_final_extraction_preserves_destination_and_cleans_staging() {
        let temp = TempDir::create();
        let destination = temp.path().join("destination");
        let staging = temp.path().join("staging");
        tokio::fs::create_dir(&destination).await.unwrap();
        tokio::fs::write(destination.join("original"), b"keep")
            .await
            .unwrap();
        tokio::fs::create_dir(&staging).await.unwrap();
        let (release, released) = tokio::sync::oneshot::channel();
        let staging_in_worker = staging.clone();
        let unpacker = tokio::spawn(async move {
            released.await.unwrap();
            tokio::fs::write(staging_in_worker.join("replacement"), b"new")
                .await
                .unwrap();
            Ok(())
        });
        let routes = UploadRoutes::default();
        let (responder, mut frames) = Responder::recording(RequestId::new(2), 2);
        let cancel = CancellationToken::new();
        let sink = sink_over(
            &destination,
            &staging,
            CopyExistingMode::Override,
            None,
            unpacker,
        );
        let gate = PublicationGate::new(&routes, &responder, &cancel);
        let mut commit = Box::pin(sink.commit(gate));

        // Post-body finalization must still own the unfinished extractor.
        assert!(futures_util::poll!(&mut commit).is_pending());
        cancel.cancel();
        release.send(()).unwrap();
        let result = commit.await;

        // Canceled extraction must not report success.
        assert!(result.is_err());
        // Cancellation during extraction must preserve the existing destination.
        assert_eq!(
            tokio::fs::read(destination.join("original")).await.unwrap(),
            b"keep"
        );
        // Staging must be removed only after the extractor finishes writing.
        assert!(!tokio::fs::try_exists(&staging).await.unwrap());
        // A canceled extraction must not even request publication.
        assert!(frames.try_recv().is_err());
    }

    #[tokio::test]
    async fn full_unpacker_queue_keeps_cancellation_async_and_joins_before_cleanup() {
        let temp_dir = TempDir::create();
        let temp_path = temp_dir.path().join("tar-upload-cancel");
        tokio::fs::create_dir(&temp_path).await.unwrap();

        let (chunk_sender, mut chunk_receiver) = mpsc::channel::<Bytes>(1);
        chunk_sender
            .try_send(Bytes::from_static(&[1]))
            .expect("the first chunk should fill the bounded queue");
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel::<()>();
        let tree_present_at_join = Arc::new(AtomicBool::new(false));
        let tree_present_in_worker = Arc::clone(&tree_present_at_join);
        let tree_in_worker = temp_path.clone();
        let unpacker = tokio::task::spawn_blocking(move || {
            release_receiver
                .blocking_recv()
                .expect("the test should release the extractor");
            while chunk_receiver.blocking_recv().is_some() {}
            tree_present_in_worker.store(tree_in_worker.exists(), Ordering::Release);
            Ok(())
        });
        let mut sink = sink_over(
            &temp_path,
            &temp_path,
            CopyExistingMode::Error,
            Some(chunk_sender),
            unpacker,
        );
        let cancel = CancellationToken::new();

        let mut write = Box::pin(sink.write(Bytes::from_static(&[2]), &cancel));
        // A full extractor queue must yield instead of blocking the Tokio worker.
        assert!(futures_util::poll!(&mut write).is_pending());
        cancel.cancel();
        // Cancellation must win without waiting for extractor queue capacity.
        assert!(matches!(write.await, Err(SinkError::Canceled)));

        release_sender.send(()).unwrap();
        sink.abort().await;

        // The blocking extractor must be joined while its temp tree still exists.
        assert!(tree_present_at_join.load(Ordering::Acquire));
        // Terminal cleanup must remove the temp tree after the extractor exits.
        assert!(!temp_path.exists());
    }
}
