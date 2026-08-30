use crate::commands::{CommandErrorKind, CreationOwnershipOptions};
use nix::unistd::{Gid, Group, Uid, User};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use thiserror::Error;

/// Serializes passwd/group access because getpwent/getpwnam share process-global libc state.
static NSS_LOCK: Mutex<()> = Mutex::new(());

/// Holds the NSS lock even after a previous lookup panicked, so one poison cannot block chown.
pub(crate) fn with_nss_lock<T>(callback: impl FnOnce() -> T) -> T {
    let _guard = NSS_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    callback()
}

/// Reports ownership validation, account lookup, and filesystem failures without losing API meaning.
#[derive(Debug, Error)]
pub enum OwnershipError {
    #[error("{0}")]
    InvalidOptions(String),
    #[error("Owner '{0}' does not exist on the agent")]
    UnknownOwner(String),
    #[error("Group '{0}' does not exist on the agent")]
    UnknownGroup(String),
    #[error("Failed to resolve owner '{name}': {source}")]
    ResolveOwner {
        name: String,
        #[source]
        source: nix::Error,
    },
    #[error("Failed to resolve group '{name}': {source}")]
    ResolveGroup {
        name: String,
        #[source]
        source: nix::Error,
    },
    #[error("Ownership lookup worker failed: {0}")]
    LookupWorker(String),
    #[error("Failed to inspect parent directory ownership: {0}")]
    InspectParent(#[source] std::io::Error),
    #[error("Failed to set ownership: {0}")]
    Apply(#[source] std::io::Error),
}

impl OwnershipError {
    /// Maps user input errors to 400-class command results and filesystem failures by errno.
    pub fn kind(&self) -> CommandErrorKind {
        match self {
            Self::InvalidOptions(_) | Self::UnknownOwner(_) | Self::UnknownGroup(_) => {
                CommandErrorKind::InvalidInput
            }
            Self::ResolveOwner { .. } | Self::ResolveGroup { .. } | Self::LookupWorker(_) => {
                CommandErrorKind::Internal
            }
            Self::InspectParent(error) | Self::Apply(error) => {
                CommandErrorKind::from_io_error(error)
            }
        }
    }
}

/// Identifies where one ownership dimension should come from after validation and name lookup.
#[derive(Clone, Copy, Debug)]
enum OwnershipSelection {
    Unchanged,
    Explicit(u32),
    Parent,
}

/// Holds resolved ownership intent so invalid account names fail before creating output.
#[derive(Clone, Copy, Debug)]
pub struct OwnershipPlan {
    owner: OwnershipSelection,
    group: OwnershipSelection,
}

/// Carries the optional IDs passed to one atomic chown operation.
#[derive(Clone, Copy, Debug)]
pub struct ResolvedOwnership {
    uid: Option<u32>,
    gid: Option<u32>,
}

impl OwnershipPlan {
    /// Resolves explicit account names while selecting safe defaults for root-created entries.
    pub async fn resolve(
        options: CreationOwnershipOptions,
        existing_ids: Option<(u32, u32)>,
    ) -> Result<Self, OwnershipError> {
        options.validate().map_err(OwnershipError::InvalidOptions)?;
        let owner = resolve_owner_selection(&options, existing_ids.map(|ids| ids.0)).await?;
        let group = resolve_group_selection(&options, existing_ids.map(|ids| ids.1)).await?;
        Ok(Self { owner, group })
    }

    /// Resolves only requested names so existing-entry chown never inherits parent ownership.
    pub async fn for_existing_entry(
        owner: Option<String>,
        group: Option<String>,
    ) -> Result<Self, OwnershipError> {
        if owner.as_ref().is_some_and(|value| value.trim().is_empty()) {
            return Err(OwnershipError::InvalidOptions(
                "Owner cannot be empty".to_string(),
            ));
        }
        if group.as_ref().is_some_and(|value| value.trim().is_empty()) {
            return Err(OwnershipError::InvalidOptions(
                "Group cannot be empty".to_string(),
            ));
        }
        let owner = match owner {
            Some(owner) => OwnershipSelection::Explicit(resolve_owner(&owner).await?),
            None => OwnershipSelection::Unchanged,
        };
        let group = match group {
            Some(group) => OwnershipSelection::Explicit(resolve_group(&group).await?),
            None => OwnershipSelection::Unchanged,
        };
        Ok(Self { owner, group })
    }

    /// Converts explicit and unchanged selections without inspecting a parent directory.
    pub fn resolved(&self) -> ResolvedOwnership {
        ResolvedOwnership {
            uid: selection_id(self.owner, None),
            gid: selection_id(self.group, None),
        }
    }

    /// Reads the immediate parent only when at least one requested dimension inherits from it.
    pub async fn for_parent(&self, parent: &Path) -> Result<ResolvedOwnership, OwnershipError> {
        let needs_parent = matches!(self.owner, OwnershipSelection::Parent)
            || matches!(self.group, OwnershipSelection::Parent);
        let parent_ids = if needs_parent {
            use std::os::unix::fs::MetadataExt;
            let metadata = tokio::fs::metadata(parent)
                .await
                .map_err(OwnershipError::InspectParent)?;
            Some((metadata.uid(), metadata.gid()))
        } else {
            None
        };

        Ok(ResolvedOwnership {
            uid: selection_id(self.owner, parent_ids.map(|ids| ids.0)),
            gid: selection_id(self.group, parent_ids.map(|ids| ids.1)),
        })
    }
}

impl ResolvedOwnership {
    /// Applies both dimensions together so a partial request leaves the other one untouched.
    pub async fn apply(&self, path: &Path) -> Result<(), OwnershipError> {
        if self.uid.is_none() && self.gid.is_none() {
            return Ok(());
        }
        let path = PathBuf::from(path);
        let uid = self.uid;
        let gid = self.gid;
        tokio::task::spawn_blocking(move || std::os::unix::fs::chown(path, uid, gid))
            .await
            .map_err(|error| OwnershipError::LookupWorker(error.to_string()))?
            .map_err(OwnershipError::Apply)
    }
}

/// Uses an explicit UID/name, an explicit inheritance choice, or the root-agent creation default.
async fn resolve_owner_selection(
    options: &CreationOwnershipOptions,
    existing_uid: Option<u32>,
) -> Result<OwnershipSelection, OwnershipError> {
    if let Some(owner) = &options.owner {
        return resolve_owner(owner).await.map(OwnershipSelection::Explicit);
    }
    Ok(inheritance_selection(options.inherit_owner, existing_uid))
}

/// Uses an explicit GID/name, an explicit inheritance choice, or the root-agent creation default.
async fn resolve_group_selection(
    options: &CreationOwnershipOptions,
    existing_gid: Option<u32>,
) -> Result<OwnershipSelection, OwnershipError> {
    if let Some(group) = &options.group {
        return resolve_group(group).await.map(OwnershipSelection::Explicit);
    }
    Ok(inheritance_selection(options.inherit_group, existing_gid))
}

/// Defaults root-created entries to existing ownership for replacement or parent ownership for creation.
fn inheritance_selection(explicit: Option<bool>, existing_id: Option<u32>) -> OwnershipSelection {
    match explicit {
        Some(true) => OwnershipSelection::Parent,
        Some(false) => OwnershipSelection::Unchanged,
        None if Uid::effective().is_root() => existing_id
            .map(OwnershipSelection::Explicit)
            .unwrap_or(OwnershipSelection::Parent),
        None => OwnershipSelection::Unchanged,
    }
}

/// Extracts an ID from a resolved selection and its optional parent metadata.
fn selection_id(selection: OwnershipSelection, parent_id: Option<u32>) -> Option<u32> {
    match selection {
        OwnershipSelection::Unchanged => None,
        OwnershipSelection::Explicit(id) => Some(id),
        OwnershipSelection::Parent => parent_id,
    }
}

/// Resolves a decimal UID directly or performs NSS-backed user-name lookup off the async runtime.
async fn resolve_owner(owner: &str) -> Result<u32, OwnershipError> {
    if let Ok(uid) = owner.parse::<u32>() {
        return Ok(uid);
    }
    let owner = owner.to_string();
    let lookup_name = owner.clone();
    tokio::task::spawn_blocking(move || with_nss_lock(|| User::from_name(&lookup_name)))
        .await
        .map_err(|error| OwnershipError::LookupWorker(error.to_string()))?
        .map_err(|source| OwnershipError::ResolveOwner {
            name: owner.clone(),
            source,
        })?
        .map(|user| user.uid.as_raw())
        .ok_or(OwnershipError::UnknownOwner(owner))
}

/// Resolves a decimal GID directly or performs NSS-backed group-name lookup off the async runtime.
async fn resolve_group(group: &str) -> Result<u32, OwnershipError> {
    if let Ok(gid) = group.parse::<u32>() {
        return Ok(gid);
    }
    let group = group.to_string();
    let lookup_name = group.clone();
    tokio::task::spawn_blocking(move || with_nss_lock(|| Group::from_name(&lookup_name)))
        .await
        .map_err(|error| OwnershipError::LookupWorker(error.to_string()))?
        .map_err(|source| OwnershipError::ResolveGroup {
            name: group.clone(),
            source,
        })?
        .map(|entry| entry.gid.as_raw())
        .ok_or(OwnershipError::UnknownGroup(group))
}

/// Resolves display names off the async runtime so command futures never block on NSS.
pub async fn names_for_ids(
    uid: u32,
    gid: u32,
) -> Result<(Option<String>, Option<String>), OwnershipError> {
    tokio::task::spawn_blocking(move || {
        with_nss_lock(|| {
            let owner = User::from_uid(Uid::from_raw(uid))
                .ok()
                .flatten()
                .map(|user| user.name);
            let group = Group::from_gid(Gid::from_raw(gid))
                .ok()
                .flatten()
                .map(|group| group.name);
            (owner, group)
        })
    })
    .await
    .map_err(|error| OwnershipError::LookupWorker(error.to_string()))
}
