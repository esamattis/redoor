//! Browser sign-in through an OpenID Connect provider.
//!
//! Implements the authorization code flow with PKCE for a confidential client. A successful
//! sign-in ends in the same server-side session the password login creates, so every other
//! route keeps its existing authentication. Agent connections and access tokens never touch
//! this module.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use redoor_core::config::OidcConfig;
use redoor_core::{log, log_error};
use redoor_protocol::api::auth::{LoginMethodsResponse, OidcLoginMethod};
use redoor_protocol::wire::log::Level;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::{auth::SessionMethod, error::ApiError, state::ServerState};

/// Cookie binding a pending sign-in to the browser that started it, so a callback URL
/// opened in another browser (login CSRF) cannot complete it.
const STATE_COOKIE_NAME: &str = "redoor_oidc_state";
/// Scope of the state cookie; only the OIDC routes need it.
const STATE_COOKIE_PATH: &str = "/api/v1/auth/oidc";
/// Time allowed for the round trip through the provider, including a passkey prompt.
const PENDING_LOGIN_LIFETIME: Duration = Duration::from_secs(10 * 60);
/// Bounds memory used by unauthenticated callers starting sign-ins they never finish.
const MAX_PENDING_LOGINS: usize = 1_024;
/// Keeps a hung provider from tying up sign-in requests indefinitely.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

/// Talks to one configured provider and remembers sign-ins that are in progress.
pub(crate) struct OidcClient {
    config: OidcConfig,
    http: reqwest::Client,
    /// Provider metadata, fetched on first use so a provider outage cannot stop the server
    /// from starting. Failed fetches are not cached and are retried on the next sign-in.
    discovery: tokio::sync::OnceCell<Discovery>,
    /// Keyed by the `state` parameter. Kept in memory: a restart only cancels sign-ins that
    /// are mid-flight, and nothing secret ever has to be written to disk.
    pending: Mutex<HashMap<String, PendingLogin>>,
}

/// The subset of the provider's discovery document this flow needs.
#[derive(Clone, Debug, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

impl Discovery {
    /// The issuer was checked at startup, but the endpoints come from the provider. The ID
    /// token is trusted without a signature check only because it arrives over TLS, so a
    /// plain HTTP endpoint must never receive the code, verifier or client secret.
    fn check_endpoints(&self) -> anyhow::Result<()> {
        for endpoint in [&self.authorization_endpoint, &self.token_endpoint] {
            if !OidcConfig::is_secure_url(&url::Url::parse(endpoint)?) {
                anyhow::bail!("insecure endpoint '{endpoint}'");
            }
        }
        Ok(())
    }
}

/// Secrets of one sign-in between the redirect to the provider and its callback.
struct PendingLogin {
    nonce: String,
    pkce_verifier: String,
    /// Same-origin path to open after sign-in, already validated.
    return_path: String,
    expires_at: Instant,
}

/// Values the ID token must match for the sign-in that requested it.
struct ExpectedToken<'a> {
    issuer: &'a str,
    client_id: &'a str,
    nonce: &'a str,
    /// `None` when the config allows every account.
    allowed_groups: Option<&'a [String]>,
}

/// Claims read from the ID token.
#[derive(Deserialize)]
struct IdTokenClaims {
    iss: String,
    sub: String,
    aud: Audience,
    exp: i64,
    azp: Option<String>,
    nonce: Option<String>,
    preferred_username: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
}

/// `aud` may be a single string or a list (OIDC Core 2).
#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

/// The person who signed in, for the audit log line.
#[derive(Debug, PartialEq, Eq)]
struct SignedInUser {
    subject: String,
    username: Option<String>,
}

/// Why an ID token was refused. `NotAllowed` is the only outcome users can fix themselves,
/// so it is the only one reported distinctly to the browser.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
enum IdTokenError {
    #[error("ID token is malformed")]
    Malformed,
    #[error("ID token was issued by '{0}'")]
    Issuer(String),
    #[error("ID token is for another client")]
    Audience,
    #[error("ID token has expired")]
    Expired,
    #[error("ID token nonce does not match the sign-in request")]
    Nonce,
    /// Carries the token's groups next to the configured ones so an admin can see from the
    /// log alone whether the provider sent the wrong groups or the config lists the wrong ones.
    #[error(
        "subject '{subject}' (username '{}') is not in an allowed group: token groups [{}], allowed groups [{}]",
        .username.as_deref().unwrap_or("-"),
        .groups.join(", "),
        .allowed.join(", ")
    )]
    NotAllowed {
        subject: String,
        username: Option<String>,
        groups: Vec<String>,
        allowed: Vec<String>,
    },
}

/// Short codes passed to the login page, which maps them to fixed messages. Codes instead
/// of free text so a crafted link cannot put arbitrary wording on the login page.
#[derive(Clone, Copy)]
enum SignInFailure {
    /// The provider could not be reached or answered unexpectedly.
    Unavailable,
    /// The account is not allowed to use this server.
    Denied,
    /// The sign-in took too long or was started in another browser.
    Expired,
    /// Anything else; details are only in the server log.
    Failed,
}

impl SignInFailure {
    /// Query value understood by the login page.
    fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }
}

impl OidcClient {
    /// Builds the client without contacting the provider, so startup never depends on it.
    pub(crate) fn new(config: OidcConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(PROVIDER_TIMEOUT)
            // Discovery and token responses are never legitimately redirected; following one
            // could send the client secret somewhere unexpected.
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        if config.allowed_groups.is_none() {
            // Shell access for every account at the provider is a deliberate choice, but one
            // an operator should see stated at startup rather than discover later.
            log!(
                Level::Warning,
                "server.oidc.allowed_groups is not set: every account that signs in at {} may use this server",
                config.issuer
            );
        }
        Ok(Self {
            config,
            http,
            discovery: tokio::sync::OnceCell::new(),
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Fetches and caches the provider metadata, refusing a document for another issuer.
    async fn discovery(&self) -> anyhow::Result<&Discovery> {
        self.discovery
            .get_or_try_init(|| async {
                let url = format!(
                    "{}/.well-known/openid-configuration",
                    self.config.issuer.trim_end_matches('/')
                );
                let response = self.http.get(&url).send().await?.error_for_status()?;
                let discovery: Discovery = serde_json::from_slice(&response.bytes().await?)?;
                if !same_issuer(&discovery.issuer, &self.config.issuer) {
                    anyhow::bail!(
                        "discovery document at {url} names issuer '{}', expected '{}'",
                        discovery.issuer,
                        self.config.issuer
                    );
                }
                discovery
                    .check_endpoints()
                    .map_err(|error| anyhow::anyhow!("discovery document at {url}: {error}"))?;
                Ok(discovery)
            })
            .await
    }

    /// Records a new pending sign-in and returns the provider URL plus its `state` value.
    async fn start(&self, return_path: String) -> anyhow::Result<(String, String)> {
        let discovery = self.discovery().await?;
        let state = random_token()?;
        let login = PendingLogin {
            nonce: random_token()?,
            pkce_verifier: random_token()?,
            return_path,
            expires_at: Instant::now() + PENDING_LOGIN_LIFETIME,
        };
        let mut url = url::Url::parse(&discovery.authorization_endpoint)?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", self.config.redirect_url.as_str())
            .append_pair("scope", &self.config.scopes.join(" "))
            .append_pair("state", &state)
            .append_pair("nonce", &login.nonce)
            .append_pair("code_challenge", &pkce_challenge(&login.pkce_verifier))
            .append_pair("code_challenge_method", "S256");
        self.remember(state.clone(), login, Instant::now())?;
        Ok((url.into(), state))
    }

    /// Stores a pending sign-in, dropping expired ones first so the cap only bites under abuse.
    fn remember(&self, state: String, login: PendingLogin, now: Instant) -> anyhow::Result<()> {
        let mut pending = self.pending.lock().expect("pending OIDC logins poisoned");
        pending.retain(|_, login| login.expires_at > now);
        if pending.len() >= MAX_PENDING_LOGINS {
            anyhow::bail!("too many sign-ins in progress");
        }
        pending.insert(state, login);
        Ok(())
    }

    /// Removes and returns a pending sign-in, so each `state` can complete at most once.
    fn take(&self, state: &str, now: Instant) -> Option<PendingLogin> {
        self.pending
            .lock()
            .expect("pending OIDC logins poisoned")
            .remove(state)
            .filter(|login| login.expires_at > now)
    }

    /// Redeems the authorization code and returns the raw ID token.
    async fn redeem(&self, login: &PendingLogin, code: &str) -> anyhow::Result<String> {
        let discovery = self.discovery().await?;
        let secret_in_body = prefers_client_secret_post(discovery);
        let mut request = self
            .http
            .post(&discovery.token_endpoint)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(header::ACCEPT, "application/json")
            .body(self.token_request_body(login, code, secret_in_body));
        if !secret_in_body {
            // RFC 6749 2.3.1: both halves are form-encoded before Basic encoding.
            let encode = |value: &str| {
                url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
            };
            request = request.basic_auth(
                encode(&self.config.client_id),
                Some(encode(&self.config.client_secret)),
            );
        }
        let response = request.send().await?;
        let status = response.status();
        let body = response.bytes().await?;
        if !status.is_success() {
            // Token endpoint errors carry only an error code and description, never tokens.
            let detail = String::from_utf8_lossy(&body[..body.len().min(512)]).into_owned();
            anyhow::bail!("token endpoint answered {status}: {detail}");
        }
        #[derive(Deserialize)]
        struct TokenResponse {
            id_token: String,
        }
        Ok(serde_json::from_slice::<TokenResponse>(&body)?.id_token)
    }

    /// Form body of the token request. Built synchronously because the serializer is not
    /// `Send` and must not live across an await in a handler future.
    fn token_request_body(&self, login: &PendingLogin, code: &str, secret_in_body: bool) -> String {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", self.config.redirect_url.as_str())
            .append_pair("code_verifier", &login.pkce_verifier);
        if secret_in_body {
            form.append_pair("client_id", &self.config.client_id)
                .append_pair("client_secret", &self.config.client_secret);
        }
        form.finish()
    }

    /// Settings handed to the ID token check for one sign-in.
    fn expected<'a>(
        &'a self,
        discovery: &'a Discovery,
        login: &'a PendingLogin,
    ) -> ExpectedToken<'a> {
        ExpectedToken {
            issuer: &discovery.issuer,
            client_id: &self.config.client_id,
            nonce: &login.nonce,
            allowed_groups: self.config.allowed_groups.as_deref(),
        }
    }
}

/// Checks the ID token's claims.
///
/// The token comes straight from the token endpoint over TLS in exchange for a code bound to
/// our PKCE verifier and client secret, so OIDC Core 3.1.3.7 allows skipping the signature
/// check; every claim that decides who signed in is still verified.
fn validate_id_token(
    id_token: &str,
    expected: &ExpectedToken<'_>,
    now: i64,
) -> Result<SignedInUser, IdTokenError> {
    let payload = id_token.split('.').nth(1).ok_or(IdTokenError::Malformed)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| IdTokenError::Malformed)?;
    let claims: IdTokenClaims =
        serde_json::from_slice(&payload).map_err(|_| IdTokenError::Malformed)?;
    if claims.iss != expected.issuer {
        return Err(IdTokenError::Issuer(claims.iss));
    }
    let audience_ok = match &claims.aud {
        Audience::One(audience) => audience == expected.client_id,
        Audience::Many(audiences) => audiences
            .iter()
            .any(|audience| audience == expected.client_id),
    };
    // With several audiences the authorized party must be us (OIDC Core 3.1.3.7 steps 4-5).
    let multiple_audiences =
        matches!(&claims.aud, Audience::Many(audiences) if audiences.len() > 1);
    let azp_ok = match claims.azp.as_deref() {
        Some(azp) => azp == expected.client_id,
        None => !multiple_audiences,
    };
    if !audience_ok || !azp_ok {
        return Err(IdTokenError::Audience);
    }
    if claims.exp <= now {
        return Err(IdTokenError::Expired);
    }
    let nonce_ok = claims
        .nonce
        .as_deref()
        .is_some_and(|nonce| bool::from(nonce.as_bytes().ct_eq(expected.nonce.as_bytes())));
    if !nonce_ok {
        return Err(IdTokenError::Nonce);
    }
    // Checked here as well as at the provider, so a provider-side misconfiguration cannot
    // hand shell access to an account outside the configured groups.
    if let Some(allowed) = expected.allowed_groups
        && !claims.groups.iter().any(|group| allowed.contains(group))
    {
        return Err(IdTokenError::NotAllowed {
            subject: claims.sub,
            username: claims.preferred_username,
            groups: claims.groups,
            allowed: allowed.to_vec(),
        });
    }
    Ok(SignedInUser {
        subject: claims.sub,
        username: claims.preferred_username,
    })
}

/// Compares issuers while tolerating a trailing slash difference between config and provider.
fn same_issuer(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

/// Basic authentication is the spec default; switch only when the provider says it lacks it.
fn prefers_client_secret_post(discovery: &Discovery) -> bool {
    discovery
        .token_endpoint_auth_methods_supported
        .as_ref()
        .is_some_and(|methods| {
            !methods.iter().any(|method| method == "client_secret_basic")
                && methods.iter().any(|method| method == "client_secret_post")
        })
}

/// 256 random bits, URL-safe, for `state`, `nonce` and the PKCE verifier.
fn random_token() -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow::anyhow!("failed to read OS randomness: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// S256 PKCE challenge (RFC 7636 4.2).
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Accepts only same-origin absolute paths, so the post-login redirect cannot leave the site.
fn safe_return_path(value: Option<&str>) -> String {
    match value {
        Some(path)
            if path.starts_with('/')
                && !path.starts_with("//")
                && !path.starts_with("/\\")
                // Browsers strip tabs and newlines from URLs, so "/\t/evil" would become
                // the protocol-relative "//evil" after the checks above.
                && !path.chars().any(|c| c.is_ascii_control())
                && HeaderValue::from_str(path).is_ok() =>
        {
            path.to_string()
        }
        _ => "/".to_string(),
    }
}

/// Reads the state cookie set when this browser started the sign-in.
fn state_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(name, value)| (name == STATE_COOKIE_NAME).then_some(value))
}

/// Builds a state cookie value; an empty value with `max_age` 0 deletes it.
fn state_set_cookie(state: &ServerState, value: &str, max_age: Duration) -> HeaderValue {
    let cookie = format!(
        "{STATE_COOKIE_NAME}={value}; HttpOnly; SameSite=Lax; Path={STATE_COOKIE_PATH}{}; Max-Age={}",
        state.auth.secure_flag(),
        max_age.as_secs()
    );
    HeaderValue::from_str(&cookie).expect("generated cookie contains only safe ASCII")
}

/// A `303 See Other` to `location`, the right status after a GET that changed server state.
fn see_other(location: &str) -> Response {
    let mut response = StatusCode::SEE_OTHER.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(location).unwrap_or(HeaderValue::from_static("/")),
    );
    response
}

/// Sends the browser back to the login page with a failure code, clearing the state cookie.
fn fail(state: &ServerState, failure: SignInFailure, return_path: &str) -> Response {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("redirect", return_path)
        .append_pair("oidc_error", failure.code())
        .finish();
    let mut response = see_other(&format!("/login?{query}"));
    response.headers_mut().append(
        header::SET_COOKIE,
        state_set_cookie(state, "", Duration::ZERO),
    );
    response
}

/// Answers 404 for the OIDC routes when OIDC is not configured, as if they did not exist.
fn not_configured() -> Response {
    ApiError::status(StatusCode::NOT_FOUND, "OIDC sign-in is not configured").into_response()
}

/// Lists the sign-in methods for the public login page.
pub(crate) async fn login_methods_handler(State(state): State<ServerState>) -> Response {
    Json(LoginMethodsResponse {
        oidc: state.oidc.as_ref().map(|client| OidcLoginMethod {
            provider_name: client.config.provider_name.clone(),
        }),
    })
    .into_response()
}

/// Query of the sign-in start route.
#[derive(Deserialize)]
pub(crate) struct LoginQuery {
    /// Path to return to after signing in, as the password form's `redirect` parameter.
    redirect: Option<String>,
}

/// Starts sign-in: remembers the attempt and redirects the browser to the provider.
pub(crate) async fn oidc_login_handler(
    State(state): State<ServerState>,
    Query(query): Query<LoginQuery>,
) -> Response {
    let Some(client) = state.oidc.clone() else {
        return not_configured();
    };
    let return_path = safe_return_path(query.redirect.as_deref());
    match client.start(return_path.clone()).await {
        Ok((authorization_url, login_state)) => {
            let mut response = see_other(&authorization_url);
            response.headers_mut().append(
                header::SET_COOKIE,
                state_set_cookie(&state, &login_state, PENDING_LOGIN_LIFETIME),
            );
            response
        }
        Err(error) => {
            log_error!(error, "Failed to start OIDC sign-in");
            fail(&state, SignInFailure::Unavailable, &return_path)
        }
    }
}

/// Query the provider appends to the redirect URL.
#[derive(Deserialize)]
pub(crate) struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Finishes sign-in: checks the state, redeems the code, checks the ID token and creates
/// the browser session.
pub(crate) async fn oidc_callback_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(client) = state.oidc.clone() else {
        return not_configured();
    };
    // The state must match this browser's cookie, which proves the same browser started
    // the sign-in, and then name a pending attempt, which makes every attempt single-use.
    let cookie_matches = match (query.state.as_deref(), state_cookie(&headers)) {
        (Some(query_state), Some(cookie_state)) => {
            bool::from(query_state.as_bytes().ct_eq(cookie_state.as_bytes()))
        }
        _ => false,
    };
    let login = query
        .state
        .as_deref()
        .filter(|_| cookie_matches)
        .and_then(|login_state| client.take(login_state, Instant::now()));
    let Some(login) = login else {
        return fail(&state, SignInFailure::Expired, "/");
    };
    if let Some(error) = query.error {
        log!(
            Level::Warning,
            "OIDC provider refused sign-in: error={error}"
        );
        let failure = if error == "access_denied" {
            SignInFailure::Denied
        } else {
            SignInFailure::Failed
        };
        return fail(&state, failure, &login.return_path);
    }
    let Some(code) = query.code else {
        return fail(&state, SignInFailure::Failed, &login.return_path);
    };
    let id_token = match client.redeem(&login, &code).await {
        Ok(id_token) => id_token,
        Err(error) => {
            log_error!(error, "Failed to redeem OIDC authorization code");
            return fail(&state, SignInFailure::Unavailable, &login.return_path);
        }
    };
    let Some(discovery) = client.discovery.get() else {
        return fail(&state, SignInFailure::Unavailable, &login.return_path);
    };
    let user = match validate_id_token(
        &id_token,
        &client.expected(discovery, &login),
        jiff::Timestamp::now().as_second(),
    ) {
        Ok(user) => user,
        Err(error) => {
            log!(Level::Warning, "OIDC sign-in rejected: {error}");
            let failure = match error {
                IdTokenError::NotAllowed { .. } => SignInFailure::Denied,
                _ => SignInFailure::Failed,
            };
            return fail(&state, failure, &login.return_path);
        }
    };
    let session = match state.auth.create_session(SessionMethod::Oidc).await {
        Ok(session) => session,
        Err(error) => {
            log_error!(error, "Failed to create session");
            return fail(&state, SignInFailure::Failed, &login.return_path);
        }
    };
    log!(
        Level::Info,
        "OIDC sign-in: subject={}, preferred_username={}, account={}",
        user.subject,
        user.username.as_deref().unwrap_or("-"),
        session.username
    );
    let mut response = see_other(&login.return_path);
    let response_headers = response.headers_mut();
    response_headers.append(header::SET_COOKIE, session.cookie);
    response_headers.append(
        header::SET_COOKIE,
        state_set_cookie(&state, "", Duration::ZERO),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    /// Builds an unsigned token; the signature is never inspected.
    fn token(claims: serde_json::Value) -> String {
        format!(
            "eyJhbGciOiJSUzI1NiJ9.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        )
    }

    /// Claims a well-behaved provider would issue for an allowed user.
    fn claims() -> serde_json::Value {
        serde_json::json!({
            "iss": "https://id.example.org",
            "sub": "user-1",
            "aud": "redoor",
            "exp": NOW + 60,
            "nonce": "nonce-1",
            "preferred_username": "alice",
            "groups": ["admins", "family"],
        })
    }

    /// Validates against the expectations of the sign-in that sent `nonce-1`.
    fn validate(claims: serde_json::Value) -> Result<SignedInUser, IdTokenError> {
        let groups = vec!["admins".to_string()];
        validate_id_token(
            &token(claims),
            &ExpectedToken {
                issuer: "https://id.example.org",
                client_id: "redoor",
                nonce: "nonce-1",
                allowed_groups: Some(&groups),
            },
            NOW,
        )
    }

    /// A token with every claim right identifies the user.
    #[test]
    fn accepts_valid_id_token() {
        // The audit log needs both the stable subject and the readable username.
        assert_eq!(
            validate(claims()),
            Ok(SignedInUser {
                subject: "user-1".to_string(),
                username: Some("alice".to_string()),
            })
        );
        let mut many = claims();
        many["aud"] = serde_json::json!(["redoor", "other"]);
        many["azp"] = serde_json::json!("redoor");
        // Several audiences are fine when this client is the authorized party.
        assert!(validate(many).is_ok());
    }

    /// Without `allowed_groups` the groups claim is not consulted at all.
    #[test]
    fn accepts_any_groups_when_unrestricted() {
        let expected = ExpectedToken {
            issuer: "https://id.example.org",
            client_id: "redoor",
            nonce: "nonce-1",
            allowed_groups: None,
        };
        let mut other_groups = claims();
        other_groups["groups"] = serde_json::json!(["family"]);
        // Any group is allowed in when the config names none.
        assert!(validate_id_token(&token(other_groups), &expected, NOW).is_ok());
        let mut no_groups = claims();
        no_groups.as_object_mut().unwrap().remove("groups");
        // A provider that does not release groups must work without a restriction.
        assert!(validate_id_token(&token(no_groups), &expected, NOW).is_ok());
    }

    /// Each claim that decides who signed in is enforced on its own.
    #[test]
    fn rejects_bad_claims() {
        let cases = [
            ("iss", serde_json::json!("https://evil.example.org")),
            ("aud", serde_json::json!(["other"])),
            ("exp", serde_json::json!(NOW)),
            ("nonce", serde_json::json!("nonce-2")),
            ("groups", serde_json::json!(["family"])),
        ];
        for (key, value) in cases {
            let mut claims = claims();
            claims[key] = value;
            // A single wrong claim must be enough to refuse the sign-in.
            assert!(validate(claims).is_err(), "{key} should be rejected");
        }
        let mut no_groups = claims();
        no_groups.as_object_mut().unwrap().remove("groups");
        // A provider that omits groups must not be treated as "no restriction".
        assert_eq!(
            validate(no_groups),
            Err(IdTokenError::NotAllowed {
                subject: "user-1".to_string(),
                username: Some("alice".to_string()),
                groups: vec![],
                allowed: vec!["admins".to_string()],
            })
        );
        let mut wrong_groups = claims();
        wrong_groups["groups"] = serde_json::json!(["family", "guests"]);
        // The log line must show both group lists so a denied sign-in can be diagnosed.
        assert_eq!(
            validate(wrong_groups).unwrap_err().to_string(),
            "subject 'user-1' (username 'alice') is not in an allowed group: token groups [family, guests], allowed groups [admins]"
        );
        let mut no_nonce = claims();
        no_nonce.as_object_mut().unwrap().remove("nonce");
        // Without a nonce a token could be replayed from another sign-in.
        assert_eq!(validate(no_nonce), Err(IdTokenError::Nonce));
        let mut foreign_party = claims();
        foreign_party["aud"] = serde_json::json!(["redoor", "other"]);
        // With several audiences and no azp, the token may have been meant for the other client.
        assert_eq!(validate(foreign_party), Err(IdTokenError::Audience));
        // Garbage instead of a JWT is refused without panicking.
        assert_eq!(
            validate_id_token(
                "not-a-jwt",
                &ExpectedToken {
                    issuer: "",
                    client_id: "",
                    nonce: "",
                    allowed_groups: None,
                },
                NOW
            ),
            Err(IdTokenError::Malformed)
        );
    }

    /// Builds a client for a provider that never needs to be contacted.
    fn client() -> OidcClient {
        OidcClient::new(OidcConfig {
            issuer: "https://id.example.org".to_string(),
            client_id: "redoor".to_string(),
            client_secret: "secret".to_string(),
            redirect_url: "https://redoor.example.org/api/v1/auth/oidc/callback"
                .parse()
                .unwrap(),
            allowed_groups: Some(vec!["admins".to_string()]),
            scopes: vec!["openid".to_string()],
            provider_name: "Example".to_string(),
            session_lifetime: Duration::from_secs(60),
        })
        .unwrap()
    }

    /// A pending sign-in that expires at `expires_at`.
    fn pending(expires_at: Instant) -> PendingLogin {
        PendingLogin {
            nonce: "n".to_string(),
            pkce_verifier: "v".to_string(),
            return_path: "/".to_string(),
            expires_at,
        }
    }

    /// A state value completes once, and only before it expires.
    #[test]
    fn pending_logins_are_single_use_and_expire() {
        let client = client();
        let now = Instant::now();
        client
            .remember("a".to_string(), pending(now + PENDING_LOGIN_LIFETIME), now)
            .unwrap();
        // The first callback with the state finds its sign-in.
        assert!(client.take("a", now).is_some());
        // Replaying the same callback finds nothing.
        assert!(client.take("a", now).is_none());
        client
            .remember("b".to_string(), pending(now + PENDING_LOGIN_LIFETIME), now)
            .unwrap();
        // A callback arriving after the deadline is refused.
        assert!(client.take("b", now + PENDING_LOGIN_LIFETIME).is_none());
        // Unknown states are refused.
        assert!(client.take("unknown", now).is_none());
    }

    /// Abandoned sign-ins cannot grow memory without bound, but expired ones make room.
    #[test]
    fn pending_logins_are_capped() {
        let client = client();
        let now = Instant::now();
        for index in 0..MAX_PENDING_LOGINS {
            client
                .remember(
                    index.to_string(),
                    pending(now + Duration::from_secs(1)),
                    now,
                )
                .unwrap();
        }
        // A full table refuses new attempts instead of evicting live ones.
        assert!(
            client
                .remember(
                    "extra".to_string(),
                    pending(now + PENDING_LOGIN_LIFETIME),
                    now
                )
                .is_err()
        );
        // Once the old attempts expire, new sign-ins work again.
        assert!(
            client
                .remember(
                    "extra".to_string(),
                    pending(now + PENDING_LOGIN_LIFETIME),
                    now + Duration::from_secs(1)
                )
                .is_ok()
        );
    }

    /// The authorization request carries PKCE, the nonce, and the exact redirect URL.
    #[tokio::test]
    async fn authorization_url_uses_pkce() {
        let client = client();
        client
            .discovery
            .set(Discovery {
                issuer: "https://id.example.org".to_string(),
                authorization_endpoint: "https://id.example.org/authorize".to_string(),
                token_endpoint: "https://id.example.org/token".to_string(),
                token_endpoint_auth_methods_supported: None,
            })
            .unwrap();
        let (url, state) = client.start("/agents".to_string()).await.unwrap();
        let url = url::Url::parse(&url).unwrap();
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        let login = client.take(&state, Instant::now()).unwrap();
        // The provider needs the state back to match the callback to this attempt.
        assert_eq!(query["state"], state);
        // The challenge proves possession of the verifier only the server knows.
        assert_eq!(
            query["code_challenge"],
            pkce_challenge(&login.pkce_verifier)
        );
        assert_eq!(query["code_challenge_method"], "S256");
        // The nonce ties the ID token to this attempt.
        assert_eq!(query["nonce"], login.nonce);
        // The redirect must match the URL registered at the provider exactly.
        assert_eq!(
            query["redirect_uri"],
            "https://redoor.example.org/api/v1/auth/oidc/callback"
        );
        // The validated return path survives the round trip.
        assert_eq!(login.return_path, "/agents");
    }

    /// The return path can never send the browser to another site.
    #[test]
    fn return_path_stays_on_site() {
        // Normal application paths, with their query, are kept.
        assert_eq!(safe_return_path(Some("/transfers?x=1")), "/transfers?x=1");
        for hostile in [
            "https://evil.example",
            "//evil.example",
            "/\\evil.example",
            "/\t/evil.example",
            "/\n/evil.example",
            "evil",
        ] {
            // Absolute and protocol-relative URLs, including ones a browser only forms after
            // stripping control characters, fall back to the home page.
            assert_eq!(safe_return_path(Some(hostile)), "/", "{hostile}");
        }
        // Missing values go home.
        assert_eq!(safe_return_path(None), "/");
    }

    /// Discovered endpoints must meet the same transport rule as the configured issuer.
    #[test]
    fn discovery_endpoints_must_be_secure() {
        let discovery = |authorization: &str, token: &str| Discovery {
            issuer: String::new(),
            authorization_endpoint: authorization.to_string(),
            token_endpoint: token.to_string(),
            token_endpoint_auth_methods_supported: None,
        };
        // HTTPS endpoints and loopback test providers are accepted.
        assert!(
            discovery("https://id.example/authorize", "https://id.example/token")
                .check_endpoints()
                .is_ok()
        );
        assert!(
            discovery(
                "http://127.0.0.1:9000/authorize",
                "http://localhost:9000/token"
            )
            .check_endpoints()
            .is_ok()
        );
        // A plain HTTP token endpoint would expose the secret and let the token be altered.
        assert!(
            discovery("https://id.example/authorize", "http://id.example/token")
                .check_endpoints()
                .is_err()
        );
        // A plain HTTP authorization endpoint would expose the code and state.
        assert!(
            discovery("http://id.example/authorize", "https://id.example/token")
                .check_endpoints()
                .is_err()
        );
    }

    /// Only an explicit lack of Basic support switches to secrets in the body.
    #[test]
    fn token_endpoint_auth_method() {
        let discovery = |methods: Option<Vec<&str>>| Discovery {
            issuer: String::new(),
            authorization_endpoint: String::new(),
            token_endpoint: String::new(),
            token_endpoint_auth_methods_supported: methods
                .map(|methods| methods.into_iter().map(str::to_string).collect()),
        };
        // The spec default applies when the provider says nothing.
        assert!(!prefers_client_secret_post(&discovery(None)));
        // Basic wins when both are offered.
        assert!(!prefers_client_secret_post(&discovery(Some(vec![
            "client_secret_post",
            "client_secret_basic"
        ]))));
        // Post is used only when Basic is unavailable.
        assert!(prefers_client_secret_post(&discovery(Some(vec![
            "client_secret_post"
        ]))));
    }
}
