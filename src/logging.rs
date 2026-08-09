use std::{collections::VecDeque, path::PathBuf, sync::OnceLock};

use anyhow::{Context, Result};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{
        broadcast,
        mpsc::{self, UnboundedSender},
        oneshot,
    },
};

const LIVE_LOG_CAPACITY: usize = 1_024;

/// Caps every historical scan to the same browser-sized rolling window.
pub const LOG_HISTORY_ENTRY_LIMIT: usize = 500;

static LOGGER: OnceLock<LoggerHandle> = OnceLock::new();

/// Orders log records so callers can consistently filter and format process output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Includes highly detailed events intended for short diagnostic sessions.
    Trace,
    /// Includes developer-oriented state without enabling full trace volume.
    Debug,
    /// Includes normal lifecycle events useful to operators.
    Info,
    /// Includes recoverable conditions that may need operator attention.
    Warning,
    /// Includes failures that prevented an operation from completing.
    Error,
}

impl Level {
    /// Keeps the file, console, and live-stream level representation identical.
    fn as_str(&self) -> &str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warning => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// Preserves structured severity until the background task applies filtering and formatting.
struct LogMessage {
    level: Level,
    message: String,
}

/// Serializes subscriptions with writes so each receiver has an exact history/live boundary.
enum LoggerCommand {
    /// Defers file I/O without making application control paths wait for the logger.
    Write(LogMessage),
    /// Creates the receiver only after every earlier queued write has completed.
    Subscribe {
        reply: oneshot::Sender<LogSubscription>,
    },
}

/// Keeps normal logging non-blocking while allowing WebSocket setup to await an ordered reply.
struct LoggerHandle {
    commands: UnboundedSender<LoggerCommand>,
}

/// Captures the stable file prefix and live receiver created at one logger queue position.
pub struct LogSubscription {
    /// Identifies the file only when persistent logging opened and remains usable.
    pub log_file_path: Option<PathBuf>,
    /// Prevents later appends from leaking into the historical snapshot.
    pub history_end: u64,
    /// Delivers accepted entries through bounded storage so slow clients cannot grow memory forever.
    pub receiver: broadcast::Receiver<String>,
}

/// Distinguishes logger shutdown failures during WebSocket subscription setup.
#[derive(Debug, thiserror::Error)]
pub enum SubscribeError {
    /// Indicates that no running logger task can accept the ordered command.
    #[error("logger command channel is closed")]
    LoggerClosed,
    /// Indicates that the logger stopped after accepting but before answering the command.
    #[error("logger dropped the subscription response")]
    ResponseDropped,
}

/// Owns mutable file state in one task so producers never perform or wait for file I/O.
pub struct Logger {
    log_file_path: Option<PathBuf>,
    log_file: Option<tokio::fs::File>,
    log_file_position: u64,
    live_entries: broadcast::Sender<String>,
    level: Level,
}

impl Logger {
    /// Opens persistent output before startup continues so subscriptions never advertise an unusable file.
    ///
    /// Missing parent directories are created first so conventional paths like
    /// `~/.local/share/<app-name>/server.log` work on first boot.
    pub async fn new(log_file_path: Option<PathBuf>) -> Result<Self> {
        let (log_file_path, log_file, log_file_position) = match log_file_path {
            Some(path) => {
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    tokio::fs::create_dir_all(parent).await.with_context(|| {
                        format!("Failed to create log directory '{}'", parent.display())
                    })?;
                }
                let file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .await
                    .with_context(|| format!("Failed to open log file '{}'", path.display()))?;
                let metadata = file
                    .metadata()
                    .await
                    .with_context(|| format!("Failed to inspect log file '{}'", path.display()))?;
                (Some(path), Some(file), metadata.len())
            }
            None => (None, None, 0),
        };
        let (live_entries, _) = broadcast::channel(LIVE_LOG_CAPACITY);

        let level = match std::env::var("REDOOR_LOGLEVEL").as_deref() {
            Ok("trace") => Level::Trace,
            Ok("debug") => Level::Debug,
            Ok("warn") => Level::Warning,
            Ok("error") => Level::Error,
            _ => Level::Info,
        };

        Ok(Self {
            log_file_path,
            log_file,
            log_file_position,
            live_entries,
            level,
        })
    }

    /// Reports file failures without recursively enqueueing another record into the broken logger.
    fn report_file_error(operation: &str, path: &std::path::Path, error: &std::io::Error) {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        eprintln!(
            "[{}] [ERROR] Failed to {} log file '{}': {}",
            timestamp,
            operation,
            path.display(),
            error
        );
    }

    /// Writes one accepted entry before publishing it so the history cutoff trails file output.
    async fn write(&mut self, level: Level, message: String) {
        if level < self.level {
            return;
        }

        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let formatted = format!("[{}] [{}] {}", timestamp, level.as_str(), message);
        println!("{}", formatted);

        if let Some(file) = self.log_file.as_mut() {
            let mut bytes = formatted.as_bytes().to_vec();
            bytes.push(b'\n');

            match file.write_all(&bytes).await {
                Ok(()) => self.log_file_position += bytes.len() as u64,
                Err(error) => {
                    if let Some(path) = self.log_file_path.as_deref() {
                        Self::report_file_error("write", path, &error);
                    }
                    // A partial write makes the exact cutoff unknowable, so stop advertising history.
                    self.log_file = None;
                    self.log_file_path = None;
                    self.log_file_position = 0;
                }
            }
        }

        // Multiline messages remain one live entry but reconnect as physical file lines; changing
        // the established line-oriented format requires a separate compatibility decision.
        let _ = self.live_entries.send(formatted);
    }

    /// Processes commands in queue order so subscription cutoffs cannot race accepted writes.
    async fn run(mut self, mut receiver: mpsc::UnboundedReceiver<LoggerCommand>) {
        while let Some(command) = receiver.recv().await {
            match command {
                LoggerCommand::Write(log_message) => {
                    self.write(log_message.level, log_message.message).await;
                }
                LoggerCommand::Subscribe { reply } => {
                    let subscription = LogSubscription {
                        log_file_path: self.log_file_path.clone(),
                        history_end: self.log_file_position,
                        receiver: self.live_entries.subscribe(),
                    };
                    let _ = reply.send(subscription);
                }
            }
        }
    }
}

/// Scans a stable file prefix asynchronously while retaining only the newest display entries.
pub async fn read_latest_entries(
    path: &std::path::Path,
    history_end: u64,
) -> std::io::Result<Vec<String>> {
    let file = tokio::fs::File::open(path).await?;
    let limited_file = file.take(history_end);
    let mut lines = BufReader::new(limited_file).lines();
    let mut entries = VecDeque::with_capacity(LOG_HISTORY_ENTRY_LIMIT);

    while let Some(line) = lines.next_line().await? {
        if entries.len() == LOG_HISTORY_ENTRY_LIMIT {
            entries.pop_front();
        }
        entries.push_back(line);
    }

    Ok(entries.into_iter().collect())
}

/// Initializes the process-global logger before any log macro is used.
pub async fn init(log_file_path: Option<String>) -> Result<()> {
    if LOGGER.get().is_some() {
        return Ok(());
    }

    let (commands, receiver) = mpsc::unbounded_channel();
    let logger = Logger::new(log_file_path.map(PathBuf::from)).await?;
    let handle = LoggerHandle { commands };
    if LOGGER.set(handle).is_err() {
        return Ok(());
    }

    tokio::spawn(logger.run(receiver));
    Ok(())
}

/// Establishes an ordered history/live boundary without blocking normal log producers.
pub async fn subscribe() -> Result<LogSubscription, SubscribeError> {
    let logger = LOGGER.get().ok_or(SubscribeError::LoggerClosed)?;
    let (reply, response) = oneshot::channel();
    logger
        .commands
        .send(LoggerCommand::Subscribe { reply })
        .map_err(|_| SubscribeError::LoggerClosed)?;
    response.await.map_err(|_| SubscribeError::ResponseDropped)
}

/// Enqueues an entry immediately so application work never waits for formatting or file output.
pub fn log(level: Level, message: String) {
    let logger = LOGGER.get().expect("global logger is unavailable");
    let _ = logger
        .commands
        .send(LoggerCommand::Write(LogMessage { level, message }));
}

/// Formats application log arguments only after callers select the intended severity.
#[macro_export]
macro_rules! log {
    ($level:expr, $($arg:tt)*) => {
        $crate::logging::log($level, format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::broadcast::error::TryRecvError,
    };
    use uuid::Uuid;

    use super::*;

    /// Creates an isolated file name so parallel logger tests cannot alter each other's history.
    fn temporary_log_path() -> PathBuf {
        std::env::temp_dir().join(format!("redoor-logger-test-{}.log", Uuid::new_v4()))
    }

    /// Writes deterministic physical records without involving the process-global logger.
    async fn write_history(path: &std::path::Path, entries: &[String], final_newline: bool) {
        let mut contents = entries.join("\n");
        if final_newline {
            contents.push('\n');
        }
        tokio::fs::write(path, contents)
            .await
            .expect("test history should be writable");
    }

    /// Starts a directly owned logger because the process-global OnceLock cannot be reset between tests.
    async fn start_logger(
        path: Option<PathBuf>,
    ) -> (UnboundedSender<LoggerCommand>, tokio::task::JoinHandle<()>) {
        let mut logger = Logger::new(path).await.expect("test logger should open");
        logger.level = Level::Info;
        let (commands, receiver) = mpsc::unbounded_channel();
        let task = tokio::spawn(logger.run(receiver));
        (commands, task)
    }

    /// Verifies missing parent directories are created so first-boot log paths work.
    #[tokio::test]
    async fn creates_missing_log_directory() {
        let directory =
            std::env::temp_dir().join(format!("redoor-logger-mkdir-test-{}", Uuid::new_v4()));
        let path = directory.join("nested/agent.log");
        let logger = Logger::new(Some(path.clone()))
            .await
            .expect("logger should create nested parents");
        drop(logger);
        assert!(
            tokio::fs::try_exists(&path).await.expect("exists check"),
            "opening the logger must create the log file after creating parents"
        );
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("test directory should be removable");
    }

    /// Requests a subscription as a deterministic barrier for every command queued before it.
    async fn request_subscription(commands: &UnboundedSender<LoggerCommand>) -> LogSubscription {
        let (reply, response) = oneshot::channel();
        commands
            .send(LoggerCommand::Subscribe { reply })
            .expect("test logger should accept subscription commands");
        response
            .await
            .expect("test logger should answer subscription commands")
    }

    /// Sends a record through the same command lane used by production log producers.
    fn send_log(commands: &UnboundedSender<LoggerCommand>, level: Level, message: &str) {
        commands
            .send(LoggerCommand::Write(LogMessage {
                level,
                message: message.to_string(),
            }))
            .expect("test logger should accept write commands");
    }

    /// Protects complete chronological snapshots when no eviction is necessary.
    #[tokio::test]
    async fn history_returns_all_entries_in_original_order_below_limit() {
        let path = temporary_log_path();
        let expected = vec![
            "first".to_string(),
            "second".to_string(),
            "third".to_string(),
        ];
        write_history(&path, &expected, true).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("history metadata should exist")
            .len();
        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("history should be readable");
        // Histories below the cap must retain every complete entry in source order.
        assert_eq!(actual, expected);
        tokio::fs::remove_file(path)
            .await
            .expect("history should be removable");
    }

    /// Protects the memory cap while retaining the newest chronological records.
    #[tokio::test]
    async fn history_retains_only_latest_five_hundred_entries() {
        let path = temporary_log_path();
        let entries = (1..=510)
            .map(|index| format!("line-{index:03}"))
            .collect::<Vec<_>>();
        write_history(&path, &entries, true).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("history metadata should exist")
            .len();
        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("history should be readable");
        // The rolling scanner must never retain more than the browser window.
        assert_eq!(actual.len(), LOG_HISTORY_ENTRY_LIMIT);
        // Eviction must discard only the ten oldest records.
        assert_eq!(actual.first().map(String::as_str), Some("line-011"));
        // The newest record must remain last after bounded scanning.
        assert_eq!(actual.last().map(String::as_str), Some("line-510"));
        tokio::fs::remove_file(path)
            .await
            .expect("history should be removable");
    }

    /// Protects the exact subscription cutoff from later appends.
    #[tokio::test]
    async fn history_cutoff_excludes_later_appends() {
        let path = temporary_log_path();
        write_history(&path, &["before cutoff".to_string()], true).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("history metadata should exist")
            .len();
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .expect("history should reopen");
        file.write_all(b"after cutoff\n")
            .await
            .expect("append should succeed");
        drop(file);
        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("history should be readable");
        // Only records accepted before the stable byte boundary belong in the snapshot.
        assert_eq!(actual, vec!["before cutoff"]);
        tokio::fs::remove_file(path)
            .await
            .expect("history should be removable");
    }

    /// Protects empty persistent history as a valid snapshot.
    #[tokio::test]
    async fn history_empty_file_returns_empty_snapshot() {
        let path = temporary_log_path();
        tokio::fs::write(&path, b"")
            .await
            .expect("empty history should be writable");
        let actual = read_latest_entries(&path, 0)
            .await
            .expect("empty history should be readable");
        // An empty active file must not invent placeholder records.
        assert!(actual.is_empty());
        tokio::fs::remove_file(path)
            .await
            .expect("history should be removable");
    }

    /// Protects an unterminated final physical line from being discarded.
    #[tokio::test]
    async fn history_retains_final_entry_without_newline() {
        let path = temporary_log_path();
        let expected = vec!["complete line".to_string(), "final line".to_string()];
        write_history(&path, &expected, false).await;
        let cutoff = tokio::fs::metadata(&path)
            .await
            .expect("history metadata should exist")
            .len();
        let actual = read_latest_entries(&path, cutoff)
            .await
            .expect("history should be readable");
        // A final physical line is still one complete display entry without a delimiter.
        assert_eq!(actual, expected);
        tokio::fs::remove_file(path)
            .await
            .expect("history should be removable");
    }

    /// Protects the queue-position boundary that prevents snapshot/live gaps and duplicates.
    #[tokio::test]
    async fn subscription_separates_history_from_later_live_entries() {
        let path = temporary_log_path();
        let (commands, task) = start_logger(Some(path.clone())).await;
        send_log(&commands, Level::Info, "first history entry");
        send_log(&commands, Level::Warning, "second history entry");

        let mut subscription = request_subscription(&commands).await;
        send_log(&commands, Level::Error, "later live entry");
        let live_entry = subscription
            .receiver
            .recv()
            .await
            .expect("accepted later entry should be broadcast");

        let mut file = tokio::fs::File::open(&path)
            .await
            .expect("test history file should open");
        let mut historical_bytes = vec![0; subscription.history_end as usize];
        file.read_exact(&mut historical_bytes)
            .await
            .expect("the stable history prefix should remain readable");
        let historical =
            String::from_utf8(historical_bytes).expect("logger output should be UTF-8");

        // Both writes queued before subscription must be included in its stable prefix.
        assert!(historical.contains("first history entry"));
        // Queue ordering must include the second pre-subscription record as well.
        assert!(historical.contains("second history entry"));
        // A post-subscription write must not leak into bytes before the returned cutoff.
        assert!(!historical.contains("later live entry"));
        // The same post-cutoff record must arrive through the live receiver instead.
        assert!(live_entry.contains("later live entry"));

        drop(commands);
        task.await.expect("test logger task should stop cleanly");
        tokio::fs::remove_file(path)
            .await
            .expect("test history file should be removable");
    }

    /// Protects filtering from leaking rejected records into either output destination.
    #[tokio::test]
    async fn filtered_entries_reach_neither_history_nor_live_delivery() {
        let path = temporary_log_path();
        let (commands, task) = start_logger(Some(path.clone())).await;
        let mut subscription = request_subscription(&commands).await;
        send_log(&commands, Level::Debug, "filtered entry");
        let after_filtered = request_subscription(&commands).await;

        // A filtered entry must not advance the persistent history boundary.
        assert_eq!(after_filtered.history_end, 0);
        // The command barrier makes an empty receiver proof that no live event was published.
        assert!(matches!(
            subscription.receiver.try_recv(),
            Err(TryRecvError::Empty)
        ));
        // An untouched append-only file confirms filtering happened before file output.
        assert_eq!(
            tokio::fs::metadata(&path)
                .await
                .expect("test file should exist")
                .len(),
            0
        );

        drop(commands);
        task.await.expect("test logger task should stop cleanly");
        tokio::fs::remove_file(path)
            .await
            .expect("test history file should be removable");
    }

    /// Protects live viewing as a useful fallback when persistent logging is unavailable.
    #[tokio::test]
    async fn no_file_mode_still_delivers_live_entries() {
        let (commands, task) = start_logger(None).await;
        let mut subscription = request_subscription(&commands).await;
        send_log(&commands, Level::Info, "memory-only live entry");
        let live_entry = subscription
            .receiver
            .recv()
            .await
            .expect("accepted memory-only entry should be broadcast");

        // No-file mode must clearly tell subscribers that persistent history is unavailable.
        assert!(subscription.log_file_path.is_none());
        // Without a file there can be no historical byte prefix to scan.
        assert_eq!(subscription.history_end, 0);
        // Live viewing remains useful even when persistent logging is disabled.
        assert!(live_entry.contains("memory-only live entry"));

        drop(commands);
        task.await.expect("test logger task should stop cleanly");
    }

    /// Protects logger responsiveness when a browser cannot keep up with accepted records.
    #[tokio::test]
    async fn bounded_broadcast_lags_without_blocking_logger_commands() {
        let (commands, task) = start_logger(None).await;
        let mut subscription = request_subscription(&commands).await;
        for index in 0..=LIVE_LOG_CAPACITY {
            send_log(&commands, Level::Info, &format!("burst entry {index}"));
        }
        let after_burst = request_subscription(&commands).await;

        let lag = subscription.receiver.recv().await;
        // Falling behind must be observable instead of allocating an unbounded client queue.
        assert!(matches!(lag, Err(broadcast::error::RecvError::Lagged(1))));
        // Receiving the barrier proves a lagging subscriber did not block logger command progress.
        assert_eq!(after_burst.history_end, 0);

        drop(commands);
        task.await.expect("test logger task should stop cleanly");
    }
}
