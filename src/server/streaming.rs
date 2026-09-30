//! Shared HTTP output lifetime ownership, independent of file and execution policy.

use redoor::{
    actors::router::{RouterHandle, RouterMsg},
    types::{AgentId, RequestId},
};

/// Disconnecting a streaming consumer must release the corresponding remote worker.
pub(crate) struct OutputCancelGuard {
    router: RouterHandle,
    agent_id: AgentId,
    request_id: RequestId,
    active: bool,
}

impl OutputCancelGuard {
    /// Arms cleanup only after the router has admitted a remote stream.
    pub(crate) fn new(router: RouterHandle, agent_id: AgentId, request_id: RequestId) -> Self {
        Self {
            router,
            agent_id,
            request_id,
            active: true,
        }
    }

    /// Consuming a terminal acknowledgement removes the need for disconnect cleanup.
    pub(crate) fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for OutputCancelGuard {
    /// Mailbox backpressure must not lose cleanup when an HTTP body is dropped.
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let router = self.router.clone();
        let agent_id = self.agent_id.clone();
        let request_id = self.request_id;
        tokio::spawn(async move {
            let _ = router
                .send_async(RouterMsg::CancelTransfer {
                    agent_id,
                    request_id,
                })
                .await;
        });
    }
}
