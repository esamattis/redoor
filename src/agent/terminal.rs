use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt, stream::SplitSink, stream::SplitStream};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill, killpg},
    unistd::Pid,
};
use redoor::terminal_protocol::{
    TerminalAgentHandshake, TerminalClientMessage, TerminalId, TerminalServerMessage, TerminalSize,
};
use std::{ffi::OsString, os::unix::process::ExitStatusExt, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::Child,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async, tungstenite::protocol::Message as WsMessage,
};

const PTY_BUFFER_SIZE: usize = 8 * 1024;
const OUTPUT_QUEUE_SIZE: usize = 8;
const CONTROL_QUEUE_SIZE: usize = 8;
const PROCESS_EXIT_GRACE: Duration = Duration::from_secs(2);

type TerminalSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type TerminalSink = SplitSink<TerminalSocket, WsMessage>;
type TerminalStream = SplitStream<TerminalSocket>;

/// One prioritized websocket command with optional delivery acknowledgement.
struct SocketCommand {
    message: WsMessage,
    sent: Option<oneshot::Sender<Result<(), String>>>,
}

/// Identifies which independently backpressured terminal component stopped first.
enum SessionEnd {
    Cancelled,
    Child(std::process::ExitStatus),
    PtyReader(Result<()>),
    SocketReader(Result<()>),
    SocketWriter(Result<()>),
}

/// Builds the dedicated data-plane URL without making assumptions about its authority.
fn terminal_url(server_url: &str, terminal_id: &TerminalId) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(server_url).context("invalid agent websocket URL")?;
    url.set_path(&format!("/api/v1/terminals/{}/agent/ws", terminal_id.0));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Connects one dedicated websocket and owns the PTY until all descendants are torn down.
pub(crate) async fn connect_and_run(
    server_url: &str,
    terminal_id: TerminalId,
    token: String,
    size: TerminalSize,
    mut cancel_receiver: watch::Receiver<bool>,
) -> Result<()> {
    size.validate()
        .map_err(|error| anyhow!(error.to_string()))?;
    let url = terminal_url(server_url, &terminal_id)?;
    if *cancel_receiver.borrow() {
        return Ok(());
    }
    let connection = tokio::select! {
        _ = cancel_receiver.changed() => return Ok(()),
        result = connect_async(url.as_str()) => result,
    };
    let (mut socket, _) = connection.context("failed to connect dedicated terminal websocket")?;

    let handshake = TerminalAgentHandshake::Authenticate { token };
    let handshake =
        serde_json::to_string(&handshake).context("failed to encode terminal handshake")?;
    let authenticated = tokio::select! {
        _ = cancel_receiver.changed() => return Ok(()),
        result = socket.send(WsMessage::text(handshake)) => result,
    };
    authenticated.context("failed to authenticate dedicated terminal websocket")?;

    match start_pty(size) {
        Ok((reader, writer, child, process_group_id)) => {
            run_pty_session(
                socket,
                reader,
                writer,
                child,
                process_group_id,
                cancel_receiver,
            )
            .await
        }
        Err(error) => {
            let _ = timeout(
                PROCESS_EXIT_GRACE,
                send_setup_error(&mut socket, "Failed to start terminal"),
            )
            .await;
            Err(error)
        }
    }
}

/// Allocates and starts the shell only after the dedicated socket handshake is sent.
fn start_pty(
    size: TerminalSize,
) -> Result<(
    pty_process::OwnedReadPty,
    pty_process::OwnedWritePty,
    Child,
    i32,
)> {
    let (pty, pts) = pty_process::open().context("failed to allocate PTY")?;
    pty.resize(pty_process::Size::new(size.rows, size.cols))
        .context("failed to set initial PTY size")?;

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/sh"));
    let command = pty_process::Command::new(shell)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .kill_on_drop(true);
    let child = command
        .spawn(pts)
        .context("failed to spawn terminal shell")?;
    let process_group_id = child
        .id()
        .ok_or_else(|| anyhow!("terminal shell has no process id"))?;
    let process_group_id =
        i32::try_from(process_group_id).context("terminal process id is too large")?;
    let (reader, writer) = pty.into_split();
    Ok((reader, writer, child, process_group_id))
}

/// Reports setup failure while the socket is still available, then closes it.
async fn send_setup_error(socket: &mut TerminalSocket, message: &str) {
    let notification = TerminalServerMessage::Error {
        message: message.to_owned(),
    };
    if let Ok(json) = serde_json::to_string(&notification) {
        let _ = socket.send(WsMessage::text(json)).await;
    }
    let _ = socket.close(None).await;
}

/// Runs bounded bridge tasks and always tears down and reaps the process group.
async fn run_pty_session(
    socket: TerminalSocket,
    reader: pty_process::OwnedReadPty,
    writer: pty_process::OwnedWritePty,
    mut child: Child,
    process_group_id: i32,
    mut cancel_receiver: watch::Receiver<bool>,
) -> Result<()> {
    let (socket_sink, socket_stream) = socket.split();
    let (output_sender, output_receiver) = mpsc::channel(OUTPUT_QUEUE_SIZE);
    let (control_sender, control_receiver) = mpsc::channel(CONTROL_QUEUE_SIZE);
    let (shutdown_sender, shutdown_receiver) = watch::channel(false);

    let mut pty_reader = tokio::spawn(read_pty(reader, output_sender, shutdown_receiver.clone()));
    let mut socket_reader = tokio::spawn(control_pty(
        socket_stream,
        writer,
        control_sender.clone(),
        shutdown_receiver.clone(),
    ));
    let mut socket_writer = tokio::spawn(write_socket(
        socket_sink,
        control_receiver,
        output_receiver,
        shutdown_receiver,
    ));

    let mut end = match send_ready_or_cancel(&control_sender, &mut cancel_receiver).await {
        Ok(true) => {
            wait_for_session_end(
                &mut child,
                &mut cancel_receiver,
                &mut pty_reader,
                &mut socket_reader,
                &mut socket_writer,
            )
            .await
        }
        Ok(false) => SessionEnd::Cancelled,
        Err(error) => SessionEnd::SocketWriter(Err(error)),
    };

    end = resolve_pty_end(end, &mut child).await;

    if let SessionEnd::Child(status) = &end {
        let notification = exit_notification(status);
        let _ = timeout(
            PROCESS_EXIT_GRACE,
            send_lifecycle(&control_sender, notification),
        )
        .await;
    }

    let pty_reader_completed = matches!(end, SessionEnd::PtyReader(_));
    let socket_reader_completed = matches!(end, SessionEnd::SocketReader(_));
    let socket_writer_completed = matches!(end, SessionEnd::SocketWriter(_));
    let _ = shutdown_sender.send(true);
    drop(control_sender);
    teardown_process_group(&mut child, process_group_id).await;
    if !pty_reader_completed {
        finish_task(pty_reader).await;
    }
    if !socket_reader_completed {
        finish_task(socket_reader).await;
    }
    if !socket_writer_completed {
        finish_task(socket_writer).await;
    }
    session_result(end)
}

/// Sends readiness while still allowing control-plane loss to cancel setup promptly.
async fn send_ready_or_cancel(
    control_sender: &mpsc::Sender<SocketCommand>,
    cancel_receiver: &mut watch::Receiver<bool>,
) -> Result<bool> {
    if *cancel_receiver.borrow() {
        return Ok(false);
    }
    tokio::select! {
        _ = cancel_receiver.changed() => Ok(false),
        result = send_lifecycle(control_sender, TerminalServerMessage::Ready) => result.map(|()| true),
    }
}

/// Gives PTY EOF a short chance to produce the child status used by the exit lifecycle.
async fn resolve_pty_end(end: SessionEnd, child: &mut Child) -> SessionEnd {
    if !matches!(end, SessionEnd::PtyReader(_)) {
        return end;
    }
    match timeout(Duration::from_millis(100), child.wait()).await {
        Ok(Ok(status)) => SessionEnd::Child(status),
        _ => end,
    }
}

/// Waits for the first authoritative terminal-ending event with small select arms.
async fn wait_for_session_end(
    child: &mut Child,
    cancel_receiver: &mut watch::Receiver<bool>,
    pty_reader: &mut JoinHandle<Result<()>>,
    socket_reader: &mut JoinHandle<Result<()>>,
    socket_writer: &mut JoinHandle<Result<()>>,
) -> SessionEnd {
    if *cancel_receiver.borrow() {
        return SessionEnd::Cancelled;
    }
    tokio::select! {
        _ = cancel_receiver.changed() => SessionEnd::Cancelled,
        status = child.wait() => child_end(status),
        result = pty_reader => SessionEnd::PtyReader(join_result(result)),
        result = socket_reader => SessionEnd::SocketReader(join_result(result)),
        result = socket_writer => SessionEnd::SocketWriter(join_result(result)),
    }
}

/// Converts child wait failures into a task-style terminal result.
fn child_end(status: std::io::Result<std::process::ExitStatus>) -> SessionEnd {
    match status {
        Ok(status) => SessionEnd::Child(status),
        Err(error) => SessionEnd::PtyReader(Err(error.into())),
    }
}

/// Preserves worker errors while giving task panics an actionable boundary error.
fn join_result(result: Result<Result<()>, tokio::task::JoinError>) -> Result<()> {
    result.context("terminal bridge task failed")?
}

/// Converts the first bridge completion into the terminal task's public result.
fn session_result(end: SessionEnd) -> Result<()> {
    match end {
        SessionEnd::Cancelled | SessionEnd::Child(_) => Ok(()),
        SessionEnd::PtyReader(result)
        | SessionEnd::SocketReader(result)
        | SessionEnd::SocketWriter(result) => result,
    }
}

/// Reads fixed-size PTY chunks into a bounded queue so output cannot grow without limit.
async fn read_pty(
    mut reader: pty_process::OwnedReadPty,
    output_sender: mpsc::Sender<Vec<u8>>,
    mut shutdown_receiver: watch::Receiver<bool>,
) -> Result<()> {
    let mut buffer = vec![0; PTY_BUFFER_SIZE];
    loop {
        let read = tokio::select! {
            _ = shutdown_receiver.changed() => return Ok(()),
            read = reader.read(&mut buffer) => read,
        }?;
        if read == 0 {
            return Ok(());
        }
        let output = buffer[..read].to_vec();
        tokio::select! {
            _ = shutdown_receiver.changed() => return Ok(()),
            result = output_sender.send(output) => {
                if result.is_err() {
                    return Ok(());
                }
            }
        }
    }
}

/// Applies browser input and validated resizes while independently observing socket EOF.
async fn control_pty(
    mut socket_stream: TerminalStream,
    mut writer: pty_process::OwnedWritePty,
    control_sender: mpsc::Sender<SocketCommand>,
    mut shutdown_receiver: watch::Receiver<bool>,
) -> Result<()> {
    loop {
        let message = tokio::select! {
            _ = shutdown_receiver.changed() => return Ok(()),
            message = socket_stream.next() => message,
        };
        let Some(message) = message else {
            return Ok(());
        };
        if !handle_socket_message(message?, &mut writer, &control_sender).await? {
            return Ok(());
        }
    }
}

/// Handles one dedicated-socket frame without retaining terminal payloads.
async fn handle_socket_message(
    message: WsMessage,
    writer: &mut pty_process::OwnedWritePty,
    control_sender: &mpsc::Sender<SocketCommand>,
) -> Result<bool> {
    match message {
        WsMessage::Binary(bytes) => writer
            .write_all(&bytes)
            .await
            .context("failed to write PTY input")
            .map(|()| true),
        WsMessage::Text(text) => resize_pty(text.as_ref(), writer).map(|()| true),
        WsMessage::Ping(bytes) => queue_socket_message(control_sender, WsMessage::Pong(bytes))
            .await
            .map(|()| true),
        WsMessage::Pong(_) => Ok(true),
        WsMessage::Close(_) => Ok(false),
        _ => bail!("unsupported terminal websocket frame"),
    }
}

/// Parses and validates resize controls again before invoking the PTY ioctl.
fn resize_pty(text: &str, writer: &pty_process::OwnedWritePty) -> Result<()> {
    let message: TerminalClientMessage =
        serde_json::from_str(text).context("invalid terminal control message")?;
    match message {
        TerminalClientMessage::Resize { size } => {
            size.validate()
                .map_err(|error| anyhow!(error.to_string()))?;
            writer
                .resize(pty_process::Size::new(size.rows, size.cols))
                .context("failed to resize PTY")
        }
    }
}

/// Queues a protocol-level websocket response without bypassing bounded backpressure.
async fn queue_socket_message(
    control_sender: &mpsc::Sender<SocketCommand>,
    message: WsMessage,
) -> Result<()> {
    control_sender
        .send(SocketCommand {
            message,
            sent: None,
        })
        .await
        .context("terminal websocket writer stopped")
}

/// Serializes a lifecycle notification and waits until the websocket sink accepts it.
async fn send_lifecycle(
    control_sender: &mpsc::Sender<SocketCommand>,
    message: TerminalServerMessage,
) -> Result<()> {
    let json = serde_json::to_string(&message).context("failed to encode terminal lifecycle")?;
    let (sent, received) = oneshot::channel();
    control_sender
        .send(SocketCommand {
            message: WsMessage::text(json),
            sent: Some(sent),
        })
        .await
        .context("terminal websocket writer stopped")?;
    received
        .await
        .context("terminal websocket writer dropped lifecycle acknowledgement")?
        .map_err(anyhow::Error::msg)
}

/// Prioritizes lifecycle and protocol controls over bounded PTY output frames.
async fn write_socket(
    mut socket_sink: TerminalSink,
    mut control_receiver: mpsc::Receiver<SocketCommand>,
    mut output_receiver: mpsc::Receiver<Vec<u8>>,
    mut shutdown_receiver: watch::Receiver<bool>,
) -> Result<()> {
    let mut control_closed = false;
    let mut output_closed = false;
    loop {
        let message = tokio::select! {
            biased;
            command = control_receiver.recv(), if !control_closed => take_socket_command(command, &mut control_closed),
            _ = shutdown_receiver.changed() => break,
            output = output_receiver.recv(), if !output_closed => take_output_message(output, &mut output_closed),
            else => break,
        };
        let Some(mut command) = message else {
            continue;
        };
        let result = socket_sink.send(command.message).await;
        if let Some(sent) = command.sent.take() {
            let _ = sent.send(result.as_ref().map(|_| ()).map_err(ToString::to_string));
        }
        result.context("failed to send terminal websocket frame")?;
    }
    let _ = socket_sink.send(WsMessage::Close(None)).await;
    let _ = socket_sink.close().await;
    Ok(())
}

/// Marks the control lane closed without prematurely dropping pending PTY output.
fn take_socket_command(
    command: Option<SocketCommand>,
    control_closed: &mut bool,
) -> Option<SocketCommand> {
    if command.is_none() {
        *control_closed = true;
    }
    command
}

/// Marks PTY EOF while preserving the control lane for a final exit notification.
fn take_output_message(output: Option<Vec<u8>>, output_closed: &mut bool) -> Option<SocketCommand> {
    if output.is_none() {
        *output_closed = true;
    }
    output.map(|bytes| SocketCommand {
        message: WsMessage::Binary(bytes.into()),
        sent: None,
    })
}

/// Produces the lifecycle status understood by the browser for a reaped child.
fn exit_notification(status: &std::process::ExitStatus) -> TerminalServerMessage {
    TerminalServerMessage::Exit {
        code: status.code(),
        signal: status.signal(),
    }
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

/// Joins a cancelled bridge task, aborting only if it did not observe shutdown promptly.
async fn finish_task(mut task: JoinHandle<Result<()>>) {
    if timeout(PROCESS_EXIT_GRACE, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::process_session_id;

    /// Verifies process names cannot shift the session field parsed from procfs.
    #[test]
    fn parses_proc_session_id_with_complex_process_name() {
        let stat = "123 (shell (worker)) S 1 123 456 0";

        // The sixth proc stat field identifies every process belonging to the PTY session.
        assert_eq!(process_session_id(stat), Some(456));
    }
}
