use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    log_error,
    log_protocol::LogEvent,
    logging::{self, LogEntry},
    websocket::keepalive_interval,
};
use tokio::sync::broadcast;

/// Keeps outbound helpers concise while retaining Axum's concrete socket sink type.
type SocketSender = futures_util::stream::SplitSink<WebSocket, WsMessage>;
/// Keeps disconnect handling independent from the live-entry forwarding loop.
type SocketReceiver = futures_util::stream::SplitStream<WebSocket>;

/// Upgrades the authenticated route-scoped connection used only by the server-log page.
pub(crate) async fn server_logs_websocket_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_server_logs_socket)
}

/// Sends one typed event and returns whether forwarding can safely continue.
async fn send_event(sender: &mut SocketSender, event: &LogEvent) -> bool {
    let json = match serde_json::to_string(event) {
        Ok(json) => json,
        Err(error) => {
            eprintln!("Failed to serialize server log websocket event: {error}");
            return false;
        }
    };

    sender.send(WsMessage::Text(json.into())).await.is_ok()
}

/// Relays bounded broadcast entries until the logger closes or this browser falls behind.
async fn forward_live_entries(
    sender: &mut SocketSender,
    live_entries: &mut broadcast::Receiver<LogEntry>,
) {
    let mut keepalive = keepalive_interval();
    loop {
        let entry = tokio::select! {
            _ = keepalive.tick() => {
                if sender.send(WsMessage::Ping(bytes::Bytes::new())).await.is_err() {
                    return;
                }
                continue;
            }
            entry = live_entries.recv() => entry,
        };
        match entry {
            Ok(entry) => {
                if !send_event(sender, &LogEvent::Entry { entry }).await {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let _ = send_event(sender, &LogEvent::Lagged { skipped }).await;
                return;
            }
        }
    }
}

/// Detects browser teardown so dropping the other select branch releases its broadcast receiver.
async fn wait_for_disconnect(receiver: &mut SocketReceiver) {
    while let Some(message_result) = receiver.next().await {
        match message_result {
            Ok(WsMessage::Close(_)) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// Builds the snapshot before forwarding live records so protocol ordering remains deterministic.
async fn handle_server_logs_socket(socket: WebSocket) {
    let subscription = match logging::subscribe().await {
        Ok(subscription) => subscription,
        Err(error) => {
            log_error!(
                anyhow::Error::new(error),
                "Failed to subscribe server log websocket"
            );
            return;
        }
    };

    let file_logging_enabled = subscription.file_logging_enabled;
    let (mut sender, mut receiver) = socket.split();
    let snapshot = LogEvent::bounded_snapshot(subscription.entries, file_logging_enabled);
    let snapshot_sent = tokio::select! {
        sent = send_event(&mut sender, &snapshot) => sent,
        _ = wait_for_disconnect(&mut receiver) => return,
    };
    if !snapshot_sent {
        return;
    }

    let mut live_entries = subscription.receiver;
    tokio::select! {
        _ = forward_live_entries(&mut sender, &mut live_entries) => {}
        _ = wait_for_disconnect(&mut receiver) => {}
    }
}
