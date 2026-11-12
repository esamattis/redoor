//! Interactive terminal sessions that belong to the agent process.
//!
//! A session (see [`session`]) owns its shell's PTY and a headless emulator mirroring the
//! screen, and lives in the process-wide [`registry`] until it is closed, so the shell
//! survives server restarts and reconnects. A connection only attaches to a session: one
//! stream carries the snapshot and live output to the server and keystrokes back. Canceling
//! the stream or losing the connection only detaches.
//!
//! Output travels on the interactive lane, which the connection writer drains before bulk
//! transfer data, so keystroke echoes never queue behind a download. Both directions are
//! credited with a terminal-sized window.

pub(crate) mod activity;
pub(crate) mod emulator;
mod pending_tail;
pub(crate) mod registry;
pub(crate) mod session;

use crate::runtime::responder::{ControlSender, OutboundFrame};
use crate::transfers::stream::{OutputCredits, StreamWriter};
use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill, killpg},
    unistd::Pid,
};
use redoor_core::{log, stream_credit::CreditLedger};
use redoor_protocol::{
    ids::RequestId,
    wire::{
        AgentToServer,
        log::Level,
        stream::{StreamChunk, TERMINAL_CREDIT_WINDOW_FRAMES, receive_queue_frames},
        terminal::{TerminalServerMessage, TerminalSize},
    },
};
use session::{
    AttachedViewer, DetachReason, InputChunk, PtyInput, PtyIo, PtyOutput, SessionCommand,
    TerminalSessionHandle, ViewerFrame,
};
use std::collections::{BTreeMap, HashMap};
use std::os::fd::AsFd;
use std::sync::{Arc, Mutex, PoisonError};
use std::{ffi::OsString, os::unix::process::ExitStatusExt, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

/// PTY read size; small enough to keep interactive output latency low.
const PTY_BUFFER_SIZE: usize = 8 * 1024;
/// Pending resizes per attachment; resizes are rare, and a full queue only drops a stale size.
const RESIZE_QUEUE_SIZE: usize = 4;
/// Keystroke frames queued for the PTY writer. Small, because a shell that does not read
/// should hold the attachment's input stream back rather than fill memory.
const PTY_WRITE_QUEUE: usize = 4;
/// How long teardown waits for the shell before escalating, so a stuck session cannot hold
/// resources indefinitely.
const PROCESS_EXIT_GRACE: Duration = Duration::from_secs(2);

/// Input queues of one terminal, fed by the connection reader.
struct TerminalRoute {
    input: mpsc::Sender<StreamChunk>,
    resize: mpsc::Sender<TerminalSize>,
}

/// Routes inbound terminal input frames and resizes to their PTY sessions.
///
/// Shared by the connection reader (frames), the runtime (resizes) and the sessions, so input
/// never passes through the runtime mailbox.
#[derive(Clone, Default)]
pub(crate) struct TerminalInputs {
    routes: Arc<Mutex<RouteTable>>,
}

/// The routes plus a serial per route, so a terminal that is still tearing down can never
/// unroute a newer terminal that reuses its stream id.
#[derive(Default)]
struct RouteTable {
    routes: HashMap<RequestId, (u64, TerminalRoute)>,
    next_serial: u64,
}

/// Input of one terminal; dropping it unroutes the stream.
pub(crate) struct TerminalInput {
    inputs: TerminalInputs,
    stream: RequestId,
    serial: u64,
    pub(crate) frames: mpsc::Receiver<StreamChunk>,
    pub(crate) resizes: mpsc::Receiver<TerminalSize>,
}

impl Drop for TerminalInput {
    /// Unroutes the stream so late frames are dropped instead of queued for nobody, unless a
    /// newer terminal already owns the stream id.
    fn drop(&mut self) {
        let mut table = self.inputs.table();
        if table
            .routes
            .get(&self.stream)
            .is_some_and(|(serial, _)| *serial == self.serial)
        {
            table.routes.remove(&self.stream);
        }
    }
}

impl TerminalInputs {
    /// Locks the table, tolerating poison because every operation leaves it consistent.
    fn table(&self) -> std::sync::MutexGuard<'_, RouteTable> {
        self.routes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Routes stream `stream` to a new terminal.
    pub(crate) fn open(&self, stream: RequestId) -> TerminalInput {
        let (input, frames) = mpsc::channel(receive_queue_frames(TERMINAL_CREDIT_WINDOW_FRAMES));
        let (resize, resizes) = mpsc::channel(RESIZE_QUEUE_SIZE);
        let mut table = self.table();
        table.next_serial = table.next_serial.wrapping_add(1);
        let serial = table.next_serial;
        table
            .routes
            .insert(stream, (serial, TerminalRoute { input, resize }));
        drop(table);
        TerminalInput {
            inputs: self.clone(),
            stream,
            serial,
            frames,
            resizes,
        }
    }

    /// Hands `chunk` to its terminal, or returns it when the stream is not a terminal.
    ///
    /// The server sends at most its credit window, so a full queue is a protocol violation;
    /// it unroutes only that terminal, whose session then ends.
    pub(crate) fn deliver(&self, chunk: StreamChunk) -> Option<StreamChunk> {
        let mut table = self.table();
        let Some((_, route)) = table.routes.get(&chunk.request_id) else {
            return Some(chunk);
        };
        let stream = chunk.request_id;
        if let Err(mpsc::error::TrySendError::Full(_)) = route.input.try_send(chunk) {
            log!(
                Level::Warning,
                "Terminal input exceeded its flow-control credit: stream={}",
                stream
            );
            table.routes.remove(&stream);
        }
        None
    }

    /// Queues a resize for terminal `stream`; resizes for unknown terminals are ignored.
    pub(crate) fn resize(&self, stream: RequestId, size: TerminalSize) {
        if let Some((_, route)) = self.table().routes.get(&stream) {
            let _ = route.resize.try_send(size);
        }
    }
}

/// Connection resources one attachment uses.
pub(crate) struct TerminalLink {
    pub(crate) stream: RequestId,
    /// Interactive lane for output frames and lifecycle events, in one order.
    pub(crate) interactive: ControlSender,
    /// Control lane for input credit grants.
    pub(crate) control: ControlSender,
    pub(crate) credits: OutputCredits,
    pub(crate) input: TerminalInput,
}

/// Tells the session the attachment ended, however the stream ends.
struct DetachGuard {
    session: TerminalSessionHandle,
    serial: u64,
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        self.session.send_detached(SessionCommand::Detach {
            serial: self.serial,
        });
    }
}

/// Serves one attachment of `session` on the link's stream until the server cancels it, the
/// connection ends, another attachment takes over or the shell's final event was sent.
///
/// The stream always ends with FIN after the last output and lifecycle event, so the server
/// knows no frame of it follows. The shell keeps running afterwards.
pub(crate) async fn attach(
    link: TerminalLink,
    session: TerminalSessionHandle,
    size: TerminalSize,
    cancel: CancellationToken,
) {
    let TerminalLink {
        stream,
        interactive,
        control,
        credits,
        input,
    } = link;
    let mut writer = StreamWriter::new(
        interactive,
        stream,
        credits.register_with_window(stream, TERMINAL_CREDIT_WINDOW_FRAMES),
    );
    let Ok(AttachedViewer {
        serial,
        frames,
        reason,
        input: queue,
    }) = session.attach(size).await
    else {
        send_event(&mut writer, stream, session_gone()).await;
        writer.send(Bytes::new(), true).await;
        return;
    };
    let _detach = DetachGuard {
        session: session.clone(),
        serial,
    };
    tokio::select! {
        () = cancel.cancelled() => {}
        () = forward_frames(frames, reason, &mut writer, stream) => {}
        () = apply_input(input, queue, &session, serial, &control, stream) => {}
    }
    writer.send(Bytes::new(), true).await;
}

/// The event of an attach whose session is gone, such as after the agent restarted.
fn session_gone() -> TerminalServerMessage {
    TerminalServerMessage::Error {
        message: "Terminal session no longer exists".to_string(),
    }
}

/// Relays the session's frames to the stream until the session lets this attachment go or
/// sends the shell's final event.
async fn forward_frames(
    mut frames: mpsc::Receiver<ViewerFrame>,
    mut reason: oneshot::Receiver<DetachReason>,
    writer: &mut StreamWriter,
    stream: RequestId,
) {
    loop {
        let frame = tokio::select! {
            biased;
            _ = &mut reason => return,
            frame = frames.recv() => frame,
        };
        match frame {
            None => return,
            Some(ViewerFrame::Output(bytes)) => {
                // Waiting for credit must not hide a takeover or close.
                let sent = tokio::select! {
                    biased;
                    _ = &mut reason => return,
                    sent = writer.send(bytes, false) => sent,
                };
                if !sent {
                    return;
                }
            }
            Some(ViewerFrame::Event(event)) => {
                let last = matches!(
                    event,
                    TerminalServerMessage::Exit { .. } | TerminalServerMessage::Error { .. }
                );
                send_event(writer, stream, event).await;
                if last {
                    return;
                }
            }
        }
    }
}

/// Hands input frames to the session's PTY queue, applies resizes and returns credit for
/// consumed input. Only returns when the input route is gone, which ends the attachment.
async fn apply_input(
    mut input: TerminalInput,
    mut queue: Option<mpsc::Sender<InputChunk>>,
    session: &TerminalSessionHandle,
    serial: u64,
    control: &ControlSender,
    stream: RequestId,
) {
    let mut ledger = CreditLedger::default();
    loop {
        let event = tokio::select! {
            size = input.resizes.recv() => size.map(InputEvent::Resize),
            chunk = input.frames.recv() => chunk.map(InputEvent::Frame),
        };
        match event {
            None => return,
            Some(InputEvent::Resize(size)) => {
                if size.validate().is_err()
                    || session
                        .send(SessionCommand::Resize { serial, size })
                        .await
                        .is_err()
                {
                    return;
                }
            }
            Some(InputEvent::Frame(chunk)) => {
                let consumes_credit = chunk.consumes_credit();
                if let Some(sender) = &queue
                    && !chunk.data.is_empty()
                {
                    let bytes = chunk.data;
                    if sender.send(InputChunk { serial, bytes }).await.is_err() {
                        // The shell is gone; its exit reaches the server on the output side.
                        queue = None;
                    }
                }
                if let Some(frames) = ledger.drained(consumes_credit) {
                    let grant = AgentToServer::Credit { stream, frames };
                    let _ = control.send(OutboundFrame::message(grant)).await;
                }
            }
        }
    }
}

/// One piece of terminal input from the server.
enum InputEvent {
    Resize(TerminalSize),
    Frame(StreamChunk),
}

/// Sends one lifecycle event on the attachment's own lane, ordered with its output.
async fn send_event(writer: &mut StreamWriter, stream: RequestId, event: TerminalServerMessage) {
    writer
        .send_message(AgentToServer::TerminalEvent { stream, event })
        .await;
}

/// Answers a `terminal_attach` the agent cannot honor with an error event and FIN, so the
/// browser shows the reason instead of waiting for a ready event that never comes.
///
/// Both frames are exempt from credit, so no credit registration is needed for a stream that
/// never started.
pub(crate) async fn refuse(interactive: ControlSender, stream: RequestId, message: &str) {
    let event = AgentToServer::TerminalEvent {
        stream,
        event: TerminalServerMessage::Error {
            message: message.to_string(),
        },
    };
    if interactive
        .send(OutboundFrame::message(event))
        .await
        .is_ok()
    {
        let _ = interactive
            .send(OutboundFrame::stream(StreamChunk::data(
                stream,
                Vec::new(),
                true,
            )))
            .await;
    }
}

/// Reads a live PTY for its session.
pub(crate) struct LivePtyOutput {
    reader: pty_process::OwnedReadPty,
    buffer: Vec<u8>,
}

impl PtyOutput for LivePtyOutput {
    async fn recv(&mut self) -> Option<Bytes> {
        // Linux reports a PTY whose other side closed as EIO, which ends output like EOF.
        let read = self.reader.read(&mut self.buffer).await.ok()?;
        (read > 0).then(|| Bytes::copy_from_slice(&self.buffer[..read]))
    }
}

/// Writes to a live PTY through its writer task, so a shell that does not read never blocks
/// the session loop.
#[derive(Clone)]
pub(crate) struct LivePtyInput {
    writes: mpsc::Sender<Bytes>,
    size: Arc<watch::Sender<TerminalSize>>,
}

impl PtyInput for LivePtyInput {
    async fn send(&self, bytes: Bytes) -> Result<(), ()> {
        self.writes.send(bytes).await.map_err(|_| ())
    }

    fn resize(&self, size: TerminalSize) {
        self.size.send_replace(size);
    }
}

/// Owns the PTY's write side: writes keystrokes and applies the latest size, until the
/// session drops its input.
async fn write_pty(
    mut pty: pty_process::OwnedWritePty,
    mut writes: mpsc::Receiver<Bytes>,
    mut size: watch::Receiver<TerminalSize>,
) {
    loop {
        tokio::select! {
            biased;
            changed = size.changed() => {
                if changed.is_err() {
                    return;
                }
                let size = *size.borrow_and_update();
                resize_pty(&pty, size);
            }
            bytes = writes.recv() => {
                let Some(bytes) = bytes else { return };
                if pty.write_all(&bytes).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Validates a size again before invoking the PTY ioctl; a failed resize only logs, because
/// the shell keeps working at its old size.
fn resize_pty(pty: &pty_process::OwnedWritePty, size: TerminalSize) {
    if size.validate().is_err() {
        return;
    }
    if let Err(error) = pty.resize(pty_process::Size::new(size.rows, size.cols)) {
        log!(Level::Warning, "Failed to resize a PTY: {error}");
    }
}

/// Waits for the shell to exit or to be killed, reports how it ended and then stops what is
/// left of its session's processes, which closes the PTY.
async fn watch_shell(
    mut child: Child,
    process_group_id: i32,
    exit: oneshot::Sender<TerminalServerMessage>,
    kill: CancellationToken,
) {
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        () = kill.cancelled() => None,
    };
    if let Some(status) = status {
        let _ = exit.send(TerminalServerMessage::Exit {
            code: status.code(),
            signal: status.signal(),
        });
    }
    teardown_process_group(&mut child, process_group_id).await;
}

/// Allocates the PTY, starts the login shell in `cwd` with the extra variables `env` from the
/// server and wires it for a session.
pub(crate) fn start_pty(
    size: TerminalSize,
    cwd: &str,
    env: &BTreeMap<String, String>,
) -> Result<PtyIo<LivePtyOutput, LivePtyInput>> {
    let (pty, pts) = pty_process::open().context("failed to allocate PTY")?;
    pty.resize(pty_process::Size::new(size.rows, size.cols))
        .context("failed to set initial PTY size")?;

    // Resolve the fallback through PATH because Android/Termux has no `/bin/sh`.
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("sh"));
    // Login mode restores the user's profile environment when the agent was started by
    // a service manager such as launchd, which otherwise supplies only a minimal PATH.
    let mut command = pty_process::Command::new(shell)
        .arg("-l")
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .current_dir(cwd)
        .kill_on_drop(true);
    // After TERM, so a device's `terminal_env` can override it too.
    for (name, value) in env {
        command = command.env(name, value);
    }
    // The device's own variables count first, so a LANG set there is kept.
    let locale = utf8_locale_override(|name| {
        env.get(name)
            .map(OsString::from)
            .or_else(|| std::env::var_os(name))
    });
    if let Some(variable) = locale {
        command = command.env(variable, UTF8_FALLBACK_LOCALE);
    }
    // Last, so nothing above can put it back: the token would let anything running in the
    // shell pass as the server.
    let command = command.env_remove(redoor_core::process::AGENT_TOKEN_ENV);
    let child = command
        .spawn(pts)
        .context("failed to spawn terminal shell")?;
    let process_group_id = child
        .id()
        .ok_or_else(|| anyhow!("terminal shell has no process id"))?;
    let process_group_id =
        i32::try_from(process_group_id).context("terminal process id is too large")?;
    // A duplicate of the controller, because the split halves do not expose theirs and the
    // probe asks it for the foreground process group.
    let controller = pty
        .as_fd()
        .try_clone_to_owned()
        .context("failed to duplicate the PTY")?;
    let (reader, writer) = pty.into_split();

    let (writes, write_queue) = mpsc::channel(PTY_WRITE_QUEUE);
    let (size_tx, size_rx) = watch::channel(size);
    tokio::spawn(write_pty(writer, write_queue, size_rx));
    let (exit_tx, exit) = oneshot::channel();
    let kill = CancellationToken::new();
    tokio::spawn(watch_shell(child, process_group_id, exit_tx, kill.clone()));
    Ok(PtyIo {
        output: LivePtyOutput {
            reader,
            buffer: vec![0; PTY_BUFFER_SIZE],
        },
        input: LivePtyInput {
            writes,
            size: Arc::new(size_tx),
        },
        exit,
        kill: Some(kill.drop_guard()),
        probe: Some(activity::ProcessProbe::new(controller, process_group_id)),
    })
}

/// Sends escalating signals to every PTY session member and reaps its leader.
async fn teardown_process_group(child: &mut Child, process_group_id: i32) {
    signal_terminal_session(process_group_id, Signal::SIGHUP).await;
    let _ = timeout(PROCESS_EXIT_GRACE, child.wait()).await;
    signal_terminal_session(process_group_id, Signal::SIGKILL).await;
    let _ = child.wait().await;
}

/// Signals both the leader group and jobs moved into separate interactive process groups.
async fn signal_terminal_session(session_id: i32, signal: Signal) {
    signal_process_group(session_id, signal);
    for process_id in terminal_session_processes(session_id).await {
        match kill(process_id, signal) {
            Ok(()) | Err(Errno::ESRCH) => {}
            Err(_) => {}
        }
    }
}

/// Enumerates Linux process metadata asynchronously so teardown never blocks the actor runtime.
async fn terminal_session_processes(session_id: i32) -> Vec<Pid> {
    let Ok(mut entries) = tokio::fs::read_dir("/proc").await else {
        return Vec::new();
    };
    let mut processes = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        let Ok(stat) = tokio::fs::read_to_string(entry.path().join("stat")).await else {
            continue;
        };
        if process_session_id(&stat) == Some(session_id) {
            processes.push(Pid::from_raw(process_id));
        }
    }
    processes
}

/// The locale a terminal shell gets when it would otherwise run without UTF-8. glibc, musl
/// and Android's bionic all build `C.UTF-8` in, so it works without installed locales; macOS
/// has no `C.UTF-8` on older releases but always ships `en_US.UTF-8`.
#[cfg(target_os = "macos")]
const UTF8_FALLBACK_LOCALE: &str = "en_US.UTF-8";
#[cfg(not(target_os = "macos"))]
const UTF8_FALLBACK_LOCALE: &str = "C.UTF-8";

/// Picks the locale variable a terminal shell needs set to [`UTF8_FALLBACK_LOCALE`], or `None`
/// when the inherited locale is already UTF-8.
///
/// The browser terminal always speaks UTF-8, and terminal emulators normally say so through the
/// locale, as iTerm2 does and SSH forwards. The agent is started over a non-interactive SSH
/// command or by a service manager, so it often inherits `LANG=C` or no locale at all, and
/// programs such as btop then refuse to start or draw mojibake. Only the variable that decides
/// the character type (`LC_ALL`, then `LC_CTYPE`, then `LANG`) is replaced, so the user's other
/// locale categories stay as they were.
fn utf8_locale_override(var: impl Fn(&str) -> Option<OsString>) -> Option<&'static str> {
    let deciding = ["LC_ALL", "LC_CTYPE", "LANG"].into_iter().find_map(|name| {
        var(name)
            .filter(|value| !value.is_empty())
            .map(|value| (name, value))
    });
    match deciding {
        Some((name, value)) => {
            let value = value.to_string_lossy().to_ascii_lowercase();
            (!value.contains("utf-8") && !value.contains("utf8")).then_some(name)
        }
        None => Some("LANG"),
    }
}

/// Extracts the session field while allowing spaces and parentheses in a process name.
fn process_session_id(stat: &str) -> Option<i32> {
    stat.rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()
}

/// Ignores a missing process group because it means teardown has already won the race.
fn signal_process_group(process_group_id: i32, signal: Signal) {
    match killpg(Pid::from_raw(process_group_id), signal) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{process_session_id, utf8_locale_override};
    use std::ffi::OsString;

    /// Runs [`utf8_locale_override`] against a fixed environment instead of the process one.
    fn locale_override(env: &[(&str, &str)]) -> Option<&'static str> {
        utf8_locale_override(|name| {
            env.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        })
    }

    /// A shell must not be left without UTF-8 when the agent's environment has no locale or
    /// a non-UTF-8 one, and only the variable deciding the character type is replaced.
    #[test]
    fn non_utf8_locale_is_overridden_in_the_deciding_variable() {
        // No locale at all, as under a bare service manager, gets LANG.
        assert_eq!(locale_override(&[]), Some("LANG"));
        // Debian hosts without a configured locale default to LANG=C.
        assert_eq!(locale_override(&[("LANG", "C")]), Some("LANG"));
        // An empty LC_ALL does not count, so LC_CTYPE decides and is the one replaced.
        assert_eq!(
            locale_override(&[
                ("LC_ALL", ""),
                ("LC_CTYPE", "POSIX"),
                ("LANG", "en_US.UTF-8")
            ]),
            Some("LC_CTYPE")
        );
        // LC_ALL overrides everything else, so setting LANG alone would not help.
        assert_eq!(
            locale_override(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")]),
            Some("LC_ALL")
        );
    }

    /// A UTF-8 locale the user already has is kept, whatever spelling it uses.
    #[test]
    fn utf8_locale_is_kept() {
        // The common glibc spelling.
        assert_eq!(locale_override(&[("LANG", "fi_FI.UTF-8")]), None);
        // `locale -a` lists names in the lowercase `utf8` form.
        assert_eq!(locale_override(&[("LANG", "C.utf8")]), None);
        // macOS terminals set only LC_CTYPE=UTF-8, which wins over a non-UTF-8 LANG.
        assert_eq!(
            locale_override(&[("LC_CTYPE", "UTF-8"), ("LANG", "C")]),
            None
        );
    }

    /// Verifies process names cannot shift the session field parsed from procfs.
    #[test]
    fn parses_proc_session_id_with_complex_process_name() {
        let stat = "123 (shell (worker)) S 1 123 456 0";

        // The sixth proc stat field identifies every process belonging to the PTY session.
        assert_eq!(process_session_id(stat), Some(456));
    }

    /// A terminal still tearing down must not unroute a newer terminal with the same id.
    #[test]
    fn stale_input_drop_keeps_the_newer_route() {
        let inputs = super::TerminalInputs::default();
        let stream = redoor_protocol::ids::RequestId::new(3);
        let old = inputs.open(stream);
        let mut new = inputs.open(stream);
        drop(old);
        let chunk = redoor_protocol::wire::stream::StreamChunk::data(stream, b"k".to_vec(), false);
        // The newer terminal still receives its input after the old one went away.
        assert!(inputs.deliver(chunk).is_none());
        assert!(new.frames.try_recv().is_ok());
    }

    /// A refused terminal tells the browser why and ends its stream.
    #[tokio::test]
    async fn refused_terminal_sends_an_error_then_fin() {
        let (lane, mut frames) = tokio::sync::mpsc::channel(4);
        let stream = redoor_protocol::ids::RequestId::new(9);
        super::refuse(lane, stream, "full").await;
        // The error event comes first so the bridge reports the reason.
        assert!(matches!(
            frames.recv().await.unwrap().as_message(),
            Some(redoor_protocol::wire::AgentToServer::TerminalEvent {
                event: redoor_protocol::wire::terminal::TerminalServerMessage::Error { .. },
                ..
            })
        ));
        // FIN then tells the server no frame of the stream follows.
        assert!(
            frames
                .recv()
                .await
                .unwrap()
                .as_stream()
                .is_some_and(|chunk| chunk.is_last)
        );
    }
}
