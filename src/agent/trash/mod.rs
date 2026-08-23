#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

use redoor::commands::{CommandErrorKind, TrashListResponse};
use std::path::PathBuf;
use thiserror::Error;

/// Immutable startup configuration used by every trash command worker.
#[derive(Clone)]
pub(crate) struct TrashService {
    #[cfg(target_os = "linux")]
    forced_root: Option<PathBuf>,
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
            let service = Self { forced_root };
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
            Ok(Self {})
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
    pub(crate) const fn for_tests() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            forced_root: None,
        }
    }

    /// Moves one entry to the provider-selected same-device trash location.
    pub(crate) async fn trash(&self, _path: PathBuf) -> Result<(), TrashError> {
        #[cfg(target_os = "linux")]
        return linux::trash(self, _path).await;
        #[cfg(target_os = "macos")]
        return macos::trash(_path).await;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash is unsupported on this platform",
        ))
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

    /// Resolves opaque identifiers before restoring one payload to an explicit destination.
    pub(crate) async fn restore(
        &self,
        _location_id: &str,
        _item_id: &str,
        _destination: PathBuf,
    ) -> Result<PathBuf, TrashError> {
        #[cfg(target_os = "linux")]
        return linux::restore(self, _location_id, _item_id, _destination).await;
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
