//! Lossless bounded execution events shared by HTTP consumers and agent workers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Keeps argv separate from environment so execution never implies shell parsing.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExecRequest {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[ts(type = "number | null")]
    pub timeout_ms: Option<u64>,
}

impl ExecRequest {
    /// Rejects invalid process inputs before accepting remote work.
    pub fn validate(&self) -> Result<(), String> {
        if self.argv.first().is_none_or(|arg| arg.is_empty())
            || self.argv.iter().any(|arg| arg.contains('\0'))
        {
            return Err("argv requires a nonempty command and cannot contain NUL".into());
        }
        if self
            .cwd
            .as_ref()
            .is_some_and(|cwd| !cwd.starts_with('/') || cwd.contains('\0'))
        {
            return Err("cwd must be an absolute remote path without NUL".into());
        }
        if self
            .env
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
        {
            return Err(
                "environment requires nonempty keys without '=' or NUL, and values without NUL"
                    .into(),
            );
        }
        if self
            .timeout_ms
            .is_some_and(|ms| ms == 0 || ms > 31_536_000_000)
        {
            return Err("timeout must be positive and at most 365 days".into());
        }
        Ok(())
    }
}

/// Byte arrays preserve binary output and split UTF-8 sequences without unbounded accumulation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ExecEvent {
    Stdout {
        data: Vec<u8>,
    },
    Stderr {
        data: Vec<u8>,
    },
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
    TimedOut,
    Canceled,
    Error {
        message: String,
    },
}
