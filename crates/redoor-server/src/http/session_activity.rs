//! `POST /api/v1/session/activity` and the transfer hold: the only two ways a browser
//! session's idle expiry moves forward.
//!
//! A module of its own because renewal used to happen on every request, which let any
//! background poll keep an unattended browser signed in forever. Now the UI reports real
//! user interaction here, and long uploads and downloads hold their session open
//! server-side, since nothing in the page can see a native download progress.

use std::{
    pin::Pin,
    task::{Context, Poll},
};

use axum::{
    Extension, Json,
    body::{Body, Bytes, HttpBody},
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};
use redoor_core::log_error;
use redoor_protocol::api::auth::SessionExpiry;

use super::{
    auth::{ActiveSession, SessionActivityGuard},
    error::ApiError,
    state::ServerState,
};

/// Slides the caller's session a full idle lifetime forward and answers with the new expiry.
///
/// The route sits behind the normal access layer, so an expired session gets the usual 401
/// and can never revive itself here. Activity also rotates the cookie's secret (at most once
/// a minute) and sends the new cookie, so keeping a session alive always moves its secret
/// on, and a copied cookie used alongside it is detected.
pub(crate) async fn session_activity_handler(
    State(state): State<ServerState>,
    Extension(session): Extension<ActiveSession>,
) -> Result<Response, ApiError> {
    let renewed = match state.auth.renew_session(&session).await {
        Ok(Some(renewed)) => renewed,
        // Expired or logged out between the access check and the renewal.
        Ok(None) => {
            return Err(ApiError::status(
                axum::http::StatusCode::UNAUTHORIZED,
                "Authentication required",
            ));
        }
        Err(error) => {
            log_error!(error, "Failed to renew the session");
            return Err(ApiError::internal("Failed to renew the session"));
        }
    };
    let mut response = Json(session_expiry(renewed.expires_at)).into_response();
    if let Some(cookie) = renewed.cookie {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    Ok(response)
}

/// Describes an expiry for the UI, counting the remaining seconds on the server's clock so a
/// browser with a wrong clock still schedules its warning at the right moment.
pub(crate) fn session_expiry(expires_at: i64) -> SessionExpiry {
    let now = jiff::Timestamp::now().as_second();
    SessionExpiry {
        expires_at: jiff::Timestamp::from_second(expires_at)
            .map(|timestamp| timestamp.to_string())
            .unwrap_or_default(),
        expires_in_seconds: expires_at.saturating_sub(now).max(0) as u64,
    }
}

/// A transfer response body that holds the session open until the body is dropped.
///
/// Hyper drops the body once the last byte is sent or the client goes away, which is exactly
/// when the transfer stops counting as activity. Wrapping the body rather than holding the
/// guard in the handler matters for downloads, whose handler returns long before the bytes
/// are through.
pub(crate) struct TransferBody {
    inner: Body,
    _hold: SessionActivityGuard,
}

impl TransferBody {
    /// Wraps `inner` so `hold` lives exactly as long as it.
    pub(crate) fn new(inner: Body, hold: SessionActivityGuard) -> Self {
        Self { inner, _hold: hold }
    }
}

impl HttpBody for TransferBody {
    type Data = Bytes;
    type Error = axum::Error;

    /// Passes every frame through unchanged.
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    /// Delegated, so the end of the body is detected as early as without the wrapper.
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    /// Delegated, so `Content-Length` responses keep their exact length.
    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}
