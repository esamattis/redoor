//! The deadline and operation name of every one-shot agent request REST and MCP use.
//!
//! The requests themselves, and the response each one decodes to, are the protocol's
//! [`AgentRequest`] types; this table only adds what the server decides about them.
//! Deadlines live here and nowhere else: most requests use [`STANDARD_TIMEOUT`]; requests with
//! an agent-enforced time limit wait that limit plus [`AGENT_LIMIT_MARGIN`] so the agent reports
//! its own partial result first; process control uses [`QUICK_TIMEOUT`].

use super::AgentCall;
pub(crate) use redoor_protocol::wire::request::{
    ChmodPath, ChownPath, CreateDirectory, DeletePartial, DirectorySize, Echo, EmptyTrash,
    GetAgentDetails, GetLoggingLevel, GitCommitDiff, GitCommitNeighbors, GitContext, GitDiff,
    GitDirectoryEntries, GitFileBases, GitLog, GitRefList, GitRevisionContent, GitRevisionStat,
    GitRevisionTree, GitStatus, GitWorktreeList, GitWorktreeStatus, ListAccounts, ListPartials,
    ListTrash, Ls, Metadata, MoveMetadata, OpenPath, ProbePartial, RawDelete, ReadPartial,
    RenamePath, Restart, RestoreTrash, SelfExec, SetLoggingLevel, Trash,
};
use redoor_protocol::wire::request::{CloseTerminal, CreateTerminal};
pub(crate) use redoor_protocol::wire::request::{
    SystemdDaemonReload, SystemdJournal, SystemdListUnits, SystemdOverview, SystemdPathStatus,
    SystemdSetLinger, SystemdUnitAction, SystemdUnitDetails,
};
use std::time::Duration;

/// Deadline for ordinary filesystem, git and inventory commands.
pub(crate) const STANDARD_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for process control that answers immediately or not at all.
pub(crate) const QUICK_TIMEOUT: Duration = Duration::from_secs(5);
/// Deadline for counting worktree changes. The agent answers after a few seconds with what it
/// has counted, but waits for at least one checkout, which may be slower than its budget or
/// queue behind the walks of other requests.
pub(crate) const GIT_WORKTREE_STATUS_TIMEOUT: Duration = Duration::from_secs(120);
/// Deadline for reading the Git state of a directory's entries. The agent answers
/// `timed_out` itself after its 30 second walk budget, so this only needs to outlast that
/// with room for the reply.
pub(crate) const GIT_DIRECTORY_ENTRIES_TIMEOUT: Duration = Duration::from_secs(45);
/// Deadline for permanently deleting every trash entry, which can touch many files.
pub(crate) const EMPTY_TRASH_TIMEOUT: Duration = Duration::from_secs(300);
/// Deadline for a systemd unit action or daemon-reload, which waits for its systemd job.
/// systemd's default start and stop timeouts are 90 seconds, so a slow but working unit
/// still answers; past this the call is abandoned and the agent kills `systemctl`, while the
/// job itself keeps running in systemd.
pub(crate) const SYSTEMD_JOB_TIMEOUT: Duration = Duration::from_secs(120);
/// Extra wait beyond an agent-enforced limit so the agent's own timeout result arrives first.
pub(crate) const AGENT_LIMIT_MARGIN: Duration = Duration::from_secs(2);

/// Waits for a command whose duration the agent bounds itself.
fn agent_limited(seconds: u64) -> Option<Duration> {
    Some(Duration::from_secs(seconds) + AGENT_LIMIT_MARGIN)
}

/// Implements [`AgentCall`] with the standard deadline for requests that need nothing else.
macro_rules! standard_calls {
    ($($request:ident => $operation:literal),* $(,)?) => {
        $(
            impl AgentCall for $request {
                const OPERATION: &'static str = $operation;
            }
        )*
    };
}

standard_calls! {
    ListPartials => "listing partials",
    ProbePartial => "probing partial",
    ReadPartial => "reading partial",
    DeletePartial => "discarding partial",
    Ls => "listing a path",
    Metadata => "reading metadata",
    MoveMetadata => "reading move metadata",
    Echo => "echoing",
    ListAccounts => "listing accounts",
    ChownPath => "changing ownership",
    ChmodPath => "changing permissions",
    OpenPath => "opening a path",
    Trash => "moving a path to the trash",
    RawDelete => "deleting a path",
    CreateDirectory => "creating a directory",
    RenamePath => "renaming a path",
    ListTrash => "listing trash",
    GitContext => "reading git context",
    GitStatus => "reading git status",
    GitDiff => "reading git diff",
    GitRevisionTree => "reading a git revision tree",
    GitRevisionContent => "reading a file at a git revision",
    GitCommitDiff => "reading a git commit diff",
    GitLog => "reading git history",
    GitCommitNeighbors => "finding the neighbouring git commits",
    GitRefList => "listing git branches or tags",
    GitWorktreeList => "listing git worktrees",
    GitRevisionStat => "inspecting a path at a git revision",
    GetAgentDetails => "fetching agent details",
    SelfExec => "starting the upgraded agent",
    SystemdOverview => "reading the systemd overview",
    SystemdListUnits => "listing systemd units",
    SystemdUnitDetails => "reading a systemd unit",
    SystemdSetLinger => "changing systemd linger",
    SystemdPathStatus => "reading the systemd status of a path",
}

impl AgentCall for SystemdUnitAction {
    const OPERATION: &'static str = "running a systemd unit action";

    /// The agent waits for the unit's job, which can take as long as the unit's own timeout.
    fn timeout(&self) -> Option<Duration> {
        Some(SYSTEMD_JOB_TIMEOUT)
    }
}

impl AgentCall for SystemdDaemonReload {
    const OPERATION: &'static str = "reloading systemd";

    /// Reloading regenerates every unit, which is slow on large hosts.
    fn timeout(&self) -> Option<Duration> {
        Some(SYSTEMD_JOB_TIMEOUT)
    }
}

impl AgentCall for DirectorySize {
    const OPERATION: &'static str = "calculating directory size";

    fn timeout(&self) -> Option<Duration> {
        agent_limited(self.timeout_seconds)
    }
}

impl AgentCall for GitWorktreeStatus {
    const OPERATION: &'static str = "counting git worktree changes";

    /// The agent bounds a request to a few seconds, but always counts at least one checkout,
    /// and that one may queue behind the walks of other requests first.
    fn timeout(&self) -> Option<Duration> {
        Some(GIT_WORKTREE_STATUS_TIMEOUT)
    }
}

impl AgentCall for GitDirectoryEntries {
    const OPERATION: &'static str = "reading the git state of directory entries";

    /// Longer than the standard deadline, so the agent's own `timed_out` answer arrives
    /// instead of a gateway timeout when the walk runs to its budget.
    fn timeout(&self) -> Option<Duration> {
        Some(GIT_DIRECTORY_ENTRIES_TIMEOUT)
    }
}

impl AgentCall for GitFileBases {
    const OPERATION: &'static str = "reading the git bases of a file";
}

impl AgentCall for EmptyTrash {
    const OPERATION: &'static str = "emptying trash";

    fn timeout(&self) -> Option<Duration> {
        Some(EMPTY_TRASH_TIMEOUT)
    }
}

impl AgentCall for RestoreTrash {
    const OPERATION: &'static str = "restoring a trash item";
    /// A cross-device restore copies then deletes; interrupting it could leave the item in
    /// neither place, so it finishes even when its caller leaves.
    const RUNS_TO_COMPLETION: bool = true;

    /// Restores can copy arbitrarily large items, so only the agent bounds them.
    fn timeout(&self) -> Option<Duration> {
        None
    }
}

impl AgentCall for GetLoggingLevel {
    const OPERATION: &'static str = "reading the logging level";

    fn timeout(&self) -> Option<Duration> {
        Some(QUICK_TIMEOUT)
    }
}

impl AgentCall for SetLoggingLevel {
    const OPERATION: &'static str = "changing the logging level";

    fn timeout(&self) -> Option<Duration> {
        Some(QUICK_TIMEOUT)
    }
}

impl AgentCall for CreateTerminal {
    const OPERATION: &'static str = "starting a terminal";

    /// Starting a shell answers at once; a slow answer means the agent is in trouble.
    fn timeout(&self) -> Option<Duration> {
        Some(QUICK_TIMEOUT)
    }
}

impl AgentCall for CloseTerminal {
    const OPERATION: &'static str = "closing a terminal";
    /// The tab is already gone when the browser stops waiting, so the shell must still go.
    const RUNS_TO_COMPLETION: bool = true;

    fn timeout(&self) -> Option<Duration> {
        Some(QUICK_TIMEOUT)
    }
}

impl AgentCall for Restart {
    const OPERATION: &'static str = "restarting the agent";

    fn timeout(&self) -> Option<Duration> {
        Some(QUICK_TIMEOUT)
    }
}
