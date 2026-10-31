//! Agent <-> server websocket protocol: the control envelope and its framing helpers.
//!
//! Identity is a property of the authenticated connection, not of individual frames: only the
//! first frame (`hello`) names the agent, and every later frame is attributed to whoever owns the
//! socket. Request ids are scoped to one connection and allocated by the server.

pub mod command;
pub mod exec;
pub mod handshake;
pub mod log;
pub mod partials;
pub mod policy;
pub mod registration;
pub mod request;
pub mod stream;
pub mod terminal;

use crate::ids::{AgentId, RequestId, SocketId};
use command::Command;
use handshake::RejectReason;
use registration::{AgentCapabilities, AgentIdentity};
use request::CommandOutcome;
use serde::{Deserialize, Serialize};

/// Control frames sent by the server to an agent.
///
/// Split from [`AgentToServer`] so each side matches only the frames it can receive and a new
/// variant cannot be silently ignored by a `_` arm.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToAgent {
    /// Accepts the agent's `hello`; the connection now speaks for that agent.
    Welcome {
        /// Server-side identity of this connection, shown in diagnostics and the UI.
        connection_id: SocketId,
    },

    /// Refuses the agent's `hello`; the agent must not retry with the same identity.
    Rejected {
        reason: RejectReason,
        message: String,
    },

    /// Ends an accepted connection on purpose (replaced by a newer connection of the same
    /// agent, or the managed agent was stopped). Managed agents exit instead of reconnecting;
    /// standalone agents reconnect with backoff, because being replaced means another machine
    /// uses their id and the server can only detect that while both keep trying.
    Evicted { message: String },

    /// Returns flow-control credit for one agent-to-server stream (download or exec output).
    ///
    /// The agent may have at most the granted number of non-terminal frames in flight per
    /// stream, so one slow consumer stalls only its own stream instead of the shared socket.
    Credit { stream: RequestId, frames: u32 },

    /// Starts a request on the agent; `id` correlates its result and is the id of its stream.
    ///
    /// `credit` is the initial window of an agent-to-server stream (downloads, exec output),
    /// so output starts without a round trip; it is zero for every other command.
    Command {
        id: RequestId,
        credit: u32,
        command: Command,
    },

    /// Orders upload publication against cancellation in the router's authoritative lifecycle.
    PublishDecision { id: RequestId, allowed: bool },

    /// Asks the agent to stop a request-cancelable command, a terminal or a log stream; they
    /// share one id space per connection.
    ///
    /// Only sent for a command whose frame was already written, so the agent always knows the
    /// id; a cancel for an id the agent has already answered is ignored.
    Cancel {
        id: RequestId,
        #[serde(default, skip_serializing_if = "partials::CancelReason::is_canceled")]
        reason: partials::CancelReason,
    },

    /// Starts a PTY whose output and input travel on stream `stream` of this connection.
    TerminalOpen {
        stream: RequestId,
        size: terminal::TerminalSize,
        cwd: String,
    },

    /// Resizes the PTY of terminal stream `stream`.
    TerminalResize {
        stream: RequestId,
        size: terminal::TerminalSize,
    },

    /// Starts relaying this agent's log events as NDJSON on stream `stream`.
    LogStreamOpen { stream: RequestId },
}

impl ServerToAgent {
    /// Recovers the request id of a `command` frame whose body did not parse.
    ///
    /// Both sides speak the same protocol version, so this only happens through a bug; answering
    /// with a typed error lets the waiting REST caller fail immediately instead of timing out.
    /// Other frame types are not answered because they have no result to correlate.
    pub fn unparsed_command_request_id(text: &str) -> Option<RequestId> {
        probe_request_id(text, "command")
    }
}

/// Reads the `id` of a frame of type `frame_type` whose body did not parse, so the receiver
/// can still fail the one request it belongs to.
fn probe_request_id(text: &str, frame_type: &str) -> Option<RequestId> {
    /// Minimal view of a frame that only needs its tag and correlation id.
    #[derive(Deserialize)]
    struct Probe {
        #[serde(rename = "type")]
        frame_type: String,
        id: Option<RequestId>,
    }

    let probe: Probe = serde_json::from_str(text).ok()?;
    if probe.frame_type == frame_type {
        probe.id
    } else {
        None
    }
}

/// Control frames sent by an agent to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToServer {
    /// First frame of every connection: binds the authenticated socket to a stable agent id
    /// and publishes the metadata the router, UI and detail responses use.
    Hello {
        agent_id: AgentId,
        agent_name: String,
        /// Platform, account and binary; flattened so the JSON keeps its flat field names, and
        /// boxed because it dwarfs every other frame.
        #[serde(flatten)]
        identity: Box<AgentIdentity>,
        /// Optional features; flattened, and each flag defaults to off.
        #[serde(flatten)]
        capabilities: AgentCapabilities,
    },

    /// The one final result of a request: `ok` with the request's response, or `error`. For
    /// streaming commands it follows the stream's data on the same lane, so the receiver has
    /// seen all data when it arrives.
    Result {
        id: RequestId,
        #[serde(flatten)]
        outcome: CommandOutcome,
    },

    /// Prefix verification of a resumable same-agent copy, kept apart from copied bytes so
    /// hashing never counts towards transfer speed.
    TransferVerification {
        id: RequestId,
        /// Verified prefix length, or the resume offset once `verifying` is false.
        bytes: u64,
        verifying: bool,
    },

    /// Copy byte progress or a later-discovered directory-download tar total.
    ///
    /// Direct uploads and file downloads derive transferred counts from streamed frames.
    /// Directory archives also send this once so the router can set `total_bytes` without
    /// overwriting those counted bytes.
    TransferProgress {
        id: RequestId,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    },

    /// Requests router authorization before staged upload content can change the destination.
    PublishRequest { id: RequestId },

    /// Returns flow-control credit for one server-to-agent stream (upload, edit, copy
    /// destination or terminal input) as the agent consumes frames, so a slow consumer stalls
    /// only its own stream. Upload streams start with zero credit, so the first grant is also
    /// the agent's signal that its worker is ready for data.
    Credit { stream: RequestId, frames: u32 },

    /// Lifecycle of terminal stream `stream` (ready, exit, setup error).
    ///
    /// Sent in the terminal's own frame order, so an exit always follows the output that
    /// preceded it.
    TerminalEvent {
        stream: RequestId,
        event: terminal::TerminalServerMessage,
    },
}

impl AgentToServer {
    /// Recovers the request id of a `result` frame whose body did not parse, so the server
    /// can fail that request instead of leaving its caller waiting.
    pub fn unparsed_result_request_id(text: &str) -> Option<RequestId> {
        probe_request_id(text, "result")
    }

    /// Wire tag of the frame, for logs that must not echo payloads (results can carry file
    /// contents).
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Hello { .. } => "hello",
            Self::Result { .. } => "result",
            Self::TransferVerification { .. } => "transfer_verification",
            Self::TransferProgress { .. } => "transfer_progress",
            Self::PublishRequest { .. } => "publish_request",
            Self::Credit { .. } => "credit",
            Self::TerminalEvent { .. } => "terminal_event",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies server frames keep the exact JSON shape fake agents and agents decode.
    #[test]
    fn server_frames_keep_their_wire_tags() {
        let frames = [
            (
                ServerToAgent::Rejected {
                    reason: RejectReason::DuplicateName,
                    message: "m".to_string(),
                },
                r#"{"type":"rejected","reason":"duplicate_name","message":"m"}"#,
            ),
            (
                ServerToAgent::Evicted {
                    message: "m".to_string(),
                },
                r#"{"type":"evicted","message":"m"}"#,
            ),
            (
                ServerToAgent::Credit {
                    stream: RequestId::new(4),
                    frames: 2,
                },
                r#"{"type":"credit","stream":4,"frames":2}"#,
            ),
            (
                ServerToAgent::Command {
                    id: RequestId::new(1),
                    credit: 0,
                    command: request::ListTrash {}.into(),
                },
                r#"{"type":"command","id":1,"credit":0,"command":{"type":"ListTrash"}}"#,
            ),
            (
                ServerToAgent::PublishDecision {
                    id: RequestId::new(2),
                    allowed: true,
                },
                r#"{"type":"publish_decision","id":2,"allowed":true}"#,
            ),
            (
                ServerToAgent::Cancel {
                    id: RequestId::new(3),
                    reason: crate::wire::partials::CancelReason::Canceled,
                },
                r#"{"type":"cancel","id":3}"#,
            ),
        ];
        for (frame, expected) in frames {
            // Fake agents in the integration tests parse these exact shapes from the raw socket.
            assert_eq!(serde_json::to_string(&frame).unwrap(), expected);
        }
    }

    /// Verifies agent frames carry no agent id, because the connection identifies the agent.
    #[test]
    fn agent_frames_keep_their_wire_tags() {
        let frames = [
            (
                AgentToServer::Result {
                    id: RequestId::new(2),
                    outcome: CommandOutcome::Ok(serde_json::Value::Null),
                },
                r#"{"type":"result","id":2,"ok":null}"#,
            ),
            (
                AgentToServer::Result {
                    id: RequestId::new(9),
                    outcome: CommandOutcome::error(command::CommandErrorKind::NotFound, "missing"),
                },
                r#"{"type":"result","id":9,"error":{"kind":"not_found","message":"missing"}}"#,
            ),
            (
                AgentToServer::TransferProgress {
                    id: RequestId::new(3),
                    transferred_bytes: 4,
                    total_bytes: None,
                },
                r#"{"type":"transfer_progress","id":3,"transferred_bytes":4,"total_bytes":null}"#,
            ),
            (
                AgentToServer::PublishRequest {
                    id: RequestId::new(5),
                },
                r#"{"type":"publish_request","id":5}"#,
            ),
            (
                AgentToServer::Credit {
                    stream: RequestId::new(6),
                    frames: 2,
                },
                r#"{"type":"credit","stream":6,"frames":2}"#,
            ),
        ];
        for (frame, expected) in frames {
            // The server and fake agents decode these exact tags and field names.
            assert_eq!(serde_json::to_string(&frame).unwrap(), expected);
        }
    }

    /// Verifies flattening keeps the flat hello JSON that agents and fixtures send.
    #[test]
    fn hello_round_trips_its_flat_json() {
        let json = r#"{"type":"hello","agent_id":"a","agent_name":"n","os":"linux","arch":"x86_64","hostname":"h","username":"u","cwd":"/home/u","binary":{"version":"0.0.0","git_rev":"r","git_dirty":false,"version_dirty":false,"build_mode":"debug","build_date":"d"},"uid":1000,"is_root":false,"supports_native_open":false,"supports_trash":true,"supports_move_to_trash":false,"supports_upload_preconditions":true}"#;
        let hello: AgentToServer = serde_json::from_str(json).unwrap();
        let AgentToServer::Hello {
            identity,
            capabilities,
            ..
        } = &hello
        else {
            panic!("expected a hello");
        };
        // Flat wire fields land in the nested values, including the renamed directory.
        assert_eq!(identity.default_directory, "/home/u");
        assert_eq!(identity.uid, 1000);
        assert!(capabilities.supports_trash);
        assert!(capabilities.supports_upload_preconditions);
        let older = json.replace(r#","supports_upload_preconditions":true"#, "");
        let AgentToServer::Hello { capabilities, .. } = serde_json::from_str(&older).unwrap()
        else {
            panic!("expected a hello");
        };
        // An older agent omits the capability, so vault writes to it are refused.
        assert!(!capabilities.supports_upload_preconditions);
        // Serializing yields the same flat object the fake agents build by hand.
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            serde_json::from_str::<serde_json::Value>(json).unwrap()
        );
    }

    /// Verifies unknown command variants still expose their request id.
    #[test]
    fn unknown_command_frames_still_yield_their_request_id() {
        let unknown = r#"{"type":"command","id":9,"credit":0,"command":{"type":"FutureCommand"}}"#;

        // The variant is unknown to this build, so normal parsing must fail.
        assert!(serde_json::from_str::<ServerToAgent>(unknown).is_err());
        // The correlation id survives so the agent can answer instead of leaving the caller waiting.
        assert_eq!(
            ServerToAgent::unparsed_command_request_id(unknown),
            Some(RequestId::new(9))
        );
        // Non-command frames have no response channel and must not be answered.
        assert_eq!(
            ServerToAgent::unparsed_command_request_id(r#"{"type":"cancel","id":"bad"}"#),
            None
        );
    }
}
