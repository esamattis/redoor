//! Per-stream writer for framed agent-to-server byte streams.

use crate::runtime::responder::{ControlSender, OutboundFrame};
use redoor_core::stream_credit::CreditGate;
use redoor_protocol::{
    ids::RequestId,
    wire::{
        AgentToServer,
        stream::{STREAM_CREDIT_WINDOW_FRAMES, StreamChunk},
    },
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Credit gates of the output streams currently writing, keyed by request id.
///
/// The server returns credit as control frames while the writer runs in its own task, so
/// grants are delivered through this shared table instead of the worker's own state.
#[derive(Clone, Default)]
pub(crate) struct OutputCredits {
    gates: Arc<Mutex<OutputCreditTable>>,
}

/// Gates plus the serial that keeps a finished writer from removing a newer registration.
#[derive(Default)]
struct OutputCreditTable {
    gates: HashMap<RequestId, (u64, CreditGate)>,
    next_serial: u64,
}

impl OutputCredits {
    /// Locks the table, tolerating poison because every operation leaves it consistent.
    fn table(&self) -> std::sync::MutexGuard<'_, OutputCreditTable> {
        self.gates
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Registers a fresh full-window gate for one request or log stream; dropping the result
    /// removes it.
    pub(crate) fn register(&self, request_id: RequestId) -> CreditRegistration {
        self.register_with_window(request_id, STREAM_CREDIT_WINDOW_FRAMES)
    }

    /// Registers a gate with a stream-specific window (terminals use a larger one).
    pub(crate) fn register_with_window(
        &self,
        request_id: RequestId,
        window: u32,
    ) -> CreditRegistration {
        let gate = CreditGate::with_window(window);
        let mut table = self.table();
        table.next_serial = table.next_serial.wrapping_add(1);
        let serial = table.next_serial;
        table.gates.insert(request_id, (serial, gate.clone()));
        CreditRegistration {
            credits: self.clone(),
            request_id,
            serial,
            gate,
        }
    }

    /// Applies a server grant; grants for streams that already ended are ignored.
    pub(crate) fn grant(&self, request_id: RequestId, frames: u32) {
        if let Some((_, gate)) = self.table().gates.get(&request_id) {
            gate.grant(frames);
        }
    }

    /// Reports whether a stream is registered, for lifecycle tests.
    #[cfg(test)]
    pub(crate) fn contains(&self, request_id: RequestId) -> bool {
        self.table().gates.contains_key(&request_id)
    }
}

/// One output stream's credit gate, unregistered (and closed) when the writer is dropped.
pub(crate) struct CreditRegistration {
    credits: OutputCredits,
    request_id: RequestId,
    serial: u64,
    gate: CreditGate,
}

impl Drop for CreditRegistration {
    /// Removes only this registration so a reused request id keeps its own gate.
    fn drop(&mut self) {
        let mut table = self.credits.table();
        if table
            .gates
            .get(&self.request_id)
            .is_some_and(|(serial, _)| *serial == self.serial)
        {
            table.gates.remove(&self.request_id);
        }
        self.gate.close();
    }
}

/// Frames one stream's output onto the connection's lane in order.
///
/// Every outbound payload frame of downloads, exec output and log streams leaves through
/// [`StreamWriter::send_chunk`], which is also where the per-stream credit gate sits: a
/// non-terminal frame is sent only after spending one frame of credit, so a slow consumer on
/// the server stalls only this writer.
pub(crate) struct StreamWriter {
    lane: ControlSender,
    request_id: RequestId,
    frames_sent: u64,
    /// Credit granted by the server for this stream.
    credit: CreditRegistration,
}

impl StreamWriter {
    /// Starts a stream on `lane` (bulk for transfers and logs, interactive for terminals).
    pub(crate) fn new(
        lane: ControlSender,
        request_id: RequestId,
        credit: CreditRegistration,
    ) -> Self {
        Self {
            lane,
            request_id,
            frames_sent: 0,
            credit,
        }
    }

    /// Builds a writer with its own full credit window, for tests that do not exercise grants.
    #[cfg(test)]
    pub(crate) fn for_test(lane: ControlSender, request_id: RequestId) -> Self {
        Self::new(
            lane,
            request_id,
            OutputCredits::default().register(request_id),
        )
    }

    /// Sends payload bytes; `is_last` marks the successful end of the stream.
    pub(crate) async fn send(&mut self, data: &[u8], is_last: bool) -> bool {
        for chunk in StreamChunk::split(self.request_id, data, is_last) {
            if !self.send_chunk(chunk).await {
                return false;
            }
        }
        true
    }

    /// Sends one empty, non-final frame.
    ///
    /// A command that validates its input before it streams sends this once validation
    /// passed, so the server can answer its HTTP client with a success status before the
    /// first data exists, while an early failure still becomes a proper error status.
    pub(crate) async fn send_ready(&mut self) -> bool {
        self.send_chunk(StreamChunk::data(self.request_id, Vec::new(), false))
            .await
    }

    /// The lane this stream's frames use, so its result can follow its data.
    pub(crate) fn lane(&self) -> &ControlSender {
        &self.lane
    }

    /// Sends one control message on this stream's lane, so it is written after the stream's
    /// queued data instead of overtaking it on the control lane.
    pub(crate) async fn send_message(&mut self, message: AgentToServer) -> bool {
        self.lane
            .send(OutboundFrame::message(message))
            .await
            .is_ok()
    }

    /// Number of frames written so far, for completion logs.
    pub(crate) fn frames_sent(&self) -> u64 {
        self.frames_sent
    }

    /// Spends credit for a non-terminal frame, then waits for room on the lane.
    ///
    /// Callers race these waits against cancellation, so neither a stalled consumer nor
    /// socket backpressure can hide a cancel request.
    async fn send_chunk(&mut self, chunk: StreamChunk) -> bool {
        if chunk.consumes_credit() && !self.credit.gate.acquire().await {
            return false;
        }
        if self.lane.send(OutboundFrame::stream(chunk)).await.is_err() {
            return false;
        }
        self.frames_sent += 1;
        tokio::task::yield_now().await;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::responder::OutboundFrame;
    use tokio::sync::mpsc;

    /// Collects the stream frames queued on a fake lane.
    fn drain(receiver: &mut mpsc::Receiver<OutboundFrame>) -> Vec<StreamChunk> {
        let mut chunks = Vec::new();
        while let Ok(frame) = receiver.try_recv() {
            chunks.extend(frame.as_stream().cloned());
        }
        chunks
    }

    /// A credited writer stops after its window, resumes on a grant and never waits for the
    /// terminal frame, so a stalled server consumer cannot block cancellation acknowledgements.
    #[tokio::test]
    async fn credited_writer_honors_window_and_exempts_terminal_frames() {
        let credits = OutputCredits::default();
        let request_id = RequestId::new(5);
        let (lane, mut receiver) = mpsc::channel(64);
        let mut writer = StreamWriter::new(lane, request_id, credits.register(request_id));
        for _ in 0..STREAM_CREDIT_WINDOW_FRAMES {
            assert!(writer.send(b"x", false).await);
        }
        let blocked = tokio::spawn(async move {
            let sent = writer.send(b"y", false).await;
            (writer, sent)
        });
        tokio::task::yield_now().await;
        // The window is spent, so the fifth data frame must wait for server credit.
        assert_eq!(
            drain(&mut receiver).len(),
            STREAM_CREDIT_WINDOW_FRAMES as usize
        );
        assert!(!blocked.is_finished());
        credits.grant(request_id, 1);
        let (mut writer, sent) = blocked.await.unwrap();
        // The grant releases exactly the waiting frame.
        assert!(sent);
        assert_eq!(drain(&mut receiver).len(), 1);
        // FIN is terminal and must go out without any credit left.
        assert!(writer.send(b"", true).await);
        let terminal = drain(&mut receiver);
        assert!(terminal.len() == 1 && terminal[0].is_last);
        drop(writer);
        // Dropping the writer unregisters its gate so late grants are ignored.
        assert!(!credits.contains(request_id));
    }
}
