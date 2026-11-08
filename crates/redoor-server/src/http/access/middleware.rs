//! REST authentication and coarse authorization, run after routing so the route table can
//! key on the matched route template and read its `{agent}` parameter.

use std::net::SocketAddr;

use axum::{
    RequestPartsExt,
    body::Body,
    extract::{ConnectInfo, MatchedPath, RawPathParams, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::{
    Principal, ResolvedDevice,
    routes::{self, Access},
};
use crate::http::{
    auth::{ActiveSession, SessionCheck, sets_session_cookie},
    client_address::ClientAddress,
    error::ApiError,
    session_activity::TransferBody,
    state::ServerState,
};

/// Authenticates the caller, applies the route's access rule and hands the principal to the
/// handler. Layered with `Router::layer`, so it only runs for matched browser routes.
pub(crate) async fn access_control(
    State(state): State<ServerState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(matched) = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
    else {
        return next.run(request).await;
    };
    let access = routes::classify(request.method(), &matched).unwrap_or_else(|| {
        warn_unclassified(request.method(), &matched);
        Access::SessionOnly
    });
    let public = access == Access::Public
        || routes::is_one_time_token_raw_request(request.method(), request.uri());
    // Authenticating before resolving keeps anonymous callers from probing device names.
    let Authenticated {
        principal,
        session,
        recovery_cookie,
    } = if public {
        Authenticated::default()
    } else {
        let client = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(peer)| ClientAddress::new(*peer, request.headers()));
        match authenticate(&state, request.headers(), client.as_ref()).await {
            Ok(authenticated) => authenticated,
            Err(error) => return error.into_response(),
        }
    };
    let (mut parts, body) = request.into_parts();
    // Every handler and the scope check below see the resolved id, never the name the client
    // used, so a renamed device cannot slip past a scope.
    let device = match resolve_device(&state, &mut parts).await {
        Ok(device) => device,
        Err(error) => return error.into_response(),
    };
    if let Some(device) = &device {
        parts.extensions.insert(device.clone());
    }
    let Some(principal) = principal else {
        return next.run(Request::from_parts(parts, body)).await;
    };
    if let Err(error) = authorize(&principal, access, device.as_ref()) {
        return error.into_response();
    }
    // Every log line written while serving the request names who made it.
    let user = Some(std::sync::Arc::from(principal.log_label()));
    parts.extensions.insert(principal);
    // A browser upload or download keeps its session open for as long as its bytes flow:
    // the hold is created before the handler reads the request body and moves into the
    // response body, so it ends when the last byte of either direction is through.
    let transfer = session
        .as_ref()
        .filter(|_| routes::is_session_transfer(&parts.method, &matched))
        .map(|session| state.auth.hold_for_transfer(session));
    if let Some(session) = session {
        parts.extensions.insert(session);
    }
    let mut response =
        redoor_core::logging::user_scope(user, next.run(Request::from_parts(parts, body))).await;
    // Websocket upgrades included, so a browser that missed a rotation recovers on any
    // request. A handler that set its own session cookie wins, because a stale secret after a
    // new session or logout's clearing cookie would sign the browser out.
    if let Some(cookie) = recovery_cookie
        && !sets_session_cookie(response.headers())
    {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    match transfer {
        Some(hold) => response.map(|body| Body::new(TransferBody::new(body, hold))),
        None => response,
    }
}

/// Who a request was authenticated as; empty for public routes.
#[derive(Default)]
struct Authenticated {
    principal: Option<Principal>,
    /// The browser session behind a session principal, for the handlers that renew, hold
    /// or watch it.
    session: Option<ActiveSession>,
    /// `Set-Cookie` re-sending the current secret to a browser that missed a rotation.
    recovery_cookie: Option<HeaderValue>,
}

/// A bearer token alone decides when present, so a stale cookie can never upgrade a rejected
/// token; otherwise the browser session cookie is used. `client` is the caller's address,
/// named in the warning when its cookie turns out to be used by two browsers.
async fn authenticate(
    state: &ServerState,
    headers: &HeaderMap,
    client: Option<&ClientAddress>,
) -> Result<Authenticated, ApiError> {
    if let Some(secret) = bearer_token(headers) {
        return match state.tokens.authenticate(secret).await {
            Some(grant) => Ok(Authenticated {
                principal: Some(Principal::Token(grant)),
                ..Authenticated::default()
            }),
            None => Err(unauthorized("Access token is invalid, expired or revoked")),
        };
    }
    match state.auth.check_session(headers).await {
        SessionCheck::Invalid => Err(unauthorized("Authentication required")),
        SessionCheck::Valid(user, session, recovery_cookie) => Ok(Authenticated {
            principal: Some(Principal::Session(user)),
            session: Some(session),
            recovery_cookie,
        }),
        SessionCheck::Reused(reused) => {
            reused.forget(state, client);
            Err(unauthorized("Authentication required"))
        }
    }
}

/// Extracts the bearer credential shared by REST and `/mcp`, so both accept exactly the same
/// header forms. The scheme is case-insensitive (RFC 9110); an `Authorization` header with
/// another scheme is not a bearer token.
pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, secret) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| secret.trim())
}

/// Resolves the route's `{agent}` parameter (a name or an id) to a known device id; `None`
/// for routes without the parameter.
async fn resolve_device(
    state: &ServerState,
    parts: &mut Parts,
) -> Result<Option<ResolvedDevice>, ApiError> {
    let value = parts
        .extract::<RawPathParams>()
        .await
        .ok()
        .and_then(|params| {
            params
                .iter()
                .find(|(name, _)| *name == "agent")
                .map(|(_, value)| value.to_owned())
        });
    match value {
        Some(value) => Ok(Some(ResolvedDevice(state.agents.resolve(&value).await?))),
        None => Ok(None),
    }
}

/// Applies the coarse route rule; `AnyPrincipal` and `Handler` routes decide in the handler.
fn authorize(
    principal: &Principal,
    access: Access,
    device: Option<&ResolvedDevice>,
) -> Result<(), ApiError> {
    match access {
        Access::Public | Access::AnyPrincipal | Access::Handler => Ok(()),
        Access::SessionOnly => principal.require_session(),
        Access::Device(permissions) => match device {
            Some(ResolvedDevice(agent)) => principal.require(permissions, agent),
            // A device rule on a route without `{agent}` is a table bug: fail closed.
            None => principal.require_session(),
        },
    }
}

/// Builds the 401 body every client already understands.
fn unauthorized(message: &str) -> ApiError {
    ApiError::status(StatusCode::UNAUTHORIZED, message)
}

/// Reminds developers in debug builds that a new API route needs a table entry; release
/// builds stay quiet because the session-only fallback is already safe.
fn warn_unclassified(method: &axum::http::Method, matched: &str) {
    #[cfg(debug_assertions)]
    {
        use std::{
            collections::BTreeSet,
            sync::{Mutex, OnceLock},
        };
        static WARNED: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
        let key = format!("{method} {matched}");
        let first = WARNED
            .get_or_init(Mutex::default)
            .lock()
            .is_ok_and(|mut warned| warned.insert(key.clone()));
        if matched.starts_with("/api/") && first {
            redoor_core::log!(
                redoor_protocol::wire::log::Level::Warning,
                "Route has no access table entry, treating it as session-only: {key}"
            );
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (method, matched);
}

#[cfg(test)]
mod tests {
    use axum::{
        Router,
        extract::{MatchedPath, RawPathParams, Request},
        middleware::{self, Next},
        response::Response,
        routing::get,
    };

    /// Mirrors what `access_control` reads, reporting it back in response headers.
    async fn probe(request: Request, next: Next) -> Response {
        let matched = request
            .extensions()
            .get::<MatchedPath>()
            .map(|matched| matched.as_str().to_owned())
            .unwrap_or_default();
        let (mut parts, body) = request.into_parts();
        let agent = axum::RequestPartsExt::extract::<RawPathParams>(&mut parts)
            .await
            .ok()
            .and_then(|params| {
                params
                    .iter()
                    .find(|(name, _)| *name == "agent")
                    .map(|(_, value)| value.to_owned())
            })
            .unwrap_or_default();
        let mut response = next.run(Request::from_parts(parts, body)).await;
        response
            .headers_mut()
            .insert("x-matched", matched.parse().unwrap());
        response
            .headers_mut()
            .insert("x-agent", agent.parse().unwrap());
        response
    }

    /// REST and MCP share this parser, so the accepted header forms are pinned here once.
    #[test]
    fn bearer_token_parsing() {
        let parse = |value: &str| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(axum::http::header::AUTHORIZATION, value.parse().unwrap());
            super::bearer_token(&headers).map(str::to_owned)
        };
        // The canonical form yields the secret.
        assert_eq!(parse("Bearer abc").as_deref(), Some("abc"));
        // The scheme is case-insensitive, as HTTP requires.
        assert_eq!(parse("bearer abc").as_deref(), Some("abc"));
        // Surrounding whitespace is not part of the secret.
        assert_eq!(parse("Bearer  abc ").as_deref(), Some("abc"));
        // Other schemes are not bearer tokens, so the cookie path stays in charge.
        assert_eq!(parse("Basic abc"), None);
        assert_eq!(parse("Bearerabc"), None);
        // No header at all is no token.
        assert_eq!(super::bearer_token(&axum::http::HeaderMap::new()), None);
    }

    /// The design depends on `Router::layer` middleware seeing the matched template and the
    /// decoded `{agent}` parameter; this proves it with a real router.
    #[tokio::test]
    async fn layer_middleware_sees_matched_path_and_params() {
        let app = Router::new()
            .route("/api/v1/agents/{agent}/ls/{*path}", get(|| async { "ok" }))
            .layer(middleware::from_fn(probe));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = reqwest::get(format!(
            "http://{address}/api/v1/agents/my%20agent/ls/tmp/x"
        ))
        .await
        .unwrap();
        // The template, not the concrete path, is what the access table is keyed on.
        assert_eq!(
            response.headers()["x-matched"],
            "/api/v1/agents/{agent}/ls/{*path}"
        );
        // The agent parameter arrives percent-decoded, matching the ids in token scopes.
        assert_eq!(response.headers()["x-agent"], "my agent");
        server.abort();
    }
}
