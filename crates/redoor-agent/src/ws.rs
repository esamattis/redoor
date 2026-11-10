//! Connection reader, writer, liveness monitor and stdin forwarding.

use crate::commands::ctx::AgentServices;
use crate::runtime::responder::{ControlSender, OutboundFrame, PostSend};
use crate::runtime::{AgentHandle, AgentMsg};
use futures_util::{Sink, SinkExt, StreamExt};
use redoor_core::log;
use redoor_protocol::wire::log::Level;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// The receiving ends of one connection's outbound lanes, drained by its single writer.
pub(super) struct LaneReceivers {
    pub(super) control: mpsc::Receiver<OutboundFrame>,
    pub(super) interactive: mpsc::Receiver<OutboundFrame>,
    pub(super) bulk: mpsc::Receiver<OutboundFrame>,
}

/// Spawns ingress and an independent liveness monitor for one socket generation.
///
/// Text frames go to the runtime; binary stream frames go straight to the worker that owns
/// their stream, so payload never passes through the runtime mailbox.
#[allow(clippy::too_many_arguments)]
pub(super) async fn spawn_read_task(
    mut read: futures_util::stream::SplitStream<crate::connection::AgentSocket>,
    agent_ref: AgentHandle,
    connection_generation: u64,
    control_tx: ControlSender,
    services: AgentServices,
    shutdown_sender: watch::Sender<bool>,
    mut shutdown: watch::Receiver<bool>,
    timeouts: redoor_core::websocket::WebSocketTimeouts,
) {
    let (activity_sender, activity_receiver) = watch::channel(Instant::now());
    let monitor_handle = agent_ref.clone();
    let monitor_shutdown = shutdown.clone();
    let reader_shutdown_sender = shutdown_sender.clone();
    tokio::spawn(monitor_connection_liveness(
        activity_receiver,
        control_tx.clone(),
        shutdown_sender,
        monitor_shutdown,
        monitor_handle,
        connection_generation,
        timeouts,
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
                Ok(WsMessage::Binary(bytes)) => {
                    services.route_stream_frame(bytes, &control_tx).await;
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
    control_tx: ControlSender,
    shutdown_sender: watch::Sender<bool>,
    mut shutdown: watch::Receiver<bool>,
    agent_ref: AgentHandle,
    connection_generation: u64,
    timeouts: redoor_core::websocket::WebSocketTimeouts,
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
                match control_tx.try_send(OutboundFrame::ping()) {
                    Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => break,
                }
            }
        }
    }
}

/// Lets the task initiating shutdown publish its diagnosis exactly once for this generation.
/// Reader cleanup must not race the liveness monitor with a generic end-of-stream reason.
fn report_connection_loss(
    shutdown_sender: &watch::Sender<bool>,
    agent_ref: &AgentHandle,
    connection_generation: u64,
    reason: String,
) {
    let initiated_shutdown = shutdown_sender.send_if_modified(|shutdown| {
        if *shutdown {
            return false;
        }
        *shutdown = true;
        true
    });
    if initiated_shutdown {
        agent_ref.report_connection_lost(connection_generation, reason);
    }
}

/// Spawns the connection writer and reports write failures through the non-blocking lifecycle
/// lane.
pub(super) fn spawn_write_task<W>(
    write: W,
    lanes: LaneReceivers,
    shutdown_sender: watch::Sender<bool>,
    shutdown: watch::Receiver<bool>,
    agent_ref: AgentHandle,
    connection_generation: u64,
) where
    W: Sink<WsMessage> + Unpin + Send + 'static,
    W::Error: Send,
{
    tokio::spawn(async move {
        if write_frames(write, lanes, shutdown, PostSend::run)
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

/// Writes queued frames in class order while allowing shutdown to cancel an in-progress write.
///
/// Control frames always go first, then interactive terminal frames, then bulk data. Since a
/// data frame is at most 64 KiB, a control frame never waits behind more than one of them.
/// A frame's post-send action (process re-exec after a restart response) runs only once the
/// frame was written, so the server always sees the response before the connection drops.
async fn write_frames<W, F>(
    mut write: W,
    mut lanes: LaneReceivers,
    mut shutdown: watch::Receiver<bool>,
    mut after_send: F,
) -> Result<(), ()>
where
    W: Sink<WsMessage> + Unpin,
    F: FnMut(PostSend),
{
    loop {
        let frame = tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
                continue;
            }
            frame = lanes.control.recv() => match frame {
                Some(frame) => frame,
                None => return Ok(()),
            },
            Some(frame) = lanes.interactive.recv() => frame,
            Some(frame) = lanes.bulk.recv() => frame,
        };
        let Some(message) = frame.encode() else {
            continue;
        };
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
        if let Some(action) = frame.after_send {
            after_send(action);
        }
    }
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
                        .send(AgentMsg::SendRawText {
                            text: trimmed.to_string(),
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
    use crate::runtime::AgentLifecycleMsg;
    use redoor_protocol::wire::{AgentToServer, request::CommandOutcome};
    use std::sync::{Arc, Mutex};

    /// Wraps a control lane with idle interactive and bulk lanes.
    fn lanes(control: mpsc::Receiver<OutboundFrame>) -> LaneReceivers {
        LaneReceivers {
            control,
            interactive: mpsc::channel(1).1,
            bulk: mpsc::channel(1).1,
        }
    }

    /// Verifies control frames overtake queued bulk data, so commands stay responsive.
    #[tokio::test]
    async fn control_frames_are_written_before_queued_bulk_data() {
        let journal = Arc::new(Mutex::new(Vec::new()));
        let (control_tx, control) = mpsc::channel(4);
        let (bulk_tx, bulk) = mpsc::channel(4);
        let (interactive_tx, interactive) = mpsc::channel(4);
        bulk_tx
            .send(OutboundFrame::raw_text("bulk".to_string()))
            .await
            .unwrap();
        interactive_tx
            .send(OutboundFrame::raw_text("interactive".to_string()))
            .await
            .unwrap();
        control_tx
            .send(OutboundFrame::raw_text("control".to_string()))
            .await
            .unwrap();
        drop((control_tx, bulk_tx, interactive_tx));
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let result = write_frames(
            JournalSink {
                journal: journal.clone(),
                fail: false,
            },
            LaneReceivers {
                control,
                interactive,
                bulk,
            },
            shutdown_receiver,
            |_| {},
        )
        .await;

        // The writer ends once the control lane closes.
        assert_eq!(result, Ok(()));
        // Class order holds although the bulk frame was queued first.
        assert_eq!(
            journal.lock().unwrap().first().map(String::as_str),
            Some("frame:control")
        );
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
        let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(1);

        forward_stdin(BufReader::new(&b""[..]), handle, true).await;

        // EOF from a disconnected SSH channel must release the remote agent PID lock.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Shutdown)));
    }

    /// Verifies ordinary agents retain the existing behavior when terminal stdin closes.
    #[tokio::test]
    async fn regular_stdin_eof_does_not_stop_agent() {
        let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(1);

        forward_stdin(BufReader::new(&b""[..]), handle, false).await;

        // A service or detached regular agent commonly has closed stdin and must keep running.
        assert!(receiver.try_recv().is_err());
    }

    /// Verifies stale detection bypasses a full ordinary actor mailbox.
    #[tokio::test]
    async fn liveness_reports_loss_while_inbound_delivery_is_backpressured() {
        let (handle, _receiver, mut lifecycle_receiver) = AgentHandle::channel(1);
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
            redoor_core::websocket::WebSocketTimeouts {
                keepalive: tokio::time::Duration::from_secs(60),
                stale_timeout: tokio::time::Duration::from_nanos(1),
                stale_check_interval: tokio::time::Duration::from_nanos(1),
                reconnect_delay: None,
            },
        ));

        let lifecycle = lifecycle_receiver
            .recv()
            .await
            .expect("stale monitor should use the independent lifecycle lane");
        // The lifecycle event must retain its generation so delayed teardown cannot affect a replacement.
        assert!(matches!(
            lifecycle,
            AgentLifecycleMsg::ConnectionLost {
                connection_generation: 7,
                ..
            }
        ));
        // Shutdown must be published before actor cleanup so blocked reader and writer tasks can exit.
        assert!(*observed_shutdown.borrow());
    }

    /// A transport diagnosis must survive reader cleanup observing the same shutdown.
    #[tokio::test]
    async fn first_connection_loss_keeps_its_reason() {
        let (handle, _receiver, mut lifecycle) = AgentHandle::channel(1);
        let (shutdown, _observed_shutdown) = watch::channel(false);

        report_connection_loss(&shutdown, &handle, 7, "Server connection stale".into());
        report_connection_loss(&shutdown, &handle, 7, "Server connection ended".into());

        // Only the initiating task owns the lifecycle event; reader cleanup cannot replace it.
        assert!(matches!(
            lifecycle.recv().await,
            Some(AgentLifecycleMsg::ConnectionLost { reason, .. }) if reason == "Server connection stale"
        ));
        // Duplicate teardown must not enqueue a later competing reason for this generation.
        assert!(lifecycle.try_recv().is_err());
    }

    /// Verifies shutdown cancels a send already blocked inside the socket sink.
    #[tokio::test]
    async fn control_shutdown_interrupts_in_progress_write() {
        let (control_tx, control_rx) = mpsc::channel(1);
        control_tx
            .send(OutboundFrame::raw_text("blocked".to_string()))
            .await
            .expect("writer setup should queue one frame");
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let write = write_frames(BlockedSink, lanes(control_rx), shutdown_receiver, |_| {});
        tokio::pin!(write);

        // Polling pending proves the writer reached the sink rather than waiting on its queue.
        assert!(futures_util::poll!(&mut write).is_pending());
        shutdown_sender
            .send(true)
            .expect("writer should still observe generation shutdown");

        // Completion proves shutdown canceled the in-progress send without a network timeout.
        assert_eq!(write.await, Ok(()));
    }

    /// Sink that records written frames into a shared journal, optionally failing every write.
    struct JournalSink {
        journal: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    impl Sink<WsMessage> for JournalSink {
        type Error = ();

        /// Always ready so the test controls ordering only through the journal.
        fn poll_ready(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }

        /// Records the frame or simulates a broken socket.
        fn start_send(self: Pin<&mut Self>, item: WsMessage) -> Result<(), ()> {
            if self.fail {
                return Err(());
            }
            self.journal
                .lock()
                .unwrap()
                .push(format!("frame:{}", item.to_text().unwrap_or("")));
            Ok(())
        }

        /// Nothing is buffered.
        fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }

        /// Nothing to close.
        fn poll_close(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Queues one restart response and runs the writer to completion over `sink`.
    async fn write_restart_response(sink: JournalSink) -> Result<(), ()> {
        let journal = sink.journal.clone();
        let (control_tx, control_rx) = mpsc::channel(1);
        let frame = OutboundFrame {
            after_send: Some(PostSend::Reexec { path: None }),
            ..OutboundFrame::message(AgentToServer::Result {
                id: redoor_protocol::ids::RequestId::new(1),
                outcome: CommandOutcome::Ok(serde_json::Value::Null),
            })
        };
        control_tx.send(frame).await.unwrap();
        drop(control_tx);
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);
        write_frames(sink, lanes(control_rx), shutdown_receiver, move |action| {
            journal.lock().unwrap().push(format!("{action:?}"));
        })
        .await
    }

    /// Verifies re-exec runs only after the restart response reached the socket.
    #[tokio::test]
    async fn post_send_action_runs_after_the_frame_is_written() {
        let journal = Arc::new(Mutex::new(Vec::new()));

        let result = write_restart_response(JournalSink {
            journal: journal.clone(),
            fail: false,
        })
        .await;

        // The writer finishes cleanly once the lane closes.
        assert_eq!(result, Ok(()));
        let journal = journal.lock().unwrap();
        // The response must be on the wire before the process is replaced.
        assert_eq!(journal.len(), 2);
        assert!(journal[0].starts_with("frame:") && journal[0].contains(r#""type":"result""#));
        assert_eq!(journal[1], "Reexec { path: None }");
    }

    /// Verifies a failed write never triggers the post-send action.
    #[tokio::test]
    async fn failed_write_skips_the_post_send_action() {
        let journal = Arc::new(Mutex::new(Vec::new()));

        let result = write_restart_response(JournalSink {
            journal: journal.clone(),
            fail: true,
        })
        .await;

        // The failure is reported so the connection is torn down.
        assert_eq!(result, Err(()));
        // Re-executing after an undelivered response would leave the router without an answer.
        assert!(journal.lock().unwrap().is_empty());
    }
}
