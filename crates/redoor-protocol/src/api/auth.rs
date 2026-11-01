//! Browser login and logout request/response bodies.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Carries credentials to the login endpoint without putting secrets in the URL.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Confirms which configured account now owns the browser session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginResponse {
    pub username: String,
}

/// Confirms that both the browser cookie and its server-side session were removed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogoutResponse {
    pub logged_out: bool,
}

/// Tells the public login page which sign-in methods to offer before any session exists.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginMethodsResponse {
    /// Present when the server is configured for OpenID Connect sign-in.
    pub oidc: Option<OidcLoginMethod>,
}

/// What the login page needs to lead with the identity provider button.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OidcLoginMethod {
    /// Operator-chosen label, shown as "Sign in with {provider_name}".
    pub provider_name: String,
}

/// How the caller of a request authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AuthMethod {
    /// A `[[server.users]]` name and password; the only method whose password the UI can
    /// change.
    Password,
    /// OpenID Connect sign-in.
    Oidc,
    /// An access token.
    Token,
}

/// `GET /api/v1/auth/me`: who is signed in and how, shown in the application menu.
///
/// Everyone who can sign in shares one account with full access, so this only says who is
/// working, not what they may do.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CurrentUserResponse {
    /// The login name, the OIDC user's readable name, or the access token's name.
    pub name: String,
    /// How the caller authenticated.
    pub method: AuthMethod,
    /// The access token's id; present only for tokens.
    pub token_id: Option<String>,
}

/// Asks to replace the TOML-configured login password.
///
/// The current password is required even though the caller already has a session, so a
/// browser left signed in, or a stolen session cookie, cannot take over the account.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

/// Confirms the change. Every other password session was signed out, and the response sets
/// a fresh session cookie so the browser that made the change stays signed in.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangePasswordResponse {
    /// The account whose password changed and that owns the new session.
    pub username: String,
}
