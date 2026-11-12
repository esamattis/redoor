//! The server's index of terminal sessions and which browser views each of them.
//!
//! Shells and their screens live in the agents. The server keeps their records, as each
//! agent last reported them, so every window can list them, and it decides which one browser
//! views a session. Records stay while their agent is disconnected, because the shells keep
//! running there and come back with the agent. Nothing is saved: a restarted server starts
//! empty and learns each agent's sessions from the report it sends after connecting, because
//! that report is the only authority on which shells still run.

use super::TerminalsChangedNotifier;
use crate::http::agent_client::AgentClient;
use crate::http::error::ApiError;
use redoor_core::log;
use redoor_protocol::{
    api::terminals::{CreateTerminalSessionRequest, TerminalSessionInfo, TerminalSessionStatus},
    ids::{AgentId, TerminalSessionId},
    wire::{
        log::Level,
        request::{CloseTerminal, CreateTerminal},
        terminal::{TerminalServerMessage, TerminalSessionRecord},
    },
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokio::sync::oneshot;

/// Why a session the agent stopped reporting ended: the agent process was restarted, which
/// ends every shell it ran.
const ENDED_WITH_AGENT: &str = "Shell ended when its device restarted";
/// Closes remembered for agents that are away. Bounded, because an agent that never comes
/// back would otherwise keep them forever; losing one only lets that shell run on.
const MAX_PENDING_CLOSES: usize = 256;

/// Why the server let go of a viewer. Sent apart from the data path, so it arrives even when
/// a slow browser has not taken the output queued for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DetachReason {
    /// Another browser attached.
    TakenOver,
    /// The session was closed.
    Closed,
}

impl DetachReason {
    /// The message the browser gets, so it can tell a takeover from a dropped connection.
    pub(crate) fn message(self) -> TerminalServerMessage {
        match self {
            Self::TakenOver => TerminalServerMessage::TakenOver,
            Self::Closed => TerminalServerMessage::Closed,
        }
    }
}

/// One browser's claim on viewing a session.
pub(crate) struct ViewerTicket {
    /// Identifies this viewer when it detaches.
    pub(crate) serial: u64,
    pub(crate) agent_id: AgentId,
    pub(crate) reason: oneshot::Receiver<DetachReason>,
    /// Set when the agent no longer runs the session, so there is nothing to attach to and
    /// the browser only learns why it ended.
    pub(crate) ended: Option<TerminalServerMessage>,
}

/// Cheap-to-clone handle to the index. The lock is never held across `.await`.
#[derive(Clone)]
pub(crate) struct TerminalRegistry {
    state: Arc<Mutex<RegistryState>>,
    agents: AgentClient,
    notifier: TerminalsChangedNotifier,
}

/// The sessions in the order the server learned them, and closes still owed to agents.
#[derive(Default)]
struct RegistryState {
    sessions: Vec<Entry>,
    pending_closes: Vec<PendingClose>,
    next_serial: u64,
}

/// A session closed while its agent was away; the agent is told when it reconnects.
struct PendingClose {
    agent_id: AgentId,
    id: TerminalSessionId,
}

/// One session and its current viewer.
struct Entry {
    agent_id: AgentId,
    record: TerminalSessionRecord,
    /// The agent stopped reporting the session because it was restarted. The record stays,
    /// exited, so the tab can show why and offer a new shell instead of vanishing.
    orphaned: bool,
    viewer: Option<Viewer>,
}

/// The browser currently viewing a session.
struct Viewer {
    serial: u64,
    release: oneshot::Sender<DetachReason>,
}

impl Entry {
    /// Tells the current viewer why it was let go.
    fn release_viewer(&mut self, reason: DetachReason) {
        if let Some(viewer) = self.viewer.take() {
            let _ = viewer.release.send(reason);
        }
    }

    /// The session as every browser window lists it.
    fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: self.record.id,
            agent_id: self.agent_id.clone(),
            cwd: self.record.cwd.clone(),
            title: self.record.title.clone(),
            number: self.record.number,
            created_at: self.record.created_at,
            status: self.record.status.clone(),
            activity: self.record.activity.clone(),
            attached: self.viewer.is_some(),
        }
    }
}

impl RegistryState {
    /// Whether the session's close still has to reach its agent.
    fn close_pending(&self, agent_id: &AgentId, id: TerminalSessionId) -> bool {
        self.pending_closes
            .iter()
            .any(|close| &close.agent_id == agent_id && close.id == id)
    }
}

impl TerminalRegistry {
    /// Starts empty; each agent's first report after connecting lists its sessions.
    pub(crate) fn new(agents: AgentClient, notifier: TerminalsChangedNotifier) -> Self {
        Self {
            state: Arc::new(Mutex::new(RegistryState::default())),
            agents,
            notifier,
        }
    }

    /// An empty index whose agent calls fail at once, as if no agent were connected, and
    /// whose changes go nowhere, for tests.
    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self::new(
            AgentClient::new(crate::actors::router::RouterHandle::closed_for_test()),
            TerminalsChangedNotifier::disabled(),
        )
    }

    /// Locks the index, tolerating poison because every operation leaves it valid.
    fn state(&self) -> MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a shell with the extra variables `env` on the agent and lists its session. The
    /// session is listed before the reply, so a list fetched after the reply already contains
    /// it.
    pub(crate) async fn create(
        &self,
        agent_id: AgentId,
        request: CreateTerminalSessionRequest,
        env: BTreeMap<String, String>,
    ) -> Result<TerminalSessionInfo, ApiError> {
        let call = CreateTerminal {
            id: TerminalSessionId::new(),
            cwd: request.cwd,
            title: request.title,
            number: request.number,
            size: request.size,
            env,
        };
        let record = self.agents.call(&agent_id, call).await?;
        let mut state = self.state();
        // The agent's own report of the new session may have arrived first.
        let index = match state
            .sessions
            .iter()
            .position(|entry| entry.record.id == record.id)
        {
            Some(index) => index,
            None => {
                state.sessions.push(Entry {
                    agent_id,
                    record,
                    orphaned: false,
                    viewer: None,
                });
                state.sessions.len() - 1
            }
        };
        let info = state.sessions[index].info();
        drop(state);
        self.notifier.publish();
        Ok(info)
    }

    /// Every session, in the order the server learned them.
    pub(crate) fn list(&self) -> Vec<TerminalSessionInfo> {
        self.state().sessions.iter().map(Entry::info).collect()
    }

    /// Whether a session is listed, so attaching to an unknown one is refused before the
    /// upgrade.
    pub(crate) fn contains(&self, id: TerminalSessionId) -> bool {
        self.state()
            .sessions
            .iter()
            .any(|entry| entry.record.id == id)
    }

    /// Makes the caller the session's only viewer; the previous one is told it was taken
    /// over. `None` when the session is gone.
    pub(crate) fn attach(&self, id: TerminalSessionId) -> Option<ViewerTicket> {
        let mut state = self.state();
        state.next_serial += 1;
        let serial = state.next_serial;
        let entry = state
            .sessions
            .iter_mut()
            .find(|entry| entry.record.id == id)?;
        entry.release_viewer(DetachReason::TakenOver);
        let (release, reason) = oneshot::channel();
        entry.viewer = Some(Viewer { serial, release });
        let agent_id = entry.agent_id.clone();
        let ended = entry.orphaned.then(|| TerminalServerMessage::Error {
            message: ENDED_WITH_AGENT.to_string(),
        });
        self.notifier.publish();
        Some(ViewerTicket {
            serial,
            agent_id,
            reason,
            ended,
        })
    }

    /// Forgets the viewer if it is still the session's current one.
    pub(crate) fn detach(&self, id: TerminalSessionId, serial: u64) {
        let mut state = self.state();
        let Some(entry) = state.sessions.iter_mut().find(|entry| {
            entry.record.id == id
                && entry
                    .viewer
                    .as_ref()
                    .is_some_and(|viewer| viewer.serial == serial)
        }) else {
            return;
        };
        entry.viewer = None;
        self.notifier.publish();
    }

    /// Ends a session; returns whether it was listed. The attached browser is told at once.
    /// An agent that is away is told when it reconnects, so the close is never lost to a
    /// disconnect and the session does not come back with the agent's next report.
    pub(crate) async fn close(&self, id: TerminalSessionId) -> bool {
        let agent_id = {
            let mut state = self.state();
            let Some(index) = state
                .sessions
                .iter()
                .position(|entry| entry.record.id == id)
            else {
                return false;
            };
            let mut entry = state.sessions.remove(index);
            entry.release_viewer(DetachReason::Closed);
            if state.pending_closes.len() >= MAX_PENDING_CLOSES {
                state.pending_closes.remove(0);
            }
            state.pending_closes.push(PendingClose {
                agent_id: entry.agent_id.clone(),
                id,
            });
            self.notifier.publish();
            entry.agent_id
        };
        self.close_on_agent(agent_id, id).await;
        true
    }

    /// Tells the agent to close a session and forgets the pending close once it has. A
    /// failure, most often a disconnected agent, keeps it for the agent's next report.
    async fn close_on_agent(&self, agent_id: AgentId, id: TerminalSessionId) {
        if let Err(error) = self.agents.call(&agent_id, CloseTerminal { id }).await {
            log!(
                Level::Debug,
                "Terminal close waits for the agent: agent_id={}, id={}, error={}",
                agent_id,
                id,
                error
            );
            return;
        }
        self.state()
            .pending_closes
            .retain(|close| !(close.agent_id == agent_id && close.id == id));
    }

    /// Replaces what the server knows about `agent_id`'s sessions with the agent's report.
    ///
    /// This is also how a restarted server learns which shells still run, so the browsers
    /// get their tabs back as each agent reconnects. Sessions keep their place and viewer. A
    /// session the agent no longer has (it was restarted) stays listed as exited until its tab is closed, like a shell that exited,
    /// so the tab explains what happened. Sessions closed while the agent was away are left
    /// out and closed on the agent now.
    pub(crate) fn report(&self, agent_id: &AgentId, records: Vec<TerminalSessionRecord>) {
        let mut state = self.state();
        // Closes of sessions the agent no longer has are done.
        state.pending_closes.retain(|close| {
            &close.agent_id != agent_id || records.iter().any(|record| record.id == close.id)
        });
        let mut to_close = Vec::new();
        let mut records: Vec<_> = records
            .into_iter()
            .filter(|record| {
                let pending = state.close_pending(agent_id, record.id);
                if pending {
                    to_close.push(record.id);
                }
                !pending
            })
            .collect();
        // Browsers only reload their tabs when what they list changed.
        let mut changed = false;
        for entry in state
            .sessions
            .iter_mut()
            .filter(|entry| &entry.agent_id == agent_id)
        {
            match records
                .iter()
                .position(|record| record.id == entry.record.id)
            {
                Some(position) => {
                    let record = records.remove(position);
                    changed |= entry.orphaned || entry.record != record;
                    entry.record = record;
                    entry.orphaned = false;
                }
                None if !entry.orphaned => {
                    changed = true;
                    entry.orphaned = true;
                    entry.record.status = TerminalSessionStatus::Exited {
                        message: ENDED_WITH_AGENT.to_string(),
                    };
                    entry.release_viewer(DetachReason::Closed);
                }
                None => {}
            }
        }
        // What is left are sessions the server did not list yet.
        changed |= !records.is_empty();
        for record in records {
            state.sessions.push(Entry {
                agent_id: agent_id.clone(),
                record,
                orphaned: false,
                viewer: None,
            });
        }
        drop(state);
        if changed {
            self.notifier.publish();
        }
        for id in to_close {
            let registry = self.clone();
            let agent_id = agent_id.clone();
            tokio::spawn(async move { registry.close_on_agent(agent_id, id).await });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::ids::UnixTimestampMillis;

    fn record(title: &str) -> TerminalSessionRecord {
        TerminalSessionRecord {
            id: TerminalSessionId::new(),
            cwd: "/".to_string(),
            title: title.to_string(),
            number: 1,
            created_at: UnixTimestampMillis::now(),
            status: TerminalSessionStatus::Running,
            activity: Default::default(),
        }
    }

    fn titles(registry: &TerminalRegistry) -> Vec<String> {
        registry
            .list()
            .into_iter()
            .map(|session| session.title)
            .collect()
    }

    /// An agent's report updates sessions in place, adds new ones and drops the ones it no
    /// longer runs.
    #[test]
    fn report_replaces_only_that_agents_sessions() {
        let agent = redoor_core::test_support::test_agent_id("agent");
        let other = redoor_core::test_support::test_agent_id("other");
        let kept = record("kept");
        let gone = record("gone");
        let registry = TerminalRegistry::disabled();
        registry.report(&agent, vec![kept.clone(), gone.clone()]);
        registry.report(&other, vec![record("other")]);
        let mut exited = kept.clone();
        exited.status = TerminalSessionStatus::Exited {
            message: "Shell exited with code 0".to_string(),
        };
        let mut ticket = registry.attach(gone.id).unwrap();
        registry.report(&agent, vec![exited.clone(), record("new")]);
        // Kept sessions stay in place with their new status, and other agents are untouched.
        assert_eq!(titles(&registry), vec!["kept", "gone", "other", "new"]);
        assert_eq!(registry.list()[0].status, exited.status);
        // A session the restarted agent no longer runs stays as exited, so its tab explains it.
        assert_eq!(
            registry.list()[1].status,
            TerminalSessionStatus::Exited {
                message: ENDED_WITH_AGENT.to_string(),
            }
        );
        // Its viewer is let go, since its shell is gone.
        assert_eq!(ticket.reason.try_recv(), Ok(DetachReason::Closed));
        // A later viewer only learns why it ended, without asking the agent.
        assert!(registry.attach(gone.id).unwrap().ended.is_some());
    }

    /// A close for an absent agent is remembered, so its next report does not bring the
    /// session back.
    #[tokio::test]
    async fn close_while_the_agent_is_away_survives_its_next_report() {
        let agent = redoor_core::test_support::test_agent_id("agent");
        let closed = record("closed");
        let open = record("open");
        let registry = TerminalRegistry::disabled();
        registry.report(&agent, vec![closed.clone(), open.clone()]);
        let mut ticket = registry.attach(closed.id).unwrap();
        assert!(registry.close(closed.id).await);
        // The viewer learns at once, even though the agent did not answer.
        assert_eq!(ticket.reason.try_recv(), Ok(DetachReason::Closed));
        registry.report(&agent, vec![closed.clone(), open, record("later")]);
        // The reconnected agent's report does not resurrect the closed tab.
        assert_eq!(titles(&registry), vec!["open", "later"]);
        // The close is still owed, because the agent still runs the shell.
        assert!(registry.state().close_pending(&agent, closed.id));
        registry.report(&agent, Vec::new());
        // Once the agent no longer has the session, nothing is owed any more.
        assert!(registry.state().pending_closes.is_empty());
    }

    /// Attaching takes the session over from the previous viewer.
    #[test]
    fn attach_takes_over_and_detach_only_frees_the_current_viewer() {
        let agent = redoor_core::test_support::test_agent_id("agent");
        let session = record("s");
        let registry = TerminalRegistry::disabled();
        registry.report(&agent, vec![session.clone()]);
        let mut first = registry.attach(session.id).unwrap();
        let second = registry.attach(session.id).unwrap();
        // The first browser learns it was taken over, not that its connection broke.
        assert_eq!(first.reason.try_recv(), Ok(DetachReason::TakenOver));
        registry.detach(session.id, first.serial);
        // A replaced viewer leaving does not mark the session detached.
        assert!(registry.list()[0].attached);
        registry.detach(session.id, second.serial);
        assert!(!registry.list()[0].attached);
    }
}
