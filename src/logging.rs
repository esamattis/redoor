use std::fs::File;

use std::io::Write;
use std::sync::OnceLock;

use tokio::sync::mpsc::{self, UnboundedSender};

static LOGGER: OnceLock<UnboundedSender<LogMessage>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warning,
    Error,
}

impl Level {
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

struct LogMessage {
    level: Level,
    message: String,
}

/// Owns the log file handle inside the background writer task so concurrent
/// callers can enqueue messages without sharing mutable file state.
pub struct Logger {
    log_file_path: Option<String>,
    log_file: Option<File>,
    level: Level,
}

impl Logger {
    /// Creates a task-local logger and opens the optional log file eagerly so
    /// subsequent log writes can reuse the same file handle.
    pub fn new(log_file_path: Option<String>) -> Self {
        let log_file = match &log_file_path {
            Some(path) => match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                Ok(file) => Some(file),
                Err(error) => {
                    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                    eprintln!(
                        "[{}] [ERROR] Failed to open log file '{}': {}",
                        timestamp, path, error
                    );
                    None
                }
            },
            None => None,
        };

        let level = match std::env::var("REDOOR_LOGLEVEL").as_deref() {
            Ok("trace") => Level::Trace,
            Ok("debug") => Level::Debug,
            Ok("warn") => Level::Warning,
            Ok("error") => Level::Error,
            _ => Level::Info,
        };

        Self {
            log_file_path,
            log_file,
            level,
        }
    }

    fn write(&mut self, level: Level, message: String) {
        if level < self.level {
            return;
        }

        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let formatted = format!("[{}] [{}] {}", timestamp, level.as_str(), message);

        println!("{}", formatted);

        if let Some(file) = self.log_file.as_mut()
            && let Err(error) = writeln!(file, "{}", formatted)
        {
            let log_file_path = self.log_file_path.as_deref().unwrap_or("<unknown>");
            eprintln!(
                "[{}] [ERROR] Failed to write log file '{}': {}",
                timestamp, log_file_path, error
            );
        }
    }

    async fn run(mut self, mut receiver: mpsc::UnboundedReceiver<LogMessage>) {
        let mut buffered_messages = Vec::with_capacity(64);

        loop {
            let received = receiver.recv_many(&mut buffered_messages, 64).await;
            if received == 0 {
                break;
            }

            for log_message in buffered_messages.drain(..) {
                self.write(log_message.level, log_message.message);
            }
        }
    }
}

/// Initializes the global logger once during application startup.
pub fn init(log_file_path: Option<String>) {
    let _ = LOGGER.get_or_init(|| {
        let (sender, receiver) = mpsc::unbounded_channel();
        let logger = Logger::new(log_file_path);

        tokio::spawn(async move {
            logger.run(receiver).await;
        });

        sender
    });
}

pub fn log(level: Level, message: String) {
    let logger = LOGGER.get().expect("global logger is unavailable");
    let _ = logger.send(LogMessage { level, message });
}

#[macro_export]
macro_rules! log {
    ($level:expr, $($arg:tt)*) => {
        $crate::logging::log($level, format!($($arg)*))
    };
}
