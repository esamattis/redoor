use std::{collections::VecDeque, path::Path};

use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    Level,
    commands::ServerLogEvent,
    log,
    logging::{self, LogSubscription},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::broadcast,
};

const HISTORY_ENTRY_LIMIT: usize = 500;

/// Keeps outbound helpers concise while retaining Axum's concrete socket sink type.
type SocketSender = futures_util::stream::SplitSink<WebSocket, WsMessage>;
/// Keeps disconnect handling independent from the live-entry forwarding loop.
type SocketReceiver = futures_util::stream::SplitStream<WebSocket>;

/// Upgrades the authenticated route-scoped connection used only by the server-log page.
pub(crate) async fn server_logs_websocket_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_server_logs_socket)
}

/// Reads complete newline-delimited entries through a stable cutoff while retaining only the newest 500.
async fn read_latest_entries(path: &Path, history_end: u64) -> std::io::Result<Vec<String>> {
    let file = tokio::fs::File::open(path).await?;
    let limited_file = file.take(history_end);
    let mut lines = BufReader::new(limited_file).lines();
    let mut entries = VecDeque::with_capacity(HISTORY_ENTRY_LIMIT);

    while let Some(line) = lines.next_line().await? {
        if entries.len() == HISTORY_ENTRY_LIMIT {
            entries.pop_front();
        }
        entries.push_back(line);
    }

    Ok(entries.into_iter().collect())
}

/// Sends one typed event and returns whether forwarding can safely continue.
async fn send_event(sender: &mut SocketSender, event: &ServerLogEvent) -> bool {
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
                if !send_event(sender, &ServerLogEvent::Entry { entry }).await {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let _ = send_event(sender, &ServerLogEvent::Lagged { skipped }).await;
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
    let snapshot = ServerLogEvent::Snapshot {
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

    match read_latest_entries(path, subscription.history_end).await {
        Ok(entries) => (entries, false),
        Err(error) => {
            log!(Level::Error, "Failed to read server log history: {error}");
            (Vec::new(), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tokio::io::AsyncWriteExt;
    use uuid::Uuid;

    use super::*;

    /// Creates a unique history file so asynchronous tests remain independent.
    fn temporary_log_path() -> PathBuf {
        std::env::temp_dir().join(format!("redoor-history-test-{}.log", Uuid::new_v4()))
    }

    /// Writes deterministic physical records without involving the process-global logger.
    async fn write_history(path: &Path, entries: &[String], final_newline: bool) {
        let mut contents = entries.join("\n");
        if final_newline {
            contents.push('\n');
        }
        tokio::fs::write(path, contents)
            .await
            .expect("test history should be writable");
    }

    /// Protects complete chronological snapshots when no eviction is necessary.
    #[tokio::test]
    async fn returns_all_entries_in_original_order_below_limit() {
        let path = temporary_log_path();
        let expected = vec![
            "first".to_string(),
            "second".to_string(),
            "third".to_string(),
        ];
        write_history(&path, &expected, true).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("test history metadata should be available")
            .len();

        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("small history should be readable");

        // Histories below the cap must retain every complete entry.
        assert_eq!(actual.len(), expected.len());
        // Source order must be preserved so the newest entry renders at the bottom.
        assert_eq!(actual, expected);
        tokio::fs::remove_file(path)
            .await
            .expect("test history should be removable");
    }

    /// Protects the memory cap while retaining the newest chronological records.
    #[tokio::test]
    async fn retains_only_the_latest_five_hundred_entries() {
        let path = temporary_log_path();
        let entries = (1..=510)
            .map(|index| format!("line-{index:03}"))
            .collect::<Vec<_>>();
        write_history(&path, &entries, true).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("test history metadata should be available")
            .len();

        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("large history should be readable");

        // The in-memory rolling window must never retain more than the requested cap.
        assert_eq!(actual.len(), HISTORY_ENTRY_LIMIT);
        // Eviction must discard the ten oldest records rather than newer records.
        assert_eq!(actual.first().map(String::as_str), Some("line-011"));
        // The newest physical record must remain last after bounded scanning.
        assert_eq!(actual.last().map(String::as_str), Some("line-510"));
        tokio::fs::remove_file(path)
            .await
            .expect("test history should be removable");
    }

    /// Protects the atomic handoff from records appended after subscription creation.
    #[tokio::test]
    async fn cutoff_excludes_later_appends() {
        let path = temporary_log_path();
        write_history(&path, &["before cutoff".to_string()], true).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("test history metadata should be available")
            .len();
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .expect("test history should reopen for append");
        file.write_all(b"after cutoff\n")
            .await
            .expect("later test entry should append");
        drop(file);

        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("stable history prefix should be readable");

        // The exact byte boundary must expose records accepted before subscription.
        assert_eq!(actual, vec!["before cutoff"]);
        // Appends through another file handle must not leak into the initial snapshot.
        assert!(!actual.iter().any(|entry| entry == "after cutoff"));
        tokio::fs::remove_file(path)
            .await
            .expect("test history should be removable");
    }

    /// Protects empty persistent history as a valid snapshot rather than an error.
    #[tokio::test]
    async fn empty_file_returns_an_empty_snapshot() {
        let path = temporary_log_path();
        tokio::fs::write(&path, b"")
            .await
            .expect("empty test history should be writable");

        let actual = read_latest_entries(&path, 0)
            .await
            .expect("empty history should be readable");

        // An empty active file is valid and must not invent a placeholder entry.
        assert!(actual.is_empty());
        tokio::fs::remove_file(path)
            .await
            .expect("test history should be removable");
    }

    /// Protects an unterminated final physical line from being silently discarded.
    #[tokio::test]
    async fn retains_final_entry_without_newline() {
        let path = temporary_log_path();
        let expected = vec!["complete line".to_string(), "final line".to_string()];
        write_history(&path, &expected, false).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("test history metadata should be available")
            .len();

        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("unterminated final history entry should be readable");

        // A final physical line remains a complete display entry even without a trailing delimiter.
        assert_eq!(actual, expected);
        tokio::fs::remove_file(path)
            .await
            .expect("test history should be removable");
    }
}
