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

/// Per-agent command backlog allowed before REST admission fails fast.
pub(crate) const CONTROL_COMMAND_QUEUE_CAPACITY: usize = 64;
/// Lifecycle and cancellation traffic has independent capacity from ordinary commands.
const CONTROL_PRIORITY_QUEUE_CAPACITY: usize = 16;

/// Constant-time string equality so invalid tokens do not leak length via timing.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_digest = Sha256::digest(left.as_bytes());
    let right_digest = Sha256::digest(right.as_bytes());
    bool::from(left_digest.ct_eq(&right_digest))
}

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
    /// Admits ordinary commands into a bounded per-agent backlog.
    outgoing_commands: mpsc::Sender<WsMessage>,
    /// Reserves socket output capacity for cancellation and lifecycle traffic.
    outgoing_priority: mpsc::Sender<WsMessage>,

    /// Populated after `AgentRegister` if the registered agent name has a
    /// matching watchdog supervisor. The stale check uses this to signal
    /// the supervisor when the WebSocket goes silent. Stays `None` for
    /// agents that aren't supervised (e.g. manually-spawned external
    /// agents), whose stale sockets are closed without restarting a process.
    watchdog: Option<WatchdogHandle>,
    /// Expected top-level `agent_token`; registration without this secret is rejected.
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
                binary,
                supports_self_exec,
                supports_native_open,
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
                    let _ = self.outgoing_priority.try_send(WsMessage::Text(
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
                // the server) and stale cleanup has no process to restart.
                self.watchdog = watchdog_registry.lookup(&agent_name);
                if let Some(watchdog) = self.watchdog.as_ref() {
                    if !watchdog.mark_connected(self.socket_id.clone()) {
                        log!(
                            Level::Warning,
                            "Rejecting managed agent registration while stopped: agent_name={}",
                            agent_name
                        );
                        let _ = self.outgoing_priority.try_send(WsMessage::Text(
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
                        outgoing_commands: self.outgoing_commands.clone(),
                        outgoing_priority: self.outgoing_priority.clone(),
                        os,
                        arch,
                        hostname,
                        username,
                        default_directory: cwd,
                        binary,
                        supports_self_exec,
                        supports_native_open,
                        watchdog: self.watchdog.clone(),
                    }));
                self.agent_id = Some(agent_id);
            }
            Message::AgentUnregister { agent_id } => {
                if let Some(watchdog) = self.watchdog.as_ref() {
                    watchdog.mark_disconnected(self.socket_id.clone());
                }
                if let Err(error) = self
                    .router_ref
                    .send_async(RouterMsg::UnregisterAgent {
                        agent_id: agent_id.clone(),
                        socket_id: self.socket_id.clone(),
                    })
                    .await
                {
                    log!(
                        Level::Error,
                        "Failed to queue explicit agent cleanup: agent_id={}, socket_id={}, error={}",
                        agent_id,
                        self.socket_id,
                        error
                    );
                }
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
            log!(
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
    let (tx_out_commands, mut rx_out_commands) =
        mpsc::channel::<WsMessage>(CONTROL_COMMAND_QUEUE_CAPACITY);
    let (tx_out_priority, mut rx_out_priority) =
        mpsc::channel::<WsMessage>(CONTROL_PRIORITY_QUEUE_CAPACITY);

    let mut runtime = SessionRuntime {
        socket_id: socket_id.clone(),
        router_ref,
        agent_id: None,
        outgoing_commands: tx_out_commands,
        outgoing_priority: tx_out_priority,
        watchdog: None,
        agent_token,
    };

    log!(Level::Info, "Session started: socket_id={}", socket_id);

    // The writer task signals through this channel when it ends, so the reader
    // loop can stop promptly instead of waiting for the read side to notice the
    // broken connection.
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<()>();
    let timeouts = crate::websocket::timeouts();

    let writer_task = tokio::spawn(async move {
        let mut commands_closed = false;
        let mut priority_closed = false;
        let mut ping_interval = crate::websocket::keepalive_interval();

        loop {
            // `biased` keeps control-plane text messages responsive while binary streaming is active.
            let next_message = tokio::select! {
                biased;
                _ = ping_interval.tick() => {
                    // A ping forces a write; if the connection is dead the send
                    // fails and the session can tear down instead of lingering.
                    if !matches!(
                        tokio::time::timeout(
                            timeouts.stale_timeout,
                            sender.send(WsMessage::Ping(bytes::Bytes::new())),
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                    continue;
                }
                message = rx_out_priority.recv(), if !priority_closed => take_outbound_message(message, &mut priority_closed),
                message = rx_out_commands.recv(), if !commands_closed => take_outbound_message(message, &mut commands_closed),
                // Both bounded lanes are closed, so no future application frames can be produced.
                else => break,
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

    // Track the last time we received any frame on the WebSocket. Any
    // inbound frame (Text, Binary, Ping, Pong, Close) resets the timer.
    // If no frame arrives for the configured stale timeout we assume the
    // connection is half-open (e.g. SSH tunnel died without a TCP
    // close). Managed sessions also ask their watchdog to restart the subprocess.
    let mut last_seen = Instant::now();
    let mut stale_check = tokio::time::interval(timeouts.stale_check_interval);
    stale_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Burn the first immediate tick so the first stale check fires one
    // interval from now rather than immediately at session start.
    stale_check.tick().await;

    loop {
        tokio::select! {
            biased;
            _ = &mut writer_done_rx => break,
            _ = stale_check.tick() => {
                if last_seen.elapsed() > timeouts.stale_timeout {
                    if let Some(watchdog) = runtime.watchdog.as_ref() {
                        log!(
                            Level::Warning,
                            "WebSocket stale for {:?}, requesting restart: agent_name={}, socket_id={}",
                            last_seen.elapsed(),
                            watchdog.key(),
                            socket_id
                        );
                        watchdog.signal_stale();
                    } else {
                        log!(
                            Level::Warning,
                            "Unmanaged WebSocket stale for {:?}, closing session: socket_id={}",
                            last_seen.elapsed(),
                            socket_id
                        );
                    }
                    // Break out of the read loop; `runtime.shutdown()`
                    // below unregisters the agent and closes the writer lane.
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

    runtime.shutdown().await;
    writer_task.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_waits_for_router_capacity_before_unregistering_agent() {
        let (sender, mut receiver) = mpsc::channel(1);
        let router_ref = RouterHandle::new(sender);
        router_ref
            .send(RouterMsg::CheckPendingUiRefresh)
            .expect("router mailbox filled");
        let socket_id = SocketId::new();
        let (outgoing_commands, _outgoing_commands_receiver) = mpsc::channel(1);
        let (outgoing_priority, _outgoing_priority_receiver) = mpsc::channel(1);
        let runtime = SessionRuntime {
            socket_id: socket_id.clone(),
            router_ref,
            agent_id: Some(AgentId::from("agent")),
            outgoing_commands,
            outgoing_priority,
            watchdog: None,
            agent_token: "token".to_string(),
        };

        let shutdown_task = tokio::spawn(runtime.shutdown());
        tokio::task::yield_now().await;

        // A full mailbox must backpressure teardown instead of completing after dropping cleanup.
        assert!(!shutdown_task.is_finished());
        assert!(matches!(
            receiver.recv().await,
            Some(RouterMsg::CheckPendingUiRefresh)
        ));
        let cleanup = receiver.recv().await;
        // Releasing one slot must deliver the exact session cleanup that was waiting for capacity.
        assert!(matches!(
            cleanup,
            Some(RouterMsg::UnregisterAgent {
                agent_id,
                socket_id: received_socket_id,
            }) if agent_id == AgentId::from("agent") && received_socket_id == socket_id
        ));
        shutdown_task.await.expect("session shutdown task joined");
    }
}
