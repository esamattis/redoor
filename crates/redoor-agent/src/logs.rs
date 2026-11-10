//! Live log streaming: this agent's log events as NDJSON on one stream of the connection.
//!
//! A log event can be larger than one 64 KiB frame, so events are newline-delimited JSON that
//! may span frames; the server reassembles each line before relaying it to the browser.

use crate::transfers::stream::StreamWriter;
use anyhow::{Context, Result};
use redoor_core::{log, logging, logging::LogSubscription};
use redoor_protocol::{
    ids::RequestId,
    wire::log::{Level, LogEntry, LogEvent},
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

/// Streams the snapshot and then live entries until the server cancels the stream, the
/// connection ends, the logger lags or fails; the stream ends with FIN in every case but
/// cancellation and a closed lane, so the server's viewer never waits for nothing.
pub(crate) async fn run(
    stream: RequestId,
    mut writer: StreamWriter,
    cancel: CancellationToken,
) -> Result<()> {
    let subscription = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = logging::subscribe() => result,
    };
    let subscription = match subscription {
        Ok(subscription) => subscription,
        Err(error) => {
            writer.send(bytes::Bytes::new(), true).await;
            return Err(error).context("logger is unavailable");
        }
    };
    log!(Level::Info, "Agent log stream started: stream={}", stream);
    let finished = tokio::select! {
        _ = cancel.cancelled() => Ok(false),
        result = forward(&mut writer, subscription) => result,
    };
    if !matches!(finished, Ok(false)) {
        writer.send(bytes::Bytes::new(), true).await;
    }
    log!(Level::Info, "Agent log stream stopped: stream={}", stream);
    finished.map(|_| ())
}

/// Sends the snapshot and live entries; returns whether the stream should be ended with FIN.
async fn forward(writer: &mut StreamWriter, mut subscription: LogSubscription) -> Result<bool> {
    let snapshot =
        LogEvent::bounded_snapshot(subscription.entries, subscription.file_logging_enabled);
    if !send_event(writer, &snapshot).await? {
        return Ok(false);
    }
    forward_live_entries(writer, &mut subscription.receiver).await
}

/// Forwards bounded logger records and ends after one lag notification.
async fn forward_live_entries(
    writer: &mut StreamWriter,
    receiver: &mut broadcast::Receiver<LogEntry>,
) -> Result<bool> {
    loop {
        match receiver.recv().await {
            Ok(entry) => {
                if !send_event(writer, &LogEvent::Entry { entry }).await? {
                    return Ok(false);
                }
            }
            Err(broadcast::error::RecvError::Closed) => return Ok(true),
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                return send_event(writer, &LogEvent::Lagged { skipped }).await;
            }
        }
    }
}

/// Writes one event as a JSON line; returns `false` once the stream can no longer be written.
async fn send_event(writer: &mut StreamWriter, event: &LogEvent) -> Result<bool> {
    let mut line = serde_json::to_vec(event).context("failed to encode log event")?;
    line.push(b'\n');
    Ok(writer.send(line, false).await)
}
