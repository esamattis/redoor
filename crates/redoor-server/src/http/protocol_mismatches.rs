//! REST view of agents refused because they speak another protocol version, scoped to the
//! signed-in user.

use axum::{Extension, Json, extract::State as AxumState};
use redoor_protocol::wire::handshake::{PROTOCOL, ProtocolMismatchListResponse};

use super::{access::Principal, state::ServerState};

/// Route: `GET /api/v1/protocol-mismatches`
///
/// Lets the UI warn about outdated standalone agents that proved this user's agent token.
pub(crate) async fn list_protocol_mismatches_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Json<ProtocolMismatchListResponse> {
    Json(ProtocolMismatchListResponse {
        server_protocol: PROTOCOL.to_string(),
        attempts: state.protocol_mismatches.list(principal.owner()),
    })
}
