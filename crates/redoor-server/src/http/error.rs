//! The one error type REST handlers return, with the HTTP status mapping in one place.

use crate::actors::router::{RouterCallError, RouterError};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor_protocol::{api::ErrorResponse, wire::command::CommandErrorKind};
use std::time::Duration;

/// Every failure a REST handler can report.
///
/// Handlers return `Result<_, ApiError>` instead of hand-building `(StatusCode, Json<ErrorResponse>)`
/// tuples, so the status of each failure class and the user-visible message are decided once.
/// Messages come from `Display` only: internal `Debug` representations never reach clients.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ApiError {
    /// The agent ran the command and reported a typed failure; its message is user-facing.
    #[error("{message}")]
    Command {
        kind: CommandErrorKind,
        message: String,
    },
    /// The router refused or failed the work (unknown agent, full queue, missing transfer link).
    #[error(transparent)]
    Router(#[from] RouterError),
    /// The router itself did not answer, so the server cannot route any work right now.
    #[error("Server router is unavailable: {0}")]
    RouterUnavailable(#[from] RouterCallError),
    /// The agent did not answer before the call's deadline; the command was abandoned.
    #[error("Agent did not respond within {} seconds", .0.as_secs_f64())]
    Timeout(Duration),
    /// The agent answered with a result that does not belong to the command it was sent,
    /// which means the two ends disagree about the protocol.
    #[error("Unexpected agent response while {0}")]
    Unexpected(&'static str),
    /// A failure with an explicit status decided by the handler (validation, conflicts).
    #[error("{message}")]
    Status { status: StatusCode, message: String },
}

impl ApiError {
    /// Builds a client error for a request the REST edge rejects before contacting an agent.
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::status(StatusCode::BAD_REQUEST, message)
    }

    /// Builds a missing-resource error for lookups that happen outside agent commands.
    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::status(StatusCode::NOT_FOUND, message)
    }

    /// Builds an authorization failure; the message names the missing permission or scope.
    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self::status(StatusCode::FORBIDDEN, message)
    }

    /// Builds a conflict error for requests that are valid but clash with current state.
    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::status(StatusCode::CONFLICT, message)
    }

    /// Builds a server-side failure that is neither an agent nor a router error.
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::status(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    /// Builds an error with a handler-chosen status.
    pub(crate) fn status(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Status {
            status,
            message: message.into(),
        }
    }

    /// The HTTP status of this failure; the only place REST statuses for errors are chosen.
    pub(crate) fn status_code(&self) -> StatusCode {
        match self {
            Self::Command { kind, .. } => command_status(kind),
            Self::Router(error) => error.status_code(),
            Self::RouterUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Timeout(_) => StatusCode::GATEWAY_TIMEOUT,
            Self::Unexpected(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Status { status, .. } => *status,
        }
    }
}

/// Maps a typed agent failure to the status clients already rely on (404 for missing paths,
/// 403 for permissions, 409 for existing destinations).
fn command_status(kind: &CommandErrorKind) -> StatusCode {
    match kind {
        CommandErrorKind::NotFound | CommandErrorKind::NotADirectory => StatusCode::NOT_FOUND,
        CommandErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        CommandErrorKind::IsDirectory | CommandErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
        // Only the client side cancels, so the request is what ended the work.
        CommandErrorKind::SourceChanged => StatusCode::CONFLICT,
        CommandErrorKind::Canceled | CommandErrorKind::Paused => StatusCode::BAD_REQUEST,
        CommandErrorKind::AlreadyExists | CommandErrorKind::Conflict => StatusCode::CONFLICT,
        CommandErrorKind::ServiceUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        CommandErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl From<crate::watchdog::WatchdogError> for ApiError {
    /// A configuration change racing a start is a conflict; every other lifecycle failure
    /// means the supervisor is gone, which is a server-side fault.
    fn from(error: crate::watchdog::WatchdogError) -> Self {
        let status = match error {
            crate::watchdog::WatchdogError::StillRunning => StatusCode::CONFLICT,
            crate::watchdog::WatchdogError::Busy { .. } => StatusCode::SERVICE_UNAVAILABLE,
            crate::watchdog::WatchdogError::SupervisorStopped { .. }
            | crate::watchdog::WatchdogError::AcknowledgementDropped { .. }
            | crate::watchdog::WatchdogError::AlreadyRegistered { .. } => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        Self::status(status, error.to_string())
    }
}

impl IntoResponse for ApiError {
    /// Renders the standard `{ "error": ... }` body every client parses.
    fn into_response(self) -> Response {
        (
            self.status_code(),
            Json(ErrorResponse {
                code: None,
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Statuses that tests and the UI depend on must not drift when handlers change.
    #[test]
    fn maps_each_failure_class_to_its_status() {
        let not_found = ApiError::Command {
            kind: CommandErrorKind::NotFound,
            message: "No such file".to_string(),
        };
        // Missing paths stay 404 with the agent's own message.
        assert_eq!(not_found.status_code(), StatusCode::NOT_FOUND);
        assert_eq!(not_found.to_string(), "No such file");
        let router = ApiError::from(RouterError::AgentNotFound {
            agent_id: "a".to_string(),
        });
        // Router errors keep their established mapping and text.
        assert_eq!(router.status_code(), StatusCode::NOT_FOUND);
        assert_eq!(router.to_string(), "Agent not found: a");
        // A silent agent is a gateway timeout with a readable message, not a Debug dump.
        let timeout = ApiError::Timeout(Duration::from_secs(30));
        assert_eq!(timeout.status_code(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            timeout.to_string(),
            "Agent did not respond within 30 seconds"
        );
        // Router shutdown is reported as unavailability with readable text.
        let stopped = ApiError::from(RouterCallError::RouterStopped);
        assert_eq!(stopped.status_code(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            stopped.to_string(),
            "Server router is unavailable: router has stopped"
        );
    }

    /// Every agent error kind keeps its status after it crossed the typed `result` frame.
    #[test]
    fn decoded_agent_errors_keep_their_statuses() {
        use redoor_protocol::wire::request::{AgentRequest, CommandOutcome, DecodeError, Metadata};
        let expected = [
            (CommandErrorKind::NotFound, StatusCode::NOT_FOUND),
            (CommandErrorKind::NotADirectory, StatusCode::NOT_FOUND),
            (CommandErrorKind::PermissionDenied, StatusCode::FORBIDDEN),
            (CommandErrorKind::IsDirectory, StatusCode::BAD_REQUEST),
            (CommandErrorKind::InvalidInput, StatusCode::BAD_REQUEST),
            (CommandErrorKind::Canceled, StatusCode::BAD_REQUEST),
            (CommandErrorKind::AlreadyExists, StatusCode::CONFLICT),
            (CommandErrorKind::Conflict, StatusCode::CONFLICT),
            (
                CommandErrorKind::ServiceUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                CommandErrorKind::Internal,
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        ];
        for (kind, status) in expected {
            let wire = serde_json::to_string(&CommandOutcome::error(kind.clone(), "m")).unwrap();
            let Err(DecodeError::Failed(error)) =
                Metadata::decode(serde_json::from_str(&wire).unwrap())
            else {
                panic!("an error outcome decodes as a failure");
            };
            let api = ApiError::Command {
                kind: error.kind,
                message: error.message,
            };
            // Clients rely on these statuses, so the typed results must not change them.
            assert_eq!(api.status_code(), status, "{kind:?}");
        }
    }
}
