use std::sync::OnceLock;
use tokio::time::{Duration, Interval, MissedTickBehavior};

/// Production ping period; tests shrink this so idle sockets prove liveness quickly.
pub const WEBSOCKET_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// Production silence budget; sized as a few missed pings before closing an agent session.
pub const WEBSOCKET_STALE_TIMEOUT: Duration = Duration::from_secs(30);
/// Production stale-poll period; independent of the ping so the threshold can be a multiple of it.
pub const WEBSOCKET_STALE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Process-wide idle timing so CLI/env can shrink production defaults in tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WebSocketTimeouts {
    /// How often idle sockets write a ping so proxies stay alive and half-open links fail.
    pub keepalive: Duration,
    /// How long an agent may stay silent before its session is closed.
    pub stale_timeout: Duration,
    /// How often the session compares last inbound traffic against `stale_timeout`.
    pub stale_check_interval: Duration,
}

impl WebSocketTimeouts {
    /// Returns the shipped defaults used when no CLI or env override is installed.
    pub fn production() -> Self {
        Self {
            keepalive: WEBSOCKET_KEEPALIVE_INTERVAL,
            stale_timeout: WEBSOCKET_STALE_TIMEOUT,
            stale_check_interval: WEBSOCKET_STALE_CHECK_INTERVAL,
        }
    }
}

static TIMEOUTS: OnceLock<WebSocketTimeouts> = OnceLock::new();

/// Installs process-wide timeouts from CLI/env before any socket is opened.
pub fn configure(timeouts: WebSocketTimeouts) {
    let _ = TIMEOUTS.set(timeouts);
}

/// Reads the active timeouts, falling back to production when `configure` was not called.
pub fn timeouts() -> WebSocketTimeouts {
    TIMEOUTS
        .get()
        .copied()
        .unwrap_or_else(WebSocketTimeouts::production)
}

/// Creates a delayed interval so opening a socket does not immediately add a control frame.
pub fn keepalive_interval() -> Interval {
    let mut interval = tokio::time::interval(timeouts().keepalive);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval.reset();
    interval
}

/// Parses `10s`, `200ms`, or a bare millisecond integer for CLI and env overrides.
pub fn parse_duration_millis(value: &str) -> Result<Duration, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("duration must not be empty".to_string());
    }
    if let Some(milliseconds) = value.strip_suffix("ms") {
        return parse_positive_count(milliseconds.trim(), "milliseconds")
            .map(Duration::from_millis);
    }
    if let Some(seconds) = value.strip_suffix('s') {
        return parse_positive_count(seconds.trim(), "seconds").map(Duration::from_secs);
    }
    parse_positive_count(value, "milliseconds").map(Duration::from_millis)
}

/// Rejects zero so a disabled timer cannot be confused with a valid interval.
fn parse_positive_count(value: &str, unit: &str) -> Result<u64, String> {
    let count = value
        .parse::<u64>()
        .map_err(|_| format!("expected a positive number of {unit}"))?;
    if count == 0 {
        return Err(format!("{unit} must be greater than zero"));
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::parse_duration_millis;
    use tokio::time::Duration;

    #[test]
    fn parse_duration_millis_accepts_units_and_bare_milliseconds() {
        // Bare integers stay milliseconds so test env values do not need a suffix.
        assert_eq!(parse_duration_millis("200"), Ok(Duration::from_millis(200)));
        assert_eq!(
            parse_duration_millis("200ms"),
            Ok(Duration::from_millis(200))
        );
        assert_eq!(parse_duration_millis("10s"), Ok(Duration::from_secs(10)));
    }

    #[test]
    fn parse_duration_millis_rejects_empty_and_zero() {
        // Zero would disable keepalive or stale detection instead of speeding it up.
        assert!(parse_duration_millis("").is_err());
        assert!(parse_duration_millis("0").is_err());
        assert!(parse_duration_millis("0s").is_err());
        assert!(parse_duration_millis("0ms").is_err());
    }
}
