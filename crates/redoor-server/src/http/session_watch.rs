//! Ends browser websockets when the session that opened them ends.
//!
//! A websocket is authenticated once, at the upgrade. Without a watch, a terminal or a live
//! log left open would keep streaming to a browser whose session expired, was logged out or
//! lost its password long ago, which defeats the short idle sessions.

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message as WsMessage, Utf8Bytes};
use futures_util::{Sink, SinkExt};

use super::auth::{ActiveSession, AuthState, SessionStatus};

/// Close code telling the UI the session ended, so it goes to the login page instead of
/// reconnecting. In the 4000-4999 range reserved for applications, echoing HTTP 401.
pub(crate) const SESSION_ENDED_CLOSE_CODE: u16 = 4401;
/// Close code telling the UI the session was revoked because two browsers used its cookie,
/// so the login page can say why. Echoes HTTP 409 Conflict.
pub(crate) const SESSION_REUSED_CLOSE_CODE: u16 = 4409;
/// How often an open socket checks its session. Bounds how long a socket outlives its
/// session, while costing only one small file read per socket and interval.
const SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// How long the close frame may take, so a stalled browser cannot keep the bridge alive.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a watched session ended, because the UI tells the user about a reuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionEnd {
    /// Expired, logged out, signed out elsewhere or revoked by a credential change.
    Ended,
    /// Revoked because its cookie was used by two browsers.
    Reused,
}

/// Watches one browser session from a websocket task.
#[derive(Clone)]
pub(crate) struct SessionWatch {
    auth: AuthState,
    session_id: String,
}

impl SessionWatch {
    /// Watches the session the upgrade request was authenticated with.
    pub(crate) fn new(auth: AuthState, session: &ActiveSession) -> Self {
        Self {
            auth,
            session_id: session.id.clone(),
        }
    }

    /// Resolves once the session is no longer valid: expired, logged out, revoked by a
    /// password or OIDC change, or revoked for reuse; says which. Checking never renews, so
    /// an open socket alone does not keep an idle browser signed in.
    pub(crate) async fn ended(&self) -> SessionEnd {
        let start = tokio::time::Instant::now() + SESSION_CHECK_INTERVAL;
        let mut checks = tokio::time::interval_at(start, SESSION_CHECK_INTERVAL);
        checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            checks.tick().await;
            match self.auth.check_session_id(&self.session_id).await {
                SessionStatus::Live => {}
                SessionStatus::Ended => return SessionEnd::Ended,
                SessionStatus::Reused => return SessionEnd::Reused,
            }
        }
    }
}

/// Closes a browser socket with the close code of `end`, bounded by a timeout.
pub(crate) async fn close_for_ended_session<S>(sink: &mut S, end: SessionEnd)
where
    S: Sink<WsMessage> + Unpin,
{
    let frame = match end {
        SessionEnd::Ended => CloseFrame {
            code: SESSION_ENDED_CLOSE_CODE,
            reason: Utf8Bytes::from_static("Session ended"),
        },
        SessionEnd::Reused => CloseFrame {
            code: SESSION_REUSED_CLOSE_CODE,
            reason: Utf8Bytes::from_static("Session used from another browser"),
        },
    };
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, sink.send(WsMessage::Close(Some(frame)))).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::auth::test_support::signed_in_auth;

    /// A watch on a live session stays pending, and resolves at the next check once the
    /// session is logged out.
    #[tokio::test(start_paused = true)]
    async fn watch_ends_after_logout() {
        let (_directory, auth, session) = signed_in_auth().await;
        let watch = SessionWatch::new(auth.clone(), &session);
        // Several check intervals of a valid session do not end the watch.
        assert!(
            tokio::time::timeout(SESSION_CHECK_INTERVAL * 3, watch.ended())
                .await
                .is_err()
        );
        auth.delete_session_id(&session.id)
            .await
            .expect("logout must succeed");
        // The next check notices the logout, so the socket would close with the plain code.
        assert_eq!(watch.ended().await, SessionEnd::Ended);
    }
}
