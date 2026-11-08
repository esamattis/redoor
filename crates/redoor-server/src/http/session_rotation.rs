//! `POST /api/v1/session/rotate`: replaces the browser session cookie's secret without
//! touching the session's expiry.
//!
//! A module of its own because rotation answers a different question than activity: an open
//! tab calls it on a timer even while nobody uses the page, so the secret keeps changing and
//! a copied cookie cannot be used quietly next to it. It must therefore never keep an idle
//! session alive, which is exactly what the activity endpoint is for.

use axum::{
    Extension, Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use redoor_core::log_error;
use redoor_protocol::api::auth::SessionRotationResponse;

use super::{auth::ActiveSession, error::ApiError, state::ServerState};

/// Rotates the caller's session secret when it is due and sends the new cookie.
///
/// Behind the normal access layer, so an expired session gets 401. The cookie carries the
/// same fixed `Max-Age` as every session cookie, which does not lengthen the session: the
/// server alone enforces the idle expiry.
pub(crate) async fn rotate_session_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
) -> Result<Response, ApiError> {
    let rotated = match state.auth.rotate_session(&session).await {
        Ok(Some(rotated)) => rotated,
        // Expired, logged out or revoked between the access check and the rotation.
        Ok(None) => {
            return Err(ApiError::status(
                StatusCode::UNAUTHORIZED,
                "Authentication required",
            ));
        }
        Err(error) => {
            log_error!(error, "Failed to rotate the session");
            return Err(ApiError::internal("Failed to rotate the session"));
        }
    };
    let mut response = Json(SessionRotationResponse {
        rotated: rotated.cookie.is_some(),
    })
    .into_response();
    if let Some(cookie) = rotated.cookie {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    Ok(response)
}
