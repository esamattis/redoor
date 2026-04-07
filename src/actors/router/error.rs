use axum::http::StatusCode;
use thiserror::Error;

/// Typed router boundary errors keep actor-internal failures structured until the
/// HTTP layer chooses the final status code and response message.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum RouterError {
    /// The requested agent or transfer target no longer exists in the router.
    #[error("Agent not found: {agent_id}")]
    AgentNotFound { agent_id: String },
    /// The requested upload or copy stream no longer exists in the router.
    #[error("Upload stream not found: agent_id={agent_id}, request_id={request_id}")]
    StreamNotFound {
        agent_id: String,
        request_id: String,
    },
    /// The requested copy bookkeeping no longer exists in the router.
    #[error("Copy stream not found: request_id={request_id}")]
    CopyStreamNotFound { request_id: String },
    /// The REST client already canceled the in-flight upload stream.
    #[error("Upload stream canceled by client")]
    ClientCanceledUpload,
    /// The router could not keep forwarding upload chunks to the agent.
    #[error(
        "Failed to forward upload chunk to agent: agent_id={agent_id}, request_id={request_id}"
    )]
    UploadForwardFailed {
        agent_id: String,
        request_id: String,
    },
    /// The router stopped before a background forwarding task could report back.
    #[error("Router stopped before {operation} completed")]
    RouterStopped { operation: &'static str },
    /// The router received a response shape that does not match the protocol.
    #[error("Unexpected response type while {operation}")]
    UnexpectedResponseType { operation: &'static str },
}

impl RouterError {
    /// Maps one router boundary failure to the HTTP status used by REST handlers.
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::AgentNotFound { .. }
            | Self::StreamNotFound { .. }
            | Self::CopyStreamNotFound { .. } => StatusCode::NOT_FOUND,
            Self::ClientCanceledUpload => StatusCode::BAD_REQUEST,
            Self::UploadForwardFailed { .. }
            | Self::RouterStopped { .. }
            | Self::UnexpectedResponseType { .. } => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}
