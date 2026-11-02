//! Process-wide structured logging: the `log!` sink, stdout/file output and the live
//! replay feed that browsers subscribe to.

use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, PoisonError, RwLock,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
};

use anyhow::Result;
use redoor_protocol::wire::log::{
    LOG_DIAGNOSTIC_LIMIT, LOG_HISTORY_ENTRY_LIMIT, LOG_MESSAGE_LIMIT, Level, LogEntry,
    LogErrorDetails,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    sync::{
        broadcast,
        mpsc::{self, Sender, error::TrySendError},
    },
};
use ts_rs::TS;

use crate::rotating_log::{LogFileSpec, RotatingLogFile};

/// Live subscriber backlog; a slower subscriber lags and skips entries instead of blocking logging.
const LIVE_LOG_CAPACITY: usize = 1_024;
/// Bounds records queued for the output task so a stalled stdout or file cannot grow memory;
/// overflow is counted as dropped instead of blocking the caller.
const LOG_RECORD_CAPACITY: usize = 2_048;
/// Appended to truncated diagnostics so readers know content was cut, not missing.
const TRUNCATION_NOTICE: &str = "
[diagnostic truncated]";

/// Sink the `log!` macros write through; replaceable so tests and embedders can inject one.
///
/// The macros stay global because threading a logger through every call site would touch
/// almost every function, but the sink itself is an ordinary owned [`LoggerHandle`].
static LOGGER: RwLock<Option<LoggerHandle>> = RwLock::new(None);
/// Admission threshold read by the macros before formatting; process-wide by design.
static LOG_LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);

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

/// Extracts the complete anyhow diagnostic before the bounded producer enqueue.
fn error_details(error: &anyhow::Error) -> LogErrorDetails {
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
    LogErrorDetails {
        chain: bound_diagnostic(chain),
        backtrace,
    }
}

/// Distinguishes application records from overload notices.
enum LogRecord {
    /// Carries one accepted application record without waiting for output.
    Message(LogEntry),
    /// Answers once every record queued before it was written.
    Flush(tokio::sync::oneshot::Sender<()>),
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
///
/// Cloning shares the same output task; the task ends when the last clone is dropped.
#[derive(Clone)]
pub struct LoggerHandle {
    records: Sender<LogRecord>,
    dropped_records: Arc<AtomicU64>,
    replay: Arc<Mutex<ReplayState>>,
    file_logging_enabled: bool,
}

impl LoggerHandle {
    /// Opens the optional log file and starts the single output task owning stdout and file I/O.
    pub async fn spawn(log_file: Option<LogFileSpec>, format: LogFormat) -> Result<Self> {
        let (records, record_receiver) = mpsc::channel(LOG_RECORD_CAPACITY);
        let logger = Logger::new(log_file, format).await?;
        let file_logging_enabled = logger.log_file.is_some();
        let (live_entries, _) = broadcast::channel(LIVE_LOG_CAPACITY);
        tokio::spawn(logger.run(record_receiver));
        Ok(Self {
            records,
            dropped_records: Arc::new(AtomicU64::new(0)),
            replay: Arc::new(Mutex::new(ReplayState {
                history: VecDeque::with_capacity(LOG_HISTORY_ENTRY_LIMIT),
                live_entries,
            })),
            file_logging_enabled,
        })
    }

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
    pub fn subscribe(&self) -> LogSubscription {
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
struct Logger {
    /// Size-bounded persistent output; `None` without a configured file or after a write
    /// failure, so a broken disk does not stop stdout logging.
    log_file: Option<RotatingLogFile>,
    format: LogFormat,
}

impl Logger {
    /// Opens persistent output before startup so availability is authoritative.
    async fn new(log_file: Option<LogFileSpec>, format: LogFormat) -> Result<Self> {
        let log_file = match log_file {
            Some(spec) => Some(spec.open().await?),
            None => None,
        };
        Ok(Self { log_file, format })
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
            && let Err(error) = file.write_message(&bytes).await
        {
            Self::report_file_error("write", file.path(), &error);
            self.log_file = None;
        }
    }

    /// Processes one bounded record while preserving output ownership.
    async fn process_record(&mut self, record: LogRecord) {
        match record {
            LogRecord::Message(entry) => self.write_entry(entry).await,
            LogRecord::Flush(done) => {
                let _ = done.send(());
            }
        }
    }

    /// Drains records through one output owner without coupling subscriptions to sink latency.
    async fn run(mut self, mut records: mpsc::Receiver<LogRecord>) {
        while let Some(record) = records.recv().await {
            self.process_record(record).await;
        }
    }
}

/// Waits, at most `timeout`, until every record logged so far was written.
///
/// Output is asynchronous, so a process that is about to exit would otherwise lose its last
/// records, which are usually the ones explaining why it exits.
pub async fn flush(timeout: std::time::Duration) {
    let Some(logger) = current() else {
        return;
    };
    let (done, written) = tokio::sync::oneshot::channel();
    let flushed = async {
        if logger.records.send(LogRecord::Flush(done)).await.is_ok() {
            let _ = written.await;
        }
    };
    let _ = tokio::time::timeout(timeout, flushed).await;
}

/// Initializes the process-global logger with the info threshold and line output.
pub async fn init(log_file: Option<LogFileSpec>) -> Result<()> {
    init_with_options(log_file, Level::Info, LogFormat::Line).await
}

/// Initializes logging with a threshold and line output.
pub async fn init_with_level(log_file: Option<LogFileSpec>, level: Level) -> Result<()> {
    init_with_options(log_file, level, LogFormat::Line).await
}

/// Initializes logging after the owning process role resolves startup options.
///
/// Keeps an already installed sink: role startup runs once per process, and tests that
/// call this repeatedly (or injected their own sink first) must not be replaced.
pub async fn init_with_options(
    log_file: Option<LogFileSpec>,
    level: Level,
    format: LogFormat,
) -> Result<()> {
    if current().is_some() {
        return Ok(());
    }
    set_level(level);
    let handle = LoggerHandle::spawn(log_file, format).await?;
    let mut slot = LOGGER.write().unwrap_or_else(PoisonError::into_inner);
    if slot.is_none() {
        *slot = Some(handle);
    }
    Ok(())
}

/// Replaces the sink behind the `log!` macros and returns the previous one.
///
/// Lets tests capture records through [`LoggerHandle::subscribe`] and restore the
/// previous sink afterwards.
pub fn install(handle: LoggerHandle) -> Option<LoggerHandle> {
    LOGGER
        .write()
        .unwrap_or_else(PoisonError::into_inner)
        .replace(handle)
}

/// Returns the installed sink; a short read lock keeps producers effectively lock-free.
fn current() -> Option<LoggerHandle> {
    LOGGER
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// Establishes an ordered snapshot/live boundary without blocking producers.
pub async fn subscribe() -> Result<LogSubscription, SubscribeError> {
    let logger = current().ok_or(SubscribeError::LoggerClosed)?;
    Ok(logger.subscribe())
}

/// Delivers a record to the installed sink, or to stderr before any sink exists.
///
/// The stderr fallback keeps early-startup and unit-test records visible instead of
/// panicking when no role has initialized logging yet.
fn deliver(entry: LogEntry) {
    match current() {
        Some(logger) => logger.send_record(entry),
        None => eprintln!("{}", entry.render_line()),
    }
}

/// Enqueues an ordinary entry immediately.
pub fn log(level: Level, message: String) {
    deliver(with_current_user(LogEntry::new(
        level,
        bound_message(message),
        None,
    )));
}

/// Enqueues a failure with its preserved anyhow chain and captured backtrace.
pub fn log_error(message: String, error: &anyhow::Error) {
    deliver(with_current_user(LogEntry::new(
        Level::Error,
        bound_message(message),
        Some(error_details(error)),
    )));
}

tokio::task_local! {
    /// The signed-in user the current task works for, such as `alice (password)`.
    ///
    /// A task-local instead of a parameter, because the user must reach log lines deep in
    /// code that has no reason to know about authentication. Set by the HTTP access layer
    /// for each request and carried into spawned work by [`spawn_in_user_scope`].
    static CURRENT_USER: Arc<str>;
}

/// Adds the current task's user to a record, so every log line written while serving a
/// request names who made it.
fn with_current_user(mut entry: LogEntry) -> LogEntry {
    entry.user = current_user().map(|user| bound_message(user.to_string()));
    entry
}

/// The user the current task works for, or `None` for background work without a requester.
pub fn current_user() -> Option<Arc<str>> {
    CURRENT_USER.try_with(Arc::clone).ok()
}

/// Runs `future` with `user` as the user named in its log lines; `None` runs it without one,
/// for operations started in the background.
pub async fn user_scope<F: std::future::Future>(user: Option<Arc<str>>, future: F) -> F::Output {
    match user {
        Some(user) => CURRENT_USER.scope(user, future).await,
        None => future.await,
    }
}

/// Runs `function` with `user` as the user named in its log lines, for synchronous work such
/// as an actor handling a message on behalf of whoever sent it; `None` runs it without one.
pub fn sync_user_scope<R>(user: Option<Arc<str>>, function: impl FnOnce() -> R) -> R {
    match user {
        Some(user) => CURRENT_USER.sync_scope(user, function),
        None => function(),
    }
}

/// `tokio::spawn` that keeps the current user for the new task's log lines.
///
/// Task-locals do not cross `tokio::spawn`, so request code that hands work to its own task
/// spawns through this instead, or that work would log without the user who asked for it.
pub fn spawn_in_user_scope<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(user_scope(current_user(), future))
}

/// `tokio::task::spawn_blocking` that keeps the current user for the closure's log lines,
/// for the same reason as [`spawn_in_user_scope`].
pub fn spawn_blocking_in_user_scope<F, R>(function: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let user = current_user();
    tokio::task::spawn_blocking(move || sync_user_scope(user, function))
}

/// Enqueues a command failure at the severity its kind deserves.
///
/// Error-level failures keep the structured diagnostic shape of [`log_error`] so operator
/// faults look the same as every other runtime error, while expected outcomes stay plain.
pub fn log_command_failure(
    level: Level,
    context: String,
    error: &redoor_protocol::wire::request::CommandError,
) {
    let message = format!("{context}, kind={:?}, error={}", error.kind, error.message);
    if level == Level::Error {
        log_error(message, &anyhow::Error::msg(error.message.clone()));
    } else {
        log(level, message);
    }
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

/// A role-specific logging environment variable holds a value the setting does not accept.
///
/// Rejected rather than ignored so a typo cannot silently fall back to the TOML value.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid {variable} value {value:?}: {reason}")]
pub struct InvalidLogSetting {
    /// Environment variable name.
    variable: String,
    /// Raw value found there.
    value: String,
    /// Accepted vocabulary.
    reason: String,
}

/// Resolves CLI, role-specific environment, TOML, then the info default.
pub fn resolve_initial_level(
    cli: Option<Level>,
    role_env_name: &str,
    toml: Option<Level>,
) -> std::result::Result<Level, InvalidLogSetting> {
    resolve_level_sources(
        cli,
        role_env_name,
        std::env::var(role_env_name).ok().as_deref(),
        toml,
    )
}

/// Applies level precedence to an already captured environment value.
///
/// Public so role startup can resolve settings as a pure function of its inputs.
pub fn resolve_level_sources(
    cli: Option<Level>,
    role_env_name: &str,
    role_env: Option<&str>,
    toml: Option<Level>,
) -> std::result::Result<Level, InvalidLogSetting> {
    if let Some(level) = cli {
        return Ok(level);
    }
    if let Some(value) = role_env {
        return value.parse::<Level>().map_err(|reason| InvalidLogSetting {
            variable: role_env_name.to_string(),
            value: value.to_string(),
            reason,
        });
    }
    Ok(toml.unwrap_or_default())
}

/// Resolves CLI, role-specific environment, TOML, then the line default.
pub fn resolve_initial_format(
    cli: Option<LogFormat>,
    role_env_name: &str,
    toml: Option<LogFormat>,
) -> std::result::Result<LogFormat, InvalidLogSetting> {
    resolve_format_sources(
        cli,
        role_env_name,
        std::env::var(role_env_name).ok().as_deref(),
        toml,
    )
}

/// Applies format precedence to an already captured environment value.
///
/// Public so role startup can resolve settings as a pure function of its inputs.
pub fn resolve_format_sources(
    cli: Option<LogFormat>,
    role_env_name: &str,
    role_env: Option<&str>,
    toml: Option<LogFormat>,
) -> std::result::Result<LogFormat, InvalidLogSetting> {
    if let Some(format) = cli {
        return Ok(format);
    }
    if let Some(value) = role_env {
        return value
            .parse::<LogFormat>()
            .map_err(|reason| InvalidLogSetting {
                variable: role_env_name.to_string(),
                value: value.to_string(),
                reason,
            });
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
        if $crate::logging::enabled(::redoor_protocol::wire::log::Level::Error) {
            $crate::logging::log_error(format!($($arg)*), &$error);
        }
    }};
}

/// Logs a failed command at the level chosen by its kind, formatting only when enabled.
#[macro_export]
macro_rules! log_command_failure {
    ($error:expr, $($arg:tt)*) => {{
        let error: &::redoor_protocol::wire::request::CommandError = &$error;
        let level = error.kind.log_level();
        if $crate::logging::enabled(level) {
            $crate::logging::log_command_failure(level, format!($($arg)*), error);
        }
    }};
}

/// Migrates failure sites that only retain rendered diagnostics into structured errors.
#[macro_export]
macro_rules! log_failure {
    ($level:expr, $($arg:tt)*) => {{
        if $crate::logging::enabled(::redoor_protocol::wire::log::Level::Error) {
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

    /// Starts an owned logger so each test observes only its own records.
    async fn start_logger(format: LogFormat) -> LoggerHandle {
        LoggerHandle::spawn(None, format)
            .await
            .expect("test logger should open")
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
        assert!(entry.timestamp.parse::<jiff::Timestamp>().is_ok());
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
            user: None,
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
        let logger = start_logger(LogFormat::Line).await;
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
    }

    /// Protects the atomic snapshot/live boundary.
    #[tokio::test]
    async fn subscription_separates_snapshot_from_live_records() {
        let logger = start_logger(LogFormat::Line).await;
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
        let details = error_details(&error);
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
        // `warn`, the spelling of the line-output label, names the warning level too.
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
    ///
    /// Scans every workspace crate because the logging macros are shared by all of them.
    #[tokio::test]
    async fn runtime_sources_do_not_use_ordinary_error_macro() {
        let crates_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core crate should live inside the crates directory");
        assert_no_ordinary_error_macros(crates_dir).await;
    }

    /// Records written inside a user scope name the user, also from tasks spawned through
    /// the scope-keeping helpers, and records outside it do not.
    #[tokio::test]
    async fn user_scope_reaches_records_and_spawned_tasks() {
        let user: Arc<str> = Arc::from("alice (password)");
        let entry = user_scope(Some(user.clone()), async {
            with_current_user(LogEntry::new(Level::Info, "inside".to_string(), None))
        })
        .await;
        // A record written inside the scope carries the user.
        assert_eq!(entry.user.as_deref(), Some("alice (password)"));
        let spawned = user_scope(Some(user.clone()), async {
            spawn_in_user_scope(async { current_user() }).await.unwrap()
        })
        .await;
        // `tokio::spawn` alone would lose the task-local; the helper carries it over.
        assert_eq!(spawned.as_deref(), Some("alice (password)"));
        let blocking = user_scope(Some(user), async {
            spawn_blocking_in_user_scope(current_user).await.unwrap()
        })
        .await;
        // Blocking work keeps the user too.
        assert_eq!(blocking.as_deref(), Some("alice (password)"));
        // Outside any scope there is no user.
        assert!(current_user().is_none());
        assert!(
            with_current_user(LogEntry::new(Level::Info, "outside".to_string(), None))
                .user
                .is_none()
        );
    }

    /// Producers write through whatever sink is installed, so tests can capture records.
    ///
    /// Calls `log` directly: the macro adds only the level gate, which another test in
    /// this module toggles concurrently.
    #[tokio::test]
    async fn records_go_through_an_injected_logger() {
        let capture = start_logger(LogFormat::Line).await;
        let previous = install(capture.clone());
        log(Level::Warning, "captured-by-injected-logger".to_string());
        if let Some(previous) = previous {
            install(previous);
        }
        // Other tests may log concurrently, so look for this test's unique record.
        assert!(
            capture
                .subscribe()
                .entries
                .iter()
                .any(|entry| entry.message == "captured-by-injected-logger")
        );
    }
}
