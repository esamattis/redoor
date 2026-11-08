//! Browser login, cookie sessions and login rate limiting.
//!
//! Redoor has exactly one account with full access; several login methods lead into it.
//! The name a session signed in with only says who is working, for logs and the UI:
//! everyone who can sign in can already run commands as the server's user, so per-user
//! rights would only pretend to protect anything.

use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::Context;
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use redoor_core::config::{OidcConfig, ServerPasswordEditError};
use redoor_core::{log, log_error};
use redoor_protocol::api::{
    ErrorResponse,
    auth::{LoginRequest, LoginResponse, LogoutResponse, SessionLength},
};
use redoor_protocol::wire::log::Level;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use super::client_address::ClientAddress;
use super::state::ServerState;
use password_logins::{Logins, PasswordLogins};

mod password_logins;

/// Cookie carrying the browser session as `<id>.<secret>`: the stable session id and the
/// secret that rotates while the user works (see [`SecretState`]).
const SESSION_COOKIE_NAME: &str = "redoor_session";
/// `Max-Age` of every session cookie: the longest session length. The server alone enforces
/// the idle expiry, so the cookie is never refreshed; a cookie tied to the lifetime would
/// expire in the browser while a long transfer still holds the session open. A dead session
/// id left in the browser is harmless, because the server rejects it.
const SESSION_COOKIE_MAX_AGE: Duration = SessionLength::Year.duration();
/// Upper bound on how often a renewal rewrites a session file, so an active UI and many
/// finishing transfers do not turn every renewal into a disk write. Also the granularity
/// of the expiry the UI is told.
const SESSION_RENEWAL_INTERVAL: Duration = Duration::from_secs(60);
/// Shortest time between two rotations of a session's secret. Counted from when the current
/// secret was issued rather than from the last expiry write, because a finished transfer
/// moves the expiry too: an attacker finishing a download every minute would otherwise keep
/// the victim's activity from ever rotating.
const ROTATION_INTERVAL: Duration = Duration::from_secs(60);
/// How long the secret a rotation replaced keeps working without counting as reuse. Covers
/// requests the browser sent before the rotation response arrived.
const ROTATION_GRACE: Duration = Duration::from_secs(30);
// A browser must never be two rotations behind with a request that is legitimately in
// flight, or its own stale secret would sign it out.
const _: () = assert!(ROTATION_GRACE.as_secs() < ROTATION_INTERVAL.as_secs());
/// How long after its credentials were checked a session may create or rotate access
/// tokens. A copied browser profile carries an older session, so it cannot mint a token
/// that would outlive the session, a password change and the mutual logout of a reused
/// cookie; the user signs in again as the last step instead.
pub(crate) const TOKEN_FRESHNESS: Duration = Duration::from_secs(60);
/// Caps online brute force against a single source address.
const LOGIN_MAX_FAILURES_PER_IP: u32 = 10;
/// Caps coordinated multi-source brute force against the whole process.
const LOGIN_MAX_FAILURES_GLOBAL: u32 = 60;
/// Bounds retained source addresses without evicting an active per-IP lockout.
const LOGIN_MAX_TRACKED_IPS: usize = 1_024;
/// Fixed window over which failed logins are counted before the counters reset.
const LOGIN_RATE_WINDOW: Duration = Duration::from_secs(60);
/// Shortest password the change form accepts. The TOML file is not held to it, so existing
/// configs keep working, but a password chosen in the UI should resist online guessing.
pub(crate) const MIN_NEW_PASSWORD_CHARS: usize = 8;

/// Holds the login verifiers and the durable directory used to validate opaque cookies.
#[derive(Clone)]
pub(crate) struct AuthState {
    /// Password logins, read from the config file whenever it changes, so hand edits and
    /// the password change form take effect without a restart.
    logins: Arc<PasswordLogins>,
    /// Argon2 hash of a random password with the default parameters, verified for names
    /// that are no login at all so the response time does not reveal which names exist.
    dummy_hash: Arc<str>,
    /// Serializes password changes, so two concurrent changes cannot both verify the old
    /// password and then both write the file.
    password_change_lock: Arc<tokio::sync::Mutex<()>>,
    sessions_directory: PathBuf,
    /// When true, Set-Cookie includes `Secure` so browsers only send the session over HTTPS.
    cookie_secure: bool,
    /// Shared secret agents must present at registration to prevent unauthenticated hijacks.
    agent_token: String,
    /// Counts failed logins of every method and failed current-password checks of the change
    /// form alike, so a stolen session cannot be used to guess a password faster than the
    /// login page.
    pub(crate) login_limiter: Arc<LoginRateLimiter>,
    /// Present when OIDC sign-in is configured; governs the sessions it creates.
    oidc_sessions: Option<OidcSessionPolicy>,
    /// Orders session renewals against logouts, so a renewal racing a logout cannot write
    /// the just-deleted session file back.
    session_file_lock: Arc<tokio::sync::Mutex<()>>,
    /// Uploads and downloads in progress per session id. A session with one keeps working
    /// past its idle expiry, because a user waiting for a long transfer is not idle and
    /// the browser cannot report activity for a native download.
    transfers: Arc<Mutex<HashMap<String, usize>>>,
}

/// How sessions created by OIDC sign-in are bound and how long they live.
#[derive(Clone)]
struct OidcSessionPolicy {
    /// Digest of the provider settings, so changing the issuer, client or allowed groups
    /// invalidates sessions that were granted under the old rules.
    fingerprint: String,
    /// Upper bound on the idle lifetime of OIDC sessions (`session_lifetime_days`), so an
    /// operator can keep sign-ins through the provider shorter than the login page offers.
    lifetime: Duration,
}

/// Which login created a session, because each kind is bound to its own part of the config
/// and revoked on its own.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionMethod {
    /// A `[[server.users]]` name and password; revoked when that user's password changes or
    /// the user is removed. The default keeps session files written
    /// before OIDC support valid.
    #[default]
    Password,
    /// OpenID Connect sign-in; revoked when the OIDC settings change.
    Oidc,
}

impl SessionMethod {
    /// The method as written in logs and the API.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Oidc => "oidc",
        }
    }
}

/// Who a browser session belongs to and how they signed in. Only for display and logs:
/// every session has the same full access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionUser {
    /// The login name, or the OIDC user's readable name.
    pub(crate) name: String,
    /// The login method that created the session.
    pub(crate) method: SessionMethod,
}

impl SessionUser {
    /// How log lines name this user, e.g. `alice (password)`.
    pub(crate) fn log_label(&self) -> String {
        format!("{} ({})", self.name, self.method.as_str())
    }
}

/// Outcome of checking a request's session cookie. Checking never renews the session: only
/// explicit activity and finished transfers do, so background polling of an unattended
/// browser cannot keep it signed in.
pub(crate) enum SessionCheck {
    /// No usable session; the request must be treated as unauthenticated.
    Invalid,
    /// The session is valid: who it belongs to, which session it is, and a `Set-Cookie` to
    /// add to the response when the browser missed a rotation ([`SecretState::LostRotation`]).
    Valid(SessionUser, ActiveSession, Option<HeaderValue>),
    /// The cookie was used by two browsers, so the session was deleted for both. Answered
    /// like [`Self::Invalid`]; the variant exists so the caller can log the detection with
    /// the request's client address.
    Reused(ReusedSession),
}

/// Where a session stands, for callers that know only its id and no secret: websockets
/// watching their session end and the vault device prune task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionStatus {
    /// Still signed in.
    Live,
    /// Expired, logged out, signed out from another browser, revoked by a credential change
    /// or deleted because two browsers used its cookie.
    Ended,
}

/// A session deleted because two browsers used its cookie. Only the request that detected
/// the reuse gets one; later requests of either browser find no session at all.
pub(crate) struct ReusedSession {
    /// The stable session id, to drop what else the server keeps for the session.
    pub(crate) id: String,
    pub(crate) user: SessionUser,
    /// Seconds since the secret the request presented was rotated away, to tell false
    /// positives (a slow network outlasting [`ROTATION_GRACE`]) apart from a stolen cookie;
    /// `None` when it was no secret this session ever had.
    pub(crate) since_rotation: Option<i64>,
}

impl ReusedSession {
    /// Drops the session's vault device secrets and logs the detection. The server log is
    /// the only place the reuse is reported: both browsers just see a signed-out session.
    /// The vault device secrets go at once, as when signing a session out from the session
    /// list, rather than at the prune task's next pass. `client` is the browser that
    /// presented the stale secret, when known.
    pub(crate) fn forget(&self, state: &ServerState, client: Option<&ClientAddress>) {
        state.vault_devices.delete_session(&self.id);
        let client = client.map_or_else(|| "an unknown address".to_string(), ToString::to_string);
        // The timing tells a slow network (a few seconds past the grace period) from a stolen
        // cookie, so the reader knows how seriously to take the warning.
        let timing = match self.since_rotation {
            Some(seconds) => format!("rotated away {seconds} s earlier"),
            None => "never issued for this session".to_string(),
        };
        // Worded for someone reading the log with no knowledge of rotation: the warning is
        // the only report of a possible breach, so it says what it means and what to do.
        log!(
            Level::Warning,
            "Possible security breach: the session cookie of {} (session {}) was used from two browsers, as a stolen cookie or a copied browser profile would be. Both browsers were signed out. The stale secret came from {client} and was {timing}. Unless this was a slow network, change the password and review the signed-in sessions.",
            self.user.log_label(),
            public_session_id(&self.id)
        );
    }
}

/// The browser session behind a request, put into the request extensions next to
/// `Principal::Session` so handlers can renew it, hold it open during a transfer, or watch
/// it end from a websocket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveSession {
    /// The stable session id from the cookie, already validated as a UUID. It names the
    /// session file and stays the same across rotations, so everything keyed on it (transfer
    /// holds, websocket watches, vault devices) survives them.
    pub(crate) id: String,
    /// The session length chosen at sign-in. A password change issues its new session with
    /// the same length.
    pub(crate) length: SessionLength,
    /// Unix seconds after which the session ends without activity. While a transfer keeps
    /// the session open this is at least a full lifetime away, because the transfer renews
    /// the session when it finishes.
    pub(crate) expires_at: i64,
    /// Hash of the secret the request presented. Renewing and rotating classify it again
    /// under the session file lock, because another tab may have rotated the session since
    /// the access check.
    pub(crate) presented: String,
    /// Unix seconds when the session's credentials were last checked; see
    /// [`SessionFile::authenticated_at`]. Carried here so the token handlers need no second
    /// read of the session file.
    pub(crate) authenticated_at: Option<i64>,
}

impl ActiveSession {
    /// Seconds this session can still create or rotate access tokens at `now`, 0 when the
    /// user has to sign in again first ([`TOKEN_FRESHNESS`]). A sign-in that was never
    /// checked counts as stale, and so does a time in the future: the OIDC callback clamps
    /// to the server's clock, so only a hand-edited file could hold one, and it must not
    /// stretch the window.
    pub(crate) fn fresh_login_seconds_left(&self, now: i64) -> u64 {
        let Some(authenticated_at) = self.authenticated_at else {
            return 0;
        };
        let age = now - authenticated_at;
        let window = TOKEN_FRESHNESS.as_secs() as i64;
        if !(0..window).contains(&age) {
            return 0;
        }
        (window - age) as u64
    }
}

/// A renewal or rotation that succeeded: the expiry, and the new session cookie when the
/// secret was rotated.
pub(crate) struct UpdatedSession {
    /// Unix seconds after which the session ends without further activity.
    pub(crate) expires_at: i64,
    /// `Set-Cookie` with the new secret, present only when the session rotated.
    pub(crate) cookie: Option<HeaderValue>,
}

/// Why a session file is updated, because each cause may change different parts of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionUpdate<'a> {
    /// The UI reported user interaction: slides the expiry and rotates the secret.
    /// `presented` is the hash of the secret the request carried.
    Activity { presented: &'a str },
    /// An open tab asked for a new secret: rotates without moving the expiry, so an idle
    /// tab keeps the secret moving without keeping the session alive.
    Rotate { presented: &'a str },
    /// An upload or download of the session finished: slides the expiry, and may renew a
    /// session that only the transfer kept alive past its expiry. Never rotates, because no
    /// response is left to carry a new cookie.
    TransferFinished,
}

/// A successful credential check: who signed in and the fingerprint the new session is
/// bound to. The fingerprint is the one of the verifier that was checked, so a password
/// change finishing in between cannot hand a session made with the old password the new
/// fingerprint.
struct SessionGrant {
    user: SessionUser,
    fingerprint: String,
    /// When the credentials behind the grant were checked; see
    /// [`SessionFile::authenticated_at`].
    authenticated_at: Option<i64>,
}

/// The outcome of a login check, carrying the session grant on success so the handler
/// cannot create a session for a rejected attempt.
enum LoginVerification {
    /// Authentication succeeded, so the handler may create a session.
    Authenticated(SessionGrant),
    /// Authentication failed, so the rate limiter must record the rejected attempt.
    Rejected,
}

/// Tracks recent failed logins so online guessing cannot run unbounded.
pub(crate) struct LoginRateLimiter {
    by_ip: Mutex<HashMap<IpAddr, FailureWindow>>,
    global: Mutex<FailureWindow>,
}

/// Sliding failure window used by both per-IP and global login throttles.
#[derive(Clone, Copy)]
struct FailureWindow {
    started_at: Instant,
    failures: u32,
}

impl FailureWindow {
    /// Uses the supplied observation time so boundary behavior can be verified without sleeps.
    fn new(now: Instant) -> Self {
        Self {
            started_at: now,
            failures: 0,
        }
    }

    /// Resets the window when it has expired so legitimate users recover after a burst.
    fn refresh(&mut self, now: Instant) {
        if now.duration_since(self.started_at) >= LOGIN_RATE_WINDOW {
            *self = Self::new(now);
        }
    }
}

impl LoginRateLimiter {
    /// Creates empty throttle state shared across all login attempts.
    fn new() -> Self {
        Self {
            by_ip: Mutex::new(HashMap::new()),
            global: Mutex::new(FailureWindow::new(Instant::now())),
        }
    }

    /// Prunes expired failures and rejects untracked sources when active tracking is full.
    pub(crate) fn is_limited(&self, ip: IpAddr, now: Instant) -> bool {
        let mut by_ip = self.by_ip.lock().expect("login rate limiter poisoned");
        by_ip.retain(|_, window| now.duration_since(window.started_at) < LOGIN_RATE_WINDOW);
        // Successful logins and throttled checks need no entry. At capacity, preserve existing
        // lockouts rather than letting source-address churn reset an attacker's failure count.
        if let Some(entry) = by_ip.get(&ip) {
            if entry.failures >= LOGIN_MAX_FAILURES_PER_IP {
                return true;
            }
        } else if by_ip.len() >= LOGIN_MAX_TRACKED_IPS {
            return true;
        }

        let mut global = self.global.lock().expect("login rate limiter poisoned");
        global.refresh(now);
        global.failures >= LOGIN_MAX_FAILURES_GLOBAL
    }

    /// Counts all rejected credentials while retaining only a bounded set of active sources.
    pub(crate) fn record_failure(&self, ip: IpAddr, now: Instant) {
        let mut by_ip = self.by_ip.lock().expect("login rate limiter poisoned");
        by_ip.retain(|_, window| now.duration_since(window.started_at) < LOGIN_RATE_WINDOW);
        if by_ip.contains_key(&ip) || by_ip.len() < LOGIN_MAX_TRACKED_IPS {
            let entry = by_ip.entry(ip).or_insert_with(|| FailureWindow::new(now));
            entry.failures = entry.failures.saturating_add(1);
        }

        // Verification may finish after other requests fill the map, so an untracked failure
        // must still contribute to the process-wide limit instead of bypassing abuse protection.
        let mut global = self.global.lock().expect("login rate limiter poisoned");
        global.refresh(now);
        global.failures = global.failures.saturating_add(1);
    }
}

/// Persists the minimum bounded metadata needed to recognize one authenticated browser.
#[derive(Debug, Serialize, Deserialize)]
struct SessionFile {
    session_id: String,
    /// The login name the session signed in with; for OIDC the user's readable name.
    username: String,
    /// Binds the cookie to the credential that was current when the session was issued.
    credentials_fingerprint: String,
    expires_at: i64,
    #[serde(default)]
    method: SessionMethod,
    /// The idle lifetime the user picked on the login page. Required: files written before
    /// the choice existed do not parse and are dropped, so that upgrade signed everyone out
    /// once instead of keeping sessions whose lifetime nobody chose.
    length: SessionLength,
    /// Unix seconds of the sign-in, shown in the session list.
    created_at: i64,
    /// The browser that signed in, shown in the session list so the user can recognise it.
    client: SessionClient,
    /// The secret the browser should present now. Required: files written before rotation
    /// existed do not parse and are dropped, so that upgrade signed everyone out once.
    current: CurrentSecret,
    /// The secret the last rotation replaced, kept to tell a request sent before the
    /// rotation response arrived ([`SecretState::Grace`]) from a second browser.
    #[serde(default)]
    previous: Option<PreviousSecret>,
    /// Unix seconds when the credentials were last checked for this session: the login time
    /// for a password login or a password change, and the provider's `auth_time` for an OIDC
    /// sign-in that asked the provider to authenticate again. `None` for a plain OIDC
    /// sign-in, whose single sign-on a copied profile could pass without any credential.
    /// Gates access token creation ([`TOKEN_FRESHNESS`]). Optional, so files from before it
    /// existed stay signed in and only have to sign in again to mint a token.
    #[serde(default)]
    authenticated_at: Option<i64>,
}

/// The secret a browser presents in its cookie now.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CurrentSecret {
    /// SHA-256 of the secret ([`secret_hash`]), so the data directory holds no working cookie
    /// once the browser has used the secret.
    hash: String,
    /// Unix seconds of the rotation (or sign-in) that issued it; drives [`ROTATION_INTERVAL`].
    issued_at: i64,
    /// The plaintext, kept only until a request presents it, so a lost or delayed rotation
    /// response can be repaired by re-sending the same secret ([`SecretState::LostRotation`]).
    #[serde(default)]
    unconfirmed: Option<String>,
}

/// The secret the last rotation replaced.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreviousSecret {
    /// SHA-256 of the secret ([`secret_hash`]).
    hash: String,
    /// Unix seconds when it stopped being current; starts [`ROTATION_GRACE`].
    retired_at: i64,
}

/// What the secret a request presented means for its session. Any secret that is neither
/// `current` nor a recent `previous` proves a split: the session id only ever leaves the
/// server inside a cookie, so whoever sends it with a wrong secret once had a real cookie of
/// this session. The server therefore needs no history of older secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SecretState {
    /// The current secret.
    Current,
    /// The previous secret within [`ROTATION_GRACE`] of its rotation: a request sent before
    /// the rotation response arrived. Accepted without changing the cookie.
    Grace,
    /// The previous secret after the grace period while the current one was never presented:
    /// the rotation response never reached the browser, or has not yet. Accepted, and the same
    /// current secret is sent again, so a late rotation response installs the same cookie.
    LostRotation,
    /// A secret the session has moved past: two browsers share the session.
    Reused,
}

/// Where a stored session stands, before looking at any secret.
enum StoredState {
    /// Signed in until `expires_at` (Unix seconds), or longer while a transfer runs.
    Live { expires_at: i64 },
    /// Expired, or its login no longer matches; the file can go.
    Ended,
}

impl SessionFile {
    /// Classifies the hash of a presented secret at `now`; see [`SecretState`]. Pure, so
    /// every row of the table can be tested with any clock.
    fn classify(&self, presented: &str, now: i64) -> SecretState {
        if hashes_match(&self.current.hash, presented) {
            return SecretState::Current;
        }
        match &self.previous {
            Some(previous) if hashes_match(&previous.hash, presented) => {
                if now - previous.retired_at < ROTATION_GRACE.as_secs() as i64 {
                    SecretState::Grace
                } else if self.current.unconfirmed.is_some() {
                    SecretState::LostRotation
                } else {
                    SecretState::Reused
                }
            }
            _ => SecretState::Reused,
        }
    }

    /// Replaces the current secret with a new one and returns its plaintext for the cookie.
    /// The old one becomes `previous`, starting its grace period.
    fn rotate(&mut self, now: i64) -> anyhow::Result<String> {
        let secret = new_session_secret()?;
        let retired = std::mem::replace(
            &mut self.current,
            CurrentSecret {
                hash: secret_hash(&secret),
                issued_at: now,
                unconfirmed: Some(secret.clone()),
            },
        );
        self.previous = Some(PreviousSecret {
            hash: retired.hash,
            retired_at: now,
        });
        Ok(secret)
    }

    /// Re-sends the unconfirmed current secret to a browser that missed its rotation, and
    /// returns it. Restarts both clocks: the previous secret's grace period, so the same
    /// browser's other requests still in flight with it are accepted, and the rotation
    /// throttle, so a second recovery response cannot arrive after a newer rotation's cookie
    /// and overwrite it with this older one.
    fn recover_lost_rotation(&mut self, now: i64) -> Option<String> {
        let secret = self.current.unconfirmed.clone()?;
        self.current.issued_at = now;
        if let Some(previous) = &mut self.previous {
            previous.retired_at = now;
        }
        Some(secret)
    }

    /// Describes the session as reused by the presented secret, for the warning: how long
    /// ago that secret was rotated away.
    fn reused(&self, presented: &str, now: i64) -> ReusedSession {
        let since_rotation = self
            .previous
            .as_ref()
            .filter(|previous| hashes_match(&previous.hash, presented))
            .map(|previous| now - previous.retired_at);
        ReusedSession {
            id: self.session_id.clone(),
            user: self.user(),
            since_rotation,
        }
    }

    /// Who the session belongs to.
    fn user(&self) -> SessionUser {
        SessionUser {
            name: self.username.clone(),
            method: self.method,
        }
    }
}

/// A fresh random session secret: 32 bytes from the OS CSPRNG, base64url so it needs no
/// escaping in a cookie and never contains the `.` that separates it from the id.
fn new_session_secret() -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow::anyhow!("failed to read OS randomness: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The stored form of a session secret: SHA-256, like access tokens. The secret has 256 bits
/// of entropy, so a plain hash needs no salt or slow KDF.
fn secret_hash(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

/// Compares two secret hashes in constant time, so timing does not reveal how much of a
/// guessed secret matched.
fn hashes_match(stored: &str, presented: &str) -> bool {
    stored.as_bytes().ct_eq(presented.as_bytes()).into()
}

/// The session cookie a request carried, split into its parts.
struct SessionCookie {
    /// The stable session id, validated as a UUID before it becomes a path.
    id: String,
    /// The secret as the browser sent it.
    secret: String,
}

impl SessionCookie {
    /// Extracts `<id>.<secret>` without accepting similarly named cookie prefixes, and
    /// rejects any other shape, such as the bare id of the format before rotation.
    fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let value = headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .filter_map(|cookie| cookie.trim().split_once('='))
            .find_map(|(name, value)| (name == SESSION_COOKIE_NAME).then_some(value))?;
        let (id, secret) = value.split_once('.')?;
        Uuid::parse_str(id).ok()?;
        if secret.is_empty() {
            return None;
        }
        Some(Self {
            id: id.to_string(),
            secret: secret.to_string(),
        })
    }

    /// The hash the session file is compared against.
    fn presented_hash(&self) -> String {
        secret_hash(&self.secret)
    }
}

/// What the server saw of the browser when it signed in, so the session list can tell the
/// user's browsers apart and reveal one they do not recognise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionClient {
    /// The `User-Agent` header, cut to [`MAX_USER_AGENT_LEN`].
    pub(crate) user_agent: Option<String>,
    /// IP of the TCP peer; the proxy when there is one.
    pub(crate) ip: IpAddr,
    /// The client a reverse proxy claims to forward for, unverified.
    pub(crate) forwarded_for: Option<String>,
}

/// Longest `User-Agent` kept. The header is client controlled and stored in a session file
/// that every session list reads, so an oversized one is cut instead of copied whole.
const MAX_USER_AGENT_LEN: usize = 512;

impl SessionClient {
    /// Describes the browser behind a sign-in request.
    pub(crate) fn new(client: &ClientAddress, headers: &HeaderMap) -> Self {
        // `to_str` only accepts visible ASCII, so the value cannot carry control characters
        // into the UI, and cutting at any byte index is a char boundary.
        let user_agent = headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value[..value.len().min(MAX_USER_AGENT_LEN)].to_string());
        Self {
            user_agent,
            ip: client.peer.ip(),
            forwarded_for: client.forwarded_for.clone(),
        }
    }
}

/// A signed-in session as the session list shows it. Carries the session id only so the
/// server can delete it; handlers must expose `public_id` instead.
pub(crate) struct ListedSession {
    /// The stable session id. Never leaves the server: anyone who knows it could sign the
    /// session out by sending it with a made-up secret, which counts as reuse.
    pub(crate) id: String,
    /// See [`public_session_id`].
    pub(crate) public_id: String,
    pub(crate) user: SessionUser,
    pub(crate) length: SessionLength,
    /// Unix seconds of the sign-in.
    pub(crate) created_at: i64,
    /// Unix seconds after which the session ends without activity.
    pub(crate) expires_at: i64,
    pub(crate) client: SessionClient,
}

/// Domain of the public session id digest, so the digest of a session id is never equal to
/// a digest the server computes for any other purpose.
const PUBLIC_SESSION_ID_DOMAIN: &[u8] = b"redoor-public-session-id-v1:";

/// The identifier the session list and the logs show for a session, derived from its stable
/// id, so it survives rotations of the secret.
///
/// Every signed-in browser can read the session list, and the session id must stay unknown
/// (see [`ListedSession::id`]), so the list names sessions by a one-way digest instead.
/// Deriving it rather than storing a second random id means it can never get out of step
/// with the session it names.
pub(crate) fn public_session_id(session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PUBLIC_SESSION_ID_DOMAIN);
    hasher.update(session_id.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl AuthState {
    /// Reads the password logins from `config_path`, creates the private session directory
    /// before requests arrive so login failures are actionable, and drops sessions of logins
    /// that no longer exist.
    pub(crate) async fn new(
        config_path: PathBuf,
        oidc: Option<&OidcConfig>,
        agent_token: String,
        cookie_secure: bool,
        data_dir: &std::path::Path,
    ) -> anyhow::Result<Self> {
        let logins = PasswordLogins::load(config_path)
            .await
            .context("Failed to read the password logins")?;
        // Argon2 is deliberately slow, so the dummy hash is made off the async workers.
        let dummy_hash = tokio::task::spawn_blocking(|| hash_password(&Uuid::new_v4().to_string()))
            .await
            .map_err(|error| anyhow::anyhow!("password hashing task failed: {error}"))??;

        // Keep independent application namespaces from sharing browser sessions on disk.
        let sessions_directory = data_dir.join("sessions");
        tokio::fs::create_dir_all(&sessions_directory).await?;

        #[cfg(unix)]
        {
            ensure_private_directory(&sessions_directory).await?;
        }

        let auth = Self {
            logins: Arc::new(logins),
            dummy_hash: Arc::from(dummy_hash),
            password_change_lock: Arc::default(),
            sessions_directory,
            cookie_secure,
            agent_token,
            login_limiter: Arc::new(LoginRateLimiter::new()),
            oidc_sessions: oidc.map(|config| OidcSessionPolicy {
                fingerprint: oidc_fingerprint(config),
                lifetime: config.session_lifetime,
            }),
            session_file_lock: Arc::new(tokio::sync::Mutex::new(())),
            transfers: Arc::default(),
        };

        // Drop sessions of changed passwords and removed logins so the change takes effect
        // immediately.
        auth.purge_stale_sessions().await?;

        Ok(auth)
    }

    /// Shared secret that agents must present when upgrading their websocket connection.
    pub(crate) fn agent_token(&self) -> &str {
        &self.agent_token
    }

    /// Maps a validated UUID to its one-file-per-session storage path.
    fn session_path(&self, session_id: &str) -> Option<PathBuf> {
        Uuid::parse_str(session_id).ok().map(|_| {
            self.sessions_directory
                .join(format!("session_{session_id}.json"))
        })
    }

    /// Reads the session file on every request so logout and server restarts share one
    /// source of truth, and classifies the presented secret ([`SecretState`]).
    ///
    /// Most requests only read. Confirming a new secret, re-sending a lost rotation and
    /// deleting a reused session change the file, so they run a second time under the session
    /// file lock with a fresh read: another request may have rotated the session in between.
    pub(crate) async fn check_session(&self, headers: &HeaderMap) -> SessionCheck {
        let Some(cookie) = SessionCookie::from_headers(headers) else {
            return SessionCheck::Invalid;
        };
        if let Some(check) = self.check_cookie(&cookie, None).await {
            return check;
        }
        let guard = self.session_file_lock.lock().await;
        self.check_cookie(&cookie, Some(&guard))
            .await
            .unwrap_or(SessionCheck::Invalid)
    }

    /// One pass of [`Self::check_session`]. Without `lock` it returns `None` as soon as the
    /// outcome needs a write; with it, `lock` proves the caller holds the session file lock,
    /// so writing is safe.
    async fn check_cookie(
        &self,
        cookie: &SessionCookie,
        lock: Option<&tokio::sync::MutexGuard<'_, ()>>,
    ) -> Option<SessionCheck> {
        let Some(path) = self.session_path(&cookie.id) else {
            return Some(SessionCheck::Invalid);
        };
        let Some(mut session) = read_session_file(&path).await else {
            return Some(SessionCheck::Invalid);
        };
        let now = jiff::Timestamp::now().as_second();
        let logins = self.logins.current().await;
        let state = if session.session_id == cookie.id {
            self.stored_state(&session, &logins, now)
        } else {
            StoredState::Ended
        };
        let expires_at = match state {
            StoredState::Live { expires_at } => expires_at,
            StoredState::Ended => {
                // Remove ended files so disk does not retain stealable sessions.
                let _ = tokio::fs::remove_file(path).await;
                return Some(SessionCheck::Invalid);
            }
        };
        let presented = cookie.presented_hash();
        let secret = session.classify(&presented, now);
        let active = ActiveSession {
            id: session.session_id.clone(),
            length: session.length,
            expires_at,
            presented: presented.clone(),
            authenticated_at: session.authenticated_at,
        };
        let needs_write = match secret {
            SecretState::Current => session.current.unconfirmed.is_some(),
            SecretState::Grace => false,
            SecretState::LostRotation | SecretState::Reused => true,
        };
        if !needs_write {
            return Some(SessionCheck::Valid(session.user(), active, None));
        }
        lock?;
        let check = match secret {
            SecretState::Current | SecretState::Grace => {
                // The browser has the new secret, so the plaintext can leave the disk.
                session.current.unconfirmed = None;
                SessionCheck::Valid(session.user(), active, None)
            }
            SecretState::LostRotation => {
                let secret = session.recover_lost_rotation(now)?;
                let cookie = self.session_set_cookie(&session.session_id, &secret);
                SessionCheck::Valid(session.user(), active, Some(cookie))
            }
            SecretState::Reused => {
                // Deleting signs out both browsers. The answer stands even when it fails: the
                // file is kept, so the next request with the stale secret detects it again.
                if let Err(error) = remove_session_file(&path).await {
                    log_error!(error, "Failed to delete a reused session");
                }
                return Some(SessionCheck::Reused(session.reused(&presented, now)));
            }
        };
        // The answer stands even when the write fails: a missed confirmation or recovery only
        // repeats on the next request.
        if let Err(error) = self.write_session(&session).await {
            log_error!(
                error,
                "Failed to update a session after checking its secret"
            );
        }
        Some(check)
    }

    /// Checks one session by id alone, for websockets that watch their session end and for
    /// the vault device prune task, which have no secret. Never renews; an expired session
    /// is only kept while a transfer of it is still running.
    pub(crate) async fn check_session_id(&self, session_id: &str) -> SessionStatus {
        let Some(path) = self.session_path(session_id) else {
            return SessionStatus::Ended;
        };
        let Some(session) = read_session_file(&path).await else {
            return SessionStatus::Ended;
        };
        let now = jiff::Timestamp::now().as_second();
        let logins = self.logins.current().await;
        if session.session_id != session_id {
            return SessionStatus::Ended;
        }
        match self.stored_state(&session, &logins, now) {
            StoredState::Live { .. } => SessionStatus::Live,
            StoredState::Ended => {
                let _ = tokio::fs::remove_file(path).await;
                SessionStatus::Ended
            }
        }
    }

    /// Where a stored session stands at `now`. Shared by the request check, the watches and
    /// the session list, so the list shows exactly the sessions that would still be let in.
    fn stored_state(&self, session: &SessionFile, logins: &Logins, now: i64) -> StoredState {
        if !self.is_current(session, logins) {
            return StoredState::Ended;
        }
        if !self.has_transfers(&session.session_id) {
            return if session.expires_at > now {
                StoredState::Live {
                    expires_at: session.expires_at,
                }
            } else {
                StoredState::Ended
            };
        }
        // The transfer renews the session when it ends, so it cannot expire before then.
        let lifetime = self.lifetime(session.method, session.length).as_secs() as i64;
        StoredState::Live {
            expires_at: session.expires_at.max(now + lifetime),
        }
    }

    /// Every session that is still signed in, newest sign-in first, for the session list.
    ///
    /// Read-only: files of ended sessions are left for the request check and the startup
    /// purge to remove, so listing never races a renewal or a logout.
    pub(crate) async fn list_sessions(&self) -> anyhow::Result<Vec<ListedSession>> {
        let logins = self.logins.current().await;
        let now = jiff::Timestamp::now().as_second();
        let mut sessions = Vec::new();
        let mut entries = tokio::fs::read_dir(&self.sessions_directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let Some(session) = read_session_file(&path).await else {
                continue;
            };
            // A file whose name does not match its id is never let in, so it is not listed.
            if self.session_path(&session.session_id).as_deref() != Some(path.as_path()) {
                continue;
            }
            let StoredState::Live { expires_at } = self.stored_state(&session, &logins, now) else {
                continue;
            };
            sessions.push(ListedSession {
                public_id: public_session_id(&session.session_id),
                id: session.session_id,
                user: SessionUser {
                    name: session.username,
                    method: session.method,
                },
                length: session.length,
                created_at: session.created_at,
                expires_at,
                client: session.client,
            });
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.created_at));
        Ok(sessions)
    }

    /// Signs out the signed-in session the list names `public_id`, or returns `None` when
    /// there is none. Returns the session so the caller can log it and drop what else
    /// belongs to it, such as its vault entries.
    pub(crate) async fn sign_out_session(
        &self,
        public_id: &str,
    ) -> anyhow::Result<Option<ListedSession>> {
        let Some(session) = self
            .list_sessions()
            .await?
            .into_iter()
            .find(|session| session.public_id == public_id)
        else {
            return Ok(None);
        };
        self.delete_session_id(&session.id).await?;
        Ok(Some(session))
    }

    /// Signs out every signed-in session except the caller's own `keep`, so a user who
    /// suspects a stolen cookie can end all other browsers without locking themselves out.
    pub(crate) async fn sign_out_other_sessions(
        &self,
        keep: &str,
    ) -> anyhow::Result<Vec<ListedSession>> {
        let mut signed_out = Vec::new();
        for session in self.list_sessions().await? {
            if session.id == keep {
                continue;
            }
            self.delete_session_id(&session.id).await?;
            signed_out.push(session);
        }
        Ok(signed_out)
    }

    /// The idle lifetime of a session: the length picked at sign-in, capped by
    /// `session_lifetime_days` for OIDC sessions. Computed on every use rather than stored,
    /// so lowering the OIDC cap also shortens sessions that already exist.
    fn lifetime(&self, method: SessionMethod, length: SessionLength) -> Duration {
        match method {
            SessionMethod::Password => length.duration(),
            // Without OIDC configured the session is revoked anyway; the shortest length is
            // only a safe answer.
            SessionMethod::Oidc => self
                .oidc_sessions
                .as_ref()
                .map_or(SessionLength::Hour.duration(), |policy| {
                    length.duration().min(policy.lifetime)
                }),
        }
    }

    /// Slides a session's expiry a full lifetime forward because the user was active, and
    /// rotates its secret when the request presented the current one. Returns `None` when the
    /// session is gone, expired or revoked, so activity can never revive a session.
    ///
    /// A request with the previous secret renews without rotating, so two tabs reporting
    /// activity at the same moment do not split the session.
    pub(crate) async fn renew_session(
        &self,
        session: &ActiveSession,
    ) -> anyhow::Result<Option<UpdatedSession>> {
        self.update(
            &session.id,
            SessionUpdate::Activity {
                presented: &session.presented,
            },
        )
        .await
    }

    /// Rotates the session's secret without moving its expiry, for an open tab that keeps
    /// the secret moving while nobody uses it. Returns `None` when the session is gone,
    /// expired or revoked.
    pub(crate) async fn rotate_session(
        &self,
        session: &ActiveSession,
    ) -> anyhow::Result<Option<UpdatedSession>> {
        self.update(
            &session.id,
            SessionUpdate::Rotate {
                presented: &session.presented,
            },
        )
        .await
    }

    /// Applies one [`SessionUpdate`]. The expiry is written at most once per
    /// [`SESSION_RENEWAL_INTERVAL`] and the secret rotated at most once per
    /// [`ROTATION_INTERVAL`], each on its own clock.
    ///
    /// Runs under the session file lock and reads the file again, so a renewal racing a
    /// logout cannot write the just-deleted session back, and the presented secret is
    /// classified against the session as it is now, not as the access check saw it.
    async fn update(
        &self,
        session_id: &str,
        update: SessionUpdate<'_>,
    ) -> anyhow::Result<Option<UpdatedSession>> {
        let Some(path) = self.session_path(session_id) else {
            return Ok(None);
        };
        let logins = self.logins.current().await;
        let _guard = self.session_file_lock.lock().await;
        let Some(mut session) = read_session_file(&path).await else {
            return Ok(None);
        };
        let now = jiff::Timestamp::now().as_second();
        let expired = session.expires_at <= now && !self.has_transfers(session_id);
        if session.session_id != session_id
            || !self.is_current(&session, &logins)
            || (update != SessionUpdate::TransferFinished && expired)
        {
            return Ok(None);
        }
        let mut changed = false;
        let mut cookie = None;
        if let SessionUpdate::Activity { presented } | SessionUpdate::Rotate { presented } = update
        {
            match session.classify(presented, now) {
                SecretState::Reused => return Ok(None),
                SecretState::Current
                    if now - session.current.issued_at >= ROTATION_INTERVAL.as_secs() as i64 =>
                {
                    let secret = session.rotate(now)?;
                    cookie = Some(self.session_set_cookie(session_id, &secret));
                    changed = true;
                }
                SecretState::Current | SecretState::Grace | SecretState::LostRotation => {}
            }
        }
        if !matches!(update, SessionUpdate::Rotate { .. }) {
            let lifetime = self.lifetime(session.method, session.length);
            let renewed_until = now + lifetime.as_secs() as i64;
            if renewed_until - session.expires_at >= SESSION_RENEWAL_INTERVAL.as_secs() as i64 {
                session.expires_at = renewed_until;
                changed = true;
            }
        }
        if changed {
            self.write_session(&session).await?;
        }
        Ok(Some(UpdatedSession {
            expires_at: session.expires_at,
            cookie,
        }))
    }

    /// Keeps a session open while an upload or download of it runs, and renews it when the
    /// transfer ends; see [`SessionActivityGuard`].
    pub(crate) fn hold_for_transfer(&self, session: &ActiveSession) -> SessionActivityGuard {
        *self
            .transfers
            .lock()
            .expect("session transfers poisoned")
            .entry(session.id.clone())
            .or_default() += 1;
        SessionActivityGuard {
            auth: self.clone(),
            session_id: session.id.clone(),
        }
    }

    /// Whether an upload or download of the session is still running.
    fn has_transfers(&self, session_id: &str) -> bool {
        self.transfers
            .lock()
            .expect("session transfers poisoned")
            .contains_key(session_id)
    }

    /// Forgets one finished transfer of the session.
    fn release_transfer(&self, session_id: &str) {
        let mut transfers = self.transfers.lock().expect("session transfers poisoned");
        if let Some(count) = transfers.get_mut(session_id) {
            *count -= 1;
            if *count == 0 {
                transfers.remove(session_id);
            }
        }
    }

    /// Whether a stored session still matches the login that issued it: a password session
    /// against the config file's current `logins`, an OIDC session against the running
    /// config. Each method is checked against its own credential, so changing one user's
    /// password or turning one method off revokes only those sessions.
    fn is_current(&self, session: &SessionFile, logins: &Logins) -> bool {
        match session.method {
            SessionMethod::Password => logins
                .get(&session.username)
                .is_some_and(|user| session.credentials_fingerprint == user.fingerprint),
            // Removing the OIDC config revokes every session it created. The name is only
            // for display, so it is not checked.
            SessionMethod::Oidc => self
                .oidc_sessions
                .as_ref()
                .is_some_and(|policy| session.credentials_fingerprint == policy.fingerprint),
        }
    }

    /// Creates a session for an OIDC sign-in; `name` is the provider's readable name for the
    /// user, recorded for display and logs only, and `length` is the login page's choice
    /// carried through the provider round trip (capped by `session_lifetime_days`).
    /// `authenticated_at` is set only when the provider proved a fresh authentication.
    pub(crate) async fn create_oidc_session(
        &self,
        name: String,
        length: SessionLength,
        client: SessionClient,
        authenticated_at: Option<i64>,
    ) -> anyhow::Result<NewSession> {
        let policy = self
            .oidc_sessions
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("OIDC sign-in is not configured"))?;
        self.issue_session(
            SessionGrant {
                user: SessionUser {
                    name,
                    method: SessionMethod::Oidc,
                },
                fingerprint: policy.fingerprint.clone(),
                authenticated_at,
            },
            length,
            client,
        )
        .await
    }

    /// Writes a new session file for a checked credential and builds its cookie.
    async fn issue_session(
        &self,
        grant: SessionGrant,
        length: SessionLength,
        client: SessionClient,
    ) -> anyhow::Result<NewSession> {
        let lifetime = self.lifetime(grant.user.method, length);
        let now = jiff::Timestamp::now();
        let secret = new_session_secret()?;
        let session = SessionFile {
            session_id: Uuid::new_v4().to_string(),
            username: grant.user.name.clone(),
            credentials_fingerprint: grant.fingerprint,
            expires_at: (now + lifetime).as_second(),
            method: grant.user.method,
            length,
            created_at: now.as_second(),
            client,
            current: CurrentSecret {
                hash: secret_hash(&secret),
                issued_at: now.as_second(),
                // Nothing to recover: a lost sign-in response leaves the browser without any
                // cookie, so the plaintext would only sit on disk.
                unconfirmed: None,
            },
            previous: None,
            authenticated_at: grant.authenticated_at,
        };
        self.write_session(&session).await?;
        Ok(NewSession {
            cookie: self.session_set_cookie(&session.session_id, &secret),
            user: grant.user,
        })
    }

    /// Writes through a temporary file so a crash cannot leave a partially valid JSON session.
    async fn write_session(&self, session: &SessionFile) -> anyhow::Result<()> {
        let session_id = &session.session_id;
        let path = self
            .session_path(session_id)
            .ok_or_else(|| anyhow::anyhow!("session id is not a UUID"))?;
        let temporary_path = self
            .sessions_directory
            .join(format!(".session_{session_id}.tmp"));
        let contents = serde_json::to_vec(session)?;
        write_private_file(&temporary_path, &contents).await?;
        tokio::fs::rename(&temporary_path, &path).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await?;
        }
        Ok(())
    }

    /// Builds the `Set-Cookie` value for a session so every issuer uses the same attributes,
    /// including the fixed [`SESSION_COOKIE_MAX_AGE`]. A rotation re-sends the same
    /// `Max-Age`; that does not lengthen the session, because the server alone enforces the
    /// idle expiry.
    fn session_set_cookie(&self, session_id: &str, secret: &str) -> HeaderValue {
        let cookie = format!(
            "{SESSION_COOKIE_NAME}={session_id}.{secret}; HttpOnly; SameSite=Lax; Path=/{}; Max-Age={}",
            self.secure_flag(),
            SESSION_COOKIE_MAX_AGE.as_secs()
        );
        HeaderValue::from_str(&cookie).expect("generated cookie contains only safe ASCII")
    }

    /// Cookie attribute that keeps cookies off plain HTTP when the deployment uses HTTPS.
    pub(crate) fn secure_flag(&self) -> &'static str {
        if self.cookie_secure { "; Secure" } else { "" }
    }

    /// Deletes only a syntactically valid session identifier, preventing path traversal via
    /// cookies. Holds the session file lock, so a renewal in flight cannot write it back.
    pub(crate) async fn delete_session_id(&self, session_id: &str) -> anyhow::Result<()> {
        let Some(path) = self.session_path(session_id) else {
            return Ok(());
        };
        let _guard = self.session_file_lock.lock().await;
        remove_session_file(&path).await
    }

    /// Removes sessions that no longer match the running config (a changed password, a
    /// removed user, OIDC turned off).
    async fn purge_stale_sessions(&self) -> anyhow::Result<()> {
        let logins = self.logins.current().await;
        let mut entries = tokio::fs::read_dir(&self.sessions_directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with("session_") || !name.ends_with(".json") {
                continue;
            }
            let Ok(contents) = tokio::fs::read(&path).await else {
                continue;
            };
            let Ok(session) = serde_json::from_slice::<SessionFile>(&contents) else {
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            };
            if !self.is_current(&session, &logins) {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        Ok(())
    }

    /// Verifies a `[[server.users]]` login name and password.
    ///
    /// A name that is no login at all is verified against a dummy hash, so the response time
    /// does not reveal which names exist.
    async fn verify_login(&self, name: &str, password: &str) -> LoginVerification {
        let password_user = self.logins.user(name).await;
        if let Some(user) = &password_user
            && verify_password_hash_off_thread(password, &user.hash).await
        {
            return LoginVerification::Authenticated(SessionGrant {
                user: SessionUser {
                    name: name.to_string(),
                    method: SessionMethod::Password,
                },
                fingerprint: user.fingerprint.clone(),
                authenticated_at: Some(jiff::Timestamp::now().as_second()),
            });
        }
        if password_user.is_none() {
            verify_password_hash_off_thread(password, &self.dummy_hash).await;
        }
        LoginVerification::Rejected
    }
}

/// Why a password change was refused.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PasswordChangeError {
    /// The session did not sign in with a `[[server.users]]` password, whose owner is
    /// redoor; OIDC passwords belong to the provider.
    #[error(
        "Only password logins from the config file can change their password here; change a system or identity provider password where it is managed"
    )]
    NotPasswordSession,
    /// The current password was wrong; counted like a failed login.
    #[error("The current password is incorrect")]
    WrongCurrentPassword,
    /// The new password does not meet the form's rules.
    #[error("{0}")]
    InvalidNewPassword(String),
    /// The config file is missing or broken, so the server runs on the last logins that
    /// loaded and a password written now would not apply.
    #[error(
        "The config file has an error, so a new password would not take effect; fix the file (see the server log) and try again"
    )]
    ConfigNotLoaded,
    /// The user's login was removed from the config file while the change was running.
    #[error(transparent)]
    CredentialsChanged(ServerPasswordEditError),
    /// Hashing, writing the file or creating the new session failed.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AuthState {
    /// Replaces the password of the signed-in `user` with `new_password`, writes its
    /// Argon2id hash into that user's entry in `config_path` and signs out that user's other
    /// password sessions. Other users' sessions are not affected.
    ///
    /// The file is written before the in-memory verifier changes, so a failed write leaves
    /// the old password working everywhere, and the hash in memory is the one in the file,
    /// so sessions created now survive the next restart. Returns a new session for the
    /// browser that made the change, because the purge also removed its old one; it keeps
    /// that browser's session length, so a short session does not turn into a long one.
    pub(crate) async fn change_password(
        &self,
        config_path: &std::path::Path,
        user: &SessionUser,
        length: SessionLength,
        client: SessionClient,
        current_password: &str,
        new_password: &str,
    ) -> Result<NewSession, PasswordChangeError> {
        if user.method != SessionMethod::Password {
            return Err(PasswordChangeError::NotPasswordSession);
        }
        let _change = self.password_change_lock.lock().await;
        // Read from the file as it is now, so the current password is checked against a hand
        // edit too, and a user removed by hand cannot change a password they no longer have.
        let snapshot = self.logins.snapshot().await;
        // A password written into a file that does not load would not apply: the old one
        // would keep working and this browser's new session would fail its next check.
        if !snapshot.loaded {
            return Err(PasswordChangeError::ConfigNotLoaded);
        }
        let Some(verifier) = snapshot.logins.get(&user.name).cloned() else {
            return Err(PasswordChangeError::CredentialsChanged(
                ServerPasswordEditError::CredentialsChanged(user.name.clone()),
            ));
        };
        validate_new_password(new_password)?;
        if !verify_password_hash_off_thread(current_password, &verifier.hash).await {
            return Err(PasswordChangeError::WrongCurrentPassword);
        }
        let new_password = zeroize::Zeroizing::new(new_password.to_string());
        // Argon2 is deliberately slow, so it runs off the async workers.
        let password_hash = redoor_core::logging::spawn_blocking_in_user_scope(move || {
            hash_password(&new_password)
        })
        .await
        .map_err(|error| anyhow::anyhow!("password hashing task failed: {error}"))??;
        redoor_core::config::set_server_password(config_path, &user.name, &password_hash)
            .await
            .map_err(|error| match error {
                ServerPasswordEditError::CredentialsChanged(_) => {
                    PasswordChangeError::CredentialsChanged(error)
                }
                ServerPasswordEditError::Io(error) => {
                    PasswordChangeError::Internal(error.context("Failed to write the config file"))
                }
            })?;
        // The same fingerprint the logins compute when they read the new hash from the file,
        // so the session issued below stays valid.
        let fingerprint = credentials_fingerprint(HASH_FINGERPRINT_DOMAIN, &password_hash);
        log!(
            Level::Info,
            "Changed the login password of user {}",
            user.name
        );
        // Old sessions are already refused by the fingerprint check on every request; the
        // purge only removes their files, so a failure must not report the change as failed.
        if let Err(error) = self.purge_stale_sessions().await {
            log_error!(error, "Failed to remove sessions after a password change");
        }
        self.issue_session(
            SessionGrant {
                user: user.clone(),
                fingerprint,
                // The current password was just checked.
                authenticated_at: Some(jiff::Timestamp::now().as_second()),
            },
            length,
            client,
        )
        .await
        .map_err(|error| {
            PasswordChangeError::Internal(
                error.context("The password was changed, but signing this browser in again failed"),
            )
        })
    }
}

/// Applies the change form's rules to a new password.
fn validate_new_password(password: &str) -> Result<(), PasswordChangeError> {
    if password.chars().count() < MIN_NEW_PASSWORD_CHARS {
        return Err(PasswordChangeError::InvalidNewPassword(format!(
            "The new password must be at least {MIN_NEW_PASSWORD_CHARS} characters long"
        )));
    }
    Ok(())
}

/// Hashes a password with argon2id so AuthState never retains recoverable plaintext.
fn hash_password(password: &str) -> anyhow::Result<String> {
    // 16 bytes is the PHC-recommended salt length; the OS CSPRNG keeps salts unpredictable.
    let mut salt_bytes = [0_u8; 16];
    getrandom::fill(&mut salt_bytes)
        .map_err(|error| anyhow::anyhow!("failed to read OS randomness: {error}"))?;
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|error| anyhow::anyhow!("failed to encode password salt: {error}"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| anyhow::anyhow!("failed to hash password: {error}"))
}

/// Constant-time password verification against a stored PHC string. Blocking: Argon2 is
/// deliberately slow, so async callers use [`verify_password_hash_off_thread`].
fn verify_password_hash(candidate: &str, password_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(password_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(candidate.as_bytes(), &parsed)
        .is_ok()
}

/// [`verify_password_hash`] on the blocking pool, keeping the user scope for its log lines.
async fn verify_password_hash_off_thread(candidate: &str, password_hash: &str) -> bool {
    let candidate = zeroize::Zeroizing::new(candidate.to_string());
    let password_hash = password_hash.to_string();
    match redoor_core::logging::spawn_blocking_in_user_scope(move || {
        verify_password_hash(&candidate, &password_hash)
    })
    .await
    {
        Ok(valid) => valid,
        Err(error) => {
            log_error!(
                anyhow::Error::new(error),
                "Password verification task failed"
            );
            false
        }
    }
}

/// Fingerprint domain of plaintext config passwords. Unchanged since sessions were
/// introduced, so upgrades do not sign anyone out.
const PLAINTEXT_FINGERPRINT_DOMAIN: &[u8] = b"redoor-session-v1:";
/// Fingerprint domain of Argon2 hashes from the config, kept apart so a plaintext password
/// can never fingerprint like a hash string.
const HASH_FINGERPRINT_DOMAIN: &[u8] = b"redoor-session-v1-argon2:";
/// Builds a stable fingerprint so rotating the config password invalidates existing cookies.
fn credentials_fingerprint(domain: &[u8], secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(secret.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Digest of the OIDC settings that decide who may sign in. The client secret is left out on
/// purpose: rotating it does not change who is allowed, so it should not sign everyone out.
fn oidc_fingerprint(config: &OidcConfig) -> String {
    let mut groups = config.allowed_groups.clone().unwrap_or_default();
    groups.sort();
    let mut hasher = Sha256::new();
    // A separate domain for "no restriction", so adding or removing `allowed_groups` signs
    // out OIDC sessions, and no group list can hash like the unrestricted setting.
    hasher.update(match config.allowed_groups {
        Some(_) => b"redoor-oidc-session-v1:".as_slice(),
        None => b"redoor-oidc-session-v1-any-group:".as_slice(),
    });
    for part in [config.issuer.as_str(), config.client_id.as_str()]
        .into_iter()
        .chain(groups.iter().map(String::as_str))
    {
        // Length prefixes keep different field splits from hashing to the same input.
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A freshly created session: who signed in and the cookie that carries it.
pub(crate) struct NewSession {
    pub(crate) user: SessionUser,
    pub(crate) cookie: HeaderValue,
}

/// Removes a session file; one that is already gone counts as removed.
async fn remove_session_file(path: &std::path::Path) -> anyhow::Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Whether a response already sets the session cookie, such as the new session of a password
/// change or logout's clearing cookie. The access layer then leaves out its recovery cookie,
/// because a stale secret arriving after either would sign the browser out.
pub(crate) fn sets_session_cookie(headers: &HeaderMap) -> bool {
    let prefix = format!("{SESSION_COOKIE_NAME}=");
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.starts_with(&prefix))
}

/// Reads and parses a session file; `None` when it is missing or unreadable, which every
/// caller treats as no session.
async fn read_session_file(path: &std::path::Path) -> Option<SessionFile> {
    let contents = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&contents).ok()
}

/// Keeps a browser session open while one upload or download of it runs.
///
/// Held by the response body of a transfer route, so it lives as long as the bytes flow,
/// not just as long as the handler. On drop it renews the session (the transfer was the
/// user's activity) before releasing the hold, so the session cannot expire in between.
pub(crate) struct SessionActivityGuard {
    auth: AuthState,
    session_id: String,
}

impl Drop for SessionActivityGuard {
    fn drop(&mut self) {
        let auth = self.auth.clone();
        let session_id = std::mem::take(&mut self.session_id);
        // Renewing writes a file, which needs the runtime; without one (shutdown) there is
        // nothing left to keep alive.
        if tokio::runtime::Handle::try_current().is_err() {
            auth.release_transfer(&session_id);
            return;
        }
        redoor_core::logging::spawn_in_user_scope(async move {
            if let Err(error) = auth
                .update(&session_id, SessionUpdate::TransferFinished)
                .await
            {
                log_error!(error, "Failed to renew the session after a transfer");
            }
            auth.release_transfer(&session_id);
        });
    }
}

/// Writes bytes with mode 0600 so local users cannot steal bearer session IDs from disk.
async fn write_private_file(path: &std::path::Path, contents: &[u8]) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(contents).await?;
    file.sync_all().await?;
    Ok(())
}

/// Ensures the sessions directory is owned by this process user and mode 0700.
#[cfg(unix)]
async fn ensure_private_directory(path: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    let metadata = tokio::fs::metadata(path).await?;
    let mode = metadata.mode() & 0o777;
    if mode != 0o700 {
        anyhow::bail!(
            "session directory '{}' must be mode 0700, found {:o}",
            path.display(),
            mode
        );
    }
    let uid = nix::unistd::Uid::current().as_raw();
    if metadata.uid() != uid {
        anyhow::bail!(
            "session directory '{}' must be owned by uid {}, found {}",
            path.display(),
            uid,
            metadata.uid()
        );
    }
    Ok(())
}

/// Verifies a login name and password and persists a new server-side login session.
pub(crate) async fn login_handler(
    State(state): State<ServerState>,
    client: ClientAddress,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Response {
    // The TCP peer, not the forwarded claim: a client could otherwise dodge the limit by
    // sending a fresh `X-Forwarded-For` with every guess.
    let client_ip = client.peer.ip();
    if state
        .auth
        .login_limiter
        .is_limited(client_ip, Instant::now())
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
                code: None,
                error: "Too many login attempts. Try again later.".to_string(),
            }),
        )
            .into_response();
    }

    let grant = match state
        .auth
        .verify_login(&request.username, &request.password)
        .await
    {
        LoginVerification::Authenticated(grant) => grant,
        LoginVerification::Rejected => {
            state
                .auth
                .login_limiter
                .record_failure(client_ip, Instant::now());
            // Debug-quoted, because the name is whatever the client sent.
            log!(
                Level::Info,
                "Failed login: name={:?}, address={client}",
                request.username
            );
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    code: None,
                    error: "Invalid username or password".to_string(),
                }),
            )
                .into_response();
        }
    };

    // A sign-in from a browser that is already signed in, such as the fresh sign-in before
    // creating an access token, replaces its session instead of leaving a stray one in the
    // session list. Not fatal: the old session still expires on its own.
    if let Err(error) = end_cookie_session(&state, &headers).await {
        log_error!(
            error,
            "Failed to end the previous session of a signing-in browser"
        );
    }
    let session = match state
        .auth
        .issue_session(
            grant,
            request.session_length,
            SessionClient::new(&client, &headers),
        )
        .await
    {
        Ok(session) => session,
        Err(error) => {
            // Keep IO/path details off the wire; operators still see them in server logs.
            log_error!(error, "Failed to create session");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    code: None,
                    error: "Failed to create session".to_string(),
                }),
            )
                .into_response();
        }
    };
    log!(
        Level::Info,
        "Signed in: user={}, address={client}",
        session.user.log_label()
    );

    let mut response = Json(LoginResponse {
        username: session.user.name,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session.cookie);
    response
}

/// Removes the durable session first (see [`end_cookie_session`]), then expires the browser
/// cookie even when no file remains.
pub(crate) async fn logout_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = end_cookie_session(&state, &headers).await {
        log_error!(error, "Failed to delete session");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                code: None,
                error: "Failed to delete session".to_string(),
            }),
        )
            .into_response();
    }

    let secure_flag = state.auth.secure_flag();
    let mut response = Json(LogoutResponse { logged_out: true }).into_response();
    let cookie =
        format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/{secure_flag}; Max-Age=0");
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("generated cookie contains only safe ASCII"),
    );
    response
}

/// Ends the session named by the request's cookie, if any: logout, and a sign-in from a
/// browser that already has a session.
///
/// The session's vault device secrets go first of all, so an end the page could not finish
/// (a closed tab, a failed lock) still locks the vault in that browser. The cookie's secret
/// is not checked for reuse: a stale one only signs out a session its holder already had,
/// and the rare case is not worth a second detection path.
pub(crate) async fn end_cookie_session(
    state: &ServerState,
    headers: &HeaderMap,
) -> anyhow::Result<()> {
    let Some(cookie) = SessionCookie::from_headers(headers) else {
        return Ok(());
    };
    state.vault_devices.delete_session(&cookie.id);
    state.auth.delete_session_id(&cookie.id).await
}

/// Fixtures other modules' tests use to get a signed-in session without the HTTP layer.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{
        ActiveSession, AuthState, LoginVerification, SessionCheck, SessionClient, SessionLength,
    };
    use redoor_core::test_support::TempDir;

    /// A browser on the loopback address with the given `User-Agent`, for tests that issue
    /// sessions without the HTTP layer.
    pub(crate) fn test_client(user_agent: &str) -> SessionClient {
        SessionClient {
            user_agent: Some(user_agent.to_string()),
            ip: std::net::Ipv4Addr::LOCALHOST.into(),
            forwarded_for: None,
        }
    }

    /// An auth state with the password user `admin` and a one-hour session of it. The directory must outlive the auth state, so it is returned too.
    pub(crate) async fn signed_in_auth() -> (TempDir, AuthState, ActiveSession) {
        let directory = TempDir::create();
        let config = directory.path().join("config.toml");
        tokio::fs::write(
            &config,
            r#"agent_token = "t"
[server]
username = "admin"
password = "password"
"#,
        )
        .await
        .expect("write config");
        let auth = AuthState::new(config, None, "t".to_string(), false, directory.path())
            .await
            .expect("auth state must initialize");
        let LoginVerification::Authenticated(grant) = auth.verify_login("admin", "password").await
        else {
            panic!("admin must be able to sign in");
        };
        let session = auth
            .issue_session(grant, SessionLength::Hour, test_client("test"))
            .await
            .expect("session");
        let mut headers = axum::http::HeaderMap::new();
        let pair = session
            .cookie
            .to_str()
            .expect("ASCII")
            .split(';')
            .next()
            .expect("cookie pair")
            .to_string();
        headers.insert(axum::http::header::COOKIE, pair.parse().expect("cookie"));
        let SessionCheck::Valid(_, active, _) = auth.check_session(&headers).await else {
            panic!("a new session must be valid");
        };
        (directory, auth, active)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::test_client;
    use super::{
        ActiveSession, AuthState, CurrentSecret, FailureWindow, LOGIN_MAX_FAILURES_GLOBAL,
        LOGIN_MAX_FAILURES_PER_IP, LOGIN_MAX_TRACKED_IPS, LOGIN_RATE_WINDOW, LoginRateLimiter,
        LoginVerification, PasswordChangeError, PreviousSecret, ROTATION_GRACE, ROTATION_INTERVAL,
        SESSION_COOKIE_NAME, SecretState, SessionCheck, SessionClient, SessionCookie, SessionFile,
        SessionGrant, SessionLength, SessionMethod, SessionStatus, SessionUser, oidc_fingerprint,
        public_session_id, secret_hash, sets_session_cookie,
    };
    use axum::http::{HeaderMap, HeaderValue, header};
    use redoor_core::config::{ConfiguredPassword, ConfiguredUser, OidcConfig};
    use redoor_core::test_support::TempDir;
    use std::{
        net::{IpAddr, Ipv4Addr},
        time::{Duration, Instant},
    };

    /// A plaintext `[[server.users]]` entry.
    fn user(name: &str, password: &str) -> ConfiguredUser {
        ConfiguredUser {
            name: name.to_string(),
            password: ConfiguredPassword::Plaintext(password.to_string()),
        }
    }

    /// The config file of the auth state stored in `directory`.
    fn config_path(directory: &TempDir) -> std::path::PathBuf {
        directory.path().join("config.toml")
    }

    /// A config file body with the given logins as `[[server.users]]` entries.
    fn users_config(users: &[ConfiguredUser]) -> String {
        let mut config = r#"agent_token = "t"
"#
        .to_string();
        for user in users {
            // A TOML literal string: the test passwords and PHC strings contain no quotes.
            let (ConfiguredPassword::Plaintext(password)
            | ConfiguredPassword::Argon2Hash(password)) = &user.password;
            config.push_str(&format!(
                r#"[[server.users]]
name = "{}"
password = '{password}'
"#,
                user.name
            ));
        }
        config
    }

    /// Replaces the config file by rename, as editors and the password form do, so a check
    /// never reads it half-written.
    async fn write_config(directory: &TempDir, content: &str) {
        let temporary = directory.path().join("config.toml.tmp");
        tokio::fs::write(&temporary, content)
            .await
            .expect("write config");
        tokio::fs::rename(&temporary, config_path(directory))
            .await
            .expect("replace config");
    }

    /// Auth state started from the config file already in `directory`, as a restart would
    /// build it.
    async fn auth_from_file(directory: &TempDir, oidc: Option<&OidcConfig>) -> AuthState {
        AuthState::new(
            config_path(directory),
            oidc,
            "agent-token".to_string(),
            false,
            directory.path(),
        )
        .await
        .expect("auth state must initialize")
    }

    /// Auth state with the given logins written to the config file in `directory`, as a
    /// restart would build it.
    async fn auth_with(
        directory: &TempDir,
        users: Vec<ConfiguredUser>,
        oidc: Option<&OidcConfig>,
    ) -> AuthState {
        write_config(directory, &users_config(&users)).await;
        auth_from_file(directory, oidc).await
    }

    /// A password session of `name`, created through the real login check.
    async fn login(auth: &AuthState, name: &str, password: &str) -> HeaderMap {
        let LoginVerification::Authenticated(grant) = auth.verify_login(name, password).await
        else {
            panic!("{name} must be able to sign in");
        };
        session_headers(auth, grant).await
    }

    /// Issues a session for a checked credential and returns the cookie it set.
    async fn session_headers(auth: &AuthState, grant: SessionGrant) -> HeaderMap {
        cookie_headers(
            &auth
                .issue_session(grant, SessionLength::Week, test_client("test"))
                .await
                .expect("session")
                .cookie,
        )
    }

    /// The signed-in user of a session, or `None` when the session is not valid.
    async fn session_user(auth: &AuthState, headers: &HeaderMap) -> Option<SessionUser> {
        match auth.check_session(headers).await {
            SessionCheck::Invalid | SessionCheck::Reused(_) => None,
            SessionCheck::Valid(user, _, _) => Some(user),
        }
    }

    /// OIDC settings with the given allowed groups and a one-year sliding lifetime.
    fn oidc_config(groups: &[&str]) -> OidcConfig {
        OidcConfig {
            issuer: "https://id.example.org".to_string(),
            client_id: "redoor".to_string(),
            client_secret: "secret".to_string(),
            redirect_url: "https://redoor.example.org/api/v1/auth/oidc/callback"
                .parse()
                .expect("test URL must parse"),
            allowed_groups: Some(groups.iter().map(|group| group.to_string()).collect()),
            scopes: vec!["openid".to_string()],
            provider_name: "Example".to_string(),
            session_lifetime: Duration::from_secs(365 * 24 * 60 * 60),
        }
    }

    /// Auth state for a password user `admin`, optionally with OIDC, stored in `directory`.
    async fn auth_state(directory: &TempDir, oidc: Option<&OidcConfig>) -> AuthState {
        auth_with(directory, vec![user("admin", "password")], oidc).await
    }

    /// Request headers carrying the cookie from a `Set-Cookie` value.
    fn cookie_headers(set_cookie: &HeaderValue) -> HeaderMap {
        let pair = set_cookie
            .to_str()
            .expect("cookie is ASCII")
            .split(';')
            .next()
            .expect("cookie has a name-value pair")
            .to_string();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, pair.parse().expect("cookie header"));
        headers
    }

    /// The file of the session a cookie names.
    fn session_file_path(directory: &TempDir, headers: &HeaderMap) -> std::path::PathBuf {
        directory
            .path()
            .join("sessions")
            .join(format!("session_{}.json", session_id(headers)))
    }

    /// The stored session a cookie names.
    async fn stored_session(directory: &TempDir, headers: &HeaderMap) -> SessionFile {
        let path = session_file_path(directory, headers);
        serde_json::from_slice(&tokio::fs::read(&path).await.expect("session file"))
            .expect("session JSON")
    }

    /// Rewrites a stored session, standing in for the passage of time.
    async fn edit_session(
        directory: &TempDir,
        headers: &HeaderMap,
        edit: impl FnOnce(&mut SessionFile),
    ) {
        let mut session = stored_session(directory, headers).await;
        edit(&mut session);
        tokio::fs::write(
            session_file_path(directory, headers),
            serde_json::to_vec(&session).expect("JSON"),
        )
        .await
        .expect("rewrite session");
    }

    /// Rewrites a stored session's expiry, standing in for the passage of time.
    async fn set_expiry(directory: &TempDir, headers: &HeaderMap, expires_at: i64) {
        edit_session(directory, headers, |session| {
            session.expires_at = expires_at
        })
        .await;
    }

    /// The stable session id carried by request headers built from a cookie.
    fn session_id(headers: &HeaderMap) -> String {
        headers[header::COOKIE]
            .to_str()
            .expect("ASCII")
            .strip_prefix(&format!("{SESSION_COOKIE_NAME}="))
            .and_then(|value| value.split_once('.'))
            .expect("session cookie")
            .0
            .to_string()
    }

    /// The stored expiry of a session, as the activity endpoint and the UI see it.
    async fn stored_expiry(directory: &TempDir, headers: &HeaderMap) -> i64 {
        stored_session(directory, headers).await.expires_at
    }

    /// The session behind a cookie, as the access layer hands it to handlers.
    async fn active_session(auth: &AuthState, headers: &HeaderMap) -> ActiveSession {
        match auth.check_session(headers).await {
            SessionCheck::Valid(_, session, _) => session,
            _ => panic!("the session must be valid"),
        }
    }

    /// Makes the current secret old enough to rotate on the next activity or rotate call.
    async fn make_rotation_due(directory: &TempDir, headers: &HeaderMap) {
        edit_session(directory, headers, |session| {
            session.current.issued_at -= ROTATION_INTERVAL.as_secs() as i64;
        })
        .await;
    }

    /// Unix seconds now, on the clock the session files use.
    fn now() -> i64 {
        jiff::Timestamp::now().as_second()
    }

    /// A password session of `admin` with the given length, and the `Set-Cookie` value it
    /// was issued with.
    async fn password_session(auth: &AuthState, length: SessionLength) -> (HeaderMap, String) {
        let LoginVerification::Authenticated(grant) = auth.verify_login("admin", "password").await
        else {
            panic!("admin must be able to sign in");
        };
        let session = auth
            .issue_session(grant, length, test_client("test"))
            .await
            .expect("session must be created");
        let cookie = session.cookie.to_str().expect("ASCII").to_string();
        (cookie_headers(&session.cookie), cookie)
    }

    /// The chosen length decides the stored expiry, while every cookie gets the same
    /// `Max-Age`, so the browser never drops a cookie the server still accepts.
    #[tokio::test]
    async fn chosen_length_decides_lifetime_and_cookie() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        for length in [
            SessionLength::Hour,
            SessionLength::Day,
            SessionLength::Week,
            SessionLength::Month,
            SessionLength::Year,
        ] {
            let seconds = length.duration().as_secs();
            let now = jiff::Timestamp::now().as_second();
            let (headers, cookie) = password_session(&auth, length).await;
            // One fixed year for every length; the server enforces the idle expiry.
            assert!(
                cookie.ends_with("; Max-Age=31536000"),
                "{length:?}: {cookie}"
            );
            let remaining = stored_expiry(&directory, &headers).await - now;
            // The server ends the session that long after sign-in (allowing a slow test).
            assert!(
                (seconds as i64 - 5..=seconds as i64 + 5).contains(&remaining),
                "{length:?}: {remaining}"
            );
            // The request path knows the length, so a password change can reuse it.
            assert!(matches!(
                auth.check_session(&headers).await,
                SessionCheck::Valid(_, session, _) if session.length == length
            ));
        }
    }

    /// `session_lifetime_days` caps the length an OIDC sign-in may pick.
    #[tokio::test]
    async fn oidc_sessions_are_capped_by_the_configured_lifetime() {
        let directory = TempDir::create();
        let oidc = OidcConfig {
            session_lifetime: Duration::from_secs(30 * 24 * 60 * 60),
            ..oidc_config(&["admins"])
        };
        let auth = auth_state(&directory, Some(&oidc)).await;
        let now = jiff::Timestamp::now().as_second();
        let capped = auth
            .create_oidc_session(
                "alice".to_string(),
                SessionLength::Year,
                test_client("test"),
                None,
            )
            .await
            .expect("session");
        let remaining = stored_expiry(&directory, &cookie_headers(&capped.cookie)).await - now;
        // A year is longer than the configured 30 days, so the session lasts 30 days.
        assert!(
            (2_592_000 - 5..=2_592_000 + 5).contains(&remaining),
            "{remaining}"
        );
        let short = auth
            .create_oidc_session(
                "alice".to_string(),
                SessionLength::Day,
                test_client("test"),
                None,
            )
            .await
            .expect("session");
        let remaining = stored_expiry(&directory, &cookie_headers(&short.cookie)).await - now;
        // A shorter choice than the cap is kept.
        assert!(
            (86_400 - 5..=86_400 + 5).contains(&remaining),
            "{remaining}"
        );
    }

    /// Ordinary requests never extend a session; only reported activity does, and it does
    /// not revive a session that already expired.
    #[tokio::test]
    async fn only_activity_renews_and_never_revives() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (headers, _) = password_session(&auth, SessionLength::Hour).await;
        let now = jiff::Timestamp::now().as_second();
        set_expiry(&directory, &headers, now + 60).await;

        // Checking a session, as every request does, leaves its expiry alone.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(..)
        ));
        assert_eq!(stored_expiry(&directory, &headers).await, now + 60);

        let active = active_session(&auth, &headers).await;
        make_rotation_due(&directory, &headers).await;
        let renewed = auth
            .renew_session(&active)
            .await
            .expect("renewal")
            .expect("a valid session is renewed");
        // Activity moves the expiry a full lifetime ahead and says so.
        assert!(renewed.expires_at >= now + 3600);
        assert_eq!(
            stored_expiry(&directory, &headers).await,
            renewed.expires_at
        );
        let cookie = renewed.cookie.expect("due activity rotates the secret");
        // The rotated cookie restarts the browser cookie's fixed lifetime.
        assert!(
            cookie
                .to_str()
                .expect("ASCII")
                .ends_with("; Max-Age=31536000")
        );
        let headers = cookie_headers(&cookie);

        set_expiry(&directory, &headers, now - 1).await;
        // Activity reported after the expiry cannot bring the session back.
        assert!(
            auth.renew_session(&active)
                .await
                .expect("renewal")
                .is_none()
        );
        // And the request path refuses it.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Invalid
        ));
    }

    /// Activity within a minute of the last renewal does not rewrite the session file.
    #[tokio::test]
    async fn activity_renewals_are_throttled() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (headers, _) = password_session(&auth, SessionLength::Week).await;
        let id = active_session(&auth, &headers).await;
        let first = auth
            .renew_session(&id)
            .await
            .expect("renewal")
            .expect("valid");
        let marker = first.expires_at - 30;
        // Stands in for "renewed 30 seconds ago", so a write would be visible.
        set_expiry(&directory, &headers, marker).await;
        let second = auth
            .renew_session(&id)
            .await
            .expect("renewal")
            .expect("valid");
        // Less than a minute since the last renewal: the file is not written again.
        assert_eq!(stored_expiry(&directory, &headers).await, marker);
        assert_eq!(second.expires_at, marker);
        // A secret issued less than a minute ago is not rotated, so no cookie is sent.
        assert!(second.cookie.is_none());

        set_expiry(&directory, &headers, marker - 60).await;
        let third = auth
            .renew_session(&id)
            .await
            .expect("renewal")
            .expect("valid");
        // A minute or more since the last renewal: the expiry is written again.
        assert!(third.expires_at > marker);
        assert_eq!(stored_expiry(&directory, &headers).await, third.expires_at);
    }

    /// Session files from before the login page offered a length have no `length`; they are
    /// rejected and removed, so the upgrade signs those browsers out once.
    #[tokio::test]
    async fn session_files_without_a_length_are_rejected() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (headers, _) = password_session(&auth, SessionLength::Week).await;
        let path = session_file_path(&directory, &headers);
        let mut stored: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.expect("file")).expect("JSON");
        stored.as_object_mut().expect("object").remove("length");
        tokio::fs::write(&path, serde_json::to_vec(&stored).expect("JSON"))
            .await
            .expect("rewrite");
        // The old format no longer authenticates.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Invalid
        ));
        auth_state(&directory, None).await;
        // The startup purge deletes it rather than keeping a dead file around.
        assert!(!tokio::fs::try_exists(&path).await.expect("stat"));
    }

    /// A running transfer keeps its session open past the idle expiry, and finishing it
    /// renews the session for a full lifetime.
    #[tokio::test]
    async fn transfers_keep_the_session_alive() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (headers, _) = password_session(&auth, SessionLength::Hour).await;
        let session = active_session(&auth, &headers).await;
        let guard = auth.hold_for_transfer(&session);
        let now = jiff::Timestamp::now().as_second();
        set_expiry(&directory, &headers, now - 1).await;

        // The expiry passed during the transfer, but the transfer keeps the session open,
        // and the UI is told the session lasts at least a lifetime longer.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(_, session, _) if session.expires_at >= now + 3600
        ));

        drop(guard);
        // Dropping the guard renews in a task; wait until the hold is released, which
        // happens after the renewal was written.
        while auth.has_transfers(&session.id) {
            tokio::task::yield_now().await;
        }
        // The finished transfer counted as activity: the session lives on afterwards.
        assert!(stored_expiry(&directory, &headers).await > now);
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(..)
        ));
    }

    /// Changing who may sign in, or turning OIDC off, revokes the sessions OIDC created
    /// while leaving password sessions alone.
    #[tokio::test]
    async fn oidc_config_changes_revoke_oidc_sessions() {
        let directory = TempDir::create();
        let oidc = oidc_config(&["admins"]);
        let auth = auth_state(&directory, Some(&oidc)).await;
        let oidc_headers = cookie_headers(
            &auth
                .create_oidc_session(
                    "alice".to_string(),
                    SessionLength::Year,
                    test_client("test"),
                    None,
                )
                .await
                .expect("session")
                .cookie,
        );
        let password_headers = login(&auth, "admin", "password").await;

        let widened = oidc_config(&["admins", "family"]);
        let restarted = auth_state(&directory, Some(&widened)).await;
        // New group rules mean old OIDC grants no longer apply.
        assert!(matches!(
            restarted.check_session(&oidc_headers).await,
            SessionCheck::Invalid
        ));
        // Password sessions do not depend on the OIDC settings.
        assert!(matches!(
            restarted.check_session(&password_headers).await,
            SessionCheck::Valid(..)
        ));

        let oidc_headers = cookie_headers(
            &restarted
                .create_oidc_session(
                    "alice".to_string(),
                    SessionLength::Year,
                    test_client("test"),
                    None,
                )
                .await
                .expect("session")
                .cookie,
        );
        let without_oidc = auth_state(&directory, None).await;
        // Removing the OIDC section revokes every session it created.
        assert!(matches!(
            without_oidc.check_session(&oidc_headers).await,
            SessionCheck::Invalid
        ));
        // Without OIDC configured, no OIDC session can be created at all.
        assert!(
            without_oidc
                .create_oidc_session(
                    "alice".to_string(),
                    SessionLength::Year,
                    test_client("test"),
                    None,
                )
                .await
                .is_err()
        );
    }

    /// Lifting the group restriction changes who may sign in, so it gets a fingerprint no
    /// group list can produce and signs out sessions made under the restriction.
    #[test]
    fn unrestricted_oidc_has_its_own_fingerprint() {
        let unrestricted = OidcConfig {
            allowed_groups: None,
            ..oidc_config(&[])
        };
        // An empty group list cannot pass validation, but must still not collide.
        assert_ne!(
            oidc_fingerprint(&unrestricted),
            oidc_fingerprint(&oidc_config(&[]))
        );
        // Dropping `allowed_groups` from a restricted config revokes its OIDC sessions.
        assert_ne!(
            oidc_fingerprint(&unrestricted),
            oidc_fingerprint(&oidc_config(&["admins"]))
        );
    }

    /// Session files written before OIDC support have no method and stay valid.
    #[tokio::test]
    async fn legacy_session_files_remain_password_sessions() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let headers = login(&auth, "admin", "password").await;
        let path = session_file_path(&directory, &headers);
        let mut stored: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.expect("file")).expect("JSON");
        stored.as_object_mut().expect("object").remove("method");
        tokio::fs::write(&path, serde_json::to_vec(&stored).expect("JSON"))
            .await
            .expect("rewrite");
        // Upgrading the server must not sign out existing browsers.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(..)
        ));
    }

    /// A config file with the given `[server]` shorthand credentials and the auth state
    /// started from it.
    async fn configured_auth(
        directory: &TempDir,
        password: ConfiguredPassword,
    ) -> (std::path::PathBuf, AuthState) {
        // A TOML literal string: the test passwords and PHC strings contain no quotes.
        let (ConfiguredPassword::Plaintext(stored) | ConfiguredPassword::Argon2Hash(stored)) =
            &password;
        write_config(
            directory,
            &format!(
                r#"agent_token = "t"
[server]
username = "admin"
password = '{stored}'
"#
            ),
        )
        .await;
        (
            config_path(directory),
            auth_from_file(directory, None).await,
        )
    }

    /// Reads `[server].password` back from the config file.
    async fn stored_password(config_path: &std::path::Path) -> String {
        let content = tokio::fs::read_to_string(config_path)
            .await
            .expect("config");
        // The editor writes a basic string, and a PHC string needs no escapes inside it.
        content
            .lines()
            .find_map(|line| line.strip_prefix("password = \""))
            .and_then(|rest| rest.strip_suffix('"'))
            .expect("password line")
            .to_string()
    }

    /// A password change writes an Argon2id hash, takes effect at once, signs out other
    /// password sessions and keeps the changing browser signed in, also across a restart.
    #[tokio::test]
    async fn password_change_rehashes_and_signs_out_other_sessions() {
        let directory = TempDir::create();
        let (config_path, auth) = configured_auth(
            &directory,
            ConfiguredPassword::Plaintext("old-password".into()),
        )
        .await;
        let other = login(&auth, "admin", "old-password").await;

        let session = auth
            .change_password(
                &config_path,
                &admin(),
                SessionLength::Week,
                test_client("test"),
                "old-password",
                "new-password",
            )
            .await
            .expect("the change must succeed");

        // The new session keeps the length the changing browser signed in with, and counts
        // as a fresh sign-in, because the current password was just checked.
        assert!(matches!(
            auth.check_session(&cookie_headers(&session.cookie)).await,
            SessionCheck::Valid(_, renewed, _)
                if renewed.length == SessionLength::Week
                    && renewed.fresh_login_seconds_left(now()) > 0
        ));
        let stored = stored_password(&config_path).await;
        // The file never gets the plaintext; it gets a hash the config parser accepts.
        assert!(stored.starts_with("$argon2id$"), "{stored}");
        assert_eq!(
            ConfiguredPassword::parse(stored.clone(), "server.password").expect("valid hash"),
            ConfiguredPassword::Argon2Hash(stored.clone())
        );
        // The new password works at once and the old one no longer does.
        assert!(matches!(
            auth.verify_login("admin", "new-password").await,
            LoginVerification::Authenticated(_)
        ));
        assert!(matches!(
            auth.verify_login("admin", "old-password").await,
            LoginVerification::Rejected
        ));
        // Other browsers signed in with the old password are signed out.
        assert!(matches!(
            auth.check_session(&other).await,
            SessionCheck::Invalid
        ));
        let current = cookie_headers(&session.cookie);
        // The browser that made the change gets a working session.
        assert!(matches!(
            auth.check_session(&current).await,
            SessionCheck::Valid(..)
        ));

        let (_, restarted) =
            configured_auth(&directory, ConfiguredPassword::Argon2Hash(stored)).await;
        // Reading the hash from the file at startup gives the same fingerprint, so the
        // session survives a restart.
        assert!(matches!(
            restarted.check_session(&current).await,
            SessionCheck::Valid(..)
        ));
        // And the hash from the file verifies the new password.
        assert!(matches!(
            restarted.verify_login("admin", "new-password").await,
            LoginVerification::Authenticated(_)
        ));
    }

    /// A wrong current password or a too short new one changes nothing.
    #[tokio::test]
    async fn password_change_requires_the_current_password() {
        let directory = TempDir::create();
        let (config_path, auth) = configured_auth(
            &directory,
            ConfiguredPassword::Plaintext("old-password".into()),
        )
        .await;
        let before = tokio::fs::read_to_string(&config_path)
            .await
            .expect("config");

        let wrong = auth
            .change_password(
                &config_path,
                &admin(),
                SessionLength::Week,
                test_client("test"),
                "guess",
                "new-password",
            )
            .await
            .err();
        // A stolen session alone cannot set a new password.
        assert!(matches!(
            wrong,
            Some(PasswordChangeError::WrongCurrentPassword)
        ));
        let short = auth
            .change_password(
                &config_path,
                &admin(),
                SessionLength::Week,
                test_client("test"),
                "old-password",
                "short",
            )
            .await
            .err();
        // The form's minimum length is enforced by the server, not only by the UI.
        assert!(matches!(
            short,
            Some(PasswordChangeError::InvalidNewPassword(_))
        ));
        // Neither attempt touched the file or the working password.
        assert_eq!(
            tokio::fs::read_to_string(&config_path)
                .await
                .expect("config"),
            before
        );
        assert!(matches!(
            auth.verify_login("admin", "old-password").await,
            LoginVerification::Authenticated(_)
        ));
    }

    /// The signed-in password user `admin`, as the change form receives it.
    fn admin() -> SessionUser {
        SessionUser {
            name: "admin".to_string(),
            method: SessionMethod::Password,
        }
    }

    /// Only password sessions may change a password; OIDC passwords are managed by the
    /// provider.
    #[tokio::test]
    async fn password_change_needs_a_password_session() {
        let directory = TempDir::create();
        let (config_path, auth) = configured_auth(
            &directory,
            ConfiguredPassword::Plaintext("old-password".into()),
        )
        .await;
        let user = SessionUser {
            name: "admin".to_string(),
            method: SessionMethod::Oidc,
        };
        let error = auth
            .change_password(
                &config_path,
                &user,
                SessionLength::Week,
                test_client("test"),
                "old-password",
                "new-password",
            )
            .await
            .err();
        // Even with the right name and current password, the method decides.
        assert!(matches!(
            error,
            Some(PasswordChangeError::NotPasswordSession)
        ));
    }

    /// Several `[[server.users]]` sign in with their own passwords, and a wrong name or a
    /// wrong password fails.
    #[tokio::test]
    async fn each_listed_user_signs_in_with_their_own_password() {
        let directory = TempDir::create();
        let auth = auth_with(
            &directory,
            vec![user("alice", "alice-password"), user("bob", "bob-password")],
            None,
        )
        .await;
        for (name, password) in [("alice", "alice-password"), ("bob", "bob-password")] {
            // Each user's own password signs them in as themselves.
            assert!(matches!(
                auth.verify_login(name, password).await,
                LoginVerification::Authenticated(SessionGrant { user, .. })
                    if user.name == name && user.method == SessionMethod::Password
            ));
        }
        // Another user's password does not work.
        assert!(matches!(
            auth.verify_login("alice", "bob-password").await,
            LoginVerification::Rejected
        ));
        // Unknown names are rejected.
        assert!(matches!(
            auth.verify_login("carol", "alice-password").await,
            LoginVerification::Rejected
        ));
    }

    /// Sessions are revoked per user: removing one user signs out only that user.
    #[tokio::test]
    async fn sessions_are_revoked_per_user() {
        let directory = TempDir::create();
        let auth = auth_with(
            &directory,
            vec![user("alice", "alice-password"), user("bob", "bob-password")],
            None,
        )
        .await;
        let alice = login(&auth, "alice", "alice-password").await;
        let bob = login(&auth, "bob", "bob-password").await;
        // Each session knows who signed in and how.
        assert_eq!(
            session_user(&auth, &bob).await,
            Some(SessionUser {
                name: "bob".to_string(),
                method: SessionMethod::Password
            })
        );

        let without_bob = auth_with(&directory, vec![user("alice", "alice-password")], None).await;
        // Removing bob from the config revokes bob's session at the restart ...
        assert!(session_user(&without_bob, &bob).await.is_none());
        // ... and nobody else's.
        assert!(session_user(&without_bob, &alice).await.is_some());
    }

    /// Hand edits of the logins apply on the next request, without a restart: a changed
    /// password and a removed user sign out those sessions, and an added user can sign in.
    #[tokio::test]
    async fn hand_edited_logins_apply_without_a_restart() {
        let directory = TempDir::create();
        let auth = auth_with(
            &directory,
            vec![user("alice", "alice-password"), user("bob", "bob-password")],
            None,
        )
        .await;
        let alice = login(&auth, "alice", "alice-password").await;
        let bob = login(&auth, "bob", "bob-password").await;

        write_config(
            &directory,
            &users_config(&[
                user("alice", "alice-edited-password"),
                user("carol", "carol-password"),
            ]),
        )
        .await;
        // A password changed by hand signs out that user's sessions at once.
        assert!(session_user(&auth, &alice).await.is_none());
        // A user removed by hand is signed out at once.
        assert!(session_user(&auth, &bob).await.is_none());
        // The hand-edited password replaces the old one.
        assert!(matches!(
            auth.verify_login("alice", "alice-password").await,
            LoginVerification::Rejected
        ));
        assert!(matches!(
            auth.verify_login("alice", "alice-edited-password").await,
            LoginVerification::Authenticated(_)
        ));
        // A user added by hand can sign in at once.
        assert!(matches!(
            auth.verify_login("carol", "carol-password").await,
            LoginVerification::Authenticated(_)
        ));
    }

    /// A broken config file, such as a half-finished hand edit, keeps the last logins that
    /// parsed instead of signing everyone out, and the next valid save applies.
    #[tokio::test]
    async fn broken_config_keeps_the_last_good_logins() {
        let directory = TempDir::create();
        let auth = auth_with(&directory, vec![user("alice", "alice-password")], None).await;
        let alice = login(&auth, "alice", "alice-password").await;

        write_config(
            &directory,
            r#"agent_token = "t"
[[server.users]
"#,
        )
        .await;
        // The signed-in browser keeps working while the file does not parse.
        assert!(session_user(&auth, &alice).await.is_some());
        // So does signing in with the last good password.
        assert!(matches!(
            auth.verify_login("alice", "alice-password").await,
            LoginVerification::Authenticated(_)
        ));

        write_config(
            &directory,
            &users_config(&[user("alice", "alice-fixed-password")]),
        )
        .await;
        // Once the file is valid again, its logins apply.
        assert!(session_user(&auth, &alice).await.is_none());
        assert!(matches!(
            auth.verify_login("alice", "alice-fixed-password").await,
            LoginVerification::Authenticated(_)
        ));
    }

    /// Editing unrelated parts of the file keeps the verifiers of unchanged passwords, so a
    /// plaintext password is not hashed again on every save.
    #[tokio::test]
    async fn unrelated_edits_keep_existing_verifiers() {
        let directory = TempDir::create();
        let users = vec![user("alice", "alice-password")];
        let auth = auth_with(&directory, users.clone(), None).await;
        let before = auth.logins.user("alice").await.expect("alice").hash;

        write_config(
            &directory,
            &format!(
                "# an unrelated edit
{}",
                users_config(&users)
            ),
        )
        .await;
        let after = auth.logins.user("alice").await.expect("alice").hash;
        // Hashing again would use a new random salt, so an equal hash means it was reused.
        assert_eq!(before, after);
    }

    /// The change form checks the current password against the file as it is now, so it
    /// cannot silently overwrite a password changed by hand with one checked against the old.
    #[tokio::test]
    async fn password_change_checks_a_hand_edited_password() {
        let directory = TempDir::create();
        let (config_path, auth) = configured_auth(
            &directory,
            ConfiguredPassword::Plaintext("old-password".into()),
        )
        .await;
        write_config(
            &directory,
            r#"agent_token = "t"
[server]
username = "admin"
password = 'hand-edited-password'
"#,
        )
        .await;

        let stale = auth
            .change_password(
                &config_path,
                &admin(),
                SessionLength::Week,
                test_client("test"),
                "old-password",
                "new-password",
            )
            .await
            .err();
        // The password from before the hand edit no longer counts as current.
        assert!(matches!(
            stale,
            Some(PasswordChangeError::WrongCurrentPassword)
        ));
        auth.change_password(
            &config_path,
            &admin(),
            SessionLength::Week,
            test_client("test"),
            "hand-edited-password",
            "new-password",
        )
        .await
        .expect("the hand-edited password is the current one");
        // The change applies on top of the hand edit.
        assert!(matches!(
            auth.verify_login("admin", "new-password").await,
            LoginVerification::Authenticated(_)
        ));
    }

    /// While the config file does not load, the change form refuses instead of writing a
    /// password that would not apply until the file is fixed.
    #[tokio::test]
    async fn password_change_refuses_while_the_config_does_not_load() {
        let directory = TempDir::create();
        let (config_path, auth) = configured_auth(
            &directory,
            ConfiguredPassword::Plaintext("old-password".into()),
        )
        .await;
        // Valid TOML the editor could rewrite, but not a config the server can load.
        let broken = r#"agent_token = "t"
[server]
username = "admin"
password = 'old-password'
port = "not-a-port"
"#;
        write_config(&directory, broken).await;

        let error = auth
            .change_password(
                &config_path,
                &admin(),
                SessionLength::Week,
                test_client("test"),
                "old-password",
                "new-password",
            )
            .await
            .err();
        // The change is refused rather than reported as done while it cannot apply.
        assert!(matches!(error, Some(PasswordChangeError::ConfigNotLoaded)));
        // The file is left as the operator wrote it.
        assert_eq!(
            tokio::fs::read_to_string(&config_path)
                .await
                .expect("config"),
            broken
        );
        // The last good password keeps working.
        assert!(matches!(
            auth.verify_login("admin", "old-password").await,
            LoginVerification::Authenticated(_)
        ));
    }

    /// Changing one user's password signs out that user's other sessions and keeps every
    /// other user signed in.
    #[tokio::test]
    async fn password_change_signs_out_only_that_user() {
        let directory = TempDir::create();
        let config_path = config_path(&directory);
        let auth = auth_with(
            &directory,
            vec![user("alice", "alice-password"), user("bob", "bob-password")],
            None,
        )
        .await;
        let alice_elsewhere = login(&auth, "alice", "alice-password").await;
        let bob = login(&auth, "bob", "bob-password").await;
        let alice = SessionUser {
            name: "alice".to_string(),
            method: SessionMethod::Password,
        };

        auth.change_password(
            &config_path,
            &alice,
            SessionLength::Week,
            test_client("test"),
            "alice-password",
            "alice-new-password",
        )
        .await
        .expect("the change must succeed");
        // Alice's other browser is signed out.
        assert!(session_user(&auth, &alice_elsewhere).await.is_none());
        // Bob is not affected.
        assert!(session_user(&auth, &bob).await.is_some());
        // Only alice's entry changed in the file.
        let content = tokio::fs::read_to_string(&config_path).await.unwrap();
        assert!(content.contains("bob-password"), "{content}");
        assert!(!content.contains("alice-password"), "{content}");
    }

    /// Session files of the removed PAM login name a method that no longer exists, so they
    /// are not valid sessions even for a password user of the same name.
    #[tokio::test]
    async fn removed_pam_session_files_sign_in_again() {
        let directory = TempDir::create();
        let auth = auth_with(&directory, vec![user("admin", "password")], None).await;
        let headers = login(&auth, "admin", "password").await;
        let path = session_file_path(&directory, &headers);
        let mut stored: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        stored["method"] = "pam".into();
        tokio::fs::write(&path, serde_json::to_vec(&stored).unwrap())
            .await
            .unwrap();
        // A PAM session must not keep working after PAM login is gone.
        assert!(session_user(&auth, &headers).await.is_none());
    }

    /// Ensures failed-login state expires at the boundary without sleeps or resetting active bans.
    #[test]
    fn login_failures_expire_without_discarding_active_lockouts() {
        let limiter = LoginRateLimiter::new();
        let now = Instant::now();
        let expired_ip = IpAddr::from([192, 0, 2, 1]);
        let active_ip = IpAddr::from([192, 0, 2, 2]);
        for _ in 0..LOGIN_MAX_FAILURES_PER_IP {
            limiter.record_failure(expired_ip, now);
        }
        for _ in 0..LOGIN_MAX_FAILURES_PER_IP {
            limiter.record_failure(active_ip, now + LOGIN_RATE_WINDOW / 2);
        }
        let boundary = now + LOGIN_RATE_WINDOW;
        // Exactly expired sources recover even while a different address still has an active ban.
        assert!(!limiter.is_limited(expired_ip, boundary));
        // Pruning unrelated expired sources must not weaken a still-active per-IP lockout.
        assert!(limiter.is_limited(active_ip, boundary));
        let by_ip = limiter
            .by_ip
            .lock()
            .expect("test limiter lock must succeed");
        // Checking a now-allowed address must not recreate an empty retained entry.
        assert_eq!(by_ip.len(), 1);
        drop(by_ip);
        limiter.record_failure(expired_ip, boundary);
        let by_ip = limiter
            .by_ip
            .lock()
            .expect("test limiter lock must succeed");
        // A new failure starts fresh instead of inheriting the previous window's ban.
        assert_eq!(by_ip[&expired_ip].failures, 1);
    }

    /// Prevents successful or globally throttled source churn from allocating empty entries.
    #[test]
    fn login_checks_do_not_retain_source_addresses() {
        let limiter = LoginRateLimiter::new();
        let now = Instant::now();
        let ip = IpAddr::from([192, 0, 2, 1]);
        // An allowed check does not need tracking until credentials actually fail.
        assert!(!limiter.is_limited(ip, now));
        for _ in 0..LOGIN_MAX_FAILURES_GLOBAL {
            limiter.record_failure(ip, now);
        }
        let fresh_ip = IpAddr::from([192, 0, 2, 2]);
        // The process-wide limit applies to sources without their own failure history.
        assert!(limiter.is_limited(fresh_ip, now));
        // Rejected checks retain only the address that actually submitted invalid credentials.
        assert_eq!(
            limiter.by_ip.lock().expect("test lock must succeed").len(),
            1
        );
        // The global throttle recovers at the same exact fixed-window boundary.
        assert!(!limiter.is_limited(fresh_ip, now + LOGIN_RATE_WINDOW));
        // Expiration removes the last stale source instead of retaining it for process lifetime.
        assert!(
            limiter
                .by_ip
                .lock()
                .expect("test lock must succeed")
                .is_empty()
        );
    }

    /// Covers capacity independently of the earlier global limit, including in-flight failures.
    #[test]
    fn login_tracking_capacity_preserves_lockouts_and_global_accounting() {
        let limiter = LoginRateLimiter::new();
        let now = Instant::now();
        let locked_ip = IpAddr::from([192, 0, 2, 1]);
        {
            let mut by_ip = limiter.by_ip.lock().expect("test lock must succeed");
            for address in 0..LOGIN_MAX_TRACKED_IPS {
                by_ip.insert(
                    IpAddr::from(Ipv4Addr::from(address as u32)),
                    FailureWindow::new(now),
                );
            }
            by_ip.remove(&IpAddr::from(Ipv4Addr::from(0u32)));
            by_ip.insert(
                locked_ip,
                FailureWindow {
                    started_at: now,
                    failures: LOGIN_MAX_FAILURES_PER_IP,
                },
            );
        }
        let fresh_ip = IpAddr::from([192, 0, 2, 2]);
        // Unknown addresses wait for expiration rather than displacing an active lockout.
        assert!(limiter.is_limited(fresh_ip, now));
        // Existing low-failure addresses still use the normal throttle policy at capacity.
        assert!(!limiter.is_limited(IpAddr::from(Ipv4Addr::from(1u32)), now));
        limiter.record_failure(fresh_ip, now);
        // An in-flight verification cannot grow the table after other requests fill it.
        assert_eq!(
            limiter.by_ip.lock().expect("test lock must succeed").len(),
            LOGIN_MAX_TRACKED_IPS
        );
        // Every failed verification contributes to global brute-force protection, even at capacity.
        assert_eq!(
            limiter
                .global
                .lock()
                .expect("test lock must succeed")
                .failures,
            1
        );
        // Source churn must never erase a tracked address's active lockout.
        assert!(limiter.is_limited(locked_ip, now));
        // Expiration makes admission possible again without permanent capacity rejection.
        assert!(!limiter.is_limited(fresh_ip, now + LOGIN_RATE_WINDOW));
        limiter
            .by_ip
            .lock()
            .expect("test lock must succeed")
            .insert(locked_ip, FailureWindow::new(now));
        limiter.record_failure(fresh_ip, now + LOGIN_RATE_WINDOW);
        // Failure recording also prunes stale entries without requiring a preceding login check.
        assert_eq!(
            limiter.by_ip.lock().expect("test lock must succeed").len(),
            1
        );
    }

    /// Issues a password session of `admin` from a browser with the given `User-Agent`.
    async fn browser_session(auth: &AuthState, user_agent: &str) -> HeaderMap {
        let LoginVerification::Authenticated(grant) = auth.verify_login("admin", "password").await
        else {
            panic!("admin must be able to sign in");
        };
        cookie_headers(
            &auth
                .issue_session(grant, SessionLength::Day, test_client(user_agent))
                .await
                .expect("session")
                .cookie,
        )
    }

    /// The session list shows every signed-in browser with what it signed in from, names
    /// each by a digest instead of its cookie, and leaves out sessions that ended.
    #[tokio::test]
    async fn session_list_shows_signed_in_browsers() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let laptop = browser_session(&auth, "Laptop").await;
        let phone = browser_session(&auth, "Phone").await;

        let sessions = auth.list_sessions().await.expect("list");
        let mut agents: Vec<_> = sessions
            .iter()
            .map(|session| session.client.user_agent.clone().unwrap_or_default())
            .collect();
        agents.sort();
        // Both browsers are listed with the user agent they signed in with.
        assert_eq!(agents, ["Laptop", "Phone"]);
        for session in &sessions {
            // The public id is a digest, never the cookie value itself.
            assert_ne!(session.public_id, session.id);
            assert_eq!(session.public_id, public_session_id(&session.id));
            // The sign-in address is recorded for the user to recognise the browser.
            assert_eq!(session.client.ip, IpAddr::from(Ipv4Addr::LOCALHOST));
            // The list names who signed in and how.
            assert_eq!(session.user.name, "admin");
        }

        set_expiry(&directory, &phone, jiff::Timestamp::now().as_second() - 1).await;
        let sessions = auth.list_sessions().await.expect("list");
        // An expired session would not be let in, so it is not listed either.
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session_id(&laptop));
    }

    /// Signing out other sessions keeps the caller's own, and a single session can be
    /// signed out by its public id.
    #[tokio::test]
    async fn sessions_are_signed_out_one_by_one_or_all_others() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let own = browser_session(&auth, "Own").await;
        let first = browser_session(&auth, "First").await;
        let second = browser_session(&auth, "Second").await;

        let target = public_session_id(&session_id(&first));
        let signed_out = auth
            .sign_out_session(&target)
            .await
            .expect("sign out")
            .expect("the session is listed");
        // The returned session is the one named by the public id.
        assert_eq!(signed_out.id, session_id(&first));
        // The signed-out browser is no longer let in.
        assert!(session_user(&auth, &first).await.is_none());
        // Signing out an id that is no longer listed reports that nothing matched.
        assert!(
            auth.sign_out_session(&target)
                .await
                .expect("sign out")
                .is_none()
        );

        let others = auth
            .sign_out_other_sessions(&session_id(&own))
            .await
            .expect("sign out others");
        // Only the remaining other browser was signed out.
        assert_eq!(others.len(), 1);
        assert!(session_user(&auth, &second).await.is_none());
        // The caller keeps working.
        assert!(session_user(&auth, &own).await.is_some());
    }

    /// A session file with a current secret `current` and, when given, a previous secret
    /// `previous` that was retired at `retired_at`, for the pure classification table.
    fn classified_file(previous: Option<(&str, i64)>, unconfirmed: Option<&str>) -> SessionFile {
        SessionFile {
            session_id: uuid::Uuid::new_v4().to_string(),
            username: "admin".to_string(),
            credentials_fingerprint: String::new(),
            expires_at: 0,
            method: SessionMethod::Password,
            length: SessionLength::Hour,
            created_at: 0,
            client: SessionClient {
                user_agent: None,
                ip: Ipv4Addr::LOCALHOST.into(),
                forwarded_for: None,
            },
            current: CurrentSecret {
                hash: secret_hash("current"),
                issued_at: 0,
                unconfirmed: unconfirmed.map(str::to_string),
            },
            previous: previous.map(|(secret, retired_at)| PreviousSecret {
                hash: secret_hash(secret),
                retired_at,
            }),
            authenticated_at: None,
        }
    }

    /// Every row of the classification table, at both sides of the grace boundary.
    #[test]
    fn presented_secrets_are_classified() {
        let grace = ROTATION_GRACE.as_secs() as i64;
        let retired_at = 1_000;
        let unconfirmed = classified_file(Some(("previous", retired_at)), Some("current"));
        let confirmed = classified_file(Some(("previous", retired_at)), None);
        let classify = |file: &SessionFile, secret: &str, after: i64| {
            file.classify(&secret_hash(secret), retired_at + after)
        };
        // The current secret is always accepted, whatever the clock says.
        assert_eq!(
            classify(&confirmed, "current", grace * 10),
            SecretState::Current
        );
        // Requests sent before the rotation response arrived are accepted, with or without
        // the new secret confirmed.
        assert_eq!(
            classify(&unconfirmed, "previous", grace - 1),
            SecretState::Grace
        );
        assert_eq!(
            classify(&confirmed, "previous", grace - 1),
            SecretState::Grace
        );
        // From the end of the grace period, an unconfirmed rotation counts as lost ...
        assert_eq!(
            classify(&unconfirmed, "previous", grace),
            SecretState::LostRotation
        );
        // ... while after the new secret was used, the old one proves a second browser.
        assert_eq!(classify(&confirmed, "previous", grace), SecretState::Reused);
        // A secret the session never had is reuse, at any time and without a previous one.
        assert_eq!(classify(&unconfirmed, "made-up", 0), SecretState::Reused);
        assert_eq!(
            classify(&classified_file(None, None), "made-up", 0),
            SecretState::Reused
        );
    }

    /// The cookie must be `<id>.<secret>`; the bare id of the old format and an empty secret
    /// are no session at all.
    #[test]
    fn session_cookies_need_an_id_and_a_secret() {
        let parse = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::COOKIE, value.parse().expect("cookie"));
            SessionCookie::from_headers(&headers).map(|cookie| (cookie.id, cookie.secret))
        };
        let id = "00000000-0000-4000-8000-000000000000";
        // The two parts are split at the first dot.
        assert_eq!(
            parse(&format!("other=1; redoor_session={id}.c2VjcmV0")),
            Some((id.to_string(), "c2VjcmV0".to_string()))
        );
        // Cookies from before rotation carry no secret and are refused.
        assert!(parse(&format!("redoor_session={id}")).is_none());
        assert!(parse(&format!("redoor_session={id}.")).is_none());
        // The id still has to be a UUID before it becomes a path.
        assert!(parse("redoor_session=../../etc.secret").is_none());
    }

    /// Activity rotates a due secret: the old one becomes `previous`, the new one stays
    /// unconfirmed until a request presents it, and the old one keeps working during the
    /// grace period without a new cookie.
    #[tokio::test]
    async fn rotation_keeps_the_previous_secret_until_confirmed() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (old, _) = password_session(&auth, SessionLength::Hour).await;
        let before = stored_session(&directory, &old).await;
        make_rotation_due(&directory, &old).await;

        let renewed = auth
            .renew_session(&active_session(&auth, &old).await)
            .await
            .expect("renewal")
            .expect("valid");
        let new = cookie_headers(&renewed.cookie.expect("a due secret rotates"));
        // The stable id stays, only the secret changes.
        assert_eq!(session_id(&new), session_id(&old));
        assert_ne!(new, old);
        let rotated = stored_session(&directory, &new).await;
        // The replaced secret is kept to recognise requests that were already in flight.
        assert_eq!(
            rotated
                .previous
                .as_ref()
                .map(|previous| previous.hash.as_str()),
            Some(before.current.hash.as_str())
        );
        // The new secret is kept in plaintext only until the browser confirms it.
        assert!(rotated.current.unconfirmed.is_some());

        // The old secret still works within the grace period, and gets no new cookie.
        assert!(matches!(
            auth.check_session(&old).await,
            SessionCheck::Valid(_, _, None)
        ));
        // Presenting the new secret confirms it ...
        assert!(matches!(
            auth.check_session(&new).await,
            SessionCheck::Valid(_, _, None)
        ));
        // ... which removes its plaintext from the disk.
        assert!(
            stored_session(&directory, &new)
                .await
                .current
                .unconfirmed
                .is_none()
        );
    }

    /// A browser that never received its rotation response gets the same current secret
    /// again, and both throttle clocks restart.
    #[tokio::test]
    async fn lost_rotations_resend_the_current_secret() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (old, _) = password_session(&auth, SessionLength::Hour).await;
        make_rotation_due(&directory, &old).await;
        let rotated = auth
            .rotate_session(&active_session(&auth, &old).await)
            .await
            .expect("rotation")
            .expect("valid")
            .cookie
            .expect("a due secret rotates");
        let long_ago = now() - 10 * ROTATION_INTERVAL.as_secs() as i64;
        edit_session(&directory, &old, |session| {
            session.current.issued_at = long_ago;
            if let Some(previous) = &mut session.previous {
                previous.retired_at = long_ago;
            }
        })
        .await;

        let SessionCheck::Valid(_, _, Some(recovery)) = auth.check_session(&old).await else {
            panic!("a lost rotation is repaired, not refused");
        };
        // The browser gets the very secret the lost response carried, so that response
        // arriving late installs the same cookie.
        assert_eq!(recovery, rotated);
        let stored = stored_session(&directory, &old).await;
        // Other requests still in flight with the old secret get a fresh grace period ...
        assert!(stored.previous.expect("previous").retired_at >= now() - 5);
        // ... and the rotation throttle restarts, so a second recovery response cannot
        // overwrite a newer rotation's cookie.
        assert!(stored.current.issued_at >= now() - 5);
        // The recovered secret works.
        assert!(matches!(
            auth.check_session(&cookie_headers(&recovery)).await,
            SessionCheck::Valid(..)
        ));
    }

    /// A stale secret after the grace period deletes the session, signing out both browsers.
    #[tokio::test]
    async fn reuse_deletes_the_session() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (old, _) = password_session(&auth, SessionLength::Hour).await;
        make_rotation_due(&directory, &old).await;
        let new = cookie_headers(
            &auth
                .renew_session(&active_session(&auth, &old).await)
                .await
                .expect("renewal")
                .expect("valid")
                .cookie
                .expect("a due secret rotates"),
        );
        // Using the new secret confirms it, as the UI's follow-up request does.
        assert!(matches!(
            auth.check_session(&new).await,
            SessionCheck::Valid(..)
        ));
        edit_session(&directory, &old, |session| {
            if let Some(previous) = &mut session.previous {
                previous.retired_at -= ROTATION_GRACE.as_secs() as i64;
            }
        })
        .await;

        let SessionCheck::Reused(reused) = auth.check_session(&old).await else {
            panic!("the stale secret must be refused as reuse");
        };
        // The detecting request knows how long ago the secret was rotated away, for the warning.
        assert!(reused.since_rotation >= Some(ROTATION_GRACE.as_secs() as i64));
        // The browser holding the current secret is signed out too.
        assert!(matches!(
            auth.check_session(&new).await,
            SessionCheck::Invalid
        ));
        // Websockets, which have no secret, see the session end as well.
        assert_eq!(
            auth.check_session_id(&session_id(&new)).await,
            SessionStatus::Ended
        );
        // Nothing of the session is kept on disk.
        assert!(
            !tokio::fs::try_exists(session_file_path(&directory, &new))
                .await
                .expect("stat")
        );
        // Activity cannot write the deleted session back.
        assert!(
            auth.rotate_session(&active_session_unchecked(&new))
                .await
                .expect("rotation")
                .is_none()
        );
    }

    /// The session behind a cookie without checking it, for calls that a deleted session
    /// must refuse on their own.
    fn active_session_unchecked(headers: &HeaderMap) -> ActiveSession {
        let cookie = SessionCookie::from_headers(headers).expect("session cookie");
        ActiveSession {
            id: cookie.id.clone(),
            length: SessionLength::Hour,
            expires_at: 0,
            presented: cookie.presented_hash(),
            authenticated_at: None,
        }
    }

    /// A valid id with a made-up secret proves someone once had a real cookie of the
    /// session, so it deletes the session at once.
    #[tokio::test]
    async fn made_up_secrets_revoke_the_session() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (headers, _) = password_session(&auth, SessionLength::Hour).await;
        let mut forged = HeaderMap::new();
        forged.insert(
            header::COOKIE,
            format!("{SESSION_COOKIE_NAME}={}.bWFkZS11cA", session_id(&headers))
                .parse()
                .expect("cookie"),
        );
        // The forged secret is refused as reuse, naming no rotation it was replaced by.
        assert!(matches!(
            auth.check_session(&forged).await,
            SessionCheck::Reused(super::ReusedSession {
                since_rotation: None,
                ..
            })
        ));
        // The real browser is signed out too.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Invalid
        ));
    }

    /// Rotating moves only the secret, never the expiry, and a finished transfer moves only
    /// the expiry, never the secret.
    #[tokio::test]
    async fn rotation_and_transfers_change_one_thing_each() {
        let directory = TempDir::create();
        let auth = auth_state(&directory, None).await;
        let (headers, _) = password_session(&auth, SessionLength::Hour).await;
        let aged = now() + 120;
        set_expiry(&directory, &headers, aged).await;
        make_rotation_due(&directory, &headers).await;
        let before = stored_session(&directory, &headers).await;

        let session = active_session(&auth, &headers).await;
        drop(auth.hold_for_transfer(&session));
        while auth.has_transfers(&session.id) {
            tokio::task::yield_now().await;
        }
        let after_transfer = stored_session(&directory, &headers).await;
        // The finished transfer renewed the session ...
        assert!(after_transfer.expires_at > aged);
        // ... but did not rotate, because no response is left to carry a new cookie.
        assert_eq!(after_transfer.current.hash, before.current.hash);

        let rotated = auth
            .rotate_session(&session)
            .await
            .expect("rotation")
            .expect("valid");
        // A transfer just before does not keep a due secret from rotating.
        assert!(rotated.cookie.is_some());
        // Rotating leaves the expiry where it was, so an idle tab cannot keep the session.
        assert_eq!(rotated.expires_at, after_transfer.expires_at);
        assert_eq!(
            stored_expiry(&directory, &headers).await,
            after_transfer.expires_at
        );
    }

    /// Only the session cookie counts as a handler setting its own session.
    #[test]
    fn recognises_responses_that_set_the_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("redoor_oidc_state=x; Max-Age=0"),
        );
        // Another cookie leaves room for the recovery cookie.
        assert!(!sets_session_cookie(&headers));
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("redoor_session=; Max-Age=0"),
        );
        // Logout's clearing cookie wins over a recovery cookie.
        assert!(sets_session_cookie(&headers));
    }

    /// A session with `authenticated_at`, for the pure freshness checks.
    fn authenticated(authenticated_at: Option<i64>) -> ActiveSession {
        ActiveSession {
            id: uuid::Uuid::new_v4().to_string(),
            length: SessionLength::Hour,
            expires_at: 0,
            presented: String::new(),
            authenticated_at,
        }
    }

    /// Token creation is open for a minute after the credentials were checked, and never for
    /// a session without a check or with one in the future.
    #[test]
    fn freshness_ends_after_a_minute() {
        let now = 1_800_000_000;
        // Right after the sign-in the whole minute is left.
        assert_eq!(authenticated(Some(now)).fresh_login_seconds_left(now), 60);
        // One second before the boundary the session is still fresh ...
        assert_eq!(
            authenticated(Some(now - 59)).fresh_login_seconds_left(now),
            1
        );
        // ... and at 60 s it has to sign in again.
        assert_eq!(
            authenticated(Some(now - 60)).fresh_login_seconds_left(now),
            0
        );
        // A plain OIDC sign-in never checked the credentials.
        assert_eq!(authenticated(None).fresh_login_seconds_left(now), 0);
        // A future time (a hand-edited file) must not stretch the window.
        assert_eq!(
            authenticated(Some(now + 30)).fresh_login_seconds_left(now),
            0
        );
    }

    /// Password logins are fresh at once; OIDC sessions only with a checked `auth_time`.
    #[tokio::test]
    async fn sign_ins_record_when_the_credentials_were_checked() {
        let directory = TempDir::create();
        let oidc = oidc_config(&["admins"]);
        let auth = auth_state(&directory, Some(&oidc)).await;
        let (headers, _) = password_session(&auth, SessionLength::Hour).await;
        // The password was just verified, so the session may create tokens.
        assert!(
            active_session(&auth, &headers)
                .await
                .fresh_login_seconds_left(now())
                > 0
        );
        let plain = auth
            .create_oidc_session(
                "alice".to_string(),
                SessionLength::Hour,
                test_client("test"),
                None,
            )
            .await
            .expect("session");
        // An OIDC sign-in without proof of a fresh authentication cannot create tokens.
        assert_eq!(
            active_session(&auth, &cookie_headers(&plain.cookie))
                .await
                .authenticated_at,
            None
        );
        let checked_at = now() - 5;
        let checked = auth
            .create_oidc_session(
                "alice".to_string(),
                SessionLength::Hour,
                test_client("test"),
                Some(checked_at),
            )
            .await
            .expect("session");
        // The provider's authentication time is what the window counts from.
        assert_eq!(
            active_session(&auth, &cookie_headers(&checked.cookie))
                .await
                .authenticated_at,
            Some(checked_at)
        );
    }
}
