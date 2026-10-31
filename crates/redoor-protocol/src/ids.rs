//! Strongly typed identifiers and timestamps shared by the wire protocol and REST API.

use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;
use uuid::Uuid;

/// Identifies one device across the router, websocket protocol, REST API and everything
/// stored per device (token scopes, resume manifests).
///
/// An opaque `dev_` + 20 lowercase base32 characters value that never changes for the
/// device's lifetime, so a rename cannot move stored references to another device. Values
/// are deserialized unchecked because stored files and request bodies may hold anything;
/// the router validates the format of every `hello` before accepting it, and request values
/// are resolved against the inventory before use.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "string")]
pub struct AgentId(String);

/// Readability prefix that makes a device id recognisable in logs, config and URLs.
const AGENT_ID_PREFIX: &str = "dev_";
/// Number of base32 characters after the prefix; 20 characters carry 100 random bits.
const AGENT_ID_RANDOM_LENGTH: usize = 20;
/// RFC 4648 base32 alphabet in lowercase, safe in paths, URLs and TOML strings.
const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Why a string is not a device id; the message is shown to operators as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "'{0}' is not a valid device id (expected 'dev_' followed by 20 lowercase base32 characters)"
)]
pub struct InvalidAgentId(pub String);

impl AgentId {
    /// Creates a fresh random id for a newly added device.
    ///
    /// Uses the OS random source because ids must not collide between servers and standalone
    /// agents that never coordinate.
    pub fn generate() -> Self {
        let mut bytes = [0u8; AGENT_ID_RANDOM_LENGTH];
        getrandom::fill(&mut bytes).expect("the operating system random source is unavailable");
        let random = bytes
            .iter()
            .map(|byte| char::from(BASE32_ALPHABET[usize::from(byte % 32)]))
            .collect::<String>();
        Self(format!("{AGENT_ID_PREFIX}{random}"))
    }

    /// Accepts only values in the id format, for ids that come from config files, the id
    /// file or the command line where a typo must fail loudly.
    pub fn parse(value: &str) -> Result<Self, InvalidAgentId> {
        if Self::is_id_format(value) {
            Ok(Self(value.to_string()))
        } else {
            Err(InvalidAgentId(value.to_string()))
        }
    }

    /// Whether a string is in the id format; also used to keep names from looking like ids,
    /// which would make name-or-id lookups ambiguous.
    pub fn is_id_format(value: &str) -> bool {
        value.strip_prefix(AGENT_ID_PREFIX).is_some_and(|random| {
            random.len() == AGENT_ID_RANDOM_LENGTH
                && random.bytes().all(|byte| BASE32_ALPHABET.contains(&byte))
        })
    }

    /// Whether this value is in the id format; values deserialized from the wire are unchecked.
    pub fn is_valid(&self) -> bool {
        Self::is_id_format(&self.0)
    }

    /// Wraps a value without checking its format, for ids that were already resolved against
    /// the inventory or are only compared (stored scopes, unit tests).
    pub fn unchecked(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrows the raw value for lookups keyed by string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Why a device name is refused; the message is shown to operators and API clients as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidDeviceName {
    #[error("device name must not be empty")]
    Empty,
    #[error("device name '{0}' must not contain ':' or '/'")]
    ReservedCharacter(String),
    #[error(
        "device name '{0}' looks like a device id; choose a name that is not 'dev_' followed by 20 base32 characters"
    )]
    LooksLikeId(String),
}

/// Checks the format rules every device name must follow wherever it enters the system.
///
/// `:` would break the CLI's `device:path` syntax and `/` URL paths; a name in the id format
/// would be ambiguous because requests accept a name or an id.
pub fn validate_device_name(name: &str) -> Result<(), InvalidDeviceName> {
    if name.is_empty() {
        return Err(InvalidDeviceName::Empty);
    }
    if name.contains([':', '/']) {
        return Err(InvalidDeviceName::ReservedCharacter(name.to_string()));
    }
    if AgentId::is_id_format(name) {
        return Err(InvalidDeviceName::LooksLikeId(name.to_string()));
    }
    Ok(())
}

/// Identifies one websocket session connected to the router.
///
/// This is used for logging and for distinguishing concurrent connections even
/// when they belong to the same logical agent over time.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "string")]
pub struct SocketId(pub Uuid);

impl SocketId {
    /// Uses a random v4 UUID so concurrent sessions never collide without coordination.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SocketId {
    fn default() -> Self {
        Self::new()
    }
}

impl From<Uuid> for SocketId {
    fn from(value: Uuid) -> Self {
        Self(value)
    }
}

impl fmt::Display for SocketId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Identifies one server-owned terminal session across REST, the attach websocket and
/// every browser window that shows it as a tab.
///
/// A random v4 UUID because the id is the only handle to a running shell: it must not be
/// guessable from other sessions and needs no coordination to stay unique.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "string")]
pub struct TerminalSessionId(pub Uuid);

impl TerminalSessionId {
    /// Creates a fresh random id for a new terminal session.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Parses a path segment; anything that is not a UUID cannot name a session.
    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for TerminalSessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for TerminalSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Correlates one router command request with its eventual response.
///
/// This is used for internal command routing between the server router,
/// websocket protocol messages, stream uploads/downloads, and agent-side
/// upload session tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "number")]
pub struct RequestId(pub u64);

impl RequestId {
    /// Wraps a raw counter value so request ids cannot be mixed up with other integers.
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    /// Advances the router's request counter to the next unused correlation id.
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }

    /// Reuses the request id as the public transfer id for flows whose progress entry is
    /// keyed by the request that started them, avoiding a second id allocation.
    pub fn as_transfer_id(self) -> TransferId {
        TransferId(self.0)
    }

    /// Encodes the id for the binary stream frame header, which is little-endian.
    pub fn to_le_bytes(self) -> [u8; 8] {
        self.0.to_le_bytes()
    }

    /// Decodes the id from a binary stream frame header.
    pub fn from_le_bytes(bytes: [u8; 8]) -> Self {
        Self(u64::from_le_bytes(bytes))
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Identifies a public transfer or copy operation exposed to REST and UI
/// consumers.
///
/// Unlike `RequestId`, this represents the externally visible transfer job,
/// not the internal per-agent request IDs that may be used to implement it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "number")]
pub struct TransferId(pub u64);

impl TransferId {
    /// Wraps a raw counter value so transfer ids cannot be mixed up with request ids.
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    /// Advances the public transfer counter to the next unused id.
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

impl fmt::Display for TransferId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl UnixTimestampSeconds {
    /// Wraps raw epoch seconds so they cannot be confused with millisecond timestamps.
    pub fn new(value: i64) -> Self {
        Self(value)
    }
}

/// Unix timestamp in whole seconds since the epoch.
///
/// This is used for registration-time metadata such as when an agent
/// connected to the router.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "number")]
pub struct UnixTimestampSeconds(pub i64);

impl fmt::Display for UnixTimestampSeconds {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Unix timestamp in milliseconds so provisioning rows can show secs + ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(type = "number")]
pub struct UnixTimestampMillis(pub i64);

impl UnixTimestampMillis {
    /// Captures the current instant so step deltas can include milliseconds.
    pub fn now() -> Self {
        Self(jiff::Timestamp::now().as_millisecond())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generated ids must pass the same check `hello` applies, or new devices could not connect.
    #[test]
    fn generated_ids_are_in_the_id_format() {
        let id = AgentId::generate();
        // The prefix keeps ids recognisable in logs and config.
        assert!(id.as_str().starts_with("dev_"), "{id}");
        // 4 prefix characters plus 20 random characters.
        assert_eq!(id.as_str().len(), 24);
        assert!(id.is_valid());
        // Two fresh ids colliding would merge devices; 100 random bits make that impossible
        // in practice, so a collision here means the generator is broken.
        assert_ne!(id, AgentId::generate());
    }

    /// Only the exact format is accepted, so typos in config or the id file fail loudly.
    #[test]
    fn parse_rejects_values_outside_the_format() {
        assert!(AgentId::parse("dev_abcdefghijklmnopqrst").is_ok());
        assert!(AgentId::parse("dev_234567abcdefghijklmn").is_ok());
        // Too short and too long.
        assert!(AgentId::parse("dev_abcdefghijklmnopqrs").is_err());
        assert!(AgentId::parse("dev_abcdefghijklmnopqrstu").is_err());
        // Uppercase, base32-excluded digits and other prefixes are not ids.
        assert!(AgentId::parse("dev_ABCDEFGHIJKLMNOPQRST").is_err());
        assert!(AgentId::parse("dev_abcdefghijklmnopqrs1").is_err());
        assert!(AgentId::parse("pi").is_err());
        assert!(AgentId::parse("").is_err());
    }

    /// Names are checked wherever they enter the system; these are the rules from the design.
    #[test]
    fn device_name_rules() {
        // Empty names cannot be shown or addressed.
        assert_eq!(validate_device_name(""), Err(InvalidDeviceName::Empty));
        // ':' breaks `device:path` and '/' breaks URL paths.
        assert!(validate_device_name("a:b").is_err());
        assert!(validate_device_name("a/b").is_err());
        // A name in the id format would make name-or-id lookups ambiguous.
        assert!(validate_device_name("dev_abcdefghijklmnopqrst").is_err());
        // Other names starting with `dev_` are fine, as are spaces and Unicode.
        assert!(validate_device_name("dev_box").is_ok());
        assert!(validate_device_name("my pi #2 ?%ä").is_ok());
    }
}
