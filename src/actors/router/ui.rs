use super::RouterHandle;
use super::messages::{RegisterUiSubscriberRequest, RouterMsg};
use super::router::Router;
use crate::commands::UiEvent;
use crate::log;
use crate::logging::Level;
use std::time::{Duration, Instant};

/* <CODEREVIEW>
Terminal states now bypass this throttle, but active copy progress still does not. Local copies emit
progress every `250ms` and routed copies can request refreshes per chunk, yet `increment_bytes` and
`set_copy_progress` still collapse those updates into one UI refresh every five seconds. That leaves
active rows showing stale byte counts for long stretches even while the router has newer progress.

Consider using a separate, shorter throttle window for active transfer progress refreshes instead of
sharing the coarse five-second window with everything else. That would keep byte counts feeling live
without reintroducing refresh storms from terminal-state churn.
</CODEREVIEW> */
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
            if router_ref.send(RouterMsg::CheckPendingUiRefresh).is_err() {
                break;
            }
        }
    })
}

/// Adds one UI subscriber to the router's refresh broadcast set.
pub(crate) fn register_subscriber(router: &mut Router, request: RegisterUiSubscriberRequest) {
    log!(
        Level::Info,
        "UI subscriber registered: subscriber_id={}",
        request.subscriber_id
    );
    router
        .ui
        .subscribers
        .insert(request.subscriber_id, request.sender);
}

/// Removes one UI subscriber from the router's refresh broadcast set.
pub(crate) fn unregister_subscriber(router: &mut Router, subscriber_id: &str) {
    log!(
        Level::Info,
        "UI subscriber unregistered: subscriber_id={}",
        subscriber_id
    );
    router.ui.subscribers.remove(subscriber_id);
}

/// Sends an immediate refresh when allowed or marks one trailing refresh as pending.
pub(crate) fn notify_refresh(router: &mut Router) {
    let now = Instant::now();

    match router.ui.last_refresh_sent_at {
        None => {
            broadcast_event(router, UiEvent::Refresh);
            router.ui.last_refresh_sent_at = Some(now);
            router.ui.refresh_pending = false;
        }
        Some(last_sent_at) => {
            let elapsed = now.saturating_duration_since(last_sent_at);

            if elapsed >= UI_REFRESH_THROTTLE_WINDOW {
                broadcast_event(router, UiEvent::Refresh);
                router.ui.last_refresh_sent_at = Some(now);
                router.ui.refresh_pending = false;
            } else {
                router.ui.refresh_pending = true;
            }
        }
    }
}

/// Broadcasts one refresh immediately and resets the trailing throttle state.
pub(crate) fn notify_refresh_immediately(router: &mut Router) {
    let now = Instant::now();
    broadcast_event(router, UiEvent::Refresh);
    router.ui.last_refresh_sent_at = Some(now);
    router.ui.refresh_pending = false;
}

/// Emits a throttled trailing refresh once the current throttle window has elapsed.
pub(crate) fn check_pending_refresh(router: &mut Router) {
    if !router.ui.refresh_pending {
        return;
    }

    let now = Instant::now();
    let Some(last_sent_at) = router.ui.last_refresh_sent_at else {
        notify_refresh_immediately(router);
        return;
    };

    let elapsed = now.saturating_duration_since(last_sent_at);
    if elapsed >= UI_REFRESH_THROTTLE_WINDOW {
        notify_refresh_immediately(router);
    }
}

/// Broadcasts one UI event to all live subscribers and drops closed senders.
fn broadcast_event(router: &mut Router, event: UiEvent) {
    router.ui.subscribers.retain(|subscriber_id, sender| {
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
