use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use redoor::{
    Level,
    commands::{ErrorResponse, LoginRequest, LoginResponse, LogoutResponse},
    log,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use super::state::ServerState;

const SESSION_COOKIE_NAME: &str = "redoor_session";
const SESSION_LIFETIME: Duration = Duration::from_secs(60 * 60 * 24 * 7);
/// Caps online brute force against a single source address.
const LOGIN_MAX_FAILURES_PER_IP: u32 = 10;
/// Caps coordinated multi-source brute force against the whole process.
const LOGIN_MAX_FAILURES_GLOBAL: u32 = 60;
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
    /// Serializes PAM because blocking checks can otherwise exhaust Tokio's blocking pool.
    #[cfg(target_os = "linux")]
    pam_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}

/// Browser login credentials resolved from the config file (or Linux system account).
pub(crate) enum LoginCredentials {
    /// Explicit username/password pair from `[server]` in the TOML config.
    Configured { username: String, password: String },
    /// Authenticate as the process owner via Linux PAM when TOML omits credentials.
    #[cfg(target_os = "linux")]
    SystemUser,
}

/// Distinguishes rejected credentials from temporary PAM saturation for correct HTTP responses.
enum LoginVerification {
    /// Authentication succeeded, so the handler may create a session.
    Authenticated,
    /// Authentication failed, so the rate limiter must record the rejected attempt.
    Rejected,
    /// PAM is already running, so callers should retry without counting a credential failure.
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
    /// Starts an empty window at the current time.
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            failures: 0,
        }
    }

    /// Resets the window when it has expired so legitimate users recover after a burst.
    fn refresh(&mut self) {
        if self.started_at.elapsed() >= LOGIN_RATE_WINDOW {
            *self = Self::new();
        }
    }
}

impl LoginRateLimiter {
    /// Creates empty throttle state shared across all login attempts.
    fn new() -> Self {
        Self {
            by_ip: Mutex::new(HashMap::new()),
            global: Mutex::new(FailureWindow::new()),
        }
    }

    /// Returns whether this client is currently locked out of login attempts.
    fn is_limited(&self, ip: IpAddr) -> bool {
        let mut by_ip = self.by_ip.lock().expect("login rate limiter poisoned");
        let entry = by_ip.entry(ip).or_insert_with(FailureWindow::new);
        entry.refresh();
        if entry.failures >= LOGIN_MAX_FAILURES_PER_IP {
            return true;
        }

        let mut global = self.global.lock().expect("login rate limiter poisoned");
        global.refresh();
        global.failures >= LOGIN_MAX_FAILURES_GLOBAL
    }

    /// Records one failed login so subsequent attempts can be rejected quickly.
    fn record_failure(&self, ip: IpAddr) {
        let mut by_ip = self.by_ip.lock().expect("login rate limiter poisoned");
        let entry = by_ip.entry(ip).or_insert_with(FailureWindow::new);
        entry.refresh();
        entry.failures = entry.failures.saturating_add(1);

        let mut global = self.global.lock().expect("login rate limiter poisoned");
        global.refresh();
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
}

impl AuthState {
    /// Creates the private session directory before requests arrive so login failures are actionable.
    pub(crate) async fn new(
        credentials: LoginCredentials,
        agent_token: String,
        cookie_secure: bool,
    ) -> anyhow::Result<Self> {
        let (username, password_backend, credentials_fingerprint) = match credentials {
            LoginCredentials::Configured { username, password } => {
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
            LoginCredentials::SystemUser => {
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
        let sessions_directory = crate::app_name::user_data_directory()?.join("sessions");
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
            #[cfg(target_os = "linux")]
            pam_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        };

        // Drop sessions issued under a previous password so rotation takes effect immediately.
        auth.purge_stale_sessions().await?;

        Ok(auth)
    }

    /// Shared secret that agents must present when registering over `/ws`.
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

    /// Reads the session file on every request so logout and server restarts share one source of truth.
    async fn is_authenticated(&self, headers: &HeaderMap) -> bool {
        let Some(session_id) = session_cookie(headers) else {
            return false;
        };
        let Some(path) = self.session_path(&session_id) else {
            return false;
        };
        let Ok(contents) = tokio::fs::read(&path).await else {
            return false;
        };
        let Ok(session) = serde_json::from_slice::<SessionFile>(&contents) else {
            return false;
        };

        let now = chrono::Utc::now().timestamp();
        if session.session_id != session_id
            || session.username != self.username
            || session.credentials_fingerprint != self.credentials_fingerprint
            || session.expires_at <= now
        {
            // Remove expired or credential-mismatched files so disk does not retain stealable IDs.
            let _ = tokio::fs::remove_file(path).await;
            return false;
        }

        true
    }

    /// Writes through a temporary file so a crash cannot leave a partially valid JSON session.
    async fn create_session(&self) -> anyhow::Result<String> {
        let session_id = Uuid::new_v4().to_string();
        let path = self
            .session_path(&session_id)
            .expect("a generated UUID must produce a session path");
        let temporary_path = self
            .sessions_directory
            .join(format!(".session_{session_id}.tmp"));
        let session = SessionFile {
            session_id: session_id.clone(),
            username: self.username.clone(),
            credentials_fingerprint: self.credentials_fingerprint.clone(),
            expires_at: chrono::Utc::now().timestamp() + SESSION_LIFETIME.as_secs() as i64,
        };
        let contents = serde_json::to_vec(&session)?;
        write_private_file(&temporary_path, &contents).await?;
        tokio::fs::rename(&temporary_path, &path).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await?;
        }
        Ok(session_id)
    }

    /// Deletes only a syntactically valid session identifier, preventing path traversal via cookies.
    async fn delete_session(&self, headers: &HeaderMap) -> anyhow::Result<()> {
        let Some(session_id) = session_cookie(headers) else {
            return Ok(());
        };
        let Some(path) = self.session_path(&session_id) else {
            return Ok(());
        };
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
            if session.username != self.username
                || session.credentials_fingerprint != self.credentials_fingerprint
            {
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
                        log!(Level::Error, "PAM authentication failed: {error}");
                        false
                    }
                    Err(error) => {
                        log!(Level::Error, "PAM authentication task failed: {error}");
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
    let salt = SaltString::generate(&mut OsRng);
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

/// Allows only resources needed to establish a session before enforcing authentication globally.
fn is_public_path(path: &str) -> bool {
    let is_agent_terminal_socket =
        path.starts_with("/api/v1/terminals/") && path.ends_with("/agent/ws");
    let is_agent_log_socket = path
        .strip_prefix("/api/v1/log-streams/")
        .and_then(|remainder| remainder.strip_suffix("/agent/ws"))
        .is_some_and(|stream_id| !stream_id.is_empty() && !stream_id.contains('/'));
    path == "/ws"
        || path == "/api/v1/agent-transfer/ws"
        || is_agent_terminal_socket
        || is_agent_log_socket
        || path == "/api/v1/login"
        || path == "/api/v1/logout"
        || !path.starts_with("/api/")
}

/// Identifies narrowly scoped raw GET requests whose handler will validate one-time authorization.
fn is_one_time_token_raw_request(method: &Method, uri: &Uri) -> bool {
    if method != Method::GET {
        return false;
    }
    let Some(remainder) = uri.path().strip_prefix("/api/v1/agents/") else {
        return false;
    };
    let Some((agent, raw_path)) = remainder.split_once("/raw") else {
        return false;
    };
    if agent.is_empty()
        || agent.contains('/')
        || !(raw_path.is_empty() || raw_path.starts_with('/'))
    {
        return false;
    }
    uri.query().is_some_and(|query| {
        query.split('&').any(|parameter| {
            parameter
                .split_once('=')
                .is_some_and(|(name, value)| name == "one_time_token" && !value.is_empty())
        })
    })
}

/// Rejects unauthenticated HTTP and browser WebSocket requests before handlers start streaming work.
pub(crate) async fn require_authentication(
    State(auth): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if is_public_path(request.uri().path())
        || is_one_time_token_raw_request(request.method(), request.uri())
        || auth.is_authenticated(request.headers()).await
    {
        return next.run(request).await;
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorResponse {
            error: "Authentication required".to_string(),
        }),
    )
        .into_response()
}

/// Verifies configured credentials and persists a new server-side login session.
pub(crate) async fn login_handler(
    State(state): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<LoginRequest>,
) -> Response {
    let client_ip = addr.ip();
    if state.auth.login_limiter.is_limited(client_ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
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
            state.auth.login_limiter.record_failure(client_ip);
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Invalid username or password".to_string(),
                }),
            )
                .into_response();
        }
        LoginVerification::Busy => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ErrorResponse {
                    error: "Authentication is busy. Try again later.".to_string(),
                }),
            )
                .into_response();
        }
    }

    let session_id = match state.auth.create_session().await {
        Ok(session_id) => session_id,
        Err(error) => {
            // Keep IO/path details off the wire; operators still see them in server logs.
            log!(Level::Error, "Failed to create session: {error}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Failed to create session".to_string(),
                }),
            )
                .into_response();
        }
    };

    let mut response = Json(LoginResponse {
        username: request.username,
    })
    .into_response();
    let secure_flag = if state.auth.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{SESSION_COOKIE_NAME}={session_id}; HttpOnly; SameSite=Lax; Path=/{secure_flag}; Max-Age={}",
        SESSION_LIFETIME.as_secs()
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("generated cookie contains only safe ASCII"),
    );
    response
}

/// Removes the durable session first, then expires the browser cookie even when no file remains.
pub(crate) async fn logout_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = state.auth.delete_session(&headers).await {
        log!(Level::Error, "Failed to delete session: {error}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Failed to delete session".to_string(),
            }),
        )
            .into_response();
    }

    let secure_flag = if state.auth.cookie_secure {
        "; Secure"
    } else {
        ""
    };
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
    use super::{is_one_time_token_raw_request, is_public_path};
    use axum::http::{Method, Uri};

    /// Protects the dedicated agent exception without exposing browser or neighboring API routes.
    #[test]
    fn only_exact_agent_log_socket_shape_is_public() {
        // A dedicated agent socket must reach its one-time-token handshake without a browser cookie.
        assert!(is_public_path(
            "/api/v1/log-streams/00000000-0000-0000-0000-000000000001/agent/ws"
        ));
        // The exact payload socket must reach its session-token handshake without a browser cookie.
        assert!(is_public_path("/api/v1/agent-transfer/ws"));
        // Neighboring transfer paths must not inherit the public authentication exception.
        assert!(!is_public_path("/api/v1/agent-transfer/ws/extra"));
        // The browser-owned endpoint must remain protected by normal session authentication.
        assert!(!is_public_path("/api/v1/agents/agent-1/logs/ws"));
        // Nested paths cannot exploit broad prefix/suffix matching to bypass authentication.
        assert!(!is_public_path("/api/v1/log-streams/not/a-stream/agent/ws"));
        // Unrelated resources under the log-stream namespace remain private.
        assert!(!is_public_path("/api/v1/log-streams/example/status"));
    }

    /// Keeps the cookie bypass limited to raw GETs that present a non-empty token parameter.
    #[test]
    fn only_token_bearing_raw_gets_reach_handler_without_cookie_authentication() {
        let token_uri: Uri = "/api/v1/agents/agent-1/raw/tmp/file?one_time_token=token"
            .parse()
            .expect("test URI must parse");
        // The handler must receive a token-bearing raw GET so it can validate the credential.
        assert!(is_one_time_token_raw_request(&Method::GET, &token_uri));
        // Token creation remains protected even if a caller adds a similarly named query parameter.
        assert!(!is_one_time_token_raw_request(&Method::POST, &token_uri));
        let missing_token_uri: Uri = "/api/v1/agents/agent-1/raw/tmp/file"
            .parse()
            .expect("test URI must parse");
        // Ordinary raw downloads still require the authenticated browser session.
        assert!(!is_one_time_token_raw_request(
            &Method::GET,
            &missing_token_uri
        ));
        let neighboring_uri: Uri = "/api/v1/agents/agent-1/rawness?one_time_token=token"
            .parse()
            .expect("test URI must parse");
        // Neighboring route names cannot use the raw-download exception.
        assert!(!is_one_time_token_raw_request(
            &Method::GET,
            &neighboring_uri
        ));
    }
}
