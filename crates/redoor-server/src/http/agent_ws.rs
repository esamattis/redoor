//! The agent websocket endpoint: authentication and protocol negotiation at upgrade time.
//!
//! Both checks happen before the upgrade is accepted, so a client without the token or with an
//! incompatible protocol never gets a socket and the session actor only ever sees agents that
//! proved the token and speak [`PROTOCOL`]. The answer proves the token back to the agent, and
//! the session finishes the proof with the `hello` (see [`redoor_protocol::wire::agent_auth`]).

use crate::actors;
use axum::{
    Json,
    extract::{State as AxumState, ws::WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use redoor_core::log;
use redoor_protocol::ids::SocketId;
use redoor_protocol::wire::agent_auth::{
    AGENT_NONCE_HEADER, AGENT_PROOF_HEADER, AgentTokenKey, HandshakeNonce, HandshakeNonces,
    SERVER_NONCE_HEADER, SERVER_PROOF_HEADER,
};
use redoor_protocol::wire::handshake::{
    AGENT_VERSION_HEADER, PROTOCOL, ProtocolMismatchResponse, offered_protocols,
};
use redoor_protocol::wire::log::Level;

use super::client_address::ClientAddress;
use super::state::ServerState;

/// Largest websocket message an agent may send. Stream data frames are at most 64 KiB, but a
/// control result can carry a bounded git diff batch (8 MiB of patch text, more once escaped
/// as JSON) or a large listing; anything beyond this is refused before it is buffered, so one
/// misbehaving agent cannot make the server hold an arbitrarily large message.
const MAX_AGENT_MESSAGE_SIZE: usize = 32 * 1024 * 1024;

/// One header of the upgrade request as text.
fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

/// Authenticates an agent upgrade request against all users' agent tokens, returning the
/// owning user, their token key, and the agent's nonce when the proof matches.
async fn authenticate_agent_upgrade(
    headers: &HeaderMap,
    accounts: &crate::workspaces::UserAccountStore,
) -> Option<(String, AgentTokenKey, HandshakeNonce)> {
    let nonce = HandshakeNonce::parse(header_text(headers, AGENT_NONCE_HEADER)?)?;
    let proof = header_text(headers, AGENT_PROOF_HEADER)?;
    let (owner, key) = accounts.authenticate_upgrade(&nonce, proof).await?;
    Some((owner, key, nonce))
}

/// The subprotocols an upgrade request offers.
fn offered(headers: &HeaderMap) -> Vec<String> {
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(offered_protocols)
        .unwrap_or_default()
}

/// Whether an upgrade request offers the protocol this server speaks.
pub(crate) fn offers_protocol(headers: &HeaderMap) -> bool {
    offered(headers).iter().any(|protocol| protocol == PROTOCOL)
}

/// The agent's self-reported binary version, for diagnosing rejections.
fn agent_version(headers: &HeaderMap) -> Option<String> {
    headers
        .get(AGENT_VERSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Refuses an upgrade that does not offer [`PROTOCOL`] with `426` and remembers the attempt
/// under `owner` (already authenticated by the token proof).
fn protocol_mismatch(
    state: &ServerState,
    owner: String,
    remote: &ClientAddress,
    headers: &HeaderMap,
) -> Response {
    let version = agent_version(headers);
    let offered = offered(headers);
    // An error, not a warning: the agent cannot connect until an operator upgrades it.
    redoor_core::log_failure!(
        Level::Error,
        "Rejecting agent with an incompatible protocol: remote={}, agent_version={}, owner={}, offered={:?}, server_protocol={}",
        remote,
        version.as_deref().unwrap_or("unknown"),
        owner,
        offered,
        PROTOCOL
    );
    state
        .protocol_mismatches
        // The IP, not the address: every retry comes from a new ephemeral port, and one agent's
        // reconnect loop must keep replacing its own entry.
        .record(
            owner,
            remote.peer.ip().to_string(),
            remote.forwarded_for.clone(),
            version,
            offered,
        );
    let server_version = redoor_core::identity::current_binary_identity().version;
    (
        StatusCode::UPGRADE_REQUIRED,
        Json(ProtocolMismatchResponse {
            server_protocol: PROTOCOL.to_string(),
            message: format!(
                "This server speaks {PROTOCOL} (version {server_version}); upgrade the agent to the server's version"
            ),
            server_version,
        }),
    )
        .into_response()
}

/// Route: `GET /api/v1/agent/ws`
///
/// `503` while first-use migration is pending, `401` when the request does not prove any
/// user's agent token (checked first, so unauthenticated clients cannot fill mismatch lists),
/// `426` for a missing or unknown protocol, otherwise the upgrade echoing [`PROTOCOL`] with
/// the server's nonce and its proof of the owning user's token.
pub(crate) async fn agent_websocket_handler(
    ws: WebSocketUpgrade,
    remote: ClientAddress,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    // TEMPORARY MIGRATION: Hold off agent connections until legacy data is migrated into a
    // user workspace so standalone agents and managed daemons back off and reconnect once done.
    if state.migration.is_pending().await {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Some((owner, key, agent_nonce)) =
        authenticate_agent_upgrade(&headers, &state.accounts).await
    else {
        log!(
            Level::Warning,
            "Rejecting agent with a missing or invalid token proof: remote={}, agent_version={}",
            remote,
            agent_version(&headers).as_deref().unwrap_or("unknown")
        );
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !offers_protocol(&headers) {
        return protocol_mismatch(&state, owner, &remote, &headers);
    }
    let nonces = HandshakeNonces {
        agent: agent_nonce,
        server: HandshakeNonce::generate(),
    };
    let hello_proof = key.hello_proof(&nonces);
    let router_ref = state.router_ref;
    let watchdog_registry = state.watchdog_registry;
    let terminals = state.terminals;
    let timeouts = state.runtime.ws_timeouts;
    let mut response = ws
        .protocols([PROTOCOL])
        .max_message_size(MAX_AGENT_MESSAGE_SIZE)
        .max_frame_size(MAX_AGENT_MESSAGE_SIZE)
        .on_upgrade(move |socket| {
            actors::session::handle_websocket(
                socket,
                actors::session::AgentWebSocketContext {
                    owner,
                    socket_id: SocketId::new(),
                    router_ref,
                    watchdog_registry,
                    terminals,
                    timeouts,
                    hello_proof,
                },
            )
        })
        .into_response();
    let answer = response.headers_mut();
    answer.insert(SERVER_NONCE_HEADER, hex_header(nonces.server.as_str()));
    answer.insert(
        SERVER_PROOF_HEADER,
        hex_header(key.server_proof(&nonces).as_str()),
    );
    response
}

/// Converts a nonce or proof, which the handshake always encodes as hex, into a header value.
fn hex_header(hex: &str) -> HeaderValue {
    HeaderValue::from_str(hex).expect("hex is a valid header value")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// Verifies the upgrade is accepted only with a proof over the agent's own nonce, and
    /// routes the connection to the user whose token produced the proof.
    #[tokio::test]
    async fn upgrade_requires_a_proof_of_the_token() {
        let temp = redoor_core::test_support::TempDir::create();
        let paths = redoor_core::paths::AppPaths::for_home("redoor-test", temp.path());
        let accounts = crate::workspaces::UserAccountStore::load_all(paths)
            .await
            .unwrap();
        accounts
            .set_account_token("alice", "token".to_string())
            .await
            .unwrap();
        let key = AgentTokenKey::new("token");
        let nonce = HandshakeNonce::generate();
        let mut headers = HeaderMap::new();
        headers.insert(AGENT_NONCE_HEADER, hex_header(nonce.as_str()));
        headers.insert(
            AGENT_PROOF_HEADER,
            hex_header(key.upgrade_proof(&nonce).as_str()),
        );
        // A proof made with a user's token is accepted and yields that user and the nonce.
        let (owner, _, proven_nonce) = authenticate_agent_upgrade(&headers, &accounts)
            .await
            .expect("valid upgrade proof");
        assert_eq!(owner, "alice");
        assert_eq!(proven_nonce, nonce);
        // A proof made with an unknown token is refused.
        let mut wrong = HeaderMap::new();
        wrong.insert(AGENT_NONCE_HEADER, hex_header(nonce.as_str()));
        wrong.insert(
            AGENT_PROOF_HEADER,
            hex_header(AgentTokenKey::new("other").upgrade_proof(&nonce).as_str()),
        );
        assert!(
            authenticate_agent_upgrade(&wrong, &accounts)
                .await
                .is_none()
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );
        headers.remove(AGENT_PROOF_HEADER);
        // The plain bearer token of older agents no longer authenticates.
        assert!(
            authenticate_agent_upgrade(&headers, &accounts)
                .await
                .is_none()
        );
    }

    /// Verifies negotiation accepts the server's protocol among several offers.
    #[test]
    fn protocol_offer_is_found_among_several() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("redoor.v6, redoor.v7"),
        );
        // An agent may offer older protocols too; the server picks its own.
        assert!(offers_protocol(&headers));
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("redoor.v8"),
        );
        // A different version alone must be refused.
        assert!(!offers_protocol(&headers));
    }
}
