//! Streams search matches to the server as batched NDJSON lines while the walk still runs.
//!
//! Path search and content grep share this driver, so both validate before they stream, batch
//! the same way, end with their `done` line and stop the same way on cancel.

use crate::transfers::stream::StreamWriter;
use redoor_protocol::wire::{command::CommandErrorKind, request::CommandError};
use serde::Serialize;
use std::future::Future;
use std::time::Duration;
use tokio::{sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;

/// Longest a found match waits before it is sent. Short enough that results appear while the
/// reader watches, long enough that a burst of matches shares one frame.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
/// Batch size that is sent at once without waiting for the interval. A stream has only a few
/// frames of credit in flight, so one frame per match would wait for a credit round trip every
/// few matches on a slow link.
const FLUSH_BYTES: usize = 32 * 1024;
/// Matches the walk may get ahead of the writer before it waits for it, which bounds the
/// memory a stalled consumer can make the agent hold.
const EVENT_CHANNEL_CAPACITY: usize = 64;

/// Sending half of the channel from a walk to its writer.
pub(crate) struct MatchSink<E>(mpsc::Sender<E>);

impl<E> MatchSink<E> {
    /// Hands one event to the writer. `false` means the writer stopped because the connection
    /// is gone, so the walk should stop too.
    pub(crate) async fn send(&self, event: E) -> bool {
        self.0.send(event).await.is_ok()
    }
}

/// Output side of one search: the request's stream and the token that cancels it.
pub(crate) struct SearchStream<'a> {
    stream: StreamWriter,
    cancel: &'a CancellationToken,
    /// Names the search in errors, such as "File search".
    label: &'static str,
}

impl<'a> SearchStream<'a> {
    /// Binds the search to its stream and cancellation token.
    pub(crate) fn new(
        stream: StreamWriter,
        cancel: &'a CancellationToken,
        label: &'static str,
    ) -> Self {
        Self {
            stream,
            cancel,
            label,
        }
    }

    /// Gives the stream back, so the command's result can follow its data on the same lane.
    pub(crate) fn into_writer(self) -> StreamWriter {
        self.stream
    }

    /// The error a canceled search reports instead of a `done` line.
    fn canceled(&self) -> CommandError {
        CommandError::new(
            CommandErrorKind::Canceled,
            format!("{} canceled by server", self.label),
        )
    }

    /// The error a search reports when the server connection went away mid-stream.
    fn disconnected(&self) -> CommandError {
        CommandError::new(
            CommandErrorKind::Internal,
            format!("{} connection closed", self.label),
        )
    }

    /// Tells the server that validation passed, before any match exists.
    ///
    /// Errors found before this frame are the command's result with no data, so the server
    /// can still answer them with a proper HTTP status.
    pub(crate) async fn ready(&mut self) -> Result<(), CommandError> {
        let sent = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(self.canceled()),
            sent = self.stream.send_ready() => sent,
        };
        if sent {
            Ok(())
        } else {
            Err(self.disconnected())
        }
    }

    /// Runs `walk` beside a writer that batches its events, then ends the stream with the
    /// `done` event the walk returns.
    ///
    /// The `done` line rides on the final frame, which needs no credit, so a finished or timed
    /// out search always ends even when the consumer stopped granting credit. A cancel stops
    /// the walk and the writer wherever they wait and ends the stream without `FIN`.
    pub(crate) async fn run<E, F>(
        &mut self,
        walk: impl FnOnce(MatchSink<E>) -> F,
    ) -> Result<(), CommandError>
    where
        E: Serialize,
        F: Future<Output = Result<E, CommandError>>,
    {
        let (sender, receiver) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let walk = walk(MatchSink(sender));
        let cancel = self.cancel;
        let both = async {
            tokio::join!(
                walk,
                BatchWriter::default().write(&mut self.stream, receiver)
            )
        };
        let (done, remaining) = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(self.canceled()),
            outputs = both => outputs,
        };
        let Some(mut last) = remaining else {
            return Err(self.disconnected());
        };
        append_line(&mut last, &done?);
        let sent = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(self.canceled()),
            sent = self.stream.send(&last, true) => sent,
        };
        if sent {
            Ok(())
        } else {
            Err(self.disconnected())
        }
    }
}

/// NDJSON lines not sent yet, and when they must go out at the latest.
#[derive(Default)]
struct BatchWriter {
    batch: Vec<u8>,
    flush_at: Option<Instant>,
}

impl BatchWriter {
    /// Writes events as NDJSON lines until the walk closes the channel, and returns the lines
    /// still unsent so they can share the final frame with `done`; `None` if the connection
    /// closed.
    ///
    /// A batch is sent when it reaches [`FLUSH_BYTES`] or [`FLUSH_INTERVAL`] after its first
    /// line, whichever comes first.
    async fn write<E: Serialize>(
        mut self,
        stream: &mut StreamWriter,
        mut events: mpsc::Receiver<E>,
    ) -> Option<Vec<u8>> {
        loop {
            let event = match self.flush_at {
                Some(flush_at) => tokio::select! {
                    event = events.recv() => event,
                    _ = tokio::time::sleep_until(flush_at) => {
                        if !self.flush(stream).await {
                            return None;
                        }
                        continue;
                    }
                },
                None => events.recv().await,
            };
            let Some(event) = event else {
                return Some(self.batch);
            };
            append_line(&mut self.batch, &event);
            self.flush_at
                .get_or_insert_with(|| Instant::now() + FLUSH_INTERVAL);
            if self.batch.len() >= FLUSH_BYTES && !self.flush(stream).await {
                return None;
            }
        }
    }

    /// Sends the batch as non-final data; `false` if the connection closed.
    async fn flush(&mut self, stream: &mut StreamWriter) -> bool {
        self.flush_at = None;
        let sent = stream.send(&self.batch, false).await;
        self.batch.clear();
        sent
    }
}

/// Appends one event as an NDJSON line.
fn append_line(batch: &mut Vec<u8>, event: &impl Serialize) {
    // Search events are plain structs of strings and numbers, which always serialize.
    if serde_json::to_writer(&mut *batch, event).is_ok() {
        batch.push(b'\n');
    }
}

/// Helpers for tests that run a search against a recording stream.
#[cfg(test)]
pub(crate) mod test_support {
    use crate::transfers::stream::{OutputCredits, StreamWriter};
    use redoor_protocol::{ids::RequestId, wire::stream::StreamChunk};
    use serde::de::DeserializeOwned;
    use tokio::{sync::mpsc, task::JoinHandle};

    /// Builds a writer whose frames a background task records until the writer is dropped.
    /// The task returns credit for every frame, like a server whose client keeps reading.
    pub(crate) fn recording_writer() -> (StreamWriter, JoinHandle<Vec<StreamChunk>>) {
        let request_id = RequestId::new(9);
        let credits = OutputCredits::default();
        let (lane, mut receiver) = mpsc::channel(16);
        let writer = StreamWriter::new(lane, request_id, credits.register(request_id));
        let recorder = tokio::spawn(async move {
            let mut frames = Vec::new();
            while let Some(frame) = receiver.recv().await {
                if let Some(chunk) = frame.as_stream() {
                    credits.grant(request_id, 1);
                    frames.push(chunk.clone());
                }
            }
            frames
        });
        (writer, recorder)
    }

    /// Builds a directory maze whose number of paths doubles with every level, without a
    /// cycle: each level holds `file_name` and two symlinks to the next level. No walk can
    /// visit all of its paths, so only a deadline or a cancel ends a search of it. Returns the
    /// maze's entry directory.
    pub(crate) async fn symlink_maze(
        parent: &std::path::Path,
        file_name: &str,
        contents: &[u8],
    ) -> std::path::PathBuf {
        const LEVELS: usize = 40;
        let maze = parent.join("maze");
        for level in 0..=LEVELS {
            let directory = maze.join(format!("level-{level}"));
            tokio::fs::create_dir_all(&directory).await.unwrap();
            tokio::fs::write(directory.join(file_name), contents)
                .await
                .unwrap();
            if level < LEVELS {
                let next = maze.join(format!("level-{}", level + 1));
                for link in ["a", "b"] {
                    tokio::fs::symlink(&next, directory.join(link))
                        .await
                        .unwrap();
                }
            }
        }
        maze.join("level-0")
    }

    /// Parses the NDJSON events carried by recorded frames, in order.
    pub(crate) fn events<E: DeserializeOwned>(frames: &[StreamChunk]) -> Vec<E> {
        let data: Vec<u8> = frames
            .iter()
            .flat_map(|chunk| chunk.data.iter().copied())
            .collect();
        data.split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).expect("search lines are events"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::recording_writer;
    use super::*;
    use crate::transfers::stream::OutputCredits;
    use redoor_protocol::ids::RequestId;

    /// One line of the test stream.
    #[derive(Serialize, serde::Deserialize, Debug, PartialEq)]
    struct Line {
        text: String,
    }

    /// Verifies bursts share frames, a full batch goes out without waiting and the remaining
    /// lines ride on the final frame with `done`.
    #[tokio::test]
    async fn batches_bursts_and_ends_with_done_on_fin() {
        let (writer, recorder) = recording_writer();
        let cancel = CancellationToken::new();
        let mut search = SearchStream::new(writer, &cancel, "Test search");
        let text = "x".repeat(1000);
        search
            .run(|sink| async move {
                for _ in 0..100 {
                    assert!(sink.send(Line { text: text.clone() }).await);
                }
                Ok(Line {
                    text: "done".to_string(),
                })
            })
            .await
            .expect("the search ends normally");
        drop(search.into_writer());
        let frames = recorder.await.unwrap();
        let lines: Vec<Line> = test_support::events(&frames);

        // Every line arrives once, in order, with `done` last.
        assert_eq!(lines.len(), 101);
        assert_eq!(lines[100].text, "done");
        // About 100 KB of lines go out in a few size-triggered batches, not one frame each.
        assert!(frames.len() <= 5, "{} frames", frames.len());
        // No batch waits until it is much larger than the flush size.
        assert!(
            frames
                .iter()
                .all(|frame| frame.data.len() < FLUSH_BYTES + 1100)
        );
        // Only the last frame ends the stream, and it carries the `done` line.
        assert!(frames.last().is_some_and(|frame| frame.is_last));
        assert!(
            frames[..frames.len() - 1]
                .iter()
                .all(|frame| !frame.is_last)
        );
    }

    /// Verifies a lone match is sent on the interval while the walk is still running.
    #[tokio::test]
    async fn flushes_a_lone_match_while_the_walk_runs() {
        let request_id = RequestId::new(3);
        let (lane, mut frames) = mpsc::channel(16);
        let writer = StreamWriter::new(
            lane,
            request_id,
            OutputCredits::default().register(request_id),
        );
        let cancel = CancellationToken::new();
        let mut search = SearchStream::new(writer, &cancel, "Test search");
        // The receiver outlives the walk, so the final frame still has a lane to go to.
        let frames = &mut frames;
        search
            .run(|sink| async move {
                assert!(
                    sink.send(Line {
                        text: "early".to_string(),
                    })
                    .await
                );
                // The walk only ends after the match reached the lane on its own.
                let frame = frames.recv().await.expect("the batch is flushed");
                let chunk = frame.as_stream().expect("a stream frame");
                // The match went out as data before the stream ended.
                assert!(!chunk.is_last);
                assert_eq!(chunk.data, b"{\"text\":\"early\"}\n");
                Ok(Line {
                    text: "done".to_string(),
                })
            })
            .await
            .expect("the search ends normally");
    }

    /// Verifies a cancel stops a walk that waits forever and ends the stream without `FIN`.
    #[tokio::test]
    async fn cancel_stops_a_waiting_walk_without_fin() {
        let (writer, recorder) = recording_writer();
        let cancel = CancellationToken::new();
        let mut search = SearchStream::new(writer, &cancel, "Test search");
        let result = search
            .run(|_sink: MatchSink<Line>| async {
                cancel.cancel();
                std::future::pending::<Result<Line, CommandError>>().await
            })
            .await;
        drop(search.into_writer());

        // The cancel is reported as such, not as a finished search.
        assert!(matches!(
            result,
            Err(CommandError {
                kind: CommandErrorKind::Canceled,
                ..
            })
        ));
        // A canceled stream never looks complete.
        assert!(recorder.await.unwrap().iter().all(|frame| !frame.is_last));
    }
}
