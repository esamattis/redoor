//! Websocket upgrade contract between agents and the server.
//!
//! Authentication and protocol negotiation happen during the HTTP upgrade instead of in a first
//! JSON frame, so a client without the token or with an incompatible protocol never gets a
//! websocket at all and the server never has to hold state for one. The `hello` only finishes
//! the mutual token proof (see [`agent_auth`](super::agent_auth)).

use crate::ids::UnixTimestampMillis;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Websocket subprotocol both sides must agree on; bumped whenever the frame contract changes
/// incompatibly, so mismatched builds fail the upgrade instead of misreading each other.
pub const PROTOCOL: &str = "redoor.v7";
/// The single endpoint agents connect to.
pub const AGENT_WS_PATH: &str = "/api/v1/agent/ws";
/// Agent binary version sent with the upgrade, only for diagnosing rejected connections.
pub const AGENT_VERSION_HEADER: &str = "x-redoor-agent-version";

/// Body of the `426 Upgrade Required` answer to an agent that does not offer [`PROTOCOL`].
///
/// The agent shows it verbatim so an operator learns which side needs upgrading instead of
/// seeing an endless reconnect loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProtocolMismatchResponse {
    /// Subprotocol this server speaks.
    pub server_protocol: String,
    /// Binary version of this server.
    pub server_version: String,
    /// Human-readable explanation suitable for the agent log.
    pub message: String,
}

/// One recent agent connection attempt that failed protocol negotiation.
///
/// Kept by the server in a small bounded list because a mismatched agent never registers and
/// would otherwise be invisible in the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProtocolMismatchAttempt {
    /// When the upgrade was rejected.
    pub at: UnixTimestampMillis,
    /// Peer address of the TCP connection (the tunnel end for SSH-launched agents).
    pub remote_address: String,
    /// Client chain a reverse proxy claims in `X-Forwarded-For` (or `X-Real-IP`). Behind a
    /// proxy the peer address is the proxy, so this is what identifies the agent's host; it is
    /// unverified, since any client can send the header.
    pub forwarded_for: Option<String>,
    /// Agent binary version from the upgrade header, when the agent sent one.
    pub agent_version: Option<String>,
    /// Subprotocols the agent offered; empty when it offered none.
    pub offered_protocols: Vec<String>,
}

/// Recent protocol-mismatched agent connection attempts, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProtocolMismatchListResponse {
    /// Subprotocol this server speaks, so the UI can explain what the agents lack.
    pub server_protocol: String,
    /// Bounded list of the most recent rejected attempts.
    pub attempts: Vec<ProtocolMismatchAttempt>,
}

/// Why the server refused an agent's `hello`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    /// Another live agent id already uses this agent name.
    DuplicateName,
    /// The managed agent with this id was intentionally stopped.
    Stopped,
    /// The `hello` carried an id that is not in the device id format or a name that breaks
    /// the device name rules; retrying cannot help until the agent is reconfigured.
    InvalidIdentity,
    /// Several machines keep replacing each other's healthy connections with the same id
    /// (a cloned data dir); the agent retries with backoff so a fixed clone gets through.
    DuplicateId,
    /// A managed daemon whose build or launch settings differ from the daemon the server's
    /// latest ensure step reported. The daemon exits, and the next ensure step starts the
    /// expected one.
    Superseded,
}

/// Parses the offered subprotocols of one upgrade request (a comma-separated header value).
pub fn offered_protocols(header: &str) -> Vec<String> {
    header
        .split(',')
        .map(str::trim)
        .filter(|protocol| !protocol.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the offered-protocol parser tolerates the spacing browsers and clients use.
    #[test]
    fn offered_protocols_splits_and_trims_the_header() {
        // Both comma forms appear in practice, and empty items must not count as offers.
        assert_eq!(
            offered_protocols("redoor.v1, redoor.v2,,"),
            vec!["redoor.v1".to_string(), "redoor.v2".to_string()]
        );
        // An absent offer yields no protocols rather than one empty string.
        assert!(offered_protocols("").is_empty());
    }
}
