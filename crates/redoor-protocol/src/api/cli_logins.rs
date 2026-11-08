//! The browser approval flow that gives the remote CLI an access token (RFC 8628 style).
//!
//! The CLI starts a request and prints a URL and a user code; the user opens the URL in a
//! signed-in browser, types the code, adjusts the token and approves it after a fresh
//! sign-in; the CLI's long poll then receives the token. A module of its own because the
//! bodies cross three parties (CLI, server, browser) with different rights to each field.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::tokens::{
    AccessTokenResponse, AccessTokenSecretResponse, CreateAccessTokenRequest, DeviceScope,
    Permission,
};

/// How long a token the CLI asks for should live, in the vocabulary the CLI's `--expires`
/// flag and the browser's expiry select share.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TokenLifetime {
    #[serde(rename = "30d")]
    Days30,
    /// The default: long enough for daily use, short enough that a forgotten token expires.
    #[default]
    #[serde(rename = "90d")]
    Days90,
    #[serde(rename = "365d")]
    Days365,
    #[serde(rename = "never")]
    Never,
}

impl TokenLifetime {
    /// The lifetime in days, or `None` for a token that never expires.
    pub fn days(self) -> Option<i64> {
        match self {
            Self::Days30 => Some(30),
            Self::Days90 => Some(90),
            Self::Days365 => Some(365),
            Self::Never => None,
        }
    }
}

/// The token the CLI would like, shown as the defaults of the approval form. The browser has
/// the final say, so nothing here is granted without the user seeing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CliTokenDefaults {
    pub name: String,
    pub permissions: Vec<Permission>,
    /// Device names or ids as the user typed them in `--devices`. Not resolved when the
    /// request starts, because the start route is public and resolving would let anyone
    /// probe device names; the approval page matches them against the device list.
    pub devices: DeviceScope,
    pub lifetime: TokenLifetime,
}

/// `POST /api/v1/cli-logins`: the CLI starts a login.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartCliLoginRequest {
    /// The machine the CLI runs on, shown on the approval page so the user can tell their own
    /// request from one somebody else sent them.
    pub host_name: String,
    pub token: CliTokenDefaults,
}

/// The CLI's handle on its login request.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartCliLoginResponse {
    /// Names the request in the approval URL and the CLI's polls.
    pub id: String,
    /// Proves to `wait` that the caller started the request. Never shown to the browser.
    pub poll_secret: String,
    /// What the user types on the approval page, as `XXXX-XXXX`.
    pub user_code: String,
    /// Path of the approval page. The CLI joins it with the server URL it was given, which
    /// the browser can reach too, rather than trusting a host name the server guesses.
    pub approval_path: String,
    #[ts(type = "number")]
    pub expires_in_seconds: u64,
}

/// Where a login request stands, as the approval page shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum CliLoginStatus {
    /// Waiting for the user.
    Pending,
    /// Approved; the token waits for the CLI to pick it up.
    Approved,
    /// Turned down; the CLI is told at its next poll.
    Denied,
}

/// `GET /api/v1/cli-logins/{id}`: what the approval page shows. Never carries the user code
/// or the poll secret, so the page cannot be approved without looking at the terminal.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CliLoginResponse {
    pub host_name: String,
    /// The TCP peer that started the request; a proxy's address when there is one.
    pub client_ip: String,
    /// The client a reverse proxy claims to forward for, unverified.
    pub forwarded_for: Option<String>,
    pub token: CliTokenDefaults,
    pub status: CliLoginStatus,
    /// Seconds since the CLI started the request.
    #[ts(type = "number")]
    pub age_seconds: u64,
    #[ts(type = "number")]
    pub expires_in_seconds: u64,
}

/// `POST /api/v1/cli-logins/{id}/approve`: the browser approves with the code from the
/// terminal and the token as the user left it in the form.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApproveCliLoginRequest {
    pub user_code: String,
    pub token: CreateAccessTokenRequest,
}

/// The approved token's metadata. The secret goes to the CLI only, never to the browser.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApproveCliLoginResponse {
    pub metadata: AccessTokenResponse,
}

/// `POST /api/v1/cli-logins/{id}/deny`: confirms the request was turned down.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DenyCliLoginResponse {
    pub denied: bool,
}

/// `POST /api/v1/cli-logins/{id}/wait`: the CLI's long poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitCliLoginRequest {
    pub poll_secret: String,
}

/// Answer of one `wait` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CliLoginWaitResponse {
    /// Nothing happened yet; poll again.
    Pending,
    /// The user turned the request down in the browser.
    Denied,
    /// The token, handed out exactly once.
    Approved(AccessTokenSecretResponse),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CLI flag values and the browser's select values are the same wire names.
    #[test]
    fn lifetimes_use_the_flag_spelling() {
        // `--expires 90d` and the select's "90d" must mean the same thing.
        assert_eq!(
            serde_json::to_string(&TokenLifetime::Days90).expect("JSON"),
            "\"90d\""
        );
        // "never" is the only lifetime without a day count.
        assert_eq!(TokenLifetime::Never.days(), None);
        assert_eq!(TokenLifetime::Days365.days(), Some(365));
    }

    /// The CLI tells the outcomes apart by the `status` tag, and the approved token keeps the
    /// shape `create-token` prints.
    #[test]
    fn wait_answers_are_tagged() {
        // A pending answer has nothing but the tag.
        assert_eq!(
            serde_json::to_value(CliLoginWaitResponse::Pending).expect("JSON"),
            serde_json::json!({"status": "pending"})
        );
        let approved: CliLoginWaitResponse = serde_json::from_value(serde_json::json!({
            "status": "approved",
            "token": "redoor_at_x",
            "metadata": {
                "id": "1",
                "name": "n",
                "permissions": ["files:read"],
                "devices": {"kind": "all"},
                "created_at": "2026-01-01T00:00:00Z",
                "expires_at": null,
                "last_used_at": null
            }
        }))
        .expect("JSON");
        // The token sits next to the tag, flattened from `AccessTokenSecretResponse`.
        assert!(
            matches!(approved, CliLoginWaitResponse::Approved(secret) if secret.token == "redoor_at_x")
        );
    }
}
