//! UI event broadcasts: throttled invalidation hints, so bursts of changes cause one browser
//! refetch, and unthrottled `rd-open` commands, routed strictly to subscribers of the owning
//! user.

use super::RouterHandle;
use super::messages::{RegisterUiSubscriberRequest, RouterMsg};
use super::state::{RouterState, UiSubscriber};
use crate::workspaces::AgentKey;
use redoor_core::log;
use redoor_protocol::api::ui_events::{OpenPathKind, UiEvent};
use redoor_protocol::wire::log::Level;
use std::time::{Duration, Instant};

/// Minimum gap between broadcast refresh events to avoid UI invalidation storms.
pub(crate) const UI_REFRESH_THROTTLE_WINDOW: Duration = Duration::from_secs(5);
/// Poll interval used by the background task that releases trailing refreshes.
pub(crate) const UI_REFRESH_CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// Starts the periodic task that asks the router when a trailing refresh is due.
pub(crate) fn start_refresh_check_task(router_ref: RouterHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(UI_REFRESH_CHECK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            // Backpressure must not permanently disable refreshes and idle history expiry.
            if router_ref
                .send_async(RouterMsg::CheckPendingUiRefresh)
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

impl RouterState {
    /// Adds one UI subscriber to the router's refresh broadcast set.
    pub(crate) fn register_subscriber(&mut self, request: RegisterUiSubscriberRequest) {
        log!(
            Level::Info,
            "UI subscriber registered: subscriber_id={}, owner={}",
            request.subscriber_id,
            request.owner
        );
        self.ui.subscribers.insert(
            request.subscriber_id,
            UiSubscriber {
                owner: request.owner,
                sender: request.sender,
            },
        );
    }

    /// Removes one UI subscriber from the router's refresh broadcast set.
    pub(crate) fn unregister_subscriber(&mut self, subscriber_id: &str) {
        log!(
            Level::Info,
            "UI subscriber unregistered: subscriber_id={}",
            subscriber_id
        );
        self.ui.subscribers.remove(subscriber_id);
    }

    /// Sends an immediate transfer refresh for `owner` when allowed or marks a trailing refresh.
    pub(crate) fn notify_transfer_refresh(&mut self, owner: &str) {
        let now = Instant::now();
        let send_now = {
            let state = self
                .ui
                .refresh_by_owner
                .entry(owner.to_string())
                .or_default();
            match state.last_refresh_sent_at {
                None => {
                    state.last_refresh_sent_at = Some(now);
                    state.refresh_pending = false;
                    true
                }
                Some(last_sent_at) => {
                    if now.saturating_duration_since(last_sent_at) >= UI_REFRESH_THROTTLE_WINDOW {
                        state.last_refresh_sent_at = Some(now);
                        state.refresh_pending = false;
                        true
                    } else {
                        state.refresh_pending = true;
                        false
                    }
                }
            }
        };
        if send_now {
            self.broadcast_event(owner, UiEvent::TransfersChanged);
        }
    }

    /// Broadcasts one transfer refresh immediately for `owner` and resets its trailing throttle.
    pub(crate) fn notify_transfer_refresh_immediately(&mut self, owner: &str) {
        let now = Instant::now();
        let state = self
            .ui
            .refresh_by_owner
            .entry(owner.to_string())
            .or_default();
        state.last_refresh_sent_at = Some(now);
        state.refresh_pending = false;
        self.broadcast_event(owner, UiEvent::TransfersChanged);
    }

    /// Emits throttled trailing refreshes for every owner whose throttle window has elapsed.
    pub(crate) fn check_pending_refresh(&mut self) {
        let now = Instant::now();
        let due_owners: Vec<String> = self
            .ui
            .refresh_by_owner
            .iter()
            .filter_map(|(owner, state)| {
                if !state.refresh_pending {
                    return None;
                }
                let due = match state.last_refresh_sent_at {
                    None => true,
                    Some(last) => now.saturating_duration_since(last) >= UI_REFRESH_THROTTLE_WINDOW,
                };
                due.then(|| owner.clone())
            })
            .collect();
        for owner in due_owners {
            self.notify_transfer_refresh_immediately(&owner);
        }
    }

    /// Broadcasts agent inventory changes to `owner` without coupling them to transfer throttling.
    pub(crate) fn notify_agents_changed(&mut self, owner: &str) {
        self.broadcast_event(owner, UiEvent::AgentsChanged);
    }

    /// Broadcasts changes that affect data loaded directly by the active route to `owner`.
    pub(crate) fn notify_routes_changed(&mut self, owner: &str) {
        self.broadcast_event(owner, UiEvent::RoutesChanged);
    }

    /// Broadcasts terminal session changes at once to `owner`.
    pub(crate) fn notify_terminals_changed(&mut self, owner: &str) {
        self.broadcast_event(owner, UiEvent::TerminalsChanged);
    }

    /// Asks every open window of `agent`'s owner to show `path` of `agent`, at once and
    /// unthrottled, because the event is a command a person is waiting on.
    pub(crate) fn notify_open_path(&mut self, agent: &AgentKey, path: String, kind: OpenPathKind) {
        let Some(connection) = self.agents.by_id.get(agent) else {
            return;
        };
        // Browser routes only address absolute paths; the agent always sends one.
        if !path.starts_with('/') {
            log!(
                Level::Warning,
                "Ignoring open path request with a relative path: agent={}",
                agent
            );
            return;
        }
        log!(
            Level::Info,
            "Opening path in the UI: agent={}, path={}",
            agent,
            path
        );
        let event = UiEvent::OpenPath {
            agent_id: agent.id.clone(),
            device_name: connection.agent_name.clone(),
            path,
            kind,
        };
        self.broadcast_event(agent.owner(), event);
    }

    /// Broadcasts one UI event to all live subscribers belonging to `owner` and drops closed
    /// senders.
    fn broadcast_event(&mut self, owner: &str, event: UiEvent) {
        self.ui.subscribers.retain(|subscriber_id, subscriber| {
            if subscriber.owner != owner {
                return true;
            }
            if subscriber.sender.send(event.clone()).is_ok() {
                true
            } else {
                log!(
                    Level::Warning,
                    "Removing closed UI subscriber: subscriber_id={}",
                    subscriber_id
                );
                false
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::lanes::ControlLanes;
    use crate::actors::router::messages::RegisterAgentRequest;
    use crate::actors::router::streams::ConnectionStreams;

    /// Builds a router with one connected agent named `phone` owned by `alice` and subscribers
    /// for `alice` and `bob`.
    fn router_with_subscribers() -> (
        RouterState,
        AgentKey,
        tokio::sync::mpsc::UnboundedReceiver<UiEvent>,
        tokio::sync::mpsc::UnboundedReceiver<UiEvent>,
    ) {
        let mut state = RouterState::new(tokio::spawn(async {}));
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let agent = AgentKey::new("alice", agent_id.clone());
        let (lanes, _receivers) = ControlLanes::bounded(4, 4);
        let mut request = RegisterAgentRequest::for_test(
            "alice",
            &agent_id,
            lanes,
            ConnectionStreams::new(agent.clone()),
        );
        request.agent_name = "phone".to_string();
        state.register_agent(request);
        let (alice_tx, alice_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert(
            "ui-alice".to_string(),
            UiSubscriber {
                owner: "alice".to_string(),
                sender: alice_tx,
            },
        );
        let (bob_tx, bob_rx) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert(
            "ui-bob".to_string(),
            UiSubscriber {
                owner: "bob".to_string(),
                sender: bob_tx,
            },
        );
        (state, agent, alice_rx, bob_rx)
    }

    /// `rd-open` reaches only the owning user's browsers at once with the device's current
    /// name, even right after another broadcast, and never leaks to other users.
    #[tokio::test]
    async fn open_path_is_broadcast_unthrottled_only_to_owner() {
        let (mut state, agent, mut alice_rx, mut bob_rx) = router_with_subscribers();
        state.notify_transfer_refresh("alice");
        state.notify_open_path(&agent, "/home/u/a.txt".to_string(), OpenPathKind::File);
        state.notify_open_path(&agent, "/home/u".to_string(), OpenPathKind::Directory);
        // The transfer hint went out first and opened the throttle window for alice only.
        assert!(matches!(alice_rx.try_recv(), Ok(UiEvent::TransfersChanged)));
        // Bob receives none of alice's events.
        assert!(bob_rx.try_recv().is_err());
        // Both requests still arrive inside that window, in order, each with its own path.
        for (expected_path, expected_kind) in [
            ("/home/u/a.txt", OpenPathKind::File),
            ("/home/u", OpenPathKind::Directory),
        ] {
            let Ok(UiEvent::OpenPath {
                agent_id: id,
                device_name,
                path,
                kind,
            }) = alice_rx.try_recv()
            else {
                panic!("expected an open_path event");
            };
            assert_eq!(id, agent.id);
            // The browser builds the device URL from the name.
            assert_eq!(device_name, "phone");
            assert_eq!(path, expected_path);
            assert_eq!(kind, expected_kind);
        }
        assert!(bob_rx.try_recv().is_err());
        state.ui.refresh_check_task.abort();
    }

    /// Browser routes only address absolute paths, and a disconnected agent has no name to
    /// show, so neither request reaches the browsers.
    #[tokio::test]
    async fn open_path_ignores_relative_paths_and_unknown_agents() {
        let (mut state, agent, mut receiver, _) = router_with_subscribers();
        state.notify_open_path(&agent, "relative.txt".to_string(), OpenPathKind::File);
        let unknown = AgentKey::new("alice", redoor_core::test_support::test_agent_id("unknown"));
        state.notify_open_path(&unknown, "/tmp".to_string(), OpenPathKind::Directory);
        // Nothing was broadcast for either request.
        assert!(receiver.try_recv().is_err());
        state.ui.refresh_check_task.abort();
    }
}
