//! Terminal sizes and lifecycle messages for interactive PTY sessions on agents.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

/// Largest accepted terminal dimension, preventing unreasonable PTY ioctls.
pub const MAX_TERMINAL_DIMENSION: u16 = 1000;

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

/// Lifecycle notifications sent from the agent terminal to the browser.
///
/// `Ready`, `Exit` and `Error` come from the agent. `TakenOver` and `Closed` are only ever
/// sent by the server to an attached browser, because the server owns the session and
/// decides who views it; an agent sending them is ignored.
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
