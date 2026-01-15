#[derive(Debug, Clone, Copy)]
pub enum Level {
    Debug,
    Info,
    Warning,
    Error,
}

impl Level {
    fn as_str(&self) -> &str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warning => "WARN",
            Level::Error => "ERROR",
        }
    }
}

pub fn log(level: Level, message: String) {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    println!("[{}] [{}] {}", timestamp, level.as_str(), message);
}

#[macro_export]
macro_rules! log {
    ($level:expr, $($arg:tt)*) => {
        $crate::logging::log($level, format!($($arg)*))
    };
}
