//! Per-agent websocket session actor: requires the `hello`, then bridges the multiplexed
//! connection to the router and the stream tables through bounded, prioritized lanes.

use crate::actors::activity::ConnectionActivity;
use crate::actors::lanes::{ControlLaneReceivers, ControlLanes, QueuedCommand};
use crate::actors::router::{
    ConnectionStreams, RegisterAgentRequest, RegistrationRejection, RouteResponse,
    RouteTransferReadyRequest, RouterHandle, RouterMsg, TransferProgressUpdateRequest,
};
use crate::terminals::registry::TerminalRegistry;
use crate::watchdog::{ConnectVerdict, ConnectingDaemon, WatchdogHandle, WatchdogRegistry};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use redoor_core::log;
use redoor_core::websocket::WebSocketTimeouts;
use redoor_protocol::wire::agent_auth::TokenProof;
use redoor_protocol::wire::handshake::RejectReason;
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::registration::{AgentCapabilities, AgentIdentity};
use redoor_protocol::{
    ids::{AgentId, SocketId},
    wire::{
        AgentToServer, ServerToAgent, command::CommandErrorKind, request::CommandOutcome,
        stream::StreamChunk,
    },
};
use tokio::sync::oneshot;
use tokio::time::{Duration, Instant};

/// Per-agent command backlog allowed before REST admission fails fast.
pub(crate) const CONTROL_COMMAND_QUEUE_CAPACITY: usize = 64;
/// Lifecycle and cancellation traffic has independent capacity from ordinary commands.
const CONTROL_PRIORITY_QUEUE_CAPACITY: usize = 16;
/// How much of an unparsable agent frame is logged; results can be large and carry file
/// contents, and the start of the frame is enough to diagnose it.
const MALFORMED_FRAME_LOG_CHARS: usize = 512;
/// How long an upgraded socket may stay silent before its `hello`.
///
/// The upgrade already required a proof of the token, so this only bounds how long a stuck or
/// buggy client, or one replaying a captured upgrade request, can hold a socket that does not
/// speak for any agent.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a refused connection may take to flush its `rejected` frame before it is dropped.
const REJECTION_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Converts a lane receive result into the next outbound frame while tracking when that lane
/// has closed.
fn take_outbound_frame<T>(frame: Option<T>, lane_closed: &mut bool) -> Option<T> {
    if frame.is_none() {
        *lane_closed = true;
    }
    frame
}

/// Converts a command lane receive result into the next outbound frame, skipping commands a
/// cancel withdrew before they were written, while tracking when the lane has closed.
fn take_command(command: Option<QueuedCommand>, lane_closed: &mut bool) -> Option<WsMessage> {
    let command = take_outbound_frame(command, lane_closed)?;
    if command
        .ticket
        .as_ref()
        .is_some_and(|ticket| !ticket.mark_written())
    {
        return None;
    }
    encode_frame(&command.frame)
}

/// Converts a data lane receive result into the next outbound frame while tracking when that
/// lane has closed.
fn take_data_frame(frame: Option<StreamChunk>, lane_closed: &mut bool) -> Option<WsMessage> {
    if frame.is_none() {
        *lane_closed = true;
    }
    frame.map(|chunk| WsMessage::Binary(chunk.to_bytes().into()))
}

/// Encodes one typed control frame for the socket; this writer is the only place the
/// server-to-agent control protocol becomes JSON.
fn encode_frame(frame: &ServerToAgent) -> Option<WsMessage> {
    match serde_json::to_string(frame) {
        Ok(json) => Some(WsMessage::Text(json.into())),
        Err(error) => {
            redoor_core::log_failure!(
                Level::Error,
                "Failed to serialize control frame for agent: error={}",
                error
            );
            None
        }
    }
}

/// The identity fields of an agent's `hello`, unpacked from the wire frame.
struct Hello {
    agent_id: AgentId,
    agent_name: String,
    identity: AgentIdentity,
    capabilities: AgentCapabilities,
    /// Spec hash of a managed daemon, checked against the watchdog's latest ensure report.
    spec_hash: Option<String>,
}

/// Whether the read loop keeps serving the socket after one frame.
#[derive(Debug, PartialEq, Eq)]
enum SessionStep {
    Continue,
    /// The peer broke the protocol; drop the socket right away.
    Close,
    /// The `hello` was refused; flush the queued `rejected` frame, then close.
    Rejected,
}

/// Runtime state held for one websocket-backed agent session.
struct SessionRuntime {
    /// Identifies the websocket connection so the router can map routed work back
    /// to this specific session.
    socket_id: SocketId,
    /// Provides the actor handle used to register the session and forward control
    /// and streaming messages into the routing layer.
    router_ref: RouterHandle,
    /// Absent until the router accepted this connection's `hello`; afterwards every frame is
    /// attributed to this agent, because frames themselves carry no identity.
    agent_id: Option<AgentId>,
    /// Typed command and priority lanes this session's writer drains.
    lanes: ControlLanes,
    /// The proof of the token over both handshake nonces the `hello` must carry. The upgrade
    /// proof is replayable, so this is what shows the agent took part in this handshake.
    hello_proof: TokenProof,

    /// Populated after `hello` if the agent id has a matching watchdog supervisor. The stale
    /// check uses this to signal the supervisor when the WebSocket goes silent. Stays `None`
    /// for agents that aren't supervised (e.g. manually-spawned external agents), whose stale
    /// sockets are closed without restarting a process.
    watchdog: Option<WatchdogHandle>,
    /// Terminal sessions the agent reports; sessions belong to the agent process, so its
    /// reports replace what the server knew about them.
    terminals: TerminalRegistry,
    /// Payload stream tables of the registered session; credit the agent returns for
    /// server-to-agent streams is applied here directly, never through the router mailbox.
    streams: Option<ConnectionStreams>,
    /// When the agent last sent anything; drives the stale check here and tells the router
    /// whether this connection is still healthy when another `hello` claims its id.
    activity: ConnectionActivity,
}

impl SessionRuntime {
    /// Handles one control frame: `hello` before registration, everything else after it.
    async fn handle_control_message(
        &mut self,
        message: AgentToServer,
        watchdog_registry: &WatchdogRegistry,
    ) -> SessionStep {
        match (self.agent_id.clone(), message) {
            (
                None,
                AgentToServer::Hello {
                    agent_id,
                    agent_name,
                    token_proof,
                    identity,
                    capabilities,
                    spec_hash,
                },
            ) => {
                if !self.hello_proof.matches(&token_proof) {
                    log!(
                        Level::Warning,
                        "Closing agent socket whose hello does not prove the token: socket_id={}",
                        self.socket_id
                    );
                    return SessionStep::Close;
                }
                self.register(
                    Hello {
                        agent_id,
                        agent_name,
                        identity: *identity,
                        capabilities,
                        spec_hash,
                    },
                    watchdog_registry,
                )
                .await
            }
            (None, other) => {
                log!(
                    Level::Warning,
                    "Closing agent socket that sent a frame before hello: socket_id={}, frame={}",
                    self.socket_id,
                    other.kind()
                );
                SessionStep::Close
            }
            (Some(_), AgentToServer::Hello { .. }) => {
                log!(
                    Level::Warning,
                    "Closing agent socket that sent a second hello: socket_id={}",
                    self.socket_id
                );
                SessionStep::Close
            }
            (Some(agent_id), other) => {
                self.handle_agent_frame(agent_id, other).await;
                SessionStep::Continue
            }
        }
    }

    /// Links the watchdog supervisor and asks the router to accept the agent.
    async fn register(
        &mut self,
        hello: Hello,
        watchdog_registry: &WatchdogRegistry,
    ) -> SessionStep {
        // Look up the supervisor for this agent id, which the server passed to the agents it
        // spawns. A `None` result is fine: it just means the agent is not supervised by the
        // watchdog (e.g. an external agent spawned outside the server) and stale cleanup has
        // no process to restart.
        self.watchdog = watchdog_registry.lookup(hello.agent_id.as_str());
        if self.watchdog.is_none() && hello.spec_hash.is_some() {
            // A managed daemon whose device this server does not manage (deleted, or from
            // another server sharing the token) must not show up as a standalone device; the
            // rejection ends it.
            log!(
                Level::Warning,
                "Rejecting managed agent daemon without a configured device: agent_id={}, agent_name={}",
                hello.agent_id,
                hello.agent_name
            );
            let _ = self.lanes.try_priority(ServerToAgent::Rejected {
                reason: RejectReason::Stopped,
                message: "This server manages no device with this agent's id".to_string(),
            });
            return SessionStep::Rejected;
        }
        let mut watchdog_attempt_generation = None;
        if let Some(watchdog) = self.watchdog.as_ref() {
            let daemon = ConnectingDaemon {
                binary: hello.identity.binary.clone(),
                spec_hash: hello.spec_hash.clone(),
            };
            let (reason, message) = match watchdog
                .mark_connected(self.socket_id.clone(), daemon)
                .await
            {
                ConnectVerdict::Accepted(attempt_generation) => {
                    watchdog_attempt_generation = Some(attempt_generation);
                    (None, "")
                }
                ConnectVerdict::Stopped => (
                    Some(RejectReason::Stopped),
                    "Managed agent is intentionally stopped",
                ),
                ConnectVerdict::Superseded => (
                    Some(RejectReason::Superseded),
                    "This daemon's build or settings differ from the daemon the server started; it is being replaced",
                ),
            };
            if let Some(reason) = reason {
                log!(
                    Level::Warning,
                    "Rejecting managed agent: agent_name={}, reason={:?}",
                    hello.agent_name,
                    reason
                );
                self.watchdog = None;
                let _ = self.lanes.try_priority(ServerToAgent::Rejected {
                    reason,
                    message: message.to_string(),
                });
                return SessionStep::Rejected;
            }
            log!(
                Level::Debug,
                "Session linked to watchdog supervisor: agent_name={}",
                hello.agent_name
            );
        }
        let agent_id = hello.agent_id.clone();
        let streams = ConnectionStreams::new(agent_id.clone());
        let (socket_id, lanes, watchdog) = (
            self.socket_id.clone(),
            self.lanes.clone(),
            self.watchdog.clone(),
        );
        let registered_streams = streams.clone();
        let activity = self.activity.clone();
        // Registration installs the routing entry every later frame depends on, so a
        // momentarily full mailbox must delay it rather than silently drop it.
        let decision = self
            .router_ref
            .request(move |reply| {
                RouterMsg::RegisterAgent(Box::new(RegisterAgentRequest {
                    agent_id: hello.agent_id,
                    agent_name: hello.agent_name,
                    socket_id,
                    lanes,
                    identity: hello.identity,
                    capabilities: hello.capabilities,
                    watchdog,
                    watchdog_attempt_generation,
                    streams: registered_streams,
                    activity,
                    reply: Some(reply),
                }))
            })
            .await;
        match decision {
            Ok(Ok(())) => {
                self.streams = Some(streams);
                self.agent_id = Some(agent_id);
                SessionStep::Continue
            }
            Ok(Err(RegistrationRejection { reason, message })) => {
                log!(
                    Level::Warning,
                    "Agent hello rejected: agent_id={}, socket_id={}, reason={:?}, message={}",
                    agent_id,
                    self.socket_id,
                    reason,
                    message
                );
                if let Some(watchdog) = self.watchdog.take() {
                    watchdog.mark_disconnected(self.socket_id.clone());
                }
                SessionStep::Rejected
            }
            Err(error) => {
                redoor_core::log_failure!(
                    Level::Error,
                    "Failed to register agent: agent_id={}, socket_id={}, error={}",
                    agent_id,
                    self.socket_id,
                    error
                );
                SessionStep::Close
            }
        }
    }

    /// Handles a frame from a session whose `hello` was accepted.
    ///
    /// Frames carry no agent id: the session's registered id (bound to an authenticated
    /// upgrade) is the only identity the router checks ownership against, so a client cannot
    /// answer or steer another agent's requests.
    async fn handle_agent_frame(&mut self, agent_id: AgentId, message: AgentToServer) {
        match message {
            AgentToServer::Hello { .. } => {}
            AgentToServer::Result { id, outcome } => {
                // Terminal responses release pending requests and transfer state, so
                // temporary mailbox pressure must never discard their cleanup signal.
                if let Err(error) = self
                    .router_ref
                    .send_async(RouterMsg::RouteResponse(RouteResponse {
                        agent_id: agent_id.clone(),
                        socket_id: self.socket_id.clone(),
                        request_id: id,
                        result: outcome,
                    }))
                    .await
                {
                    redoor_core::log_failure!(
                        Level::Error,
                        "Failed to queue command response: agent_id={}, request_id={}, error={}",
                        agent_id,
                        id,
                        error
                    );
                }
            }
            AgentToServer::PublishRequest { id } => {
                let _ = self
                    .router_ref
                    .send_async(RouterMsg::BeginUploadPublication {
                        agent_id,
                        socket_id: self.socket_id.clone(),
                        request_id: id,
                    })
                    .await;
            }
            AgentToServer::Credit { stream, frames } => {
                let first = self
                    .streams
                    .as_ref()
                    .is_some_and(|streams| streams.grant_outbound(stream, frames));
                // An upload's first grant is the agent's signal that its worker is ready.
                if first {
                    let _ = self
                        .router_ref
                        .send_async(RouterMsg::RouteTransferReady(RouteTransferReadyRequest {
                            agent_id,
                            socket_id: self.socket_id.clone(),
                            request_id: stream,
                        }))
                        .await;
                }
            }
            AgentToServer::TerminalEvent { stream, event } => {
                if let Some(streams) = &self.streams {
                    streams.deliver_terminal_event(stream, event);
                }
            }
            AgentToServer::TerminalSessions { sessions } => {
                self.terminals.report(&agent_id, sessions);
            }
            AgentToServer::TransferVerification {
                id,
                bytes,
                verifying,
            } => {
                self.router_ref
                    .send_async(RouterMsg::LocalVerification {
                        agent_id,
                        request_id: id,
                        bytes,
                        verifying,
                    })
                    .await
                    .ok();
            }
            AgentToServer::TransferProgress {
                id,
                transferred_bytes,
                total_bytes,
            } => {
                // Late archive totals and local copy progress arrive once or rarely, so waiting
                // for mailbox capacity is cheap while dropping them would leave stale progress.
                let _ = self
                    .router_ref
                    .send_async(RouterMsg::TransferProgressUpdate(
                        TransferProgressUpdateRequest {
                            agent_id,
                            socket_id: self.socket_id.clone(),
                            request_id: id,
                            transferred_bytes,
                            total_bytes,
                        },
                    ))
                    .await;
            }
        }
    }

    /// Unregisters the session's agent after the websocket goes away.
    async fn shutdown(self) {
        if let Some(watchdog) = self.watchdog.as_ref() {
            watchdog.mark_disconnected(self.socket_id.clone());
        }
        if let Some(agent_id) = self.agent_id
            && let Err(error) = self
                .router_ref
                .send_async(RouterMsg::UnregisterAgent {
                    agent_id: agent_id.clone(),
                    socket_id: self.socket_id.clone(),
                })
                .await
        {
            redoor_core::log_failure!(
                Level::Error,
                "Failed to queue disconnected agent cleanup: agent_id={}, socket_id={}, error={}",
                agent_id,
                self.socket_id,
                error
            );
        }

        log!(Level::Info, "Session stopped: socket_id={}", self.socket_id);
    }

    /// Dispatches one inbound websocket frame to the appropriate handler.
    async fn handle_ws_message(
        &mut self,
        message: WsMessage,
        watchdog_registry: &WatchdogRegistry,
    ) -> SessionStep {
        match message {
            WsMessage::Text(text) => match serde_json::from_str::<AgentToServer>(&text) {
                Ok(message) => {
                    self.handle_control_message(message, watchdog_registry)
                        .await
                }
                Err(error) if self.agent_id.is_none() => {
                    log!(
                        Level::Warning,
                        "Closing agent socket whose first frame is not a hello: socket_id={}, error={}",
                        self.socket_id,
                        error
                    );
                    SessionStep::Close
                }
                Err(error) => self.handle_malformed_frame(&text, error).await,
            },
            WsMessage::Binary(bytes) => self.handle_stream_frame(bytes).await,
            _ => SessionStep::Continue,
        }
    }

    /// Decides on a periodic check whether the socket must close: a socket that never said
    /// `hello`, or one that has been silent past the stale timeout (a half-open connection,
    /// e.g. a dead SSH tunnel). Managed agents also ask their watchdog for a restart.
    fn should_close(&self, opened_at: Instant, timeouts: &WebSocketTimeouts) -> bool {
        if self.agent_id.is_none() && opened_at.elapsed() > HELLO_TIMEOUT {
            log!(
                Level::Warning,
                "Closing agent socket that sent no hello: socket_id={}",
                self.socket_id
            );
            return true;
        }
        let idle = self.activity.idle();
        if idle <= timeouts.stale_timeout {
            return false;
        }
        if let Some(watchdog) = self.watchdog.as_ref() {
            log!(
                Level::Warning,
                "WebSocket stale for {:?}, requesting restart: agent_name={}, socket_id={}",
                idle,
                watchdog.key(),
                self.socket_id
            );
            watchdog.signal_stale(self.socket_id.clone());
        } else {
            log!(
                Level::Warning,
                "Unmanaged WebSocket stale for {:?}, closing session: socket_id={}",
                idle,
                self.socket_id
            );
        }
        true
    }

    /// Logs a frame that did not parse and fails the request it belongs to, if it is a result.
    ///
    /// The flow would otherwise wait forever for a result that already came. Only a prefix of
    /// the frame is logged, because results can be large and carry file contents.
    async fn handle_malformed_frame(
        &mut self,
        text: &str,
        error: serde_json::Error,
    ) -> SessionStep {
        let prefix: String = text.chars().take(MALFORMED_FRAME_LOG_CHARS).collect();
        redoor_core::log_failure!(
            Level::Error,
            "Failed to deserialize agent frame: {1}, text prefix: {0}",
            prefix,
            error
        );
        let (Some(agent_id), Some(request_id)) = (
            self.agent_id.clone(),
            AgentToServer::unparsed_result_request_id(text),
        ) else {
            return SessionStep::Continue;
        };
        let response = RouteResponse {
            agent_id,
            socket_id: self.socket_id.clone(),
            request_id,
            result: CommandOutcome::error(
                CommandErrorKind::Internal,
                format!("Agent sent a malformed result: {error}"),
            ),
        };
        if self
            .router_ref
            .send_async(RouterMsg::RouteResponse(response))
            .await
            .is_err()
        {
            return SessionStep::Close;
        }
        SessionStep::Continue
    }

    /// Hands one binary frame straight to its stream's consumer.
    ///
    /// Payload never passes through the router: only a stream's terminal frame is reported to
    /// it. Every stream is credited, so delivery never waits on a consumer and a stalled HTTP
    /// client or copy destination cannot freeze the other streams of this connection.
    async fn handle_stream_frame(&mut self, bytes: bytes::Bytes) -> SessionStep {
        let Some(streams) = &self.streams else {
            log!(
                Level::Warning,
                "Closing agent socket that sent stream data before hello: socket_id={}",
                self.socket_id
            );
            return SessionStep::Close;
        };
        let chunk = match StreamChunk::from_bytes(bytes) {
            Ok(chunk) => chunk,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Closing agent socket that sent a malformed stream frame: socket_id={}, error={}",
                    self.socket_id,
                    error
                );
                return SessionStep::Close;
            }
        };
        if let Some(violation) = streams.deliver(chunk)
            && self
                .router_ref
                .send_async(RouterMsg::CreditViolated(violation))
                .await
                .is_err()
        {
            return SessionStep::Close;
        }
        SessionStep::Continue
    }
}

/// Sends one keepalive ping; a ping forces a write, so a dead connection fails here and the
/// session can tear down instead of lingering. Returns whether the ping was written.
async fn send_ping(sender: &mut SplitSink<WebSocket, WsMessage>, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, sender.send(WsMessage::Ping(bytes::Bytes::new()))).await,
        Ok(Ok(()))
    )
}

/// Entry point for a new agent connection whose upgrade proved the token. Splits the socket
/// into send/receive halves and wires them to the router using explicit Tokio channels; the
/// `hello` must carry `hello_proof` before the agent is registered.
pub(crate) async fn handle_websocket(
    socket: WebSocket,
    socket_id: SocketId,
    router_ref: RouterHandle,
    watchdog_registry: WatchdogRegistry,
    terminals: TerminalRegistry,
    timeouts: redoor_core::websocket::WebSocketTimeouts,
    hello_proof: TokenProof,
) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    let (lanes, receivers) = ControlLanes::bounded(
        CONTROL_COMMAND_QUEUE_CAPACITY,
        CONTROL_PRIORITY_QUEUE_CAPACITY,
    );
    let ControlLaneReceivers {
        commands: mut rx_out_commands,
        priority: mut rx_out_priority,
        interactive: mut rx_out_interactive,
        bulk: mut rx_out_bulk,
    } = receivers;

    let mut runtime = SessionRuntime {
        socket_id: socket_id.clone(),
        router_ref,
        agent_id: None,
        lanes,
        hello_proof,
        watchdog: None,
        terminals,
        streams: None,
        activity: ConnectionActivity::new(ConnectionActivity::healthy_window(&timeouts)),
    };

    log!(Level::Info, "Session started: socket_id={}", socket_id);

    // The writer task signals through this channel when it ends, so the reader
    // loop can stop promptly instead of waiting for the read side to notice the
    // broken connection.
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<()>();

    let mut writer_task = tokio::spawn(async move {
        let mut commands_closed = false;
        let mut priority_closed = false;
        let mut interactive_closed = false;
        let mut bulk_closed = false;
        let mut ping_interval = timeouts.keepalive_interval();

        loop {
            // `biased` drains the classes in strict order: priority control, commands,
            // interactive terminal input, then bulk data. A data frame is at most 64 KiB, so a
            // control frame never waits behind more than one of them.
            let next_message = tokio::select! {
                biased;
                _ = ping_interval.tick() => {
                    if !send_ping(&mut sender, timeouts.stale_timeout).await {
                        break;
                    }
                    continue;
                }
                frame = rx_out_priority.recv(), if !priority_closed => take_outbound_frame(frame, &mut priority_closed).as_ref().and_then(encode_frame),
                frame = rx_out_commands.recv(), if !commands_closed => take_command(frame, &mut commands_closed),
                frame = rx_out_interactive.recv(), if !interactive_closed => take_data_frame(frame, &mut interactive_closed),
                frame = rx_out_bulk.recv(), if !bulk_closed => take_data_frame(frame, &mut bulk_closed),
                // Every bounded lane is closed, so no future frames can be produced.
                else => {
                    let _ = sender.send(WsMessage::Close(None)).await;
                    break;
                }
            };

            let Some(message) = next_message else {
                continue;
            };

            if !matches!(
                tokio::time::timeout(timeouts.stale_timeout, sender.send(message)).await,
                Ok(Ok(()))
            ) {
                // A send failure means the websocket is gone, so continuing to pull
                // router output would only accumulate work for a dead session.
                break;
            }
        }

        let _ = writer_done_tx.send(());
    });

    // The runtime's activity clock tracks the last time we received any frame on the
    // WebSocket. Any inbound frame (Text, Binary, Ping, Pong, Close) resets it. If no frame
    // arrives for the configured stale timeout we assume the connection is half-open (e.g.
    // SSH tunnel died without a TCP close). Managed sessions also ask their watchdog to
    // restart the subprocess.
    let opened_at = Instant::now();
    let mut stale_check = tokio::time::interval(timeouts.stale_check_interval);
    stale_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Burn the first immediate tick so the first stale check fires one
    // interval from now rather than immediately at session start.
    stale_check.tick().await;

    let mut rejected = false;
    loop {
        tokio::select! {
            biased;
            _ = &mut writer_done_rx => break,
            _ = stale_check.tick() => {
                // Breaking out lets `runtime.shutdown()` below unregister the agent and close
                // the writer lane.
                if runtime.should_close(opened_at, &timeouts) {
                    break;
                }
            }
            result = receiver.next() => match result {
                Some(Ok(message)) => {
                    // Any inbound frame (including Pong) resets the
                    // stale timer. The dispatch below happens before
                    // we drop the frame so the runtime can act on it.
                    runtime.activity.touch();
                    match runtime.handle_ws_message(message, &watchdog_registry).await {
                        SessionStep::Continue => {}
                        SessionStep::Close => break,
                        SessionStep::Rejected => {
                            rejected = true;
                            break;
                        }
                    }
                }
                _ => break,
            },
        }
    }

    runtime.shutdown().await;
    if rejected {
        // The session held the last lane senders, so the writer flushes the queued `rejected`
        // frame, closes the socket and ends; the agent then exits, or retries later when the
        // reason was `duplicate_id`.
        if tokio::time::timeout(REJECTION_FLUSH_TIMEOUT, &mut writer_task)
            .await
            .is_err()
        {
            writer_task.abort();
        }
    } else {
        writer_task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::ids::RequestId;
    use tokio::sync::mpsc;

    /// The writer's encoding is the wire format the agent parses.
    #[test]
    fn writer_encodes_typed_frames_as_protocol_json() {
        let frame = ServerToAgent::Cancel {
            id: RequestId::new(5),
            reason: redoor_protocol::wire::partials::CancelReason::Canceled,
        };
        let Some(WsMessage::Text(text)) = encode_frame(&frame) else {
            panic!("control frames are text messages");
        };
        // Agents and fake test agents decode exactly this tag and field.
        assert_eq!(text.as_str(), r#"{"type":"cancel","id":5}"#);
    }

    /// The `hello` proof of a test handshake, for sessions whose tests do not involve it.
    fn test_hello_proof() -> TokenProof {
        use redoor_protocol::wire::agent_auth::{AgentTokenKey, HandshakeNonce, HandshakeNonces};
        AgentTokenKey::new("token").hello_proof(&HandshakeNonces {
            agent: HandshakeNonce::generate(),
            server: HandshakeNonce::generate(),
        })
    }

    /// Builds a session runtime over a capturing router mailbox.
    fn capture_session(
        agent_id: Option<AgentId>,
    ) -> (
        SessionRuntime,
        mpsc::Receiver<crate::actors::router::RouterEnvelope>,
    ) {
        let (sender, receiver) = mpsc::channel(8);
        let (lanes, _receivers) = ControlLanes::bounded(1, 1);
        let runtime = SessionRuntime {
            socket_id: SocketId::new(),
            router_ref: RouterHandle::new(sender),
            agent_id,
            lanes,
            hello_proof: test_hello_proof(),
            watchdog: None,
            terminals: TerminalRegistry::disabled(),
            streams: None,
            activity: ConnectionActivity::new(Duration::from_secs(20)),
        };
        (runtime, receiver)
    }

    /// A result frame that does not parse still fails its request, so the caller does not
    /// wait forever for a result that already came.
    #[tokio::test]
    async fn malformed_result_fails_its_request() {
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let (mut runtime, mut receiver) = capture_session(Some(agent_id.clone()));
        let step = runtime
            .handle_ws_message(
                WsMessage::Text(r#"{"type":"result","id":4}"#.into()),
                &WatchdogRegistry::new(),
            )
            .await;
        // A malformed frame is not a reason to drop the whole connection.
        assert_eq!(step, SessionStep::Continue);
        // The request it names is failed with an internal error.
        assert!(matches!(
            receiver.try_recv().map(|envelope| envelope.message),
            Ok(RouterMsg::RouteResponse(RouteResponse {
                request_id,
                result: CommandOutcome::Error(_),
                ..
            })) if request_id == RequestId::new(4)
        ));
    }

    /// A socket that has not said hello must not reach the router with agent frames, and the
    /// protocol violation closes it: otherwise an authenticated but unidentified socket could
    /// resolve or steer pending requests of whichever agent it guessed.
    #[tokio::test]
    async fn frames_before_hello_close_the_socket() {
        let watchdog_registry = WatchdogRegistry::new();
        let request_id = RequestId::new(1);
        for frame in [
            AgentToServer::Result {
                id: request_id,
                outcome: CommandOutcome::Ok(serde_json::Value::Null),
            },
            AgentToServer::TransferProgress {
                id: request_id,
                transferred_bytes: 1,
                total_bytes: None,
            },
            AgentToServer::PublishRequest { id: request_id },
            AgentToServer::Credit {
                stream: request_id,
                frames: 1,
            },
        ] {
            let (mut runtime, mut receiver) = capture_session(None);
            let step = runtime
                .handle_control_message(frame, &watchdog_registry)
                .await;
            // The socket is dropped instead of waiting for a hello that may never come.
            assert_eq!(step, SessionStep::Close);
            // Nothing may be queued for the router before the hello was accepted.
            assert!(
                receiver
                    .try_recv()
                    .map(|envelope| envelope.message)
                    .is_err()
            );
        }
    }

    /// A registered session routes frames under its own agent id, because frames carry none.
    #[tokio::test]
    async fn registered_session_routes_frames_under_its_own_agent_id() {
        let own = redoor_core::test_support::test_agent_id("own");
        let (mut runtime, mut receiver) = capture_session(Some(own.clone()));
        let socket_id = runtime.socket_id.clone();
        runtime
            .handle_control_message(
                AgentToServer::Result {
                    id: RequestId::new(3),
                    outcome: CommandOutcome::Ok(serde_json::Value::Null),
                },
                &WatchdogRegistry::new(),
            )
            .await;
        // The router sees the session's identity and socket, which it checks for ownership.
        let Ok(RouterMsg::RouteResponse(response)) =
            receiver.try_recv().map(|envelope| envelope.message)
        else {
            panic!("registered session should forward the response");
        };
        assert_eq!(response.agent_id, own);
        assert_eq!(response.socket_id, socket_id);
    }

    /// A hello without this handshake's proof, as from a client that replayed a captured
    /// upgrade request, closes the socket before the router ever sees the agent.
    #[tokio::test]
    async fn hello_without_the_handshake_proof_closes_the_socket() {
        let (mut runtime, mut receiver) = capture_session(None);
        let mut hello: serde_json::Value = serde_json::from_str(
            r#"{"type":"hello","agent_id":"dev_abcdefghijklmnopqrstuvwxyz","agent_name":"replayed","os":"linux","arch":"x86_64","hostname":"h","username":"u","cwd":"/","binary":{"version":"0.0.0","git_rev":"r","git_dirty":false,"version_dirty":false,"build_mode":"debug","build_date":"d"},"uid":1000,"is_root":false,"supports_native_open":false,"supports_trash":false,"supports_move_to_trash":false}"#,
        )
        .unwrap();
        // A proof of another handshake, such as the one in the captured request's own hello.
        hello["token_proof"] = test_hello_proof().as_str().into();
        let step = runtime
            .handle_control_message(
                serde_json::from_value(hello).unwrap(),
                &WatchdogRegistry::new(),
            )
            .await;
        // Without the proof the socket cannot speak for any agent.
        assert_eq!(step, SessionStep::Close);
        // The agent was never registered.
        assert!(
            receiver
                .try_recv()
                .map(|envelope| envelope.message)
                .is_err()
        );
    }

    /// A managed daemon whose device this server does not manage is refused instead of
    /// showing up as a standalone device, which ends it.
    #[tokio::test]
    async fn daemon_without_a_supervisor_is_rejected() {
        let (mut runtime, mut receiver) = capture_session(None);
        let mut hello: serde_json::Value = serde_json::from_str(
            r#"{"type":"hello","agent_id":"dev_abcdefghijklmnopqrst","agent_name":"orphan","os":"linux","arch":"x86_64","hostname":"h","username":"u","cwd":"/","binary":{"version":"0.0.0","git_rev":"r","git_dirty":false,"version_dirty":false,"build_mode":"debug","build_date":"d"},"uid":1000,"is_root":false,"supports_native_open":false,"supports_trash":false,"supports_move_to_trash":false,"spec_hash":"spec"}"#,
        )
        .unwrap();
        hello["token_proof"] = runtime.hello_proof.as_str().into();
        let step = runtime
            .handle_control_message(
                serde_json::from_value(hello).unwrap(),
                &WatchdogRegistry::new(),
            )
            .await;
        // The rejection is flushed and the socket closed, which makes the daemon exit.
        assert_eq!(step, SessionStep::Rejected);
        // The router never learns about the daemon, so no external device appears.
        assert!(
            receiver
                .try_recv()
                .map(|envelope| envelope.message)
                .is_err()
        );
    }

    /// A second hello on an accepted connection is a protocol violation, not a re-register.
    #[tokio::test]
    async fn second_hello_closes_the_socket() {
        let (mut runtime, mut receiver) =
            capture_session(Some(redoor_core::test_support::test_agent_id("own")));
        let hello: AgentToServer = serde_json::from_str(
            r#"{"type":"hello","agent_id":"other","agent_name":"other","token_proof":"p","os":"linux","arch":"x86_64","hostname":"h","username":"u","cwd":"/","binary":{"version":"0.0.0","git_rev":"r","git_dirty":false,"version_dirty":false,"build_mode":"debug","build_date":"d"},"uid":1000,"is_root":false,"supports_native_open":false,"supports_trash":false,"supports_move_to_trash":false}"#,
        )
        .unwrap();
        let step = runtime
            .handle_control_message(hello, &WatchdogRegistry::new())
            .await;
        // Switching identity mid-connection would let one agent speak for another.
        assert_eq!(step, SessionStep::Close);
        assert!(
            receiver
                .try_recv()
                .map(|envelope| envelope.message)
                .is_err()
        );
    }

    /// Exercises session dispatch under backpressure so completion cleanup cannot be lost.
    #[tokio::test]
    async fn command_response_waits_for_router_capacity_before_routing() {
        let (sender, mut receiver) = mpsc::channel(1);
        let router_ref = RouterHandle::new(sender);
        router_ref
            .send(RouterMsg::CheckPendingUiRefresh)
            .expect("router mailbox filled");
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let request_id = RequestId::new(42);
        let (lanes, _receivers) = ControlLanes::bounded(1, 1);
        let mut runtime = SessionRuntime {
            socket_id: SocketId::new(),
            router_ref,
            agent_id: Some(agent_id.clone()),
            lanes,
            hello_proof: test_hello_proof(),
            watchdog: None,
            terminals: TerminalRegistry::disabled(),
            streams: None,
            activity: ConnectionActivity::new(Duration::from_secs(20)),
        };
        let watchdog_registry = WatchdogRegistry::new();
        let response = runtime.handle_control_message(
            AgentToServer::Result {
                id: request_id,
                outcome: CommandOutcome::Ok(serde_json::Value::Null),
            },
            &watchdog_registry,
        );
        tokio::pin!(response);

        // Poll the actual handler to distinguish backpressure from a silently dropped response.
        assert!(futures_util::poll!(&mut response).is_pending());
        // Only the preexisting message may occupy the mailbox while completion is waiting.
        assert!(matches!(
            receiver.recv().await.map(|envelope| envelope.message),
            Some(RouterMsg::CheckPendingUiRefresh)
        ));
        response.await;
        // The completion payload must survive capacity pressure unchanged for transfer cleanup.
        assert!(matches!(
            receiver.recv().await.map(|envelope| envelope.message),
            Some(RouterMsg::RouteResponse(RouteResponse {
                agent_id: received_agent_id,
                request_id: received_request_id,
                socket_id: _,
                result: CommandOutcome::Ok(serde_json::Value::Null),
            })) if received_agent_id == agent_id && received_request_id == request_id
        ));
    }

    /// Verifies teardown waits for router capacity instead of dropping the unregistration.
    #[tokio::test]
    async fn shutdown_waits_for_router_capacity_before_unregistering_agent() {
        let (sender, mut receiver) = mpsc::channel(1);
        let router_ref = RouterHandle::new(sender);
        router_ref
            .send(RouterMsg::CheckPendingUiRefresh)
            .expect("router mailbox filled");
        let socket_id = SocketId::new();
        let (lanes, _receivers) = ControlLanes::bounded(1, 1);
        let runtime = SessionRuntime {
            socket_id: socket_id.clone(),
            router_ref,
            agent_id: Some(redoor_core::test_support::test_agent_id("agent")),
            lanes,
            hello_proof: test_hello_proof(),
            watchdog: None,
            terminals: TerminalRegistry::disabled(),
            streams: None,
            activity: ConnectionActivity::new(Duration::from_secs(20)),
        };

        let shutdown_task = tokio::spawn(runtime.shutdown());
        tokio::task::yield_now().await;

        // A full mailbox must backpressure teardown instead of completing after dropping cleanup.
        assert!(!shutdown_task.is_finished());
        assert!(matches!(
            receiver.recv().await.map(|envelope| envelope.message),
            Some(RouterMsg::CheckPendingUiRefresh)
        ));
        let cleanup = receiver.recv().await.map(|envelope| envelope.message);
        // Releasing one slot must deliver the exact session cleanup that was waiting for capacity.
        assert!(matches!(
            cleanup,
            Some(RouterMsg::UnregisterAgent {
                agent_id,
                socket_id: received_socket_id,
            }) if agent_id == redoor_core::test_support::test_agent_id("agent") && received_socket_id == socket_id
        ));
        shutdown_task.await.expect("session shutdown task joined");
    }
}
