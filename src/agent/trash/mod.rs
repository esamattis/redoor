#[cfg(target_os = "linux")]
mod linux;

use redoor::commands::{CommandErrorKind, TrashListResponse};
use std::path::PathBuf;
use thiserror::Error;

/// Immutable startup configuration used by every trash command worker.
#[derive(Clone)]
pub(crate) struct TrashService {
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
                    "Trash directory cannot be configured on an unsupported platform",
                ));
            }
            Ok(Self { forced_root: None })
        }
    }

    /// Advertises the service only on targets with a complete provider.
    pub(crate) const fn supported(&self) -> bool {
        cfg!(target_os = "linux")
    }

    /// Supplies inert configuration to tests that do not execute trash commands.
    #[cfg(test)]
    pub(crate) const fn for_tests() -> Self {
        Self { forced_root: None }
    }

    /// Moves one entry to the provider-selected same-device trash location.
    pub(crate) async fn trash(&self, path: PathBuf) -> Result<(), TrashError> {
        #[cfg(target_os = "linux")]
        return linux::trash(self, path).await;
        #[cfg(not(target_os = "linux"))]
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

    /// Resolves opaque identifiers against fresh inventory before restoring one payload.
    pub(crate) async fn restore(
        &self,
        location_id: &str,
        item_id: &str,
    ) -> Result<PathBuf, TrashError> {
        #[cfg(target_os = "linux")]
        return linux::restore(self, location_id, item_id).await;
        #[cfg(not(target_os = "linux"))]
        Err(TrashError::new(
            CommandErrorKind::InvalidInput,
            "Trash is unsupported on this platform",
        ))
    }

    /// Exposes the immutable override only inside the platform provider.
    fn forced_root(&self) -> Option<&std::path::Path> {
        self.forced_root.as_deref()
    }
}
