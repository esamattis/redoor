//! One terminal session: the task that owns a shell's PTY, mirrors its output and serves at
//! most one attachment.
//!
//! The session belongs to the agent process, not to a connection, so the shell keeps running
//! while no server is connected and a restarted server can attach to it again. All state
//! changes happen inside the task's loop, so attaching, taking over and finishing are atomic
//! with respect to output: an attachment gets the snapshot of exactly the output fed before
//! it, then live output, with nothing lost or repeated.

use super::emulator::{MirrorFailed, MirrorPermit, MirrorSender, ScreenMirror};
use bytes::Bytes;
use libghostty_vt::terminal::CompressionMode;
use redoor_protocol::{
    api::terminals::TerminalSessionStatus,
    wire::terminal::{TerminalServerMessage, TerminalSessionRecord, TerminalSize},
};
use std::collections::VecDeque;
use std::future::Future;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::DropGuard;

/// Frames of input queued for the PTY. A full queue holds the attachment's input stream
/// back, which in turn holds the server back through credit.
pub(crate) const MAX_PENDING_INPUT_FRAMES: usize = 32;
/// Frames queued for an attachment. Output is only read from the PTY when a slot is free, so
/// a slow server or browser slows the shell instead of growing memory.
const VIEWER_QUEUE: usize = 16;
/// Commands queued for the session task.
const COMMAND_QUEUE: usize = 16;
/// Quiet time after output before a running session compacts its mirror.
const MIRROR_IDLE_COMPRESS: Duration = Duration::from_secs(5);
/// How long output may keep coming after the shell exited. The rest of the session's
/// processes are killed after the shell exits, which closes the PTY; a process that left the
/// session but kept the PTY open must not keep the session from finishing.
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a closed PTY waits for the shell's exit status. The PTY usually closes a moment
/// before the shell is reaped, and the status is what tells the user how it ended.
const EXIT_STATUS_TIMEOUT: Duration = Duration::from_secs(2);

/// The output side of a PTY, abstracted so the session can be tested without one.
pub(crate) trait PtyOutput: Send + 'static {
    /// Next chunk of output, `None` once the PTY is closed. Cancel safe.
    fn recv(&mut self) -> impl Future<Output = Option<Bytes>> + Send;
}

/// The input side of a PTY: keystrokes and resizes.
pub(crate) trait PtyInput: Clone + Send + Sync + 'static {
    /// Writes keystrokes, waiting while the PTY does not take them; `Err` once it is gone.
    fn send(&self, bytes: Bytes) -> impl Future<Output = Result<(), ()>> + Send;
    /// Resizes the PTY without waiting behind queued input.
    fn resize(&self, size: TerminalSize);
}

/// Everything a session needs from its shell.
pub(crate) struct PtyIo<O, I> {
    pub(crate) output: O,
    pub(crate) input: I,
    /// The shell's exit status, sent once when it exits.
    pub(crate) exit: oneshot::Receiver<TerminalServerMessage>,
    /// Kills the shell and its jobs when the session lets go of the PTY; `None` in tests.
    pub(crate) kill: Option<DropGuard>,
}

/// One item for an attachment, in the order it must be sent.
#[derive(Debug)]
pub(crate) enum ViewerFrame {
    Output(Bytes),
    Event(TerminalServerMessage),
}

/// Why the session let go of an attachment. Sent apart from the data channel, so it arrives
/// even when that channel is full of output a slow server has not taken yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DetachReason {
    /// Another attachment took the session over.
    TakenOver,
    /// The session was closed.
    Closed,
}

/// Keystrokes from one attachment, tagged so input from a replaced one can be dropped.
pub(crate) struct InputChunk {
    pub(crate) serial: u64,
    pub(crate) bytes: Bytes,
}

/// The attachment's end of the session.
pub(crate) struct AttachedViewer {
    /// Identifies this attachment in its later commands.
    pub(crate) serial: u64,
    pub(crate) frames: mpsc::Receiver<ViewerFrame>,
    pub(crate) reason: oneshot::Receiver<DetachReason>,
    /// Where keystrokes go; `None` when the shell is already gone.
    pub(crate) input: Option<mpsc::Sender<InputChunk>>,
}

/// Requests to the session task from the registry and attachments.
pub(crate) enum SessionCommand {
    Attach {
        size: TerminalSize,
        reply: oneshot::Sender<AttachedViewer>,
    },
    Detach {
        serial: u64,
    },
    Resize {
        serial: u64,
        size: TerminalSize,
    },
    /// Ends the session; `done` is answered after the attachment was told and the shell was
    /// told to stop.
    Close {
        done: oneshot::Sender<()>,
    },
}

/// The registry's handle to one session task.
#[derive(Clone)]
pub(crate) struct TerminalSessionHandle {
    commands: mpsc::Sender<SessionCommand>,
    record: watch::Receiver<TerminalSessionRecord>,
}

/// The session task is gone, which only happens once it was closed.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SessionGone;

impl TerminalSessionHandle {
    /// The session as reported to the server, read without involving the task.
    pub(crate) fn record(&self) -> TerminalSessionRecord {
        self.record.borrow().clone()
    }

    /// Follows the record, so tests can wait for a state instead of sleeping.
    #[cfg(test)]
    pub(crate) fn watch_record(&self) -> watch::Receiver<TerminalSessionRecord> {
        self.record.clone()
    }

    /// Attaches with `size`, taking the session over from any current attachment.
    pub(crate) async fn attach(&self, size: TerminalSize) -> Result<AttachedViewer, SessionGone> {
        let (reply, attached) = oneshot::channel();
        self.send(SessionCommand::Attach { size, reply }).await?;
        attached.await.map_err(|_| SessionGone)
    }

    /// Sends a command to the task.
    pub(crate) async fn send(&self, command: SessionCommand) -> Result<(), SessionGone> {
        self.commands.send(command).await.map_err(|_| SessionGone)
    }

    /// Queues a command without waiting, for drop paths; a full queue hands it to a task.
    pub(crate) fn send_detached(&self, command: SessionCommand) {
        if let Err(mpsc::error::TrySendError::Full(command)) = self.commands.try_send(command) {
            let commands = self.commands.clone();
            tokio::spawn(async move {
                let _ = commands.send(command).await;
            });
        }
    }

    /// Ends the session and waits until its attachment was told and the shell told to stop.
    pub(crate) async fn close(&self) {
        let (done, closed) = oneshot::channel();
        if self.send(SessionCommand::Close { done }).await.is_ok() {
            let _ = closed.await;
        }
    }
}

/// Where the session is in its life.
#[derive(Debug, Clone)]
enum Status {
    Running,
    /// The shell exited; its remaining output is still being drained.
    Exiting(TerminalServerMessage),
    /// The PTY is gone; this event is what every later attachment is told.
    Exited(TerminalServerMessage),
}

/// The current attachment as the session sees it.
struct Viewer {
    serial: u64,
    frames: mpsc::Sender<ViewerFrame>,
    reason: Option<oneshot::Sender<DetachReason>>,
}

impl Viewer {
    /// Tells the attachment why it was let go.
    fn release(mut self, reason: DetachReason) {
        if let Some(sender) = self.reason.take() {
            let _ = sender.send(reason);
        }
    }
}

/// The live PTY; dropped as a whole when the session finishes, which kills what is left of
/// the shell's processes.
struct LivePty<O, I> {
    output: O,
    input: I,
    /// Keystrokes for the forwarder; cloned into every attachment.
    input_queue: mpsc::Sender<InputChunk>,
    /// The size the PTY has, so a resize is sent only when it differs.
    pty_size: TerminalSize,
    _forwarder: AbortOnDrop,
    _kill: Option<DropGuard>,
}

/// Aborts a helper task when its owner is dropped.
struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What the output arm produced.
enum OutputStep {
    /// A chunk was read; the permits guarantee it can be fed and sent without waiting.
    Chunk {
        viewer: Option<mpsc::OwnedPermit<ViewerFrame>>,
        mirror: MirrorPermit,
        chunk: Option<Bytes>,
    },
    /// The attachment went away.
    ViewerGone,
    MirrorFailed,
}

/// Something that wants to hear when any session's record changes, so the server can be told.
pub(crate) type SessionsChanged = Arc<watch::Sender<()>>;

/// Creates a session task for a started shell and returns its handle.
pub(crate) fn spawn_session<O: PtyOutput, I: PtyInput>(
    record: TerminalSessionRecord,
    size: TerminalSize,
    io: PtyIo<O, I>,
    changed: SessionsChanged,
) -> TerminalSessionHandle {
    let (commands_tx, commands) = mpsc::channel(COMMAND_QUEUE);
    let (record_tx, record_rx) = watch::channel(record);
    let serial = Arc::new(AtomicU64::new(0));
    let (input_queue, input_chunks) = mpsc::channel(MAX_PENDING_INPUT_FRAMES);
    let forwarder = tokio::spawn(forward_input(
        io.input.clone(),
        input_chunks,
        serial.clone(),
    ));
    let mirror = ScreenMirror::spawn(size);
    let mut task = SessionTask {
        commands,
        record: record_tx,
        changed,
        status: Status::Running,
        size,
        serial,
        viewer: None,
        outbox: VecDeque::new(),
        pending_snapshot: None,
        mirror: mirror.ok(),
        exit: Some(io.exit),
        pty: Some(LivePty {
            output: io.output,
            input: io.input,
            input_queue,
            pty_size: size,
            _forwarder: AbortOnDrop(forwarder.abort_handle()),
            _kill: io.kill,
        }),
        output_ended: false,
        drain_deadline: None,
        compress_at: None,
    };
    if task.mirror.is_none() {
        task.finish(emulator_failed());
    }
    tokio::spawn(task.run());
    TerminalSessionHandle {
        commands: commands_tx,
        record: record_rx,
    }
}

/// The loop's state. Only the task touches it.
struct SessionTask<O, I> {
    commands: mpsc::Receiver<SessionCommand>,
    record: watch::Sender<TerminalSessionRecord>,
    changed: SessionsChanged,
    status: Status,
    /// The size of the current (or last) attachment, which the PTY and mirror follow.
    size: TerminalSize,
    /// Serial of the current attachment, shared with the input forwarder.
    serial: Arc<AtomicU64>,
    viewer: Option<Viewer>,
    /// Frames that must reach the attachment before any further output.
    outbox: VecDeque<ViewerFrame>,
    /// The new attachment's snapshot while the emulator makes it; output waits meanwhile.
    pending_snapshot: Option<oneshot::Receiver<Vec<u8>>>,
    /// The emulator, `None` once it failed. Kept after the shell exits, because it holds
    /// the final screen.
    mirror: Option<ScreenMirror>,
    /// The shell's exit status, `None` once received or gone.
    exit: Option<oneshot::Receiver<TerminalServerMessage>>,
    pty: Option<LivePty<O, I>>,
    /// The PTY closed; the session waits for the shell's exit status to finish.
    output_ended: bool,
    /// When an exited shell stops waiting for the rest of its output, or a closed PTY for
    /// the shell's exit status.
    drain_deadline: Option<Instant>,
    /// When the idle mirror is compacted next.
    compress_at: Option<Instant>,
}

impl<O: PtyOutput, I: PtyInput> SessionTask<O, I> {
    /// Serves commands first, so a takeover or close is never stuck behind output, then the
    /// shell's exit, then output that can be delivered.
    async fn run(mut self) {
        loop {
            let snapshot_pending = self.pending_snapshot.is_some();
            let flush_enabled = self.viewer.is_some() && !self.outbox.is_empty();
            let output_enabled = self.pty.is_some()
                && !self.output_ended
                && !snapshot_pending
                && self.outbox.is_empty();
            let viewer_frames = self.viewer.as_ref().map(|viewer| viewer.frames.clone());
            let flush_frames = viewer_frames.clone();
            tokio::select! {
                biased;
                command = self.commands.recv() => {
                    if !self.handle_command(command).await {
                        return;
                    }
                }
                snapshot = wait_snapshot(&mut self.pending_snapshot), if snapshot_pending => {
                    self.deliver_snapshot(snapshot);
                }
                exit = recv_exit(&mut self.exit) => self.handle_exit(exit),
                () = sleep_until(self.drain_deadline) => self.drain_timed_out(),
                permit = reserve_viewer(flush_frames), if flush_enabled => self.flush(permit),
                step = next_output(
                    viewer_frames,
                    self.mirror.as_ref().map(ScreenMirror::sender),
                    self.pty.as_mut().map(|pty| &mut pty.output),
                ), if output_enabled => self.handle_output(step),
                () = sleep_until(self.compress_at) => self.compress_idle().await,
            }
        }
    }

    /// Applies one command; returns `false` when the session ends.
    async fn handle_command(&mut self, command: Option<SessionCommand>) -> bool {
        match command {
            Some(SessionCommand::Attach { size, reply }) => self.attach(size, reply).await,
            Some(SessionCommand::Detach { serial }) => self.detach(serial),
            Some(SessionCommand::Resize { serial, size }) => {
                if self
                    .viewer
                    .as_ref()
                    .is_some_and(|viewer| viewer.serial == serial)
                {
                    self.resize(size).await;
                }
            }
            Some(SessionCommand::Close { done }) => {
                if let Some(viewer) = self.viewer.take() {
                    viewer.release(DetachReason::Closed);
                }
                // The PTY and its kill guard go now, so the shell is told to stop before the
                // caller is answered.
                self.pty = None;
                let _ = done.send(());
                return false;
            }
            // Every handle is gone, so nobody can reach the session any more.
            None => return false,
        }
        true
    }

    /// Takes the session over for a new attachment, without awaiting any attachment.
    async fn attach(&mut self, size: TerminalSize, reply: oneshot::Sender<AttachedViewer>) {
        if let Some(previous) = self.viewer.take() {
            previous.release(DetachReason::TakenOver);
        }
        let serial = self.serial.load(Ordering::Acquire) + 1;
        self.serial.store(serial, Ordering::Release);
        self.outbox.clear();
        self.pending_snapshot = None;
        self.resize(size).await;

        let (frames_tx, frames) = mpsc::channel(VIEWER_QUEUE);
        let (reason_tx, reason) = oneshot::channel();
        self.viewer = Some(Viewer {
            serial,
            frames: frames_tx,
            reason: Some(reason_tx),
        });
        if matches!(self.status, Status::Running | Status::Exiting(_)) {
            self.outbox
                .push_back(ViewerFrame::Event(TerminalServerMessage::Ready));
        }
        self.request_snapshot().await;
        let _ = reply.send(AttachedViewer {
            serial,
            frames,
            reason,
            input: self.pty.as_ref().map(|pty| pty.input_queue.clone()),
        });
    }

    /// Asks the emulator for the new attachment's snapshot. Without an emulator the
    /// attachment only gets the final event of an exited session.
    async fn request_snapshot(&mut self) {
        let requested = match &self.mirror {
            Some(mirror) => mirror.snapshot().await,
            None => Err(MirrorFailed),
        };
        match requested {
            Ok(snapshot) => self.pending_snapshot = Some(snapshot),
            Err(MirrorFailed) => self.mirror_failed(),
        }
    }

    /// Queues the snapshot, and for an exited session the event that explains why.
    fn deliver_snapshot(&mut self, snapshot: Result<Vec<u8>, oneshot::error::RecvError>) {
        self.pending_snapshot = None;
        match snapshot {
            Ok(snapshot) => {
                self.outbox
                    .push_back(ViewerFrame::Output(Bytes::from(snapshot)));
                if let Status::Exited(event) = &self.status {
                    self.outbox.push_back(ViewerFrame::Event(event.clone()));
                }
            }
            Err(_) => self.mirror_failed(),
        }
    }

    /// Forgets the attachment if it is still the current one.
    fn detach(&mut self, serial: u64) {
        if self
            .viewer
            .as_ref()
            .is_some_and(|viewer| viewer.serial == serial)
        {
            self.viewer = None;
            self.outbox.clear();
            self.pending_snapshot = None;
        }
    }

    /// Follows the attachment's size in the mirror and the PTY.
    async fn resize(&mut self, size: TerminalSize) {
        if size == self.size {
            return;
        }
        self.size = size;
        if let Some(mirror) = &self.mirror
            && mirror.resize(size).await.is_err()
        {
            self.mirror_failed();
        }
        if let Some(pty) = &mut self.pty
            && pty.pty_size != size
        {
            pty.pty_size = size;
            pty.input.resize(size);
        }
    }

    /// The shell exited. Its last output may still be queued in the PTY, so the session
    /// finishes when the output ends, or after a grace period.
    fn handle_exit(&mut self, exit: Option<TerminalServerMessage>) {
        // A received or dropped channel returns at once on every poll, so the arm turns off,
        // or it would starve the output arm that has to drain and finish the session.
        self.exit = None;
        let event = exit.unwrap_or_else(unknown_exit);
        if self.output_ended {
            return self.finish(event);
        }
        if matches!(self.status, Status::Running) {
            self.status = Status::Exiting(event);
            self.drain_deadline = Some(Instant::now() + EXIT_DRAIN_TIMEOUT);
        }
    }

    /// Output did not end after the shell exited, or the status did not come after the PTY
    /// closed; finish with what is known.
    fn drain_timed_out(&mut self) {
        self.drain_deadline = None;
        match &self.status {
            Status::Exiting(event) => {
                let event = event.clone();
                self.finish(event);
            }
            Status::Running if self.output_ended => self.finish(unknown_exit()),
            Status::Running | Status::Exited(_) => {}
        }
    }

    /// Sends one queued frame to the attachment.
    fn flush(&mut self, permit: Option<mpsc::OwnedPermit<ViewerFrame>>) {
        let Some(permit) = permit else {
            self.drop_viewer();
            return;
        };
        if let Some(frame) = self.outbox.pop_front() {
            permit.send(frame);
        }
    }

    /// Feeds one output chunk to the mirror and the attachment, or finishes at the end.
    fn handle_output(&mut self, step: OutputStep) {
        let (viewer, mirror, chunk) = match step {
            OutputStep::Chunk {
                viewer,
                mirror,
                chunk,
            } => (viewer, mirror, chunk),
            OutputStep::ViewerGone => return self.drop_viewer(),
            OutputStep::MirrorFailed => return self.mirror_failed(),
        };
        match chunk {
            Some(data) => {
                mirror.feed(data.clone());
                if let Some(viewer) = viewer {
                    viewer.send(ViewerFrame::Output(data));
                }
                self.compress_at = Some(Instant::now() + MIRROR_IDLE_COMPRESS);
            }
            None => self.output_closed(),
        }
    }

    /// The PTY closed. The shell's status may still be on its way, because the PTY usually
    /// closes right before the shell is reaped, so the session waits for it a little.
    fn output_closed(&mut self) {
        if let Status::Exiting(event) = &self.status {
            let event = event.clone();
            return self.finish(event);
        }
        if self.exit.is_none() {
            return self.finish(unknown_exit());
        }
        self.output_ended = true;
        self.drain_deadline = Some(Instant::now() + EXIT_STATUS_TIMEOUT);
    }

    /// Releases the PTY and keeps only the mirror and the final event.
    fn finish(&mut self, event: TerminalServerMessage) {
        if matches!(self.status, Status::Exited(_)) {
            return;
        }
        self.pty = None;
        self.exit = None;
        self.drain_deadline = None;
        self.compress_at = None;
        if self.viewer.is_some() && self.pending_snapshot.is_none() {
            self.outbox.push_back(ViewerFrame::Event(event.clone()));
        }
        let message = exit_message(&event);
        self.status = Status::Exited(event);
        // An exited session only ever serves its final snapshot, so compact it once.
        if let Some(mirror) = &self.mirror {
            mirror.try_compress(CompressionMode::Full);
        }
        self.record.send_modify(|record| {
            record.status = TerminalSessionStatus::Exited { message };
        });
        self.changed.send_replace(());
    }

    /// Compacts a running session's mirror after a quiet spell.
    async fn compress_idle(&mut self) {
        self.compress_at = None;
        if let Some(mirror) = &self.mirror
            && mirror.compress(CompressionMode::Incremental).await.is_err()
        {
            self.mirror_failed();
        }
    }

    /// The emulator is gone: the session cannot be restored, so the shell ends too.
    fn mirror_failed(&mut self) {
        self.mirror = None;
        self.pending_snapshot = None;
        if let Status::Exited(event) = &self.status {
            // The attachment still learns why the session ended.
            if self.viewer.is_some() && self.outbox.is_empty() {
                self.outbox.push_back(ViewerFrame::Event(event.clone()));
            }
            return;
        }
        self.finish(emulator_failed());
    }

    /// The current attachment went away without detaching.
    fn drop_viewer(&mut self) {
        if let Some(serial) = self.viewer.as_ref().map(|viewer| viewer.serial) {
            self.detach(serial);
        }
    }
}

/// The message a tab shows for a session's final event.
pub(crate) fn exit_message(event: &TerminalServerMessage) -> String {
    match event {
        TerminalServerMessage::Error { message } => message.clone(),
        TerminalServerMessage::Exit {
            code: Some(code), ..
        } => format!("Shell exited with code {code}"),
        TerminalServerMessage::Exit {
            signal: Some(signal),
            ..
        } => format!("Shell exited from signal {signal}"),
        _ => "Shell exited".to_string(),
    }
}

/// The event of a shell whose status is not known.
fn unknown_exit() -> TerminalServerMessage {
    TerminalServerMessage::Exit {
        code: None,
        signal: None,
    }
}

/// The event of a session whose emulator failed.
fn emulator_failed() -> TerminalServerMessage {
    TerminalServerMessage::Error {
        message: MirrorFailed.to_string(),
    }
}

/// Waits for the pending snapshot; never resolves without one.
async fn wait_snapshot(
    pending: &mut Option<oneshot::Receiver<Vec<u8>>>,
) -> Result<Vec<u8>, oneshot::error::RecvError> {
    match pending {
        Some(snapshot) => snapshot.await,
        None => std::future::pending().await,
    }
}

/// The shell's exit status; never resolves once received or gone.
async fn recv_exit(
    exit: &mut Option<oneshot::Receiver<TerminalServerMessage>>,
) -> Option<TerminalServerMessage> {
    match exit {
        Some(exit) => exit.await.ok(),
        None => std::future::pending().await,
    }
}

/// Sleeps until `deadline`; never resolves without one.
async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Waits for room for one frame; `None` when the attachment is gone.
async fn reserve_viewer(
    frames: Option<mpsc::Sender<ViewerFrame>>,
) -> Option<mpsc::OwnedPermit<ViewerFrame>> {
    match frames {
        Some(frames) => frames.reserve_owned().await.ok(),
        None => std::future::pending().await,
    }
}

/// Reads one output chunk, but only after the attachment (if any) and the emulator have room
/// for it, so the session never takes output it cannot deliver and the shell is slowed
/// instead. Without an attachment, output is drained into the mirror alone, so a detached
/// shell never blocks on output.
async fn next_output<O: PtyOutput>(
    viewer: Option<mpsc::Sender<ViewerFrame>>,
    mirror: Option<MirrorSender>,
    output: Option<&mut O>,
) -> OutputStep {
    let Some(output) = output else {
        return std::future::pending().await;
    };
    let viewer = match viewer {
        Some(frames) => match frames.reserve_owned().await {
            Ok(permit) => Some(permit),
            Err(_) => return OutputStep::ViewerGone,
        },
        None => None,
    };
    let Some(mirror) = mirror else {
        return OutputStep::MirrorFailed;
    };
    let Ok(mirror) = mirror.reserve().await else {
        return OutputStep::MirrorFailed;
    };
    let chunk = output.recv().await;
    OutputStep::Chunk {
        viewer,
        mirror,
        chunk,
    }
}

/// Writes keystrokes to the PTY off the session loop, because writing waits while the shell
/// does not read. Input from a replaced attachment is dropped right before it would be
/// written, so after a takeover only the newest attachment types.
async fn forward_input<I: PtyInput>(
    input: I,
    mut chunks: mpsc::Receiver<InputChunk>,
    serial: Arc<AtomicU64>,
) {
    while let Some(chunk) = chunks.recv().await {
        if chunk.serial != serial.load(Ordering::Acquire) {
            continue;
        }
        if input.send(chunk.bytes).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::ids::{TerminalSessionId, UnixTimestampMillis};

    /// Output side fed by the test; dropping the sender closes the PTY.
    struct FakeOutput(mpsc::Receiver<Bytes>);

    impl PtyOutput for FakeOutput {
        fn recv(&mut self) -> impl Future<Output = Option<Bytes>> + Send {
            self.0.recv()
        }
    }

    /// What the session sent towards the shell.
    #[derive(Debug, PartialEq, Eq)]
    enum Sent {
        Input(Bytes),
        Resize(TerminalSize),
    }

    /// Input side that records what reached the "shell".
    #[derive(Clone)]
    struct FakeInput(mpsc::UnboundedSender<Sent>);

    impl PtyInput for FakeInput {
        async fn send(&self, bytes: Bytes) -> Result<(), ()> {
            self.0.send(Sent::Input(bytes)).map_err(|_| ())
        }

        fn resize(&self, size: TerminalSize) {
            let _ = self.0.send(Sent::Resize(size));
        }
    }

    /// The test's ends of one session's shell.
    struct Harness {
        session: TerminalSessionHandle,
        output: Option<mpsc::Sender<Bytes>>,
        exit: Option<oneshot::Sender<TerminalServerMessage>>,
        shell: mpsc::UnboundedReceiver<Sent>,
        changed: watch::Receiver<()>,
    }

    fn size(rows: u16, cols: u16) -> TerminalSize {
        TerminalSize::new(rows, cols).unwrap()
    }

    /// Starts a session on fake channels; output holds more frames than an attachment does,
    /// so tests can stall an attachment while output is still queued.
    fn harness() -> Harness {
        let (output, output_rx) = mpsc::channel(256);
        let (exit, exit_rx) = oneshot::channel();
        let (shell_tx, shell) = mpsc::unbounded_channel();
        let (changed_tx, changed) = watch::channel(());
        let record = TerminalSessionRecord {
            id: TerminalSessionId::new(),
            cwd: "/tmp".to_string(),
            title: "agent 1".to_string(),
            number: 1,
            created_at: UnixTimestampMillis::now(),
            status: TerminalSessionStatus::Running,
        };
        let session = spawn_session(
            record,
            size(24, 80),
            PtyIo {
                output: FakeOutput(output_rx),
                input: FakeInput(shell_tx),
                exit: exit_rx,
                kill: None,
            },
            Arc::new(changed_tx),
        );
        Harness {
            session,
            output: Some(output),
            exit: Some(exit),
            shell,
            changed,
        }
    }

    impl Harness {
        fn output(&self) -> &mpsc::Sender<Bytes> {
            self.output.as_ref().expect("PTY still open")
        }

        async fn print(&self, text: &str) {
            self.output()
                .send(Bytes::copy_from_slice(text.as_bytes()))
                .await
                .unwrap();
        }

        /// The shell exits with `code` and the PTY closes.
        fn exit(&mut self, code: i32) {
            if let Some(exit) = self.exit.take() {
                let _ = exit.send(TerminalServerMessage::Exit {
                    code: Some(code),
                    signal: None,
                });
            }
            self.output = None;
        }

        /// Waits until the session pulled every queued output chunk.
        async fn drained(&self) {
            let output = self.output();
            while output.capacity() < output.max_capacity() {
                tokio::task::yield_now().await;
            }
        }

        /// Waits for the reported status, the way the server would see it.
        async fn status(&self, wanted: TerminalSessionStatus) {
            let mut record = self.session.watch_record();
            record
                .wait_for(|record| record.status == wanted)
                .await
                .unwrap();
        }

        async fn attach(&self) -> AttachedViewer {
            self.session.attach(size(24, 80)).await.unwrap()
        }
    }

    /// Next frame for an attachment, or a failure instead of a hang.
    async fn next_frame(viewer: &mut AttachedViewer) -> ViewerFrame {
        tokio::time::timeout(Duration::from_secs(10), viewer.frames.recv())
            .await
            .expect("frame in time")
            .expect("viewer still attached")
    }

    /// Reads frames until `event` and returns the output bytes before it; a ready event on
    /// the way is expected, because every attachment of a running session gets one first.
    async fn output_until(viewer: &mut AttachedViewer, event: &TerminalServerMessage) -> Vec<u8> {
        let mut output = Vec::new();
        loop {
            match next_frame(viewer).await {
                ViewerFrame::Output(bytes) => output.extend_from_slice(&bytes),
                ViewerFrame::Event(received) if &received == event => return output,
                ViewerFrame::Event(TerminalServerMessage::Ready) => {}
                ViewerFrame::Event(other) => panic!("unexpected event {other:?}"),
            }
        }
    }

    /// Reads output frames until `needle` was seen.
    async fn output_containing(viewer: &mut AttachedViewer, needle: &str) -> String {
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains(needle) {
            match next_frame(viewer).await {
                ViewerFrame::Output(bytes) => output.extend_from_slice(&bytes),
                ViewerFrame::Event(event) => panic!("unexpected event {event:?}"),
            }
        }
        String::from_utf8_lossy(&output).into_owned()
    }

    fn assert_ready(frame: ViewerFrame) {
        // A running session first tells a new attachment it can type.
        assert!(
            matches!(frame, ViewerFrame::Event(TerminalServerMessage::Ready)),
            "{frame:?}"
        );
    }

    fn snapshot_text(frame: ViewerFrame) -> String {
        match frame {
            ViewerFrame::Output(bytes) => {
                // Every snapshot resets a reused browser emulator first.
                assert!(bytes.starts_with(b"\x1bc"));
                String::from_utf8_lossy(&bytes).into_owned()
            }
            ViewerFrame::Event(event) => panic!("expected a snapshot, got {event:?}"),
        }
    }

    fn exited(code: i32) -> TerminalServerMessage {
        TerminalServerMessage::Exit {
            code: Some(code),
            signal: None,
        }
    }

    #[tokio::test]
    async fn output_while_detached_is_in_the_next_snapshot() {
        let harness = harness();
        harness.print("printed while nobody watched").await;
        harness.drained().await;
        let mut viewer = harness.attach().await;
        assert_ready(next_frame(&mut viewer).await);
        // The mirror kept what the shell printed while detached.
        assert!(
            snapshot_text(next_frame(&mut viewer).await).contains("printed while nobody watched")
        );
    }

    #[tokio::test]
    async fn attach_sends_ready_snapshot_then_live_output_exactly_once() {
        let harness = harness();
        harness.print("first-marker ").await;
        let mut viewer = harness.attach().await;
        harness.print("second-marker").await;
        assert_ready(next_frame(&mut viewer).await);
        let snapshot = snapshot_text(next_frame(&mut viewer).await);
        let live = output_containing(&mut viewer, "second-marker").await;
        let all = format!("{snapshot}{live}");
        // Output around the attach is in the snapshot or the live stream, never both and
        // never neither.
        assert_eq!(all.matches("first-marker").count(), 1, "{all:?}");
        assert_eq!(all.matches("second-marker").count(), 1, "{all:?}");
    }

    #[tokio::test]
    async fn takeover_releases_the_first_attachment_and_drops_its_input() {
        let mut harness = harness();
        let mut first = harness.attach().await;
        let mut second = harness.attach().await;
        // The first attachment learns it was taken over, not that the connection broke.
        assert_eq!((&mut first.reason).await, Ok(DetachReason::TakenOver));
        let send = |viewer: &AttachedViewer, text: &'static str| {
            let input = viewer.input.clone().unwrap();
            let serial = viewer.serial;
            async move {
                input
                    .send(InputChunk {
                        serial,
                        bytes: Bytes::from_static(text.as_bytes()),
                    })
                    .await
                    .unwrap();
            }
        };
        send(&first, "from first").await;
        send(&second, "from second").await;
        // Only the newest attachment types into the shell.
        assert_eq!(
            harness.shell.recv().await,
            Some(Sent::Input(Bytes::from_static(b"from second")))
        );
        assert_ready(next_frame(&mut second).await);
    }

    #[tokio::test]
    async fn stalled_attachment_does_not_block_takeover_or_close() {
        let harness = harness();
        let mut stalled = harness.attach().await;
        for line in 0..(VIEWER_QUEUE * 2) {
            harness.print(&format!("line {line}\r\n")).await;
        }
        while stalled.frames.len() < VIEWER_QUEUE {
            tokio::task::yield_now().await;
        }
        let mut second = harness.attach().await;
        // The full data channel cannot hold up the reason.
        assert_eq!((&mut stalled.reason).await, Ok(DetachReason::TakenOver));
        assert_ready(next_frame(&mut second).await);
        harness.session.close().await;
        // Closing is not held up by an attachment either, and the attachment learns why.
        assert_eq!((&mut second.reason).await, Ok(DetachReason::Closed));
    }

    #[tokio::test]
    async fn exit_event_follows_queued_output_while_commands_stay_served() {
        let mut harness = harness();
        let mut stalled = harness.attach().await;
        for line in 0..(VIEWER_QUEUE * 3) {
            harness.print(&format!("line {line}\r\n")).await;
        }
        harness.print("last-line").await;
        harness.exit(0);
        // The shell exited, but output before it is not delivered yet and the attachment is
        // stalled: a takeover must still be served.
        let mut viewer = harness.attach().await;
        assert_eq!((&mut stalled.reason).await, Ok(DetachReason::TakenOver));
        let before_exit = output_until(&mut viewer, &exited(0)).await;
        // The exit event comes after the last output, so the attachment saw everything.
        assert!(String::from_utf8_lossy(&before_exit).contains("last-line"));
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Shell exited with code 0".to_string(),
            })
            .await;
    }

    #[tokio::test]
    async fn attach_frames_depend_on_the_status() {
        let mut harness = harness();
        // Running: ready, then the snapshot.
        harness.print("running-text").await;
        harness.drained().await;
        let mut viewer = harness.attach().await;
        assert_ready(next_frame(&mut viewer).await);
        assert!(snapshot_text(next_frame(&mut viewer).await).contains("running-text"));

        // Exited: the last screen, then why it ended.
        drop(viewer);
        harness.exit(0);
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Shell exited with code 0".to_string(),
            })
            .await;
        let mut viewer = harness.attach().await;
        assert!(snapshot_text(next_frame(&mut viewer).await).contains("running-text"));
        assert!(
            matches!(next_frame(&mut viewer).await, ViewerFrame::Event(event) if event == exited(0))
        );
        // An exited session takes no input.
        assert!(viewer.input.is_none());
    }

    #[tokio::test]
    async fn exit_tells_the_server_the_list_changed() {
        let mut harness = harness();
        harness.changed.mark_unchanged();
        harness.exit(7);
        // The new status reaches the server through the change signal, not a poll.
        harness.changed.changed().await.unwrap();
        assert_eq!(
            harness.session.record().status,
            TerminalSessionStatus::Exited {
                message: "Shell exited with code 7".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn resize_follows_the_current_attachment_only() {
        let mut harness = harness();
        let viewer = harness.session.attach(size(40, 120)).await.unwrap();
        // Attaching with another size resizes the PTY to it.
        assert_eq!(
            harness.shell.recv().await,
            Some(Sent::Resize(size(40, 120)))
        );
        harness
            .session
            .send(SessionCommand::Resize {
                serial: viewer.serial,
                size: size(30, 100),
            })
            .await
            .unwrap();
        assert_eq!(
            harness.shell.recv().await,
            Some(Sent::Resize(size(30, 100)))
        );
        harness
            .session
            .send(SessionCommand::Resize {
                serial: viewer.serial - 1,
                size: size(10, 10),
            })
            .await
            .unwrap();
        harness.print("x").await;
        harness.drained().await;
        // A replaced attachment's resize is ignored.
        assert!(harness.shell.try_recv().is_err());
    }

    #[tokio::test]
    async fn exit_status_that_follows_the_closed_pty_is_still_reported() {
        let mut harness = harness();
        let exit = harness.exit.take().unwrap();
        // The PTY closes before the shell is reaped.
        harness.output = None;
        tokio::task::yield_now().await;
        let _ = exit.send(exited(3));
        // The status still decides how the session ended.
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Shell exited with code 3".to_string(),
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn shell_whose_output_never_ends_still_finishes() {
        let mut harness = harness();
        let _held_open = harness.output.clone();
        harness.exit(0);
        // Paused time advances to the drain deadline once everything is idle; a process that
        // kept the PTY open does not keep the session running.
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Shell exited with code 0".to_string(),
            })
            .await;
    }
}
