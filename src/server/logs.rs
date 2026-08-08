use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    Level, log,
    log_protocol::LogEvent,
    logging::{self, LogSubscription},
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
    live_entries: &mut broadcast::Receiver<String>,
) {
    loop {
        match live_entries.recv().await {
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
            log!(
                Level::Error,
                "Failed to subscribe server log websocket: {error}"
            );
            return;
        }
    };

    let file_logging_enabled = subscription.log_file_path.is_some();
    let (mut sender, mut receiver) = socket.split();
    let (entries, history_read_failed) = tokio::select! {
        history = read_subscription_history(&subscription) => history,
        _ = wait_for_disconnect(&mut receiver) => return,
    };
    let snapshot = LogEvent::Snapshot {
        entries,
        file_logging_enabled,
    };
    let snapshot_sent = tokio::select! {
        sent = send_event(&mut sender, &snapshot) => sent,
        _ = wait_for_disconnect(&mut receiver) => return,
    };
    if !snapshot_sent || history_read_failed {
        return;
    }

    let mut live_entries = subscription.receiver;
    tokio::select! {
        _ = forward_live_entries(&mut sender, &mut live_entries) => {}
        _ = wait_for_disconnect(&mut receiver) => {}
    }
}

/// Converts file availability into a safe browser snapshot without exposing paths or I/O details.
async fn read_subscription_history(subscription: &LogSubscription) -> (Vec<String>, bool) {
    let Some(path) = subscription.log_file_path.as_deref() else {
        return (Vec::new(), false);
    };

    match logging::read_latest_entries(path, subscription.history_end).await {
        Ok(entries) => (entries, false),
        Err(error) => {
            log!(Level::Error, "Failed to read server log history: {error}");
            (Vec::new(), true)
        }
    }
}
