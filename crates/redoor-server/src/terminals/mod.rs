//! Server-owned terminal sessions.
//!
//! A session owns its agent terminal stream, so the shell lives until the session is closed
//! instead of until a browser socket closes. Browsers attach to a session to view it, one at
//! a time, and get the mirrored screen first. This is long-lived server state, not HTTP, so
//! the REST and websocket handlers in `http` only look sessions up here.

pub(crate) mod emulator;
mod pending_tail;
pub(crate) mod registry;
pub(crate) mod session;

use crate::actors::router::{RouterHandle, RouterMsg, RouterSendError};

/// Tells open browser windows that the session list changed, so they add or drop tabs.
#[derive(Clone)]
pub(crate) struct TerminalsChangedNotifier {
    /// `None` in unit tests, which have no router.
    router: Option<RouterHandle>,
}

impl TerminalsChangedNotifier {
    /// Publishes through the router's UI broadcast.
    pub(crate) fn new(router: RouterHandle) -> Self {
        Self {
            router: Some(router),
        }
    }

    /// A notifier that publishes nothing, for session tests.
    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self { router: None }
    }

    /// Queues the event without waiting; a full mailbox hands it to a task so the session
    /// loop never blocks on the router.
    pub(crate) fn publish(&self) {
        let Some(router) = &self.router else {
            return;
        };
        if let Err(RouterSendError::Full) = router.send(RouterMsg::TerminalsChanged) {
            let router = router.clone();
            tokio::spawn(async move {
                let _ = router.send_async(RouterMsg::TerminalsChanged).await;
            });
        }
    }
}
