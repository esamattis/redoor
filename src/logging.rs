use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{
        broadcast,
        mpsc::{self, Sender, error::TrySendError},
        oneshot,
    },
};
use ts_rs::TS;

const LIVE_LOG_CAPACITY: usize = 1_024;
const LOG_RECORD_CAPACITY: usize = 2_048;
const LOGGER_CONTROL_CAPACITY: usize = 16;

/// Caps every historical scan to the same browser-sized rolling window.
pub const LOG_HISTORY_ENTRY_LIMIT: usize = 500;

static LOGGER: OnceLock<LoggerHandle> = OnceLock::new();
/// Makes the effective process threshold available without task-local allocation or locking.
static LOG_LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);

/// Orders log records so callers can consistently filter and format process output.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
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

    /// Converts the compact atomic representation back to the canonical level.
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Trace,
            1 => Self::Debug,
            2 => Self::Info,
            3 => Self::Warning,
            4 => Self::Error,
            _ => Self::Info,
        }
    }
}

impl Default for Level {
    /// Keeps normal operator lifecycle output enabled unless another source overrides it.
    fn default() -> Self {
        Self::Info
    }
}

impl std::str::FromStr for Level {
    type Err = String;

    /// Accepts human CLI/config spelling while keeping one API serialization vocabulary.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "trace" => Ok(Self::Trace),
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" | "warning" => Ok(Self::Warning),
            "error" => Ok(Self::Error),
            _ => {
                Err("logging level must be one of: trace, debug, info, warning, error".to_string())
            }
        }
    }
}

impl std::fmt::Display for Level {
    /// Uses the same lowercase vocabulary accepted by TOML, CLI, env, and REST.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        })
    }
}

/// Carries a requested runtime threshold without overloading unrelated log-stream protocol data.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoggingLevelRequest {
    pub level: Level,
}

/// Returns the process-authoritative threshold after a read or successful update.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoggingLevelResponse {
    pub level: Level,
}

/// Preserves structured severity until the background task applies filtering and formatting.
struct LogMessage {
    level: Level,
    message: String,
}

/// Distinguishes application records from overload notices generated when queue capacity returns.
enum LogRecord {
    /// Carries one application record without making its producer wait for output.
    Message(LogMessage),
    /// Makes bounded-queue loss visible once the logger can accept records again.
    Dropped(u64),
}

/// Keeps subscription setup off the lossy record lane so output backlog cannot starve control.
enum LoggerCommand {
    /// Captures the current persisted prefix before subsequently processed records are published.
    Subscribe {
        reply: oneshot::Sender<LogSubscription>,
    },
}

/// Keeps normal logging non-blocking while allowing WebSocket setup to await an ordered reply.
struct LoggerHandle {
    records: Sender<LogRecord>,
    commands: Sender<LoggerCommand>,
    dropped_records: Arc<AtomicU64>,
}

impl LoggerHandle {
    /// Admits a record without waiting and preserves an exact count when bounded capacity is exhausted.
    fn send_record(&self, message: LogMessage) {
        let dropped = self.dropped_records.swap(0, Ordering::AcqRel);
        if dropped > 0 {
            match self.records.try_send(LogRecord::Dropped(dropped)) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    self.dropped_records
                        .fetch_add(dropped + 1, Ordering::Relaxed);
                    return;
                }
                Err(TrySendError::Closed(_)) => return,
            }
        }

        if matches!(
            self.records.try_send(LogRecord::Message(message)),
            Err(TrySendError::Full(_))
        ) {
            self.dropped_records.fetch_add(1, Ordering::Relaxed);
        }
    }
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

        Ok(Self {
            log_file_path,
            log_file,
            log_file_position,
            live_entries,
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

    /// Formats one record already admitted by the producer-side atomic threshold.
    async fn write(&mut self, level: Level, message: String) {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let formatted = format!("[{}] [{}] {}", timestamp, level.as_str(), message);
        self.write_formatted(formatted).await;
    }

    /// Writes a synthetic warning even when the configured level would hide ordinary warnings.
    async fn write_drop_notice(&mut self, dropped: u64) {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let formatted = format!(
            "[{}] [WARN] Logger dropped {dropped} records while its output queue was full",
            timestamp
        );
        self.write_formatted(formatted).await;
    }

    /// Writes one accepted entry before publishing it so the history cutoff trails file output.
    async fn write_formatted(&mut self, formatted: String) {
        let mut bytes = formatted.as_bytes().to_vec();
        bytes.push(b'\n');
        if let Err(error) = tokio::io::stdout().write_all(&bytes).await {
            eprintln!("Failed to write logger output to stdout: {error}");
        }

        if let Some(file) = self.log_file.as_mut() {
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

    /// Processes one bounded record while retaining a single owner for output ordering.
    async fn process_record(&mut self, record: LogRecord) {
        match record {
            LogRecord::Message(log_message) => {
                self.write(log_message.level, log_message.message).await;
            }
            LogRecord::Dropped(dropped) => self.write_drop_notice(dropped).await,
        }
    }

    /// Drains only the bounded backlog visible at admission before capturing a subscription boundary.
    async fn process_command(
        &mut self,
        command: LoggerCommand,
        records: &mut mpsc::Receiver<LogRecord>,
    ) {
        match command {
            LoggerCommand::Subscribe { reply } => {
                let backlog = records.len();
                for _ in 0..backlog {
                    let Some(record) = records.recv().await else {
                        break;
                    };
                    self.process_record(record).await;
                }
                let subscription = LogSubscription {
                    log_file_path: self.log_file_path.clone(),
                    history_end: self.log_file_position,
                    receiver: self.live_entries.subscribe(),
                };
                let _ = reply.send(subscription);
            }
        }
    }

    /// Prioritizes bounded control traffic while draining accepted records through one output owner.
    async fn run(
        mut self,
        mut records: mpsc::Receiver<LogRecord>,
        mut commands: mpsc::Receiver<LoggerCommand>,
    ) {
        loop {
            tokio::select! {
                biased;
                Some(command) = commands.recv() => self.process_command(command, &mut records).await,
                Some(record) = records.recv() => self.process_record(record).await,
                else => break,
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
    init_with_level(log_file_path, Level::Info).await
}

/// Initializes logging with the startup threshold resolved by the owning process role.
pub async fn init_with_level(log_file_path: Option<String>, level: Level) -> Result<()> {
    if LOGGER.get().is_some() {
        return Ok(());
    }

    set_level(level);

    let (records, record_receiver) = mpsc::channel(LOG_RECORD_CAPACITY);
    let (commands, command_receiver) = mpsc::channel(LOGGER_CONTROL_CAPACITY);
    let logger = Logger::new(log_file_path.map(PathBuf::from)).await?;
    let handle = LoggerHandle {
        records,
        commands,
        dropped_records: Arc::new(AtomicU64::new(0)),
    };
    if LOGGER.set(handle).is_err() {
        return Ok(());
    }

    tokio::spawn(logger.run(record_receiver, command_receiver));
    Ok(())
}

/// Establishes an ordered history/live boundary without blocking normal log producers.
pub async fn subscribe() -> Result<LogSubscription, SubscribeError> {
    let logger = LOGGER.get().ok_or(SubscribeError::LoggerClosed)?;
    let (reply, response) = oneshot::channel();
    logger
        .commands
        .send(LoggerCommand::Subscribe { reply })
        .await
        .map_err(|_| SubscribeError::LoggerClosed)?;
    response.await.map_err(|_| SubscribeError::ResponseDropped)
}

/// Enqueues an entry immediately so application work never waits for formatting or file output.
pub fn log(level: Level, message: String) {
    let logger = LOGGER.get().expect("global logger is unavailable");
    logger.send_record(LogMessage { level, message });
}

/// Returns whether a producer should construct and enqueue a record at this severity.
#[inline]
pub fn enabled(level: Level) -> bool {
    level as u8 >= LOG_LEVEL.load(Ordering::Relaxed)
}

/// Returns the current process-wide threshold with one relaxed atomic load.
pub fn level() -> Level {
    Level::from_u8(LOG_LEVEL.load(Ordering::Relaxed))
}

/// Changes admission for subsequent macro calls without blocking active output or streams.
pub fn set_level(level: Level) {
    LOG_LEVEL.store(level as u8, Ordering::Relaxed);
}

/// Resolves CLI, role-specific env, legacy env, TOML, then the info default.
pub fn resolve_initial_level(
    cli: Option<Level>,
    role_env_name: &str,
    toml: Option<Level>,
) -> std::result::Result<Level, String> {
    resolve_level_sources(
        cli,
        role_env_name,
        std::env::var(role_env_name).ok().as_deref(),
        std::env::var("REDOOR_LOGLEVEL").ok().as_deref(),
        toml,
    )
}

/// Applies startup precedence independently of process environment access so every source is testable.
fn resolve_level_sources(
    cli: Option<Level>,
    role_env_name: &str,
    role_env: Option<&str>,
    legacy_env: Option<&str>,
    toml: Option<Level>,
) -> std::result::Result<Level, String> {
    if let Some(level) = cli {
        return Ok(level);
    }
    if let Some(value) = role_env {
        return value
            .parse::<Level>()
            .map_err(|error| format!("Invalid {role_env_name} value {value:?}: {error}"));
    }
    if let Some(value) = legacy_env {
        return value
            .parse::<Level>()
            .map_err(|error| format!("Invalid REDOOR_LOGLEVEL value {value:?}: {error}"));
    }
    Ok(toml.unwrap_or_default())
}

/// Formats application log arguments only after callers select the intended severity.
#[macro_export]
macro_rules! log {
    ($level:expr, $($arg:tt)*) => {
        {
            let level = $level;
            if $crate::logging::enabled(level) {
                $crate::logging::log(level, format!($($arg)*));
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::test_support::TempDir;

    /// Places logger history beneath the root owned by the current test.
    fn temporary_log_path(temp_dir: &TempDir) -> PathBuf {
        temp_dir.path().join("server.log")
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
    async fn start_logger(path: Option<PathBuf>) -> (LoggerHandle, tokio::task::JoinHandle<()>) {
        let logger = Logger::new(path).await.expect("test logger should open");
        let (records, record_receiver) = mpsc::channel(LOG_RECORD_CAPACITY);
        let (commands, command_receiver) = mpsc::channel(LOGGER_CONTROL_CAPACITY);
        let handle = LoggerHandle {
            records,
            commands,
            dropped_records: Arc::new(AtomicU64::new(0)),
        };
        let task = tokio::spawn(logger.run(record_receiver, command_receiver));
        (handle, task)
    }

    /// Verifies missing parent directories are created so first-boot log paths work.
    #[tokio::test]
    async fn creates_missing_log_directory() {
        let temp_dir = TempDir::create();
        let path = temp_dir.path().join("nested/agent.log");
        let logger = Logger::new(Some(path.clone()))
            .await
            .expect("logger should create nested parents");
        drop(logger);
        assert!(
            tokio::fs::try_exists(&path).await.expect("exists check"),
            "opening the logger must create the log file after creating parents"
        );
    }

    /// Requests a subscription as a deterministic barrier for every command queued before it.
    async fn request_subscription(logger: &LoggerHandle) -> LogSubscription {
        let (reply, response) = oneshot::channel();
        logger
            .commands
            .send(LoggerCommand::Subscribe { reply })
            .await
            .expect("test logger should accept subscription commands");
        response
            .await
            .expect("test logger should answer subscription commands")
    }

    /// Sends a record through the same command lane used by production log producers.
    fn send_log(logger: &LoggerHandle, level: Level, message: &str) {
        logger.send_record(LogMessage {
            level,
            message: message.to_string(),
        });
    }

    /// Proves overload remains bounded and reports the exact loss after capacity returns.
    #[test]
    fn bounded_record_queue_reports_drops_on_recovery() {
        let (records, mut record_receiver) = mpsc::channel(2);
        let (commands, _command_receiver) = mpsc::channel(1);
        let logger = LoggerHandle {
            records,
            commands,
            dropped_records: Arc::new(AtomicU64::new(0)),
        };

        send_log(&logger, Level::Info, "accepted one");
        send_log(&logger, Level::Info, "accepted two");
        send_log(&logger, Level::Info, "dropped");
        // A full queue must retain only its configured number of allocated records.
        assert_eq!(logger.records.max_capacity() - logger.records.capacity(), 2);
        // Every rejected application record must contribute to explicit loss accounting.
        assert_eq!(logger.dropped_records.load(Ordering::Relaxed), 1);

        let _ = record_receiver
            .try_recv()
            .expect("first record should be queued");
        let _ = record_receiver
            .try_recv()
            .expect("second record should be queued");
        send_log(&logger, Level::Info, "accepted after recovery");

        let notice = record_receiver
            .try_recv()
            .expect("drop notice should be queued");
        // Recovery must report the exact accumulated loss before the next accepted record.
        assert!(matches!(notice, LogRecord::Dropped(1)));
        let recovered = record_receiver
            .try_recv()
            .expect("post-recovery record should be queued");
        // Capacity recovery must not discard the record that exposed the loss notice.
        assert!(matches!(recovered, LogRecord::Message(_)));
        // Once reported, the loss counter must return to zero for the next overload interval.
        assert_eq!(logger.dropped_records.load(Ordering::Relaxed), 0);
    }

    /// Proves subscription control drains a fixed backlog rather than waiting behind later records.
    #[tokio::test]
    async fn subscription_control_is_not_starved_by_record_backlog() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
        let logger = Logger::new(Some(path.clone()))
            .await
            .expect("test logger should open");
        let (records, record_receiver) = mpsc::channel(2);
        let (commands, command_receiver) = mpsc::channel(1);
        let handle = LoggerHandle {
            records,
            commands,
            dropped_records: Arc::new(AtomicU64::new(0)),
        };
        send_log(&handle, Level::Info, "backlog one");
        send_log(&handle, Level::Info, "backlog two");
        let (reply, response) = oneshot::channel();
        handle
            .commands
            .try_send(LoggerCommand::Subscribe { reply })
            .expect("control lane should remain available beside a full record lane");

        let task = tokio::spawn(logger.run(record_receiver, command_receiver));
        let subscription = response
            .await
            .expect("prioritized subscription should receive a response");
        let history = read_latest_entries(&path, subscription.history_end)
            .await
            .expect("subscription history should be readable");
        // Both records visible at control admission must be included in the stable boundary.
        assert_eq!(history.len(), 2);

        drop(handle);
        task.await.expect("test logger task should stop cleanly");
    }

    /// Protects complete chronological snapshots when no eviction is necessary.
    #[tokio::test]
    async fn history_returns_all_entries_in_original_order_below_limit() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
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
    }

    /// Protects the memory cap while retaining the newest chronological records.
    #[tokio::test]
    async fn history_retains_only_latest_five_hundred_entries() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
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
    }

    /// Protects the exact subscription cutoff from later appends.
    #[tokio::test]
    async fn history_cutoff_excludes_later_appends() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
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
    }

    /// Protects empty persistent history as a valid snapshot.
    #[tokio::test]
    async fn history_empty_file_returns_empty_snapshot() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
        tokio::fs::write(&path, b"")
            .await
            .expect("empty history should be writable");
        let actual = read_latest_entries(&path, 0)
            .await
            .expect("empty history should be readable");
        // An empty active file must not invent placeholder records.
        assert!(actual.is_empty());
    }

    /// Protects an unterminated final physical line from being discarded.
    #[tokio::test]
    async fn history_retains_final_entry_without_newline() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
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
    }

    /// Protects the queue-position boundary that prevents snapshot/live gaps and duplicates.
    #[tokio::test]
    async fn subscription_separates_history_from_later_live_entries() {
        let temp_dir = TempDir::create();
        let path = temporary_log_path(&temp_dir);
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
    }

    /// Proves disabled macro arguments are not evaluated or formatted on the hot path.
    #[test]
    fn disabled_macro_does_not_evaluate_arguments() {
        let evaluations = std::cell::Cell::new(0);
        set_level(Level::Error);
        crate::log!(Level::Debug, "unused {}", {
            evaluations.set(evaluations.get() + 1);
            "argument"
        });
        set_level(Level::Info);

        // A disabled event must do only the atomic comparison and skip every format argument.
        assert_eq!(evaluations.get(), 0);
    }

    /// Protects canonical level spelling, warning compatibility, and threshold ordering.
    #[test]
    fn levels_parse_display_and_order_consistently() {
        // Legacy `warn` remains accepted while APIs emit the clearer canonical spelling.
        assert_eq!("warn".parse::<Level>(), Ok(Level::Warning));
        assert_eq!(Level::Warning.to_string(), "warning");
        // Increasing enum order is what makes the atomic hot-path comparison sufficient.
        assert!(Level::Trace < Level::Debug && Level::Info < Level::Error);
        // Invalid startup values must fail rather than silently reverting to info.
        assert!("verbose".parse::<Level>().is_err());
    }

    /// Protects the startup contract shared by both server and standalone-agent entry points.
    #[test]
    fn startup_level_sources_follow_documented_precedence() {
        // Explicit CLI state must win even when every lower-priority source is present.
        assert_eq!(
            resolve_level_sources(
                Some(Level::Error),
                "REDOOR_SERVER_LOG_LEVEL",
                Some("trace"),
                Some("debug"),
                Some(Level::Warning),
            ),
            Ok(Level::Error),
        );
        // The role-specific server or agent variable must override legacy compatibility and TOML.
        assert_eq!(
            resolve_level_sources(
                None,
                "REDOOR_AGENT_LOG_LEVEL",
                Some("trace"),
                Some("debug"),
                Some(Level::Warning),
            ),
            Ok(Level::Trace),
        );
        // Legacy deployments retain precedence over TOML when no role-specific value is set.
        assert_eq!(
            resolve_level_sources(
                None,
                "REDOOR_SERVER_LOG_LEVEL",
                None,
                Some("debug"),
                Some(Level::Warning),
            ),
            Ok(Level::Debug),
        );
        // TOML supplies the configured initial value before the info default is considered.
        assert_eq!(
            resolve_level_sources(
                None,
                "REDOOR_AGENT_LOG_LEVEL",
                None,
                None,
                Some(Level::Warning),
            ),
            Ok(Level::Warning),
        );
        // Both process roles remain at info when no startup source is configured.
        assert_eq!(
            resolve_level_sources(None, "REDOOR_SERVER_LOG_LEVEL", None, None, None),
            Ok(Level::Info),
        );
        // Invalid high-priority input must fail instead of falling through to a lower source.
        assert!(
            resolve_level_sources(
                None,
                "REDOOR_AGENT_LOG_LEVEL",
                Some("verbose"),
                Some("debug"),
                None,
            )
            .is_err(),
        );
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
