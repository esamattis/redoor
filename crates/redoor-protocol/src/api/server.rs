//! Server identity, restart and upgrade bodies.

use crate::identity::ServerBuildMode;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Server identity and authenticated agent bootstrap settings shown on the UI home page.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerInfoResponse {
    /// Filesystem and service namespace selected by `REDOOR_APP_NAME`.
    pub app_name: String,
    /// Shared registration secret included so the authenticated UI can render a working agent config.
    pub agent_token: String,
    /// Absolute path of the TOML config file this process loaded.
    pub config_path: String,
    /// Whether the server serves HTTPS with its generated self-signed certificate, so the
    /// agent config the UI renders turns certificate verification off.
    pub self_signed_tls: bool,
    /// Absolute path of the running server binary.
    pub exe_path: String,
    /// Primary non-loopback IP selected from the server's local routing table.
    pub external_ip: Option<String>,
    /// Hostname of the server machine, so browser tabs of different servers can be told apart.
    pub hostname: String,
    /// Operating system of the running server executable.
    pub os: String,
    /// CPU architecture of the running server executable.
    pub arch: String,
    /// `CARGO_PKG_VERSION` baked into this binary.
    pub version: String,
    /// Full git commit SHA (or `unknown` when git metadata was unavailable at build).
    pub git_rev: String,
    /// True when the working tree had uncommitted changes at build time.
    pub git_dirty: bool,
    /// True when HEAD was not tagged `v{version}` at build time.
    pub version_dirty: bool,
    /// Whether this binary was compiled as debug or release.
    pub build_mode: ServerBuildMode,
    /// UTC compile timestamp (`YYYY-MM-DDTHH:MM:SSZ`) or `unknown`.
    pub build_date: String,
    /// Random id of this server process image, new after every restart and re-exec.
    ///
    /// A restart keeps the PID and can be back within milliseconds, so a client waiting for
    /// it cannot rely on seeing the server go down; a changed boot id proves the new process.
    pub boot_id: String,
}

/// Confirms a server or agent accepted a restart request before its connection closes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RestartResponse {
    pub restarting: bool,
}

/// Selects the release `POST /api/v1/server/upgrade` installs over the server binary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerUpgradeRequest {
    /// Release tag such as `v1.3.1`; the latest published release when absent.
    #[serde(default)]
    pub target_version: Option<String>,
}

/// Reports a finished install; the server restarts itself right after answering.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerUpgradeResponse {
    /// Output of `install.sh`, naming the release and where it was installed.
    pub output: String,
    /// Every other local process that ran the replaced binary and what happened to it.
    pub processes: Vec<UpgradeProcessReport>,
}

/// One local process that ran the replaced binary.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpgradeProcessReport {
    /// Process ID, which an in-place restart keeps.
    pub pid: u32,
    /// Command line, so an operator can tell the processes apart.
    pub command: String,
    /// What the upgrade did with it.
    pub outcome: UpgradeProcessOutcome,
}

/// What an upgrade did with one process running the replaced binary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UpgradeProcessOutcome {
    /// It runs the new binary.
    Restarted,
    /// It was told to restart; the server cannot wait for it because it restarts too.
    Restarting,
    /// Nothing could restart it automatically, so it still runs the old version.
    LeftRunning {
        /// What the operator should do instead.
        hint: String,
    },
    /// Restarting it was attempted and failed.
    Failed {
        /// Why it failed.
        error: String,
    },
}
