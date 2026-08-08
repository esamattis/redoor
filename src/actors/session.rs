use crate::actors::router::{
    RegisterAgentRequest, RouteResponse, RouteTransferReadyRequest, RouterHandle, RouterMsg,
    TransferProgressUpdateRequest,
};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message, SocketId};
use crate::watchdog::{WatchdogHandle, WatchdogRegistry};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::time::Instant;
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};

/// Constant-time string equality so invalid tokens do not leak length via timing.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_digest = Sha256::digest(left.as_bytes());
    let right_digest = Sha256::digest(right.as_bytes());
    bool::from(left_digest.ct_eq(&right_digest))
}

/// Interval between websocket Ping frames sent by the server to proactively
/// detect half-open connections. When the SSH tunnel drops without a clean
/// TCP close, the read side may not notice for a long time. Periodic pings
/// force a write that fails fast if the underlying connection is gone,
/// allowing the session to clean up and free the agent name.
const WEBSOCKET_PING_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_secs(10);

/// How often the session checks whether the WebSocket has gone silent.
/// Independent of the ping interval so the stale check can use a multiple
/// of the ping interval as its threshold.
const WEBSOCKET_STALE_CHECK_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_secs(5);

/// No inbound frame for at least this long means the WebSocket is
/// treated as stale and the supervisor is asked to restart the
/// subprocess. Sized as 3x the ping interval so two missed pongs
/// (= 30s of silence) trigger a restart.
const WEBSOCKET_STALE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(30);

/// Converts a lane receive result into the next outbound websocket frame while
/// tracking when that lane has closed.
fn take_outbound_message(message: Option<WsMessage>, lane_closed: &mut bool) -> Option<WsMessage> {
    match message {
        Some(message) => Some(message),
        None => {
            *lane_closed = true;
            None
        }
    }
}

/// Runtime state held for one websocket-backed agent session.
struct SessionRuntime {
    /// Identifies the websocket connection so the router can map routed work back
    /// to this specific session.
    socket_id: SocketId,
    /// Provides the actor handle used to register the session and forward control
    /// and streaming messages into the routing layer.
    router_ref: RouterHandle,
    /// Remains absent until the websocket sends `Message::AgentRegister`, because
    /// the socket exists before the remote agent has announced which logical
    /// agent identity it should be associated with.
    agent_id: Option<AgentId>,
    /// Sends control and other small text frames without backpressure so router
    /// notifications stay responsive.
    outgoing_text: mpsc::UnboundedSender<WsMessage>,

    /// Populated after `AgentRegister` if the registered agent name has a
    /// matching watchdog supervisor. The stale check uses this to signal
    /// the supervisor when the WebSocket goes silent. Stays `None` for
    /// agents that aren't supervised (e.g. manually-spawned external
    /// agents), in which case the stale check is a no-op.
    watchdog: Option<WatchdogHandle>,
    /// Expected `server.agent_token`; registration without this secret is rejected.
    agent_token: String,
}

impl SessionRuntime {
    /// Registers the agent with the router once the websocket announces itself.
    async fn handle_control_message(
        &mut self,
        message: Message,
        watchdog_registry: &WatchdogRegistry,
    ) {
        match message {
            Message::AgentRegister {
                agent_id,
                agent_name,
                os,
                arch,
                hostname,
                username,
                cwd,
                token,
            } => {
                // Reject impostors before name takeover: an unauthenticated client
                // that only knows an agent name must not replace a live connection.
                if !constant_time_eq(&token, &self.agent_token) {
                    log!(
                        Level::Warning,
                        "Rejecting agent registration with invalid token: agent_name={}, socket_id={}",
                        agent_name,
                        self.socket_id
                    );
                    let _ = self.outgoing_text.send(WsMessage::Text(
                        serde_json::to_string(&Message::Error {
                            message: "Invalid agent token".to_string(),
                        })
                        .unwrap_or_else(|_| {
                            r#"{"type":"error","message":"Invalid agent token"}"#.to_string()
                        })
                        .into(),
                    ));
                    return;
                }

                // Look up the supervisor for this agent name BEFORE
                // moving `agent_name` into the registration payload so
                // the registry still has access to it. A `None` result
                // is fine: it just means the agent is not supervised by
                // the watchdog (e.g. an external agent spawned outside
                // the server) and the stale check will be a no-op.
                self.watchdog = watchdog_registry.lookup(&agent_name);
                if let Some(watchdog) = self.watchdog.as_ref() {
                    if !watchdog.mark_connected(self.socket_id.clone()) {
                        log!(
                            Level::Warning,
                            "Rejecting managed agent registration while stopped: agent_name={}",
                            agent_name
                        );
                        let _ = self.outgoing_text.send(WsMessage::Text(
                            serde_json::to_string(&Message::Error {
                                message: "Managed agent is intentionally stopped".to_string(),
                            })
                            .unwrap_or_else(|_| {
                                r#"{"type":"error","message":"Managed agent is intentionally stopped"}"#.to_string()
                            })
                            .into(),
                        ));
                        self.watchdog = None;
                        return;
                    }
                    log!(
                        Level::Debug,
                        "Session linked to watchdog supervisor: agent_name={}",
                        agent_name
                    );
                }

                let _ = self
                    .router_ref
                    .send(RouterMsg::RegisterAgent(RegisterAgentRequest {
                        agent_id: agent_id.clone(),
                        agent_name,
                        socket_id: self.socket_id.clone(),
                        outgoing_text: self.outgoing_text.clone(),
                        os,
                        arch,
                        hostname,
                        username,
                        default_directory: cwd,
                        watchdog: self.watchdog.clone(),
                    }));
                self.agent_id = Some(agent_id);
            }
            Message::AgentUnregister { agent_id } => {
                if let Some(watchdog) = self.watchdog.as_ref() {
                    watchdog.mark_disconnected(self.socket_id.clone());
                }
                let _ = self.router_ref.send(RouterMsg::UnregisterAgent {
                    agent_id,
                    socket_id: self.socket_id.clone(),
                });
            }
            Message::TransferReady {
                agent_id,
                request_id,
            } => {
                // TransferReady is a one-shot gate for uploads/copies. try_send would
                // permanently drop readiness when the router mailbox is full, leaving
                // the transfer stuck until client timeout with no cleanup path.
                if let Err(error) = self
                    .router_ref
                    .send_async(RouterMsg::RouteTransferReady(RouteTransferReadyRequest {
                        agent_id: agent_id.clone(),
                        request_id,
                    }))
                    .await
                {
                    log!(
                        Level::Error,
                        "Failed to queue transfer readiness: agent_id={}, request_id={}, error={}",
                        agent_id,
                        request_id,
                        error
                    );
                }
            }
            Message::CommandResponse {
                agent_id,
                request_id,
                result,
            } => {
                let _ = self
                    .router_ref
                    .send(RouterMsg::RouteResponse(RouteResponse {
                        agent_id,
                        request_id,
                        result,
                    }));
            }
            Message::TransferProgressUpdate {
                agent_id,
                request_id,
                transferred_bytes,
                total_bytes,
            } => {
                let _ = self.router_ref.send(RouterMsg::TransferProgressUpdate(
                    TransferProgressUpdateRequest {
                        agent_id,
                        request_id,
                        transferred_bytes,
                        total_bytes,
                    },
                ));
            }
            _ => {}
        }
    }

    /// Unregisters the session's agent after the websocket goes away.
    fn shutdown(self) {
        if let Some(watchdog) = self.watchdog.as_ref() {
            watchdog.mark_disconnected(self.socket_id.clone());
        }
        if let Some(agent_id) = self.agent_id {
            let _ = self.router_ref.send(RouterMsg::UnregisterAgent {
                agent_id,
                socket_id: self.socket_id.clone(),
            });
        }

        log!(Level::Info, "Session stopped: socket_id={}", self.socket_id);
    }

    /// Dispatches one inbound websocket frame to the appropriate handler.
    /// Returns `false` when the session should stop (e.g. router rejected
    /// a binary chunk), so the caller can break out of its read loop.
    async fn handle_ws_message(
        &mut self,
        message: WsMessage,
        watchdog_registry: &WatchdogRegistry,
    ) -> bool {
        match message {
            WsMessage::Text(text) => match serde_json::from_str::<Message>(&text) {
                Ok(message) => {
                    self.handle_control_message(message, watchdog_registry)
                        .await
                }
                Err(error) => {
                    log!(
                        Level::Error,
                        "Failed to deserialize WebSocket message: {}, raw text: {}",
                        error,
                        text
                    );
                }
            },
            WsMessage::Binary(_) => {
                log!(
                    Level::Warning,
                    "Binary frame on control socket: socket_id={}",
                    self.socket_id
                );
                return false;
            }
            _ => {}
        }
        true
    }
}

/// Entry point for a new WebSocket connection. Splits the socket into send/receive
/// halves and wires them to the router using explicit Tokio channels.
pub async fn handle_websocket(
    socket: WebSocket,
    socket_id: SocketId,
    router_ref: RouterHandle,
    watchdog_registry: WatchdogRegistry,
    agent_token: String,
) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    // Text frames carry control-plane messages, so they stay unbounded to avoid
    // stalling router notifications behind a concurrent large transfer.
    let (tx_out_text, mut rx_out_text) = mpsc::unbounded_channel::<WsMessage>();

    let mut runtime = SessionRuntime {
        socket_id: socket_id.clone(),
        router_ref,
        agent_id: None,
        outgoing_text: tx_out_text,
        watchdog: None,
        agent_token,
    };

    log!(Level::Info, "Session started: socket_id={}", socket_id);

    // The writer task signals through this channel when it ends, so the reader
    // loop can stop promptly instead of waiting for the read side to notice the
    // broken connection.
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<()>();

    let writer_task = tokio::spawn(async move {
        let mut text_closed = false;
        let mut ping_interval = tokio::time::interval(WEBSOCKET_PING_INTERVAL);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Consume the first immediate tick so the first ping fires one interval
        // from now rather than immediately at session start.
        ping_interval.tick().await;

        loop {
            // `biased` keeps control-plane text messages responsive while binary streaming is active.
            let next_message = tokio::select! {
                biased;
                _ = ping_interval.tick() => {
                    // A ping forces a write; if the connection is dead the send
                    // fails and the session can tear down instead of lingering.
                    if sender.send(WsMessage::Ping(bytes::Bytes::new())).await.is_err() {
                        break;
                    }
                    continue;
                }
                message = rx_out_text.recv(), if !text_closed => take_outbound_message(message, &mut text_closed),
                // The control lane is closed, so no future application frames can be produced.
                else => break,
            };

            let Some(message) = next_message else {
                continue;
            };

            if sender.send(message).await.is_err() {
                // A send failure means the websocket is gone, so continuing to pull
                // router output would only accumulate work for a dead session.
                break;
            }
        }

        let _ = writer_done_tx.send(());
    });

    // Track the last time we received any frame on the WebSocket. Any
    // inbound frame (Text, Binary, Ping, Pong, Close) resets the timer.
    // If no frame arrives for WEBSOCKET_STALE_TIMEOUT we assume the
    // connection is half-open (e.g. SSH tunnel died without a TCP
    // close) and ask the watchdog supervisor to restart the subprocess.
    let mut last_seen = Instant::now();
    let mut stale_check = tokio::time::interval(WEBSOCKET_STALE_CHECK_INTERVAL);
    stale_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Burn the first immediate tick so the first stale check fires one
    // interval from now rather than immediately at session start.
    stale_check.tick().await;

    loop {
        tokio::select! {
            biased;
            _ = &mut writer_done_rx => break,
            _ = stale_check.tick() => {
                if last_seen.elapsed() > WEBSOCKET_STALE_TIMEOUT
                    && let Some(watchdog) = runtime.watchdog.as_ref()
                {
                    log!(
                        Level::Warning,
                        "WebSocket stale for {:?}, requesting restart: agent_name={}, socket_id={}",
                        last_seen.elapsed(),
                        watchdog.key(),
                        socket_id
                    );
                    watchdog.signal_stale();
                    // Break out of the read loop; `runtime.shutdown()`
                    // below closes the lanes and the writer task exits,
                    // and the supervisor is already killing the subprocess.
                    break;
                }
            }
            result = receiver.next() => match result {
                Some(Ok(message)) => {
                    // Any inbound frame (including Pong) resets the
                    // stale timer. The dispatch below happens before
                    // we drop the frame so the runtime can act on it.
                    last_seen = Instant::now();
                    if !runtime.handle_ws_message(message, &watchdog_registry).await {
                        break;
                    }
                }
                _ => break,
            },
        }
    }

    runtime.shutdown();
    writer_task.abort();
}
