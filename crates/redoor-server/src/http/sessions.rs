//! `GET /api/v1/sessions`, `DELETE /api/v1/sessions` and `DELETE /api/v1/sessions/{id}`:
//! the signed-in browsers, and signing them out from another browser.
//!
//! A module of its own because these routes act on every browser session of the server,
//! while the login and logout routes in `auth` only ever act on the caller's own. Everyone
//! who can sign in shares the one account, so any session may see and end any other.

use axum::{
    Extension, Json,
    extract::{Path, State},
};
use redoor_core::{log, log_error};
use redoor_protocol::api::auth::AuthMethod;
use redoor_protocol::api::sessions::{
    BrowserSession, BrowserSessionListResponse, SignOutSessionsResponse,
};
use redoor_protocol::wire::log::Level;

use super::auth::{ActiveSession, ListedSession, SessionMethod};
use super::error::ApiError;
use super::state::ServerState;

/// Lists every signed-in browser session, marking the caller's own.
pub(crate) async fn list_sessions_handler(
    State(state): State<ServerState>,
    Extension(current): Extension<ActiveSession>,
) -> Result<Json<BrowserSessionListResponse>, ApiError> {
    let sessions = state.auth.list_sessions().await.map_err(|error| {
        log_error!(error, "Failed to list sessions");
        ApiError::internal("Failed to list sessions")
    })?;
    Ok(Json(BrowserSessionListResponse {
        sessions: sessions
            .into_iter()
            .map(|session| browser_session(session, &current))
            .collect(),
    }))
}

/// Signs out one session by its public id. The caller's own session may be signed out too;
/// its next request then gets 401 and leads to the login page.
pub(crate) async fn sign_out_session_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Json<SignOutSessionsResponse>, ApiError> {
    let session = state.auth.sign_out_session(&id).await.map_err(|error| {
        log_error!(error, "Failed to sign out a session");
        ApiError::internal("Failed to sign out the session")
    })?;
    let Some(session) = session else {
        return Err(ApiError::not_found("No signed-in session has this id"));
    };
    forget_signed_out(&state, &session);
    Ok(Json(SignOutSessionsResponse { signed_out: 1 }))
}

/// Signs out every session except the caller's, so a user who suspects a stolen cookie
/// can end all other browsers in one step and keep working in this one.
pub(crate) async fn sign_out_other_sessions_handler(
    State(state): State<ServerState>,
    Extension(current): Extension<ActiveSession>,
) -> Result<Json<SignOutSessionsResponse>, ApiError> {
    let sessions = state
        .auth
        .sign_out_other_sessions(&current.id)
        .await
        .map_err(|error| {
            log_error!(error, "Failed to sign out other sessions");
            ApiError::internal("Failed to sign out the other sessions")
        })?;
    for session in &sessions {
        forget_signed_out(&state, session);
    }
    Ok(Json(SignOutSessionsResponse {
        signed_out: sessions.len() as u32,
    }))
}

/// Drops what the server keeps for a session besides its file and logs the sign-out.
///
/// The vault entries go like on logout, so a signed-out browser cannot open the vault even
/// if it still holds a kept device secret.
fn forget_signed_out(state: &ServerState, session: &ListedSession) {
    state.vault_devices.delete_session(&session.id);
    let forwarded = session
        .client
        .forwarded_for
        .as_deref()
        .map(|forwarded| format!(" (forwarded for {forwarded})"))
        .unwrap_or_default();
    log!(
        Level::Info,
        "Signed out session: user={}, address={}{forwarded}",
        session.user.log_label(),
        session.client.ip
    );
}

/// Describes a listed session for the UI without its cookie value.
fn browser_session(session: ListedSession, current: &ActiveSession) -> BrowserSession {
    BrowserSession {
        current: session.id == current.id,
        id: session.public_id,
        name: session.user.name,
        method: match session.user.method {
            SessionMethod::Password => AuthMethod::Password,
            SessionMethod::Oidc => AuthMethod::Oidc,
        },
        length: session.length,
        created_at: rfc3339(session.created_at),
        expires_at: rfc3339(session.expires_at),
        user_agent: session.client.user_agent,
        ip: session.client.ip.to_string(),
        forwarded_for: session.client.forwarded_for,
    }
}

/// Formats Unix seconds for the UI; empty only for a time outside jiff's range, which a
/// session file written by this server never holds.
fn rfc3339(seconds: i64) -> String {
    jiff::Timestamp::from_second(seconds)
        .map(|timestamp| timestamp.to_string())
        .unwrap_or_default()
}
