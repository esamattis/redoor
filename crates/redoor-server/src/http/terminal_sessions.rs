//! REST resource of server-owned terminal sessions: list, create and close. Attaching a
//! browser is the websocket in `terminals`.

use super::{
    access::ResolvedDevice, agent_helpers::require_absolute_path, error::ApiError,
    state::ServerState,
};
use crate::terminals::registry::CreateSessionError;
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use redoor_protocol::{
    api::terminals::{
        CloseTerminalSessionResponse, CreateTerminalSessionRequest, CreateTerminalSessionResponse,
        TerminalSessionList,
    },
    ids::TerminalSessionId,
};

/// Longest accepted tab title, so one request cannot store an unbounded string that every
/// window then lists.
const MAX_TERMINAL_TITLE_CHARS: usize = 200;

/// Lists every session, so a reloaded window can restore its tabs.
pub(crate) async fn list_terminal_sessions_handler(
    State(state): State<ServerState>,
) -> Json<TerminalSessionList> {
    Json(TerminalSessionList {
        sessions: state.terminals.list(),
    })
}

/// Starts a shell on a device; it lives until its tab is closed.
pub(crate) async fn create_terminal_session_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    State(state): State<ServerState>,
    Json(mut request): Json<CreateTerminalSessionRequest>,
) -> Result<(StatusCode, Json<CreateTerminalSessionResponse>), ApiError> {
    request.cwd = require_absolute_path(request.cwd)?;
    request
        .size
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    if request.title.chars().count() > MAX_TERMINAL_TITLE_CHARS {
        return Err(ApiError::bad_request("Terminal title is too long"));
    }
    let session = state
        .terminals
        .create(agent_id, request)
        .await
        .map_err(|error| match error {
            CreateSessionError::AgentLimit
            | CreateSessionError::ServerLimit
            | CreateSessionError::NotConnected => ApiError::conflict(error.to_string()),
        })?;
    Ok((
        StatusCode::CREATED,
        Json(CreateTerminalSessionResponse { session }),
    ))
}

/// Kills a session's shell and forgets it, telling an attached browser it was closed.
pub(crate) async fn delete_terminal_session_handler(
    Path(id): Path<String>,
    State(state): State<ServerState>,
) -> Result<Json<CloseTerminalSessionResponse>, ApiError> {
    let id = parse_session_id(&id)?;
    if state.terminals.close(id).await {
        Ok(Json(CloseTerminalSessionResponse { id }))
    } else {
        Err(session_not_found())
    }
}

/// Parses a session id from the path; a malformed id names no session, so it is a 404 like
/// an unknown one.
pub(crate) fn parse_session_id(value: &str) -> Result<TerminalSessionId, ApiError> {
    TerminalSessionId::parse(value).ok_or_else(session_not_found)
}

/// The error for an id that names no session, such as after a server restart.
pub(crate) fn session_not_found() -> ApiError {
    ApiError::not_found("Terminal session no longer exists")
}
