//! Systemd unit management bodies shared by REST, the agent protocol and the browser.
//!
//! Agents drive `systemctl`, `journalctl`, `loginctl` and `systemd-analyze` rather than D-Bus,
//! so unit and job states are kept as the strings systemd prints: their sets grow between
//! systemd versions, and an enum would turn a new state into a decode failure.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Journal lines a request shows before following, when the caller does not choose.
pub const DEFAULT_JOURNAL_LINES: u32 = 200;
/// Most journal lines one request may ask for, so a single view cannot make the agent replay
/// a whole journal before following it.
pub const MAX_JOURNAL_LINES: u32 = 10_000;

/// Whether the agent's host is managed by systemd, decided once when the agent starts.
///
/// Reported in the agent's `hello` so the UI can hide the systemd view on hosts without it
/// (macOS, Termux, most containers) and explain why instead of failing on every request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(tag = "status", rename_all = "snake_case")]
pub enum SystemdSupport {
    Available,
    /// The host has no systemd the agent can use; `reason` is shown to the user as is.
    Unavailable {
        reason: String,
    },
}

impl Default for SystemdSupport {
    /// A `hello` without the field (a scripted test agent) is treated as a host without
    /// systemd, so the server never sends systemd commands an agent did not claim to support.
    fn default() -> Self {
        Self::Unavailable {
            reason: "The agent did not report systemd support".to_string(),
        }
    }
}

/// Which systemd manager a request talks to.
///
/// Every request names its manager explicitly instead of defaulting to the agent's own, so a
/// root agent can never act on the system manager when the user meant a user's manager.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum SystemdScope {
    /// The system manager (PID 1).
    System,
    /// The per-user manager (`user@<uid>.service`) of the named account.
    User { name: String },
}

impl std::fmt::Display for SystemdScope {
    /// Short label for logs and error messages.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::System => formatter.write_str("system"),
            Self::User { name } => write!(formatter, "user {name}"),
        }
    }
}

/// The unit the agent process itself runs in, read from `/proc/self/cgroup`.
///
/// Stopping, restarting or disabling it disconnects the device, so the UI warns harder
/// before doing that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdAgentUnit {
    pub scope: SystemdScope,
    pub unit: String,
}

/// Linger and manager state of one account, for the root agent's user list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdUserSummary {
    pub name: String,
    pub uid: u32,
    /// Whether the user's manager is started at boot and kept after the last logout.
    pub linger: bool,
    /// Whether the user's manager runs now; without it the user's units cannot be managed.
    pub manager_running: bool,
}

/// `GET /api/v1/agents/{agent}/systemd`: who the agent is from systemd's point of view and,
/// for root agents, which user managers exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdOverviewResponse {
    /// Account the agent runs as, resolved from its effective UID (not `$USER`).
    pub username: String,
    pub uid: u32,
    /// Root agents manage the system manager and every user's manager; others only read the
    /// system manager and manage their own user's.
    pub is_root: bool,
    /// Whether the agent account's own user manager runs.
    pub user_manager_running: bool,
    /// Whether linger is enabled for the agent account.
    pub linger: bool,
    /// The unit the agent runs in, when it runs in a systemd service or scope.
    pub agent_unit: Option<SystemdAgentUnit>,
    /// Root agents only: regular accounts (UID 1000 and up) plus every account whose manager
    /// runs, by name. Empty for other agents, which cannot act on other users.
    pub users: Vec<SystemdUserSummary>,
    /// Whether the account list was cut at its limit.
    pub users_truncated: bool,
}

/// One unit of a manager, merged from its loaded units and its installed unit files, so
/// disabled units that are not loaded appear too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdUnitSummary {
    /// Full unit name, such as `nginx.service` or `getty@.service`.
    pub name: String,
    /// The unit type from the name's suffix, such as `service` or `timer`.
    pub unit_type: String,
    /// Absent for units that are only installed as files and not loaded.
    pub description: Option<String>,
    /// `loaded`, `not-found`, `masked`, ...; absent for unit files that are not loaded.
    pub load_state: Option<String>,
    /// `active`, `inactive`, `failed`, ...; absent for unit files that are not loaded, which
    /// are inactive.
    pub active_state: Option<String>,
    /// Type-specific state such as `running` or `exited`.
    pub sub_state: Option<String>,
    /// `enabled`, `disabled`, `static`, `masked`, ...; absent for loaded units without a unit
    /// file (devices, mounts from fstab, transient units).
    pub unit_file_state: Option<String>,
    /// The file that defines the unit, so the list can link each unit straight to its file
    /// view, which shows the unit's status beside its file. An instance such as
    /// `getty@tty1.service` reports its template's file. Absent for units without an editable
    /// file: devices, scopes, built-in units such as `-.slice`, transient units, masked
    /// units, and units that are only referenced (`not-found`).
    pub fragment_path: Option<String>,
    /// When and what a loaded `.timer` unit runs, so the list can show a `list-timers` view
    /// without one details request per timer; absent for other units and unloaded timers.
    pub timer: Option<SystemdTimerSummary>,
}

/// The schedule columns of `systemctl list-timers` for one timer in the unit list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdTimerSummary {
    /// When the timer elapses next, in Unix milliseconds; absent when nothing is scheduled.
    #[ts(type = "number | null")]
    pub next_elapse_ms: Option<u64>,
    /// When the timer last elapsed, in Unix milliseconds; absent when it never did.
    #[ts(type = "number | null")]
    pub last_trigger_ms: Option<u64>,
    /// The units the timer activates, usually the service of the same name.
    pub triggers: Vec<String>,
}

/// The schedule of a `.timer` unit, for its status page.
///
/// systemd keeps calendar and monotonic (boot or activation relative) rules apart; both are
/// reported here already converted to wall-clock time, so the UI never needs the device's
/// monotonic clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdTimerInfo {
    /// The units the timer activates (`Triggers`).
    pub triggers: Vec<String>,
    /// When the timer elapses next, in Unix milliseconds: the earlier of its next calendar
    /// and next monotonic elapse. Absent when nothing is scheduled.
    #[ts(type = "number | null")]
    pub next_elapse_ms: Option<u64>,
    /// When the timer last elapsed, in Unix milliseconds; absent when it never did.
    #[ts(type = "number | null")]
    pub last_trigger_ms: Option<u64>,
    /// The timer's rules as unit file lines, such as `OnCalendar=*-*-* 03:00:00` or
    /// `OnUnitActiveSec=1d`; calendar rules first, in systemd's order.
    pub schedules: Vec<String>,
    /// Whether a run missed while the device was off happens at the next start
    /// (`Persistent=`).
    pub persistent: bool,
}

/// `GET .../systemd/{scope}/units`: every unit of one manager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdUnitListResponse {
    pub scope: SystemdScope,
    /// Sorted by name.
    pub units: Vec<SystemdUnitSummary>,
    /// The response is one control frame, so the list is bounded; true when units were left
    /// out.
    pub truncated: bool,
    /// Whether this agent may start, stop, enable and disable units of this manager.
    pub can_manage: bool,
}

/// `GET .../systemd/{scope}/units/{unit}`: the status of one unit.
///
/// Optional fields are absent when systemd reports no value (`[not set]`, an empty string or
/// the "infinity" sentinel), for example the memory of a stopped service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdUnitDetailsResponse {
    pub scope: SystemdScope,
    /// The unit's primary name; an alias in the URL resolves to it.
    pub id: String,
    pub description: Option<String>,
    pub load_state: Option<String>,
    pub active_state: Option<String>,
    pub sub_state: Option<String>,
    pub unit_file_state: Option<String>,
    pub unit_file_preset: Option<String>,
    /// The unit file systemd loaded, which the UI opens in the editor.
    pub fragment_path: Option<String>,
    /// Drop-in files that modify the unit, in the order systemd applies them.
    pub drop_in_paths: Vec<String>,
    /// Whether a unit file changed on disk after systemd loaded it, so a daemon-reload is due.
    pub need_daemon_reload: bool,
    #[ts(type = "number | null")]
    pub main_pid: Option<u32>,
    /// Exit status of the main process's last run.
    pub exec_main_status: Option<i32>,
    /// `success` or why the unit last failed, such as `exit-code` or `timeout`.
    pub result: Option<String>,
    /// When the unit last became active, in Unix milliseconds.
    #[ts(type = "number | null")]
    pub active_enter_timestamp_ms: Option<u64>,
    /// When the unit last became inactive, in Unix milliseconds.
    #[ts(type = "number | null")]
    pub inactive_enter_timestamp_ms: Option<u64>,
    #[ts(type = "number | null")]
    pub memory_current_bytes: Option<u64>,
    #[ts(type = "number | null")]
    pub cpu_usage_nsec: Option<u64>,
    #[ts(type = "number | null")]
    pub tasks_current: Option<u64>,
    /// Whether the unit supports `reload`, so the UI can leave the action out.
    pub can_reload: bool,
    /// Whether this agent may act on the unit.
    pub can_manage: bool,
    /// Whether the agent process runs in this unit, so stopping it disconnects the device.
    pub is_agent_unit: bool,
    /// The schedule of a `.timer` unit; absent for other unit types and for timers systemd
    /// does not know.
    pub timer: Option<SystemdTimerInfo>,
    /// Units that activate this one (`TriggeredBy`), such as the timer, socket or path unit
    /// of a service, so the UI can explain why a stopped service starts by itself.
    pub triggered_by: Vec<String>,
}

/// An operation on one unit. Each maps to the `systemctl` verb of the same name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum SystemdUnitAction {
    Start,
    Stop,
    Restart,
    Reload,
    Enable,
    Disable,
}

impl SystemdUnitAction {
    /// The `systemctl` verb that performs the action.
    pub fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Reload => "reload",
            Self::Enable => "enable",
            Self::Disable => "disable",
        }
    }
}

/// `POST .../systemd/{scope}/units/{unit}/actions`; answered with the unit's
/// [`SystemdUnitDetailsResponse`] after the action finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdUnitActionRequest {
    pub action: SystemdUnitAction,
}

/// `POST .../systemd/{scope}/daemon-reload`: the manager reloaded its unit files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdDaemonReloadResponse {
    pub scope: SystemdScope,
}

/// `PUT .../systemd/user/{user}/linger`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdLingerRequest {
    pub enabled: bool,
}

/// The linger state of one account after a change, read back from logind's state directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdLingerResponse {
    pub user: String,
    pub linger: bool,
}

/// What a manager knows about the unit a file defines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum SystemdPathUnitState {
    /// The file changed after the manager loaded the unit; a daemon-reload applies it.
    NeedsReload,
    /// The manager cannot load the unit, typically a new unit file on a systemd that does
    /// not pick up new files on demand; a daemon-reload makes it known. Current versions load
    /// new files on demand, so those report `UpToDate`.
    NotLoaded,
    /// The manager's copy matches the file.
    UpToDate,
    /// The user's manager does not run, so there is nothing to reload.
    ManagerNotRunning,
}

/// One manager whose unit search path contains a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdPathMatch {
    pub scope: SystemdScope,
    /// The unit the file defines, or the unit a drop-in file modifies.
    pub unit: String,
    /// Whether the file is a `<unit>.d/*.conf` drop-in rather than the unit file itself.
    pub drop_in: bool,
    pub state: SystemdPathUnitState,
    /// Whether this agent may run daemon-reload for the manager.
    pub can_reload: bool,
}

/// `GET .../systemd/path-status?path=&user=`: which managers a file belongs to, so the editor can
/// offer a daemon-reload after saving it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdPathStatusResponse {
    pub path: String,
    /// Empty when the file is not in any manager's unit search path.
    pub matches: Vec<SystemdPathMatch>,
}

/// Query of the path-status route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdPathStatusQuery {
    pub path: String,
    /// The user whose manager to check, for files shared by every user's manager (such as
    /// `/usr/lib/systemd/user/*`) opened from that user's unit list. Without it the agent
    /// checks its own user manager, or for a root agent the file owner's.
    #[serde(default)]
    #[ts(optional)]
    pub user: Option<String>,
}

/// Query of the journal routes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdJournalQuery {
    /// Lines of history before following; [`DEFAULT_JOURNAL_LINES`] when absent, at most
    /// [`MAX_JOURNAL_LINES`].
    #[serde(default)]
    #[ts(optional)]
    pub lines: Option<u32>,
}

/// One journal entry of a unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemdJournalEntry {
    /// When the entry was written, in Unix microseconds (`__REALTIME_TIMESTAMP`).
    #[ts(type = "number | null")]
    pub timestamp_us: Option<u64>,
    /// Syslog priority, 0 (emergency) to 7 (debug).
    pub priority: Option<u8>,
    #[ts(type = "number | null")]
    pub pid: Option<u32>,
    /// Usually the program name (`SYSLOG_IDENTIFIER`).
    pub identifier: Option<String>,
    /// The message; non-UTF-8 messages are decoded lossily.
    pub message: String,
}

/// One NDJSON line of a journal stream.
///
/// The stream shows the last lines and then follows the journal until the client goes away,
/// so it normally has no last line; `end` only appears when `journalctl` itself stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum SystemdJournalEvent {
    Entry {
        entry: SystemdJournalEntry,
    },
    /// The agent's account cannot read the system journal (it is not in `systemd-journal` or
    /// `adm`), so the entries of system units are missing. Sent before any entry.
    AccessLimited {
        message: String,
    },
    /// `journalctl` exited; `message` carries its error output when it failed.
    End {
        message: Option<String>,
    },
}
