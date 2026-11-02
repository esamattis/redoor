//! Contract between the server and `redoor agent managed`, the command that keeps a managed
//! agent's daemon running on a device and holds the server's session to it.
//!
//! The server writes one [`ManagedLaunch`] line to the command's stdin. The command makes
//! sure a daemon with exactly these settings runs (keeping a matching one, so its shells
//! survive), prints one [`EnsureReport`] line and then holds the session until stdin ends or
//! the daemon exits, which it reports with a final [`HolderEnd`] line. The daemon itself gets
//! the same payload and connects to the server like any agent.

use crate::identity::BinaryIdentity;
use crate::ids::AgentId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Longest accepted payload line. The payload is a handful of short fields; the bound keeps a
/// peer that never sends a newline from making the agent buffer without limit.
pub const MAX_MANAGED_LAUNCH_BYTES: usize = 16 * 1024;

/// Everything a managed daemon needs, sent as one JSON line on stdin so neither the token nor
/// the settings appear in any process list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedLaunch {
    /// Shared agent token. Never written to disk; the spec hash only covers its fingerprint.
    pub token: String,
    /// Device id the server owns for this entry.
    pub agent_id: AgentId,
    /// Registration name.
    pub name: String,
    /// Logical server URL (`ws://` or `wss://`); its authority supplies TLS SNI and `Host`.
    pub server_url: String,
    /// Skips certificate verification; managed agents always reach the server on loopback or
    /// through a tunnel whose name cannot match the server certificate.
    pub insecure_tls: bool,
    /// Directory the UI opens first; the account home when absent.
    pub home: Option<String>,
    /// Where the daemon opens its TCP-equivalent stream to the server.
    pub connect: ManagedConnect,
    /// Seconds the daemon may stay without an accepted connection before it exits, so a
    /// device whose server is gone for good does not keep a daemon forever.
    pub orphan_timeout: u64,
    /// Replaces the daemon even when it matches (a Restart, or a daemon that stopped
    /// connecting). Not part of the spec hash.
    pub replace: bool,
    /// Whether the server currently has a socket from this agent. A kept daemon is only woken
    /// to reconnect at once when it has none. Not part of the spec hash.
    pub server_connected: bool,
}

/// The physical endpoint of a managed daemon's connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedConnect {
    /// The Unix socket an SSH stream-local reverse forward listens on. A path instead of a
    /// port, because the daemon outlives the SSH session and must find the next session's
    /// forward at the same address.
    Unix(String),
    /// `host:port` of the server's own listener, for managed agents on the server host.
    Tcp(String),
}

/// The settings that make up a daemon's identity, in a fixed order for hashing.
#[derive(Serialize)]
struct SpecFields<'a> {
    token_fingerprint: String,
    agent_id: &'a AgentId,
    name: &'a str,
    server_url: &'a str,
    insecure_tls: bool,
    home: &'a Option<String>,
    connect: &'a ManagedConnect,
    orphan_timeout: u64,
}

impl ManagedLaunch {
    /// Parses one payload line, refusing oversized input before decoding it.
    pub fn parse(line: &[u8]) -> Result<Self, ManagedLaunchError> {
        if line.len() > MAX_MANAGED_LAUNCH_BYTES {
            return Err(ManagedLaunchError::TooLarge);
        }
        serde_json::from_slice(line).map_err(ManagedLaunchError::Invalid)
    }

    /// Encodes the payload as the single line the command reads.
    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("launch payload serializes");
        line.push('\n');
        line
    }

    /// Hash of every setting the running daemon depends on.
    ///
    /// A daemon is kept only when its hash equals the new payload's, so any change (a new
    /// name, home, server port or token) restarts it. The token enters only as a SHA-256
    /// fingerprint, because the hash is written to the daemon's PID file and sent in `hello`.
    /// `replace` and `server_connected` describe the request, not the daemon, and are left out.
    pub fn spec_hash(&self) -> String {
        let fields = SpecFields {
            token_fingerprint: super::agent_auth::to_hex(&Sha256::digest(self.token.as_bytes())),
            agent_id: &self.agent_id,
            name: &self.name,
            server_url: &self.server_url,
            insecure_tls: self.insecure_tls,
            home: &self.home,
            connect: &self.connect,
            orphan_timeout: self.orphan_timeout,
        };
        let canonical = serde_json::to_vec(&fields).expect("spec fields serialize");
        super::agent_auth::to_hex(&Sha256::digest(&canonical))
    }
}

/// Why a payload line was refused.
#[derive(Debug, thiserror::Error)]
pub enum ManagedLaunchError {
    /// The line exceeds [`MAX_MANAGED_LAUNCH_BYTES`].
    #[error("managed launch payload is larger than {MAX_MANAGED_LAUNCH_BYTES} bytes")]
    TooLarge,
    /// The line is not a valid payload.
    #[error("invalid managed launch payload: {0}")]
    Invalid(#[source] serde_json::Error),
}

/// What the ensure step did with the daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnsureOutcome {
    /// A matching daemon was already running and keeps its shells.
    Kept,
    /// No daemon was running, so one was started.
    Started,
    /// A daemon with another binary or settings (or a forced replacement) was replaced.
    Restarted,
}

/// The daemon that runs after a successful ensure step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonReport {
    /// What the ensure step did.
    pub outcome: EnsureOutcome,
    /// Process id of the running daemon.
    pub pid: u32,
    /// Build of the running daemon. The server accepts a `hello` only from this build.
    pub binary: BinaryIdentity,
    /// Spec hash of the running daemon, compared with the one its `hello` carries.
    pub spec_hash: String,
}

/// Why no daemon runs after the ensure step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnsureFailure {
    /// What went wrong.
    pub message: String,
    /// The end of what the daemon wrote to stderr before it gave up, which usually says why.
    pub stderr_tail: String,
}

/// The one report line the ensure step prints after the probe lines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnsureReport {
    /// A daemon runs and the command now holds the session.
    Ready(DaemonReport),
    /// No daemon runs; the command exits after printing this.
    Failed(EnsureFailure),
}

/// The last line the holder prints when it ends on its own, so the server can tell a dead
/// daemon (with the end of its log) from a closed session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "ended", rename_all = "snake_case")]
pub enum HolderEnd {
    /// The daemon released its lock, so it is gone.
    DaemonExited {
        /// The end of the daemon's log file.
        log_tail: String,
    },
    /// The session's stdin ended, which is how the server drops the tunnel.
    StdinEof,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A representative payload for the hashing and parsing tests.
    fn launch() -> ManagedLaunch {
        ManagedLaunch {
            token: "secret-token".to_string(),
            agent_id: AgentId::parse("dev_aaaaaaaaaaaaaaaaaaaa").unwrap(),
            name: "box".to_string(),
            server_url: "ws://localhost:7666/api/v1/agent/ws".to_string(),
            insecure_tls: false,
            home: Some("/home/user".to_string()),
            connect: ManagedConnect::Unix("/run/user/1000/redoor-dev_x.sock".to_string()),
            orphan_timeout: 86_400,
            replace: false,
            server_connected: false,
        }
    }

    /// The payload must survive the trip through one line, including the connect variant.
    #[test]
    fn payload_round_trips_through_one_line() {
        let line = launch().to_line();
        // The holder reads exactly one line, so the encoding must not contain another newline.
        assert_eq!(line.matches('\n').count(), 1);
        assert_eq!(
            ManagedLaunch::parse(line.trim_end().as_bytes()).unwrap(),
            launch()
        );
        // The connect variant is externally tagged so the server and agent agree on its shape.
        assert!(line.contains(r#""connect":{"unix":"/run/user/1000/redoor-dev_x.sock"}"#));
    }

    /// An oversized line is refused before decoding so it cannot be buffered without bound.
    #[test]
    fn oversized_payload_is_refused() {
        let line = vec![b' '; MAX_MANAGED_LAUNCH_BYTES + 1];
        assert!(matches!(
            ManagedLaunch::parse(&line),
            Err(ManagedLaunchError::TooLarge)
        ));
        // Unknown fields are refused, so a mismatched server and agent fail loudly.
        let mut value = serde_json::to_value(launch()).unwrap();
        value["surprise"] = serde_json::json!(true);
        assert!(ManagedLaunch::parse(value.to_string().as_bytes()).is_err());
    }

    /// The hash only depends on the daemon's settings, so a request flag never restarts it,
    /// while every setting and a token rotation do.
    #[test]
    fn spec_hash_is_stable_and_covers_the_settings() {
        let base = launch().spec_hash();
        // The same settings always give the same hash, so a matching daemon is kept.
        assert_eq!(base, launch().spec_hash());
        let mut flags = launch();
        flags.replace = true;
        flags.server_connected = true;
        // Request flags describe this ensure step, not the daemon.
        assert_eq!(flags.spec_hash(), base);
        let mut rotated = launch();
        rotated.token = "rotated-token".to_string();
        // A new token must restart the daemon, which still holds the old one.
        assert_ne!(rotated.spec_hash(), base);
        // The hash ends up in files and frames, so the token must not be recoverable from it.
        assert!(!base.contains("secret-token"));
        let mut moved = launch();
        moved.connect = ManagedConnect::Tcp("localhost:7666".to_string());
        // A changed endpoint means the old daemon would connect to nothing.
        assert_ne!(moved.spec_hash(), base);
        let mut renamed = launch();
        renamed.home = None;
        assert_ne!(renamed.spec_hash(), base);
    }

    /// The report and end lines keep the shapes the server parses.
    #[test]
    fn report_lines_keep_their_wire_shape() {
        let end = serde_json::to_string(&HolderEnd::StdinEof).unwrap();
        assert_eq!(end, r#"{"ended":"stdin_eof"}"#);
        let failed = serde_json::to_string(&EnsureReport::Failed(EnsureFailure {
            message: "m".to_string(),
            stderr_tail: "s".to_string(),
        }))
        .unwrap();
        assert_eq!(failed, r#"{"failed":{"message":"m","stderr_tail":"s"}}"#);
    }
}
