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
use redoor_core::config::{OidcConfig, ServerPasswordEditError};
use redoor_core::{log, log_error};
use redoor_protocol::api::{
    ErrorResponse,
    auth::{LoginRequest, LoginResponse, LogoutResponse},
};
use redoor_protocol::wire::log::Level;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::client_address::ClientAddress;
use super::state::ServerState;
use password_logins::{Logins, PasswordLogins};

mod password_logins;

/// Cookie carrying the opaque browser session id.
const SESSION_COOKIE_NAME: &str = "redoor_session";
/// One week, so routine use does not require frequent re-login while stolen cookies expire.
const SESSION_LIFETIME: Duration = Duration::from_secs(60 * 60 * 24 * 7);
/// Upper bound on how often a sliding OIDC session file is rewritten, so busy UIs that send
/// many requests per second do not turn every request into a disk write.
const SESSION_RENEWAL_INTERVAL: Duration = Duration::from_secs(60 * 60 * 24);
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
}

/// How sessions created by OIDC sign-in are bound and how long they live.
#[derive(Clone)]
struct OidcSessionPolicy {
    /// Digest of the provider settings, so changing the issuer, client or allowed groups
    /// invalidates sessions that were granted under the old rules.
    fingerprint: String,
    /// Idle lifetime; every authenticated request slides the expiry forward.
    lifetime: Duration,
}

/// Which login created a session, because each kind is bound to its own part of the config
/// and revoked on its own.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionMethod {
    /// A `[[server.users]]` name and password; fixed lifetime, revoked when that user's
    /// password changes or the user is removed. The default keeps session files written
    /// before OIDC support valid.
    #[default]
    Password,
    /// OpenID Connect sign-in; sliding lifetime, revoked when the OIDC settings change.
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

/// Outcome of checking a request's session cookie.
pub(crate) enum SessionCheck {
    /// No usable session; the request must be treated as unauthenticated.
    Invalid,
    /// The session is valid and its cookie needs no update.
    Valid(SessionUser),
    /// The session is valid and its expiry slid forward, so the response must refresh the
    /// browser cookie's lifetime to match.
    Renewed(SessionUser, HeaderValue),
}

/// A successful credential check: who signed in and the fingerprint the new session is
/// bound to. The fingerprint is the one of the verifier that was checked, so a password
/// change finishing in between cannot hand a session made with the old password the new
/// fingerprint.
struct SessionGrant {
    user: SessionUser,
    fingerprint: String,
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
    /// source of truth.
    pub(crate) async fn check_session(&self, headers: &HeaderMap) -> SessionCheck {
        let Some(session_id) = session_cookie(headers) else {
            return SessionCheck::Invalid;
        };
        let Some(path) = self.session_path(&session_id) else {
            return SessionCheck::Invalid;
        };
        let Ok(contents) = tokio::fs::read(&path).await else {
            return SessionCheck::Invalid;
        };
        let Ok(mut session) = serde_json::from_slice::<SessionFile>(&contents) else {
            return SessionCheck::Invalid;
        };

        let now = jiff::Timestamp::now().as_second();
        let logins = self.logins.current().await;
        if session.session_id != session_id
            || !self.is_current(&session, &logins)
            || session.expires_at <= now
        {
            // Remove expired or credential-mismatched files so disk does not retain stealable IDs.
            let _ = tokio::fs::remove_file(path).await;
            return SessionCheck::Invalid;
        }
        let user = SessionUser {
            name: session.username.clone(),
            method: session.method,
        };

        let Some(policy) = self
            .oidc_sessions
            .as_ref()
            .filter(|_| session.method == SessionMethod::Oidc)
        else {
            return SessionCheck::Valid(user);
        };
        let lifetime = policy.lifetime.as_secs() as i64;
        let renewal_interval = SESSION_RENEWAL_INTERVAL.min(policy.lifetime / 2).as_secs() as i64;
        if session.expires_at - now > lifetime - renewal_interval {
            return SessionCheck::Valid(user);
        }
        session.expires_at = now + lifetime;
        let _guard = self.session_file_lock.lock().await;
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            // Logged out while this request was in flight; let this request finish but do not
            // bring the session back.
            return SessionCheck::Valid(user);
        }
        if let Err(error) = self.write_session(&session).await {
            // The session is still valid until its old expiry, so a failed renewal must not
            // log the user out; the next request simply tries again.
            log_error!(error, "Failed to renew session");
            return SessionCheck::Valid(user);
        }
        SessionCheck::Renewed(user, self.session_set_cookie(&session_id, policy.lifetime))
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
    /// user, recorded for display and logs only.
    pub(crate) async fn create_oidc_session(&self, name: String) -> anyhow::Result<NewSession> {
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
            },
            policy.lifetime,
        )
        .await
    }

    /// Writes a new session file for a checked credential and builds its cookie.
    async fn issue_session(
        &self,
        grant: SessionGrant,
        lifetime: Duration,
    ) -> anyhow::Result<NewSession> {
        let session = SessionFile {
            session_id: Uuid::new_v4().to_string(),
            username: grant.user.name.clone(),
            credentials_fingerprint: grant.fingerprint,
            expires_at: (jiff::Timestamp::now() + lifetime).as_second(),
            method: grant.user.method,
        };
        self.write_session(&session).await?;
        Ok(NewSession {
            cookie: self.session_set_cookie(&session.session_id, lifetime),
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

    /// Builds the `Set-Cookie` value for a session so every issuer uses the same attributes.
    fn session_set_cookie(&self, session_id: &str, lifetime: Duration) -> HeaderValue {
        let cookie = format!(
            "{SESSION_COOKIE_NAME}={session_id}; HttpOnly; SameSite=Lax; Path=/{}; Max-Age={}",
            self.secure_flag(),
            lifetime.as_secs()
        );
        HeaderValue::from_str(&cookie).expect("generated cookie contains only safe ASCII")
    }

    /// Cookie attribute that keeps cookies off plain HTTP when the deployment uses HTTPS.
    pub(crate) fn secure_flag(&self) -> &'static str {
        if self.cookie_secure { "; Secure" } else { "" }
    }

    /// Deletes only a syntactically valid session identifier, preventing path traversal via cookies.
    async fn delete_session(&self, headers: &HeaderMap) -> anyhow::Result<()> {
        let Some(session_id) = session_cookie(headers) else {
            return Ok(());
        };
        let Some(path) = self.session_path(&session_id) else {
            return Ok(());
        };
        let _guard = self.session_file_lock.lock().await;
        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
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
    /// browser that made the change, because the purge also removed its old one.
    pub(crate) async fn change_password(
        &self,
        config_path: &std::path::Path,
        user: &SessionUser,
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
            },
            SESSION_LIFETIME,
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

/// Extracts the opaque session identifier without accepting similarly named cookie prefixes.
fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(name, value)| (name == SESSION_COOKIE_NAME).then(|| value.to_string()))
}

/// Verifies a login name and password and persists a new server-side login session.
pub(crate) async fn login_handler(
    State(state): State<ServerState>,
    client: ClientAddress,
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

    let session = match state.auth.issue_session(grant, SESSION_LIFETIME).await {
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

/// Removes the durable session first, then expires the browser cookie even when no file remains.
pub(crate) async fn logout_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = state.auth.delete_session(&headers).await {
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

#[cfg(test)]
mod tests {
    use super::{
        AuthState, FailureWindow, LOGIN_MAX_FAILURES_GLOBAL, LOGIN_MAX_FAILURES_PER_IP,
        LOGIN_MAX_TRACKED_IPS, LOGIN_RATE_WINDOW, LoginRateLimiter, LoginVerification,
        PasswordChangeError, SESSION_COOKIE_NAME, SESSION_LIFETIME, SessionCheck, SessionFile,
        SessionGrant, SessionMethod, SessionUser, oidc_fingerprint,
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
                .issue_session(grant, SESSION_LIFETIME)
                .await
                .expect("session")
                .cookie,
        )
    }

    /// The signed-in user of a session, or `None` when the session is not valid.
    async fn session_user(auth: &AuthState, headers: &HeaderMap) -> Option<SessionUser> {
        match auth.check_session(headers).await {
            SessionCheck::Invalid => None,
            SessionCheck::Valid(user) | SessionCheck::Renewed(user, _) => Some(user),
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

    /// Rewrites a stored session's expiry, standing in for the passage of time.
    async fn set_expiry(directory: &TempDir, headers: &HeaderMap, expires_at: i64) {
        let value = headers[header::COOKIE].to_str().expect("ASCII");
        let session_id = value
            .strip_prefix(&format!("{SESSION_COOKIE_NAME}="))
            .expect("session cookie");
        let path = directory
            .path()
            .join("sessions")
            .join(format!("session_{session_id}.json"));
        let mut session: SessionFile =
            serde_json::from_slice(&tokio::fs::read(&path).await.expect("session file"))
                .expect("session JSON");
        session.expires_at = expires_at;
        tokio::fs::write(&path, serde_json::to_vec(&session).expect("JSON"))
            .await
            .expect("rewrite session");
    }

    /// OIDC sessions slide forward on use, at most once per renewal interval, and refresh
    /// the browser cookie when they do.
    #[tokio::test]
    async fn oidc_sessions_slide_and_refresh_the_cookie() {
        let directory = TempDir::create();
        let oidc = oidc_config(&["admins"]);
        let auth = auth_state(&directory, Some(&oidc)).await;
        let session = auth
            .create_oidc_session("alice".to_string())
            .await
            .expect("session must be created");
        // The browser cookie lasts as long as the configured sliding lifetime.
        assert!(
            session
                .cookie
                .to_str()
                .expect("ASCII")
                .contains("Max-Age=31536000")
        );
        let headers = cookie_headers(&session.cookie);
        // A brand-new session needs no renewal, so no disk write or cookie per request, and
        // it names the OIDC user.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(SessionUser { name, method: SessionMethod::Oidc }) if name == "alice"
        ));

        let now = jiff::Timestamp::now().as_second();
        set_expiry(&directory, &headers, now + 60).await;
        // A session close to expiry is extended and the cookie is re-issued.
        let SessionCheck::Renewed(_, cookie) = auth.check_session(&headers).await else {
            panic!("a used session close to expiry must be renewed");
        };
        assert!(cookie.to_str().expect("ASCII").contains("Max-Age=31536000"));
        // After renewal the stored expiry is a full lifetime away again.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(_)
        ));

        set_expiry(&directory, &headers, now - 1).await;
        // Sliding never revives a session that already expired.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Invalid
        ));
    }

    /// Password sessions keep their fixed lifetime even when OIDC is configured.
    #[tokio::test]
    async fn password_sessions_do_not_slide() {
        let directory = TempDir::create();
        let oidc = oidc_config(&["admins"]);
        let auth = auth_state(&directory, Some(&oidc)).await;
        let LoginVerification::Authenticated(grant) = auth.verify_login("admin", "password").await
        else {
            panic!("admin must be able to sign in");
        };
        let session = auth
            .issue_session(grant, SESSION_LIFETIME)
            .await
            .expect("session must be created");
        // Password sessions keep the existing one-week cookie.
        assert!(
            session
                .cookie
                .to_str()
                .expect("ASCII")
                .contains("Max-Age=604800")
        );
        let headers = cookie_headers(&session.cookie);
        set_expiry(
            &directory,
            &headers,
            jiff::Timestamp::now().as_second() + 60,
        )
        .await;
        // Use near expiry does not extend a password session.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(_)
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
                .create_oidc_session("alice".to_string())
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
            SessionCheck::Valid(_)
        ));

        let oidc_headers = cookie_headers(
            &restarted
                .create_oidc_session("alice".to_string())
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
                .create_oidc_session("alice".to_string())
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
        let value = headers[header::COOKIE].to_str().expect("ASCII");
        let session_id = value
            .strip_prefix(&format!("{SESSION_COOKIE_NAME}="))
            .expect("session cookie");
        let path = directory
            .path()
            .join("sessions")
            .join(format!("session_{session_id}.json"));
        let mut stored: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.expect("file")).expect("JSON");
        stored.as_object_mut().expect("object").remove("method");
        tokio::fs::write(&path, serde_json::to_vec(&stored).expect("JSON"))
            .await
            .expect("rewrite");
        // Upgrading the server must not sign out existing browsers.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid(_)
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
            .change_password(&config_path, &admin(), "old-password", "new-password")
            .await
            .expect("the change must succeed");

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
            SessionCheck::Valid(_)
        ));

        let (_, restarted) =
            configured_auth(&directory, ConfiguredPassword::Argon2Hash(stored)).await;
        // Reading the hash from the file at startup gives the same fingerprint, so the
        // session survives a restart.
        assert!(matches!(
            restarted.check_session(&current).await,
            SessionCheck::Valid(_)
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
            .change_password(&config_path, &admin(), "guess", "new-password")
            .await
            .err();
        // A stolen session alone cannot set a new password.
        assert!(matches!(
            wrong,
            Some(PasswordChangeError::WrongCurrentPassword)
        ));
        let short = auth
            .change_password(&config_path, &admin(), "old-password", "short")
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
            .change_password(&config_path, &user, "old-password", "new-password")
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
            .change_password(&config_path, &admin(), "old-password", "new-password")
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
            .change_password(&config_path, &admin(), "old-password", "new-password")
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

        auth.change_password(&config_path, &alice, "alice-password", "alice-new-password")
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
        let value = headers[header::COOKIE].to_str().expect("ASCII");
        let session_id = value
            .strip_prefix(&format!("{SESSION_COOKIE_NAME}="))
            .expect("session cookie");
        let path = directory
            .path()
            .join("sessions")
            .join(format!("session_{session_id}.json"));
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
}
