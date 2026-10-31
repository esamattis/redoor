//! What an agent announces about itself in the `hello` that opens its connection.
//!
//! The same two values travel from the wire (`hello`, flattened so the JSON keeps its
//! flat field names) through the router's live connection and retained inventory to the REST
//! projection, instead of a dozen loose fields copied between four structs.

use crate::identity::BinaryIdentity;
use serde::{Deserialize, Serialize};

/// Who the agent process is: platform, account, start directory and binary.
///
/// Fixed for one connection; a reconnect may report a different identity (an upgraded
/// binary, a different account), which replaces the previous one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentIdentity {
    /// Operating system reported by the agent.
    pub os: String,
    /// CPU architecture reported by the agent.
    pub arch: String,
    /// Hostname reported by the agent.
    pub hostname: String,
    /// Account the agent process runs as.
    pub username: String,
    /// Immutable absolute directory opened when the UI selects this agent.
    #[serde(rename = "cwd")]
    pub default_directory: String,
    /// Compile-time identity of the agent binary.
    pub binary: BinaryIdentity,
    /// Effective UID captured at connect so chmod gating does not depend on `$USER`.
    pub uid: u32,
    /// Derived from the effective UID, never from the username, so systemd `User=` is correct.
    pub is_root: bool,
}

/// Which platform-dependent features the agent implements, so the server only offers what
/// this agent can do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCapabilities {
    /// Can launch filesystem paths in a graphical desktop.
    pub supports_native_open: bool,
    /// Implements the trash inventory and restore commands.
    pub supports_trash: bool,
    /// Can move filesystem entries to its platform trash.
    pub supports_move_to_trash: bool,
    /// Checks `RawUpload::precondition` before publishing. Older agents ignore the field,
    /// so the server refuses vault writes to agents that do not announce this.
    #[serde(default)]
    pub supports_upload_preconditions: bool,
}
