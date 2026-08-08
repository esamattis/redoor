use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    actors,
    commands::{AgentDetailsResponse, Command, CommandResult, ErrorResponse},
    types::AgentId,
};

use serde::Deserialize;

use super::{responses::command_error_status, state::ServerState};

/// Fetches detailed runtime and immutable registration metadata for one agent.
pub(crate) async fn get_agent_details(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<AgentDetailsResponse, Response> {
    match state
        .router_ref
        .request(30000, |reply| {
            actors::router::RouterMsg::ExecuteCommandRest(actors::router::ExecuteCommandRequest {
                agent_id: agent_id.clone(),
                command: Command::GetAgentDetails,
                reply,
            })
        })
        .await
    {
        Ok(CommandResult::GetAgentDetails(details)) => Ok(details),
        Ok(CommandResult::Error { kind, message }) => {
            let status = command_error_status(&kind);
            Err((status, Json(ErrorResponse { error: message })).into_response())
        }
        Ok(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Unexpected result type while fetching agent details".to_string(),
            }),
        )
            .into_response()),
        Err(error) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get agent details: {:?}", error),
            }),
        )
            .into_response()),
    }
}

/// Extracts an agent and its optional file path from exact-root and wildcard routes.
#[derive(Deserialize)]
pub(crate) struct AgentFilePath {
    pub(crate) agent: String,
    pub(crate) path: Option<String>,
}

/// Restores the implicit filesystem root omitted from REST wildcard URL segments.
pub(crate) fn absolute_path_from_url(path: String) -> String {
    format!("/{path}")
}

/// Rejects cwd-dependent filesystem addressing without canonicalizing valid destinations.
pub(crate) fn require_absolute_path(path: String) -> Result<String, Response> {
    if std::path::Path::new(&path).is_absolute() {
        Ok(path)
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Filesystem path must be absolute".to_string(),
            }),
        )
            .into_response())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies URL splats become absolute without requiring a doubled route separator.
    #[test]
    fn restores_implicit_url_root() {
        // The empty splat addresses the filesystem root.
        assert_eq!(absolute_path_from_url(String::new()), "/");
        // Nested URL segments retain their filesystem hierarchy.
        assert_eq!(
            absolute_path_from_url("home/user".to_string()),
            "/home/user"
        );
    }

    /// Verifies lexical validation accepts absolute destinations without requiring existence.
    #[test]
    fn accepts_absolute_paths() {
        for path in ["/", "/tmp/existing-style", "/not-created-yet/file"] {
            // Nonexistent destinations must remain usable by upload, mkdir, and copy APIs.
            assert_eq!(require_absolute_path(path.to_string()).unwrap(), path);
        }
    }

    /// Verifies malformed paths fail at the transport boundary before agent lookup.
    #[test]
    fn rejects_relative_paths() {
        for path in ["relative", "./relative", "../relative", ""] {
            let response = require_absolute_path(path.to_string()).unwrap_err();
            // A stable 400 response makes relative addressing invalid for every endpoint.
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }
}
