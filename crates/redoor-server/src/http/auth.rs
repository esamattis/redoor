//! Browser login, cookie sessions and login rate limiting.

use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use redoor_core::config::{AuthMode, OidcConfig};
use redoor_core::log_error;
use redoor_protocol::api::{
    ErrorResponse,
    auth::{LoginRequest, LoginResponse, LogoutResponse},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use super::state::ServerState;

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

/// How browser login passwords are verified after the username check succeeds.
#[derive(Clone)]
enum PasswordBackend {
    /// Argon2id PHC hash of a password stored in the TOML config.
    ConfiguredHash(String),
    /// Linux PAM against the OS account running the server process.
    #[cfg(target_os = "linux")]
    SystemPam(super::pam::PamApi),
}

/// Holds hashed credentials and the durable directory used to validate opaque cookies.
#[derive(Clone)]
pub(crate) struct AuthState {
    username: String,
    /// Either a config password hash or Linux PAM for the process owner.
    password_backend: PasswordBackend,
    /// Stable digest so password rotation (configured mode) invalidates old sessions.
    credentials_fingerprint: String,
    sessions_directory: PathBuf,
    /// When true, Set-Cookie includes `Secure` so browsers only send the session over HTTPS.
    cookie_secure: bool,
    /// Shared secret agents must present at registration to prevent unauthenticated hijacks.
    agent_token: String,
    login_limiter: std::sync::Arc<LoginRateLimiter>,
    /// Present when OIDC sign-in is configured; governs the sessions it creates.
    oidc_sessions: Option<OidcSessionPolicy>,
    /// Orders session renewals against logouts, so a renewal racing a logout cannot write
    /// the just-deleted session file back.
    session_file_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// Serializes PAM because blocking checks can otherwise exhaust Tokio's blocking pool.
    #[cfg(target_os = "linux")]
    pam_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
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

/// Which login created a session, because the two kinds expire and invalidate differently.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionMethod {
    /// Username and password; fixed lifetime, invalidated when the configured password changes.
    /// The default keeps session files written before OIDC support valid.
    #[default]
    Password,
    /// OpenID Connect sign-in; sliding lifetime, invalidated when the OIDC settings change.
    Oidc,
}

/// Outcome of checking a request's session cookie.
pub(crate) enum SessionCheck {
    /// No usable session; the request must be treated as unauthenticated.
    Invalid,
    /// The session is valid and its cookie needs no update.
    Valid,
    /// The session is valid and its expiry slid forward, so the response must refresh the
    /// browser cookie's lifetime to match.
    Renewed(HeaderValue),
}

/// Distinguishes rejected credentials from temporary PAM saturation for correct HTTP responses.
enum LoginVerification {
    /// Authentication succeeded, so the handler may create a session.
    Authenticated,
    /// Authentication failed, so the rate limiter must record the rejected attempt.
    Rejected,
    /// PAM is already running, so callers should retry without counting a credential failure.
    #[cfg(target_os = "linux")]
    Busy,
}

/// Tracks recent failed logins so online guessing cannot run unbounded.
struct LoginRateLimiter {
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
    fn is_limited(&self, ip: IpAddr, now: Instant) -> bool {
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
    fn record_failure(&self, ip: IpAddr, now: Instant) {
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
    username: String,
    /// Binds the cookie to the password that was current when the session was issued.
    credentials_fingerprint: String,
    expires_at: i64,
    #[serde(default)]
    method: SessionMethod,
}

impl AuthState {
    /// Creates the private session directory before requests arrive so login failures are actionable.
    pub(crate) async fn new(
        credentials: AuthMode,
        oidc: Option<&OidcConfig>,
        agent_token: String,
        cookie_secure: bool,
        data_dir: &std::path::Path,
    ) -> anyhow::Result<Self> {
        let (username, password_backend, credentials_fingerprint) = match credentials {
            AuthMode::Configured { username, password } => {
                let password_hash = hash_password(&password)?;
                // Fingerprint is independent of the per-process argon2 salt so sessions survive
                // restarts until the operator actually changes the configured password.
                let fingerprint = credentials_fingerprint(&password);
                // Drop the only plaintext copy once derived secrets exist.
                drop(password);
                (
                    username,
                    PasswordBackend::ConfiguredHash(password_hash),
                    fingerprint,
                )
            }
            #[cfg(target_os = "linux")]
            AuthMode::SystemAccount => {
                // Dynamic library loading and passwd lookups can block on filesystem or NSS work,
                // so validate the complete PAM backend away from Tokio's async worker threads.
                let (username, pam_api) = tokio::task::spawn_blocking(|| {
                    let pam_api = super::pam::PamApi::load()?;
                    let uid = nix::unistd::Uid::current();
                    let username = nix::unistd::User::from_uid(uid)
                        .map_err(|error| {
                            anyhow::anyhow!("failed to look up process user: {error}")
                        })?
                        .ok_or_else(|| anyhow::anyhow!("no system user for process UID {uid}"))?
                        .name;
                    Ok::<_, anyhow::Error>((username, pam_api))
                })
                .await
                .map_err(|error| {
                    anyhow::anyhow!("failed to join PAM authentication startup task: {error}")
                })??;
                // Fixed marker: OS password changes do not bulk-invalidate PAM sessions;
                // sessions still expire via SESSION_LIFETIME.
                let fingerprint = credentials_fingerprint("pam-system-auth-v1");
                (username, PasswordBackend::SystemPam(pam_api), fingerprint)
            }
        };

        // Keep independent application namespaces from sharing browser sessions on disk.
        let sessions_directory = data_dir.join("sessions");
        tokio::fs::create_dir_all(&sessions_directory).await?;

        #[cfg(unix)]
        {
            ensure_private_directory(&sessions_directory).await?;
        }

        let auth = Self {
            username,
            password_backend,
            credentials_fingerprint: credentials_fingerprint.clone(),
            sessions_directory: sessions_directory.clone(),
            cookie_secure,
            agent_token,
            login_limiter: std::sync::Arc::new(LoginRateLimiter::new()),
            oidc_sessions: oidc.map(|config| OidcSessionPolicy {
                fingerprint: oidc_fingerprint(config),
                lifetime: config.session_lifetime,
            }),
            session_file_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(target_os = "linux")]
            pam_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };

        // Drop sessions issued under a previous password so rotation takes effect immediately.
        auth.purge_stale_sessions().await?;

        Ok(auth)
    }

    /// Shared secret that agents must present when upgrading their websocket connection.
    pub(crate) fn agent_token(&self) -> &str {
        &self.agent_token
    }

    /// Identifies the single login account so per-user files can be stored without parsing cookies.
    pub(crate) fn username(&self) -> &str {
        &self.username
    }

    /// Maps a validated UUID to its one-file-per-session storage path.
    fn session_path(&self, session_id: &str) -> Option<PathBuf> {
        Uuid::parse_str(session_id).ok().map(|_| {
            self.sessions_directory
                .join(format!("session_{session_id}.json"))
        })
    }

    /// Reads the session file on every request so logout and server restarts share one source of truth.
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
        if session.session_id != session_id
            || !self.is_current(&session)
            || session.expires_at <= now
        {
            // Remove expired or credential-mismatched files so disk does not retain stealable IDs.
            let _ = tokio::fs::remove_file(path).await;
            return SessionCheck::Invalid;
        }

        let Some(policy) = self
            .oidc_sessions
            .as_ref()
            .filter(|_| session.method == SessionMethod::Oidc)
        else {
            return SessionCheck::Valid;
        };
        let lifetime = policy.lifetime.as_secs() as i64;
        let renewal_interval = SESSION_RENEWAL_INTERVAL.min(policy.lifetime / 2).as_secs() as i64;
        if session.expires_at - now > lifetime - renewal_interval {
            return SessionCheck::Valid;
        }
        session.expires_at = now + lifetime;
        let _guard = self.session_file_lock.lock().await;
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            // Logged out while this request was in flight; let this request finish but do not
            // bring the session back.
            return SessionCheck::Valid;
        }
        if let Err(error) = self.write_session(&session).await {
            // The session is still valid until its old expiry, so a failed renewal must not
            // log the user out; the next request simply tries again.
            log_error!(error, "Failed to renew session");
            return SessionCheck::Valid;
        }
        SessionCheck::Renewed(self.session_set_cookie(&session_id, policy.lifetime))
    }

    /// Whether a stored session still matches the account and the login rules that issued it.
    fn is_current(&self, session: &SessionFile) -> bool {
        if session.username != self.username {
            return false;
        }
        match session.method {
            SessionMethod::Password => {
                session.credentials_fingerprint == self.credentials_fingerprint
            }
            // Removing the OIDC config revokes every session it created.
            SessionMethod::Oidc => self
                .oidc_sessions
                .as_ref()
                .is_some_and(|policy| session.credentials_fingerprint == policy.fingerprint),
        }
    }

    /// Creates a session for the single configured account, recording how the user signed in.
    pub(crate) async fn create_session(&self, method: SessionMethod) -> anyhow::Result<NewSession> {
        let (fingerprint, lifetime) = match (method, &self.oidc_sessions) {
            (SessionMethod::Password, _) => {
                (self.credentials_fingerprint.clone(), SESSION_LIFETIME)
            }
            (SessionMethod::Oidc, Some(policy)) => (policy.fingerprint.clone(), policy.lifetime),
            (SessionMethod::Oidc, None) => anyhow::bail!("OIDC sign-in is not configured"),
        };
        let session = SessionFile {
            session_id: Uuid::new_v4().to_string(),
            username: self.username.clone(),
            credentials_fingerprint: fingerprint,
            expires_at: (jiff::Timestamp::now() + lifetime).as_second(),
            method,
        };
        self.write_session(&session).await?;
        Ok(NewSession {
            cookie: self.session_set_cookie(&session.session_id, lifetime),
            username: session.username,
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

    /// Removes sessions that no longer match the configured credentials (e.g. after password rotation).
    async fn purge_stale_sessions(&self) -> anyhow::Result<()> {
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
            if !self.is_current(&session) {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        Ok(())
    }

    /// Verifies username + password against the configured backend.
    ///
    /// Always verifies configured password hashes on username mismatch so timing does not
    /// reveal which half of the credential pair was wrong. PAM rejects mismatched usernames
    /// before entering its serialized blocking verification path.
    async fn verify_login(&self, username: &str, password: &str) -> LoginVerification {
        let username_ok = constant_time_eq(username, &self.username);
        let password_ok = match &self.password_backend {
            PasswordBackend::ConfiguredHash(password_hash) => {
                verify_password_hash(password, password_hash)
            }
            #[cfg(target_os = "linux")]
            PasswordBackend::SystemPam(pam_api) => {
                // Configured auth still runs Argon2 for a wrong username so its cost does not
                // reveal whether that username exists. PAM must return early instead: many PAM
                // stacks delay wrong passwords but accept the correct password quickly, so
                // checking the real account here would let a mismatched username probe whether
                // a candidate system password is valid.
                if !username_ok {
                    return LoginVerification::Rejected;
                }
                let Ok(permit) = self.pam_semaphore.clone().try_acquire_owned() else {
                    return LoginVerification::Busy;
                };
                let password = password.to_string();
                let pam_api = pam_api.clone();
                match tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    pam_api.verify_current_user_password(&password)
                })
                .await
                {
                    Ok(Ok(valid)) => valid,
                    Ok(Err(error)) => {
                        log_error!(error, "PAM authentication failed");
                        false
                    }
                    Err(error) => {
                        log_error!(anyhow::Error::new(error), "PAM authentication task failed");
                        false
                    }
                }
            }
        };
        if username_ok && password_ok {
            LoginVerification::Authenticated
        } else {
            LoginVerification::Rejected
        }
    }
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

/// Constant-time password verification against a stored PHC string.
fn verify_password_hash(candidate: &str, password_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(password_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(candidate.as_bytes(), &parsed)
        .is_ok()
}

/// Builds a stable fingerprint so rotating the config password invalidates existing cookies.
fn credentials_fingerprint(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"redoor-session-v1:");
    hasher.update(password.as_bytes());
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

/// A freshly created session: the account it belongs to and the cookie that carries it.
pub(crate) struct NewSession {
    pub(crate) username: String,
    pub(crate) cookie: HeaderValue,
}

/// Constant-time string equality via fixed-length digests so length and content do not leak via timing.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_digest = Sha256::digest(left.as_bytes());
    let right_digest = Sha256::digest(right.as_bytes());
    bool::from(left_digest.ct_eq(&right_digest))
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

/// Verifies configured credentials and persists a new server-side login session.
pub(crate) async fn login_handler(
    State(state): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<LoginRequest>,
) -> Response {
    let client_ip = addr.ip();
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

    // Configured auth verifies the hash on username mismatch to avoid a timing signal,
    // while PAM rejects mismatched usernames before its blocking check.
    match state
        .auth
        .verify_login(&request.username, &request.password)
        .await
    {
        LoginVerification::Authenticated => {}
        LoginVerification::Rejected => {
            state
                .auth
                .login_limiter
                .record_failure(client_ip, Instant::now());
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    code: None,
                    error: "Invalid username or password".to_string(),
                }),
            )
                .into_response();
        }
        #[cfg(target_os = "linux")]
        LoginVerification::Busy => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ErrorResponse {
                    code: None,
                    error: "Authentication is busy. Try again later.".to_string(),
                }),
            )
                .into_response();
        }
    }

    let session = match state.auth.create_session(SessionMethod::Password).await {
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

    let mut response = Json(LoginResponse {
        username: session.username,
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
        LOGIN_MAX_TRACKED_IPS, LOGIN_RATE_WINDOW, LoginRateLimiter, SESSION_COOKIE_NAME,
        SessionCheck, SessionFile, SessionMethod, oidc_fingerprint,
    };
    use axum::http::{HeaderMap, HeaderValue, header};
    use redoor_core::config::{AuthMode, OidcConfig};
    use redoor_core::test_support::TempDir;
    use std::{
        net::{IpAddr, Ipv4Addr},
        time::{Duration, Instant},
    };

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

    /// Auth state for a password account, optionally with OIDC, stored in `directory`.
    async fn auth_state(directory: &TempDir, oidc: Option<&OidcConfig>) -> AuthState {
        AuthState::new(
            AuthMode::Configured {
                username: "admin".to_string(),
                password: "password".to_string(),
            },
            oidc,
            "agent-token".to_string(),
            false,
            directory.path(),
        )
        .await
        .expect("auth state must initialize")
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
            .create_session(SessionMethod::Oidc)
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
        // A brand-new session needs no renewal, so no disk write or cookie per request.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid
        ));

        let now = jiff::Timestamp::now().as_second();
        set_expiry(&directory, &headers, now + 60).await;
        // A session close to expiry is extended and the cookie is re-issued.
        let SessionCheck::Renewed(cookie) = auth.check_session(&headers).await else {
            panic!("a used session close to expiry must be renewed");
        };
        assert!(cookie.to_str().expect("ASCII").contains("Max-Age=31536000"));
        // After renewal the stored expiry is a full lifetime away again.
        assert!(matches!(
            auth.check_session(&headers).await,
            SessionCheck::Valid
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
        let session = auth
            .create_session(SessionMethod::Password)
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
            SessionCheck::Valid
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
                .create_session(SessionMethod::Oidc)
                .await
                .expect("session")
                .cookie,
        );
        let password_headers = cookie_headers(
            &auth
                .create_session(SessionMethod::Password)
                .await
                .expect("session")
                .cookie,
        );

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
            SessionCheck::Valid
        ));

        let oidc_headers = cookie_headers(
            &restarted
                .create_session(SessionMethod::Oidc)
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
                .create_session(SessionMethod::Oidc)
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
        let session = auth
            .create_session(SessionMethod::Password)
            .await
            .expect("session");
        let headers = cookie_headers(&session.cookie);
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
            SessionCheck::Valid
        ));
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
