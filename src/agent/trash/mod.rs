#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

use redoor::{
    Level,
    commands::{CommandErrorKind, TrashListResponse},
    log,
};
use std::{path::PathBuf, sync::Arc};
use thiserror::Error;
use tokio::sync::Mutex;

use super::transfers::copy::LocalCopyResponseContext;

/// Immutable startup configuration used by every trash command worker.
#[derive(Clone)]
pub(crate) struct TrashService {
    #[cfg(target_os = "linux")]
    forced_root: Option<PathBuf>,
    /// Prevents purge from racing with publication or restoration of provider metadata.
    mutation_lock: Arc<Mutex<()>>,
}

/// Keeps provider failures mapped to stable command error categories.
#[derive(Debug, Error)]
#[error("{message}")]
pub(crate) struct TrashError {
    pub(crate) kind: CommandErrorKind,
    message: String,
}

impl TrashError {
    /// Creates an error when provider validation determines the public category directly.
    pub(crate) fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Adds operation context while preserving the OS error's stable category.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn io(context: &str, error: std::io::Error) -> Self {
        Self::new(
            CommandErrorKind::from_io_error(&error),
            format!("{context}: {error}"),
        )
    }
}

impl TrashService {
    /// Resolves and validates runtime trash configuration once before registration.
    pub(crate) async fn initialize(forced_root: Option<PathBuf>) -> Result<Self, TrashError> {
        #[cfg(target_os = "linux")]
        {
            let service = Self {
                forced_root,
                mutation_lock: Arc::new(Mutex::new(())),
            };
            if let Some(root) = &service.forced_root {
                linux::prepare_private_root(root).await?;
            }
            Ok(service)
        }
        #[cfg(not(target_os = "linux"))]
        {
            if forced_root.is_some() {
                return Err(TrashError::new(
                    CommandErrorKind::InvalidInput,
                    "Trash directory overrides are supported only on Linux",
                ));
            }
            Ok(Self {
                mutation_lock: Arc::new(Mutex::new(())),
            })
        }
    }

    /// Advertises providers that can move entries to platform trash.
    pub(crate) const fn supports_move(&self) -> bool {
        cfg!(any(target_os = "linux", target_os = "macos"))
    }

    /// Advertises providers that implement Redoor trash inventory and restore.
    pub(crate) const fn supports_inventory(&self) -> bool {
        cfg!(target_os = "linux")
    }

    /// Supplies inert configuration to tests that do not execute trash commands.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            forced_root: None,
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Moves one entry to the provider-selected same-device trash location.
    pub(crate) async fn trash(&self, path: PathBuf) -> Result<(), TrashError> {
        log!(
            Level::Debug,
            "Trash operation requested: path={}",
            path.display()
        );
        let _guard = self.mutation_lock.lock().await;
        log!(
            Level::Debug,
            "Trash mutation lock acquired: path={}",
            path.display()
        );
        #[cfg(target_os = "linux")]
        let result = linux::trash(self, path.clone()).await;
        #[cfg(target_os = "macos")]
        let result = macos::trash(path.clone()).await;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let result = Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash is unsupported on this platform",
        ));
        match &result {
            Ok(()) => log!(
                Level::Debug,
                "Trash operation completed: path={}",
                path.display()
            ),
            Err(error) => log!(
                Level::Debug,
                "Trash operation failed: path={}, kind={:?}, error={}",
                path.display(),
                error.kind,
                error
            ),
        }
        result
    }

    /// Discovers and orders a fresh trash inventory without recursively scanning payloads.
    pub(crate) async fn list(&self) -> Result<TrashListResponse, TrashError> {
        #[cfg(target_os = "linux")]
        return linux::list(self).await;
        #[cfg(not(target_os = "linux"))]
        Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash is unsupported on this platform",
        ))
    }

    /// Permanently removes all payloads and metadata while preserving provider roots.
    pub(crate) async fn empty(&self) -> Result<u64, TrashError> {
        let _guard = self.mutation_lock.lock().await;
        #[cfg(target_os = "linux")]
        return linux::empty(self).await;
        #[cfg(not(target_os = "linux"))]
        Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash is unsupported on this platform",
        ))
    }

    /// Resolves opaque identifiers before restoring one payload to an explicit destination.
    pub(crate) async fn restore(
        &self,
        _location_id: &str,
        _item_id: &str,
        _destination: PathBuf,
        _response: &LocalCopyResponseContext<'_>,
    ) -> Result<PathBuf, TrashError> {
        let _guard = self.mutation_lock.lock().await;
        #[cfg(target_os = "linux")]
        return linux::restore(self, _location_id, _item_id, _destination, _response).await;
        #[cfg(not(target_os = "linux"))]
        Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash is unsupported on this platform",
        ))
    }

    /// Exposes the immutable override only inside the platform provider.
    #[cfg(target_os = "linux")]
    fn forced_root(&self) -> Option<&std::path::Path> {
        self.forced_root.as_deref()
    }
}
