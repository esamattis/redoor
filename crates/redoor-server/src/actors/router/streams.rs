//! The router-free data path: stream leases, per-connection stream tables and consumers.
//!
//! The router admits streams, tracks their lifecycle and handles cancellation, but payload
//! frames never pass through its mailbox. They travel directly between the connection's
//! session and the HTTP, copy, terminal or log consumers through the types here, so a 64 KiB
//! chunk costs no router messages; the router only hears the command's result (which follows
//! the stream's data on the connection) and credit violations. Every stream is credited, so the
//! connection reader never waits for a consumer and one stalled client cannot freeze the other
//! streams of its agent.

use crate::actors::lanes::ControlLanes;
use redoor_core::stream_credit::{CreditGate, CreditLedger};
use redoor_protocol::{
    ids::{AgentId, RequestId},
    wire::{
        ServerToAgent,
        command::CommandErrorKind,
        request::CommandError,
        stream::{StreamChunk, receive_queue_frames},
        terminal::TerminalServerMessage,
    },
};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, MutexGuard, OnceLock, PoisonError,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Message shown when an agent sends more frames than its credit allowed.
pub(crate) const CREDIT_VIOLATION: &str = "Agent exceeded the stream flow-control credit";

/// What a stream needs to reach its agent without asking the router.
#[derive(Clone, Debug)]
pub struct AgentLink {
    /// Lanes of the connection; credit grants use the priority lane so they never queue
    /// behind commands or data.
    control: ControlLanes,
}

impl AgentLink {
    /// Captures the lanes of one connection.
    pub(crate) fn new(control: ControlLanes) -> Self {
        Self { control }
    }

    /// The connection's lanes, for stream-scoped control frames (resizes, cancels).
    pub(crate) fn lanes(&self) -> &ControlLanes {
        &self.control
    }

    /// Returns credit for frames a consumer drained, waiting for priority-lane capacity so a
    /// grant is never lost (a lost grant would shrink the window for the rest of the stream).
    async fn grant(&self, request_id: RequestId, frames: u32) {
        let _ = self
            .control
            .send_priority(ServerToAgent::Credit {
                stream: request_id,
                frames,
            })
            .await;
    }
}

/// Router-issued handle for one admitted stream, shared by the router and the data path.
///
/// The router keeps a clone to cancel the stream and to read its progress; the data path
/// counts bytes into `bytes` and stops when `cancel` fires. No chunk ever has to go back to
/// the router to be accounted for.
#[derive(Clone, Debug)]
pub struct StreamLease {
    /// Request id the agent uses in the stream's frames.
    pub(crate) id: RequestId,
    /// Lanes of the agent at the other end of the stream.
    pub(crate) link: AgentLink,
    /// Stops the data path; frames for a cancelled stream are discarded.
    pub(crate) cancel: CancellationToken,
    /// Payload bytes accepted by the consumer (inbound) or the agent's lane (outbound).
    pub(crate) bytes: Arc<AtomicU64>,
    /// Inbound payload bytes the reader queued, including frames the consumer has not drained
    /// yet; the result follows the data, so this is the stream's full size when it arrives.
    received: Arc<AtomicU64>,
    /// Reason reported to the consumer when the router failed the stream.
    fault: Arc<OnceLock<CommandError>>,
}

impl StreamLease {
    /// Creates a lease whose byte counter starts at `initial_bytes` (resumed downloads).
    pub(crate) fn new(id: RequestId, link: AgentLink, initial_bytes: u64) -> Self {
        Self {
            id,
            link,
            cancel: CancellationToken::new(),
            bytes: Arc::new(AtomicU64::new(initial_bytes)),
            received: Arc::new(AtomicU64::new(0)),
            fault: Arc::new(OnceLock::new()),
        }
    }

    /// Stops the data path without reporting an error to the consumer.
    pub(crate) fn stop(&self) {
        self.cancel.cancel();
    }

    /// Stops the data path and makes the consumer observe `reason` as a stream error.
    pub(crate) fn fail(&self, reason: CommandError) {
        let _ = self.fault.set(reason);
        self.cancel.cancel();
    }

    /// Bytes accounted so far, read by the router when reporting progress.
    pub(crate) fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    /// Inbound bytes the reader queued for the consumer so far.
    pub(crate) fn received(&self) -> u64 {
        self.received.load(Ordering::Relaxed)
    }

    /// Failure reason set by [`StreamLease::fail`].
    fn fault(&self) -> Option<&CommandError> {
        self.fault.get()
    }
}

/// An inbound stream whose agent exceeded its credit: the only data-path event the router
/// sees, because a completed stream is followed by its result anyway.
#[derive(Debug)]
pub struct CreditViolation {
    /// Agent whose connection carried the stream.
    pub(crate) agent_id: AgentId,
    /// Stream that broke its credit and is no longer routed.
    pub(crate) request_id: RequestId,
}

/// One inbound stream as seen by the connection reader.
#[derive(Debug)]
struct InboundSlot {
    sender: mpsc::Sender<StreamChunk>,
    cancel: CancellationToken,
    /// The lease's queued-byte counter.
    received: Arc<AtomicU64>,
    /// The lease's failure reason, set here on a credit violation so the consumer reports it
    /// even if it drains the closed queue before the router hears about the violation.
    fault: Arc<OnceLock<CommandError>>,
}

/// The stream tables of one connection, shared by the router and the connection's session.
#[derive(Debug)]
struct StreamTables {
    agent_id: AgentId,
    inbound: Mutex<HashMap<RequestId, InboundSlot>>,
    outbound: Mutex<HashMap<RequestId, OutboundSlot>>,
    /// Lifecycle events of open terminals, delivered in their stream's frame order.
    terminal_events: Mutex<HashMap<RequestId, mpsc::Sender<TerminalServerMessage>>>,
}

/// How an outbound stream's credit starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutboundStart {
    /// The agent is ready at once (terminal input after its ready event).
    FullWindow,
    /// The agent grants the first window when its worker is ready (uploads).
    AwaitGrant,
}

/// Credit of one server-to-agent stream.
#[derive(Debug)]
struct OutboundSlot {
    gate: CreditGate,
    /// Whether the agent has granted credit yet; the first grant signals readiness.
    granted: bool,
}

/// Pending terminal lifecycle events per terminal; there are at most three (ready, exit or
/// error), so the queue never fills for an honest agent.
const TERMINAL_EVENT_QUEUE: usize = 4;

/// Per-control-session routing for payload streams, used without the router actor.
///
/// Created by the session at registration and stored in the router's connection entry.
#[derive(Clone, Debug)]
pub struct ConnectionStreams {
    tables: Arc<StreamTables>,
}

impl ConnectionStreams {
    /// Creates empty tables for one agent connection.
    pub fn new(agent_id: AgentId) -> Self {
        Self {
            tables: Arc::new(StreamTables {
                agent_id,
                inbound: Mutex::new(HashMap::new()),
                outbound: Mutex::new(HashMap::new()),
                terminal_events: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Locks the inbound table, tolerating poison because every operation leaves it valid.
    fn inbound(&self) -> MutexGuard<'_, HashMap<RequestId, InboundSlot>> {
        self.tables
            .inbound
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Locks the outbound table, tolerating poison because every operation leaves it valid.
    fn outbound(&self) -> MutexGuard<'_, HashMap<RequestId, OutboundSlot>> {
        self.tables
            .outbound
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens an inbound stream with `window` frames of credit and returns its consumer.
    ///
    /// Must happen before the command is sent so no frame can arrive unroutable. The queue
    /// holds the credit window plus the terminal frame, so an honest agent never overflows it.
    pub(crate) fn open_inbound(&self, lease: StreamLease, window: u32) -> OutputReceiver {
        let (sender, chunks) = mpsc::channel(receive_queue_frames(window));
        self.inbound().insert(
            lease.id,
            InboundSlot {
                sender,
                cancel: lease.cancel.clone(),
                received: lease.received.clone(),
                fault: lease.fault.clone(),
            },
        );
        OutputReceiver {
            chunks,
            lease,
            ledger: CreditLedger::default(),
            owed_credit: 0,
            fault_reported: false,
        }
    }

    /// Removes an inbound stream; its consumer sees the end after draining queued frames.
    pub(crate) fn close_inbound(&self, request_id: RequestId) {
        self.inbound().remove(&request_id);
    }

    /// Registers credit for an outbound stream with `window` frames.
    ///
    /// Upload streams start with no credit: the agent grants the first window once its
    /// worker is ready, and that first grant is also the readiness signal.
    pub(crate) fn open_outbound(
        &self,
        request_id: RequestId,
        window: u32,
        start: OutboundStart,
    ) -> CreditGate {
        let gate = match start {
            OutboundStart::FullWindow => CreditGate::with_window(window),
            OutboundStart::AwaitGrant => CreditGate::awaiting_grant(window),
        };
        self.outbound().insert(
            request_id,
            OutboundSlot {
                gate: gate.clone(),
                granted: start == OutboundStart::FullWindow,
            },
        );
        gate
    }

    /// Removes an outbound stream's credit and releases a producer waiting for it.
    pub(crate) fn close_outbound(&self, request_id: RequestId) {
        if let Some(slot) = self.outbound().remove(&request_id) {
            slot.gate.close();
        }
    }

    /// Applies credit returned by the agent; grants for finished streams are ignored.
    ///
    /// Returns `true` for the first grant of a stream that waited for it, which tells the
    /// router the agent's worker is ready.
    pub fn grant_outbound(&self, request_id: RequestId, frames: u32) -> bool {
        let mut outbound = self.outbound();
        let Some(slot) = outbound.get_mut(&request_id) else {
            return false;
        };
        slot.gate.grant(frames);
        !std::mem::replace(&mut slot.granted, true)
    }

    /// Opens the lifecycle event queue of terminal `request_id`.
    pub(crate) fn open_terminal_events(
        &self,
        request_id: RequestId,
    ) -> mpsc::Receiver<TerminalServerMessage> {
        let (sender, events) = mpsc::channel(TERMINAL_EVENT_QUEUE);
        self.terminal_events().insert(request_id, sender);
        events
    }

    /// Delivers one terminal lifecycle event; events of unknown or closed terminals are
    /// dropped, and a flooding agent cannot make the reader wait.
    pub fn deliver_terminal_event(&self, request_id: RequestId, event: TerminalServerMessage) {
        if let Some(events) = self.terminal_events().get(&request_id) {
            let _ = events.try_send(event);
        }
    }

    /// Forgets every table entry of one stream (terminals and log streams end this way).
    pub(crate) fn close(&self, request_id: RequestId) {
        self.close_inbound(request_id);
        self.close_outbound(request_id);
        self.terminal_events().remove(&request_id);
    }

    /// Locks the terminal event table, tolerating poison because every operation leaves it
    /// valid.
    fn terminal_events(
        &self,
    ) -> MutexGuard<'_, HashMap<RequestId, mpsc::Sender<TerminalServerMessage>>> {
        self.tables
            .terminal_events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Ends every stream of this connection because it is gone.
    pub(crate) fn clear(&self) {
        self.inbound().clear();
        for (_, slot) in self.outbound().drain() {
            slot.gate.close();
        }
        self.terminal_events().clear();
    }

    /// Hands one frame from the connection to its stream's consumer.
    ///
    /// Streams are filled with `try_send` and never make the reader wait; a full queue means
    /// the agent ignored its credit, which fails that stream only and is the one event the
    /// router has to hear about. Frames of stopped streams are discarded. `FIN` ends routing
    /// of the stream; its result follows on the connection and settles it in the router.
    pub(crate) fn deliver(&self, chunk: StreamChunk) -> Option<CreditViolation> {
        let request_id = chunk.request_id;
        let (sender, cancel, fault) = {
            let mut inbound = self.inbound();
            let slot = inbound.get_mut(&request_id)?;
            slot.received
                .fetch_add(chunk.data.len() as u64, Ordering::Relaxed);
            let route = (slot.sender.clone(), slot.cancel.clone(), slot.fault.clone());
            if chunk.is_last {
                // Nothing may follow FIN, so the stream stops being routable.
                inbound.remove(&request_id);
            }
            route
        };
        if cancel.is_cancelled() {
            return None;
        }
        match sender.try_send(chunk) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => None,
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Closing the queue lets the consumer reach its end, so the fault must already
                // be set: the router fails the lease only after it receives the violation.
                let _ = fault.set(CommandError::new(
                    CommandErrorKind::Internal,
                    CREDIT_VIOLATION,
                ));
                self.close_inbound(request_id);
                Some(CreditViolation {
                    agent_id: self.tables.agent_id.clone(),
                    request_id,
                })
            }
        }
    }
}

/// Consumer end of one inbound stream (download or exec output, or a copy source).
///
/// Counts drained bytes for progress and returns credit as frames are drained, so the agent
/// can only run ahead of this consumer by the credit window.
#[derive(Debug)]
pub struct OutputReceiver {
    chunks: mpsc::Receiver<StreamChunk>,
    lease: StreamLease,
    ledger: CreditLedger,
    /// Credit earned by drained frames but not yet returned to the agent.
    owed_credit: u32,
    fault_reported: bool,
}

impl OutputReceiver {
    /// Request id of the stream, used by consumers to arm cancellation.
    pub fn request_id(&self) -> RequestId {
        self.lease.id
    }

    /// Receives the next frame, or `None` when the stream ended or was stopped.
    ///
    /// Already queued frames are drained before a stop is observed, so output accepted before
    /// a cancellation is not lost. A stream the router failed (the agent's result was an
    /// error, or it broke its credit) yields `Err` with the reason once before ending, so
    /// consumers never mistake a failed stream for a short one.
    ///
    /// Cancel safe: credit owed for drained frames is returned before waiting for the next
    /// frame, and nothing is awaited after a frame was dequeued, so dropping this future (for
    /// example in a `select!`) never loses a frame or a grant.
    pub async fn recv(&mut self) -> Option<Result<StreamChunk, CommandError>> {
        if self.owed_credit > 0 {
            self.lease.link.grant(self.lease.id, self.owed_credit).await;
            self.owed_credit = 0;
        }
        let chunk = tokio::select! {
            biased;
            chunk = self.chunks.recv() => chunk,
            _ = self.lease.cancel.cancelled() => None,
        };
        let Some(chunk) = chunk else {
            return self.take_fault().map(Err);
        };
        self.lease
            .bytes
            .fetch_add(chunk.data.len() as u64, Ordering::Relaxed);
        if let Some(frames) = self.ledger.drained(chunk.consumes_credit()) {
            self.owed_credit += frames;
        }
        Some(Ok(chunk))
    }

    /// Returns a router-reported failure once, after the queued frames were drained.
    fn take_fault(&mut self) -> Option<CommandError> {
        if self.fault_reported {
            return None;
        }
        let message = self.lease.fault()?.clone();
        self.fault_reported = true;
        Some(message)
    }
}

#[cfg(test)]
impl ConnectionStreams {
    /// Opens an inbound stream on a detached link so consumer tests need no router.
    pub(crate) fn open_detached(&self, request_id: RequestId) -> OutputReceiver {
        let link = AgentLink::new(ControlLanes::bounded(1, 1).0);
        self.open_inbound(
            StreamLease::new(request_id, link, 0),
            redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES,
        )
    }
}

/// Why an outbound frame was not sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboundError {
    /// The router stopped the stream (cancellation, teardown or completion).
    Stopped,
    /// The agent's connection is gone.
    LaneClosed,
}

/// Producer end of one server-to-agent stream (upload, edit, copy destination or terminal
/// input).
///
/// Sends directly onto the connection's bulk or interactive lane, spending per-stream credit
/// so a slow destination worker stalls only this stream. A producer that has to give up never
/// sends an error frame: the router cancels the agent's worker, whose result settles the flow.
#[derive(Clone, Debug)]
pub struct OutboundStream {
    lease: StreamLease,
    lane: mpsc::Sender<StreamChunk>,
    credit: CreditGate,
}

impl OutboundStream {
    /// Binds a lease to its lane class and the stream's credit gate.
    pub(crate) fn new(lease: StreamLease, credit: CreditGate, interactive: bool) -> Self {
        let lane = lease.link.control.data(interactive).clone();
        Self {
            lease,
            lane,
            credit,
        }
    }

    /// Request id of the stream, used by producers to arm cancellation.
    pub fn request_id(&self) -> RequestId {
        self.lease.id
    }

    /// The lease shared with the router.
    pub(crate) fn lease(&self) -> &StreamLease {
        &self.lease
    }

    /// Splits one logical payload into frames and sends them in order.
    pub(crate) async fn send_data(&self, data: &[u8], is_last: bool) -> Result<(), OutboundError> {
        for chunk in StreamChunk::split(self.lease.id, data, is_last) {
            self.send(chunk).await?;
        }
        Ok(())
    }

    /// Sends one frame, waiting for credit (non-terminal frames) and lane capacity while
    /// staying responsive to the router stopping the stream.
    pub(crate) async fn send(&self, chunk: StreamChunk) -> Result<(), OutboundError> {
        let cancel = &self.lease.cancel;
        if cancel.is_cancelled() {
            return Err(OutboundError::Stopped);
        }
        if chunk.consumes_credit() {
            let acquired = tokio::select! {
                biased;
                _ = cancel.cancelled() => false,
                acquired = self.credit.acquire() => acquired,
            };
            if !acquired {
                return Err(OutboundError::Stopped);
            }
        }
        let bytes = chunk.data.len() as u64;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(OutboundError::Stopped),
            result = self.lane.send(chunk) => result.map_err(|_| OutboundError::LaneClosed)?,
        }
        self.lease.bytes.fetch_add(bytes, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES;

    /// Builds a session's tables plus the priority lane its credit grants use.
    fn session() -> (ConnectionStreams, AgentLink, mpsc::Receiver<ServerToAgent>) {
        let (lanes, receivers) = ControlLanes::bounded(16, 16);
        let agent = redoor_core::test_support::test_agent_id("agent");
        (
            ConnectionStreams::new(agent.clone()),
            AgentLink::new(lanes),
            receivers.priority,
        )
    }

    /// Builds one data or terminal frame of `request_id`.
    fn frame(request_id: u64, is_last: bool) -> StreamChunk {
        StreamChunk::data(RequestId::new(request_id), vec![7; 16], is_last)
    }

    /// A stalled consumer must not stall the reader: other streams keep flowing, and a frame
    /// beyond the credit window fails only the violating stream.
    #[tokio::test]
    async fn stalled_consumer_does_not_block_other_streams() {
        let (streams, link, _grants) = session();
        let _stalled = streams.open_inbound(
            StreamLease::new(RequestId::new(1), link.clone(), 0),
            STREAM_CREDIT_WINDOW_FRAMES,
        );
        let mut live = streams.open_inbound(
            StreamLease::new(RequestId::new(2), link, 0),
            STREAM_CREDIT_WINDOW_FRAMES,
        );
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES {
            // Frames within the window are queued without waiting for the consumer.
            assert!(streams.deliver(frame(1, false)).is_none());
        }
        // FIN has its reserved slot even with the window full.
        assert!(streams.deliver(frame(1, true)).is_none());
        // The reader returned for every frame above, so another stream is still served.
        assert!(streams.deliver(frame(2, false)).is_none());
        assert_eq!(
            live.recv().await.unwrap().unwrap().request_id,
            RequestId::new(2)
        );
    }

    /// An agent ignoring its credit fails only its own stream.
    #[tokio::test]
    async fn credit_overflow_fails_only_the_violating_stream() {
        let (streams, link, _grants) = session();
        let _stalled = streams.open_inbound(
            StreamLease::new(RequestId::new(1), link, 0),
            STREAM_CREDIT_WINDOW_FRAMES,
        );
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES + 1 {
            assert!(streams.deliver(frame(1, false)).is_none());
        }
        let violation = streams.deliver(frame(1, false)).unwrap();
        // The violation names the stream so the router can fail it and stop its worker.
        assert_eq!(violation.request_id, RequestId::new(1));
        // The violating stream is no longer routed, so later frames are ignored.
        assert!(streams.deliver(frame(1, true)).is_none());
    }

    /// A consumer draining a violating stream before the router handles the violation must
    /// still end with the error, never with a clean end that looks like a short stream.
    #[tokio::test]
    async fn credit_overflow_reports_error_before_router_fails_stream() {
        let (streams, link, _grants) = session();
        let mut receiver = streams.open_inbound(
            StreamLease::new(RequestId::new(7), link, 0),
            STREAM_CREDIT_WINDOW_FRAMES,
        );
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES + 1 {
            streams.deliver(frame(7, false));
        }
        assert!(streams.deliver(frame(7, false)).is_some());
        let mut last = None;
        while let Some(item) = receiver.recv().await {
            last = Some(item);
        }
        // The violation is reported after the queued frames without any router involvement.
        assert_eq!(
            last,
            Some(Err(CommandError::new(
                CommandErrorKind::Internal,
                CREDIT_VIOLATION
            )))
        );
    }

    /// Nothing may follow FIN, so a stream stops being routed once FIN was delivered, and the
    /// lease counts every queued byte for the result that follows.
    #[tokio::test]
    async fn fin_ends_routing_and_counts_queued_bytes() {
        let (streams, link, _grants) = session();
        let lease = StreamLease::new(RequestId::new(6), link, 0);
        let mut receiver = streams.open_inbound(lease.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        streams.deliver(frame(6, false));
        streams.deliver(frame(6, true));
        // The router completes downloads with this count before the consumer drained them.
        assert_eq!(lease.received(), 32);
        // A frame after FIN is not routed to the finished consumer.
        assert!(streams.deliver(frame(6, false)).is_none());
        assert!(!receiver.recv().await.unwrap().unwrap().is_last);
        assert!(receiver.recv().await.unwrap().unwrap().is_last);
        // The consumer sees the end right after FIN instead of the stray frame.
        assert!(receiver.recv().await.is_none());
    }

    /// Draining returns credit in batches on the priority lane and counts drained bytes.
    #[tokio::test]
    async fn draining_grants_credit_and_counts_bytes() {
        let (streams, link, mut grants) = session();
        let lease = StreamLease::new(RequestId::new(3), link, 0);
        let mut receiver = streams.open_inbound(lease.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        streams.deliver(frame(3, false));
        streams.deliver(frame(3, false));
        receiver.recv().await.unwrap().unwrap();
        receiver.recv().await.unwrap().unwrap();
        // The batch is returned when the consumer asks for more, before it waits again.
        assert!(grants.try_recv().is_err());
        let next = tokio::spawn(async move { receiver.recv().await });
        // Two drained frames complete one batch, returned for this stream on the control lane.
        assert!(matches!(
            grants.recv().await,
            Some(ServerToAgent::Credit { stream, frames: 2 }) if stream == RequestId::new(3)
        ));
        // Progress counts what the consumer drained, not what the reader merely queued.
        assert_eq!(lease.bytes(), 32);
        next.abort();
    }

    /// Stopped streams discard payload and end for the consumer.
    #[tokio::test]
    async fn stopped_stream_discards_payload() {
        let (streams, link, _grants) = session();
        let lease = StreamLease::new(RequestId::new(4), link, 0);
        let mut receiver = streams.open_inbound(lease.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        lease.stop();
        // Frames of a stopped stream are dropped without involving the router.
        assert!(streams.deliver(frame(4, false)).is_none());
        assert!(streams.deliver(frame(4, true)).is_none());
        // The consumer sees the end instead of the discarded frames.
        assert!(receiver.recv().await.is_none());
    }

    /// A failed stream reports its reason once to the consumer.
    #[tokio::test]
    async fn failed_stream_yields_reason_once() {
        let (streams, link, _grants) = session();
        let lease = StreamLease::new(RequestId::new(5), link, 0);
        let mut receiver = streams.open_inbound(lease.clone(), STREAM_CREDIT_WINDOW_FRAMES);
        lease.fail(CommandError::new(
            CommandErrorKind::Internal,
            "Agent disconnected",
        ));
        // Consumers need a real error, not a silently truncated body.
        assert_eq!(
            receiver.recv().await,
            Some(Err(CommandError::new(
                CommandErrorKind::Internal,
                "Agent disconnected"
            )))
        );
        assert!(receiver.recv().await.is_none());
    }

    /// The first grant of an upload stream is its readiness signal, later grants are not, and
    /// a producer cannot send before it.
    #[tokio::test]
    async fn upload_waits_for_first_grant() {
        let streams = ConnectionStreams::new(redoor_core::test_support::test_agent_id("agent"));
        let (lanes, mut receivers) = ControlLanes::bounded(1, 1);
        let lease = StreamLease::new(RequestId::new(8), AgentLink::new(lanes), 0);
        let outbound = OutboundStream::new(
            lease.clone(),
            streams.open_outbound(
                lease.id,
                STREAM_CREDIT_WINDOW_FRAMES,
                OutboundStart::AwaitGrant,
            ),
            false,
        );
        let blocked = tokio::spawn({
            let outbound = outbound.clone();
            async move { outbound.send(frame(8, false)).await }
        });
        tokio::task::yield_now().await;
        // Without the agent's grant its worker may not exist yet, so nothing is sent.
        assert!(!blocked.is_finished());
        // The first grant tells the router the worker is ready.
        assert!(streams.grant_outbound(lease.id, STREAM_CREDIT_WINDOW_FRAMES));
        assert_eq!(blocked.await.unwrap(), Ok(()));
        assert!(receivers.bulk.recv().await.is_some());
        // Later grants are plain credit.
        assert!(!streams.grant_outbound(lease.id, 1));
    }

    /// Outbound frames spend credit, terminal frames do not, and the router can stop a
    /// producer waiting for credit.
    #[tokio::test]
    async fn outbound_stream_spends_credit_and_stops_promptly() {
        let streams = ConnectionStreams::new(redoor_core::test_support::test_agent_id("agent"));
        let (lanes, mut receivers) = ControlLanes::bounded(1, 1);
        let lease = StreamLease::new(RequestId::new(7), AgentLink::new(lanes), 0);
        let outbound = OutboundStream::new(
            lease.clone(),
            streams.open_outbound(
                lease.id,
                STREAM_CREDIT_WINDOW_FRAMES,
                OutboundStart::FullWindow,
            ),
            false,
        );
        // Drains the one-slot bulk lane in the background so only credit limits the producer.
        let drain = tokio::spawn(async move { while receivers.bulk.recv().await.is_some() {} });
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES {
            outbound.send(frame(7, false)).await.unwrap();
        }
        // The terminal frame never waits for credit.
        outbound.send(frame(7, true)).await.unwrap();
        let blocked = tokio::spawn({
            let outbound = outbound.clone();
            async move { outbound.send(frame(7, false)).await }
        });
        tokio::task::yield_now().await;
        // With the window spent, the producer waits for the agent's grant.
        assert!(!blocked.is_finished());
        streams.grant_outbound(RequestId::new(7), 1);
        assert_eq!(blocked.await.unwrap(), Ok(()));
        let blocked = tokio::spawn({
            let outbound = outbound.clone();
            async move { outbound.send(frame(7, false)).await }
        });
        lease.stop();
        // Cancellation releases a producer stuck on credit instead of leaking it.
        assert_eq!(blocked.await.unwrap(), Err(OutboundError::Stopped));
        // Outbound progress counts bytes the lane accepted: the window, FIN and the granted
        // frame, but not the canceled one.
        assert_eq!(lease.bytes(), 16 * (STREAM_CREDIT_WINDOW_FRAMES as u64 + 2));
        drain.abort();
    }
}
