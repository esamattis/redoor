//! UI event broadcasts: throttled invalidation hints, so bursts of changes cause one browser
//! refetch, and unthrottled `rd-open` commands.

use super::RouterHandle;
use super::messages::{RegisterUiSubscriberRequest, RouterMsg};
use super::state::RouterState;
use redoor_core::log;
use redoor_protocol::api::ui_events::{OpenPathKind, UiEvent};
use redoor_protocol::ids::AgentId;
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
            "UI subscriber registered: subscriber_id={}",
            request.subscriber_id
        );
        self.ui
            .subscribers
            .insert(request.subscriber_id, request.sender);
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

    /// Sends an immediate transfer refresh when allowed or marks one trailing refresh as pending.
    pub(crate) fn notify_transfer_refresh(&mut self) {
        let now = Instant::now();

        match self.ui.last_refresh_sent_at {
            None => {
                self.broadcast_event(UiEvent::TransfersChanged);
                self.ui.last_refresh_sent_at = Some(now);
                self.ui.refresh_pending = false;
            }
            Some(last_sent_at) => {
                let elapsed = now.saturating_duration_since(last_sent_at);

                if elapsed >= UI_REFRESH_THROTTLE_WINDOW {
                    self.broadcast_event(UiEvent::TransfersChanged);
                    self.ui.last_refresh_sent_at = Some(now);
                    self.ui.refresh_pending = false;
                } else {
                    self.ui.refresh_pending = true;
                }
            }
        }
    }

    /// Broadcasts one transfer refresh immediately and resets the trailing throttle self.
    pub(crate) fn notify_transfer_refresh_immediately(&mut self) {
        let now = Instant::now();
        self.broadcast_event(UiEvent::TransfersChanged);
        self.ui.last_refresh_sent_at = Some(now);
        self.ui.refresh_pending = false;
    }

    /// Emits a throttled trailing refresh once the current throttle window has elapsed.
    pub(crate) fn check_pending_refresh(&mut self) {
        if !self.ui.refresh_pending {
            return;
        }

        let now = Instant::now();
        let Some(last_sent_at) = self.ui.last_refresh_sent_at else {
            self.notify_transfer_refresh_immediately();
            return;
        };

        let elapsed = now.saturating_duration_since(last_sent_at);
        if elapsed >= UI_REFRESH_THROTTLE_WINDOW {
            self.notify_transfer_refresh_immediately();
        }
    }

    /// Broadcasts agent inventory changes without coupling them to transfer throttling.
    pub(crate) fn notify_agents_changed(&mut self) {
        self.broadcast_event(UiEvent::AgentsChanged);
    }

    /// Broadcasts changes that affect data loaded directly by the active route.
    pub(crate) fn notify_routes_changed(&mut self) {
        self.broadcast_event(UiEvent::RoutesChanged);
    }

    /// Broadcasts terminal session changes at once; they are rare and a window waiting for
    /// a tab to appear or disappear should not wait for a throttle window.
    pub(crate) fn notify_terminals_changed(&mut self) {
        self.broadcast_event(UiEvent::TerminalsChanged);
    }

    /// Asks every open window to show `path` of `agent_id`, at once and unthrottled, because
    /// the event is a command a person is waiting on, not a hint that may be merged.
    ///
    /// Every window gets it: users are equally privileged, and the windows themselves decide
    /// which one navigates (the focused one) and which only offer to.
    pub(crate) fn notify_open_path(
        &mut self,
        agent_id: &AgentId,
        path: String,
        kind: OpenPathKind,
    ) {
        let Some(connection) = self.agents.by_id.get(agent_id) else {
            return;
        };
        // Browser routes only address absolute paths; the agent always sends one.
        if !path.starts_with('/') {
            log!(
                Level::Warning,
                "Ignoring open path request with a relative path: agent_id={}",
                agent_id
            );
            return;
        }
        log!(
            Level::Info,
            "Opening path in the UI: agent_id={}, path={}",
            agent_id,
            path
        );
        let event = UiEvent::OpenPath {
            agent_id: agent_id.clone(),
            device_name: connection.agent_name.clone(),
            path,
            kind,
        };
        self.broadcast_event(event);
    }

    /// Broadcasts one UI event to all live subscribers and drops closed senders.
    fn broadcast_event(&mut self, event: UiEvent) {
        self.ui.subscribers.retain(|subscriber_id, sender| {
            if sender.send(event.clone()).is_ok() {
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

    /// Builds a router with one connected agent named `phone` and one UI subscriber that
    /// joined after the registration, so it only sees what the test triggers.
    fn router_with_subscriber() -> (
        RouterState,
        AgentId,
        tokio::sync::mpsc::UnboundedReceiver<UiEvent>,
    ) {
        let mut state = RouterState::new(tokio::spawn(async {}));
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let (lanes, _receivers) = ControlLanes::bounded(4, 4);
        let mut request = RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            ConnectionStreams::new(agent_id.clone()),
        );
        request.agent_name = "phone".to_string();
        state.register_agent(request);
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        state.ui.subscribers.insert("ui-1".to_string(), sender);
        (state, agent_id, receiver)
    }

    /// `rd-open` reaches the browsers at once with the device's current name, even right
    /// after another broadcast, because the refresh throttle must never delay or merge it.
    #[tokio::test]
    async fn open_path_is_broadcast_unthrottled_with_the_device_name() {
        let (mut state, agent_id, mut receiver) = router_with_subscriber();
        state.notify_transfer_refresh();
        state.notify_open_path(&agent_id, "/home/u/a.txt".to_string(), OpenPathKind::File);
        state.notify_open_path(&agent_id, "/home/u".to_string(), OpenPathKind::Directory);
        // The transfer hint went out first and opened the throttle window.
        assert!(matches!(receiver.try_recv(), Ok(UiEvent::TransfersChanged)));
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
            }) = receiver.try_recv()
            else {
                panic!("expected an open_path event");
            };
            assert_eq!(id, agent_id);
            // The browser builds the device URL from the name.
            assert_eq!(device_name, "phone");
            assert_eq!(path, expected_path);
            assert_eq!(kind, expected_kind);
        }
        state.ui.refresh_check_task.abort();
    }

    /// Browser routes only address absolute paths, and a disconnected agent has no name to
    /// show, so neither request reaches the browsers.
    #[tokio::test]
    async fn open_path_ignores_relative_paths_and_unknown_agents() {
        let (mut state, agent_id, mut receiver) = router_with_subscriber();
        state.notify_open_path(&agent_id, "relative.txt".to_string(), OpenPathKind::File);
        let unknown = redoor_core::test_support::test_agent_id("unknown");
        state.notify_open_path(&unknown, "/tmp".to_string(), OpenPathKind::Directory);
        // Nothing was broadcast for either request.
        assert!(receiver.try_recv().is_err());
        state.ui.refresh_check_task.abort();
    }
}
