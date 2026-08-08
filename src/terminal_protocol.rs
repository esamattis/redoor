use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

/// Largest accepted terminal dimension, preventing unreasonable PTY ioctls.
pub const MAX_TERMINAL_DIMENSION: u16 = 1000;

/// Identifies one ephemeral terminal tunnel from creation through PTY teardown.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "string")]
pub struct TerminalId(pub Uuid);

impl TerminalId {
    /// Creates an unpredictable public rendezvous identifier for one terminal.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TerminalId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for TerminalId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Reports dimensions that cannot safely be passed to the PTY ioctl.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("terminal rows and columns must be between 1 and {MAX_TERMINAL_DIMENSION}")]
pub struct InvalidTerminalSize;

/// Validated terminal cell dimensions shared by browser, server, and agent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
}

/// First agent frame proving possession of the one-time bootstrap secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalAgentHandshake {
    Authenticate { token: String },
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
        let id = TerminalId(Uuid::nil());
        // The UUID newtype stays a plain string in JSON and generated TypeScript.
        assert_eq!(
            serde_json::to_string(&id).unwrap(),
            "\"00000000-0000-0000-0000-000000000000\""
        );
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
        let handshake = TerminalAgentHandshake::Authenticate {
            token: "secret".into(),
        };
        // Authentication is carried in the first text frame, not the URL.
        assert_eq!(
            serde_json::to_value(handshake).unwrap()["type"],
            "authenticate"
        );
    }
}
