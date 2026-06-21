use crate::actors::router::{
    RegisterAgentRequest, RouteResponse, RouteStreamChunkRequest, RouterHandle, RouterMsg,
    TransferProgressUpdateRequest,
};
use crate::log;
use crate::logging::Level;
use crate::types::{AgentId, Message, SocketId};
use crate::watchdog::{WatchdogHandle, WatchdogRegistry};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};

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
    /// Sends binary frames on a bounded lane so large stream transfers apply
    /// backpressure instead of growing memory usage without bound.
    outgoing_binary: mpsc::Sender<WsMessage>,
    /// Populated after `AgentRegister` if the registered agent name has a
    /// matching watchdog supervisor. The stale check uses this to signal
    /// the supervisor when the WebSocket goes silent. Stays `None` for
    /// agents that aren't supervised (e.g. manually-spawned external
    /// agents), in which case the stale check is a no-op.
    watchdog: Option<WatchdogHandle>,
}

impl SessionRuntime {
    /// Registers the agent with the router once the websocket announces itself.
    fn handle_control_message(&mut self, message: Message, watchdog_registry: &WatchdogRegistry) {
        match message {
            Message::AgentRegister {
                agent_id,
                agent_name,
                os,
                arch,
                hostname,
                username,
            } => {
                // Look up the supervisor for this agent name BEFORE
                // moving `agent_name` into the registration payload so
                // the registry still has access to it. A `None` result
                // is fine: it just means the agent is not supervised by
                // the watchdog (e.g. an external agent spawned outside
                // the server) and the stale check will be a no-op.
                self.watchdog = watchdog_registry.lookup(&agent_name);
                if self.watchdog.is_some() {
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
                        outgoing_binary: self.outgoing_binary.clone(),
                        os,
                        arch,
                        hostname,
                        username,
                    }));
                self.agent_id = Some(agent_id);
            }
            Message::AgentUnregister { agent_id } => {
                let _ = self.router_ref.send(RouterMsg::UnregisterAgent {
                    agent_id,
                    socket_id: self.socket_id.clone(),
                });
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

    /// Forwards one parsed binary stream chunk and waits until the router has finished routing it.
    async fn handle_binary_message(&mut self, bytes: Vec<u8>) -> bool {
        let Ok(chunk) = crate::streaming::StreamChunk::from_bytes(&bytes) else {
            return true;
        };

        let Some(agent_id) = self.agent_id.clone() else {
            return true;
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .router_ref
            .send_async(RouterMsg::RouteStreamChunk(RouteStreamChunkRequest {
                agent_id,
                chunk,
                reply: reply_tx,
            }))
            .await
            .is_err()
        {
            return false;
        }

        reply_rx.await.is_ok()
    }

    /// Unregisters the session's agent after the websocket goes away.
    fn shutdown(self) {
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
                Ok(message) => self.handle_control_message(message, watchdog_registry),
                Err(error) => {
                    log!(
                        Level::Error,
                        "Failed to deserialize WebSocket message: {}, raw text: {}",
                        error,
                        text
                    );
                }
            },
            WsMessage::Binary(bytes) => {
                if !self.handle_binary_message(bytes.to_vec()).await {
                    return false;
                }
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
) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    // Text frames carry control-plane messages, so they stay unbounded to avoid
    // stalling router notifications behind a concurrent large transfer.
    let (tx_out_text, mut rx_out_text) = mpsc::unbounded_channel::<WsMessage>();
    // Binary frames can be large and continuous, so this lane stays bounded to
    // propagate backpressure instead of buffering an unbounded stream in memory.
    let (tx_out_binary, mut rx_out_binary) = mpsc::channel::<WsMessage>(1);

    let mut runtime = SessionRuntime {
        socket_id: socket_id.clone(),
        router_ref,
        agent_id: None,
        outgoing_text: tx_out_text,
        outgoing_binary: tx_out_binary,
        watchdog: None,
    };

    log!(Level::Info, "Session started: socket_id={}", socket_id);

    // The writer task signals through this channel when it ends, so the reader
    // loop can stop promptly instead of waiting for the read side to notice the
    // broken connection.
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<()>();

    let writer_task = tokio::spawn(async move {
        let mut text_closed = false;
        let mut binary_closed = false;
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
                message = rx_out_binary.recv(), if !binary_closed => take_outbound_message(message, &mut binary_closed),
                // Both outbound lanes are closed, so no future websocket frames can
                // be produced and the writer task can stop cleanly.
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
