use std::{path::PathBuf, time::Duration};

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use redoor::commands::{ErrorResponse, LoginRequest, LoginResponse, LogoutResponse};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::state::ServerState;

const SESSION_COOKIE_NAME: &str = "redoor_session";
const SESSION_LIFETIME: Duration = Duration::from_secs(60 * 60 * 24 * 30);

/// Holds configured credentials and the durable directory used to validate opaque cookies.
#[derive(Clone)]
pub(crate) struct AuthState {
    username: String,
    password: String,
    sessions_directory: PathBuf,
}

/// Persists the minimum bounded metadata needed to recognize one authenticated browser.
#[derive(Debug, Serialize, Deserialize)]
struct SessionFile {
    session_id: String,
    username: String,
    expires_at: i64,
}

impl AuthState {
    /// Creates the private session directory before requests arrive so login failures are actionable.
    pub(crate) async fn new(username: String, password: String) -> anyhow::Result<Self> {
        let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
            anyhow::anyhow!("HOME is not set; cannot locate the session directory")
        })?;
        let sessions_directory = home.join(".local/share/sessions");
        tokio::fs::create_dir_all(&sessions_directory).await?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&sessions_directory, std::fs::Permissions::from_mode(0o700))
                .await?;
        }

        Ok(Self {
            username,
            password,
            sessions_directory,
        })
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
            || session.expires_at <= now
        {
            if session.expires_at <= now {
                let _ = tokio::fs::remove_file(path).await;
            }
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
            expires_at: chrono::Utc::now().timestamp() + SESSION_LIFETIME.as_secs() as i64,
        };
        let contents = serde_json::to_vec(&session)?;
        tokio::fs::write(&temporary_path, contents).await?;
        tokio::fs::rename(temporary_path, path).await?;
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
    path == "/ws"
        || is_agent_terminal_socket
        || path == "/api/v1/login"
        || path == "/api/v1/logout"
        || !path.starts_with("/api/")
}

/// Rejects unauthenticated HTTP and browser WebSocket requests before handlers start streaming work.
pub(crate) async fn require_authentication(
    State(auth): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if is_public_path(request.uri().path()) || auth.is_authenticated(request.headers()).await {
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
    Json(request): Json<LoginRequest>,
) -> Response {
    if request.username != state.auth.username || request.password != state.auth.password {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Invalid username or password".to_string(),
            }),
        )
            .into_response();
    }

    let session_id = match state.auth.create_session().await {
        Ok(session_id) => session_id,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to create session: {error}"),
                }),
            )
                .into_response();
        }
    };

    let mut response = Json(LoginResponse {
        username: request.username,
    })
    .into_response();
    let cookie = format!(
        "{SESSION_COOKIE_NAME}={session_id}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
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
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to delete session: {error}"),
            }),
        )
            .into_response();
    }

    let mut response = Json(LogoutResponse { logged_out: true }).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("redoor_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"),
    );
    response
}
