//! The router's single table of in-flight work.
//!
//! Every request the router hands to an agent belongs to exactly one flow: a one-shot command,
//! an output stream (download or exec), an upload, or a copy (which may also delete its source
//! when it is a move). One index from request id to flow replaces probing several registries in
//! turn, and explicit phase enums replace combinations of booleans.
//!
//! Request ids are scoped to the agent connection that carries them, so the index is keyed by
//! agent and request id: a frame can only ever resolve work that was sent to its own agent.

use super::RouterError;
use super::messages::{RouterReply, UploadStartOutcome};
use super::state::CopyContentKind;
use super::streams::{OutboundStream, StreamLease};
use redoor_protocol::wire::request::CommandOutcome;
use redoor_protocol::{
    ids::{AgentId, RequestId, TransferId},
    wire::{
        command::{Command, MoveSourceIdentity},
        exec::ExecEvent,
        policy::UploadKind,
    },
};
use std::collections::HashMap;

/// Identifies one flow; it is the first request id allocated for the flow.
pub(crate) type FlowId = RequestId;

/// One request as an agent sees it: the agent connection plus the id scoped to it.
pub(crate) type AgentRequest = (AgentId, RequestId);

/// One unit of in-flight work owned by the router.
pub(crate) enum Flow {
    Command(CommandFlow),
    Output(OutputFlow),
    Upload(UploadFlow),
    /// Boxed: a copy carries two stream handles and dwarfs the other flows in the table.
    Copy(Box<CopyFlow>),
}

/// A one-shot command whose REST caller waits for the final result.
pub(crate) struct CommandFlow {
    pub(crate) request_id: RequestId,
    pub(crate) agent_id: AgentId,
    /// Whether the agent registers the command for `cancel` (request cancel scope),
    /// so an abandoned caller's cancel can actually stop its work.
    pub(crate) cancelable: bool,
    pub(crate) reply: RouterReply<CommandOutcome>,
}

/// An agent-to-consumer stream: file download or process output.
pub(crate) struct OutputFlow {
    pub(crate) request_id: RequestId,
    pub(crate) agent_id: AgentId,
    pub(crate) kind: OutputKind,
    /// Shared with the consumer; cancelling it stops the data path.
    pub(crate) lease: StreamLease,
    pub(crate) phase: OutputPhase,
}

/// What an output stream carries and therefore how it ends.
pub(crate) enum OutputKind {
    /// File bytes with public transfer history, possibly continuing an earlier row.
    Download {
        progress_id: TransferId,
        /// Transferred bytes the history row already had when this stream started.
        base_bytes: u64,
    },
    /// Process events; the terminal event is also published independently of the output
    /// queue so completion stays observable when the consumer is saturated.
    Execution {
        terminal: tokio::sync::watch::Sender<Option<ExecEvent>>,
    },
    /// NDJSON search matches ending with a `done` line; no history, and the result is only
    /// read for a failure.
    Search,
}

/// Lifecycle of an output stream.
pub(crate) enum OutputPhase {
    Streaming,
    /// Cancellation was admitted and the agent's acknowledgement is pending.
    Canceling {
        /// A priority enqueue still waiting for lane capacity, aborted when the flow ends.
        retained_delivery: Option<tokio::task::JoinHandle<()>>,
    },
}

impl Drop for OutputFlow {
    /// A cancellation still waiting for lane capacity is pointless once the flow is gone.
    fn drop(&mut self) {
        if let OutputPhase::Canceling {
            retained_delivery: Some(task),
        } = &self.phase
        {
            task.abort();
        }
    }
}

/// A REST upload, archive upload or file edit streaming into one agent.
pub(crate) struct UploadFlow {
    pub(crate) request_id: RequestId,
    pub(crate) agent_id: AgentId,
    /// Defines public progress semantics and the only accepted successful result.
    pub(crate) kind: UploadKind,
    pub(crate) phase: UploadPhase,
    /// Final result for the HTTP producer.
    pub(crate) completion: Option<RouterReply<Result<CommandOutcome, RouterError>>>,
    /// Releases the HTTP producer once the agent worker exists, or reports early failure.
    pub(crate) ready: Option<RouterReply<Result<UploadStartOutcome, RouterError>>>,
    /// The router's handle on the data path, used for cancellation and router-owned terminals.
    pub(crate) stream: OutboundStream,
}

/// Lifecycle of an upload, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UploadPhase {
    /// The agent has not yet confirmed that its worker exists.
    AwaitingReady,
    /// Body frames flow directly from the HTTP producer to the agent.
    Streaming,
    /// An edit's terminal frame is router-owned; the inode rewrite can no longer be canceled.
    Committing,
    /// The agent was authorized to publish staged content; cancellation is no longer possible.
    Publishing,
    /// Cancellation was admitted; `explicit` distinguishes a user action from a vanished producer.
    Canceling { explicit: bool },
}

/// A logical copy or move between two paths, on one agent or across two.
pub(crate) struct CopyFlow {
    /// A pause's reply remains owned until destination persistence is acknowledged.
    pub(crate) pause: Option<super::messages::RouterReply<Result<(), String>>>,
    /// Whether the destination stages into a durable partial that survives failures.
    pub(crate) resumable: bool,
    /// Public transfer id shown in progress listings and used for cancellation.
    pub(crate) progress_id: TransferId,
    pub(crate) source_agent_id: AgentId,
    pub(crate) dest_agent_id: AgentId,
    pub(crate) content_kind: CopyContentKind,
    /// Follow-up after the destination is published; moves delete the verified source.
    pub(crate) then: Option<DeleteSource>,
    pub(crate) phase: CopyPhase,
}

/// Source cleanup that turns a copy into a move.
pub(crate) struct DeleteSource {
    pub(crate) path: String,
    /// Filesystem identity that must still match, so a replacement is never deleted.
    pub(crate) identity: MoveSourceIdentity,
}

/// Lifecycle of a copy.
pub(crate) enum CopyPhase {
    /// Both agents hash one prefix segment at a time before a remote resume appends.
    /// Hashing owns no byte streams and can be stopped without touching durable output.
    Verifying(Box<PrefixVerification>),
    /// The destination persists (pause) or deletes (cancel, changed source) the partial whose
    /// verification was interrupted, before the transfer settles.
    SettlingPartial {
        request_id: RequestId,
        /// Why verification failed; `None` when the user paused or canceled.
        failure: Option<String>,
    },
    /// One agent copies or moves locally and reports its own progress.
    Local { request_id: RequestId },
    /// Bytes stream from the source agent through the server to the destination agent.
    /// Boxed so the stream-less phases stay small.
    Remote(Box<RemoteCopy>),
    /// A remote move published its destination and is deleting the source.
    DeletingSource { request_id: RequestId },
}

/// Segment-by-segment comparison of a destination partial with its source.
///
/// One segment per command keeps both disks reading sequentially and lets comparison stop at
/// the first mismatch, which bounds how much a slow disk reads when the tail is torn.
pub(crate) struct PrefixVerification {
    /// Started with the verified offset once comparison ends.
    pub(crate) target: super::messages::CopyTarget,
    /// Agent-local manifest key of the destination partial.
    pub(crate) key: String,
    /// Whole-segment prefix length to compare.
    pub(crate) end: u64,
    /// Bytes verified so far; always a segment boundary.
    pub(crate) offset: u64,
    pub(crate) source: SegmentDigest,
    pub(crate) dest: SegmentDigest,
}

/// One agent's hash of the segment being compared.
pub(crate) struct SegmentDigest {
    pub(crate) request_id: RequestId,
    /// Arrives independently from each agent; comparison waits for both.
    pub(crate) digest: Option<String>,
}

/// The two streams of a cross-agent copy and how far it got.
pub(crate) struct RemoteCopy {
    /// Source download stream, consumed by the copy forwarder.
    pub(crate) source: StreamLease,
    /// Destination upload stream, fed by the copy forwarder.
    pub(crate) dest: OutboundStream,
    pub(crate) stage: RemoteStage,
    /// Whether the source already sent its terminal frame, so teardown must not cancel it.
    pub(crate) source_finished: bool,
}

/// Progress of a cross-agent copy.
pub(crate) enum RemoteStage {
    /// The source download is held back until the destination worker exists.
    AwaitingDestination {
        source_command: Command,
    },
    Streaming,
    /// Cancellation was sent; both temp-owning workers must acknowledge before it settles.
    Canceling {
        source_acked: bool,
        dest_acked: bool,
    },
}

impl RemoteCopy {
    /// Request id of the source download.
    pub(crate) fn source_id(&self) -> RequestId {
        self.source.id
    }

    /// Request id of the destination upload.
    pub(crate) fn dest_id(&self) -> RequestId {
        self.dest.request_id()
    }
}

impl CopyFlow {
    /// Whether this copy deletes its source after publishing (a move).
    pub(crate) fn is_move(&self) -> bool {
        self.then.is_some()
    }

    /// Whether a failure now leaves a resumable partial on the destination.
    ///
    /// A remote destination creates its partial before granting credit, so a failure while
    /// still awaiting it may have happened before any partial existed. A published move has
    /// consumed its partial.
    pub(crate) fn keeps_partial(&self) -> bool {
        self.resumable
            && match &self.phase {
                CopyPhase::Verifying(_)
                | CopyPhase::SettlingPartial { .. }
                | CopyPhase::Local { .. } => true,
                CopyPhase::Remote(remote) => {
                    !matches!(remote.stage, RemoteStage::AwaitingDestination { .. })
                }
                CopyPhase::DeletingSource { .. } => false,
            }
    }

    /// Whether the copy's current phase still depends on `agent_id`.
    ///
    /// Only a remote stream needs both agents, and only until the source has answered: after
    /// that the destination holds every byte, so losing the source agent must not fail a copy
    /// the destination can still publish. A local copy runs entirely on the source agent, and
    /// once a move published its destination only the source deletion is left, so losing the
    /// destination agent then must not mark a successful move as errored.
    fn involves(&self, agent_id: &AgentId) -> bool {
        match &self.phase {
            CopyPhase::Verifying(_) => {
                &self.source_agent_id == agent_id || &self.dest_agent_id == agent_id
            }
            CopyPhase::SettlingPartial { .. } => &self.dest_agent_id == agent_id,
            CopyPhase::Remote(remote) => {
                (&self.source_agent_id == agent_id && !remote.source_finished)
                    || &self.dest_agent_id == agent_id
            }
            CopyPhase::Local { .. } | CopyPhase::DeletingSource { .. } => {
                &self.source_agent_id == agent_id
            }
        }
    }
}

impl Flow {
    /// Agent requests this flow's current phase answers to.
    fn request_ids(&self) -> Vec<AgentRequest> {
        match self {
            Self::Command(flow) => vec![(flow.agent_id.clone(), flow.request_id)],
            Self::Output(flow) => vec![(flow.agent_id.clone(), flow.request_id)],
            Self::Upload(flow) => vec![(flow.agent_id.clone(), flow.request_id)],
            Self::Copy(flow) => match &flow.phase {
                CopyPhase::Verifying(verification) => vec![
                    (flow.source_agent_id.clone(), verification.source.request_id),
                    (flow.dest_agent_id.clone(), verification.dest.request_id),
                ],
                CopyPhase::SettlingPartial { request_id, .. } => {
                    vec![(flow.dest_agent_id.clone(), *request_id)]
                }
                CopyPhase::Local { request_id } | CopyPhase::DeletingSource { request_id } => {
                    vec![(flow.source_agent_id.clone(), *request_id)]
                }
                CopyPhase::Remote(remote) => vec![
                    (flow.source_agent_id.clone(), remote.source_id()),
                    (flow.dest_agent_id.clone(), remote.dest_id()),
                ],
            },
        }
    }

    /// Public transfer history row this flow owns, if any.
    pub(crate) fn progress_id(&self) -> Option<TransferId> {
        match self {
            Self::Command(_) => None,
            Self::Output(flow) => match flow.kind {
                OutputKind::Download { progress_id, .. } => Some(progress_id),
                OutputKind::Execution { .. } | OutputKind::Search => None,
            },
            Self::Upload(flow) => Some(flow.request_id.as_transfer_id()),
            Self::Copy(flow) => Some(flow.progress_id),
        }
    }

    /// Whether this flow still drives its history row, which a canceled output no longer does.
    fn owns_progress(&self) -> bool {
        !matches!(
            self,
            Self::Output(OutputFlow {
                phase: OutputPhase::Canceling { .. },
                ..
            })
        )
    }

    /// Whether this flow depends on `agent_id` at all.
    pub(crate) fn involves(&self, agent_id: &AgentId) -> bool {
        match self {
            Self::Command(flow) => &flow.agent_id == agent_id,
            Self::Output(flow) => &flow.agent_id == agent_id,
            Self::Upload(flow) => &flow.agent_id == agent_id,
            Self::Copy(flow) => flow.involves(agent_id),
        }
    }

    /// Progress row and the bytes its data path has counted, while that count is still the
    /// authoritative progress (not after cancellation took over the row).
    fn live_progress(&self) -> Option<(TransferId, u64)> {
        match self {
            Self::Command(_) => None,
            Self::Output(flow) => match (&flow.kind, &flow.phase) {
                (OutputKind::Download { progress_id, .. }, OutputPhase::Streaming) => {
                    Some((*progress_id, flow.lease.bytes()))
                }
                _ => None,
            },
            Self::Upload(flow) => {
                (!matches!(flow.phase, UploadPhase::Canceling { .. })).then(|| {
                    (
                        flow.request_id.as_transfer_id(),
                        flow.stream.lease().bytes(),
                    )
                })
            }
            Self::Copy(flow) => match &flow.phase {
                CopyPhase::Remote(remote)
                    if !matches!(remote.stage, RemoteStage::Canceling { .. }) =>
                {
                    Some((flow.progress_id, remote.dest.lease().bytes()))
                }
                _ => None,
            },
        }
    }
}

/// All in-flight flows plus the index from agent requests to flows.
#[derive(Default)]
pub(crate) struct FlowTable {
    by_request: HashMap<AgentRequest, FlowId>,
    flows: HashMap<FlowId, Flow>,
    /// The signed-in user whose request created each flow, so the agent's later answers
    /// are logged as that user's; flows started without one are absent.
    users: HashMap<FlowId, std::sync::Arc<str>>,
}

impl FlowTable {
    /// Adds a flow and indexes every request id of its current phase. The current task's
    /// user, the sender of the message that started the flow, becomes the flow's user.
    pub(crate) fn insert(&mut self, id: FlowId, flow: Flow) {
        for request_id in flow.request_ids() {
            self.by_request.insert(request_id, id);
        }
        self.flows.insert(id, flow);
        match redoor_core::logging::current_user() {
            Some(user) => self.users.insert(id, user),
            None => self.users.remove(&id),
        };
    }

    /// The user whose request created a flow, for logging the flow's later steps.
    pub(crate) fn user(&self, id: FlowId) -> Option<std::sync::Arc<str>> {
        self.users.get(&id).cloned()
    }

    /// Finds the flow a request sent to `agent_id` belongs to.
    pub(crate) fn id_for(&self, agent_id: &AgentId, request_id: RequestId) -> Option<FlowId> {
        self.by_request
            .get(&(agent_id.clone(), request_id))
            .copied()
    }

    /// Borrows one flow.
    pub(crate) fn get(&self, id: FlowId) -> Option<&Flow> {
        self.flows.get(&id)
    }

    /// Mutably borrows one flow.
    pub(crate) fn get_mut(&mut self, id: FlowId) -> Option<&mut Flow> {
        self.flows.get_mut(&id)
    }

    /// Removes a flow and its request ids.
    pub(crate) fn remove(&mut self, id: FlowId) -> Option<Flow> {
        let flow = self.flows.remove(&id)?;
        self.users.remove(&id);
        self.unindex(id, &flow);
        Some(flow)
    }

    /// Re-indexes a flow whose phase changed the request ids it answers to.
    pub(crate) fn reindex(&mut self, id: FlowId, previous: &[AgentRequest]) {
        for request_id in previous {
            if self.by_request.get(request_id) == Some(&id) {
                self.by_request.remove(request_id);
            }
        }
        if let Some(flow) = self.flows.get(&id) {
            for request_id in flow.request_ids() {
                self.by_request.insert(request_id, id);
            }
        }
    }

    /// Agent requests of one flow's current phase, captured before a phase change.
    pub(crate) fn request_ids(&self, id: FlowId) -> Vec<AgentRequest> {
        self.flows
            .get(&id)
            .map(Flow::request_ids)
            .unwrap_or_default()
    }

    /// Removes every flow matching `predicate` in a single pass over the table.
    pub(crate) fn extract_if(
        &mut self,
        mut predicate: impl FnMut(&Flow) -> bool,
    ) -> Vec<(FlowId, Flow)> {
        let extracted: Vec<_> = self.flows.extract_if(|_, flow| predicate(flow)).collect();
        for (id, flow) in &extracted {
            self.unindex(*id, flow);
            self.users.remove(id);
        }
        extracted
    }

    /// Finds the flow that owns a public transfer history row.
    ///
    /// A resumed download shares its row with the canceled stream it continues, which may
    /// still await its agent's acknowledgement; the live stream is the owner.
    pub(crate) fn find_by_progress(&self, transfer_id: TransferId) -> Option<FlowId> {
        self.flows
            .iter()
            .filter(|(_, flow)| flow.progress_id() == Some(transfer_id))
            .max_by_key(|(_, flow)| flow.owns_progress())
            .map(|(id, _)| *id)
    }

    /// Removes command flows whose REST caller already gave up, so abandoned replies do not
    /// accumulate; run from the periodic router tick instead of on every message. Returns
    /// the removed commands so the caller can cancel the cancelable ones on their agent.
    pub(crate) fn prune_abandoned_commands(&mut self) -> Vec<CommandFlow> {
        self.extract_if(|flow| match flow {
            Flow::Command(command) => command.reply.is_closed(),
            _ => false,
        })
        .into_iter()
        .filter_map(|(_, flow)| match flow {
            Flow::Command(command) => Some(command),
            _ => None,
        })
        .collect()
    }

    /// Current data-path byte counts of every flow that still owns its progress row.
    pub(crate) fn live_progress(&self) -> impl Iterator<Item = (TransferId, u64)> + '_ {
        self.flows.values().filter_map(Flow::live_progress)
    }

    /// Server-to-agent byte streams currently open into `agent_id`: uploads, edits and copy
    /// destinations, which the per-connection upload cap counts.
    pub(crate) fn uploads_into(&self, agent_id: &AgentId) -> usize {
        self.flows
            .values()
            .filter(|flow| match flow {
                Flow::Upload(upload) => &upload.agent_id == agent_id,
                Flow::Copy(copy) => {
                    matches!(copy.phase, CopyPhase::Remote(_)) && &copy.dest_agent_id == agent_id
                }
                Flow::Command(_) | Flow::Output(_) => false,
            })
            .count()
    }

    /// Number of flows, for tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.flows.len()
    }

    /// Removes a flow's request ids unless another flow has since claimed them.
    fn unindex(&mut self, id: FlowId, flow: &Flow) {
        for request_id in flow.request_ids() {
            if self.by_request.get(&request_id) == Some(&id) {
                self.by_request.remove(&request_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    /// Builds a command flow owned by `agent`.
    fn command(id: u64, agent: &str) -> (Flow, oneshot::Receiver<CommandOutcome>) {
        let (reply, receiver) = oneshot::channel();
        (
            Flow::Command(CommandFlow {
                request_id: RequestId::new(id),
                agent_id: redoor_core::test_support::test_agent_id(agent),
                cancelable: false,
                reply,
            }),
            receiver,
        )
    }

    /// One pass removes exactly the flows of a lost agent and their index entries.
    #[test]
    fn extract_if_removes_matching_flows_and_index() {
        let mut table = FlowTable::default();
        let (lost, _lost_reply) = command(1, "lost");
        let (kept, _kept_reply) = command(2, "kept");
        table.insert(RequestId::new(1), lost);
        table.insert(RequestId::new(2), kept);
        let extracted = table
            .extract_if(|flow| flow.involves(&redoor_core::test_support::test_agent_id("lost")));
        // Only the lost agent's work is settled by its disconnect.
        assert_eq!(extracted.len(), 1);
        assert_eq!(
            table.id_for(
                &redoor_core::test_support::test_agent_id("lost"),
                RequestId::new(1)
            ),
            None
        );
        // Unrelated flows and their routing survive.
        assert_eq!(
            table.id_for(
                &redoor_core::test_support::test_agent_id("kept"),
                RequestId::new(2)
            ),
            Some(RequestId::new(2))
        );
    }

    /// Request ids belong to one connection, so another agent naming them finds nothing.
    #[test]
    fn request_ids_resolve_only_for_their_own_agent() {
        let mut table = FlowTable::default();
        let (owned, _reply) = command(7, "owner");
        table.insert(RequestId::new(7), owned);
        // The owning agent's frames reach the flow.
        assert!(
            table
                .id_for(
                    &redoor_core::test_support::test_agent_id("owner"),
                    RequestId::new(7)
                )
                .is_some()
        );
        // The same number from another connection must not resolve someone else's work.
        assert!(
            table
                .id_for(
                    &redoor_core::test_support::test_agent_id("other"),
                    RequestId::new(7)
                )
                .is_none()
        );
    }

    /// Builds a cross-agent move from `source` to `dest` in a stream-less phase.
    fn move_flow(phase: CopyPhase) -> Flow {
        Flow::Copy(Box::new(CopyFlow {
            pause: None,
            resumable: false,
            progress_id: TransferId::new(1),
            source_agent_id: redoor_core::test_support::test_agent_id("source"),
            dest_agent_id: redoor_core::test_support::test_agent_id("dest"),
            content_kind: CopyContentKind::RawFile,
            then: Some(DeleteSource {
                path: "/src".to_string(),
                identity: MoveSourceIdentity {
                    device: 1,
                    inode: 2,
                    size: 3,
                    modified_seconds: 4,
                    modified_nanoseconds: 5,
                    is_directory: false,
                },
            }),
            phase,
        }))
    }

    /// Once a move published its destination only the source deletion remains, so losing the
    /// destination agent must not fail (and mark as errored) an already successful move.
    #[test]
    fn deleting_source_depends_only_on_the_source_agent() {
        let flow = move_flow(CopyPhase::DeletingSource {
            request_id: RequestId::new(9),
        });
        assert!(flow.involves(&redoor_core::test_support::test_agent_id("source")));
        assert!(!flow.involves(&redoor_core::test_support::test_agent_id("dest")));
        // A local phase likewise runs entirely on the source agent.
        let local = move_flow(CopyPhase::Local {
            request_id: RequestId::new(9),
        });
        assert!(!local.involves(&redoor_core::test_support::test_agent_id("dest")));
    }

    /// Abandoned REST replies are pruned without touching live callers.
    #[test]
    fn prune_drops_only_abandoned_commands() {
        let mut table = FlowTable::default();
        let (abandoned, abandoned_reply) = command(1, "agent");
        let (live, _live_reply) = command(2, "agent");
        table.insert(RequestId::new(1), abandoned);
        table.insert(RequestId::new(2), live);
        drop(abandoned_reply);
        let pruned = table.prune_abandoned_commands();
        // The pruned command is handed back so its agent work can be canceled.
        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].request_id, RequestId::new(1));
        // A timed-out caller's reply port must not be retained until the agent answers.
        assert_eq!(table.len(), 1);
        assert!(
            table
                .id_for(
                    &redoor_core::test_support::test_agent_id("agent"),
                    RequestId::new(2)
                )
                .is_some()
        );
    }
}
