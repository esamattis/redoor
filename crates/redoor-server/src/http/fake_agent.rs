//! A scripted agent connected to a real router, for unit tests of the HTTP service layer.

use crate::actors::lanes::{ControlLanes, QueuedCommand};
use crate::actors::router::{
    ConnectionStreams, RegisterAgentRequest, RouteResponse, RouterHandle, RouterMsg, spawn_router,
};
use crate::workspaces::AgentKey;
use redoor_protocol::{
    ids::{RequestId, SocketId},
    wire::{
        ServerToAgent,
        command::Command,
        request::{AgentRequest, CommandOutcome},
        stream::StreamChunk,
    },
};
use tokio::sync::mpsc;

/// The socket-facing ends of one registered agent: what the server queued for it, and the
/// stream tables its connection reader would deliver frames into.
pub(crate) struct FakeAgent {
    pub(crate) router: RouterHandle,
    pub(crate) agent_id: AgentKey,
    /// Control session the agent registered on; the router only accepts its frames from it.
    socket_id: SocketId,
    pub(crate) commands: mpsc::Receiver<QueuedCommand>,
    pub(crate) priority: mpsc::Receiver<ServerToAgent>,
    /// Kept open so server-to-agent payload frames have somewhere to go.
    _bulk: mpsc::Receiver<StreamChunk>,
    pub(crate) streams: ConnectionStreams,
}

impl FakeAgent {
    /// Starts a router and registers one agent.
    pub(crate) async fn connect() -> Self {
        let (router, _task) = spawn_router();
        let agent_id = AgentKey::new(
            "test",
            redoor_core::test_support::test_agent_id("fake-agent"),
        );
        let (lanes, receivers) = ControlLanes::bounded(16, 16);
        let (commands, mut priority) = (receivers.commands, receivers.priority);
        let streams = ConnectionStreams::new(agent_id.clone());
        let registration =
            RegisterAgentRequest::for_test("test", &agent_id.id, lanes, streams.clone());
        let socket_id = registration.socket_id.clone();
        router
            .send_async(RouterMsg::RegisterAgent(Box::new(registration)))
            .await
            .unwrap();
        let ServerToAgent::Welcome { .. } = Self::next(&mut priority).await else {
            panic!("registration starts with the welcome");
        };
        Self {
            router,
            agent_id,
            socket_id,
            commands,
            priority,
            _bulk: receivers.bulk,
            streams,
        }
    }

    /// Reads the next control frame of one lane.
    pub(crate) async fn next(lane: &mut mpsc::Receiver<ServerToAgent>) -> ServerToAgent {
        lane.recv().await.expect("lane open")
    }

    /// Reads the next command the server sent, skipping withdrawn ones like the session
    /// writer does.
    pub(crate) async fn next_command(&mut self) -> (RequestId, Command) {
        loop {
            let queued = self.commands.recv().await.expect("lane open");
            if queued
                .ticket
                .as_ref()
                .is_some_and(|ticket| !ticket.mark_written())
            {
                continue;
            }
            match queued.frame {
                ServerToAgent::Command { id, command, .. } => return (id, command),
                other => panic!("expected a command, got {other:?}"),
            }
        }
    }

    /// Reads the next priority frame (cancels, credit grants).
    pub(crate) async fn next_priority(&mut self) -> ServerToAgent {
        Self::next(&mut self.priority).await
    }

    /// Sends the final result of `request_id` as the agent would.
    pub(crate) async fn respond(&self, request_id: RequestId, result: CommandOutcome) {
        self.router
            .send_async(RouterMsg::RouteResponse(RouteResponse {
                agent_id: self.agent_id.clone(),
                socket_id: self.socket_id.clone(),
                request_id,
                result,
            }))
            .await
            .unwrap();
    }

    /// Sends request `R`'s successful response, encoded as the agent encodes it.
    pub(crate) async fn respond_ok<R: AgentRequest>(
        &self,
        request_id: RequestId,
        response: R::Response,
    ) {
        self.respond(request_id, R::encode(Ok(response))).await;
    }

    /// Answers the next queued command with `result`.
    pub(crate) async fn answer(&mut self, result: CommandOutcome) {
        let (request_id, _) = self.next_command().await;
        self.respond(request_id, result).await;
    }

    /// Delivers one stream frame through the connection reader's routing.
    pub(crate) async fn deliver(&self, chunk: StreamChunk) {
        if let Some(violation) = self.streams.deliver(chunk) {
            self.router
                .send_async(RouterMsg::CreditViolated(violation))
                .await
                .unwrap();
        }
    }
}
