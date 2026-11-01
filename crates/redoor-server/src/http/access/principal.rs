//! Who is calling, and the single decision function every route and MCP tool uses.

use std::collections::BTreeSet;

use redoor_protocol::{
    api::tokens::{DeviceScope, Permission},
    ids::AgentId,
};
use uuid::Uuid;

use crate::http::{auth::SessionUser, error::ApiError};

/// The authenticated caller, inserted into request extensions by the access middleware (REST)
/// and the MCP bearer middleware.
#[derive(Clone, Debug)]
pub(crate) enum Principal {
    /// A browser session: the single account with full access, including session-only
    /// routes. The user only says who signed in and how, for logs and the UI.
    Session(SessionUser),
    /// An access token, limited to its permissions on the devices in its scope.
    Token(TokenGrant),
}

/// The authorization part of an access token; carries no secret.
#[derive(Clone, Debug)]
pub(crate) struct TokenGrant {
    pub(crate) id: Uuid,
    /// The token's display name, for log lines and `GET /api/v1/auth/me`.
    pub(crate) name: String,
    pub(crate) permissions: BTreeSet<Permission>,
    pub(crate) devices: DeviceScope,
}

impl Principal {
    /// The one place a device permission decision is made: the device must be in scope and
    /// every listed permission held. An empty list is a pure scope check.
    pub(crate) fn require(
        &self,
        permissions: &[Permission],
        device: &AgentId,
    ) -> Result<(), ApiError> {
        let Principal::Token(grant) = self else {
            return Ok(());
        };
        if !grant.devices.contains(device) {
            return Err(ApiError::forbidden(format!(
                "Device {device} is outside this token's scope"
            )));
        }
        if let Some(missing) = permissions
            .iter()
            .find(|permission| !grant.permissions.contains(permission))
        {
            return Err(ApiError::forbidden(format!(
                "Token lacks {missing} on device {device}"
            )));
        }
        Ok(())
    }

    /// Whether the device is in scope, used to filter inventory and transfer listings.
    pub(crate) fn can_see(&self, device: &AgentId) -> bool {
        match self {
            Principal::Session(_) => true,
            Principal::Token(grant) => grant.devices.contains(device),
        }
    }

    /// Whether the caller holds a permission on at least one device; used to hide MCP tools
    /// the token can never use.
    pub(crate) fn holds(&self, permission: Permission) -> bool {
        match self {
            Principal::Session(_) => true,
            Principal::Token(grant) => grant.permissions.contains(&permission),
        }
    }

    /// Rejects tokens on routes that manage the server, its agents or other tokens, so a
    /// token can never widen its own access.
    pub(crate) fn require_session(&self) -> Result<(), ApiError> {
        match self {
            Principal::Session(_) => Ok(()),
            Principal::Token(_) => Err(ApiError::forbidden("Requires a browser session")),
        }
    }

    /// The signed-in user of a browser session, for per-user state; tokens have none.
    pub(crate) fn session_user(&self) -> Result<&SessionUser, ApiError> {
        match self {
            Principal::Session(user) => Ok(user),
            Principal::Token(_) => Err(ApiError::forbidden("Requires a browser session")),
        }
    }

    /// The token id, which owns MCP operations; `None` for browser sessions.
    pub(crate) fn token_id(&self) -> Option<Uuid> {
        match self {
            Principal::Session(_) => None,
            Principal::Token(grant) => Some(grant.id),
        }
    }

    /// How log lines written for this caller name it: `alice (password)` for a session and
    /// the token's name and id for a token.
    pub(crate) fn log_label(&self) -> String {
        match self {
            Principal::Session(user) => user.log_label(),
            Principal::Token(grant) => format!("{} (token {})", grant.name, grant.id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    /// Builds a token principal for the matrix below.
    fn token(permissions: &[Permission], devices: DeviceScope) -> Principal {
        Principal::Token(TokenGrant {
            id: Uuid::new_v4(),
            name: "test token".to_string(),
            permissions: permissions.iter().copied().collect(),
            devices,
        })
    }

    /// Covers session, all-device and limited-device principals in one decision table.
    #[test]
    fn require_matrix() {
        let a = redoor_core::test_support::test_agent_id("a");
        let b = redoor_core::test_support::test_agent_id("b");
        let session = Principal::Session(crate::http::auth::SessionUser {
            name: "alice".to_string(),
            method: crate::http::auth::SessionMethod::Password,
        });
        // A browser session may do everything, whichever method it signed in with.
        assert!(session.require(&Permission::ALL, &a).is_ok());
        assert!(session.require_session().is_ok());

        let all = token(&[Permission::FilesRead], DeviceScope::All);
        // An all-device token keeps its permission on any device, including new ones.
        assert!(all.require(&[Permission::FilesRead], &b).is_ok());
        // It is still limited to its permissions.
        let denied = all.require(&[Permission::FilesWrite], &a).unwrap_err();
        assert_eq!(denied.status_code(), StatusCode::FORBIDDEN);
        assert_eq!(
            denied.to_string(),
            format!("Token lacks files:write on device {a}")
        );
        // Tokens never pass session-only routes.
        assert!(all.require_session().is_err());

        let only = token(
            &[Permission::FilesRead, Permission::FilesWrite],
            DeviceScope::Only {
                device_ids: vec![a.clone()],
            },
        );
        // Every listed permission is required on an in-scope device.
        assert!(
            only.require(&[Permission::FilesRead, Permission::FilesWrite], &a)
                .is_ok()
        );
        // An empty list is a pure scope check.
        assert!(only.require(&[], &a).is_ok());
        let outside = only.require(&[], &b).unwrap_err();
        // Out-of-scope devices are refused even without a permission request.
        assert_eq!(
            outside.to_string(),
            format!("Device {b} is outside this token's scope")
        );
        // Visibility follows the scope only.
        assert!(only.can_see(&a));
        assert!(!only.can_see(&b));
        // Permission holding ignores devices, for tool listing.
        assert!(only.holds(Permission::FilesWrite));
        assert!(!only.holds(Permission::CommandsExecute));
    }
}
