//! Browser session management: listing the signed-in browsers and signing them out.
//!
//! A module of its own because it manages every browser session of the server, not just the
//! caller's own login, which `auth` covers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::auth::{AuthMethod, SessionLength};

/// `GET /api/v1/sessions`: every browser session that is still signed in, so the user can
/// spot a forgotten or unknown browser and sign it out.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BrowserSessionListResponse {
    /// Newest sign-in first.
    pub sessions: Vec<BrowserSession>,
}

/// One signed-in browser, described by what the server saw when it signed in.
///
/// Never carries the session's cookie value: the list is shown in every signed-in browser,
/// and the cookie is a bearer secret.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BrowserSession {
    /// Public identifier for signing the session out, derived from the cookie value with a
    /// one-way hash so it cannot be turned back into a cookie.
    pub id: String,
    /// Whether this is the session of the browser making the request, so the UI can mark it
    /// and sign it out through the normal logout instead.
    pub current: bool,
    /// The login name, or the OIDC user's readable name.
    pub name: String,
    /// How the session signed in; never `token`.
    pub method: AuthMethod,
    /// The idle length chosen at sign-in.
    pub length: SessionLength,
    /// RFC 3339 time of the sign-in.
    pub created_at: String,
    /// RFC 3339 time the session ends unless the user is active again.
    pub expires_at: String,
    /// The browser's `User-Agent` at sign-in; absent when it sent none.
    pub user_agent: Option<String>,
    /// IP address of the TCP peer at sign-in. Behind a reverse proxy this is the proxy.
    pub ip: String,
    /// The client a reverse proxy named in `X-Forwarded-For` (or `X-Real-IP`) at sign-in.
    /// Any client can send the header, so it is shown as a claim only.
    pub forwarded_for: Option<String>,
}

/// `DELETE /api/v1/sessions` and `DELETE /api/v1/sessions/{id}`: how many browser sessions
/// were signed out, so the UI can say what happened.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SignOutSessionsResponse {
    pub signed_out: u32,
}
