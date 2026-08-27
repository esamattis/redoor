use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    sync::{
        broadcast,
        mpsc::{self, Sender, error::TrySendError},
    },
};
use ts_rs::TS;

const LIVE_LOG_CAPACITY: usize = 1_024;
const LOG_RECORD_CAPACITY: usize = 2_048;
/// Gives relay validation the same per-section diagnostic bound used by producers.
pub const LOG_DIAGNOSTIC_LIMIT: usize = 64 * 1_024;
/// Keeps one structured entry comfortably below the relay frame limit.
pub const LOG_MESSAGE_LIMIT: usize = 32 * 1_024;
const TRUNCATION_NOTICE: &str = "
[diagnostic truncated]";
/// Caps process-local browser replay at an exact, predictable memory bound.
pub const LOG_HISTORY_ENTRY_LIMIT: usize = 1_000;

static LOGGER: OnceLock<LoggerHandle> = OnceLock::new();
static LOG_LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);

/// Orders log records so callers can consistently filter and present process output.
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
    /// Keeps human process output compatible with the established severity labels.
    fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warning => "WARN",
            Self::Error => "ERROR",
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
    /// Keeps normal lifecycle output enabled unless another source overrides it.
    fn default() -> Self {
        Self::Info
    }
}

impl std::str::FromStr for Level {
    type Err = String;

    /// Accepts human startup spelling while retaining one API vocabulary.
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
    /// Uses the lowercase spelling accepted by TOML, CLI, env, and REST.
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

/// Selects operator-facing output without changing structured browser payloads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum LogFormat {
    /// Preserves the human-readable line format.
    #[default]
    Line,
    /// Emits one JSON object per physical output line.
    Json,
}

impl std::str::FromStr for LogFormat {
    type Err = String;

    /// Restricts startup values to documented sink formats.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "line" => Ok(Self::Line),
            "json" => Ok(Self::Json),
            _ => Err("log format must be one of: line, json".to_string()),
        }
    }
}

impl std::fmt::Display for LogFormat {
    /// Uses stable CLI and TOML spelling.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Line => "line",
            Self::Json => "json",
        })
    }
}

/// Retains diagnostics separately so viewers can disclose them on demand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogErrorDetails {
    /// Contains the anyhow context/source sequence, subject to a visible bound.
    pub chain: String,
    /// Contains a captured backtrace when runtime capture is enabled.
    pub backtrace: Option<String>,
}

impl LogErrorDetails {
    /// Extracts the complete anyhow diagnostic before the bounded producer enqueue.
    fn from_error(error: &anyhow::Error) -> Self {
        let chain = error
            .chain()
            .enumerate()
            .map(|(index, cause)| {
                if index == 0 {
                    cause.to_string()
                } else {
                    format!("Caused by: {cause}")
                }
            })
            .collect::<Vec<_>>()
            .join(
                "
",
            );
        let rendered_backtrace = error.backtrace().to_string();
        let backtrace = (!rendered_backtrace.trim().is_empty()
            && !rendered_backtrace.contains("disabled backtrace"))
        .then(|| bound_diagnostic(rendered_backtrace));
        Self {
            chain: bound_diagnostic(chain),
            backtrace,
        }
    }
}

/// Represents one record identically across replay, live events, and JSON output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogEntry {
    /// Uses RFC 3339 milliseconds and an explicit offset for unambiguous ordering.
    pub timestamp: String,
    pub level: Level,
    /// Excludes rendered timestamp and severity prefixes.
    pub message: String,
    /// Exists only for failures sent through the dedicated error logger.
    pub error: Option<LogErrorDetails>,
}

impl LogEntry {
    /// Captures time before enqueueing so output backlog does not alter event chronology.
    fn new(level: Level, message: String, error: Option<LogErrorDetails>) -> Self {
        Self {
            timestamp: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
            level,
            message,
            error,
        }
    }

    /// Preserves the established human-readable line format for existing consumers.
    fn render_line(&self) -> String {
        let timestamp = chrono::DateTime::parse_from_rfc3339(&self.timestamp)
            .expect("logger-created timestamps must remain valid RFC 3339 values")
            .format("%Y-%m-%d %H:%M:%S%.3f");
        format!("[{timestamp}] [{}] {}", self.level.as_str(), self.message)
    }
}

/// Carries a requested runtime threshold without overloading stream protocol data.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoggingLevelRequest {
    pub level: Level,
}

/// Returns the authoritative threshold after a read or successful update.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoggingLevelResponse {
    pub level: Level,
}

/// Distinguishes application records from overload notices.
enum LogRecord {
    /// Carries one accepted application record without waiting for output.
    Message(LogEntry),
}

/// Owns the replay/live boundary separately from potentially slow output I/O.
struct ReplayState {
    history: VecDeque<LogEntry>,
    live_entries: broadcast::Sender<LogEntry>,
}

impl ReplayState {
    /// Publishes only records accepted by the bounded sink queue.
    fn publish(&mut self, entry: LogEntry) {
        if self.history.len() == LOG_HISTORY_ENTRY_LIMIT {
            self.history.pop_front();
        }
        self.history.push_back(entry.clone());
        let _ = self.live_entries.send(entry);
    }
}

/// Keeps normal logging non-blocking while sharing a precise replay/live boundary.
struct LoggerHandle {
    records: Sender<LogRecord>,
    dropped_records: Arc<AtomicU64>,
    replay: Arc<Mutex<ReplayState>>,
    file_logging_enabled: bool,
}

impl LoggerHandle {
    /// Admits a record immediately and retains exact bounded-queue loss accounting.
    fn send_record(&self, entry: LogEntry) {
        let dropped = self.dropped_records.swap(0, Ordering::AcqRel);
        if dropped > 0 {
            let notice = LogEntry::new(
                Level::Warning,
                format!("Logger dropped {dropped} records while its output queue was full"),
                None,
            );
            match self.records.try_send(LogRecord::Message(notice.clone())) {
                Ok(()) => self
                    .replay
                    .lock()
                    .expect("logger replay state must not be poisoned")
                    .publish(notice),
                Err(TrySendError::Full(_)) => {
                    self.dropped_records
                        .fetch_add(dropped + 1, Ordering::Relaxed);
                    return;
                }
                Err(TrySendError::Closed(_)) => return,
            }
        }
        match self.records.try_send(LogRecord::Message(entry.clone())) {
            Ok(()) => self
                .replay
                .lock()
                .expect("logger replay state must not be poisoned")
                .publish(entry),
            Err(TrySendError::Full(_)) => {
                self.dropped_records.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Closed(_)) => {}
        }
    }

    /// Captures history and installs the receiver while holding one short lock.
    fn subscribe(&self) -> LogSubscription {
        let replay = self
            .replay
            .lock()
            .expect("logger replay state must not be poisoned");
        LogSubscription {
            entries: replay.history.iter().cloned().collect(),
            file_logging_enabled: self.file_logging_enabled,
            receiver: replay.live_entries.subscribe(),
        }
    }
}

/// Carries an atomic process-local snapshot and its structured live receiver.
pub struct LogSubscription {
    pub entries: Vec<LogEntry>,
    /// Explains persistence availability without exposing an internal path.
    pub file_logging_enabled: bool,
    pub receiver: broadcast::Receiver<LogEntry>,
}

/// Distinguishes logger shutdown failures during subscription setup.
#[derive(Debug, thiserror::Error)]
pub enum SubscribeError {
    /// No running logger task can accept the command.
    #[error("logger command channel is closed")]
    LoggerClosed,
}

/// Owns output and replay state in one task so producers never wait for I/O.
pub struct Logger {
    log_file_path: Option<PathBuf>,
    log_file: Option<tokio::fs::File>,
    format: LogFormat,
}

impl Logger {
    /// Opens persistent output before startup so availability is authoritative.
    pub async fn new(log_file_path: Option<PathBuf>, format: LogFormat) -> Result<Self> {
        let (log_file_path, log_file) = match log_file_path {
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
                (Some(path), Some(file))
            }
            None => (None, None),
        };
        Ok(Self {
            log_file_path,
            log_file,
            format,
        })
    }

    /// Reports sink failures directly to avoid recursively using the broken logger.
    fn report_file_error(operation: &str, path: &std::path::Path, error: &std::io::Error) {
        eprintln!(
            "Failed to {operation} log file '{}': {error}",
            path.display()
        );
    }

    /// Writes, retains, and broadcasts one record in deterministic order.
    async fn write_entry(&mut self, entry: LogEntry) {
        let formatted = match self.format {
            LogFormat::Line => entry.render_line(),
            LogFormat::Json => serde_json::to_string(&entry)
                .expect("serializing an owned structured log record must succeed"),
        };
        let mut bytes = formatted.into_bytes();
        bytes.push(b'\n');
        if let Err(error) = tokio::io::stdout().write_all(&bytes).await {
            eprintln!("Failed to write logger output to stdout: {error}");
        }
        if let Some(file) = self.log_file.as_mut()
            && let Err(error) = file.write_all(&bytes).await
        {
            if let Some(path) = self.log_file_path.as_deref() {
                Self::report_file_error("write", path, &error);
            }
            self.log_file = None;
            self.log_file_path = None;
        }
    }

    /// Processes one bounded record while preserving output ownership.
    async fn process_record(&mut self, record: LogRecord) {
        match record {
            LogRecord::Message(entry) => self.write_entry(entry).await,
        }
    }

    /// Drains records through one output owner without coupling subscriptions to sink latency.
    async fn run(mut self, mut records: mpsc::Receiver<LogRecord>) {
        while let Some(record) = records.recv().await {
            self.process_record(record).await;
        }
    }
}

/// Initializes the process-global logger with compatibility defaults.
pub async fn init(log_file_path: Option<String>) -> Result<()> {
    init_with_options(log_file_path, Level::Info, LogFormat::Line).await
}

/// Initializes logging with a threshold and compatibility line output.
pub async fn init_with_level(log_file_path: Option<String>, level: Level) -> Result<()> {
    init_with_options(log_file_path, level, LogFormat::Line).await
}

/// Initializes logging after the owning process role resolves startup options.
pub async fn init_with_options(
    log_file_path: Option<String>,
    level: Level,
    format: LogFormat,
) -> Result<()> {
    if LOGGER.get().is_some() {
        return Ok(());
    }
    set_level(level);
    let (records, record_receiver) = mpsc::channel(LOG_RECORD_CAPACITY);
    let logger = Logger::new(log_file_path.map(PathBuf::from), format).await?;
    let file_logging_enabled = logger.log_file.is_some();
    let (live_entries, _) = broadcast::channel(LIVE_LOG_CAPACITY);
    let handle = LoggerHandle {
        records,
        dropped_records: Arc::new(AtomicU64::new(0)),
        replay: Arc::new(Mutex::new(ReplayState {
            history: VecDeque::with_capacity(LOG_HISTORY_ENTRY_LIMIT),
            live_entries,
        })),
        file_logging_enabled,
    };
    if LOGGER.set(handle).is_err() {
        return Ok(());
    }
    tokio::spawn(logger.run(record_receiver));
    Ok(())
}

/// Establishes an ordered snapshot/live boundary without blocking producers.
pub async fn subscribe() -> Result<LogSubscription, SubscribeError> {
    let logger = LOGGER.get().ok_or(SubscribeError::LoggerClosed)?;
    Ok(logger.subscribe())
}

/// Enqueues an ordinary entry immediately.
pub fn log(level: Level, message: String) {
    LOGGER
        .get()
        .expect("global logger is unavailable")
        .send_record(LogEntry::new(level, bound_message(message), None));
}

/// Enqueues a failure with its preserved anyhow chain and captured backtrace.
pub fn log_error(message: String, error: &anyhow::Error) {
    LOGGER
        .get()
        .expect("global logger is unavailable")
        .send_record(LogEntry::new(
            Level::Error,
            bound_message(message),
            Some(LogErrorDetails::from_error(error)),
        ));
}

/// Truncates on a UTF-8 boundary while making diagnostic loss visible.
fn bound_diagnostic(mut value: String) -> String {
    if value.len() <= LOG_DIAGNOSTIC_LIMIT {
        return value;
    }
    let mut end = LOG_DIAGNOSTIC_LIMIT.saturating_sub(TRUNCATION_NOTICE.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push_str(TRUNCATION_NOTICE);
    value
}

/// Bounds human messages before they enter replay or relay memory.
fn bound_message(value: String) -> String {
    bound_value(value, LOG_MESSAGE_LIMIT, " [message truncated]")
}

/// Truncates one UTF-8 value at a visible byte limit.
fn bound_value(mut value: String, limit: usize, notice: &str) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut end = limit.saturating_sub(notice.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push_str(notice);
    value
}

/// Returns whether a producer should construct a record at this severity.
#[inline]
pub fn enabled(level: Level) -> bool {
    level as u8 >= LOG_LEVEL.load(Ordering::Relaxed)
}

/// Returns the current process-wide threshold.
pub fn level() -> Level {
    Level::from_u8(LOG_LEVEL.load(Ordering::Relaxed))
}

/// Changes admission for subsequent macro calls.
pub fn set_level(level: Level) {
    LOG_LEVEL.store(level as u8, Ordering::Relaxed);
}

/// Resolves CLI, role-specific environment, TOML, then the info default.
pub fn resolve_initial_level(
    cli: Option<Level>,
    role_env_name: &str,
    toml: Option<Level>,
) -> std::result::Result<Level, String> {
    resolve_level_sources(
        cli,
        role_env_name,
        std::env::var(role_env_name).ok().as_deref(),
        toml,
    )
}

/// Isolates level precedence from process environment access for tests.
fn resolve_level_sources(
    cli: Option<Level>,
    role_env_name: &str,
    role_env: Option<&str>,
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
    Ok(toml.unwrap_or_default())
}

/// Resolves CLI, role-specific environment, TOML, then the line default.
pub fn resolve_initial_format(
    cli: Option<LogFormat>,
    role_env_name: &str,
    toml: Option<LogFormat>,
) -> std::result::Result<LogFormat, String> {
    resolve_format_sources(
        cli,
        role_env_name,
        std::env::var(role_env_name).ok().as_deref(),
        toml,
    )
}

/// Isolates format precedence from process environment access for tests.
fn resolve_format_sources(
    cli: Option<LogFormat>,
    role_env_name: &str,
    role_env: Option<&str>,
    toml: Option<LogFormat>,
) -> std::result::Result<LogFormat, String> {
    if let Some(format) = cli {
        return Ok(format);
    }
    if let Some(value) = role_env {
        return value
            .parse::<LogFormat>()
            .map_err(|error| format!("Invalid {role_env_name} value {value:?}: {error}"));
    }
    Ok(toml.unwrap_or_default())
}

/// Formats ordinary application records only when their level is enabled.
#[macro_export]
macro_rules! log {
    ($level:expr, $($arg:tt)*) => {{
        let level = $level;
        if $crate::logging::enabled(level) {
            $crate::logging::log(level, format!($($arg)*));
        }
    }};
}

/// Captures failure diagnostics only when error logging is enabled.
#[macro_export]
macro_rules! log_error {
    ($error:expr, $($arg:tt)*) => {{
        if $crate::logging::enabled($crate::logging::Level::Error) {
            $crate::logging::log_error(format!($($arg)*), &$error);
        }
    }};
}

/// Migrates failure sites that only retain rendered diagnostics into structured errors.
#[macro_export]
macro_rules! log_failure {
    ($level:expr, $($arg:tt)*) => {{
        if $crate::logging::enabled($crate::logging::Level::Error) {
            let message = format!($($arg)*);
            let diagnostic = anyhow::Error::msg(message.clone());
            $crate::logging::log_error(message, &diagnostic);
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checks Rust sources asynchronously so runtime errors cannot bypass structured diagnostics.
    async fn assert_no_ordinary_error_macros(path: &std::path::Path) {
        let mut directories = vec![path.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries = tokio::fs::read_dir(&directory)
                .await
                .expect("source directory should be readable");
            while let Some(entry) = entries
                .next_entry()
                .await
                .expect("source entry should be readable")
            {
                let path = entry.path();
                if entry
                    .file_type()
                    .await
                    .expect("source type should be readable")
                    .is_dir()
                {
                    directories.push(path);
                    continue;
                }
                if path.extension().and_then(std::ffi::OsStr::to_str) != Some("rs")
                    || path.ends_with("logging.rs")
                {
                    continue;
                }
                let source = tokio::fs::read_to_string(&path)
                    .await
                    .expect("Rust source should be UTF-8");
                let compact = source.split_whitespace().collect::<String>();
                // Ordinary error macros lose chains; runtime failures must use a dedicated error macro.
                assert!(
                    !compact.contains("log!(Level::Error,"),
                    "{} contains an ordinary error-level log macro",
                    path.display()
                );
            }
        }
    }

    /// Starts an owned logger because the global OnceLock cannot reset between tests.
    async fn start_logger(format: LogFormat) -> (LoggerHandle, tokio::task::JoinHandle<()>) {
        let logger = Logger::new(None, format)
            .await
            .expect("test logger should open");
        let (records, record_receiver) = mpsc::channel(LOG_RECORD_CAPACITY);
        let (live_entries, _) = broadcast::channel(LIVE_LOG_CAPACITY);
        let handle = LoggerHandle {
            records,
            dropped_records: Arc::new(AtomicU64::new(0)),
            replay: Arc::new(Mutex::new(ReplayState {
                history: VecDeque::with_capacity(LOG_HISTORY_ENTRY_LIMIT),
                live_entries,
            })),
            file_logging_enabled: false,
        };
        let task = tokio::spawn(logger.run(record_receiver));
        (handle, task)
    }

    /// Requests an ordered snapshot as a deterministic barrier.
    async fn snapshot(logger: &LoggerHandle) -> LogSubscription {
        logger.subscribe()
    }

    /// Sends one deterministic record through the production queue lane.
    fn send_log(logger: &LoggerHandle, level: Level, message: String) {
        logger.send_record(LogEntry::new(level, message, None));
    }

    /// Protects timestamp shape and structured serialization fields.
    #[test]
    fn structured_entry_has_rfc3339_millisecond_timestamp() {
        let entry = LogEntry::new(Level::Info, "ready".to_string(), None);
        // Parsing proves the timestamp contains a valid explicit RFC 3339 offset.
        assert!(chrono::DateTime::parse_from_rfc3339(&entry.timestamp).is_ok());
        // The fractional component remains exactly milliseconds for stable display.
        assert!(entry.timestamp.contains('.') && entry.timestamp.len() >= 29);
        let json = serde_json::to_value(&entry).expect("entry serializes");
        // Structured output must retain independent message and severity fields.
        assert_eq!(json["message"], "ready");
        assert_eq!(json["level"], "info");
    }

    /// Ensures line output remains compatible while JSON remains one physical line.
    #[test]
    fn renderers_escape_multiline_records() {
        let entry = LogEntry::new(
            Level::Warning,
            "first
second"
                .to_string(),
            None,
        );
        // Human output preserves embedded line breaks used by existing process-log consumers.
        assert!(entry.render_line().ends_with(
            "first
second"
        ));
        let json = serde_json::to_string(&entry).expect("entry serializes");
        // NDJSON serialization cannot contain a literal embedded newline.
        assert!(!json.contains('\n'));
    }

    /// Locks the compatibility timestamp prefix used by existing line-output consumers.
    #[test]
    fn line_renderer_uses_the_established_timestamp_shape() {
        let entry = LogEntry {
            timestamp: "2026-08-27T12:34:56.789+03:00".to_string(),
            level: Level::Info,
            message: "ready".to_string(),
            error: None,
        };
        // Line mode must not expose the structured RFC 3339 separator or offset.
        assert_eq!(
            entry.render_line(),
            "[2026-08-27 12:34:56.789] [INFO] ready"
        );
    }

    /// Protects exact history capacity and chronological eviction without a log file.
    #[tokio::test]
    async fn history_retains_exactly_latest_one_thousand_records() {
        let (logger, task) = start_logger(LogFormat::Line).await;
        for index in 0..1_010 {
            send_log(&logger, Level::Info, format!("record-{index}"));
        }
        let subscription = snapshot(&logger).await;
        // Replay is capped at exactly the documented process-local window.
        assert_eq!(subscription.entries.len(), LOG_HISTORY_ENTRY_LIMIT);
        // Chronological eviction removes only the oldest ten records.
        assert_eq!(subscription.entries[0].message, "record-10");
        // The newest accepted record remains the final snapshot item.
        assert_eq!(subscription.entries[999].message, "record-1009");
        // Replay remains available even when persistence is disabled.
        assert!(!subscription.file_logging_enabled);
        drop(logger);
        task.await.expect("logger stops");
    }

    /// Protects the atomic snapshot/live boundary.
    #[tokio::test]
    async fn subscription_separates_snapshot_from_live_records() {
        let (logger, task) = start_logger(LogFormat::Line).await;
        send_log(&logger, Level::Info, "history".to_string());
        let mut subscription = snapshot(&logger).await;
        send_log(&logger, Level::Error, "live".to_string());
        let live = subscription
            .receiver
            .recv()
            .await
            .expect("live record arrives");
        // Pre-subscription records appear once in the snapshot.
        assert_eq!(subscription.entries[0].message, "history");
        // Post-subscription records appear once on the live receiver.
        assert_eq!(live.message, "live");
        drop(logger);
        task.await.expect("logger stops");
    }

    /// Protects visible UTF-8-safe diagnostic truncation.
    #[test]
    fn diagnostic_truncation_is_bounded_and_visible() {
        let value = bound_diagnostic("é".repeat(LOG_DIAGNOSTIC_LIMIT));
        // The diagnostic cannot exceed its relay-safe byte allocation.
        assert!(value.len() <= LOG_DIAGNOSTIC_LIMIT);
        // Operators can distinguish truncation from a complete diagnostic.
        assert!(value.ends_with(TRUNCATION_NOTICE));
    }

    /// Protects context/source ordering and explicit unavailable-backtrace representation.
    #[test]
    fn error_details_preserve_anyhow_chain() {
        let error = anyhow::anyhow!("inner cause").context("outer context");
        let details = LogErrorDetails::from_error(&error);
        // Context remains first so the dialog starts with the failed operation.
        assert!(details.chain.starts_with("outer context"));
        // The typed source remains available separately within the full chain.
        assert!(details.chain.contains("Caused by: inner cause"));
        // Disabled capture is represented as absence rather than diagnostic boilerplate.
        if error.backtrace().status() == std::backtrace::BacktraceStatus::Disabled {
            assert!(details.backtrace.is_none());
        }
    }

    /// Protects level and format parsing plus startup precedence.
    #[test]
    fn startup_sources_follow_documented_precedence() {
        // CLI format wins over role environment and TOML.
        assert_eq!(
            resolve_format_sources(
                Some(LogFormat::Json),
                "FORMAT",
                Some("line"),
                Some(LogFormat::Line)
            ),
            Ok(LogFormat::Json)
        );
        // Role environment wins over TOML.
        assert_eq!(
            resolve_format_sources(None, "FORMAT", Some("json"), Some(LogFormat::Line)),
            Ok(LogFormat::Json)
        );
        // TOML wins over the line default.
        assert_eq!(
            resolve_format_sources(None, "FORMAT", None, Some(LogFormat::Json)),
            Ok(LogFormat::Json)
        );
        // Invalid high-priority input fails rather than falling through.
        assert!(resolve_format_sources(None, "FORMAT", Some("pretty"), None).is_err());
        // Existing warning aliases and level ordering remain compatible.
        assert_eq!("warn".parse::<Level>(), Ok(Level::Warning));
    }

    /// Proves disabled macro arguments are not evaluated.
    #[test]
    fn disabled_macro_does_not_evaluate_arguments() {
        let evaluations = std::cell::Cell::new(0);
        set_level(Level::Error);
        crate::log!(Level::Debug, "unused {}", {
            evaluations.set(1);
            "argument"
        });
        set_level(Level::Info);
        // Disabled records must avoid argument formatting and side effects.
        assert_eq!(evaluations.get(), 0);
    }

    /// Guards structured diagnostics as the only runtime error-severity producer path.
    #[tokio::test]
    async fn runtime_sources_do_not_use_ordinary_error_macro() {
        assert_no_ordinary_error_macros(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .as_path(),
        )
        .await;
    }
}
