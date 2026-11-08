//! `redoor remote login` through the browser: pending CLI logins and their routes.
//!
//! This is the OAuth device authorization flow (RFC 8628). The CLI starts a request and
//! prints a URL and a user code; the user opens the URL in a signed-in browser, types the
//! code and approves the token after a fresh sign-in; the CLI's long poll then receives the
//! token. The CLI never sees a password, OIDC-only servers get a CLI login too, and a token
//! can only be minted with a person approving it in the browser.
//!
//! Requests live in memory for at most [`CLI_LOGIN_LIFETIME`] and are gone after a restart,
//! which only cancels logins that were in progress.

use std::{
    collections::{BTreeSet, HashMap},
    net::IpAddr,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use axum::{
    Extension, Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use redoor_core::{log, log_error};
use redoor_protocol::{
    api::{
        cli_logins::{
            ApproveCliLoginRequest, ApproveCliLoginResponse, CliLoginResponse, CliLoginStatus,
            CliLoginWaitResponse, CliTokenDefaults, DenyCliLoginResponse, StartCliLoginRequest,
            StartCliLoginResponse, WaitCliLoginRequest,
        },
        tokens::{AccessTokenSecretResponse, DeviceScope},
    },
    wire::log::Level,
};
use subtle::ConstantTimeEq;
use tokio::sync::Notify;

use super::{
    auth::ActiveSession,
    client_address::ClientAddress,
    error::ApiError,
    state::ServerState,
    tokens::handlers::{mint, no_store, require_fresh_login, validate_mutation_origin},
};

/// How long a request waits for the browser. Long enough to open the URL on another device
/// and sign in; short enough that a phished code goes stale soon (RFC 8628 suggests minutes).
const CLI_LOGIN_LIFETIME: Duration = Duration::from_secs(10 * 60);
/// Pending requests overall. The start route is public, so this bounds what anonymous
/// callers can make the server hold.
const MAX_PENDING: usize = 20;
/// Pending requests per TCP peer, so one client cannot take every slot.
const MAX_PENDING_PER_IP: usize = 5;
/// Wrong user codes before the request is removed, so the code cannot be guessed.
const MAX_WRONG_CODES: u32 = 5;
/// Longest single `wait`: below common proxy idle timeouts, so the poll is answered rather
/// than cut.
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Consonants without look-alikes (no vowels, so codes do not spell words; no 0/O, 1/I),
/// as RFC 8628 6.1 suggests for codes typed on another device.
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
/// Symbols in a user code: 20^8 is about 2^34.6, against at most five guesses.
const USER_CODE_LENGTH: usize = 8;
/// Longest host name kept; it is client controlled and shown on the approval page.
const MAX_HOST_NAME_CHARS: usize = 255;
/// Longest requested token name, the same limit token creation has.
const MAX_TOKEN_NAME_CHARS: usize = 100;
/// Most requested devices, and the longest one, so a request's memory stays small.
const MAX_REQUESTED_DEVICES: usize = 64;
const MAX_DEVICE_CHARS: usize = 200;

/// The pending CLI logins, shared by all handlers.
#[derive(Clone, Default)]
pub(crate) struct CliLoginStore {
    requests: Arc<Mutex<HashMap<String, PendingCliLogin>>>,
}

/// One request between the CLI starting it and the CLI receiving its answer.
struct PendingCliLogin {
    /// Proves a `wait` comes from the CLI that started the request.
    poll_secret: String,
    /// Normalized: upper case, without the separator.
    user_code: String,
    host_name: String,
    /// Who started it, shown on the approval page next to the phishing warning.
    client: ClientAddress,
    token: CliTokenDefaults,
    created_at: Instant,
    expires_at: Instant,
    wrong_codes: u32,
    outcome: Outcome,
    /// A `wait` is in progress; a second one is refused, so one request cannot hold any
    /// number of long polls.
    waiting: bool,
    /// Wakes the `wait` when the browser approves or denies. `notify_one` keeps a permit
    /// when nobody waits yet, so an answer between two polls is not missed.
    notify: Arc<Notify>,
}

/// What the browser decided.
enum Outcome {
    Pending,
    /// The token is being created; neither a second approval nor a denial may interleave.
    Approving,
    /// The token, held only until the CLI's `wait` takes it.
    Approved(AccessTokenSecretResponse),
    Denied,
}

/// Why a CLI login operation was refused.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum CliLoginError {
    /// Unknown, expired, already answered, or the poll secret did not match. One answer for
    /// all, so a poll does not reveal which requests exist.
    #[error("This login request is unknown, expired or already used; run the command again")]
    NotFound,
    #[error("Too many CLI logins are waiting for approval; try again in a few minutes")]
    TooMany,
    #[error("{0}")]
    Invalid(String),
    #[error("The code does not match the one shown in the terminal")]
    WrongCode,
    #[error("Too many wrong codes, so the login request was cancelled; run the command again")]
    TooManyWrongCodes,
    #[error("This login request was already {0}")]
    AlreadyAnswered(&'static str),
    #[error("Another wait for this login request is already in progress")]
    WaitInProgress,
}

impl From<CliLoginError> for ApiError {
    /// 404 for everything that ends the request, so the CLI's answer is the same whatever
    /// happened; 409 for a request that is answered or polled already.
    fn from(error: CliLoginError) -> Self {
        let status = match error {
            CliLoginError::NotFound | CliLoginError::TooManyWrongCodes => StatusCode::NOT_FOUND,
            CliLoginError::TooMany => StatusCode::TOO_MANY_REQUESTS,
            CliLoginError::Invalid(_) | CliLoginError::WrongCode => StatusCode::BAD_REQUEST,
            CliLoginError::AlreadyAnswered(_) | CliLoginError::WaitInProgress => {
                StatusCode::CONFLICT
            }
        };
        ApiError::status(status, error.to_string())
    }
}

/// Clears the waiting flag when a `wait` ends, also when the CLI disconnects and the handler
/// future is dropped mid-poll.
struct Waiter<'a> {
    store: &'a CliLoginStore,
    id: String,
}

impl Drop for Waiter<'_> {
    fn drop(&mut self) {
        if let Some(request) = self.store.lock(Instant::now()).get_mut(&self.id) {
            request.waiting = false;
        }
    }
}

impl CliLoginStore {
    /// The requests with expired ones dropped, so every access sees only live requests and
    /// an untaken token secret is gone with its request.
    fn lock(&self, now: Instant) -> MutexGuard<'_, HashMap<String, PendingCliLogin>> {
        let mut requests = self.requests.lock().expect("CLI logins poisoned");
        requests.retain(|_, request| request.expires_at > now);
        requests
    }

    /// Records a new request from `client` and returns the CLI's handle on it.
    fn start(
        &self,
        request: StartCliLoginRequest,
        client: ClientAddress,
        now: Instant,
    ) -> Result<StartCliLoginResponse, CliLoginError> {
        let host_name = valid_host_name(&request.host_name)?;
        let token = valid_defaults(request.token)?;
        let id = random_string(16)?;
        let poll_secret = random_string(32)?;
        let user_code = new_user_code()?;
        let mut requests = self.lock(now);
        let ip: IpAddr = client.peer.ip();
        let from_ip = requests
            .values()
            .filter(|request| request.client.peer.ip() == ip)
            .count();
        if requests.len() >= MAX_PENDING || from_ip >= MAX_PENDING_PER_IP {
            return Err(CliLoginError::TooMany);
        }
        requests.insert(
            id.clone(),
            PendingCliLogin {
                poll_secret: poll_secret.clone(),
                user_code: user_code.clone(),
                host_name,
                client,
                token,
                created_at: now,
                expires_at: now + CLI_LOGIN_LIFETIME,
                wrong_codes: 0,
                outcome: Outcome::Pending,
                waiting: false,
                notify: Arc::default(),
            },
        );
        Ok(StartCliLoginResponse {
            approval_path: format!("/cli-login/{id}"),
            id,
            poll_secret,
            user_code: format!(
                "{}-{}",
                &user_code[..USER_CODE_LENGTH / 2],
                &user_code[USER_CODE_LENGTH / 2..]
            ),
            expires_in_seconds: CLI_LOGIN_LIFETIME.as_secs(),
        })
    }

    /// What the approval page shows: never the user code or the poll secret.
    fn describe(&self, id: &str, now: Instant) -> Result<CliLoginResponse, CliLoginError> {
        let requests = self.lock(now);
        let request = requests.get(id).ok_or(CliLoginError::NotFound)?;
        Ok(CliLoginResponse {
            host_name: request.host_name.clone(),
            client_ip: request.client.peer.ip().to_string(),
            forwarded_for: request.client.forwarded_for.clone(),
            token: request.token.clone(),
            status: match request.outcome {
                Outcome::Pending => CliLoginStatus::Pending,
                Outcome::Approving | Outcome::Approved(_) => CliLoginStatus::Approved,
                Outcome::Denied => CliLoginStatus::Denied,
            },
            age_seconds: now.duration_since(request.created_at).as_secs(),
            expires_in_seconds: request.expires_at.duration_since(now).as_secs(),
        })
    }

    /// Checks the user code and reserves the request for the token about to be created.
    /// Every wrong code counts, and the [`MAX_WRONG_CODES`]th removes the request.
    fn begin_approval(&self, id: &str, user_code: &str, now: Instant) -> Result<(), CliLoginError> {
        let mut requests = self.lock(now);
        let request = requests.get_mut(id).ok_or(CliLoginError::NotFound)?;
        request.outcome.require_pending()?;
        let typed = normalize_user_code(user_code);
        if !bool::from(typed.as_bytes().ct_eq(request.user_code.as_bytes())) {
            request.wrong_codes += 1;
            if request.wrong_codes >= MAX_WRONG_CODES {
                requests.remove(id);
                return Err(CliLoginError::TooManyWrongCodes);
            }
            return Err(CliLoginError::WrongCode);
        }
        request.outcome = Outcome::Approving;
        Ok(())
    }

    /// Ends an approval begun with [`Self::begin_approval`]: stores the token for the CLI
    /// and wakes its `wait`, or with `None` (creating the token failed) lets the user try
    /// again. Returns `false` when the request expired in between, so the caller can revoke
    /// the token nobody will pick up.
    fn finish_approval(&self, id: &str, token: Option<AccessTokenSecretResponse>) -> bool {
        let mut requests = self.lock(Instant::now());
        let Some(request) = requests.get_mut(id) else {
            return false;
        };
        match token {
            Some(token) => {
                request.outcome = Outcome::Approved(token);
                request.notify.notify_one();
            }
            None => request.outcome = Outcome::Pending,
        }
        true
    }

    /// Turns a pending request down and wakes the CLI's `wait`. Needs no user code: denying
    /// hands nothing out.
    fn deny(&self, id: &str, now: Instant) -> Result<(), CliLoginError> {
        let mut requests = self.lock(now);
        let request = requests.get_mut(id).ok_or(CliLoginError::NotFound)?;
        request.outcome.require_pending()?;
        request.outcome = Outcome::Denied;
        request.notify.notify_one();
        Ok(())
    }

    /// The CLI's long poll: answers at once when the browser has decided, otherwise waits up
    /// to [`WAIT_TIMEOUT`] (or the request's expiry) for it. `approved` and `denied` are
    /// each answered once, after which the request is gone.
    async fn wait(
        &self,
        id: &str,
        poll_secret: &str,
    ) -> Result<CliLoginWaitResponse, CliLoginError> {
        let (notify, deadline) = {
            let now = Instant::now();
            let mut requests = self.lock(now);
            let authentic = requests.get(id).is_some_and(|request| {
                bool::from(request.poll_secret.as_bytes().ct_eq(poll_secret.as_bytes()))
            });
            if !authentic {
                return Err(CliLoginError::NotFound);
            }
            // Before taking an answer, so a second poll cannot take the one the waiting
            // poll is about to receive.
            if requests.get(id).is_some_and(|request| request.waiting) {
                return Err(CliLoginError::WaitInProgress);
            }
            if let Some(answer) = take_answer(&mut requests, id) {
                return Ok(answer);
            }
            let request = requests.get_mut(id).ok_or(CliLoginError::NotFound)?;
            request.waiting = true;
            (
                request.notify.clone(),
                (now + WAIT_TIMEOUT).min(request.expires_at),
            )
        };
        let _waiter = Waiter {
            store: self,
            id: id.to_string(),
        };
        // A timeout is the normal "still pending" answer.
        let _ = tokio::time::timeout_at(deadline.into(), notify.notified()).await;
        let mut requests = self.lock(Instant::now());
        if !requests.contains_key(id) {
            return Err(CliLoginError::NotFound);
        }
        Ok(take_answer(&mut requests, id).unwrap_or(CliLoginWaitResponse::Pending))
    }
}

/// Removes a decided request and returns its answer for the CLI, or `None` while it is
/// still pending.
fn take_answer(
    requests: &mut HashMap<String, PendingCliLogin>,
    id: &str,
) -> Option<CliLoginWaitResponse> {
    let decided = requests
        .get(id)
        .is_some_and(|request| matches!(request.outcome, Outcome::Approved(_) | Outcome::Denied));
    if !decided {
        return None;
    }
    match requests.remove(id)?.outcome {
        Outcome::Approved(token) => Some(CliLoginWaitResponse::Approved(token)),
        Outcome::Denied => Some(CliLoginWaitResponse::Denied),
        Outcome::Pending | Outcome::Approving => None,
    }
}

impl Outcome {
    /// Only a pending request can be approved or denied.
    fn require_pending(&self) -> Result<(), CliLoginError> {
        match self {
            Self::Pending => Ok(()),
            Self::Approving | Self::Approved(_) => Err(CliLoginError::AlreadyAnswered("approved")),
            Self::Denied => Err(CliLoginError::AlreadyAnswered("denied")),
        }
    }
}

/// Accepts a host name the approval page can show: trimmed, non-empty, bounded and free of
/// control characters, since it comes from an unauthenticated caller.
fn valid_host_name(value: &str) -> Result<String, CliLoginError> {
    let host_name = value.trim();
    if host_name.is_empty()
        || host_name.chars().count() > MAX_HOST_NAME_CHARS
        || host_name.chars().any(char::is_control)
    {
        return Err(CliLoginError::Invalid(format!(
            "The host name must have 1 to {MAX_HOST_NAME_CHARS} printable characters"
        )));
    }
    Ok(host_name.to_string())
}

/// Bounds the requested defaults so an anonymous request stays small. They are only form
/// defaults: the approval runs the full token validation on what the browser sends.
fn valid_defaults(token: CliTokenDefaults) -> Result<CliTokenDefaults, CliLoginError> {
    let invalid = |message: String| Err(CliLoginError::Invalid(message));
    let name = token.name.trim().to_string();
    if name.chars().count() > MAX_TOKEN_NAME_CHARS || name.chars().any(char::is_control) {
        return invalid(format!(
            "The token name must have at most {MAX_TOKEN_NAME_CHARS} printable characters"
        ));
    }
    let devices = match token.devices {
        DeviceScope::All => DeviceScope::All,
        DeviceScope::Only { device_ids } => {
            if device_ids.is_empty() || device_ids.len() > MAX_REQUESTED_DEVICES {
                return invalid(format!(
                    "Request 'all' devices or 1 to {MAX_REQUESTED_DEVICES} devices"
                ));
            }
            if device_ids.iter().any(|device| {
                device.as_str().is_empty()
                    || device.as_str().chars().count() > MAX_DEVICE_CHARS
                    || device.as_str().chars().any(char::is_control)
            }) {
                return invalid(format!(
                    "Device names must have 1 to {MAX_DEVICE_CHARS} printable characters"
                ));
            }
            DeviceScope::Only { device_ids }
        }
    };
    Ok(CliTokenDefaults {
        name,
        // A set, so a body of repeated permissions cannot grow the request.
        permissions: token
            .permissions
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        devices,
        lifetime: token.lifetime,
    })
}

/// `bytes` random bytes from the OS CSPRNG, base64url so they fit a URL path and JSON.
fn random_string(bytes: usize) -> Result<String, CliLoginError> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|error| {
        CliLoginError::Invalid(format!("failed to read OS randomness: {error}"))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// A new user code. Rejection sampling keeps every symbol uniform: 256 is not a multiple of
/// the alphabet size.
fn new_user_code() -> Result<String, CliLoginError> {
    let limit = 256 - 256 % USER_CODE_ALPHABET.len();
    let mut code = String::with_capacity(USER_CODE_LENGTH);
    while code.len() < USER_CODE_LENGTH {
        let mut byte = [0_u8; 1];
        getrandom::fill(&mut byte).map_err(|error| {
            CliLoginError::Invalid(format!("failed to read OS randomness: {error}"))
        })?;
        if usize::from(byte[0]) < limit {
            code.push(char::from(
                USER_CODE_ALPHABET[usize::from(byte[0]) % USER_CODE_ALPHABET.len()],
            ));
        }
    }
    Ok(code)
}

/// What the user typed, as stored: case and separators do not matter.
fn normalize_user_code(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Route: `POST /api/v1/cli-logins` (public): the CLI starts a login.
pub(crate) async fn start_handler(
    State(state): State<ServerState>,
    client: ClientAddress,
    Json(request): Json<StartCliLoginRequest>,
) -> Result<Response, ApiError> {
    let started = state
        .cli_logins
        .start(request, client.clone(), Instant::now())?;
    log!(
        Level::Info,
        "CLI login requested: address={client}, request={}",
        started.id
    );
    // Carries the poll secret, so it must not be cached.
    Ok(no_store(Json(started)))
}

/// Route: `GET /api/v1/cli-logins/{id}` (session only): what the approval page shows.
pub(crate) async fn get_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    Ok(no_store(Json(
        state.cli_logins.describe(&id, Instant::now())?,
    )))
}

/// Route: `POST /api/v1/cli-logins/{id}/approve` (session only): the browser approves with
/// the code from the terminal. The token goes through the same creation path and fresh
/// sign-in check as `POST /api/v1/tokens`; its secret goes to the CLI only.
pub(crate) async fn approve_handler(
    State(state): State<ServerState>,
    session: Option<Extension<ActiveSession>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<ApproveCliLoginRequest>,
) -> Result<Response, ApiError> {
    validate_mutation_origin(&headers)?;
    // Before the code, so a copied profile cannot even spend the request's guesses.
    require_fresh_login(session.as_deref())?;
    state
        .cli_logins
        .begin_approval(&id, &request.user_code, Instant::now())?;
    let token = match mint(&state, request.token).await {
        Ok(token) => token,
        Err(error) => {
            state.cli_logins.finish_approval(&id, None);
            return Err(error);
        }
    };
    let metadata = token.metadata.clone();
    if !state.cli_logins.finish_approval(&id, Some(token)) {
        // The request expired while the token was created; nobody would pick it up.
        if let Ok(token_id) = metadata.id.parse()
            && let Err(error) = state.tokens.delete(token_id).await
        {
            log_error!(
                anyhow::Error::from(error),
                "Failed to revoke the token of an expired CLI login"
            );
        }
        return Err(CliLoginError::NotFound.into());
    }
    log!(
        Level::Info,
        "Approved CLI login {id}: token \"{}\" ({})",
        metadata.name.escape_debug(),
        metadata.id
    );
    Ok(no_store(Json(ApproveCliLoginResponse { metadata })))
}

/// Route: `POST /api/v1/cli-logins/{id}/deny` (session only): the browser turns the request
/// down, and the CLI stops waiting.
pub(crate) async fn deny_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    validate_mutation_origin(&headers)?;
    state.cli_logins.deny(&id, Instant::now())?;
    log!(Level::Info, "Denied CLI login {id}");
    Ok(no_store(Json(DenyCliLoginResponse { denied: true })))
}

/// Route: `POST /api/v1/cli-logins/{id}/wait` (public, authenticated by the poll secret):
/// the CLI's long poll.
pub(crate) async fn wait_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(request): Json<WaitCliLoginRequest>,
) -> Result<Response, ApiError> {
    let answer = state.cli_logins.wait(&id, &request.poll_secret).await?;
    // Carries the token secret when approved.
    Ok(no_store(Json(answer)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::api::{
        cli_logins::TokenLifetime,
        tokens::{AccessTokenResponse, Permission},
    };

    /// A CLI request from `ip`.
    fn client(ip: [u8; 4]) -> ClientAddress {
        ClientAddress {
            peer: (ip, 40_000).into(),
            forwarded_for: None,
        }
    }

    /// What `redoor remote login` sends by default.
    fn request() -> StartCliLoginRequest {
        StartCliLoginRequest {
            host_name: "laptop".to_string(),
            token: CliTokenDefaults {
                name: "redoor remote on laptop".to_string(),
                permissions: vec![Permission::FilesRead, Permission::FilesRead],
                devices: DeviceScope::All,
                lifetime: TokenLifetime::Days90,
            },
        }
    }

    /// A token as the approval would create it.
    fn token() -> AccessTokenSecretResponse {
        AccessTokenSecretResponse {
            token: "redoor_at_secret".to_string(),
            metadata: AccessTokenResponse {
                id: "id".to_string(),
                name: "n".to_string(),
                permissions: vec![Permission::FilesRead],
                devices: DeviceScope::All,
                created_at: String::new(),
                expires_at: None,
                last_used_at: None,
            },
        }
    }

    /// Codes are shown split in two halves of the consonant alphabet and accepted however
    /// the user types them.
    #[test]
    fn user_codes_are_readable_and_forgiving() {
        let store = CliLoginStore::default();
        let started = store
            .start(request(), client([10, 0, 0, 1]), Instant::now())
            .unwrap();
        let (left, right) = started.user_code.split_once('-').unwrap();
        // XXXX-XXXX, from the alphabet without vowels and look-alikes.
        assert_eq!((left.len(), right.len()), (4, 4));
        assert!(
            format!("{left}{right}")
                .bytes()
                .all(|byte| USER_CODE_ALPHABET.contains(&byte))
        );
        // Lower case and spaces instead of the dash still match.
        let typed = format!("{} {}", left.to_lowercase(), right.to_lowercase());
        assert_eq!(
            store.begin_approval(&started.id, &typed, Instant::now()),
            Ok(())
        );
        // The described request never contains the code or the poll secret.
        let described =
            serde_json::to_string(&store.describe(&started.id, Instant::now()).unwrap()).unwrap();
        assert!(!described.contains(left) && !described.contains(&started.poll_secret));
    }

    /// The approved token is handed out once, then the request is gone.
    #[tokio::test]
    async fn approval_is_handed_out_once() {
        let store = CliLoginStore::default();
        let started = store
            .start(request(), client([10, 0, 0, 1]), Instant::now())
            .unwrap();
        // A wrong poll secret learns nothing, not even that the request exists.
        assert_eq!(
            store.wait(&started.id, "wrong").await.unwrap_err(),
            CliLoginError::NotFound
        );
        store
            .begin_approval(&started.id, &started.user_code, Instant::now())
            .unwrap();
        // A second approval cannot slip in while the token is being created.
        assert_eq!(
            store.begin_approval(&started.id, &started.user_code, Instant::now()),
            Err(CliLoginError::AlreadyAnswered("approved"))
        );
        assert!(store.finish_approval(&started.id, Some(token())));
        // The CLI receives the token ...
        assert!(matches!(
            store.wait(&started.id, &started.poll_secret).await,
            Ok(CliLoginWaitResponse::Approved(secret)) if secret.token == "redoor_at_secret"
        ));
        // ... exactly once.
        assert_eq!(
            store
                .wait(&started.id, &started.poll_secret)
                .await
                .unwrap_err(),
            CliLoginError::NotFound
        );
    }

    /// A waiting CLI is woken by the decision instead of polling again.
    #[tokio::test]
    async fn a_decision_wakes_the_waiting_cli() {
        let store = CliLoginStore::default();
        let started = store
            .start(request(), client([10, 0, 0, 1]), Instant::now())
            .unwrap();
        let waiting = tokio::spawn({
            let store = store.clone();
            let id = started.id.clone();
            let secret = started.poll_secret.clone();
            async move { store.wait(&id, &secret).await }
        });
        // Wait until the poll is registered, so the second one below is concurrent.
        while !store.lock(Instant::now())[&started.id].waiting {
            tokio::task::yield_now().await;
        }
        // One poll per request: a second concurrent one is refused.
        assert_eq!(
            store
                .wait(&started.id, &started.poll_secret)
                .await
                .unwrap_err(),
            CliLoginError::WaitInProgress
        );
        store.deny(&started.id, Instant::now()).unwrap();
        // A denied request cannot be approved any more.
        assert_eq!(
            store.begin_approval(&started.id, &started.user_code, Instant::now()),
            Err(CliLoginError::AlreadyAnswered("denied"))
        );
        // The waiting poll answers with the denial, well before its timeout.
        assert!(matches!(
            waiting.await.unwrap(),
            Ok(CliLoginWaitResponse::Denied)
        ));
        // The denial is answered once, too.
        assert_eq!(
            store
                .wait(&started.id, &started.poll_secret)
                .await
                .unwrap_err(),
            CliLoginError::NotFound
        );
    }

    /// Five wrong codes remove the request, so the code cannot be guessed.
    #[test]
    fn wrong_codes_remove_the_request() {
        let store = CliLoginStore::default();
        let now = Instant::now();
        let started = store.start(request(), client([10, 0, 0, 1]), now).unwrap();
        for _ in 1..MAX_WRONG_CODES {
            // Each wrong code is refused but leaves the request for another try.
            assert_eq!(
                store.begin_approval(&started.id, "AAAA-AAAA", now),
                Err(CliLoginError::WrongCode)
            );
        }
        // The fifth removes it ...
        assert_eq!(
            store.begin_approval(&started.id, "AAAA-AAAA", now),
            Err(CliLoginError::TooManyWrongCodes)
        );
        // ... so even the right code is too late.
        assert_eq!(
            store.begin_approval(&started.id, &started.user_code, now),
            Err(CliLoginError::NotFound)
        );
    }

    /// Requests and an untaken token are dropped after ten minutes.
    #[test]
    fn requests_expire() {
        let store = CliLoginStore::default();
        let now = Instant::now();
        let started = store.start(request(), client([10, 0, 0, 1]), now).unwrap();
        store
            .begin_approval(&started.id, &started.user_code, now)
            .unwrap();
        assert!(store.finish_approval(&started.id, Some(token())));
        // Just before the end the request is still there ...
        assert!(
            store
                .describe(
                    &started.id,
                    now + CLI_LOGIN_LIFETIME - Duration::from_secs(1)
                )
                .is_ok()
        );
        // ... and after it, the request and its token secret are gone.
        assert_eq!(
            store
                .describe(&started.id, now + CLI_LOGIN_LIFETIME)
                .unwrap_err(),
            CliLoginError::NotFound
        );
        assert!(store.lock(now + CLI_LOGIN_LIFETIME).is_empty());
    }

    /// Anonymous callers cannot make the server hold more than a few requests.
    #[test]
    fn pending_requests_are_capped() {
        let store = CliLoginStore::default();
        let now = Instant::now();
        for _ in 0..MAX_PENDING_PER_IP {
            store.start(request(), client([10, 0, 0, 1]), now).unwrap();
        }
        // One address gets only its share.
        assert_eq!(
            store
                .start(request(), client([10, 0, 0, 1]), now)
                .unwrap_err(),
            CliLoginError::TooMany
        );
        // Other addresses fill the rest of the table.
        for last in 2..=(MAX_PENDING / MAX_PENDING_PER_IP) as u8 {
            for _ in 0..MAX_PENDING_PER_IP {
                store
                    .start(request(), client([10, 0, 0, last]), now)
                    .unwrap();
            }
        }
        // Overall the table is bounded too.
        assert_eq!(
            store
                .start(request(), client([10, 0, 0, 200]), now)
                .unwrap_err(),
            CliLoginError::TooMany
        );
        // Expired requests free their slots.
        assert!(
            store
                .start(request(), client([10, 0, 0, 200]), now + CLI_LOGIN_LIFETIME)
                .is_ok()
        );
    }

    /// Requests are kept small whatever an anonymous caller sends.
    #[test]
    fn requests_are_bounded() {
        let store = CliLoginStore::default();
        let now = Instant::now();
        let started = store.start(request(), client([10, 0, 0, 1]), now).unwrap();
        // Repeated permissions are stored once.
        assert_eq!(
            store.describe(&started.id, now).unwrap().token.permissions,
            vec![Permission::FilesRead]
        );
        let mut bad_host = request();
        bad_host.host_name = "evil\u{1b}[2J".to_string();
        // Control characters could not be shown safely, so they are refused.
        assert!(matches!(
            store.start(bad_host, client([10, 0, 0, 1]), now),
            Err(CliLoginError::Invalid(_))
        ));
        let mut many_devices = request();
        many_devices.token.devices = DeviceScope::Only {
            device_ids: (0..=MAX_REQUESTED_DEVICES)
                .map(|index| redoor_protocol::ids::AgentId::unchecked(format!("d{index}")))
                .collect(),
        };
        // A device list beyond the limit is refused.
        assert!(matches!(
            store.start(many_devices, client([10, 0, 0, 1]), now),
            Err(CliLoginError::Invalid(_))
        ));
    }
}
