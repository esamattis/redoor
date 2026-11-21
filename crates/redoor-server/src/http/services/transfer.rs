//! Starting copies and moves between agent paths, shared by REST copy, REST move and MCP.

use crate::actors::router::{
    CopyContentKind, CopyOperation, CopyTarget, ResumeVerification, RouterHandle, RouterMsg,
    StartCopyRequest,
};
use crate::http::{
    agent_client::{AgentClient, GitRevisionStat, MoveMetadata},
    agent_helpers::require_absolute_path,
    error::ApiError,
};
use crate::workspaces::AgentKey;
use redoor_core::{log, partials::SEGMENT_SIZE};
use redoor_protocol::{
    api::{
        git::revision::validate_revision,
        transfers::{CopyEndpoint, CopyExistingMode, ResumeMode, TransferProgressEntry},
    },
    ids::TransferId,
    wire::{
        command::{GitRevisionStatKind, MoveSourceIdentity},
        log::Level,
        partials::{
            PartialAuthorization, PartialIdentity, PartialOperation, PartialTransfer, SignedPartial,
        },
    },
};
use tokio::sync::watch;

/// One requested copy or move.
pub(crate) struct CopySpec {
    /// Workspace owner whose devices are being copied between.
    pub(crate) owner: String,
    /// Copy keeps the source; move deletes it after the destination is published.
    pub(crate) op: CopyOperation,
    pub(crate) source: CopyEndpoint,
    pub(crate) dest: CopyEndpoint,
    pub(crate) on_existing: CopyExistingMode,
    /// Auto continues a verified partial; restart discards it.
    pub(crate) resume: ResumeMode,
    /// Whether the caller needs the terminal outcome after public history may be pruned (MCP
    /// operation records); REST clients poll the progress API instead.
    pub(crate) observe_terminal: bool,
}

/// One requested copy whose source is read from Git history.
pub(crate) struct RevisionCopySpec {
    /// Workspace owner whose devices are being copied between.
    pub(crate) owner: String,
    pub(crate) source: CopyEndpoint,
    /// A commit id, branch, tag or other revision; resolved to a commit before streaming.
    pub(crate) rev: String,
    pub(crate) dest: CopyEndpoint,
    pub(crate) on_existing: CopyExistingMode,
}

/// An admitted copy or move.
pub(crate) struct StartedCopy {
    /// Public id used by progress listings and cancellation.
    pub(crate) transfer_id: TransferId,
    /// Terminal outcome, present when the spec asked to observe it.
    pub(crate) terminal: Option<watch::Receiver<Option<TransferProgressEntry>>>,
}

/// What the source is, as far as choosing a copy mode is concerned.
struct SourceShape {
    total_bytes: u64,
    content_kind: CopyContentKind,
    identity: MoveSourceIdentity,
}

/// Admits copies and moves; the router runs them.
#[derive(Clone, Debug)]
pub(crate) struct TransferService {
    agents: AgentClient,
    router: RouterHandle,
    /// Shared so the lazily loaded key is read from disk once per server process.
    signer: std::sync::Arc<redoor_core::partial_signatures::PartialSigner>,
}

impl TransferService {
    /// Creates the service on the shared router.
    pub(crate) fn new(router: RouterHandle, data_dir: std::path::PathBuf) -> Self {
        Self {
            signer: std::sync::Arc::new(redoor_core::partial_signatures::PartialSigner::new(
                data_dir,
            )),
            agents: AgentClient::new(router.clone()),
            router,
        }
    }

    /// Validates the endpoints, inspects the source and starts the transfer.
    ///
    /// The source's filesystem identity lets the router delete only the object a move copied,
    /// and binds a resumable partial to the exact source it was copied from.
    pub(crate) async fn start_copy(&self, spec: CopySpec) -> Result<StartedCopy, ApiError> {
        let source_path = require_absolute_path(spec.source.path.clone())?;
        let dest_path = require_absolute_path(spec.dest.path.clone())?;
        if spec.source.agent == spec.dest.agent && source_path == dest_path {
            return Err(ApiError::bad_request(
                "Source and destination must be different",
            ));
        }
        let source_key = AgentKey::new(&spec.owner, spec.source.agent.clone());
        let dest_key = AgentKey::new(&spec.owner, spec.dest.agent.clone());
        let source = self
            .inspect_source(spec.op, &source_key, &source_path)
            .await?;
        let mut partial = match source.content_kind {
            CopyContentKind::RawFile => Some(Box::new(PartialTransfer {
                signed: self
                    .sign_partial(&spec, &source_path, &dest_path, &source.identity)
                    .await?,
                resume: spec.resume,
                offset: 0,
                expected_partial: None,
            })),
            CopyContentKind::TarDirectory => None,
        };
        // Same-agent copies verify inside the agent's own command, without router round trips.
        let resume_verification = if spec.source.agent != spec.dest.agent
            && spec.resume == ResumeMode::Auto
            && let Some(partial) = &mut partial
            && let Some(record) = self
                .candidate(
                    &source_key,
                    &source_path,
                    &dest_key,
                    &dest_path,
                    &source.identity,
                )
                .await?
        {
            // The destination must reopen exactly the inode whose prefix gets verified.
            partial.expected_partial = Some(PartialIdentity {
                device: record.manifest.partial_device,
                inode: record.manifest.partial_inode,
            });
            Some(ResumeVerification {
                end: record.partial_bytes.min(source.identity.size) / SEGMENT_SIZE * SEGMENT_SIZE,
                key: record.key,
            })
        } else {
            None
        };
        let (terminal, terminal_receiver) = if spec.observe_terminal {
            let (sender, receiver) = watch::channel(None);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let transfer_id = self
            .router
            .request(|reply| {
                RouterMsg::StartCopyRest(StartCopyRequest {
                    target: CopyTarget {
                        source_agent_id: source_key.clone(),
                        source_path: source_path.clone(),
                        dest_agent_id: dest_key.clone(),
                        dest_path: dest_path.clone(),
                        total_bytes: source.total_bytes,
                        content_kind: source.content_kind,
                        on_existing: spec.on_existing,
                        operation: spec.op,
                        source_identity: Some(source.identity),
                        partial,
                        source_rev: None,
                        executable: false,
                    },
                    resume_verification,
                    terminal,
                    reply,
                })
            })
            .await??;
        log!(
            Level::Debug,
            "Transfer started: transfer_id={}, operation={}, source_agent={}, source_path={}, dest_agent={}, dest_path={}, total_bytes={}",
            transfer_id,
            spec.op.label(),
            spec.source.agent,
            source_path,
            spec.dest.agent,
            dest_path,
            source.total_bytes
        );
        Ok(StartedCopy {
            transfer_id,
            terminal: terminal_receiver,
        })
    }

    /// Validates the endpoints, resolves the revision and starts a copy from Git history.
    ///
    /// The revision is resolved to a commit once, here, and the transfer streams that commit,
    /// so a branch that moves meanwhile cannot change what arrives. History has no inode to
    /// resume from or delete, so these copies are never resumable and never moves. Copying a
    /// revision onto its own working path is allowed, since that is how a file is restored.
    pub(crate) async fn start_revision_copy(
        &self,
        spec: RevisionCopySpec,
    ) -> Result<TransferId, ApiError> {
        let source_path = require_absolute_path(spec.source.path.clone())?;
        let dest_path = require_absolute_path(spec.dest.path.clone())?;
        validate_revision(&spec.rev).map_err(ApiError::bad_request)?;
        let source_key = AgentKey::new(&spec.owner, spec.source.agent.clone());
        let dest_key = AgentKey::new(&spec.owner, spec.dest.agent.clone());
        // Only a replacement on the repository's own agent can delete its `.git`.
        let replace_target = (spec.on_existing == CopyExistingMode::Override
            && spec.dest.agent == spec.source.agent)
            .then(|| dest_path.clone());
        let stat = self
            .agents
            .call(
                &source_key,
                GitRevisionStat {
                    path: source_path.clone(),
                    rev: spec.rev.clone(),
                    replace_target,
                },
            )
            .await?;
        let (total_bytes, content_kind, executable) = match stat.kind {
            GitRevisionStatKind::File { size, executable } => {
                (size, CopyContentKind::RawFile, executable)
            }
            // Archive size is unknown until the agent walks the tree.
            GitRevisionStatKind::Directory => (0, CopyContentKind::TarDirectory, false),
            GitRevisionStatKind::Symlink | GitRevisionStatKind::Submodule => {
                return Err(ApiError::bad_request(
                    "Only files and directories can be copied from a Git revision",
                ));
            }
        };
        if stat.replaces_repository {
            return Err(ApiError::bad_request(
                "Replacing this directory would delete the repository's .git directory, which \
a committed tree does not contain; merge into it instead",
            ));
        }
        let transfer_id = self
            .router
            .request(|reply| {
                RouterMsg::StartCopyRest(StartCopyRequest {
                    target: CopyTarget {
                        source_agent_id: source_key.clone(),
                        source_path: source_path.clone(),
                        dest_agent_id: dest_key.clone(),
                        dest_path: dest_path.clone(),
                        total_bytes,
                        content_kind,
                        on_existing: spec.on_existing,
                        operation: CopyOperation::Copy,
                        source_identity: None,
                        partial: None,
                        source_rev: Some(stat.commit_id.clone()),
                        executable,
                    },
                    resume_verification: None,
                    terminal: None,
                    reply,
                })
            })
            .await??;
        log!(
            Level::Debug,
            "Revision copy started: transfer_id={}, source_agent={}, source_path={}, commit={}, dest_agent={}, dest_path={}, total_bytes={}",
            transfer_id,
            spec.source.agent,
            source_path,
            stat.commit_id,
            spec.dest.agent,
            dest_path,
            total_bytes
        );
        Ok(transfer_id)
    }

    /// Authorizes the destination to keep a resumable partial of exactly this source.
    async fn sign_partial(
        &self,
        spec: &CopySpec,
        source_path: &str,
        dest_path: &str,
        identity: &MoveSourceIdentity,
    ) -> Result<SignedPartial, ApiError> {
        self.signer
            .sign_for_owner(
                &spec.owner,
                PartialAuthorization {
                    version: 1,
                    source_agent_id: spec.source.agent.clone(),
                    source_path: source_path.to_string(),
                    source_identity: identity.clone(),
                    dest_agent_id: spec.dest.agent.clone(),
                    dest_path: dest_path.to_string(),
                    operation: match spec.op {
                        CopyOperation::Copy => PartialOperation::Copy,
                        CopyOperation::Move => PartialOperation::Move,
                    },
                    on_existing: spec.on_existing,
                    created_at: redoor_core::partials::now(),
                },
            )
            .await
            .map_err(|error| ApiError::internal(format!("Cannot sign partial: {error}")))
    }

    /// Verifies server authorization and binds it to the workspace owner and agent returning
    /// the manifest.
    pub(crate) async fn verify(
        &self,
        owner: &str,
        agent: &redoor_protocol::ids::AgentId,
        record: &redoor_protocol::wire::partials::PartialRecord,
    ) -> Result<bool, ApiError> {
        let valid = &record.manifest.signed.authorization.dest_agent_id == agent
            && self
                .signer
                .verify_for_owner(owner, &record.manifest.signed)
                .await
                .map_err(|error| ApiError::bad_request(error.to_string()))?;
        if !valid {
            log!(
                Level::Info,
                "Ignoring unverifiable partial: agent={}, key={}",
                agent,
                record.key
            );
        }
        Ok(valid)
    }

    /// Preflight and ordinary copy share identity comparison; neither hashes here.
    pub(crate) async fn candidate(
        &self,
        source_agent: &AgentKey,
        source_path: &str,
        dest_agent: &AgentKey,
        dest_path: &str,
        identity: &MoveSourceIdentity,
    ) -> Result<Option<redoor_protocol::wire::partials::PartialRecord>, ApiError> {
        let candidate = self
            .agents
            .call(
                dest_agent,
                crate::http::agent_client::ProbePartial {
                    dest_path: dest_path.into(),
                },
            )
            .await?;
        let Some(record) = candidate else {
            return Ok(None);
        };
        if !self
            .verify(&dest_agent.owner, &dest_agent.id, &record)
            .await?
        {
            return Ok(None);
        }
        let authorization = &record.manifest.signed.authorization;
        if authorization.source_agent_id != source_agent.id
            || authorization.source_path != source_path
            || &authorization.source_identity != identity
            || authorization.dest_path != dest_path
        {
            log!(
                Level::Info,
                "Ignoring stale partial: key={}, saved_identity={:?}, live_identity={:?}",
                record.key,
                authorization.source_identity,
                identity
            );
            return Ok(None);
        }
        Ok(Some(record))
    }

    /// Reads the source metadata the operation needs and picks raw-file or archive transport.
    async fn inspect_source(
        &self,
        op: CopyOperation,
        agent_id: &AgentKey,
        path: &str,
    ) -> Result<SourceShape, ApiError> {
        let path = path.to_string();
        let metadata = self.agents.call(agent_id, MoveMetadata { path }).await?;
        let (file_size, is_file, is_dir) = (metadata.file_size, metadata.is_file, metadata.is_dir);
        let (total_bytes, content_kind) = if is_file {
            (file_size, CopyContentKind::RawFile)
        } else if is_dir {
            // Archive size is unknown until the agent walks the tree.
            (0, CopyContentKind::TarDirectory)
        } else {
            return Err(ApiError::bad_request(format!(
                "{} supports regular files and directories only",
                op.title()
            )));
        };
        Ok(SourceShape {
            total_bytes,
            content_kind,
            identity: metadata.identity,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::fake_agent::FakeAgent;
    use axum::http::StatusCode;
    use redoor_protocol::wire::command::{Command, MoveMetadataResult};
    use redoor_protocol::wire::request;

    /// A spec between two paths of the fake agent.
    fn spec(agent: &FakeAgent, op: CopyOperation, source: &str, dest: &str) -> CopySpec {
        CopySpec {
            owner: agent.agent_id.owner.clone(),
            op,
            source: CopyEndpoint {
                agent: agent.agent_id.id.clone(),
                path: source.to_string(),
            },
            dest: CopyEndpoint {
                agent: agent.agent_id.id.clone(),
                path: dest.to_string(),
            },
            on_existing: CopyExistingMode::Error,
            resume: Default::default(),
            observe_terminal: true,
        }
    }

    /// Invalid endpoints are rejected before any agent work.
    #[tokio::test]
    async fn rejects_identical_and_relative_endpoints() {
        let mut agent = FakeAgent::connect().await;
        let service = TransferService::new(
            agent.router.clone(),
            std::env::temp_dir().join(format!("redoor-signer-{}", uuid::Uuid::new_v4())),
        );
        let same = service
            .start_copy(spec(&agent, CopyOperation::Copy, "/a", "/a"))
            .await
            .err()
            .unwrap();
        // Copying a path onto itself is a client error for REST and MCP alike.
        assert_eq!(same.status_code(), StatusCode::BAD_REQUEST);
        let relative = service
            .start_copy(spec(&agent, CopyOperation::Move, "a", "/b"))
            .await
            .err()
            .unwrap();
        // Relative paths would depend on the agent's working directory.
        assert_eq!(relative.to_string(), "Filesystem path must be absolute");
        // Neither request reached the agent.
        assert!(agent.commands.try_recv().is_err());
    }

    /// Special files are refused with an operation-specific message.
    #[tokio::test]
    async fn rejects_sources_that_are_neither_files_nor_directories() {
        let mut agent = FakeAgent::connect().await;
        let service = TransferService::new(
            agent.router.clone(),
            std::env::temp_dir().join(format!("redoor-signer-{}", uuid::Uuid::new_v4())),
        );
        let started = tokio::spawn({
            let spec = spec(&agent, CopyOperation::Copy, "/dev/null", "/b");
            async move { service.start_copy(spec).await }
        });
        let (request_id, command) = agent.next_command().await;
        // Copies capture the source identity too, so a resumable partial is bound to it.
        assert!(matches!(
            command,
            Command::MoveMetadata(request::MoveMetadata { .. })
        ));
        agent
            .respond_ok::<request::MoveMetadata>(
                request_id,
                MoveMetadataResult {
                    file_size: 5,
                    is_file: false,
                    is_dir: false,
                    identity: MoveSourceIdentity {
                        device: 1,
                        inode: 2,
                        size: 5,
                        modified_seconds: 3,
                        modified_nanoseconds: 4,
                        is_directory: false,
                    },
                },
            )
            .await;
        let error = started.await.unwrap().err().unwrap();
        assert_eq!(
            error.to_string(),
            "Copy supports regular files and directories only"
        );
    }

    /// A move captures the source identity so only the copied object is deleted later.
    #[tokio::test]
    async fn move_forwards_the_captured_source_identity() {
        let mut agent = FakeAgent::connect().await;
        let service = TransferService::new(
            agent.router.clone(),
            std::env::temp_dir().join(format!("redoor-signer-{}", uuid::Uuid::new_v4())),
        );
        let started = tokio::spawn({
            let spec = spec(&agent, CopyOperation::Move, "/src", "/dst");
            async move { service.start_copy(spec).await }
        });
        let (request_id, command) = agent.next_command().await;
        // Moves read the filesystem identity, not just metadata.
        assert!(matches!(
            command,
            Command::MoveMetadata(request::MoveMetadata { .. })
        ));
        let identity = redoor_protocol::wire::command::MoveSourceIdentity {
            device: 1,
            inode: 2,
            size: 5,
            modified_seconds: 3,
            modified_nanoseconds: 4,
            is_directory: false,
        };
        agent
            .respond_ok::<request::MoveMetadata>(
                request_id,
                MoveMetadataResult {
                    file_size: 5,
                    is_file: true,
                    is_dir: false,
                    identity: identity.clone(),
                },
            )
            .await;
        let started = started.await.unwrap().unwrap();
        // Observers get the terminal lane they asked for.
        assert!(started.terminal.is_some());
        let (_, command) = agent.next_command().await;
        // The same-agent move carries exactly the identity read before copying.
        assert!(matches!(
            command,
            Command::LocalMove(request::LocalMove { expected_identity, .. }) if expected_identity == identity
        ));
    }
}
