//! `PUT /api/v1/auth/password`: changes the TOML-configured login password from the UI.
//!
//! A module of its own because it is the only route that rewrites the server credentials,
//! and its rules (current password, rate limiting, re-issued cookie) differ from login.

use std::time::Instant;

use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use redoor_core::log_error;
use redoor_protocol::api::auth::{ChangePasswordRequest, ChangePasswordResponse};

use super::auth::PasswordChangeError;
use super::error::ApiError;
use super::state::ServerState;

/// Verifies the current password, writes the new one as an Argon2id hash into the config
/// file and answers with a fresh session cookie for this browser.
pub(crate) async fn change_password_handler(
    State(state): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<Response, ApiError> {
    let client_ip = addr.ip();
    // Shares the login throttle, so a stolen session cannot guess the password faster
    // through this form than through the login page.
    if state
        .auth
        .login_limiter
        .is_limited(client_ip, Instant::now())
    {
        return Err(ApiError::status(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many failed password attempts. Try again later.",
        ));
    }
    // Held like the other config edits, so this rewrite cannot interleave with a device edit.
    let _config_edit = state.config_edit_lock.lock().await;
    let session = state
        .auth
        .change_password(
            &state.config_path,
            &request.current_password,
            &request.new_password,
        )
        .await
        .map_err(|error| match error {
            PasswordChangeError::WrongCurrentPassword => {
                state
                    .auth
                    .login_limiter
                    .record_failure(client_ip, Instant::now());
                // 403, not 401: the UI treats 401 as an expired session and leaves the page.
                ApiError::forbidden(error.to_string())
            }
            PasswordChangeError::NotConfigured => ApiError::conflict(error.to_string()),
            PasswordChangeError::CredentialsChanged(_) => ApiError::conflict(error.to_string()),
            PasswordChangeError::InvalidNewPassword(_) => ApiError::bad_request(error.to_string()),
            PasswordChangeError::Internal(error) => {
                log_error!(error, "Failed to change the login password");
                ApiError::internal(format!("{error}"))
            }
        })?;
    let mut response = Json(ChangePasswordResponse {
        username: session.username,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session.cookie);
    Ok(response)
}
