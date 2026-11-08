//! REST handlers for access token management and a token's view of itself.

use axum::{
    Extension, Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use jiff::Timestamp;
use redoor_protocol::api::{
    ApiErrorCode,
    tokens::{
        AccessTokenListResponse, AccessTokenSecretResponse, CreateAccessTokenRequest,
        DeleteAccessTokenResponse, DeviceScope, UpdateAccessTokenRequest,
    },
};
use uuid::Uuid;

use super::store::{IssuedToken, TokenPolicy};
use crate::http::{access::Principal, auth::ActiveSession, error::ApiError, state::ServerState};

/// Route: `GET /api/v1/tokens` lists every token's metadata.
pub(crate) async fn list(State(state): State<ServerState>) -> Response {
    no_store(Json(AccessTokenListResponse {
        tokens: state.tokens.list().await,
    }))
}

/// Route: `POST /api/v1/tokens` mints a token and returns its secret once. Needs a fresh
/// sign-in ([`require_fresh_login`]).
pub(crate) async fn create(
    State(state): State<ServerState>,
    session: Option<Extension<ActiveSession>>,
    headers: HeaderMap,
    Json(request): Json<CreateAccessTokenRequest>,
) -> Result<Response, ApiError> {
    validate_mutation_origin(&headers)?;
    require_fresh_login(session.as_deref())?;
    Ok(no_store(Json(mint(&state, request).await?)))
}

/// Creates a token from a creation request and returns its only copy of the secret. Shared
/// by `POST /api/v1/tokens` and the CLI login approval, so both validate the same way; the
/// callers check the fresh sign-in first.
pub(crate) async fn mint(
    state: &ServerState,
    request: CreateAccessTokenRequest,
) -> Result<AccessTokenSecretResponse, ApiError> {
    let expires_at = request
        .expires_at
        .as_deref()
        .map(|value| {
            value
                .parse::<Timestamp>()
                .map_err(|_| ApiError::bad_request("Token expiry must be an RFC 3339 timestamp"))
        })
        .transpose()?;
    let devices = resolve_scope(state, request.devices).await?;
    let issued = state
        .tokens
        .create(
            TokenPolicy {
                name: request.name,
                permissions: request.permissions,
                devices,
            },
            expires_at,
        )
        .await?;
    Ok(secret(issued))
}

/// Refuses to hand out a token secret unless the session's credentials were checked within
/// the last minute ([`crate::http::auth::TOKEN_FRESHNESS`]). A copied browser profile holds
/// an older session, and signing in again needs the credentials, so it cannot turn its
/// short window into a token that outlives the session. 403 with its own code, so the UI
/// sends the user through the sign-in instead of treating it as a signed-out session.
pub(crate) fn require_fresh_login(session: Option<&ActiveSession>) -> Result<(), ApiError> {
    let now = Timestamp::now().as_second();
    if session.is_some_and(|session| session.fresh_login_seconds_left(now) > 0) {
        return Ok(());
    }
    Err(ApiError::coded(
        StatusCode::FORBIDDEN,
        ApiErrorCode::FreshLoginRequired,
        "Sign in again to create an access token: the last sign-in was more than a minute ago",
    ))
}

/// Route: `PUT /api/v1/tokens/{token_id}` replaces the policy without changing the secret.
pub(crate) async fn update(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(token_id): Path<String>,
    Json(request): Json<UpdateAccessTokenRequest>,
) -> Result<Response, ApiError> {
    validate_mutation_origin(&headers)?;
    let id = parse_id(&token_id)?;
    let devices = resolve_scope(&state, request.devices).await?;
    let metadata = state
        .tokens
        .update(
            id,
            TokenPolicy {
                name: request.name,
                permissions: request.permissions,
                devices,
            },
        )
        .await?;
    Ok(no_store(Json(metadata)))
}

/// Route: `POST /api/v1/tokens/{token_id}/rotate` issues a new secret for the same token.
/// Hands out a secret like creation, so it needs a fresh sign-in too.
pub(crate) async fn rotate(
    State(state): State<ServerState>,
    session: Option<Extension<ActiveSession>>,
    headers: HeaderMap,
    Path(token_id): Path<String>,
) -> Result<Response, ApiError> {
    validate_mutation_origin(&headers)?;
    require_fresh_login(session.as_deref())?;
    let issued = state.tokens.rotate(parse_id(&token_id)?).await?;
    Ok(no_store(Json(secret(issued))))
}

/// Route: `DELETE /api/v1/tokens/{token_id}` revokes a token immediately.
pub(crate) async fn delete(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Path(token_id): Path<String>,
) -> Result<Response, ApiError> {
    validate_mutation_origin(&headers)?;
    state.tokens.delete(parse_id(&token_id)?).await?;
    Ok(no_store(Json(DeleteAccessTokenResponse { deleted: true })))
}

/// Route: `GET /api/v1/tokens/current` lets a token learn its own permissions (CLI `status`).
pub(crate) async fn current(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Result<Response, ApiError> {
    let id = current_id(&principal)?;
    let metadata = state
        .tokens
        .get(id)
        .await
        .ok_or_else(|| ApiError::not_found("Access token not found"))?;
    Ok(no_store(Json(metadata)))
}

/// Route: `DELETE /api/v1/tokens/current` lets a token revoke itself (CLI `logout`).
pub(crate) async fn delete_current(
    State(state): State<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Result<Response, ApiError> {
    state.tokens.delete(current_id(&principal)?).await?;
    Ok(no_store(Json(DeleteAccessTokenResponse { deleted: true })))
}

/// The `current` routes only make sense for a token, not a browser session.
fn current_id(principal: &Principal) -> Result<Uuid, ApiError> {
    principal.token_id().ok_or_else(|| {
        ApiError::bad_request("This request is not authenticated with an access token")
    })
}

/// Parses a path id so malformed ids are a client error rather than "not found".
fn parse_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::bad_request("Token id must be a UUID"))
}

/// Resolves the device names or ids of a scope to the ids of known devices.
///
/// A scope stays tied to the devices it was created for: storing names would let a token
/// follow a name to whichever device takes it later. Unknown values are refused because
/// they are almost always typos.
async fn resolve_scope(state: &ServerState, devices: DeviceScope) -> Result<DeviceScope, ApiError> {
    let DeviceScope::Only { device_ids } = devices else {
        return Ok(DeviceScope::All);
    };
    let mut resolved = Vec::with_capacity(device_ids.len());
    for device in device_ids {
        let id = state
            .agents
            .resolve(device.as_str())
            .await
            .map_err(|error| match error.status_code() {
                axum::http::StatusCode::NOT_FOUND => {
                    ApiError::bad_request(format!("Unknown device '{device}'"))
                }
                _ => error,
            })?;
        resolved.push(id);
    }
    Ok(DeviceScope::Only {
        device_ids: resolved,
    })
}

/// Session-authenticated mutations reject cross-site requests, since the cookie would
/// otherwise let another site mint tokens in the user's name.
pub(crate) fn validate_mutation_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == "cross-site")
    {
        return Err(ApiError::forbidden("Cross-site token mutation rejected"));
    }
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(());
    };
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::forbidden("Mutation Origin cannot be validated"))?;
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest.trim_end_matches('/'));
    if origin_host != Some(host) {
        return Err(ApiError::forbidden(
            "Mutation Origin does not match this server",
        ));
    }
    Ok(())
}

/// The response body of a newly issued secret; callers send it with [`no_store`].
fn secret(issued: IssuedToken) -> AccessTokenSecretResponse {
    AccessTokenSecretResponse {
        token: issued.secret,
        metadata: issued.metadata,
    }
}

/// Keeps token responses out of browser and proxy caches.
pub(crate) fn no_store(body: impl IntoResponse) -> Response {
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}
