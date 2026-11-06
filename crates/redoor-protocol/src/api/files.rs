//! Filesystem listing, metadata, and mutation bodies.

use crate::ids::UnixTimestampSeconds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Selects explicit or parent-derived ownership for a newly created filesystem entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreationOwnershipOptions {
    /// Accepts either a user name or a numeric UID resolved by the agent host.
    pub owner: Option<String>,
    /// Accepts either a group name or a numeric GID resolved by the agent host.
    pub group: Option<String>,
    /// Overrides the root-agent default when present.
    pub inherit_owner: Option<bool>,
    /// Overrides the root-agent default when present.
    pub inherit_group: Option<bool>,
}

impl CreationOwnershipOptions {
    /// Rejects ambiguous ownership requests before any filesystem mutation starts.
    pub fn validate(&self) -> Result<(), String> {
        if self
            .owner
            .as_ref()
            .is_some_and(|owner| owner.trim().is_empty())
        {
            return Err("Owner cannot be empty".to_string());
        }
        if self
            .group
            .as_ref()
            .is_some_and(|group| group.trim().is_empty())
        {
            return Err("Group cannot be empty".to_string());
        }
        if self.owner.is_some() && self.inherit_owner == Some(true) {
            return Err("Cannot specify both owner and inherit_owner=true".to_string());
        }
        if self.group.is_some() && self.inherit_group == Some(true) {
            return Err("Cannot specify both group and inherit_group=true".to_string());
        }
        Ok(())
    }
}

/// File facts the UI needs before choosing how to open a path (download, edit or preview).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MetadataResponse {
    pub path: String,
    pub mime_type: String,
    #[ts(type = "number")]
    pub file_size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    /// True only when the agent verified the whole file is UTF-8 and small enough to edit safely.
    pub editable: bool,
    /// True only when the agent verified content magic bytes and size allow in-browser image viewing.
    pub viewable_image: bool,
    /// Outstanding process-local download tokens for this exact agent and path.
    pub one_time_tokens: Vec<String>,
}

/// Returns the recursive regular-file bytes stored below one directory.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DirectorySizeResponse {
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
    pub errors: Vec<DirectorySizeError>,
}

/// Describes one filesystem entry omitted from a partial directory-size result.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DirectorySizeError {
    pub path: String,
    pub error: String,
}

/// Returns the opaque single-use credential without exposing registry internals.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateOneTimeTokenResponse {
    /// UUID accepted once by the matching agent raw-download path.
    pub one_time_token: String,
}

/// Describes one directory entry completely enough to render and sort a file list.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String,
    #[ts(type = "number")]
    pub size: u64,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub modified_at: UnixTimestampSeconds,
}

/// Exposes directory entries and metadata so clients can provide alternate directory views.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsDirectoryResponse {
    pub files: Vec<LsEntry>,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub permissions: u32,
}

/// Exposes remote file metadata needed by clients to present a useful detail view.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LsFileResponse {
    #[ts(type = "number")]
    pub size: u64,
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub permissions: u32,
    /// Whether the agent's user may run the file, so the file view offers running it only
    /// when the shell would not refuse. Mode bits alone cannot tell: they ignore the user's
    /// groups and `noexec` mounts.
    pub executable: bool,
}

/// Reports the written path and byte count so clients can confirm the upload landed intact.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RawUploadResponse {
    pub path: String,
    #[ts(type = "number")]
    pub bytes_written: u64,
}

/// Confirms that an editor body was committed to the selected existing inode.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileEditResponse {
    pub path: String,
    #[ts(type = "number")]
    pub bytes_written: u64,
}

/// Echoes the deleted path so clients can update listings without re-deriving it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RawDeleteResponse {
    pub path: String,
}

/// Echoes the created directory path so clients can navigate to it directly.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateDirectoryResponse {
    pub path: String,
}

/// Keeps rename inside one directory so the operation remains an atomic metadata change.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenamePathRequest {
    pub dir: String,
    pub old: String,
    pub new: String,
}

/// Confirms the source path was atomically moved to the requested destination.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenamePathResponse {
    pub source_path: String,
    pub dest_path: String,
}

/// Accepts name or numeric owner/group strings for an existing-entry chown.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChownPathRequest {
    /// User name or decimal UID; omitted when only the group should change.
    #[serde(default)]
    pub owner: Option<String>,
    /// Group name or decimal GID; omitted when only the owner should change.
    #[serde(default)]
    pub group: Option<String>,
}

/// Returns the followed inode's ownership so UID/GID stay in sync after a name mapping.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChownPathResponse {
    pub path: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub uid: u32,
    pub gid: u32,
}

/// Carries the ordinary 9-bit mode the details grid can display and mutate.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChmodPathRequest {
    pub permissions: u32,
}

/// Returns the applied rwx bits so symbolic, octal, and grid views update together.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChmodPathResponse {
    pub path: String,
    pub permissions: u32,
}
