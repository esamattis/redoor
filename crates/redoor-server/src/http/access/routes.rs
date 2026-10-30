//! The route access table: which principal may call which REST route.
//!
//! Keeping every rule in one exhaustive table makes the token surface reviewable at a glance,
//! and any route missing from it falls back to session-only, so new routes are denied to
//! tokens until someone decides otherwise.

use axum::http::{Method, Uri};
use redoor_protocol::api::tokens::Permission::{
    self, AgentsManage, CommandsExecute, FilesDelete, FilesRead, FilesWrite,
};

/// What a route requires from the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    /// No credential: login, logout, the OIDC sign-in round trip and the agent endpoint, which
    /// checks the agent token itself.
    Public,
    /// Browser sessions only: server and agent configuration, token management, live sockets.
    SessionOnly,
    /// Any session or token; the handler filters what it returns by device scope.
    AnyPrincipal,
    /// The route has an `{agent}` parameter and needs every listed permission on that device.
    Device(&'static [Permission]),
    /// The devices are in the request body, so the handler must call `Principal::require`.
    Handler,
}

/// Classifies a matched route template. `None` means the route has no entry, which the
/// middleware treats as session-only (deny for tokens).
pub(crate) fn classify(method: &Method, matched_path: &str) -> Option<Access> {
    // Routes that also exist with a trailing `/{*path}` share the same rule.
    let path = matched_path
        .strip_suffix("/{*path}")
        .unwrap_or(matched_path);
    let access = match (method.as_str(), path) {
        ("GET", "/api/v1/agent/ws") | ("POST", "/api/v1/login" | "/api/v1/logout") => {
            Access::Public
        }
        // The sign-in round trip happens before a session exists; the callback authenticates
        // the provider's answer itself.
        (
            "GET",
            "/api/v1/auth/methods" | "/api/v1/auth/oidc/login" | "/api/v1/auth/oidc/callback",
        ) => Access::Public,

        // Live sockets, server configuration and agent configuration.
        (
            "GET",
            "/api/v1/ui/ws"
            | "/api/v1/server/logs/ws"
            | "/api/v1/agents/{agent}/logs/ws"
            | "/api/v1/agents/{agent}/terminal/ws",
        )
        | ("GET", "/api/v1/protocol-mismatches" | "/api/v1/server")
        | ("GET" | "PUT", "/api/v1/server/logging-level" | "/api/v1/user/state")
        | ("GET" | "PUT" | "DELETE", "/api/v1/user/editor-buffers/{key}")
        | ("POST", "/api/v1/server/restart" | "/api/v1/server/upgrade")
        | ("POST", "/api/v1/agents" | "/api/v1/local-agents")
        | ("PUT" | "DELETE", "/api/v1/agents/{agent}" | "/api/v1/local-agents/{agent}")
        | (
            "GET",
            "/api/v1/agents/{agent}/configuration" | "/api/v1/local-agents/{agent}/configuration",
        )
        | ("GET" | "PUT", "/api/v1/agents/{agent}/logging-level")
        | ("POST", "/api/v1/agents/{agent}/echo") => Access::SessionOnly,

        // SSH keys and host keys carry login passwords and change what the server can log
        // in to.
        ("GET", "/api/v1/agents/{agent}/ssh-host-key")
        | ("POST", "/api/v1/agents/{agent}/ssh-host-key/pin")
        | ("POST" | "DELETE", "/api/v1/agents/{agent}/ssh-key") => Access::SessionOnly,

        // Token management: never grantable, so a token cannot mint a broader one.
        ("GET" | "POST", "/api/v1/tokens")
        | ("PUT" | "DELETE", "/api/v1/tokens/{token_id}")
        | ("POST", "/api/v1/tokens/{token_id}/rotate") => Access::SessionOnly,
        // A token may read and delete itself, which is what CLI status and logout use.
        ("GET" | "DELETE", "/api/v1/tokens/current") => Access::AnyPrincipal,

        // Inventory and transfer listings are filtered by scope in their handlers.
        ("GET", "/api/v1/agents" | "/api/v1/transfers/progress" | "/api/v1/partials") => {
            Access::AnyPrincipal
        }
        // The upload request id is an unguessable client UUID and only cancels.
        ("DELETE", "/api/v1/upload-requests/{token}") => Access::AnyPrincipal,

        ("GET", "/api/v1/agents/{agent}") => Access::Device(&[]),
        (
            "POST",
            "/api/v1/agents/{agent}/start"
            | "/api/v1/agents/{agent}/shutdown"
            | "/api/v1/agents/{agent}/retry-start"
            | "/api/v1/agents/{agent}/restart"
            | "/api/v1/agents/{agent}/upgrade",
        ) => Access::Device(&[AgentsManage]),
        ("POST", "/api/v1/agents/{agent}/exec" | "/api/v1/agents/{agent}/open")
        | ("DELETE", "/api/v1/agents/{agent}/exec/{execution_id}") => {
            Access::Device(&[CommandsExecute])
        }
        (
            "GET",
            "/api/v1/agents/{agent}/ls"
            | "/api/v1/agents/{agent}/metadata"
            | "/api/v1/agents/{agent}/git/context"
            | "/api/v1/agents/{agent}/git/status"
            | "/api/v1/agents/{agent}/git/entries"
            | "/api/v1/agents/{agent}/git/tree"
            | "/api/v1/agents/{agent}/git/blob"
            | "/api/v1/agents/{agent}/git/download"
            | "/api/v1/agents/{agent}/git/commit-diff"
            | "/api/v1/agents/{agent}/git/log"
            | "/api/v1/agents/{agent}/git/commit-neighbors"
            | "/api/v1/agents/{agent}/git/branches"
            | "/api/v1/agents/{agent}/git/tags"
            | "/api/v1/agents/{agent}/git/worktrees"
            | "/api/v1/agents/{agent}/raw"
            | "/api/v1/agents/{agent}/accounts"
            | "/api/v1/agents/{agent}/trash",
        )
        | (
            "POST",
            "/api/v1/agents/{agent}/find"
            | "/api/v1/agents/{agent}/grep"
            | "/api/v1/agents/{agent}/directory-size"
            | "/api/v1/agents/{agent}/git/diff"
            | "/api/v1/agents/{agent}/git/worktree-status"
            | "/api/v1/agents/{agent}/one-time-token",
        ) => Access::Device(&[FilesRead]),
        (
            "PUT",
            "/api/v1/agents/{agent}/raw"
            | "/api/v1/agents/{agent}/archive"
            | "/api/v1/agents/{agent}/edit",
        )
        | (
            "POST",
            "/api/v1/agents/{agent}/mkdir"
            | "/api/v1/agents/{agent}/chmod"
            | "/api/v1/agents/{agent}/chown"
            | "/api/v1/agents/{agent}/trash/restore",
        ) => Access::Device(&[FilesWrite]),
        // Renaming removes the old name, so it needs delete as well as write.
        ("POST", "/api/v1/agents/{agent}/rename") => Access::Device(&[FilesWrite, FilesDelete]),
        ("DELETE", "/api/v1/agents/{agent}/raw" | "/api/v1/agents/{agent}/trash") => {
            Access::Device(&[FilesDelete])
        }

        // The devices are named in the body or found through a transfer id.
        (
            "POST",
            "/api/v1/copy"
            | "/api/v1/copy/preflight"
            | "/api/v1/move"
            | "/api/v1/diff"
            | "/api/v1/partials/resume"
            | "/api/v1/partials/discard"
            | "/api/v1/transfers/{transfer_id}/pause",
        )
        | ("DELETE", "/api/v1/transfers/{transfer_id}") => Access::Handler,

        _ => return None,
    };
    Some(access)
}

/// Identifies raw GETs carrying a one-time link token; their handler validates the link, so
/// they need no session or access token.
pub(crate) fn is_one_time_token_raw_request(method: &Method, uri: &Uri) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Representative rows of the table, so an accidental edit shows up as a test failure.
    #[test]
    fn table_rows() {
        let cases = [
            (Method::GET, "/api/v1/agent/ws", Access::Public),
            (Method::POST, "/api/v1/login", Access::Public),
            (Method::GET, "/api/v1/auth/oidc/callback", Access::Public),
            (Method::GET, "/api/v1/auth/methods", Access::Public),
            (Method::GET, "/api/v1/agents", Access::AnyPrincipal),
            (Method::POST, "/api/v1/agents", Access::SessionOnly),
            (Method::GET, "/api/v1/agents/{agent}", Access::Device(&[])),
            (Method::PUT, "/api/v1/agents/{agent}", Access::SessionOnly),
            (
                Method::PUT,
                "/api/v1/user/editor-buffers/{key}",
                Access::SessionOnly,
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/ls/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/tree/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/entries/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/commit-diff",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/log/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/commit-neighbors/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/tags",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/download/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/git/worktrees/{*path}",
                Access::Device(&[FilesRead]),
            ),
            (
                Method::PUT,
                "/api/v1/agents/{agent}/archive/{*path}",
                Access::Device(&[FilesWrite]),
            ),
            (
                Method::DELETE,
                "/api/v1/agents/{agent}/raw/{*path}",
                Access::Device(&[FilesDelete]),
            ),
            (
                Method::POST,
                "/api/v1/agents/{agent}/rename",
                Access::Device(&[FilesWrite, FilesDelete]),
            ),
            (
                Method::POST,
                "/api/v1/agents/{agent}/exec",
                Access::Device(&[CommandsExecute]),
            ),
            (
                Method::POST,
                "/api/v1/agents/{agent}/start",
                Access::Device(&[AgentsManage]),
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/terminal/ws",
                Access::SessionOnly,
            ),
            (Method::POST, "/api/v1/server/restart", Access::SessionOnly),
            (Method::POST, "/api/v1/server/upgrade", Access::SessionOnly),
            (
                Method::POST,
                "/api/v1/agents/{agent}/ssh-key",
                Access::SessionOnly,
            ),
            (
                Method::GET,
                "/api/v1/agents/{agent}/ssh-host-key",
                Access::SessionOnly,
            ),
            (Method::GET, "/api/v1/tokens", Access::SessionOnly),
            (Method::GET, "/api/v1/tokens/current", Access::AnyPrincipal),
            (
                Method::POST,
                "/api/v1/tokens/{token_id}/rotate",
                Access::SessionOnly,
            ),
            (Method::POST, "/api/v1/copy", Access::Handler),
            (
                Method::DELETE,
                "/api/v1/transfers/{transfer_id}",
                Access::Handler,
            ),
        ];
        for (method, path, expected) in cases {
            // Each route keeps exactly the access decided in the design.
            assert_eq!(classify(&method, path), Some(expected), "{method} {path}");
        }
    }

    /// Default deny: a route nobody classified gets no rule, so it is not reachable with a token.
    #[test]
    fn unknown_routes_are_session_only() {
        // A new route without a table entry has no rule, so the middleware denies tokens.
        assert_eq!(classify(&Method::GET, "/api/v1/new-feature"), None);
        // A known path with an unlisted method is unclassified the same way.
        assert_eq!(classify(&Method::PATCH, "/api/v1/agents/{agent}/raw"), None);
    }

    /// Keeps the link bypass limited to raw GETs that present a non-empty token parameter.
    #[test]
    fn only_token_bearing_raw_gets_bypass_authentication() {
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
        // Ordinary raw downloads still require a session or access token.
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
