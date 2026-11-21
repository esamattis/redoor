//! The device a request addresses, resolved from the `{agent}` path parameter within the
//! caller's workspace.

use axum::{extract::FromRequestParts, http::request::Parts};

use crate::http::error::ApiError;
use crate::workspaces::AgentKey;

/// Owned device key (`owner` + `AgentId`) resolved from the route's `{agent}` parameter.
///
/// The parameter accepts a name or an id. The access middleware resolves it once within the
/// caller's workspace, before access control, and handlers take the key from here instead of
/// reading the raw parameter, so a handler can never act on a device belonging to another user
/// or a name that scope checks did not see.
#[derive(Clone, Debug)]
pub(crate) struct ResolvedDevice(pub(crate) AgentKey);

impl<S: Send + Sync> FromRequestParts<S> for ResolvedDevice {
    type Rejection = ApiError;

    /// Reads what the middleware stored; a miss means the route skipped the middleware, which
    /// is a server bug rather than a client error.
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<ResolvedDevice>()
            .cloned()
            .ok_or_else(|| ApiError::internal("Device parameter was not resolved"))
    }
}
