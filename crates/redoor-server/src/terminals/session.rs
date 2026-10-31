//! One terminal session: the task that owns an agent terminal stream, mirrors its output and
//! serves at most one attached browser.
//!
//! The task, not a browser socket, holds the stream and its close guard, so the PTY lives as
//! long as the session. All state changes happen inside the task's loop, so attaching,
//! taking over and finishing are atomic with respect to output: a viewer gets the snapshot
//! of exactly the output fed before it, then live output, with nothing lost or repeated.

use super::TerminalsChangedNotifier;
use super::emulator::{MirrorFailed, MirrorPermit, MirrorSender, ScreenMirror};
use crate::actors::router::StreamCloseGuard;
use bytes::Bytes;
use libghostty_vt::terminal::CompressionMode;
use redoor_protocol::{
    api::terminals::{TerminalSessionInfo, TerminalSessionStatus},
    wire::{
        request::CommandError,
        stream::StreamChunk,
        terminal::{TerminalServerMessage, TerminalSize},
    },
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

/// How long the agent may take to start the PTY before the session gives up on it.
pub(crate) const TERMINAL_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
/// Frames of browser input queued for the agent. Input before the PTY is ready waits here,
/// so early keystrokes are kept, and a full queue holds the browser socket back.
pub(crate) const MAX_PENDING_INPUT_FRAMES: usize = 32;
/// Frames queued for an attached browser. Output is only pulled from the agent when a slot
/// is free, so a slow browser slows the agent through credit instead of growing memory.
const VIEWER_QUEUE: usize = 16;
/// Commands queued for the session task.
const COMMAND_QUEUE: usize = 16;
/// Quiet time after output before a running session compacts its mirror.
const MIRROR_IDLE_COMPRESS: Duration = Duration::from_secs(5);

/// The output side of an agent terminal stream, abstracted so the session can be tested
/// without a router.
pub(crate) trait TerminalOutput: Send + 'static {
    /// Next PTY output frame, `Err` if the stream failed, `None` at the end. Cancel safe.
    fn recv(&mut self) -> impl Future<Output = Option<Result<StreamChunk, CommandError>>> + Send;
}

/// The input side of an agent terminal stream: keystrokes (credited) and resizes.
pub(crate) trait TerminalInput: Clone + Send + Sync + 'static {
    /// Sends keystrokes, waiting for credit; `Err` once the stream is gone.
    fn send(&self, bytes: Bytes) -> impl Future<Output = Result<(), ()>> + Send;
    /// Resizes the PTY without waiting, ahead of queued input.
    fn resize(&self, size: TerminalSize);
}

/// Everything a session needs from its agent terminal stream.
pub(crate) struct TerminalIo<O, I> {
    pub(crate) output: O,
    pub(crate) input: I,
    pub(crate) events: mpsc::Receiver<TerminalServerMessage>,
    /// Cancels the stream on the agent when the session drops it; `None` in tests.
    pub(crate) close: Option<StreamCloseGuard>,
}

/// One item for an attached browser, in the order it must be sent.
#[derive(Debug)]
pub(crate) enum ViewerFrame {
    Output(Bytes),
    Event(TerminalServerMessage),
}

/// Why the session let go of a viewer. Sent apart from the data channel, so it arrives even
/// when that channel is full of output a slow browser has not taken yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DetachReason {
    /// Another browser attached.
    TakenOver,
    /// The session was closed.
    Closed,
}

impl DetachReason {
    /// The message the browser gets, so it can tell a takeover from a dropped connection.
    pub(crate) fn message(self) -> TerminalServerMessage {
        match self {
            Self::TakenOver => TerminalServerMessage::TakenOver,
            Self::Closed => TerminalServerMessage::Closed,
        }
    }
}

/// Keystrokes from one viewer, tagged so input from a replaced viewer can be dropped.
pub(crate) struct InputChunk {
    pub(crate) serial: u64,
    pub(crate) bytes: Bytes,
}

/// The browser bridge's end of one attachment.
pub(crate) struct AttachedViewer {
    /// Identifies this attachment in the bridge's later commands.
    pub(crate) serial: u64,
    pub(crate) frames: mpsc::Receiver<ViewerFrame>,
    pub(crate) reason: oneshot::Receiver<DetachReason>,
    /// Where keystrokes go; `None` when the shell is already gone.
    pub(crate) input: Option<mpsc::Sender<InputChunk>>,
}

/// Requests to the session task from the registry and attached bridges.
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
    /// Ends the session; `done` is answered after the viewer was told.
    Close {
        done: oneshot::Sender<()>,
    },
}

/// The registry's handle to one session task.
#[derive(Clone)]
pub(crate) struct TerminalSessionHandle {
    commands: mpsc::Sender<SessionCommand>,
    info: watch::Receiver<TerminalSessionInfo>,
}

/// The session task is gone, which only happens once it was closed.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SessionGone;

impl TerminalSessionHandle {
    /// The session as listed, read without involving the task.
    pub(crate) fn info(&self) -> TerminalSessionInfo {
        self.info.borrow().clone()
    }

    /// Follows the listing view, so tests can wait for a state instead of sleeping.
    #[cfg(test)]
    pub(crate) fn watch_info(&self) -> watch::Receiver<TerminalSessionInfo> {
        self.info.clone()
    }

    /// Attaches a viewer of `size`, taking the session over from any current one.
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

    /// Ends the session and waits until its viewer was told and the stream released.
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
    /// Waiting for the agent's ready event.
    Starting,
    Running,
    /// The agent reported the end; its output is still being drained.
    Exiting(TerminalServerMessage),
    /// The stream is gone; this event is what every later viewer is told.
    Exited(TerminalServerMessage),
}

/// The current viewer as the session sees it.
struct Viewer {
    serial: u64,
    frames: mpsc::Sender<ViewerFrame>,
    reason: Option<oneshot::Sender<DetachReason>>,
}

impl Viewer {
    /// Tells the viewer why it was let go.
    fn release(mut self, reason: DetachReason) {
        if let Some(sender) = self.reason.take() {
            let _ = sender.send(reason);
        }
    }
}

/// The live agent stream; dropped as a whole when the session finishes, which cancels the
/// stream on the agent and frees its terminal slot.
struct LiveStream<O, I> {
    output: O,
    input: I,
    /// Keystrokes for the forwarder; cloned into every attachment.
    input_queue: mpsc::Sender<InputChunk>,
    /// Lets the forwarder start sending once the PTY is ready.
    ready: watch::Sender<bool>,
    /// The size the agent's PTY has, so a resize is sent only when it differs.
    pty_size: TerminalSize,
    _forwarder: AbortOnDrop,
    _close: Option<StreamCloseGuard>,
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
    /// A frame was pulled; the permits guarantee it can be fed and sent without waiting.
    Chunk {
        viewer: Option<mpsc::OwnedPermit<ViewerFrame>>,
        mirror: MirrorPermit,
        chunk: Option<Result<StreamChunk, CommandError>>,
    },
    /// The viewer's bridge went away.
    ViewerGone,
    MirrorFailed,
}

/// Creates a session task and returns its handle. The PTY start is not awaited: the task
/// waits for the agent's ready event itself, under [`TERMINAL_SETUP_TIMEOUT`].
pub(crate) fn spawn_session<O: TerminalOutput, I: TerminalInput>(
    info: TerminalSessionInfo,
    size: TerminalSize,
    io: TerminalIo<O, I>,
    notifier: TerminalsChangedNotifier,
) -> TerminalSessionHandle {
    let (commands_tx, commands) = mpsc::channel(COMMAND_QUEUE);
    let (info_tx, info_rx) = watch::channel(info);
    let serial = Arc::new(AtomicU64::new(0));
    let (input_queue, input_chunks) = mpsc::channel(MAX_PENDING_INPUT_FRAMES);
    let (ready, ready_rx) = watch::channel(false);
    let forwarder = tokio::spawn(forward_input(
        io.input.clone(),
        input_chunks,
        serial.clone(),
        ready_rx,
    ));
    let mirror = ScreenMirror::spawn(size);
    let mut task = SessionTask {
        commands,
        info: info_tx,
        notifier,
        status: Status::Starting,
        size,
        serial,
        viewer: None,
        outbox: VecDeque::new(),
        pending_snapshot: None,
        mirror: mirror.ok(),
        events: Some(io.events),
        stream: Some(LiveStream {
            output: io.output,
            input: io.input,
            input_queue,
            ready,
            pty_size: size,
            _forwarder: AbortOnDrop(forwarder.abort_handle()),
            _close: io.close,
        }),
        setup_deadline: Some(Instant::now() + TERMINAL_SETUP_TIMEOUT),
        compress_at: None,
    };
    if task.mirror.is_none() {
        task.finish(emulator_failed());
    }
    tokio::spawn(task.run());
    TerminalSessionHandle {
        commands: commands_tx,
        info: info_rx,
    }
}

/// The loop's state. Only the task touches it.
struct SessionTask<O, I> {
    commands: mpsc::Receiver<SessionCommand>,
    info: watch::Sender<TerminalSessionInfo>,
    notifier: TerminalsChangedNotifier,
    status: Status,
    /// The size of the current (or last) viewer, which the PTY and mirror follow.
    size: TerminalSize,
    /// Serial of the current viewer, shared with the input forwarder.
    serial: Arc<AtomicU64>,
    viewer: Option<Viewer>,
    /// Frames that must reach the viewer before any further output.
    outbox: VecDeque<ViewerFrame>,
    /// The new viewer's snapshot while the emulator makes it; output waits meanwhile.
    pending_snapshot: Option<oneshot::Receiver<Vec<u8>>>,
    /// The emulator, `None` once it failed. Kept after the shell exits, because it holds
    /// the final screen.
    mirror: Option<ScreenMirror>,
    /// Lifecycle events from the agent, `None` once that channel closed.
    events: Option<mpsc::Receiver<TerminalServerMessage>>,
    stream: Option<LiveStream<O, I>>,
    /// When a session still starting gives up.
    setup_deadline: Option<Instant>,
    /// When the idle mirror is compacted next.
    compress_at: Option<Instant>,
}

impl<O: TerminalOutput, I: TerminalInput> SessionTask<O, I> {
    /// Serves commands first, so a takeover or close is never stuck behind output, then
    /// agent events, then output that can be delivered.
    async fn run(mut self) {
        loop {
            let snapshot_pending = self.pending_snapshot.is_some();
            let flush_enabled = self.viewer.is_some() && !self.outbox.is_empty();
            let output_enabled =
                self.stream.is_some() && !snapshot_pending && self.outbox.is_empty();
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
                event = recv_event(&mut self.events) => self.handle_event(event),
                () = sleep_until(self.setup_deadline) => self.setup_timed_out(),
                permit = reserve_viewer(flush_frames), if flush_enabled => self.flush(permit),
                step = next_output(
                    viewer_frames,
                    self.mirror.as_ref().map(ScreenMirror::sender),
                    self.stream.as_mut().map(|stream| &mut stream.output),
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
                // The stream and its close guard go now, so the agent stops the PTY before
                // the caller is answered.
                self.stream = None;
                let _ = done.send(());
                return false;
            }
            // Every handle is gone, so nobody can reach the session any more.
            None => return false,
        }
        true
    }

    /// Takes the session over for a new viewer, without awaiting any viewer or credit.
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
            input: self
                .stream
                .as_ref()
                .map(|stream| stream.input_queue.clone()),
        });
        self.publish_info();
    }

    /// Asks the emulator for the new viewer's snapshot. Without an emulator the viewer only
    /// gets the final event of an exited session.
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

    /// Forgets the viewer if it is still the current one.
    fn detach(&mut self, serial: u64) {
        if self
            .viewer
            .as_ref()
            .is_some_and(|viewer| viewer.serial == serial)
        {
            self.viewer = None;
            self.outbox.clear();
            self.pending_snapshot = None;
            self.publish_info();
        }
    }

    /// Follows the viewer's size in the mirror, and in the PTY once it runs.
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
        self.sync_pty_size();
    }

    /// Sends the current size to a running PTY when it differs. Resizes before the ready
    /// event would be dropped by the agent, so they are sent at ready instead.
    fn sync_pty_size(&mut self) {
        if !matches!(self.status, Status::Running) {
            return;
        }
        if let Some(stream) = &mut self.stream
            && stream.pty_size != self.size
        {
            stream.pty_size = self.size;
            stream.input.resize(self.size);
        }
    }

    /// Applies one agent lifecycle event, or the end of that channel.
    fn handle_event(&mut self, event: Option<TerminalServerMessage>) {
        match event {
            Some(TerminalServerMessage::Ready) if matches!(self.status, Status::Starting) => {
                self.status = Status::Running;
                self.setup_deadline = None;
                if let Some(stream) = &self.stream {
                    let _ = stream.ready.send(true);
                }
                if self.viewer.is_some() {
                    self.outbox
                        .push_back(ViewerFrame::Event(TerminalServerMessage::Ready));
                }
                self.sync_pty_size();
                self.publish_info();
            }
            Some(
                event @ (TerminalServerMessage::Exit { .. } | TerminalServerMessage::Error { .. }),
            ) => {
                // The output before the event may still be queued, so the session finishes
                // only when the output ends.
                if matches!(self.status, Status::Starting | Status::Running) {
                    self.status = Status::Exiting(event);
                }
            }
            // Duplicate ready events and server-only messages from an agent mean nothing.
            Some(_) => {}
            None => {
                // A closed channel returns at once on every poll, so the arm turns off, or it
                // would starve the output arm that has to drain and finish the session.
                self.events = None;
                if matches!(self.status, Status::Starting | Status::Running) {
                    self.status = Status::Exiting(agent_disconnected());
                }
            }
        }
    }

    /// The agent never reported the PTY ready.
    fn setup_timed_out(&mut self) {
        self.setup_deadline = None;
        if matches!(self.status, Status::Starting) {
            self.finish(TerminalServerMessage::Error {
                message: "Agent did not start the terminal".to_string(),
            });
        }
    }

    /// Sends one queued frame to the viewer.
    fn flush(&mut self, permit: Option<mpsc::OwnedPermit<ViewerFrame>>) {
        let Some(permit) = permit else {
            self.drop_viewer();
            return;
        };
        if let Some(frame) = self.outbox.pop_front() {
            permit.send(frame);
        }
    }

    /// Feeds one output frame to the mirror and the viewer, or finishes at the end.
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
            Some(Ok(chunk)) => {
                let is_last = chunk.is_last;
                if !chunk.data.is_empty() {
                    let data = Bytes::from(chunk.data);
                    mirror.feed(data.clone());
                    if let Some(viewer) = viewer {
                        viewer.send(ViewerFrame::Output(data));
                    }
                    self.compress_at = Some(Instant::now() + MIRROR_IDLE_COMPRESS);
                }
                if is_last {
                    let event = self.ending_event().unwrap_or(TerminalServerMessage::Exit {
                        code: None,
                        signal: None,
                    });
                    self.finish(event);
                }
            }
            Some(Err(error)) => self.finish(TerminalServerMessage::Error {
                message: error.message,
            }),
            None => {
                let event = self.ending_event().unwrap_or_else(agent_disconnected);
                self.finish(event);
            }
        }
    }

    /// The exit or error event the agent reported, including one still queued: the agent
    /// sends it before FIN, so it is already in the channel when FIN is read.
    fn ending_event(&mut self) -> Option<TerminalServerMessage> {
        if let Status::Exiting(event) = &self.status {
            return Some(event.clone());
        }
        let events = self.events.as_mut()?;
        while let Ok(event) = events.try_recv() {
            if matches!(
                event,
                TerminalServerMessage::Exit { .. } | TerminalServerMessage::Error { .. }
            ) {
                return Some(event);
            }
        }
        None
    }

    /// Releases the stream and keeps only the mirror and the final event.
    fn finish(&mut self, event: TerminalServerMessage) {
        if matches!(self.status, Status::Exited(_)) {
            return;
        }
        self.stream = None;
        self.events = None;
        self.setup_deadline = None;
        self.compress_at = None;
        if self.viewer.is_some() && self.pending_snapshot.is_none() {
            self.outbox.push_back(ViewerFrame::Event(event.clone()));
        }
        self.status = Status::Exited(event);
        // An exited session only ever serves its final snapshot, so compact it once.
        if let Some(mirror) = &self.mirror {
            mirror.try_compress(CompressionMode::Full);
        }
        self.publish_info();
        self.notifier.publish();
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
            // The viewer still learns why the session ended.
            if self.viewer.is_some() && self.outbox.is_empty() {
                self.outbox.push_back(ViewerFrame::Event(event.clone()));
            }
            return;
        }
        self.finish(emulator_failed());
    }

    /// The current viewer's bridge went away without detaching.
    fn drop_viewer(&mut self) {
        if let Some(serial) = self.viewer.as_ref().map(|viewer| viewer.serial) {
            self.detach(serial);
        }
    }

    /// Republishes the listing view of the session.
    fn publish_info(&self) {
        let status = match &self.status {
            Status::Starting => TerminalSessionStatus::Starting,
            Status::Running | Status::Exiting(_) => TerminalSessionStatus::Running,
            Status::Exited(event) => TerminalSessionStatus::Exited {
                message: exit_message(event),
            },
        };
        let attached = self.viewer.is_some();
        self.info.send_if_modified(|info| {
            let changed = info.status != status || info.attached != attached;
            info.status = status;
            info.attached = attached;
            changed
        });
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

/// The event of a session whose agent went away.
fn agent_disconnected() -> TerminalServerMessage {
    TerminalServerMessage::Error {
        message: "Agent disconnected".to_string(),
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

/// Next lifecycle event; never resolves once the channel is gone.
async fn recv_event(
    events: &mut Option<mpsc::Receiver<TerminalServerMessage>>,
) -> Option<TerminalServerMessage> {
    match events {
        Some(events) => events.recv().await,
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

/// Waits for room for one frame; `None` when the viewer's bridge is gone.
async fn reserve_viewer(
    frames: Option<mpsc::Sender<ViewerFrame>>,
) -> Option<mpsc::OwnedPermit<ViewerFrame>> {
    match frames {
        Some(frames) => frames.reserve_owned().await.ok(),
        None => std::future::pending().await,
    }
}

/// Pulls one output frame, but only after the viewer (if any) and the emulator have room for
/// it, so the session never takes output it cannot deliver and agent credit stays the
/// backpressure. While detached, output is drained into the mirror alone, so a detached
/// shell never blocks on output.
async fn next_output<O: TerminalOutput>(
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

/// Relays keystrokes to the agent off the session loop, because sending waits for credit.
/// Input queued before the PTY is ready waits for it; input from a replaced viewer is
/// dropped right before it would be sent, so after a takeover only the newest viewer types.
async fn forward_input<I: TerminalInput>(
    input: I,
    mut chunks: mpsc::Receiver<InputChunk>,
    serial: Arc<AtomicU64>,
    mut ready: watch::Receiver<bool>,
) {
    if ready.wait_for(|ready| *ready).await.is_err() {
        return;
    }
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
    use redoor_protocol::{
        ids::{RequestId, TerminalSessionId, UnixTimestampMillis},
        wire::command::CommandErrorKind,
    };

    /// Output side fed by the test.
    struct FakeOutput(mpsc::Receiver<Result<StreamChunk, CommandError>>);

    impl TerminalOutput for FakeOutput {
        fn recv(
            &mut self,
        ) -> impl Future<Output = Option<Result<StreamChunk, CommandError>>> + Send {
            self.0.recv()
        }
    }

    /// What the session sent towards the agent.
    #[derive(Debug, PartialEq, Eq)]
    enum Sent {
        Input(Bytes),
        Resize(TerminalSize),
    }

    /// Input side that records what reached the "agent".
    #[derive(Clone)]
    struct FakeInput(mpsc::UnboundedSender<Sent>);

    impl TerminalInput for FakeInput {
        async fn send(&self, bytes: Bytes) -> Result<(), ()> {
            self.0.send(Sent::Input(bytes)).map_err(|_| ())
        }

        fn resize(&self, size: TerminalSize) {
            let _ = self.0.send(Sent::Resize(size));
        }
    }

    /// The test's ends of one session's agent stream.
    struct Harness {
        session: TerminalSessionHandle,
        output: mpsc::Sender<Result<StreamChunk, CommandError>>,
        events: mpsc::Sender<TerminalServerMessage>,
        agent: mpsc::UnboundedReceiver<Sent>,
    }

    fn size(rows: u16, cols: u16) -> TerminalSize {
        TerminalSize::new(rows, cols).unwrap()
    }

    /// Starts a session on fake channels; output holds more frames than a viewer does, so
    /// tests can stall a viewer while output is still queued.
    fn harness() -> Harness {
        let (output, output_rx) = mpsc::channel(256);
        let (events, events_rx) = mpsc::channel(8);
        let (agent_tx, agent) = mpsc::unbounded_channel();
        let info = TerminalSessionInfo {
            id: TerminalSessionId::new(),
            agent_id: redoor_core::test_support::test_agent_id("agent"),
            cwd: "/tmp".to_string(),
            title: "agent 1".to_string(),
            number: 1,
            created_at: UnixTimestampMillis::now(),
            status: TerminalSessionStatus::Starting,
            attached: false,
        };
        let session = spawn_session(
            info,
            size(24, 80),
            TerminalIo {
                output: FakeOutput(output_rx),
                input: FakeInput(agent_tx),
                events: events_rx,
                close: None,
            },
            TerminalsChangedNotifier::disabled(),
        );
        Harness {
            session,
            output,
            events,
            agent,
        }
    }

    impl Harness {
        async fn print(&self, text: &str) {
            let chunk = StreamChunk::data(RequestId::new(1), text.as_bytes().to_vec(), false);
            self.output.send(Ok(chunk)).await.unwrap();
        }

        async fn fin(&self) {
            let chunk = StreamChunk::data(RequestId::new(1), Vec::new(), true);
            self.output.send(Ok(chunk)).await.unwrap();
        }

        async fn event(&self, event: TerminalServerMessage) {
            self.events.send(event).await.unwrap();
        }

        /// Waits until the session pulled every queued output frame.
        async fn drained(&self) {
            while self.output.capacity() < self.output.max_capacity() {
                tokio::task::yield_now().await;
            }
        }

        /// Waits for the listed status, the way a browser polling the list would.
        async fn status(&self, wanted: TerminalSessionStatus) {
            let mut info = self.session.watch_info();
            info.wait_for(|info| info.status == wanted).await.unwrap();
        }

        async fn attach(&self) -> AttachedViewer {
            self.session.attach(size(24, 80)).await.unwrap()
        }
    }

    /// Next frame for a viewer, or a failure instead of a hang.
    async fn next_frame(viewer: &mut AttachedViewer) -> ViewerFrame {
        tokio::time::timeout(Duration::from_secs(10), viewer.frames.recv())
            .await
            .expect("frame in time")
            .expect("viewer still attached")
    }

    /// Reads frames until `event` and returns the output bytes before it; a ready event on
    /// the way is expected, because every viewer of a running session gets one first.
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
        // A running session first tells a new viewer it can type.
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

    fn exited() -> TerminalServerMessage {
        TerminalServerMessage::Exit {
            code: Some(0),
            signal: None,
        }
    }

    #[tokio::test]
    async fn output_while_detached_is_in_the_next_snapshot() {
        let harness = harness();
        harness.event(TerminalServerMessage::Ready).await;
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
        harness.event(TerminalServerMessage::Ready).await;
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
    async fn takeover_releases_the_first_viewer_and_drops_its_input() {
        let mut harness = harness();
        harness.event(TerminalServerMessage::Ready).await;
        let mut first = harness.attach().await;
        let mut second = harness.attach().await;
        // The first viewer learns it was taken over, not that the connection broke.
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
        // Only the newest viewer types into the shell.
        assert_eq!(
            harness.agent.recv().await,
            Some(Sent::Input(Bytes::from_static(b"from second")))
        );
        assert_ready(next_frame(&mut second).await);
    }

    #[tokio::test]
    async fn input_queued_before_a_takeover_is_dropped() {
        let mut harness = harness();
        let first = harness.attach().await;
        // Before ready, input waits in the forwarder.
        first
            .input
            .as_ref()
            .unwrap()
            .send(InputChunk {
                serial: first.serial,
                bytes: Bytes::from_static(b"stale"),
            })
            .await
            .unwrap();
        let second = harness.attach().await;
        second
            .input
            .as_ref()
            .unwrap()
            .send(InputChunk {
                serial: second.serial,
                bytes: Bytes::from_static(b"fresh"),
            })
            .await
            .unwrap();
        harness.event(TerminalServerMessage::Ready).await;
        // The replaced viewer's queued keystrokes never reach the shell.
        assert_eq!(
            harness.agent.recv().await,
            Some(Sent::Input(Bytes::from_static(b"fresh")))
        );
    }

    #[tokio::test]
    async fn stalled_viewer_does_not_block_takeover_or_close() {
        let harness = harness();
        harness.event(TerminalServerMessage::Ready).await;
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
        // Closing is not held up by a viewer either, and the viewer learns why.
        assert_eq!((&mut second.reason).await, Ok(DetachReason::Closed));
    }

    #[tokio::test]
    async fn exit_event_follows_queued_output_while_commands_stay_served() {
        let harness = harness();
        harness.event(TerminalServerMessage::Ready).await;
        let mut stalled = harness.attach().await;
        for line in 0..(VIEWER_QUEUE * 3) {
            harness.print(&format!("line {line}\r\n")).await;
        }
        harness.print("last-line").await;
        harness.event(exited()).await;
        harness.fin().await;
        // The agent's exit event is queued, but output before it is not delivered yet and
        // the viewer is stalled: a takeover must still be served.
        let mut viewer = harness.attach().await;
        assert_eq!((&mut stalled.reason).await, Ok(DetachReason::TakenOver));
        let before_exit = output_until(&mut viewer, &exited()).await;
        // The exit event comes after the last output, so the viewer saw everything.
        assert!(String::from_utf8_lossy(&before_exit).contains("last-line"));
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Shell exited with code 0".to_string(),
            })
            .await;
    }

    #[tokio::test]
    async fn attach_frames_depend_on_the_status() {
        let harness = harness();
        // Starting: only the snapshot; ready follows when the PTY is ready.
        let mut viewer = harness.attach().await;
        snapshot_text(next_frame(&mut viewer).await);
        harness.event(TerminalServerMessage::Ready).await;
        assert_ready(next_frame(&mut viewer).await);

        // Running: ready, then the snapshot.
        harness.print("running-text").await;
        harness.drained().await;
        let mut viewer = harness.attach().await;
        assert_ready(next_frame(&mut viewer).await);
        assert!(snapshot_text(next_frame(&mut viewer).await).contains("running-text"));

        // Exited: the last screen, then why it ended.
        drop(viewer);
        harness.event(exited()).await;
        harness.fin().await;
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Shell exited with code 0".to_string(),
            })
            .await;
        let mut viewer = harness.attach().await;
        assert!(snapshot_text(next_frame(&mut viewer).await).contains("running-text"));
        assert!(
            matches!(next_frame(&mut viewer).await, ViewerFrame::Event(event) if event == exited())
        );
        // An exited session takes no input.
        assert!(viewer.input.is_none());
    }

    #[tokio::test]
    async fn closed_lifecycle_channel_drains_output_then_reports_agent_disconnected() {
        let Harness {
            session,
            output,
            events,
            agent: _agent,
        } = harness();
        events.send(TerminalServerMessage::Ready).await.unwrap();
        let mut viewer = session.attach(size(24, 80)).await.unwrap();
        for line in 0..(VIEWER_QUEUE * 2) {
            let text = format!("line {line}\r\n").into_bytes();
            output
                .send(Ok(StreamChunk::data(RequestId::new(1), text, false)))
                .await
                .unwrap();
        }
        output
            .send(Ok(StreamChunk::data(
                RequestId::new(1),
                b"tail-text".to_vec(),
                false,
            )))
            .await
            .unwrap();
        // The agent connection is gone: both channels close, events first.
        drop(events);
        drop(output);
        let error = TerminalServerMessage::Error {
            message: "Agent disconnected".to_string(),
        };
        let drained = output_until(&mut viewer, &error).await;
        // Output queued before the disconnect is still delivered before the error.
        assert!(String::from_utf8_lossy(&drained).contains("tail-text"));
        let mut info = session.watch_info();
        info.wait_for(|info| {
            info.status
                == TerminalSessionStatus::Exited {
                    message: "Agent disconnected".to_string(),
                }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn failed_stream_finishes_with_its_error() {
        let harness = harness();
        harness.event(TerminalServerMessage::Ready).await;
        harness
            .output
            .send(Err(CommandError::new(
                CommandErrorKind::Internal,
                "stream broke",
            )))
            .await
            .unwrap();
        // A failed stream is an exit with the reason, never a silent hang.
        harness
            .status(TerminalSessionStatus::Exited {
                message: "stream broke".to_string(),
            })
            .await;
    }

    #[tokio::test]
    async fn resize_reaches_the_pty_only_once_it_runs() {
        let mut harness = harness();
        let viewer = harness.session.attach(size(40, 120)).await.unwrap();
        harness.event(TerminalServerMessage::Ready).await;
        // A resize before ready would be dropped by the agent, so it is sent at ready.
        assert_eq!(
            harness.agent.recv().await,
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
            harness.agent.recv().await,
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
        // A replaced viewer's resize is ignored.
        assert!(harness.agent.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn agent_that_never_starts_the_pty_times_out() {
        let harness = harness();
        // Paused time advances to the setup deadline once everything is idle.
        harness
            .status(TerminalSessionStatus::Exited {
                message: "Agent did not start the terminal".to_string(),
            })
            .await;
    }
}
