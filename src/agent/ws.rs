use super::{AgentHandle, AgentMsg};
use futures_util::{Sink, SinkExt, StreamExt};
use redoor::{Level, log, types::Message};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, tungstenite::protocol::Message as WsMessage,
};

/// Spawns control ingress and an independent liveness monitor for one socket generation.
pub(super) async fn spawn_read_task(
    mut read: futures_util::stream::SplitStream<
        WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    agent_ref: AgentHandle,
    connection_generation: u64,
    control_tx: mpsc::Sender<WsMessage>,
    shutdown_sender: watch::Sender<bool>,
    mut shutdown: watch::Receiver<bool>,
) {
    let (activity_sender, activity_receiver) = watch::channel(Instant::now());
    let monitor_handle = agent_ref.clone();
    let monitor_shutdown = shutdown.clone();
    let reader_shutdown_sender = shutdown_sender.clone();
    tokio::spawn(monitor_connection_liveness(
        activity_receiver,
        control_tx,
        shutdown_sender,
        monitor_shutdown,
        monitor_handle,
        connection_generation,
        redoor::websocket::timeouts(),
    ));

    tokio::spawn(async move {
        let mut connection_loss_reported = false;
        loop {
            let msg = tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                    continue;
                }
                msg = read.next() => msg,
            };

            let Some(msg) = msg else {
                break;
            };
            activity_sender.send_replace(Instant::now());
            match msg {
                Ok(WsMessage::Text(text)) => {
                    let delivered = tokio::select! {
                        biased;
                        changed = shutdown.changed() => {
                            connection_loss_reported = true;
                            changed.is_ok() && !*shutdown.borrow()
                        }
                        result = agent_ref.send(AgentMsg::WebSocketMessage {
                            connection_generation,
                            text: text.to_string(),
                        }) => result.is_ok(),
                    };
                    if !delivered {
                        break;
                    }
                }
                Ok(WsMessage::Binary(_)) => {
                    connection_loss_reported = true;
                    report_connection_loss(
                        &reader_shutdown_sender,
                        &agent_ref,
                        connection_generation,
                        "Binary frame received on control socket".to_string(),
                    );
                    break;
                }
                Ok(WsMessage::Close(_)) => {
                    connection_loss_reported = true;
                    report_connection_loss(
                        &reader_shutdown_sender,
                        &agent_ref,
                        connection_generation,
                        "Server closed connection".to_string(),
                    );
                    break;
                }
                Err(error) => {
                    connection_loss_reported = true;
                    report_connection_loss(
                        &reader_shutdown_sender,
                        &agent_ref,
                        connection_generation,
                        format!("Error receiving message: {error}"),
                    );
                    break;
                }
                _ => {}
            }
        }
        if !connection_loss_reported {
            report_connection_loss(
                &reader_shutdown_sender,
                &agent_ref,
                connection_generation,
                "Server connection ended".to_string(),
            );
        }
    });
}

/// Checks silence independently of bounded inbound delivery and tears down stale transports first.
async fn monitor_connection_liveness(
    activity: watch::Receiver<Instant>,
    control_tx: mpsc::Sender<WsMessage>,
    shutdown_sender: watch::Sender<bool>,
    mut shutdown: watch::Receiver<bool>,
    agent_ref: AgentHandle,
    connection_generation: u64,
    timeouts: redoor::websocket::WebSocketTimeouts,
) {
    let mut keepalive = tokio::time::interval(timeouts.keepalive);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.reset();
    let mut stale_check = tokio::time::interval(timeouts.stale_check_interval);
    stale_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    stale_check.tick().await;

    loop {
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = stale_check.tick() => {
                let elapsed = activity.borrow().elapsed();
                if elapsed > timeouts.stale_timeout {
                    report_connection_loss(
                        &shutdown_sender,
                        &agent_ref,
                        connection_generation,
                        format!("Server connection stale for {elapsed:?}"),
                    );
                    break;
                }
            }
            _ = keepalive.tick() => {
                match control_tx.try_send(WsMessage::Ping(bytes::Bytes::new())) {
                    Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => break,
                }
            }
        }
    }
}

/// Stops both socket halves before publishing loss so actor backpressure cannot retain the transport.
fn report_connection_loss(
    shutdown_sender: &watch::Sender<bool>,
    agent_ref: &AgentHandle,
    connection_generation: u64,
    reason: String,
) {
    let _ = shutdown_sender.send(true);
    agent_ref.report_connection_lost(connection_generation, reason);
}

/// Spawns the control writer and reports write failures through the non-blocking lifecycle lane.
pub(super) fn spawn_write_task<W>(
    write: W,
    control_rx: mpsc::Receiver<WsMessage>,
    shutdown_sender: watch::Sender<bool>,
    shutdown: watch::Receiver<bool>,
    agent_ref: AgentHandle,
    connection_generation: u64,
) where
    W: Sink<WsMessage> + Unpin + Send + 'static,
    W::Error: Send,
{
    tokio::spawn(async move {
        if write_control_frames(write, control_rx, shutdown)
            .await
            .is_err()
        {
            log!(Level::Warning, "Failed to send WebSocket message");
            report_connection_loss(
                &shutdown_sender,
                &agent_ref,
                connection_generation,
                "Failed to write to server connection".to_string(),
            );
        }
    });
}

/// Writes queued control frames while allowing shutdown to cancel an in-progress socket write.
async fn write_control_frames<W>(
    mut write: W,
    mut control_rx: mpsc::Receiver<WsMessage>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), ()>
where
    W: Sink<WsMessage> + Unpin,
{
    loop {
        let message = tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
                continue;
            }
            message = control_rx.recv() => match message {
                Some(message) => message,
                None => return Ok(()),
            },
        };
        let reexec_path = reexec_path(&message);
        let send_result = tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
                continue;
            }
            result = write.send(message) => result,
        };
        if send_result.is_err() {
            return Err(());
        }
        if let Some(path) = reexec_path {
            // The response is on the socket before exec interrupts this connection.
            match path {
                Some(path) => redoor::process::reexec_process(std::path::Path::new(&path)),
                None => redoor::process::reexec_current_process(),
            }
        }
    }
}

/// Extracts process replacement only after identifying a successfully written command response.
fn reexec_path(message: &WsMessage) -> Option<Option<String>> {
    let WsMessage::Text(text) = message else {
        return None;
    };
    serde_json::from_str::<Message>(text)
        .ok()
        .and_then(|message| match message {
            Message::CommandResponse {
                result: redoor::commands::CommandResult::Restart,
                ..
            } => Some(None),
            Message::CommandResponse {
                result: redoor::commands::CommandResult::SelfExec { path },
                ..
            } => Some(Some(path)),
            _ => None,
        })
}

/// Spawns stdin forwarding and optionally treats EOF as loss of the owning SSH relay.
pub(super) async fn spawn_stdin_task(agent_ref: AgentHandle, exit_on_eof: bool) {
    tokio::spawn(forward_stdin(
        BufReader::new(tokio::io::stdin()),
        agent_ref,
        exit_on_eof,
    ));
}

/// Forwards complete input lines while keeping relay-only EOF shutdown independently testable.
async fn forward_stdin<R>(mut input: R, agent_ref: AgentHandle, exit_on_eof: bool)
where
    R: AsyncBufRead + Unpin,
{
    let mut line = String::new();
    loop {
        match input.read_line(&mut line).await {
            Ok(0) => {
                if exit_on_eof {
                    let _ = agent_ref.send(AgentMsg::Shutdown).await;
                }
                break;
            }
            Ok(_) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let _ = agent_ref
                        .send(AgentMsg::SendWebSocketMessage {
                            msg: WsMessage::text(trimmed.to_string()),
                        })
                        .await;
                }
                line.clear();
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    use futures_util::Sink;
    use tokio::sync::mpsc;

    use super::*;

    /// Creates a handle whose two lanes can be inspected independently.
    fn test_handle(
        sender: mpsc::Sender<AgentMsg>,
    ) -> (
        AgentHandle,
        mpsc::UnboundedReceiver<super::super::AgentLifecycleMsg>,
    ) {
        let (lifecycle_sender, lifecycle_receiver) = mpsc::unbounded_channel();
        (
            AgentHandle {
                sender,
                lifecycle_sender,
            },
            lifecycle_receiver,
        )
    }

    /// Sink that models a socket whose transport never accepts another frame.
    struct BlockedSink;

    impl Sink<WsMessage> for BlockedSink {
        type Error = ();

        /// Keeps the write future pending until generation shutdown cancels it.
        fn poll_ready(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Pending
        }

        /// Cannot be reached because this sink never becomes ready.
        fn start_send(self: Pin<&mut Self>, _item: WsMessage) -> Result<(), ()> {
            unreachable!("blocked sink cannot accept a frame")
        }

        /// Keeps flushing pending for the same reason as readiness.
        fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Pending
        }

        /// Closing is irrelevant because cancellation drops the blocked socket generation.
        fn poll_close(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Verifies only SSH-owned agents stop when their input channel disappears.
    #[tokio::test]
    async fn relay_stdin_eof_requests_clean_shutdown() {
        let (sender, mut receiver) = mpsc::channel(1);
        let (handle, _lifecycle_receiver) = test_handle(sender);

        forward_stdin(BufReader::new(&b""[..]), handle, true).await;

        // EOF from a disconnected SSH channel must release the remote agent PID lock.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Shutdown)));
    }

    /// Verifies ordinary agents retain the existing behavior when terminal stdin closes.
    #[tokio::test]
    async fn regular_stdin_eof_does_not_stop_agent() {
        let (sender, mut receiver) = mpsc::channel(1);
        let (handle, _lifecycle_receiver) = test_handle(sender);

        forward_stdin(BufReader::new(&b""[..]), handle, false).await;

        // A service or detached regular agent commonly has closed stdin and must keep running.
        assert!(receiver.try_recv().is_err());
    }

    /// Verifies stale detection bypasses a full ordinary actor mailbox.
    #[tokio::test]
    async fn liveness_reports_loss_while_inbound_delivery_is_backpressured() {
        let (sender, _receiver) = mpsc::channel(1);
        let (handle, mut lifecycle_receiver) = test_handle(sender);
        handle
            .try_send(AgentMsg::ExitWithError)
            .expect("mailbox saturation setup should fill its only slot");
        let stale_since = Instant::now()
            .checked_sub(tokio::time::Duration::from_secs(1))
            .expect("one second should fit in Tokio's monotonic clock");
        let (_activity_sender, activity_receiver) = watch::channel(stale_since);
        let (control_tx, _control_rx) = mpsc::channel(1);
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let observed_shutdown = shutdown_receiver.clone();
        tokio::spawn(monitor_connection_liveness(
            activity_receiver,
            control_tx,
            shutdown_sender,
            shutdown_receiver,
            handle,
            7,
            redoor::websocket::WebSocketTimeouts {
                keepalive: tokio::time::Duration::from_secs(60),
                stale_timeout: tokio::time::Duration::from_nanos(1),
                stale_check_interval: tokio::time::Duration::from_nanos(1),
            },
        ));

        let lifecycle = lifecycle_receiver
            .recv()
            .await
            .expect("stale monitor should use the independent lifecycle lane");
        // The lifecycle event must retain its generation so delayed teardown cannot affect a replacement.
        assert!(matches!(
            lifecycle,
            super::super::AgentLifecycleMsg::ConnectionLost {
                connection_generation: 7,
                ..
            }
        ));
        // Shutdown must be published before actor cleanup so blocked reader and writer tasks can exit.
        assert!(*observed_shutdown.borrow());
    }

    /// Verifies shutdown cancels a send already blocked inside the socket sink.
    #[tokio::test]
    async fn control_shutdown_interrupts_in_progress_write() {
        let (control_tx, control_rx) = mpsc::channel(1);
        control_tx
            .send(WsMessage::text("blocked"))
            .await
            .expect("writer setup should queue one frame");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let write = write_control_frames(BlockedSink, control_rx, shutdown_receiver);
        tokio::pin!(write);

        // Polling pending proves the writer reached the sink rather than waiting on its queue.
        assert!(futures_util::poll!(&mut write).is_pending());
        shutdown_sender
            .send(true)
            .expect("writer should still observe generation shutdown");

        // Completion proves shutdown canceled the in-progress send without a network timeout.
        assert_eq!(write.await, Ok(()));
    }
}
