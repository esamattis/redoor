//! Browser login and logout request/response bodies.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Carries credentials to the login endpoint without putting secrets in the URL.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    /// How long the session lasts without activity, picked on the login page. Defaults to
    /// one hour, so a client that does not ask gets the shortest session.
    #[serde(default)]
    pub session_length: SessionLength,
}

/// How long a browser session lasts without activity, chosen by the user at sign-in.
///
/// A fixed list instead of free seconds, so the login page offers sensible choices and the
/// server never has to validate an arbitrary lifetime. Sessions slide: the length counts
/// from the last activity, not from the sign-in. OIDC sessions are additionally capped by
/// `server.oidc.session_lifetime_days`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum SessionLength {
    /// One hour, the default: a browser left open on a shared or lost device signs out soon.
    #[default]
    Hour,
    /// 24 hours.
    Day,
    /// One week.
    Week,
    /// 30 days.
    Month,
    /// 365 days.
    Year,
}

impl SessionLength {
    /// The idle lifetime this choice stands for. `const`, so the server can derive its fixed
    /// cookie `Max-Age` from the longest choice.
    pub const fn duration(self) -> Duration {
        const HOUR: u64 = 60 * 60;
        const DAY: u64 = 24 * HOUR;
        Duration::from_secs(match self {
            Self::Hour => HOUR,
            Self::Day => DAY,
            Self::Week => 7 * DAY,
            Self::Month => 30 * DAY,
            Self::Year => 365 * DAY,
        })
    }

    /// The wire name, as serde writes it; for URLs the server builds itself, such as the
    /// login page link that keeps the user's choice after a failed OIDC sign-in.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
        }
    }
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
    /// When the browser session ends without further activity; absent for access tokens,
    /// which do not idle out. The UI schedules its sign-out warning from it on page load.
    pub session: Option<SessionExpiry>,
    /// Seconds this browser session can still create or rotate access tokens, counted on the
    /// server's clock from the last time its credentials were checked; 0 once it has to sign
    /// in again first. Absent for access tokens, which can never manage tokens. Lets the UI
    /// send the user through the sign-in before the server refuses the request.
    #[ts(type = "number | null")]
    pub fresh_login_seconds_left: Option<u64>,
}

/// When a browser session ends unless the user is active again.
///
/// Sessions only slide forward on explicit activity (`POST /api/v1/session/activity`) and
/// finished transfers, never on ordinary requests, so the UI needs the expiry to warn before
/// signing the user out. Returned by the activity endpoint and inside `GET /api/v1/auth/me`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionExpiry {
    /// RFC 3339 expiry on the server's clock, for display and logs.
    pub expires_at: String,
    /// Seconds from this response until the expiry. The UI schedules from this rather than
    /// `expires_at`, so a browser whose clock is off does not sign out too early or too late.
    #[ts(type = "number")]
    pub expires_in_seconds: u64,
}

/// Answer of `POST /api/v1/session/rotate`, which an open tab calls every few minutes so the
/// session cookie's secret keeps changing even while nobody uses the page.
///
/// The new cookie itself travels in `Set-Cookie`; the flag only says whether there was one,
/// because the server rotates at most once a minute and a call inside that minute changes
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionRotationResponse {
    /// Whether this response carries a new session cookie.
    pub rotated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each choice on the login page maps to the lifetime its label promises.
    #[test]
    fn session_lengths_map_to_their_durations() {
        let hours = |length: SessionLength| length.duration().as_secs() / 3600;
        // The labels "1 hour", "24 hours", "1 week", "1 month" and "1 year".
        assert_eq!(hours(SessionLength::Hour), 1);
        assert_eq!(hours(SessionLength::Day), 24);
        assert_eq!(hours(SessionLength::Week), 7 * 24);
        assert_eq!(hours(SessionLength::Month), 30 * 24);
        assert_eq!(hours(SessionLength::Year), 365 * 24);
    }

    /// A login without a length gets the shortest session, and the wire names are the ones
    /// the login page's search parameter uses.
    #[test]
    fn session_length_defaults_to_an_hour() {
        let request: LoginRequest =
            serde_json::from_str(r#"{"username":"a","password":"b"}"#).expect("JSON");
        // Clients that predate the choice, and scripts, get the safe default.
        assert_eq!(request.session_length, SessionLength::Hour);
        for length in [
            SessionLength::Hour,
            SessionLength::Day,
            SessionLength::Week,
            SessionLength::Month,
            SessionLength::Year,
        ] {
            // URLs built from `as_str` carry the same value serde reads back.
            assert_eq!(
                serde_json::to_string(&length).expect("JSON"),
                format!("\"{}\"", length.as_str())
            );
        }
    }
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
