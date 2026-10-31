//! Headless terminal emulator that mirrors one session's screen, so a browser that attaches
//! later can be given the screen, cursor and input modes it would have had if it had stayed.
//!
//! The emulator is `libghostty-vt`, the engine the browser renders with, so the server
//! parses output exactly as the client does. Its types are `!Send`, so each session's
//! emulator lives on its own thread and this module's async handle talks to it over one
//! ordered channel. FFI and threading stay in this module.

use super::pending_tail::PendingTail;
use bytes::Bytes;
use libghostty_vt::{
    Terminal, TerminalOptions,
    fmt::{Format, Formatter, FormatterOptions},
    terminal::{CompressionMode, CompressionResult},
};
use redoor_core::log;
use redoor_protocol::wire::{log::Level, terminal::TerminalSize};
use tokio::sync::{mpsc, oneshot};

/// Scrollback lines a snapshot can restore. Bounds both the mirror's memory and the size of
/// the first frame a re-attaching browser receives. Measured: a 200x60 mirror with full
/// scrollback takes about 2 MiB, and its snapshot about 90 KiB.
pub(crate) const TERMINAL_SNAPSHOT_SCROLLBACK_LINES: usize = 1000;
/// Commands queued for the emulator thread. Small, because output waits for a slot before it
/// is pulled from the agent, which turns a busy emulator into agent backpressure.
const MIRROR_QUEUE: usize = 4;
/// Full reset, so a browser emulator reused after a takeover starts from a clean state.
const RIS: &[u8] = b"\x1bc";
/// Nominal cell size passed on resize; only image protocols and pixel reports use it.
const CELL_WIDTH_PX: u32 = 8;
const CELL_HEIGHT_PX: u32 = 16;

/// Work for the emulator thread, applied strictly in order.
enum MirrorCommand {
    Feed(Bytes),
    Resize(TerminalSize),
    /// Serializes the state as of every feed queued before it.
    Snapshot(oneshot::Sender<Vec<u8>>),
    Compress(CompressionMode),
}

/// The emulator thread is gone (it failed to start or panicked); the session cannot be
/// restored any more.
#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("Terminal emulator failed")]
pub(crate) struct MirrorFailed;

/// Async handle to one session's emulator thread. Dropping it ends the thread.
pub(crate) struct ScreenMirror {
    commands: mpsc::Sender<MirrorCommand>,
}

/// A reserved slot on the emulator's queue, taken before a chunk is pulled from the agent so
/// the chunk can always be fed without waiting.
pub(crate) struct MirrorPermit(mpsc::OwnedPermit<MirrorCommand>);

impl MirrorPermit {
    /// Feeds one chunk of PTY output.
    pub(crate) fn feed(self, bytes: Bytes) {
        self.0.send(MirrorCommand::Feed(bytes));
    }
}

impl ScreenMirror {
    /// Starts the emulator thread for a terminal of `size`.
    pub(crate) fn spawn(size: TerminalSize) -> Result<Self, MirrorFailed> {
        let (commands, receiver) = mpsc::channel(MIRROR_QUEUE);
        std::thread::Builder::new()
            .name("terminal-mirror".to_string())
            .spawn(move || run_mirror(size, receiver))
            .map_err(|error| {
                redoor_core::log_error!(
                    anyhow::Error::from(error),
                    "Failed to start a terminal emulator thread"
                );
                MirrorFailed
            })?;
        Ok(Self { commands })
    }

    /// A sender for the session's output arm, which reserves a slot without borrowing the
    /// session.
    pub(crate) fn sender(&self) -> MirrorSender {
        MirrorSender(self.commands.clone())
    }

    /// Applies a new size, as the PTY gets it.
    pub(crate) async fn resize(&self, size: TerminalSize) -> Result<(), MirrorFailed> {
        self.send(MirrorCommand::Resize(size)).await
    }

    /// Asks for a snapshot that reflects exactly the output fed before this call.
    ///
    /// Waits only for queue space, never for the snapshot itself, so the caller can keep
    /// serving other work while the thread serializes the screen.
    pub(crate) async fn snapshot(&self) -> Result<oneshot::Receiver<Vec<u8>>, MirrorFailed> {
        let (reply, snapshot) = oneshot::channel();
        self.send(MirrorCommand::Snapshot(reply)).await?;
        Ok(snapshot)
    }

    /// Asks the thread to compact its storage, `Full` once for an exited session and
    /// `Incremental` while a running one is idle.
    pub(crate) async fn compress(&self, mode: CompressionMode) -> Result<(), MirrorFailed> {
        self.send(MirrorCommand::Compress(mode)).await
    }

    /// Asks for compaction only if the queue has room; compaction is opportunistic, so it
    /// is never worth waiting for.
    pub(crate) fn try_compress(&self, mode: CompressionMode) {
        let _ = self.commands.try_send(MirrorCommand::Compress(mode));
    }

    /// Queues a command; the thread only ever does bounded CPU work, so waiting for a slot
    /// cannot wait on a browser or the agent.
    async fn send(&self, command: MirrorCommand) -> Result<(), MirrorFailed> {
        self.commands.send(command).await.map_err(|_| MirrorFailed)
    }
}

/// A clone of the emulator queue's sender that output arms can own.
#[derive(Clone)]
pub(crate) struct MirrorSender(mpsc::Sender<MirrorCommand>);

impl MirrorSender {
    /// Waits for a queue slot for one output chunk.
    pub(crate) async fn reserve(self) -> Result<MirrorPermit, MirrorFailed> {
        self.0
            .reserve_owned()
            .await
            .map(MirrorPermit)
            .map_err(|_| MirrorFailed)
    }
}

/// The emulator and what it needs beyond the screen to make a faithful snapshot.
struct MirrorState {
    terminal: Terminal<'static, 'static>,
    tail: PendingTail,
}

/// Thread body: applies commands until the session drops its handle.
fn run_mirror(size: TerminalSize, mut commands: mpsc::Receiver<MirrorCommand>) {
    let terminal = Terminal::new(TerminalOptions {
        cols: size.cols,
        rows: size.rows,
        max_scrollback: TERMINAL_SNAPSHOT_SCROLLBACK_LINES,
    });
    let mut state = match terminal {
        Ok(terminal) => MirrorState {
            terminal,
            tail: PendingTail::default(),
        },
        Err(error) => {
            redoor_core::log_error!(
                anyhow::Error::from(error),
                "Failed to create a terminal emulator"
            );
            return;
        }
    };
    while let Some(command) = commands.blocking_recv() {
        match command {
            MirrorCommand::Feed(bytes) => state.feed(&bytes),
            MirrorCommand::Resize(size) => state.resize(size),
            MirrorCommand::Snapshot(reply) => {
                let _ = reply.send(state.snapshot());
            }
            MirrorCommand::Compress(mode) => state.compress(mode, &commands),
        }
    }
}

impl MirrorState {
    /// Parses one chunk of PTY output.
    fn feed(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
        self.tail.feed(bytes);
    }

    /// Resizes the screen; the primary screen reflows like the browser's does.
    fn resize(&mut self, size: TerminalSize) {
        if let Err(error) =
            self.terminal
                .resize(size.cols, size.rows, CELL_WIDTH_PX, CELL_HEIGHT_PX)
        {
            log!(
                Level::Warning,
                "Failed to resize a terminal mirror: {error}"
            );
        }
    }

    /// Serializes screen, scrollback, cursor and modes, plus the unfinished sequence.
    fn snapshot(&self) -> Vec<u8> {
        let mut snapshot = RIS.to_vec();
        match format_vt(&self.terminal) {
            Ok(formatted) => snapshot.extend_from_slice(&formatted),
            Err(error) => log!(
                Level::Warning,
                "Failed to format a terminal mirror: {error}"
            ),
        }
        snapshot.extend_from_slice(self.tail.bytes());
        snapshot
    }

    /// Compacts storage. Incremental steps continue only while no other work is queued, so
    /// compaction never delays output.
    fn compress(&mut self, mode: CompressionMode, commands: &mpsc::Receiver<MirrorCommand>) {
        loop {
            match self.terminal.compress(mode) {
                Ok(CompressionResult::Pending)
                    if mode == CompressionMode::Incremental && commands.is_empty() => {}
                Ok(_) => return,
                Err(error) => {
                    log!(Level::Debug, "Terminal mirror compression failed: {error}");
                    return;
                }
            }
        }
    }
}

/// Renders the terminal as VT sequences that rebuild it in a fresh emulator.
fn format_vt(terminal: &Terminal<'static, 'static>) -> libghostty_vt::error::Result<Vec<u8>> {
    let options = FormatterOptions::new()
        .with_format(Format::Vt)
        .with_modes(true)
        .with_cursor(true)
        .with_style(true)
        .with_scrolling_region(true)
        // Tab stops are written after the cursor position, and setting them moves the
        // cursor, so including them restores the cursor in the wrong column. Shells keep the
        // default stops, which the browser's reset already restores.
        .with_tabstops(false)
        .with_charsets(true)
        .with_keyboard(true);
    let mut formatter = Formatter::new(terminal, options)?;
    Ok(formatter.format_alloc(None)?.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libghostty_vt::terminal::Mode;

    /// Builds an emulator like the mirror's, standing in for the browser in comparisons.
    fn browser(cols: u16, rows: u16) -> Terminal<'static, 'static> {
        Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: TERMINAL_SNAPSHOT_SCROLLBACK_LINES,
        })
        .expect("terminal")
    }

    /// Renders text only, to compare two emulators.
    fn plain(terminal: &Terminal<'static, 'static>) -> String {
        let options = FormatterOptions::new().with_format(Format::Plain);
        let mut formatter = Formatter::new(terminal, options).expect("formatter");
        String::from_utf8(formatter.format_alloc(None).expect("format").to_vec()).expect("utf-8")
    }

    /// Renders text with styles, so colors are compared too.
    fn styled(terminal: &Terminal<'static, 'static>) -> Vec<u8> {
        format_vt(terminal).expect("format")
    }

    fn size(cols: u16, rows: u16) -> TerminalSize {
        TerminalSize::new(rows, cols).expect("size")
    }

    /// Feeds chunks through a real mirror thread and returns its snapshot.
    async fn mirror_snapshot(cols: u16, rows: u16, chunks: &[&[u8]]) -> Vec<u8> {
        let mirror = ScreenMirror::spawn(size(cols, rows)).expect("mirror");
        for chunk in chunks {
            mirror
                .sender()
                .reserve()
                .await
                .expect("slot")
                .feed(Bytes::copy_from_slice(chunk));
        }
        mirror
            .snapshot()
            .await
            .expect("queued")
            .await
            .expect("snapshot")
    }

    /// The modes the browser needs restored so keys, pastes and clicks keep working.
    const RESTORED_MODES: [Mode; 7] = [
        Mode::DECCKM,
        Mode::BRACKETED_PASTE,
        Mode::NORMAL_MOUSE,
        Mode::SGR_MOUSE,
        Mode::FOCUS_EVENT,
        Mode::CURSOR_VISIBLE,
        Mode::ALT_SCREEN_SAVE,
    ];

    /// Asserts that `restored` looks and behaves like `source`.
    fn assert_same_terminal(
        restored: &Terminal<'static, 'static>,
        source: &Terminal<'static, 'static>,
    ) {
        // The visible text, including multi-byte characters, must match.
        assert_eq!(plain(restored), plain(source));
        // Colors and attributes must match, or a reload loses syntax highlighting.
        assert_eq!(styled(restored), styled(source));
        // The cursor must be where the shell left it, or the next output lands elsewhere.
        assert_eq!(restored.cursor_x().unwrap(), source.cursor_x().unwrap());
        assert_eq!(restored.cursor_y().unwrap(), source.cursor_y().unwrap());
        for mode in RESTORED_MODES {
            // Each input mode must survive, or keys, pastes and clicks break after a reload.
            assert_eq!(
                restored.mode(mode).unwrap(),
                source.mode(mode).unwrap(),
                "mode {} differs",
                mode.value()
            );
        }
    }

    #[tokio::test]
    async fn snapshot_restores_screen_cursor_colors_and_modes() {
        let output: &[&[u8]] = &[
            b"plain line\r\n\x1b[1;31mbold red\x1b[0m and \xc3",
            // A UTF-8 character split across two feeds must still decode.
            b"\xa4\xe2\x82\xac\r\n",
            // Modes a full-screen app such as vim or htop turns on.
            b"\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h",
            b"\x1b[5;10Hcursor here",
        ];
        let snapshot = mirror_snapshot(80, 24, output).await;
        let mut source = browser(80, 24);
        for chunk in output {
            source.vt_write(chunk);
        }
        // A browser emulator reused after a takeover must be reset first.
        assert!(snapshot.starts_with(RIS));
        let mut restored = browser(80, 24);
        restored.vt_write(b"stale screen of the previous viewer");
        restored.vt_write(&snapshot);
        assert_same_terminal(&restored, &source);
        // The split character arrived whole.
        assert!(plain(&restored).contains("ä€"));
    }

    #[tokio::test]
    async fn snapshot_restores_alternate_screen() {
        let output: &[&[u8]] = &[
            b"shell prompt\r\n",
            b"\x1b[?1049h\x1b[2J\x1b[Hfull screen app",
        ];
        let snapshot = mirror_snapshot(80, 24, output).await;
        let mut source = browser(80, 24);
        for chunk in output {
            source.vt_write(chunk);
        }
        let mut restored = browser(80, 24);
        restored.vt_write(&snapshot);
        // A reload while vim is open must come back on the alternate screen with its text.
        assert_same_terminal(&restored, &source);
    }

    #[tokio::test]
    async fn snapshot_keeps_scrollback_within_the_cap() {
        let mut output = Vec::new();
        for line in 0..(TERMINAL_SNAPSHOT_SCROLLBACK_LINES + 500) {
            output.extend_from_slice(format!("line {line}\r\n").as_bytes());
        }
        let snapshot = mirror_snapshot(80, 24, &[&output]).await;
        let text = String::from_utf8_lossy(&snapshot);
        // Recent history is restored, so a reload can still scroll back.
        assert!(text.contains("line 1000\r\n") || text.contains("line 1000\n"));
        // History beyond the cap is gone, which bounds memory and the snapshot.
        assert!(!text.contains("line 10\r\n") && !text.contains("line 10\n"));
    }

    #[tokio::test]
    async fn changed_tab_stop_does_not_move_the_restored_cursor() {
        // Clear all tab stops and set a custom one, then park the cursor.
        let output: &[&[u8]] = &[b"\x1b[3g\x1b[1;5H\x1bH\x1b[3;7Hx"];
        let snapshot = mirror_snapshot(80, 24, output).await;
        let mut source = browser(80, 24);
        source.vt_write(output[0]);
        let mut restored = browser(80, 24);
        restored.vt_write(&snapshot);
        // Tab stops are left out of the snapshot because writing them moves the cursor.
        assert_eq!(restored.cursor_x().unwrap(), source.cursor_x().unwrap());
        assert_eq!(restored.cursor_y().unwrap(), source.cursor_y().unwrap());
    }

    /// Attaching between any two chunks must render like the uninterrupted stream.
    #[tokio::test]
    async fn attaching_inside_a_sequence_renders_like_the_whole_stream() {
        let cases: &[(&[u8], &[u8])] = &[
            // Inside a UTF-8 character.
            (b"price: \xe2\x82", b"\xac done"),
            // Inside a CSI sequence that sets a color.
            (b"before \x1b[38;5;", b"196mred text\x1b[0m"),
            // Inside an OSC title, which must not be printed as text.
            (b"x\x1b]0;my ti", b"tle\x07after"),
        ];
        for (before, after) in cases {
            let snapshot = mirror_snapshot(80, 24, &[before]).await;
            let mut whole = browser(80, 24);
            whole.vt_write(before);
            whole.vt_write(after);
            let mut attached = browser(80, 24);
            attached.vt_write(&snapshot);
            attached.vt_write(after);
            assert_same_terminal(&attached, &whole);
        }
    }

    /// A resize reaches the mirror in order with output, as it does the PTY.
    #[tokio::test]
    async fn resize_applies_before_later_output() {
        let mirror = ScreenMirror::spawn(size(80, 24)).expect("mirror");
        mirror.resize(size(120, 40)).await.expect("resize");
        mirror
            .sender()
            .reserve()
            .await
            .expect("slot")
            .feed(Bytes::from_static(b"\x1b[40;120Hx"));
        let snapshot = mirror.snapshot().await.unwrap().await.unwrap();
        let mut restored = browser(120, 40);
        restored.vt_write(&snapshot);
        // The cursor could only reach the last cell after the mirror grew.
        assert_eq!(restored.cursor_y().unwrap(), 39);
        assert_eq!(restored.cursor_x().unwrap(), 119);
    }

    /// Compression must never change what a snapshot restores.
    #[tokio::test]
    async fn compression_keeps_the_snapshot() {
        let mirror = ScreenMirror::spawn(size(80, 24)).expect("mirror");
        let mut output = Vec::new();
        for line in 0..300 {
            output.extend_from_slice(format!("\x1b[3{}mline {line}\r\n", line % 8).as_bytes());
        }
        mirror
            .sender()
            .reserve()
            .await
            .unwrap()
            .feed(Bytes::from(output));
        let before = mirror.snapshot().await.unwrap().await.unwrap();
        mirror.compress(CompressionMode::Full).await.unwrap();
        mirror.compress(CompressionMode::Incremental).await.unwrap();
        let after = mirror.snapshot().await.unwrap().await.unwrap();
        // Compression only changes storage, never the logical contents.
        assert_eq!(before, after);
    }
}
