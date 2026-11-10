//! Agent-to-server output streams (downloads and process output) for REST and MCP consumers.

use crate::actors::router::{
    ExecuteStreamRequest, OutputReceiver, OutputStreamTracking, RouterHandle, RouterMsg,
};
use crate::http::error::ApiError;
use axum::{body::Body, http::header, response::Response};
use bytes::Bytes;
use futures_util::Stream;
use redoor_protocol::wire::request;
use redoor_protocol::{
    ids::{AgentId, RequestId},
    wire::{
        command::Command,
        exec::{ExecEvent, ExecRequest},
        stream::StreamChunk,
    },
};
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Duration;
use tokio::sync::watch;
use tokio_util::sync::ReusableBoxFuture;

/// Message for a failure that carried no text.
const UNDESCRIBED_FAILURE: &str = "Agent stream failed";

/// Message for a byte stream that stopped before the agent's `FIN`, so a canceled download
/// never looks like a complete, shorter file.
const INCOMPLETE_STREAM: &str = "Stream ended before completion";

/// One frame of an output stream, or the reason the stream failed.
type StreamItem = Result<StreamChunk, AgentStreamError>;

/// The pending receive of an output stream, owning the receiver so polling can resume across
/// dropped `recv` futures and `Stream` polls alike.
type ReceiveFuture = ReusableBoxFuture<'static, (OutputReceiver, Option<StreamItem>)>;

/// The stream failed: the agent's result was an error, or the router failed the stream; the
/// text is the (possibly empty) reason.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{}", .0.message)]
pub(crate) struct AgentStreamError(pub(crate) request::CommandError);

/// One admitted output stream plus the cleanup its consumer owes the agent.
///
/// Dropping the stream before its terminal frame (an HTTP client disconnecting, an MCP read that
/// stopped at its byte limit) cancels the agent worker, so no consumer can forget to arm or
/// disarm cancellation. Frames are read with [`OutputStream::recv`] or, for byte consumers,
/// through the [`Stream`] implementation; both share one cancel-safe receive.
pub(crate) struct OutputStream {
    request_id: RequestId,
    receive: ReceiveFuture,
    /// An item read ahead by [`OutputStream::peek`], returned before any new one.
    peeked: Option<StreamItem>,
    guard: OutputCancelGuard,
    /// Set once the byte stream yielded its final item.
    finished: bool,
}

impl OutputStream {
    /// Admits an output command and returns its armed consumer.
    pub(crate) async fn open(
        router: &RouterHandle,
        agent_id: AgentId,
        command: Command,
        tracking: OutputStreamTracking,
    ) -> Result<Self, ApiError> {
        let receiver = router
            .request(|reply| {
                RouterMsg::ExecuteStreamCommandRest(ExecuteStreamRequest {
                    agent_id: agent_id.clone(),
                    command,
                    tracking,
                    reply,
                })
            })
            .await??;
        let request_id = receiver.request_id();
        Ok(Self {
            request_id,
            receive: ReusableBoxFuture::new(Self::receive(receiver)),
            peeked: None,
            guard: OutputCancelGuard {
                router: router.clone(),
                agent_id,
                request_id,
                armed: true,
            },
            finished: false,
        })
    }

    /// Admits a non-PTY execution and returns its output plus the independent terminal lane,
    /// which reports how the process ended even when the output queue is saturated.
    pub(crate) async fn open_execution(
        router: &RouterHandle,
        agent_id: AgentId,
        request: ExecRequest,
    ) -> Result<(Self, watch::Receiver<Option<ExecEvent>>), ApiError> {
        let (terminal, terminal_receiver) = watch::channel(None);
        let stream = Self::open(
            router,
            agent_id,
            Command::Exec(request::Exec { request }),
            OutputStreamTracking::Execution { terminal },
        )
        .await?;
        Ok((stream, terminal_receiver))
    }

    /// Admits an NDJSON event stream (a search or a journal) and waits up to `timeout` for
    /// the agent's first frame.
    ///
    /// The agent validates its request before it sends anything, so an early failure arrives
    /// here as the stream's error and becomes a proper HTTP status instead of a body that
    /// breaks off after a `200`. `what` names the stream in the error for a stream that ends
    /// before it starts.
    pub(crate) async fn open_events(
        router: &RouterHandle,
        agent_id: AgentId,
        command: Command,
        timeout: Duration,
        what: &str,
    ) -> Result<Self, ApiError> {
        let mut output =
            Self::open(router, agent_id, command, OutputStreamTracking::Events).await?;
        let first = tokio::time::timeout(timeout, output.peek())
            .await
            .map_err(|_| ApiError::Timeout(timeout))?;
        match first {
            Some(Ok(_)) => Ok(output),
            Some(Err(AgentStreamError(error))) => Err(ApiError::Command {
                kind: error.kind.clone(),
                message: error.message.clone(),
            }),
            None => Err(ApiError::internal(format!(
                "{what} ended before it started"
            ))),
        }
    }

    /// Answers with the agent's NDJSON lines as they arrive.
    ///
    /// The body ends with an error when the agent fails mid-stream, so a client never takes a
    /// cut-off stream for a finished one. Dropping the body cancels the agent's work.
    pub(crate) fn into_ndjson_response(self) -> Response {
        Response::builder()
            .header(header::CONTENT_TYPE, "application/x-ndjson")
            // Reverse proxies such as nginx would otherwise hold lines back until the stream
            // ends, which defeats streaming them.
            .header("X-Accel-Buffering", "no")
            .body(Body::from_stream(self))
            .unwrap_or_else(|_| Response::new(Body::empty()))
    }

    /// Request id of the stream, which executions expose for cancellation.
    pub(crate) fn request_id(&self) -> RequestId {
        self.request_id
    }

    /// Releases the agent from cancellation once a terminal outcome was observed elsewhere
    /// (the execution terminal lane).
    pub(crate) fn disarm(&mut self) {
        self.guard.armed = false;
    }

    /// Receives the next frame or the stream's failure, or `None` when the stream ended.
    ///
    /// Cancel safe: the receive in progress lives in the stream, so a `select!` that drops this
    /// future loses no frame. `FIN` or a failure disarms cancellation because the agent worker
    /// already finished.
    pub(crate) async fn recv(&mut self) -> Option<StreamItem> {
        if let Some(item) = self.peeked.take() {
            return Some(item);
        }
        std::future::poll_fn(|cx| self.poll_recv(cx)).await
    }

    /// Reads the first item without consuming it, so callers can still answer with a JSON
    /// error before committing to a streaming response.
    pub(crate) async fn peek(&mut self) -> Option<&StreamItem> {
        if self.peeked.is_none() {
            self.peeked = std::future::poll_fn(|cx| self.poll_recv(cx)).await;
        }
        self.peeked.as_ref()
    }

    /// Collects at most `limit` payload bytes into memory.
    ///
    /// Reading stops at the final frame or at the first byte beyond `limit`; dropping the
    /// stream afterwards cancels an agent that still has more. A failed stream becomes `Err`
    /// with its message (possibly empty).
    pub(crate) async fn read_bounded(
        &mut self,
        limit: usize,
    ) -> Result<BoundedRead, AgentStreamError> {
        let mut data = Vec::with_capacity(limit.min(64 * 1024));
        while let Some(item) = self.recv().await {
            let chunk = item?;
            let room = limit - data.len();
            if chunk.data.len() > room {
                data.extend_from_slice(&chunk.data[..room]);
                return Ok(BoundedRead {
                    data,
                    overflowed: true,
                    completed: false,
                });
            }
            data.extend_from_slice(&chunk.data);
            if chunk.is_last {
                return Ok(BoundedRead {
                    data,
                    overflowed: false,
                    completed: true,
                });
            }
        }
        Ok(BoundedRead {
            data,
            overflowed: false,
            completed: false,
        })
    }

    /// One receive that hands the receiver back with its item, so it can be restarted.
    async fn receive(mut receiver: OutputReceiver) -> (OutputReceiver, Option<StreamItem>) {
        let item = receiver
            .recv()
            .await
            .map(|item| item.map_err(AgentStreamError));
        (receiver, item)
    }

    /// Polls the stored receive and immediately re-arms it for the next item.
    fn poll_recv(&mut self, cx: &mut Context<'_>) -> Poll<Option<StreamItem>> {
        let (receiver, item) = ready!(self.receive.poll(cx));
        self.receive.set(Self::receive(receiver));
        let finished = match &item {
            Some(Ok(chunk)) => chunk.is_last,
            Some(Err(_)) | None => true,
        };
        if finished {
            // The worker finished (or the router ended the stream); nothing is left to cancel.
            self.guard.armed = false;
        }
        Poll::Ready(item)
    }
}

/// Bytes collected by [`OutputStream::read_bounded`].
pub(crate) struct BoundedRead {
    /// At most `limit` payload bytes.
    pub(crate) data: Vec<u8>,
    /// Whether the agent sent more than `limit` bytes.
    pub(crate) overflowed: bool,
    /// Whether the agent's final frame was received.
    pub(crate) completed: bool,
}

impl Stream for OutputStream {
    type Item = std::io::Result<Bytes>;

    /// Yields payload bytes; a failed stream, or one that stopped before `FIN`, ends with an
    /// I/O error so an HTTP body fails visibly instead of looking like a complete, truncated
    /// file.
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        loop {
            if this.finished {
                return Poll::Ready(None);
            }
            let item = match this.peeked.take() {
                Some(item) => Some(item),
                None => ready!(this.poll_recv(cx)),
            };
            let chunk = match item {
                Some(Ok(chunk)) => chunk,
                Some(Err(AgentStreamError(error))) => {
                    this.finished = true;
                    let message = if error.message.is_empty() {
                        UNDESCRIBED_FAILURE.to_string()
                    } else {
                        error.message
                    };
                    return Poll::Ready(Some(Err(std::io::Error::other(message))));
                }
                None => {
                    this.finished = true;
                    return Poll::Ready(Some(Err(std::io::Error::other(INCOMPLETE_STREAM))));
                }
            };
            this.finished = chunk.is_last;
            if !chunk.data.is_empty() {
                return Poll::Ready(Some(Ok(chunk.data)));
            }
        }
    }
}

/// Cancels the agent worker of a stream whose consumer went away before its terminal frame.
struct OutputCancelGuard {
    router: RouterHandle,
    agent_id: AgentId,
    request_id: RequestId,
    armed: bool,
}

impl Drop for OutputCancelGuard {
    /// Waits for mailbox capacity in a task: a lost cancel would leave the agent streaming
    /// into a stream nobody reads.
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let router = self.router.clone();
        let agent_id = self.agent_id.clone();
        let request_id = self.request_id;
        redoor_core::logging::spawn_in_user_scope(async move {
            let _ = router
                .send_async(RouterMsg::CancelTransfer {
                    agent_id,
                    request_id,
                })
                .await;
        });
    }
}

#[cfg(test)]
impl OutputStream {
    /// Wraps a detached receiver so consumer tests need no admission round trip.
    pub(crate) fn detached(
        router: RouterHandle,
        agent_id: AgentId,
        receiver: OutputReceiver,
    ) -> Self {
        let request_id = receiver.request_id();
        Self {
            request_id,
            receive: ReusableBoxFuture::new(Self::receive(receiver)),
            peeked: None,
            guard: OutputCancelGuard {
                router,
                agent_id,
                request_id,
                armed: true,
            },
            finished: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::fake_agent::FakeAgent;
    use futures_util::StreamExt;
    use redoor_protocol::wire::ServerToAgent;

    /// Opens a download of `/tmp/file` on the fake agent.
    async fn download(agent: &mut FakeAgent) -> OutputStream {
        let stream = OutputStream::open(
            &agent.router,
            agent.agent_id.clone(),
            Command::RawDownload(request::RawDownload {
                expected_identity: None,
                path: "/tmp/file".to_string(),
                range_start: None,
                range_end: None,
            }),
            OutputStreamTracking::Download {
                path: "/tmp/file".to_string(),
                total_bytes: 8,
                full_size: Some(8),
                resume_offset: None,
            },
        )
        .await
        .unwrap();
        let (request_id, _) = agent.next_command().await;
        // The consumer and the agent agree on the stream they talk about.
        assert_eq!(stream.request_id(), request_id);
        stream
    }

    /// One agent frame of the stream.
    fn frame(request_id: RequestId, data: &[u8], is_last: bool) -> StreamChunk {
        StreamChunk {
            request_id,
            is_last,
            data: bytes::Bytes::copy_from_slice(data),
        }
    }

    /// Dropping an unfinished stream cancels its agent worker; a finished one does not.
    #[tokio::test]
    async fn drop_before_terminal_cancels_the_agent() {
        let mut agent = FakeAgent::connect().await;
        let stream = download(&mut agent).await;
        let id = stream.request_id();
        drop(stream);
        // A consumer that vanished must not leave the agent streaming into nothing.
        assert!(matches!(
            agent.next_priority().await,
            ServerToAgent::Cancel { id: request_id, reason: redoor_protocol::wire::partials::CancelReason::Canceled } if request_id == id
        ));

        let mut stream = download(&mut agent).await;
        let id = stream.request_id();
        agent.deliver(frame(id, b"done", true)).await;
        // The terminal frame is still delivered to the consumer.
        assert!(
            stream
                .recv()
                .await
                .is_some_and(|item| item.is_ok_and(|chunk| chunk.is_last))
        );
        // A worker that already finished has nothing left to cancel.
        assert!(!stream.guard.armed);
    }

    /// The byte stream yields payload, then fails visibly when the agent's result is an
    /// error.
    #[tokio::test]
    async fn byte_stream_ends_with_error_on_agent_failure() {
        let mut agent = FakeAgent::connect().await;
        let mut stream = download(&mut agent).await;
        let id = stream.request_id();
        agent.deliver(frame(id, b"", false)).await;
        agent.deliver(frame(id, b"abc", false)).await;
        agent
            .respond(
                id,
                redoor_protocol::wire::request::CommandOutcome::error(
                    redoor_protocol::wire::command::CommandErrorKind::Internal,
                    "disk gone",
                ),
            )
            .await;
        // Empty frames carry nothing for the HTTP body and are skipped.
        assert_eq!(stream.next().await.unwrap().unwrap(), Bytes::from("abc"));
        let error = stream.next().await.unwrap().unwrap_err();
        // The body aborts with the agent's message instead of ending like a complete file.
        assert_eq!(error.to_string(), "disk gone");
        assert!(stream.next().await.is_none());
    }

    /// A byte stream stopped before `FIN` fails instead of ending like a shorter file.
    #[tokio::test]
    async fn byte_stream_stopped_before_fin_fails() {
        let mut agent = FakeAgent::connect().await;
        let mut stream = download(&mut agent).await;
        let id = stream.request_id();
        agent.deliver(frame(id, b"abc", false)).await;
        agent
            .router
            .send_async(RouterMsg::CancelTransfer {
                agent_id: agent.agent_id.clone(),
                request_id: id,
            })
            .await
            .unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap(), Bytes::from("abc"));
        // A canceled download must not look complete to the HTTP client.
        assert_eq!(
            stream.next().await.unwrap().unwrap_err().to_string(),
            INCOMPLETE_STREAM
        );
    }

    /// Bounded reads stop at the limit and report that more data exists.
    #[tokio::test]
    async fn read_bounded_stops_at_the_limit() {
        let mut agent = FakeAgent::connect().await;
        let mut stream = download(&mut agent).await;
        let id = stream.request_id();
        let delivery = tokio::spawn({
            let streams = agent.streams.clone();
            async move {
                streams.deliver(frame(id, b"abcd", false));
                streams.deliver(frame(id, b"efgh", false));
            }
        });
        let read = stream.read_bounded(6).await.unwrap();
        // Only the requested bytes are kept in memory.
        assert_eq!(read.data, b"abcdef");
        // The caller learns the content continues and that the agent did not finish.
        assert!(read.overflowed && !read.completed);
        delivery.await.unwrap();
        drop(stream);
        // Stopping early cancels the agent, which may still be producing.
        assert!(matches!(
            agent.next_priority().await,
            ServerToAgent::Cancel { id: request_id, reason: redoor_protocol::wire::partials::CancelReason::Canceled } if request_id == id
        ));
    }
}
