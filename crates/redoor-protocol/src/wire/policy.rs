//! Execution policy for every wire command.
//!
//! The agent decides admission, cancellation and task ownership from this table and the
//! server derives upload semantics from it, so a new command is classified in exactly one
//! exhaustive match instead of several hand-maintained `matches!` lists that can drift.

use crate::api::transfers::TransferDirection;
use crate::wire::command::Command;

/// Socket lanes a command occupies while it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandLane {
    /// Request and response are control frames only.
    Control,
    /// The agent streams output bytes to the server on the request's stream.
    Output,
    /// The server streams input bytes to the agent on the request's stream.
    Upload(UploadKind),
}

/// Distinguishes inbound byte streams that share transport but not publication semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadKind {
    /// Replaces or creates one file through a sibling staging file.
    RawUpload,
    /// Extracts a tar stream into a sibling staging directory before placement.
    TarUpload,
    /// Rewrites an existing inode in place after staging the full body.
    EditFile,
}

impl UploadKind {
    /// Selects the direction exposed through transfer progress APIs.
    pub fn direction(self) -> TransferDirection {
        match self {
            Self::RawUpload | Self::TarUpload => TransferDirection::Upload,
            Self::EditFile => TransferDirection::Edit,
        }
    }
}

/// How a running command reacts to explicit cancellation and connection loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelScope {
    /// Dropped when its control connection ends; there is no explicit cancel message for it.
    Connection,
    /// Registered by request id so `cancel` and connection loss stop it
    /// cooperatively, letting the command remove its staging output before it reports.
    Request,
    /// Runs to completion even when the connection ends because interrupting a half-applied
    /// mutation (trash rename, purge) would be worse than delaying teardown.
    Uninterruptible,
}

/// Admission and lifecycle rules for one command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandPolicy {
    /// Whether the command streams bytes, and in which direction.
    pub lane: CommandLane,
    /// Which cancellation sources stop the command and whether it may be dropped.
    pub cancel_scope: CancelScope,
    /// Serialized with every other exclusive command because they mutate shared agent-owned
    /// state (the trash inventory) that concurrent writers could corrupt.
    pub exclusive: bool,
}

impl CommandPolicy {
    /// Ordinary request/response command that can be dropped on disconnect.
    const CONTROL: Self = Self {
        lane: CommandLane::Control,
        cancel_scope: CancelScope::Connection,
        exclusive: false,
    };
    /// Request/response work that can run far longer than its caller cares (searches, status
    /// walks), so an abandoned REST call must stop it on the agent instead of letting it hold
    /// CPU, disk and command slots until its own timeout.
    const CANCELABLE_CONTROL: Self = Self {
        lane: CommandLane::Control,
        cancel_scope: CancelScope::Request,
        exclusive: false,
    };
    /// Same-agent work that owns staging output and must clean it up when canceled.
    const LOCAL_TRANSFER: Self = Self {
        lane: CommandLane::Control,
        cancel_scope: CancelScope::Request,
        exclusive: false,
    };
    /// Agent-to-server byte stream.
    const OUTPUT: Self = Self {
        lane: CommandLane::Output,
        cancel_scope: CancelScope::Request,
        exclusive: false,
    };

    /// Server-to-agent byte stream with the given publication semantics.
    const fn upload(kind: UploadKind) -> Self {
        Self {
            lane: CommandLane::Upload(kind),
            cancel_scope: CancelScope::Request,
            exclusive: false,
        }
    }

    /// Trash mutation that must not interleave with other trash mutations.
    const fn trash_mutation(cancel_scope: CancelScope) -> Self {
        Self {
            lane: CommandLane::Control,
            cancel_scope,
            exclusive: true,
        }
    }

    /// Whether the command carries a byte stream in either direction.
    pub fn streams_bytes(&self) -> bool {
        !matches!(self.lane, CommandLane::Control)
    }

    /// Upload semantics when the command receives a server-to-agent byte stream.
    pub fn upload_kind(&self) -> Option<UploadKind> {
        match self.lane {
            CommandLane::Upload(kind) => Some(kind),
            CommandLane::Control | CommandLane::Output => None,
        }
    }
}

impl Command {
    /// Returns the single authoritative execution policy for this command.
    pub fn policy(&self) -> CommandPolicy {
        match self {
            Self::Exec { .. }
            | Self::RawDownload { .. }
            | Self::TarDownload { .. }
            | Self::GitDownload { .. } => CommandPolicy::OUTPUT,
            Self::RawUpload { .. } => CommandPolicy::upload(UploadKind::RawUpload),
            Self::TarUpload { .. } => CommandPolicy::upload(UploadKind::TarUpload),
            Self::EditFile { .. } => CommandPolicy::upload(UploadKind::EditFile),
            Self::LocalCopyFile { .. }
            | Self::LocalCopyDirectory { .. }
            | Self::LocalMove { .. } => CommandPolicy::LOCAL_TRANSFER,
            Self::Trash { .. } | Self::EmptyTrash(_) => {
                CommandPolicy::trash_mutation(CancelScope::Uninterruptible)
            }
            // Restore is a move that reports progress and owns staging, so it stays cancelable.
            Self::RestoreTrash { .. } => CommandPolicy::trash_mutation(CancelScope::Request),
            Self::HashSegments(_) => CommandPolicy::LOCAL_TRANSFER,
            Self::FileSearch { .. } | Self::ContentGrep { .. } | Self::GitWorktreeStatus { .. } => {
                CommandPolicy::CANCELABLE_CONTROL
            }
            Self::ListPartials(_)
            | Self::ProbePartial(_)
            | Self::ReadPartial(_)
            | Self::DeletePartial(_)
            | Self::PersistPartial(_)
            | Self::Ls { .. }
            | Self::RawDelete { .. }
            | Self::ListTrash(_)
            | Self::CreateDirectory { .. }
            | Self::RenamePath { .. }
            | Self::ChownPath { .. }
            | Self::ChmodPath { .. }
            | Self::ListAccounts(_)
            | Self::Metadata { .. }
            | Self::DirectorySize { .. }
            | Self::GitContext { .. }
            | Self::GitStatus { .. }
            | Self::GitDiff { .. }
            | Self::GitRevisionTree { .. }
            | Self::GitRevisionContent { .. }
            | Self::GitCommitDiff { .. }
            | Self::GitLog { .. }
            | Self::GitCommitNeighbors { .. }
            | Self::GitRefList { .. }
            | Self::GitWorktreeList { .. }
            | Self::GitRevisionStat { .. }
            | Self::MoveMetadata { .. }
            | Self::DeleteMoveSource { .. }
            | Self::OpenPath { .. }
            | Self::Echo { .. }
            | Self::GetAgentDetails(_)
            | Self::GetLoggingLevel(_)
            | Self::SetLoggingLevel { .. }
            | Self::Restart(_)
            | Self::SelfExec { .. } => CommandPolicy::CONTROL,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::agents::EchoRequest;
    use crate::api::files::CreationOwnershipOptions;
    use crate::api::git::GitPage;
    use crate::api::git::refs::{GitBranchScope, GitRefListKind, GitRefSort};
    use crate::api::git::worktree::GitDiffMode;
    use crate::api::search::CaseSensitivity;
    use crate::api::transfers::CopyExistingMode;
    use crate::wire::command::MoveSourceIdentity;
    use crate::wire::exec::ExecRequest;
    use crate::wire::log::Level;
    use crate::wire::request;

    /// Maps every variant to a dense index; adding a variant fails to compile here first, and
    /// the coverage assertion below then forces a matching sample.
    fn variant_index(command: &Command) -> usize {
        match command {
            Command::Exec(request::Exec { .. }) => 0,
            Command::Ls(request::Ls { .. }) => 1,
            Command::FileSearch(request::FileSearch { .. }) => 2,
            Command::ContentGrep(request::ContentGrep { .. }) => 3,
            Command::RawDownload(request::RawDownload { .. }) => 4,
            Command::TarDownload(request::TarDownload { .. }) => 5,
            Command::ListPartials(_) => 36,
            Command::ProbePartial(_) => 37,
            Command::ReadPartial(_) => 38,
            Command::DeletePartial(_) => 39,
            Command::HashSegments(_) => 40,
            Command::PersistPartial(_) => 41,
            Command::RawUpload(request::RawUpload { .. }) => 6,
            Command::EditFile(request::EditFile { .. }) => 7,
            Command::TarUpload(request::TarUpload { .. }) => 8,
            Command::LocalCopyFile(request::LocalCopyFile { .. }) => 9,
            Command::LocalCopyDirectory(request::LocalCopyDirectory { .. }) => 10,
            Command::LocalMove(request::LocalMove { .. }) => 11,
            Command::RawDelete(request::RawDelete { .. }) => 12,
            Command::Trash(request::Trash { .. }) => 13,
            Command::ListTrash(request::ListTrash {}) => 14,
            Command::EmptyTrash(request::EmptyTrash {}) => 15,
            Command::RestoreTrash(request::RestoreTrash { .. }) => 16,
            Command::CreateDirectory(request::CreateDirectory { .. }) => 17,
            Command::RenamePath(request::RenamePath { .. }) => 18,
            Command::ChownPath(request::ChownPath { .. }) => 19,
            Command::ChmodPath(request::ChmodPath { .. }) => 20,
            Command::ListAccounts(request::ListAccounts {}) => 21,
            Command::Metadata(request::Metadata { .. }) => 22,
            Command::DirectorySize(request::DirectorySize { .. }) => 23,
            Command::GitContext(request::GitContext { .. }) => 24,
            Command::GitStatus(request::GitStatus { .. }) => 25,
            Command::GitDiff(request::GitDiff { .. }) => 26,
            Command::MoveMetadata(request::MoveMetadata { .. }) => 27,
            Command::DeleteMoveSource(request::DeleteMoveSource { .. }) => 28,
            Command::OpenPath(request::OpenPath { .. }) => 29,
            Command::Echo(request::Echo { .. }) => 30,
            Command::GetAgentDetails(request::GetAgentDetails {}) => 31,
            Command::GetLoggingLevel(request::GetLoggingLevel {}) => 32,
            Command::SetLoggingLevel(request::SetLoggingLevel { .. }) => 33,
            Command::Restart(request::Restart {}) => 34,
            Command::SelfExec(request::SelfExec { .. }) => 35,
            Command::GitRevisionTree(request::GitRevisionTree { .. }) => 42,
            Command::GitRevisionContent(request::GitRevisionContent { .. }) => 43,
            Command::GitCommitDiff(request::GitCommitDiff { .. }) => 44,
            Command::GitLog(request::GitLog { .. }) => 45,
            Command::GitRefList(request::GitRefList { .. }) => 46,
            Command::GitRevisionStat(request::GitRevisionStat { .. }) => 47,
            Command::GitDownload(request::GitDownload { .. }) => 48,
            Command::GitCommitNeighbors(request::GitCommitNeighbors { .. }) => 49,
            Command::GitWorktreeList(request::GitWorktreeList { .. }) => 50,
            Command::GitWorktreeStatus(request::GitWorktreeStatus { .. }) => 51,
        }
    }

    /// Number of variants covered by `variant_index`.
    const VARIANT_COUNT: usize = 52;

    /// Builds one instance of every command variant for table-wide policy checks.
    fn every_command() -> Vec<Command> {
        let path = || "/tmp/path".to_string();
        let identity = MoveSourceIdentity {
            device: 1,
            inode: 2,
            size: 3,
            modified_seconds: 4,
            modified_nanoseconds: 5,
            is_directory: false,
        };
        vec![
            Command::ListPartials(request::ListPartials {}),
            Command::ProbePartial(request::ProbePartial { dest_path: path() }),
            Command::ReadPartial(request::ReadPartial {
                key: "0".repeat(64),
            }),
            Command::DeletePartial(request::DeletePartial {
                key: "0".repeat(64),
            }),
            Command::PersistPartial(request::PersistPartial {
                key: "0".repeat(64),
                signed: None,
            }),
            Command::HashSegments(request::HashSegments {
                path: path(),
                start: 0,
                end: 1,
                partial_key: None,
                expected_identity: None,
            }),
            Command::Exec(request::Exec {
                request: ExecRequest {
                    argv: vec!["true".to_string()],
                    cwd: None,
                    env: Default::default(),
                    timeout_ms: None,
                },
            }),
            Command::Ls(request::Ls { path: None }),
            Command::FileSearch(request::FileSearch {
                path: path(),
                query: "q".to_string(),
                timeout_seconds: 1,
                include_hidden: false,
                respect_gitignore: true,
                case_sensitivity: CaseSensitivity::Smart,
                directories_only: false,
            }),
            Command::ContentGrep(request::ContentGrep {
                path: path(),
                query: "q".to_string(),
                timeout_seconds: 1,
                include_hidden: false,
                respect_gitignore: true,
                fixed_string: false,
                case_sensitivity: CaseSensitivity::Smart,
                before_context: 0,
                after_context: 0,
            }),
            Command::RawDownload(request::RawDownload {
                expected_identity: None,
                path: path(),
                range_start: None,
                range_end: None,
            }),
            Command::TarDownload(request::TarDownload {
                path: path(),
                include_root: false,
            }),
            Command::RawUpload(request::RawUpload {
                partial: None,
                path: path(),
                on_existing: CopyExistingMode::Override,
                ownership: CreationOwnershipOptions::default(),
                executable: false,
            }),
            Command::EditFile(request::EditFile { path: path() }),
            Command::TarUpload(request::TarUpload {
                path: path(),
                on_existing: CopyExistingMode::Error,
            }),
            Command::LocalCopyFile(request::LocalCopyFile {
                partial: None,
                source_path: path(),
                dest_path: path(),
                on_existing: CopyExistingMode::Error,
            }),
            Command::LocalCopyDirectory(request::LocalCopyDirectory {
                source_path: path(),
                dest_path: path(),
                on_existing: CopyExistingMode::Error,
            }),
            Command::LocalMove(request::LocalMove {
                partial: None,
                source_path: path(),
                dest_path: path(),
                source_is_directory: false,
                expected_identity: identity.clone(),
                on_existing: CopyExistingMode::Error,
            }),
            Command::RawDelete(request::RawDelete { path: path() }),
            Command::Trash(request::Trash { path: path() }),
            Command::ListTrash(request::ListTrash {}),
            Command::EmptyTrash(request::EmptyTrash {}),
            Command::RestoreTrash(request::RestoreTrash {
                location_id: "l".to_string(),
                item_id: "i".to_string(),
                destination_path: path(),
            }),
            Command::CreateDirectory(request::CreateDirectory {
                path: path(),
                ownership: CreationOwnershipOptions::default(),
            }),
            Command::RenamePath(request::RenamePath {
                dir: path(),
                old: "a".to_string(),
                new: "b".to_string(),
            }),
            Command::ChownPath(request::ChownPath {
                path: path(),
                owner: None,
                group: None,
            }),
            Command::ChmodPath(request::ChmodPath {
                path: path(),
                permissions: 0o644,
            }),
            Command::ListAccounts(request::ListAccounts {}),
            Command::Metadata(request::Metadata { path: path() }),
            Command::DirectorySize(request::DirectorySize {
                path: path(),
                timeout_seconds: 1,
            }),
            Command::GitContext(request::GitContext { path: path() }),
            Command::GitStatus(request::GitStatus { path: path() }),
            Command::GitDiff(request::GitDiff {
                files: Vec::new(),
                mode: GitDiffMode::Full,
            }),
            Command::GitRevisionTree(request::GitRevisionTree {
                path: path(),
                rev: "HEAD".to_string(),
            }),
            Command::GitRevisionContent(request::GitRevisionContent {
                path: path(),
                rev: "HEAD".to_string(),
            }),
            Command::GitCommitDiff(request::GitCommitDiff {
                path: path(),
                rev: "HEAD".to_string(),
            }),
            Command::GitLog(request::GitLog {
                path: path(),
                rev: None,
                page: GitPage { skip: 0, limit: 1 },
            }),
            Command::GitCommitNeighbors(request::GitCommitNeighbors {
                path: path(),
                rev: "HEAD".to_string(),
            }),
            Command::GitRefList(request::GitRefList {
                path: path(),
                kind: GitRefListKind::Tags,
                sort: GitRefSort::Recent,
                scope: GitBranchScope::All,
                page: GitPage { skip: 0, limit: 1 },
            }),
            Command::GitWorktreeList(request::GitWorktreeList { path: path() }),
            Command::GitWorktreeStatus(request::GitWorktreeStatus {
                paths: vec![path()],
            }),
            Command::GitRevisionStat(request::GitRevisionStat {
                path: path(),
                rev: "HEAD".to_string(),
                replace_target: None,
            }),
            Command::GitDownload(request::GitDownload {
                path: path(),
                rev: "HEAD".to_string(),
                include_root: false,
            }),
            Command::MoveMetadata(request::MoveMetadata { path: path() }),
            Command::DeleteMoveSource(request::DeleteMoveSource {
                path: path(),
                expected_identity: identity,
            }),
            Command::OpenPath(request::OpenPath { path: path() }),
            Command::Echo(request::Echo {
                request: EchoRequest {
                    message: "m".to_string(),
                    random_sleep: false,
                },
            }),
            Command::GetAgentDetails(request::GetAgentDetails {}),
            Command::GetLoggingLevel(request::GetLoggingLevel {}),
            Command::SetLoggingLevel(request::SetLoggingLevel { level: Level::Info }),
            Command::Restart(request::Restart {}),
            Command::SelfExec(request::SelfExec { path: path() }),
        ]
    }

    /// Verifies the policy samples cover every command variant.
    #[test]
    fn samples_cover_every_command_variant() {
        let mut seen = vec![false; VARIANT_COUNT];
        for command in every_command() {
            seen[variant_index(&command)] = true;
        }
        // Every variant needs a sample so the consistency checks below see the whole policy table.
        assert!(
            seen.iter().all(|covered| *covered),
            "missing samples: {seen:?}"
        );
    }

    /// Verifies every transfer-lane command can be canceled by request id.
    #[test]
    fn streaming_commands_are_request_cancelable() {
        for command in every_command() {
            let policy = command.policy();
            if policy.streams_bytes() {
                // Byte streams own staging output or a server consumer, so cancel must reach them.
                assert_eq!(
                    policy.cancel_scope,
                    CancelScope::Request,
                    "{} streams bytes but cannot be canceled by request id",
                    command.summary()
                );
            }
        }
    }

    /// Verifies the long-running read commands stop on the agent when their caller gives up.
    #[test]
    fn searches_and_status_walks_are_request_cancelable() {
        for command in every_command() {
            if matches!(
                command,
                Command::FileSearch(_) | Command::ContentGrep(_) | Command::GitWorktreeStatus(_)
            ) {
                // Without a request-scoped token an abandoned search keeps its slots until its
                // own timeout, so superseded UI searches would queue behind stale ones.
                assert_eq!(
                    command.policy().cancel_scope,
                    CancelScope::Request,
                    "{} cannot be canceled by request id",
                    command.summary()
                );
            }
        }
    }

    /// Verifies exclusive commands are never abortable.
    #[test]
    fn exclusive_commands_are_never_dropped_mid_mutation() {
        for command in every_command() {
            let policy = command.policy();
            if policy.exclusive {
                // Dropping a future that holds the exclusive slot could abandon a half-applied mutation.
                assert_ne!(
                    policy.cancel_scope,
                    CancelScope::Connection,
                    "{} is exclusive but abortable",
                    command.summary()
                );
            }
        }
    }

    /// Verifies upload kinds match their commands.
    #[test]
    fn upload_lane_matches_the_command() {
        let expected = [
            (6, UploadKind::RawUpload),
            (7, UploadKind::EditFile),
            (8, UploadKind::TarUpload),
        ];
        let uploads: Vec<_> = every_command()
            .into_iter()
            .filter_map(|command| {
                command
                    .policy()
                    .upload_kind()
                    .map(|kind| (variant_index(&command), kind))
            })
            .collect();
        // Exactly the three upload commands may grant upload credit and receive chunks.
        assert_eq!(uploads.len(), expected.len());
        for (index, kind) in expected {
            // The server routes chunks and completion by this kind, so it must match the command.
            assert!(uploads.contains(&(index, kind)));
        }
        // Edits keep their own progress direction so the UI can distinguish inode rewrites.
        assert!(matches!(
            UploadKind::EditFile.direction(),
            TransferDirection::Edit
        ));
    }
}
