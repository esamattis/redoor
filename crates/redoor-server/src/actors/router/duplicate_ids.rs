//! Detection of several machines that share one device id.
//!
//! Copying a home directory, VM image or container image copies a standalone agent's
//! `<data_dir>/agent-id`, so the clones send the same id in `hello`. A reconnect of an id
//! normally replaces the old connection, which would make the clones evict each other forever.
//! Hostnames cannot tell clones from reconnects (clones usually keep them), so the router
//! looks at behavior instead: a real reconnect replaces a dead or dying connection once, while
//! clones keep replacing each other's healthy ones. After [`TAKEOVER_LIMIT`] such replacements
//! within [`TAKEOVER_WINDOW`] the router keeps the current connection and refuses newcomers
//! with `duplicate_id` while it stays healthy, and shows a warning on the device.

use super::messages::RegisterAgentRequest;
use super::state::RouterState;
use crate::workspaces::AgentKey;
use redoor_core::log;
use redoor_protocol::api::agents::DuplicateIdWarning;
use redoor_protocol::ids::UnixTimestampSeconds;
use redoor_protocol::wire::log::Level;
use std::collections::VecDeque;
use tokio::time::{Duration, Instant};

/// How long replacements of healthy connections are remembered, and how long a detected
/// conflict outlives the last competing `hello`.
///
/// A refused clone retries with the agent's quick reconnect delay (a few seconds), so a
/// conflict only ends once the competing machine stopped trying, not between two retries.
pub(crate) const TAKEOVER_WINDOW: Duration = Duration::from_secs(60);
/// Replacements of healthy connections within [`TAKEOVER_WINDOW`] that mark an id as shared.
///
/// One replacement is a normal reconnect that happened before the server noticed the old
/// connection die; three in a minute is a loop no ordinary reconnect produces.
pub(crate) const TAKEOVER_LIMIT: usize = 3;
/// Most hostnames kept for the warning, so a misbehaving fleet cannot grow router memory.
const MAX_REPORTED_HOSTNAMES: usize = 8;

/// Recent takeovers of one id's healthy connections, kept only while they matter.
#[derive(Debug, Default)]
pub(crate) struct TakeoverHistory {
    /// When a `hello` replaced a healthy connection, oldest first, within the window.
    replacements: VecDeque<Instant>,
    /// Hostnames reported by the connections involved in those takeovers, so the warning can
    /// name the machines that are clones of each other.
    hostnames: Vec<String>,
    /// Present once the loop was detected; newcomers are then refused.
    conflict: Option<IdConflict>,
}

/// A detected id conflict: what the device shows and when the competitors were last heard.
#[derive(Debug)]
struct IdConflict {
    /// When the router started refusing newcomers, reported to the UI.
    since: UnixTimestampSeconds,
    /// Last competing `hello`; the conflict ends one window after it.
    last_competitor_at: Instant,
}

/// What the router does with a `hello` that would replace a healthy connection.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TakeoverDecision {
    /// Replace the current connection. `conflict_started` is set when this replacement
    /// completed the loop, so the caller publishes the new warning.
    Replace { conflict_started: bool },
    /// Keep the current connection and refuse the newcomer. `warning_changed` is set when
    /// the newcomer reported a hostname the warning did not list yet.
    Refuse { warning_changed: bool },
}

impl TakeoverHistory {
    /// Records a `hello` that competes with a healthy connection and decides its fate.
    pub(crate) fn competing_hello(
        &mut self,
        now: Instant,
        current_hostname: &str,
        newcomer_hostname: &str,
    ) -> TakeoverDecision {
        self.expire(now);
        let mut warning_changed = self.remember_hostname(current_hostname);
        warning_changed |= self.remember_hostname(newcomer_hostname);
        if let Some(conflict) = &mut self.conflict {
            conflict.last_competitor_at = now;
            return TakeoverDecision::Refuse { warning_changed };
        }
        self.replacements.push_back(now);
        let conflict_started = self.replacements.len() >= TAKEOVER_LIMIT;
        if conflict_started {
            self.conflict = Some(IdConflict {
                since: UnixTimestampSeconds::new(jiff::Timestamp::now().as_second()),
                last_competitor_at: now,
            });
        }
        TakeoverDecision::Replace { conflict_started }
    }

    /// Adds a hostname to the warning; returns whether it was new.
    fn remember_hostname(&mut self, hostname: &str) -> bool {
        if self.hostnames.len() >= MAX_REPORTED_HOSTNAMES
            || self.hostnames.iter().any(|known| known == hostname)
        {
            return false;
        }
        self.hostnames.push(hostname.to_string());
        true
    }

    /// The warning the device shows while the conflict lasts.
    pub(crate) fn warning(&self) -> Option<DuplicateIdWarning> {
        self.conflict.as_ref().map(|conflict| DuplicateIdWarning {
            hostnames: self.hostnames.clone(),
            since: conflict.since,
        })
    }

    /// Forgets replacements older than the window and ends a conflict whose competitors
    /// have been quiet for a whole window; returns whether a conflict ended.
    pub(crate) fn expire(&mut self, now: Instant) -> bool {
        while self
            .replacements
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= TAKEOVER_WINDOW)
        {
            self.replacements.pop_front();
        }
        let ended = self.conflict.as_ref().is_some_and(|conflict| {
            now.saturating_duration_since(conflict.last_competitor_at) >= TAKEOVER_WINDOW
        });
        if ended {
            self.conflict = None;
        }
        if self.is_idle() {
            self.hostnames.clear();
        }
        ended
    }

    /// Whether nothing is left to remember, so the router can drop the entry.
    pub(crate) fn is_idle(&self) -> bool {
        self.replacements.is_empty() && self.conflict.is_none()
    }
}

impl RouterState {
    /// Decides whether `request` may replace the id's current connection; `Err` carries the
    /// `duplicate_id` rejection message.
    ///
    /// Only a healthy current connection is defended: a dead or dying one (silent past the
    /// heartbeat window) is what a real reconnect replaces, and no connection at all means
    /// nothing competes. This also lets a fixed clone, or the remaining machine after the
    /// connected one went away, through on its next retry.
    pub(crate) fn admit_takeover(&mut self, request: &RegisterAgentRequest) -> Result<(), String> {
        let key = AgentKey::new(&request.owner, request.agent_id.clone());
        let Some(current) = self.agents.by_id.get(&key) else {
            return Ok(());
        };
        if !current.activity.is_healthy() {
            return Ok(());
        }
        let current_hostname = current.identity.hostname.clone();
        let history = self.agents.takeovers.entry(key.clone()).or_default();
        match history.competing_hello(
            Instant::now(),
            &current_hostname,
            &request.identity.hostname,
        ) {
            TakeoverDecision::Replace {
                conflict_started: false,
            } => Ok(()),
            TakeoverDecision::Replace {
                conflict_started: true,
            } => {
                log!(
                    Level::Warning,
                    "Several machines are using one device id; refusing newcomers while the current connection is healthy: agent={}, hostnames={:?}",
                    key,
                    history.hostnames
                );
                self.publish_duplicate_id(&key);
                Ok(())
            }
            TakeoverDecision::Refuse { warning_changed } => {
                let message = format!(
                    "Another machine is already connected as device '{}' (hostnames seen: {}). Several machines are using the same device id, usually because the agent's data directory was copied. Delete the agent-id file in the data directory on one of them to give it its own identity.",
                    request.agent_id,
                    history.hostnames.join(", ")
                );
                if warning_changed {
                    self.publish_duplicate_id(&key);
                }
                Err(message)
            }
        }
    }

    /// Copies the id's current conflict warning (or its absence) into the inventory and
    /// tells UI subscribers of its owner, so the device page explains why one machine stays offline.
    fn publish_duplicate_id(&mut self, agent: &AgentKey) {
        let warning = self
            .agents
            .takeovers
            .get(agent)
            .and_then(TakeoverHistory::warning);
        if let Some(known) = self.agents.known_by_id.get_mut(agent) {
            known.duplicate_id = warning;
        }
        self.notify_agents_changed(agent.owner());
    }

    /// Ends conflicts whose competitors have been quiet for a whole window and forgets old
    /// takeovers; driven by the router's periodic tick so no separate timer is needed.
    pub(crate) fn expire_duplicate_ids(&mut self) {
        if self.agents.takeovers.is_empty() {
            return;
        }
        let now = Instant::now();
        let mut ended = Vec::new();
        self.agents.takeovers.retain(|agent, history| {
            if history.expire(now) {
                ended.push(agent.clone());
            }
            !history.is_idle()
        });
        for agent in ended {
            log!(
                Level::Info,
                "Device id conflict ended after a quiet window: agent={}",
                agent
            );
            self.publish_duplicate_id(&agent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::lanes::{ControlLaneReceivers, ControlLanes};
    use crate::actors::router::messages::RegistrationRejection;
    use crate::actors::router::streams::ConnectionStreams;
    use redoor_protocol::wire::ServerToAgent;
    use redoor_protocol::wire::handshake::RejectReason;
    use tokio::sync::oneshot;

    /// Healthy window of the test connections, matching production's two keepalives.
    const HEALTHY_WITHIN: Duration = Duration::from_secs(20);

    /// Builds isolated router state without starting a router mailbox task.
    fn test_state() -> RouterState {
        let refresh_task = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        RouterState::new(refresh_task)
    }

    /// One machine's `hello` for `agent_id`, with the receivers its session would drain and
    /// the router's verdict.
    struct Hello {
        request: RegisterAgentRequest,
        receivers: ControlLaneReceivers,
        decision: oneshot::Receiver<Result<(), RegistrationRejection>>,
    }

    /// Builds a `hello` from a machine called `hostname`, whose connection stays healthy
    /// until time advances past the heartbeat window without a `touch`.
    fn hello(agent_id: &AgentKey, hostname: &str) -> Hello {
        let (lanes, receivers) = ControlLanes::bounded(4, 4);
        let mut request = RegisterAgentRequest::for_test(
            agent_id.owner(),
            &agent_id.id,
            lanes,
            ConnectionStreams::new(agent_id.clone()),
        );
        request.agent_name = "clone".to_string();
        request.identity.hostname = hostname.to_string();
        request.activity = crate::actors::activity::ConnectionActivity::new(HEALTHY_WITHIN);
        let (reply, decision) = oneshot::channel();
        request.reply = Some(reply);
        Hello {
            request,
            receivers,
            decision,
        }
    }

    /// Registers `hello` and returns the router's verdict and its receivers.
    async fn register(
        state: &mut RouterState,
        hello: Hello,
    ) -> (Result<(), RegistrationRejection>, ControlLaneReceivers) {
        let Hello {
            request,
            receivers,
            decision,
        } = hello;
        state.register_agent(request);
        (decision.await.expect("router answers"), receivers)
    }

    /// The warning the device currently shows.
    fn warning(state: &RouterState, agent_id: &AgentKey) -> Option<DuplicateIdWarning> {
        state.agents.known_by_id[agent_id].duplicate_id.clone()
    }

    /// A reconnect that replaces a connection which went silent is ordinary, so it is never
    /// counted, however often the network drops.
    #[tokio::test(start_paused = true)]
    async fn replacing_a_dead_connection_is_a_normal_reconnect() {
        let mut state = test_state();
        let agent_id = AgentKey::new(
            "test",
            redoor_core::test_support::test_agent_id("reconnect"),
        );
        for _ in 0..TAKEOVER_LIMIT + 1 {
            let (decision, _receivers) = register(&mut state, hello(&agent_id, "laptop")).await;
            // Every reconnect is welcomed, because the connection it replaces is dead.
            assert!(decision.is_ok());
            tokio::time::advance(HEALTHY_WITHIN + Duration::from_secs(1)).await;
        }
        // No takeover of a healthy connection happened, so nothing is remembered.
        assert!(state.agents.takeovers.is_empty());
        // The device shows no warning.
        assert_eq!(warning(&state, &agent_id), None);
        state.ui.refresh_check_task.abort();
    }

    /// Clones that keep replacing each other's healthy connections are stopped after the
    /// limit: the current connection stays and newcomers get `duplicate_id`.
    #[tokio::test(start_paused = true)]
    async fn repeated_takeovers_of_healthy_connections_become_duplicate_id_rejections() {
        let mut state = test_state();
        let agent_id = AgentKey::new("test", redoor_core::test_support::test_agent_id("clone"));
        let (first, _first) = register(&mut state, hello(&agent_id, "vm-a")).await;
        // The first connection has nothing to compete with.
        assert!(first.is_ok());
        let mut last_socket = None;
        for attempt in 1..=TAKEOVER_LIMIT {
            tokio::time::advance(Duration::from_secs(3)).await;
            let hostname = if attempt % 2 == 0 { "vm-a" } else { "vm-b" };
            let hello = hello(&agent_id, hostname);
            let socket = hello.request.socket_id.clone();
            let (decision, _receivers) = register(&mut state, hello).await;
            // Up to the limit, takeovers still happen like reconnects.
            assert!(decision.is_ok(), "takeover {attempt} was refused");
            last_socket = Some(socket);
        }
        let current = last_socket.expect("takeovers happened");
        // Reaching the limit raises the warning, naming both machines.
        assert_eq!(
            warning(&state, &agent_id).map(|warning| warning.hostnames),
            Some(vec!["vm-a".to_string(), "vm-b".to_string()])
        );

        tokio::time::advance(Duration::from_secs(3)).await;
        let (decision, mut receivers) = register(&mut state, hello(&agent_id, "vm-a")).await;
        // The session learns the reason so it closes the socket after the frame is flushed.
        assert!(matches!(
            decision,
            Err(RegistrationRejection {
                reason: RejectReason::DuplicateId,
                ..
            })
        ));
        // The agent reads why it was refused, so it can tell the operator how to fix it.
        assert!(matches!(
            receivers.priority.try_recv(),
            Ok(ServerToAgent::Rejected {
                reason: RejectReason::DuplicateId,
                ..
            })
        ));
        // The healthy current connection keeps the id instead of being evicted again.
        assert!(state.agents.is_current_session(&agent_id, &current));
        state.ui.refresh_check_task.abort();
    }

    /// Refusals only defend a healthy connection: once the current one dies, the next
    /// machine gets through, so a clone is never locked out of a free id.
    #[tokio::test(start_paused = true)]
    async fn newcomer_gets_through_once_the_defended_connection_dies() {
        let mut state = test_state();
        let agent_id = AgentKey::new("test", redoor_core::test_support::test_agent_id("survivor"));
        for _ in 0..=TAKEOVER_LIMIT {
            let (decision, _receivers) = register(&mut state, hello(&agent_id, "vm")).await;
            assert!(decision.is_ok());
        }
        // The loop was detected.
        assert!(warning(&state, &agent_id).is_some());

        tokio::time::advance(HEALTHY_WITHIN + Duration::from_secs(1)).await;
        let (decision, _receivers) = register(&mut state, hello(&agent_id, "vm")).await;
        // The current connection went silent, so the newcomer replaces it.
        assert!(decision.is_ok());
        state.ui.refresh_check_task.abort();
    }

    /// The warning clears once no competing `hello` arrived for a whole window, and the id
    /// then behaves like any other again.
    #[tokio::test(start_paused = true)]
    async fn warning_clears_after_a_quiet_window() {
        let mut state = test_state();
        let agent_id = AgentKey::new("test", redoor_core::test_support::test_agent_id("quiet"));
        let mut current = None;
        for _ in 0..=TAKEOVER_LIMIT {
            let (decision, receivers) = register(&mut state, hello(&agent_id, "vm")).await;
            assert!(decision.is_ok());
            current = Some(receivers);
        }
        let (refused, _receivers) = register(&mut state, hello(&agent_id, "vm")).await;
        // The conflict is active.
        assert!(refused.is_err());

        tokio::time::advance(TAKEOVER_WINDOW - Duration::from_secs(1)).await;
        // Keep the defended connection healthy, like its heartbeats would.
        state.agents.by_id[&agent_id].activity.touch();
        state.expire_duplicate_ids();
        // Within the window after the last competitor the warning stays.
        assert!(warning(&state, &agent_id).is_some());

        tokio::time::advance(Duration::from_secs(1)).await;
        state.expire_duplicate_ids();
        // A whole quiet window ends the conflict and clears the warning.
        assert_eq!(warning(&state, &agent_id), None);
        // Nothing is retained for the id once it is quiet.
        assert!(state.agents.takeovers.is_empty());

        state.agents.by_id[&agent_id].activity.touch();
        let (decision, _receivers) = register(&mut state, hello(&agent_id, "vm")).await;
        // A later takeover is a fresh first replacement, not a refusal.
        assert!(decision.is_ok());
        drop(current);
        state.ui.refresh_check_task.abort();
    }
}
