use tokio::time::{Duration, Interval, MissedTickBehavior};

/// Forces periodic writes to keep idle proxies active and expose half-open connections.
pub const WEBSOCKET_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

/// Creates a delayed interval so opening a socket does not immediately add a control frame.
pub fn keepalive_interval() -> Interval {
    let mut interval = tokio::time::interval(WEBSOCKET_KEEPALIVE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval.reset();
    interval
}
