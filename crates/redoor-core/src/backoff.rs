//! The one retry schedule for every connection redoor keeps alive.
//!
//! Agents reconnecting to the server, the watchdog restarting managed agents and relays
//! relaunching their SSH sessions all share it. Connections are never given up on, so the
//! cap bounds how long a recovered server or network waits before redoor notices, and one
//! schedule means the three paths cannot drift apart again.

use std::time::Duration;

/// First retry delay; a short blip recovers almost at once.
pub const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
/// Longest delay between attempts. Retrying never stops, so this is also the longest a
/// recovered server waits for its agents.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long a connection must stay up before the schedule starts over. A peer that accepts
/// and then drops at once must not be retried at the shortest delay forever.
pub const STABLE_RUNTIME: Duration = Duration::from_secs(30);

/// Exponential retry delay with jitter, capped at [`MAX_BACKOFF`].
///
/// The delay doubles after every attempt. Each wait is drawn from the upper half of the
/// current step ("equal jitter"), so many agents that lost the same server spread their
/// reconnects without any wait ever exceeding the cap.
#[derive(Debug, Clone)]
pub struct Backoff {
    /// Upper bound of the next wait before jitter.
    current: Duration,
}

impl Default for Backoff {
    /// Starts at the shortest delay so the first retry is quick.
    fn default() -> Self {
        Self {
            current: INITIAL_BACKOFF,
        }
    }
}

impl Backoff {
    /// Returns the jittered delay to wait now and doubles the next step up to the cap.
    pub fn next_delay(&mut self) -> Duration {
        let step = self.current;
        self.current = (self.current * 2).min(MAX_BACKOFF);
        jittered(step)
    }

    /// Jumps straight to the cap. Used when retrying soon cannot help (a wrong token, an
    /// incompatible server) but an operator may fix it, so redoor keeps trying slowly.
    pub fn saturate(&mut self) {
        self.current = MAX_BACKOFF;
    }

    /// Starts over at the shortest delay once a connection has proven itself healthy.
    pub fn reset(&mut self) {
        self.current = INITIAL_BACKOFF;
    }

    /// Resets when the attempt that just ended ran for at least [`STABLE_RUNTIME`].
    pub fn reset_if_stable(&mut self, ran_for: Duration) {
        if ran_for >= STABLE_RUNTIME {
            self.reset();
        }
    }
}

/// Picks a wait from the upper half of `step`, so jitter never pushes it past the cap.
fn jittered(step: Duration) -> Duration {
    let half = step / 2;
    let spread = u64::try_from(half.as_millis()).unwrap_or(u64::MAX);
    half + Duration::from_millis(fastrand::u64(0..=spread))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collects the upper bound of each step by draining a fresh schedule.
    fn steps(count: usize) -> Vec<Duration> {
        let mut backoff = Backoff::default();
        (0..count)
            .map(|_| {
                let step = backoff.current;
                backoff.next_delay();
                step
            })
            .collect()
    }

    #[test]
    fn steps_double_up_to_the_cap() {
        // The schedule grows exponentially so a long outage is not hammered ...
        assert_eq!(
            steps(7),
            [1, 2, 4, 8, 16, 30, 30].map(Duration::from_secs).to_vec()
        );
    }

    #[test]
    fn jitter_stays_within_the_upper_half_of_each_step() {
        let mut backoff = Backoff::default();
        for _ in 0..200 {
            let step = backoff.current;
            let delay = backoff.next_delay();
            // ... and jitter only spreads agents out; it never waits past the step,
            // so no wait ever exceeds the 30 second cap.
            assert!(
                delay <= step && delay <= MAX_BACKOFF,
                "{delay:?} > {step:?}"
            );
            // Never retrying almost immediately keeps the exponential growth meaningful.
            assert!(delay >= step / 2, "{delay:?} < half of {step:?}");
        }
    }

    #[test]
    fn saturate_and_reset_move_between_the_ends() {
        let mut backoff = Backoff::default();
        backoff.saturate();
        // A refusal that needs an operator retries at the slowest pace right away.
        assert_eq!(backoff.current, MAX_BACKOFF);
        backoff.reset_if_stable(STABLE_RUNTIME - Duration::from_millis(1));
        // A connection that dropped quickly must not restart the fast retries.
        assert_eq!(backoff.current, MAX_BACKOFF);
        backoff.reset_if_stable(STABLE_RUNTIME);
        // A connection that stayed up long enough starts the schedule over.
        assert_eq!(backoff.current, INITIAL_BACKOFF);
    }
}
