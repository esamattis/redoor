//! Throttled UI invalidation broadcasts so bursts of changes cause one browser refetch.

use super::RouterHandle;
use super::messages::{RegisterUiSubscriberRequest, RouterMsg};
use super::state::RouterState;
use redoor_core::log;
use redoor_protocol::api::ui_events::UiEvent;
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
