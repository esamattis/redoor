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

/// The agent's nonce, when the upgrade request proves the token over it.
fn proven_agent_nonce(headers: &HeaderMap, key: &AgentTokenKey) -> Option<HandshakeNonce> {
    let nonce = HandshakeNonce::parse(header_text(headers, AGENT_NONCE_HEADER)?)?;
    let proof = header_text(headers, AGENT_PROOF_HEADER)?;
    key.upgrade_proof(&nonce).matches(proof).then_some(nonce)
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

/// Refuses an upgrade that does not offer [`PROTOCOL`] with `426` and remembers the attempt.
fn protocol_mismatch(state: &ServerState, remote: &ClientAddress, headers: &HeaderMap) -> Response {
    let version = agent_version(headers);
    let offered = offered(headers);
    // An error, not a warning: the agent cannot connect until an operator upgrades it.
    redoor_core::log_failure!(
        Level::Error,
        "Rejecting agent with an incompatible protocol: remote={}, agent_version={}, offered={:?}, server_protocol={}",
        remote,
        version.as_deref().unwrap_or("unknown"),
        offered,
        PROTOCOL
    );
    state
        .protocol_mismatches
        // The IP, not the address: every retry comes from a new ephemeral port, and one agent's
        // reconnect loop must keep replacing its own entry.
        .record(
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
/// `401` when the request does not prove the token (checked first, so unauthenticated clients
/// cannot fill the mismatch list), `426` for a missing or unknown protocol, otherwise the
/// upgrade echoing [`PROTOCOL`] with the server's nonce and its proof of the token.
pub(crate) async fn agent_websocket_handler(
    ws: WebSocketUpgrade,
    remote: ClientAddress,
    headers: HeaderMap,
    AxumState(state): AxumState<ServerState>,
) -> Response {
    let key = AgentTokenKey::new(state.auth.agent_token());
    let Some(agent_nonce) = proven_agent_nonce(&headers, &key) else {
        log!(
            Level::Warning,
            "Rejecting agent with a missing or invalid token proof: remote={}, agent_version={}",
            remote,
            agent_version(&headers).as_deref().unwrap_or("unknown")
        );
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !offers_protocol(&headers) {
        return protocol_mismatch(&state, &remote, &headers);
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
                SocketId::new(),
                router_ref,
                watchdog_registry,
                terminals,
                timeouts,
                hello_proof,
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

    /// Verifies the upgrade is accepted only with a proof over the agent's own nonce.
    #[test]
    fn upgrade_requires_a_proof_of_the_token() {
        let key = AgentTokenKey::new("token");
        let nonce = HandshakeNonce::generate();
        let mut headers = HeaderMap::new();
        headers.insert(AGENT_NONCE_HEADER, hex_header(nonce.as_str()));
        headers.insert(
            AGENT_PROOF_HEADER,
            hex_header(key.upgrade_proof(&nonce).as_str()),
        );
        // A proof made with the server's token is accepted and yields the agent's nonce.
        assert_eq!(proven_agent_nonce(&headers, &key), Some(nonce.clone()));
        // A proof made with another token is refused.
        assert_eq!(
            proven_agent_nonce(&headers, &AgentTokenKey::new("other")),
            None
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );
        headers.remove(AGENT_PROOF_HEADER);
        // The plain bearer token of older agents no longer authenticates.
        assert_eq!(proven_agent_nonce(&headers, &key), None);
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
