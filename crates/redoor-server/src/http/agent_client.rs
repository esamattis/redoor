//! Typed request/response calls to connected agents.
//!
//! Every one-shot agent command goes through [`AgentClient::call`] with a protocol request
//! that is also an [`AgentCall`]: the request type fixes the response type it decodes to, and
//! the call adds its deadline. Handlers therefore never build router messages, pick timeouts
//! or match result variants themselves, and a caller that gives up always tells the agent to
//! stop.

mod calls;

pub(crate) use calls::*;

use super::error::ApiError;
use crate::actors::router::{
    AgentListEntry, ExecuteCommandRequest, RouterCallError, RouterHandle, RouterMsg,
    RouterSendError,
};
use redoor_core::log;
use redoor_protocol::{
    api::agents::{AgentDetailsResponse, MountPoint},
    ids::{AgentId, RequestId},
    wire::{
        command::Command,
        log::Level,
        request::{AgentRequest, CommandError, CommandOutcome, DecodeError},
    },
};
use std::time::Duration;
use tokio::sync::oneshot;

/// One typed agent request plus what the server decides about it: how long to wait and
/// whether it may be abandoned.
pub(crate) trait AgentCall: AgentRequest {
    /// Operator-facing description used when the agent answers with a malformed response.
    const OPERATION: &'static str;

    /// Whether the command must finish even when its caller goes away. Such a call is not
    /// canceled on the agent when the HTTP request is dropped; only its answer is lost.
    const RUNS_TO_COMPLETION: bool = false;

    /// Deadline for the agent's answer; `None` for work whose duration is unbounded (a
    /// cross-device trash restore).
    fn timeout(&self) -> Option<Duration> {
        Some(STANDARD_TIMEOUT)
    }
}

/// Sends typed commands to agents through the router.
#[derive(Clone, Debug)]
pub(crate) struct AgentClient {
    router: RouterHandle,
}

impl AgentClient {
    /// Creates a client on the shared router.
    pub(crate) fn new(router: RouterHandle) -> Self {
        Self { router }
    }

    /// Runs one command on `agent_id` and returns its typed result.
    ///
    /// When the deadline passes (or the caller's future is dropped, e.g. by an HTTP
    /// disconnect) the router abandons the command and cancels it on the agent, so the agent
    /// stops working for a caller that is no longer there.
    pub(crate) async fn call<C: AgentCall>(
        &self,
        agent_id: &AgentId,
        call: C,
    ) -> Result<C::Response, ApiError> {
        let timeout = call.timeout();
        let command: Command = call.into();
        let outcome = self
            .execute(agent_id, command, timeout, !C::RUNS_TO_COMPLETION)
            .await?;
        C::decode(outcome).map_err(|error| match error {
            DecodeError::Failed(CommandError { kind, message }) => {
                ApiError::Command { kind, message }
            }
            DecodeError::Malformed(_) => ApiError::Unexpected(C::OPERATION),
        })
    }

    /// Agent-reported runtime details with the registration-owned fields (name, directory,
    /// platform, binary, account) taken from the router inventory, which is authoritative.
    pub(crate) async fn agent_details(
        &self,
        agent_id: &AgentId,
    ) -> Result<AgentDetailsResponse, ApiError> {
        let mut details = self.call(agent_id, GetAgentDetails {}).await?;
        // Pseudo filesystems are noise in capacity views, so only real mounts are shown.
        details.mount_points.retain(MountPoint::is_visible);
        let entry = self
            .inventory()
            .await?
            .into_iter()
            .find(|entry| &entry.id == agent_id)
            .ok_or_else(|| ApiError::not_found(format!("Agent not found: {agent_id}")))?;
        entry.apply_registration(&mut details);
        Ok(details)
    }

    /// Retained inventory of every agent seen by this server, in router order.
    pub(crate) async fn inventory(&self) -> Result<Vec<AgentListEntry>, ApiError> {
        Ok(self
            .router
            .request(|reply| RouterMsg::GetAgentList { reply })
            .await?)
    }

    /// Resolves a device name or id from a request to the id of a known device.
    ///
    /// Every request value that addresses a device goes through here before access control,
    /// so scope checks and stored references always use ids.
    pub(crate) async fn resolve(&self, value: &str) -> Result<AgentId, ApiError> {
        let value_owned = value.to_string();
        self.router
            .request(|reply| RouterMsg::ResolveDevice {
                value: value_owned,
                reply,
            })
            .await?
            .ok_or_else(|| ApiError::not_found(format!("Device not found: {value}")))
    }

    /// Cancels an admitted execution; `false` when no such execution belongs to the agent.
    pub(crate) async fn cancel_execution(
        &self,
        agent_id: AgentId,
        request_id: RequestId,
    ) -> Result<bool, ApiError> {
        Ok(self
            .router
            .request(|reply| RouterMsg::CancelExecution {
                agent_id,
                request_id,
                reply,
            })
            .await??)
    }

    /// Queues a command and waits for its final result under `timeout`.
    ///
    /// The id is drawn before sending so the guard can abandon exactly this command however
    /// the caller leaves. `cancel_on_abandon` is false for work that must finish even when
    /// nobody waits for its answer.
    async fn execute(
        &self,
        agent_id: &AgentId,
        command: Command,
        timeout: Option<Duration>,
        cancel_on_abandon: bool,
    ) -> Result<CommandOutcome, ApiError> {
        let request_id = self.router.next_request_id();
        let (reply, result) = oneshot::channel();
        // Armed before the send is awaited: a drop while waiting for mailbox capacity then
        // sends a harmless abandon for a command the router never saw.
        let mut pending = PendingCommand {
            router: self.router.clone(),
            agent_id: agent_id.clone(),
            request_id,
            armed: true,
        };
        if self
            .router
            .send_async(RouterMsg::ExecuteCommandRest(ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command,
                request_id,
                cancel_on_abandon,
                reply,
            }))
            .await
            .is_err()
        {
            pending.armed = false;
            return Err(RouterCallError::RouterStopped.into());
        }
        let result = match timeout {
            Some(deadline) => match tokio::time::timeout(deadline, result).await {
                Ok(result) => result,
                Err(_) => {
                    log!(
                        Level::Warning,
                        "Agent command timed out: agent_id={}, timeout_ms={}",
                        agent_id,
                        deadline.as_millis()
                    );
                    return Err(ApiError::Timeout(deadline));
                }
            },
            None => result.await,
        };
        // Any answer, including the router dropping the reply, ends the command's lifetime.
        pending.armed = false;
        result.map_err(|_| RouterCallError::RouterStopped.into())
    }
}

/// Abandons a command whose caller stopped waiting before it answered.
struct PendingCommand {
    router: RouterHandle,
    agent_id: AgentId,
    request_id: RequestId,
    armed: bool,
}

impl Drop for PendingCommand {
    /// Tells the router the caller left, so it forgets the command and, for cancelable ones,
    /// stops it on the agent.
    ///
    /// The router mailbox is FIFO and the execute message is enqueued before the caller can
    /// wait on its answer, so the abandon always arrives after it; an abandon for a command
    /// the router never saw or already settled is a no-op. The message is never dropped: a
    /// full mailbox hands it to a task that waits for capacity.
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let message = RouterMsg::AbandonCommand {
            agent_id: self.agent_id.clone(),
            request_id: self.request_id,
        };
        match self.router.send(message) {
            Ok(()) | Err(RouterSendError::Stopped) => {}
            Err(RouterSendError::Full) => {
                let router = self.router.clone();
                let agent_id = self.agent_id.clone();
                let request_id = self.request_id;
                tokio::spawn(async move {
                    // Waits for mailbox capacity: losing this would leave the agent working for nobody.
                    let _ = router
                        .send_async(RouterMsg::AbandonCommand {
                            agent_id,
                            request_id,
                        })
                        .await;
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::fake_agent::FakeAgent;
    use axum::http::StatusCode;
    use redoor_protocol::wire::ServerToAgent;
    use redoor_protocol::wire::command::CommandErrorKind;

    /// A restore (request cancel scope) with a test-sized deadline.
    struct QuickRestore;

    impl From<QuickRestore> for Command {
        /// Sends an ordinary restore; only the deadline differs.
        fn from(_: QuickRestore) -> Self {
            RestoreTrash {
                location_id: "l".to_string(),
                item_id: "i".to_string(),
                destination_path: "/tmp/restored".to_string(),
            }
            .into()
        }
    }

    impl AgentRequest for QuickRestore {
        type Response = <RestoreTrash as AgentRequest>::Response;
    }

    impl AgentCall for QuickRestore {
        const OPERATION: &'static str = "restoring a test item";

        fn timeout(&self) -> Option<Duration> {
            Some(Duration::from_millis(50))
        }
    }

    /// A restore (request cancel scope) with no deadline, so only a dropped caller ends it.
    struct UnboundedRestore;

    impl From<UnboundedRestore> for Command {
        /// Sends an ordinary restore; only the missing deadline differs.
        fn from(_: UnboundedRestore) -> Self {
            QuickRestore.into()
        }
    }

    impl AgentRequest for UnboundedRestore {
        type Response = <RestoreTrash as AgentRequest>::Response;
    }

    impl AgentCall for UnboundedRestore {
        const OPERATION: &'static str = "restoring a test item";

        fn timeout(&self) -> Option<Duration> {
            None
        }
    }

    /// An echo (connection cancel scope) with a test-sized deadline.
    struct QuickEcho;

    impl From<QuickEcho> for Command {
        /// Sends an ordinary echo; only the deadline differs.
        fn from(_: QuickEcho) -> Self {
            Echo {
                request: redoor_protocol::api::agents::EchoRequest {
                    message: "hi".to_string(),
                    random_sleep: false,
                },
            }
            .into()
        }
    }

    impl AgentRequest for QuickEcho {
        type Response = <Echo as AgentRequest>::Response;
    }

    impl AgentCall for QuickEcho {
        const OPERATION: &'static str = "echoing";

        fn timeout(&self) -> Option<Duration> {
            Some(Duration::from_millis(50))
        }
    }

    /// Typed agent failures and malformed responses become the matching API errors.
    #[tokio::test]
    async fn extract_maps_agent_failures_and_protocol_mismatches() {
        let mut agent = FakeAgent::connect().await;
        let client = AgentClient::new(agent.router.clone());
        let id = agent.agent_id.clone();
        let call = tokio::spawn(async move {
            client
                .call(
                    &id,
                    Metadata {
                        path: "/missing".to_string(),
                    },
                )
                .await
        });
        agent
            .answer(CommandOutcome::error(
                CommandErrorKind::NotFound,
                "No such file",
            ))
            .await;
        let error = call.await.unwrap().unwrap_err();
        // The agent's typed failure keeps its status and message without Debug noise.
        assert_eq!(error.status_code(), StatusCode::NOT_FOUND);
        assert_eq!(error.to_string(), "No such file");

        let client = AgentClient::new(agent.router.clone());
        let id = agent.agent_id.clone();
        let call = tokio::spawn(async move {
            client
                .call(
                    &id,
                    Metadata {
                        path: "/x".to_string(),
                    },
                )
                .await
        });
        agent
            .answer(CommandOutcome::Ok(serde_json::json!(null)))
            .await;
        let error = call.await.unwrap().unwrap_err();
        // A response of another type is a protocol mismatch, reported once, as a 500.
        assert!(
            matches!(error, ApiError::Unexpected(operation) if operation == Metadata::OPERATION)
        );
        assert_eq!(error.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A cancelable command whose deadline passes is canceled on the agent.
    #[tokio::test]
    async fn timeout_cancels_request_scoped_command() {
        let mut agent = FakeAgent::connect().await;
        let client = AgentClient::new(agent.router.clone());
        let error = client
            .call(&agent.agent_id, QuickRestore)
            .await
            .unwrap_err();
        // The caller learns the agent was too slow.
        assert!(matches!(error, ApiError::Timeout(_)));
        let (request_id, _) = agent.next_command().await;
        // The agent is told to stop exactly the abandoned request.
        assert!(matches!(
            agent.next_priority().await,
            ServerToAgent::Cancel { id: canceled , reason: redoor_protocol::wire::partials::CancelReason::Canceled } if canceled == request_id
        ));
    }

    /// A caller that disappears without any deadline cancels its command on the agent through
    /// the explicit abandon message.
    #[tokio::test]
    async fn dropped_caller_cancels_request_scoped_command() {
        let mut agent = FakeAgent::connect().await;
        let client = AgentClient::new(agent.router.clone());
        let id = agent.agent_id.clone();
        let call = tokio::spawn(async move { client.call(&id, UnboundedRestore).await });
        let (request_id, _) = agent.next_command().await;
        // The HTTP request goes away while the agent is still working.
        call.abort();
        let _ = call.await;
        // The agent is told to stop exactly the abandoned request.
        assert!(matches!(
            agent.next_priority().await,
            ServerToAgent::Cancel { id: canceled, .. } if canceled == request_id
        ));
    }

    /// A restore that outlives its HTTP caller keeps running: the agent is not told to
    /// cancel (which would roll the restore back) and its answer is still accepted.
    #[tokio::test]
    async fn dropped_caller_does_not_cancel_run_to_completion_call() {
        let mut agent = FakeAgent::connect().await;
        let client = AgentClient::new(agent.router.clone());
        let id = agent.agent_id.clone();
        let call = tokio::spawn(async move {
            client
                .call(
                    &id,
                    RestoreTrash {
                        location_id: "l".to_string(),
                        item_id: "i".to_string(),
                        destination_path: "/tmp/restored".to_string(),
                    },
                )
                .await
        });
        let (request_id, _) = agent.next_command().await;
        // The HTTP request goes away while the agent is still restoring.
        call.abort();
        let _ = call.await;
        // A later command and its answer prove the router has processed any abandonment.
        let client = AgentClient::new(agent.router.clone());
        let id = agent.agent_id.clone();
        let follow_up = tokio::spawn(async move { client.call(&id, ListAccounts {}).await });
        let (follow_up_id, _) = agent.next_command().await;
        agent
            .respond(
                follow_up_id,
                CommandOutcome::error(CommandErrorKind::Internal, "done"),
            )
            .await;
        assert!(follow_up.await.unwrap().is_err());
        // No cancel frame may reach the agent for the restore.
        assert!(agent.priority.try_recv().is_err());
        agent
            .respond(
                request_id,
                CommandOutcome::Ok(serde_json::json!({"path": "/tmp/restored"})),
            )
            .await;
    }

    /// Commands the agent cannot cancel are only forgotten, never sent a pointless cancel.
    #[tokio::test]
    async fn timeout_forgets_connection_scoped_command() {
        let mut agent = FakeAgent::connect().await;
        let client = AgentClient::new(agent.router.clone());
        let error = client.call(&agent.agent_id, QuickEcho).await.unwrap_err();
        // The deadline still bounds the caller.
        assert!(matches!(error, ApiError::Timeout(_)));
        // A follow-up command proves the router processed the abandonment first.
        let id = agent.agent_id.clone();
        let follow_up = tokio::spawn(async move { client.call(&id, ListAccounts {}).await });
        let _echo = agent.next_command().await;
        agent
            .answer(CommandOutcome::error(CommandErrorKind::Internal, "done"))
            .await;
        assert!(follow_up.await.unwrap().is_err());
        // The echo was abandoned without a cancel frame on the priority lane.
        assert!(agent.priority.try_recv().is_err());
    }
}
