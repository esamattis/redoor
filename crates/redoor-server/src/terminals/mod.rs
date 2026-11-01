//! The server's view of terminal sessions.
//!
//! Shells and their mirrored screens live in the agent processes, so they survive server
//! restarts. The server keeps an index of the sessions, saved across its own restarts, and
//! decides which one browser views each of them. This is long-lived server state, not HTTP,
//! so the REST and websocket handlers in `http` only look sessions up here.

pub(crate) mod registry;
pub(crate) mod store;

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
