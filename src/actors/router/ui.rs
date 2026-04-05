use super::messages::{RegisterUiSubscriberRequest, RouterMsg};
use super::state::RouterState;
use crate::commands::UiEvent;
use crate::log;
use crate::logging::Level;
use ractor::ActorRef;
use std::time::{Duration, Instant};

/// Minimum gap between broadcast refresh events to avoid UI invalidation storms.
pub(crate) const UI_REFRESH_THROTTLE_WINDOW: Duration = Duration::from_secs(5);
/// Poll interval used by the background task that releases trailing refreshes.
pub(crate) const UI_REFRESH_CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// Starts the periodic task that asks the router when a trailing refresh is due.
pub(crate) fn start_refresh_check_task(
    router_ref: ActorRef<RouterMsg>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(UI_REFRESH_CHECK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            if router_ref.cast(RouterMsg::CheckPendingUiRefresh).is_err() {
                break;
            }
        }
    })
}

/// Adds one UI subscriber to the router's refresh broadcast set.
pub(crate) fn register_subscriber(state: &mut RouterState, request: RegisterUiSubscriberRequest) {
    log!(
        Level::Info,
        "UI subscriber registered: subscriber_id={}",
        request.subscriber_id
    );
    state
        .ui
        .subscribers
        .insert(request.subscriber_id, request.sender);
}

/// Removes one UI subscriber from the router's refresh broadcast set.
pub(crate) fn unregister_subscriber(state: &mut RouterState, subscriber_id: &str) {
    log!(
        Level::Info,
        "UI subscriber unregistered: subscriber_id={}",
        subscriber_id
    );
    state.ui.subscribers.remove(subscriber_id);
}

/// Sends an immediate refresh when allowed or marks one trailing refresh as pending.
pub(crate) fn notify_refresh(state: &mut RouterState) {
    let now = Instant::now();

    match state.ui.last_refresh_sent_at {
        None => {
            broadcast_event(state, UiEvent::Refresh);
            state.ui.last_refresh_sent_at = Some(now);
            state.ui.refresh_pending = false;
        }
        Some(last_sent_at) => {
            let elapsed = now.saturating_duration_since(last_sent_at);

            if elapsed >= UI_REFRESH_THROTTLE_WINDOW {
                broadcast_event(state, UiEvent::Refresh);
                state.ui.last_refresh_sent_at = Some(now);
                state.ui.refresh_pending = false;
            } else {
                state.ui.refresh_pending = true;
            }
        }
    }
}

/// Emits a throttled trailing refresh once the current throttle window has elapsed.
pub(crate) fn check_pending_refresh(state: &mut RouterState) {
    if !state.ui.refresh_pending {
        return;
    }

    let now = Instant::now();
    let Some(last_sent_at) = state.ui.last_refresh_sent_at else {
        broadcast_event(state, UiEvent::Refresh);
        state.ui.last_refresh_sent_at = Some(now);
        state.ui.refresh_pending = false;
        return;
    };

    let elapsed = now.saturating_duration_since(last_sent_at);
    if elapsed >= UI_REFRESH_THROTTLE_WINDOW {
        broadcast_event(state, UiEvent::Refresh);
        state.ui.last_refresh_sent_at = Some(now);
        state.ui.refresh_pending = false;
    }
}

/// Broadcasts one UI event to all live subscribers and drops closed senders.
fn broadcast_event(state: &mut RouterState, event: UiEvent) {
    state.ui.subscribers.retain(|subscriber_id, sender| {
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
