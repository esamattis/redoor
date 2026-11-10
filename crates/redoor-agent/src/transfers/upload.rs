//! Generic driver for server-to-agent uploads plus the chunk and publication routing they share.
//!
//! Raw file uploads, tar directory uploads and in-place file edits differ only in how bytes are
//! staged and published. Their lifecycle (readiness, payload validation, cancellation, abort,
//! unregistration and the terminal response) lives here once so the three cannot drift apart.

use crate::commands::ctx::CommandCtx;
use crate::errors::AgentCommandError;
use crate::runtime::responder::{ControlSender, Responder, ResultLedger};
use bytes::Bytes;
use redoor_core::log;
use redoor_core::stream_credit::CreditLedger;
use redoor_protocol::wire::request::{CommandError, CommandOutcome};
use redoor_protocol::{
    ids::RequestId,
    wire::{
        command::CommandErrorKind,
        log::Level,
        policy::UploadKind,
        stream::{STREAM_CREDIT_WINDOW_FRAMES, StreamChunk},
    },
};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Bounded per-upload chunk queue between the connection reader and the worker: exactly the
/// credit window plus the terminal frame, so an honest server never fills it and the first
/// frame beyond its credit is detected as a violation.
const CHUNK_QUEUE_CAPACITY: usize = redoor_protocol::wire::stream::receive_queue_frames(
    redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES,
);
/// Upper bound on waiting for the router's publication decision.
const PUBLICATION_DECISION_TIMEOUT: Duration = Duration::from_secs(30);

/// Destination-specific staging and publication for one upload.
pub(crate) trait UploadSink: Send + Sized {
    /// Whether a terminal chunk already queued must win over a concurrent cancellation.
    ///
    /// Edits commit an accepted terminal frame even if transfer teardown races it; replacing
    /// uploads instead stay promptly cancelable because publication is separately gated.
    const TERMINAL_WINS_OVER_CANCEL: bool = false;

    /// Stages one chunk of payload bytes; the frame's shared buffer is handed over as is.
    fn write(
        &mut self,
        data: Bytes,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<(), SinkError>> + Send;

    /// Publishes the staged content after the terminal chunk and returns the success result.
    ///
    /// Implementations remove their own staging output when publication fails.
    fn commit(
        self,
        gate: PublicationGate<'_>,
    ) -> impl Future<Output = Result<(), AgentCommandError>> + Send;

    /// Resumable sinks persist on pause or interruption; ordinary sinks retain cleanup behavior.
    fn stop(
        self,
        _reason: redoor_protocol::wire::partials::CancelReason,
    ) -> impl Future<Output = Result<(), AgentCommandError>> + Send {
        async move {
            self.abort().await;
            Ok(())
        }
    }

    /// Discards staged output after cancellation or failure.
    fn abort(self) -> impl Future<Output = ()> + Send;
}

/// Why staging one chunk stopped.
pub(crate) enum SinkError {
    /// Cancellation won while the sink waited for internal capacity.
    Canceled,
    /// The chunk could not be staged.
    Failed(AgentCommandError),
}

impl From<AgentCommandError> for SinkError {
    /// Staging failures carry their protocol error kind unchanged.
    fn from(error: AgentCommandError) -> Self {
        Self::Failed(error)
    }
}

/// Router-ordered permission to change the destination with staged content.
pub(crate) struct PublicationGate<'a> {
    routes: &'a UploadRoutes,
    responder: &'a Responder,
    cancel: &'a CancellationToken,
}

impl<'a> PublicationGate<'a> {
    /// Binds the gate to one request's routing, responder and cancellation.
    pub(crate) fn new(
        routes: &'a UploadRoutes,
        responder: &'a Responder,
        cancel: &'a CancellationToken,
    ) -> Self {
        Self {
            routes,
            responder,
            cancel,
        }
    }

    /// Whether the upload was canceled; checked after work the sink could not interrupt.
    pub(crate) fn is_canceled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Asks the router whether publication may proceed while cancellation stays possible.
    ///
    /// Metadata preparation touches only owned staging; the router orders cancellation before
    /// the first rename, backup or merge can affect user data.
    pub(crate) async fn authorize(&self) -> bool {
        if self.cancel.is_cancelled() {
            return false;
        }
        let request_id = self.responder.request_id();
        let decision = self.routes.await_publication(request_id);
        let authorization = async {
            self.responder.request_publication().await.ok()?;
            decision.await.ok()
        };
        let allowed = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => false,
            result = tokio::time::timeout(PUBLICATION_DECISION_TIMEOUT, authorization) => {
                result.ok().flatten().unwrap_or(false)
            }
        };
        self.routes.forget_publication(request_id);
        allowed && !self.cancel.is_cancelled()
    }
}

/// One event observed while the upload is still reversible.
enum UploadEvent {
    Chunk(Option<StreamChunk>),
    Canceled,
}

/// Why the receive loop ended without publishing.
enum UploadStop {
    Canceled,
    Failed(AgentCommandError),
}

/// Lifecycle owner for one upload request.
pub(crate) struct UploadDriver {
    kind: UploadKind,
    path: String,
    ctx: CommandCtx,
}

impl UploadDriver {
    /// Binds the driver to the command's context and destination for logs.
    pub(crate) fn new(kind: UploadKind, path: String, ctx: CommandCtx) -> Self {
        Self { kind, path, ctx }
    }

    /// Subject used in user-facing failure messages.
    fn subject(&self) -> &'static str {
        match self.kind {
            UploadKind::RawUpload | UploadKind::TarUpload => "Upload",
            UploadKind::EditFile => "File edit",
        }
    }

    /// Operation name used in logs.
    fn label(&self) -> &'static str {
        match self.kind {
            UploadKind::RawUpload => "Raw upload",
            UploadKind::TarUpload => "Tar upload",
            UploadKind::EditFile => "File edit",
        }
    }

    /// Runs the upload: announce readiness, stage chunks, then commit or abort.
    ///
    /// Owns the ordering every upload must follow on cancellation or failure: stop staging,
    /// unroute chunks, discard staging output, unregister the request, and only then let the
    /// dispatcher send the terminal response.
    pub(crate) async fn run<S: UploadSink>(
        self,
        prepared: Result<S, AgentCommandError>,
    ) -> Result<(), CommandError> {
        let mut sink = match prepared {
            Ok(sink) => sink,
            Err(error) => return Err(error.into()),
        };
        let request_id = self.ctx.responder.request_id();
        let (route, mut chunks) = self.ctx.services.upload_routes.open(request_id, &self.path);
        // The first credit grant is the readiness signal: it is sent only after the route
        // exists, so no chunk can arrive unroutable.
        let _ = self
            .ctx
            .responder
            .stream_credit(STREAM_CREDIT_WINDOW_FRAMES)
            .await;

        let mut bytes_written = 0_u64;
        let mut ledger = CreditLedger::default();
        let stop = loop {
            let chunk = match Self::next_event::<S>(&mut chunks, &self.ctx.cancel).await {
                UploadEvent::Canceled => break UploadStop::Canceled,
                UploadEvent::Chunk(Some(chunk)) => chunk,
                UploadEvent::Chunk(None) => {
                    break UploadStop::Failed(AgentCommandError::new(
                        CommandErrorKind::Internal,
                        format!("{} stream ended before completion", self.subject()),
                    ));
                }
            };
            let is_last = chunk.is_last;
            let consumed_credit = chunk.consumes_credit();
            let length = chunk.data.len() as u64;
            match sink.write(chunk.data, &self.ctx.cancel).await {
                Ok(()) => bytes_written = bytes_written.saturating_add(length),
                Err(SinkError::Canceled) => break UploadStop::Canceled,
                Err(SinkError::Failed(error)) => break UploadStop::Failed(error),
            }
            // Credit returns only after staging, so a slow destination throttles just this
            // upload's sender instead of the shared connection.
            if let Some(frames) = ledger.drained(consumed_credit) {
                let _ = self.ctx.responder.stream_credit(frames).await;
            }
            if is_last {
                let gate = PublicationGate::new(
                    &self.ctx.services.upload_routes,
                    &self.ctx.responder,
                    &self.ctx.cancel,
                );
                let result = sink.commit(gate).await;
                if result.is_ok() {
                    log!(
                        Level::Info,
                        "{} complete: request_id={}, path={}, bytes_written={}",
                        self.label(),
                        request_id,
                        self.path,
                        bytes_written
                    );
                }
                drop(route);
                drop(self.ctx);
                return result.map_err(CommandError::from);
            }
        };

        let result = match &stop {
            UploadStop::Canceled => {
                log!(
                    Level::Info,
                    "Stopping {} after cancel: request_id={}, path={}",
                    self.label().to_lowercase(),
                    request_id,
                    self.path
                );
                Err(CommandError::new(
                    CommandErrorKind::Canceled,
                    format!("{} canceled by server", self.subject()),
                ))
            }
            UploadStop::Failed(error) => Err(CommandError::new(error.kind(), error.to_string())),
        };
        // Unroute before the possibly slow abort so the reader drops late frames instead of
        // queueing them for a worker that stopped reading. Late frames for an unrouted request
        // are dropped.
        drop(route);
        drop(chunks);
        let reason = if matches!(stop, UploadStop::Canceled) {
            self.ctx.registration.as_ref().map_or(
                redoor_protocol::wire::partials::CancelReason::Canceled,
                |registration| registration.reason(),
            )
        } else {
            redoor_protocol::wire::partials::CancelReason::Disconnected
        };
        if let Err(error) = sink.stop(reason).await {
            return Err(error.into());
        }
        drop(self.ctx);
        if reason == redoor_protocol::wire::partials::CancelReason::Paused {
            Err(CommandError::new(
                CommandErrorKind::Paused,
                "Transfer paused; partial kept",
            ))
        } else {
            result
        }
    }

    /// Waits for the next chunk or cancellation, preferring an already queued terminal frame
    /// only for sinks that require it.
    async fn next_event<S: UploadSink>(
        chunks: &mut mpsc::Receiver<StreamChunk>,
        cancel: &CancellationToken,
    ) -> UploadEvent {
        if S::TERMINAL_WINS_OVER_CANCEL {
            tokio::select! {
                biased;
                chunk = chunks.recv() => UploadEvent::Chunk(chunk),
                _ = cancel.cancelled() => UploadEvent::Canceled,
            }
        } else {
            tokio::select! {
                chunk = chunks.recv() => UploadEvent::Chunk(chunk),
                _ = cancel.cancelled() => UploadEvent::Canceled,
            }
        }
    }
}

/// Destination recorded for one routed upload, used in delivery diagnostics.
struct UploadRoute {
    serial: u64,
    /// Shared so routing a frame clones a pointer, not the path; only warnings read it.
    path: Arc<str>,
    /// Never awaited by the socket reader; the server's credit bounds what it may hold.
    chunks: mpsc::Sender<StreamChunk>,
}

/// Shared routing tables guarded together so clearing them is atomic.
#[derive(Default)]
struct RouteTable {
    routes: HashMap<RequestId, UploadRoute>,
    publication_replies: HashMap<RequestId, oneshot::Sender<bool>>,
    next_serial: u64,
}

/// Routes inbound stream frames and router publication decisions to upload workers.
///
/// Chunks bypass the runtime mailbox entirely so a slow disk backpressures only the transfer
/// socket, never control traffic.
#[derive(Clone, Default)]
pub(crate) struct UploadRoutes {
    shared: Arc<Mutex<RouteTable>>,
}

impl UploadRoutes {
    /// Locks the tables, tolerating poison because each operation leaves them consistent.
    fn table(&self) -> std::sync::MutexGuard<'_, RouteTable> {
        self.shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Registers a chunk route for `request_id`; the guard removes it on drop.
    ///
    /// The route relies on the server honoring per-stream credit, which is what lets the
    /// connection reader enqueue without ever waiting on this worker.
    pub(crate) fn open(
        &self,
        request_id: RequestId,
        path: &str,
    ) -> (RouteGuard, mpsc::Receiver<StreamChunk>) {
        let (chunks, receiver) = mpsc::channel(CHUNK_QUEUE_CAPACITY);
        let mut table = self.table();
        table.next_serial = table.next_serial.wrapping_add(1);
        let serial = table.next_serial;
        table.routes.insert(
            request_id,
            UploadRoute {
                serial,
                path: Arc::from(path),
                chunks,
            },
        );
        (
            RouteGuard {
                routes: self.clone(),
                request_id,
                serial,
            },
            receiver,
        )
    }

    /// Delivers one stream frame to its upload worker.
    ///
    /// Routes are filled with `try_send`: the server never has more than the window plus the
    /// terminal frame outstanding, so a full queue is a protocol violation that fails only
    /// this upload while the reader keeps serving every other stream.
    pub(crate) async fn route_chunk(
        &self,
        chunk: StreamChunk,
        control: &ControlSender,
        results: &ResultLedger,
    ) {
        let request_id = chunk.request_id;
        let route = self
            .table()
            .routes
            .get(&request_id)
            .map(|route| (route.serial, route.path.clone(), route.chunks.clone()));
        let Some((serial, path, chunks)) = route else {
            return;
        };
        match chunks.try_send(chunk) {
            Ok(()) => return,
            Err(mpsc::error::TrySendError::Full(_)) => {
                log!(
                    Level::Warning,
                    "Upload exceeded its flow-control credit: request_id={}, path={}",
                    request_id,
                    path
                );
                // Unrouting closes the worker's queue; it fails with its own response.
                let _ = self.remove(request_id, serial);
                return;
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
        // A worker unroutes itself before it stops reading and answers on its own; only a
        // worker that vanished while still routed (an abnormal exit) needs an answer here.
        if !self.remove(request_id, serial) {
            return;
        }
        log!(
            Level::Warning,
            "Upload worker dropped before chunk delivery: request_id={}, path={}",
            request_id,
            path
        );
        let _ = Responder::new(control.clone(), results.clone(), request_id)
            .respond(CommandOutcome::error(
                CommandErrorKind::Internal,
                "Upload worker is no longer available",
            ))
            .await;
    }

    /// Removes a route only if it is still the registration identified by `serial`; returns
    /// whether it was.
    fn remove(&self, request_id: RequestId, serial: u64) -> bool {
        let mut table = self.table();
        let current = table
            .routes
            .get(&request_id)
            .is_some_and(|route| route.serial == serial);
        if current {
            table.routes.remove(&request_id);
        }
        current
    }

    /// Registers the waiter for the router's publication decision.
    fn await_publication(&self, request_id: RequestId) -> oneshot::Receiver<bool> {
        let (sender, receiver) = oneshot::channel();
        self.table().publication_replies.insert(request_id, sender);
        receiver
    }

    /// Drops a publication waiter that finished or gave up.
    fn forget_publication(&self, request_id: RequestId) {
        self.table().publication_replies.remove(&request_id);
    }

    /// Delivers the router's decision only to the worker that still waits for it.
    pub(crate) fn resolve_publication(&self, request_id: RequestId, allowed: bool) {
        if let Some(sender) = self.table().publication_replies.remove(&request_id) {
            let _ = sender.send(allowed);
        }
    }

    /// Detaches every route when the connection is lost; workers observe closed queues.
    pub(crate) fn clear(&self) {
        let mut table = self.table();
        table.routes.clear();
        table.publication_replies.clear();
    }

    /// Reports whether a route exists, for lifecycle tests.
    #[cfg(test)]
    pub(crate) fn contains(&self, request_id: RequestId) -> bool {
        self.table().routes.contains_key(&request_id)
    }
}

/// Removes its chunk route when the upload worker finishes.
pub(crate) struct RouteGuard {
    routes: UploadRoutes,
    request_id: RequestId,
    serial: u64,
}

impl Drop for RouteGuard {
    /// Unroutes this worker without disturbing a newer route for the same id.
    fn drop(&mut self) {
        let _ = self.routes.remove(self.request_id, self.serial);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cancel::CancelRegistry;

    /// Records lifecycle calls and whether the request was still routed and registered.
    struct RecordingSink {
        events: Arc<Mutex<Vec<String>>>,
        routes: UploadRoutes,
        registry: CancelRegistry<RequestId>,
        request_id: RequestId,
        /// When set, `abort` reports that it started and then waits to be released, modelling
        /// slow staging cleanup.
        slow_abort: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    }

    impl RecordingSink {
        /// Notes one lifecycle step along with the registration state observed at that moment.
        fn record(&self, step: &str) {
            let state = format!(
                "{step} routed={} registered={}",
                self.routes.contains(self.request_id),
                self.registry.contains(&self.request_id)
            );
            self.events.lock().unwrap().push(state);
        }
    }

    impl UploadSink for RecordingSink {
        /// Records a staged chunk.
        async fn write(
            &mut self,
            _data: Bytes,
            _cancel: &CancellationToken,
        ) -> Result<(), SinkError> {
            self.record("write");
            Ok(())
        }

        /// Records publication and reports success.
        async fn commit(self, _gate: PublicationGate<'_>) -> Result<(), AgentCommandError> {
            self.record("commit");
            Ok(())
        }

        /// Records staging cleanup, optionally stalling until the test releases it.
        async fn abort(mut self) {
            self.record("abort");
            if let Some((started, release)) = self.slow_abort.take() {
                let _ = started.send(());
                let _ = release.await;
            }
        }
    }

    /// Fixture wiring a registered request, a recording sink and a frame receiver.
    struct Harness {
        events: Arc<Mutex<Vec<String>>>,
        registry: CancelRegistry<RequestId>,
        routes: UploadRoutes,
        frames: mpsc::Receiver<crate::runtime::responder::OutboundFrame>,
        task: tokio::task::JoinHandle<Result<(), CommandError>>,
    }

    /// Starts a raw-upload driver over a recording sink.
    fn start() -> Harness {
        start_with(None)
    }

    /// Starts a raw-upload driver whose sink may stall in `abort`.
    fn start_with(slow_abort: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>) -> Harness {
        let request_id = RequestId::new(5);
        let (mut ctx, frames) = CommandCtx::detached(request_id);
        let registry = CancelRegistry::new(None);
        let registration = registry.register(request_id).unwrap();
        ctx.cancel = registration.token().clone();
        ctx.registration = Some(registration);
        let routes = ctx.services.upload_routes.clone();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = RecordingSink {
            events: events.clone(),
            routes: routes.clone(),
            registry: registry.clone(),
            request_id,
            slow_abort,
        };
        let task = tokio::spawn(
            UploadDriver::new(UploadKind::RawUpload, "/tmp/dest".to_string(), ctx).run(Ok(sink)),
        );
        Harness {
            events,
            registry,
            routes,
            frames,
            task,
        }
    }

    /// Builds one data chunk of the upload under test as the connection reader parses it.
    fn frame(is_last: bool) -> StreamChunk {
        StreamChunk::data(RequestId::new(5), b"bytes".to_vec(), is_last)
    }

    /// Verifies the cancel ordering: abort staging, unregister, then answer.
    #[tokio::test]
    async fn cancel_aborts_before_unregistering_and_answering() {
        let mut harness = start();
        let ready = harness.frames.recv().await.unwrap();
        // The first credit grant (readiness) is sent only once the route exists.
        assert!(matches!(
            ready.as_message(),
            Some(redoor_protocol::wire::AgentToServer::Credit { .. })
        ));

        harness.registry.cancel_with_reason(
            &RequestId::new(5),
            redoor_protocol::wire::partials::CancelReason::Canceled,
        );
        let result = harness.task.await.unwrap();

        // Staging is discarded after unrouting but while the request is still cancelable.
        assert_eq!(
            *harness.events.lock().unwrap(),
            vec!["abort routed=false registered=true".to_string()]
        );
        // The terminal response follows unregistration so late cancels become harmless.
        assert!(!harness.registry.contains(&RequestId::new(5)));
        assert!(!harness.routes.contains(RequestId::new(5)));
        // Cancellation keeps its established user-facing classification.
        assert!(matches!(
            result,
            Err(CommandError { kind: CommandErrorKind::Canceled, message }) if message == "Upload canceled by server"
        ));
    }

    /// A slow abort must not stall the connection reader on this worker's full queue, and the
    /// reader must not answer for a worker that answers itself.
    #[tokio::test]
    async fn slow_abort_neither_blocks_the_reader_nor_double_answers() {
        let (started, abort_started) = oneshot::channel();
        let (release, abort_release) = oneshot::channel();
        let mut harness = start_with(Some((started, abort_release)));
        harness.frames.recv().await.unwrap();
        harness.registry.cancel_with_reason(
            &RequestId::new(5),
            redoor_protocol::wire::partials::CancelReason::Canceled,
        );
        abort_started.await.unwrap();
        let (control, mut control_frames) = mpsc::channel(4);
        // More frames than the queue holds: with the route still registered the reader would
        // report a credit violation for a worker that is busy aborting.
        for _ in 0..=CHUNK_QUEUE_CAPACITY {
            harness
                .routes
                .route_chunk(frame(false), &control, &ResultLedger::default())
                .await;
        }
        let _ = release.send(());
        let result = harness.task.await.unwrap();
        // The worker's own cancellation result is the only answer.
        assert!(matches!(result, Err(CommandError { .. })));
        assert!(control_frames.try_recv().is_err());
    }

    /// Verifies publication runs while a `cancel` can still reach the gate.
    #[tokio::test]
    async fn terminal_chunk_commits_while_still_registered() {
        let mut harness = start();
        harness.frames.recv().await.unwrap();
        let (control, _control_frames) = mpsc::channel(1);

        harness
            .routes
            .route_chunk(frame(true), &control, &ResultLedger::default())
            .await;
        let result = harness.task.await.unwrap();

        // Publication runs while a `cancel` can still reach the publication gate.
        assert_eq!(
            *harness.events.lock().unwrap(),
            vec![
                "write routed=true registered=true".to_string(),
                "commit routed=true registered=true".to_string()
            ]
        );
        // Success releases both registrations before the response is sent.
        assert!(!harness.registry.contains(&RequestId::new(5)));
        assert!(matches!(result, Ok(())));
    }

    /// A route never makes the reader wait: overflow unroutes only that upload.
    #[tokio::test]
    async fn route_overflow_fails_only_that_upload() {
        let routes = UploadRoutes::default();
        let (control, _control_frames) = mpsc::channel(1);
        let (_guard, mut chunks) = routes.open(RequestId::new(5), "/stalled");
        let (_other_guard, mut other_chunks) = routes.open(RequestId::new(6), "/other");
        for _ in 0..CHUNK_QUEUE_CAPACITY {
            routes
                .route_chunk(frame(false), &control, &ResultLedger::default())
                .await;
        }
        // The queue is full and the worker is stalled; this frame exceeds any honest credit.
        routes
            .route_chunk(frame(false), &control, &ResultLedger::default())
            .await;
        // The violating upload is unrouted so its worker fails instead of the socket stalling.
        assert!(!routes.contains(RequestId::new(5)));
        let mut queued = 0;
        while chunks.recv().await.is_some() {
            queued += 1;
        }
        // Frames accepted before the violation are still delivered, then the queue closes.
        assert_eq!(queued, CHUNK_QUEUE_CAPACITY);
        let mut other = frame(false);
        other.request_id = RequestId::new(6);
        routes
            .route_chunk(other, &control, &ResultLedger::default())
            .await;
        // An unrelated upload on the same socket keeps receiving frames.
        assert_eq!(
            other_chunks.recv().await.map(|chunk| chunk.request_id),
            Some(RequestId::new(6))
        );
    }
}
