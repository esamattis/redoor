use crate::streaming::{HEADER_SIZE, MAX_TRANSFER_FRAME_PAYLOAD_BYTES};
use crate::types::AgentId;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Limits how long an unauthenticated transfer socket can occupy server resources.
pub const TRANSFER_AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds the only text frame accepted by the payload-only transfer protocol.
pub const MAX_TRANSFER_HANDSHAKE_TEXT_BYTES: usize = 4 * 1024;
/// Bounds transfer messages to one framed stream chunk and prevents oversized allocations.
pub const MAX_TRANSFER_WEBSOCKET_MESSAGE_BYTES: usize =
    HEADER_SIZE + MAX_TRANSFER_FRAME_PAYLOAD_BYTES;
/// Avoids a tight reconnect loop while keeping temporary payload outages short.
pub const TRANSFER_RECONNECT_DELAY: Duration = Duration::from_secs(1);
/// Keeps each direction limited to one queued payload frame for end-to-end backpressure.
pub const TRANSFER_OUTBOUND_QUEUE_CAPACITY: usize = 1;

/// Authenticates a payload-only socket against the currently authoritative control session.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransferSocketHandshake {
    /// Binds this payload socket to the current control connection without reusing the shared agent secret.
    Authenticate { agent_id: AgentId, token: String },
}
