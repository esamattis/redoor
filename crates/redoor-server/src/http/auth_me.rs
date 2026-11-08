//! `GET /api/v1/auth/me`: who is signed in and how.
//!
//! A module of its own because it describes the caller rather than any resource, and every
//! kind of principal may call it.

use axum::{Extension, Json};
use redoor_protocol::api::auth::{AuthMethod, CurrentUserResponse};

use super::access::Principal;
use super::auth::{ActiveSession, SessionMethod};
use super::session_activity::session_expiry;

/// Describes the caller: the login name and method for a browser session, and the token's
/// name and id for an access token. The UI shows it in the application menu, decides from
/// the method whether the password change form applies, schedules its sign-out warning
/// from the session's expiry, and tells from the fresh sign-in window whether creating an
/// access token needs a sign-in first. Reading it does not renew the session.
pub(crate) async fn auth_me_handler(
    Extension(principal): Extension<Principal>,
    session: Option<Extension<ActiveSession>>,
) -> Json<CurrentUserResponse> {
    let now = jiff::Timestamp::now().as_second();
    let fresh_login_seconds_left = session
        .as_ref()
        .map(|Extension(session)| session.fresh_login_seconds_left(now));
    let session = session.map(|Extension(session)| session_expiry(session.expires_at));
    Json(match principal {
        Principal::Session(user) => CurrentUserResponse {
            name: user.name,
            method: match user.method {
                SessionMethod::Password => AuthMethod::Password,
                SessionMethod::Oidc => AuthMethod::Oidc,
            },
            token_id: None,
            session,
            fresh_login_seconds_left,
        },
        Principal::Token(grant) => CurrentUserResponse {
            name: grant.name,
            method: AuthMethod::Token,
            token_id: Some(grant.id.to_string()),
            session: None,
            fresh_login_seconds_left: None,
        },
    })
}
