//! `GET /api/v1/auth/me`: who is signed in and how.
//!
//! A module of its own because it describes the caller rather than any resource, and every
//! kind of principal may call it.

use axum::{Extension, Json};
use redoor_protocol::api::auth::{AuthMethod, CurrentUserResponse};

use super::access::Principal;
use super::auth::SessionMethod;

/// Describes the caller: the login name and method for a browser session, and the token's
/// name and id for an access token. The UI shows it in the application menu and decides
/// from the method whether the password change form applies.
pub(crate) async fn auth_me_handler(
    Extension(principal): Extension<Principal>,
) -> Json<CurrentUserResponse> {
    Json(match principal {
        Principal::Session(user) => CurrentUserResponse {
            name: user.name,
            method: match user.method {
                SessionMethod::Password => AuthMethod::Password,
                SessionMethod::Pam => AuthMethod::Pam,
                SessionMethod::Oidc => AuthMethod::Oidc,
            },
            token_id: None,
        },
        Principal::Token(grant) => CurrentUserResponse {
            name: grant.name,
            method: AuthMethod::Token,
            token_id: Some(grant.id.to_string()),
        },
    })
}
