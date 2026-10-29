//! The deadline and operation name of every one-shot agent request REST and MCP use.
//!
//! The requests themselves, and the response each one decodes to, are the protocol's
//! [`AgentRequest`] types; this table only adds what the server decides about them.
//! Deadlines live here and nowhere else: most requests use [`STANDARD_TIMEOUT`]; requests with
//! an agent-enforced time limit wait that limit plus [`AGENT_LIMIT_MARGIN`] so the agent reports
//! its own partial result first; process control uses [`QUICK_TIMEOUT`].

use super::AgentCall;
use redoor_protocol::api::search::{FindRequest, GrepRequest};
pub(crate) use redoor_protocol::wire::request::{
    ChmodPath, ChownPath, ContentGrep, CreateDirectory, DeletePartial, DirectorySize, Echo,
    EmptyTrash, FileSearch, GetAgentDetails, GetLoggingLevel, GitCommitDiff, GitCommitNeighbors,
    GitContext, GitDiff, GitLog, GitRefList, GitRevisionContent, GitRevisionStat, GitRevisionTree,
    GitStatus, GitWorktreeList, GitWorktreeStatus, ListAccounts, ListPartials, ListTrash, Ls,
    Metadata, MoveMetadata, OpenPath, ProbePartial, RawDelete, ReadPartial, RenamePath, Restart,
    RestoreTrash, SelfExec, SetLoggingLevel, Trash,
};
use std::time::Duration;

/// Deadline for ordinary filesystem, git and inventory commands.
pub(crate) const STANDARD_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for process control that answers immediately or not at all.
pub(crate) const QUICK_TIMEOUT: Duration = Duration::from_secs(5);
/// Deadline for counting one worktree's changes, which may first wait for the walks of other
/// checkouts the agent queues ahead of it.
pub(crate) const GIT_WORKTREE_STATUS_TIMEOUT: Duration = Duration::from_secs(120);
/// Deadline for permanently deleting every trash entry, which can touch many files.
pub(crate) const EMPTY_TRASH_TIMEOUT: Duration = Duration::from_secs(300);
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
}

impl AgentCall for FileSearch {
    const OPERATION: &'static str = "searching files";

    fn timeout(&self) -> Option<Duration> {
        agent_limited(self.timeout_seconds)
    }
}

impl AgentCall for ContentGrep {
    const OPERATION: &'static str = "searching file contents";

    fn timeout(&self) -> Option<Duration> {
        agent_limited(self.timeout_seconds)
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

    /// One status walk fits the standard deadline, but the agent runs only a few at a time,
    /// so a row of a long list may queue behind the walks of the rows before it.
    fn timeout(&self) -> Option<Duration> {
        Some(GIT_WORKTREE_STATUS_TIMEOUT)
    }
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

impl AgentCall for Restart {
    const OPERATION: &'static str = "restarting the agent";

    fn timeout(&self) -> Option<Duration> {
        Some(QUICK_TIMEOUT)
    }
}

/// Builds a file-name search below `path` from its REST request.
pub(crate) fn file_search(path: String, request: FindRequest) -> FileSearch {
    FileSearch {
        path,
        query: request.query,
        timeout_seconds: request.timeout,
        include_hidden: request.include_hidden,
        respect_gitignore: request.respect_gitignore,
        case_sensitivity: request.case_sensitivity,
        directories_only: request.directories_only,
    }
}

/// Builds a content search below `path` from its REST request.
pub(crate) fn content_grep(path: String, request: GrepRequest) -> ContentGrep {
    ContentGrep {
        path,
        query: request.query,
        timeout_seconds: request.timeout,
        include_hidden: request.include_hidden,
        respect_gitignore: request.respect_gitignore,
        fixed_string: request.fixed_string,
        case_sensitivity: request.case_sensitivity,
        before_context: request.before_context,
        after_context: request.after_context,
    }
}
