//! Terminal sizes and lifecycle messages for interactive PTY sessions on agents.

use crate::api::terminals::{TerminalActivity, TerminalSessionStatus};
use crate::ids::{TerminalSessionId, UnixTimestampMillis};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;
use ts_rs::TS;

/// Largest accepted terminal dimension, preventing unreasonable PTY ioctls.
pub const MAX_TERMINAL_DIMENSION: u16 = 1000;

/// Variable every terminal shell gets with the redoor server's hostname, so prompts and
/// scripts can tell which server a shell was opened through.
pub const REDOOR_SERVER_ENV: &str = "REDOOR_SERVER";

/// Most variables one device's `terminal_env` may hold; a bound because every shell start
/// carries them in one control frame.
pub const MAX_TERMINAL_ENV_VARIABLES: usize = 256;

/// Longest accepted `terminal_env` value in bytes, generous for PATH-like lists but small
/// enough that the whole set always fits a control frame.
pub const MAX_TERMINAL_ENV_VALUE_BYTES: usize = 4096;

/// Checks a device's `terminal_env` before it is saved or used.
///
/// Names are limited to the portable shell identifier form, because a shell cannot `export`
/// or expand anything else. A NUL byte cannot pass through `execve`, so spawning the shell
/// would fail. [`REDOOR_SERVER_ENV`] is set by redoor itself and refused, so a config never
/// claims a value the shell will not see.
pub fn validate_terminal_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    if env.len() > MAX_TERMINAL_ENV_VARIABLES {
        return Err(format!(
            "terminal_env must have at most {MAX_TERMINAL_ENV_VARIABLES} variables"
        ));
    }
    for (name, value) in env {
        let mut characters = name.chars();
        let valid_name = characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
            && characters.all(|character| character.is_ascii_alphanumeric() || character == '_');
        if !valid_name {
            return Err(format!(
                "terminal_env name '{name}' must start with a letter or '_' and contain only letters, digits and '_'"
            ));
        }
        if name == REDOOR_SERVER_ENV {
            return Err(format!(
                "terminal_env must not set {REDOOR_SERVER_ENV}; redoor sets it to the server's hostname"
            ));
        }
        if value.contains('\0') {
            return Err(format!(
                "terminal_env value of '{name}' must not contain NUL bytes"
            ));
        }
        if value.len() > MAX_TERMINAL_ENV_VALUE_BYTES {
            return Err(format!(
                "terminal_env value of '{name}' must be at most {MAX_TERMINAL_ENV_VALUE_BYTES} bytes"
            ));
        }
    }
    Ok(())
}

/// Reports dimensions that cannot safely be passed to the PTY ioctl.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("terminal rows and columns must be between 1 and {MAX_TERMINAL_DIMENSION}")]
pub struct InvalidTerminalSize;

/// Validated terminal cell dimensions shared by browser, server, and agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalSize {
    /// Rejects dimensions that are invalid or unreasonable for a Unix PTY.
    pub fn new(rows: u16, cols: u16) -> Result<Self, InvalidTerminalSize> {
        let size = Self { rows, cols };
        size.validate()?;
        Ok(size)
    }

    /// Revalidates values after every deserialization trust boundary.
    pub fn validate(self) -> Result<(), InvalidTerminalSize> {
        if (1..=MAX_TERMINAL_DIMENSION).contains(&self.rows)
            && (1..=MAX_TERMINAL_DIMENSION).contains(&self.cols)
        {
            Ok(())
        } else {
            Err(InvalidTerminalSize)
        }
    }
}

/// Controls sent from the browser terminal to the agent PTY.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum TerminalClientMessage {
    Resize { size: TerminalSize },
}

/// One terminal session as the agent that runs it reports it.
///
/// The agent owns the shell and keeps this record next to it, so a restarted server learns
/// every session again, with the metadata its tabs show, as soon as the agent reconnects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSessionRecord {
    pub id: TerminalSessionId,
    /// Directory the shell started in.
    pub cwd: String,
    /// Tab title chosen by the creating window.
    pub title: String,
    /// Per-device tab number.
    pub number: u32,
    pub created_at: UnixTimestampMillis,
    pub status: TerminalSessionStatus,
    /// What the shell is doing now. Defaults to nothing known, so an agent built before the
    /// field existed still reports its sessions.
    #[serde(default)]
    pub activity: TerminalActivity,
}

/// Lifecycle notifications sent from the agent terminal to the browser.
///
/// `Ready`, `Exit` and `Error` come from the agent. `TakenOver` and `Closed` are only ever
/// sent by the server to an attached browser, because the server decides which browser views
/// a session; an agent sending them is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum TerminalServerMessage {
    Ready,
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
    Error {
        message: String,
    },
    /// Another browser window attached to the session, so this one stopped viewing it.
    TakenOver,
    /// The session was closed (deleted) while this browser was attached.
    Closed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_terminal_size_boundaries() {
        // The minimum dimensions remain usable for deliberately tiny panels.
        assert!(TerminalSize::new(1, 1).is_ok());
        // The explicit maximum protects the upper accepted PTY ioctl boundary.
        assert!(TerminalSize::new(1000, 1000).is_ok());
        // Zero-sized terminals cannot be represented by a usable browser canvas.
        assert!(TerminalSize::new(0, 1).is_err());
        // Values above the bound cannot reach a PTY resize ioctl.
        assert!(TerminalSize::new(1, 1001).is_err());
    }

    /// Builds a one-variable environment for the validation cases below.
    fn env(name: &str, value: &str) -> BTreeMap<String, String> {
        BTreeMap::from([(name.to_string(), value.to_string())])
    }

    #[test]
    fn validates_terminal_env() {
        // Ordinary shell identifiers, including a leading underscore, are accepted.
        assert!(validate_terminal_env(&env("_EDITOR_2", "vim -u NONE")).is_ok());
        // A name a shell cannot export is refused.
        assert!(validate_terminal_env(&env("2FA", "x")).is_err());
        assert!(validate_terminal_env(&env("MY-VAR", "x")).is_err());
        assert!(validate_terminal_env(&env("", "x")).is_err());
        // redoor owns REDOOR_SERVER, so the config cannot pretend to set it.
        assert!(validate_terminal_env(&env(REDOOR_SERVER_ENV, "x")).is_err());
        // execve cannot pass a NUL byte, so the shell would fail to start.
        assert!(validate_terminal_env(&env("A", "a\0b")).is_err());
        // An oversized value would bloat every shell start's control frame.
        let long = "x".repeat(MAX_TERMINAL_ENV_VALUE_BYTES + 1);
        assert!(validate_terminal_env(&env("A", &long)).is_err());
    }

    #[test]
    fn serializes_terminal_wire_types() {
        let resize = TerminalClientMessage::Resize {
            size: TerminalSize::new(24, 80).unwrap(),
        };
        // The tagged resize shape is stable across browser, relay, and agent.
        assert_eq!(serde_json::to_value(resize).unwrap()["type"], "resize");
        // Ready is a typed lifecycle control rather than terminal output bytes.
        assert_eq!(
            serde_json::to_value(TerminalServerMessage::Ready).unwrap()["type"],
            "ready"
        );
    }
}
