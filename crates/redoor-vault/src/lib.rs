//! The `.redoorvault` file format, version 1.
//!
//! ```text
//! offset  size        field
//! 0       12          magic "REDOORVAULT\0"
//! 12      1           format version = 0x01
//! 13      2           header_len (u16 BE, at most 4096)
//! 15      header_len  header: UTF-8 JSON (`VaultFileHeader`)
//! …       32          header_mac = HMAC-SHA256(K_hdr, bytes 0 … end of header)
//! …       …           payload: STREAM chunks of ChaCha20-Poly1305
//! ```
//!
//! This is the one implementation of the format: the browser only wraps and unwraps file
//! keys, and the server builds headers, checks MACs and streams the payload through
//! [`EncryptingReader`] and [`DecryptingReader`].
//!
//! It is a crate of its own so that only the roles allowed to hold file keys link it: the
//! server now, and a future command line tool that opens files with a backup `vault.json`
//! and no server. The agent crate cannot depend on it, which makes "agents only see
//! ciphertext" a property the compiler checks.
//!
//! Both readers hold at most one chunk of plaintext, and never release plaintext from a
//! chunk they have not authenticated, so large files stream in constant memory and a
//! truncated or tampered file never looks complete.

mod header;
mod stream;

pub use header::{VaultPreamble, VaultReadError};
pub use stream::{DecryptingReader, EncryptingReader};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// Every vault file starts with these bytes.
pub const MAGIC: [u8; 12] = *b"REDOORVAULT\0";
/// The format version this code reads and writes.
pub const FORMAT_VERSION: u8 = 1;
/// Magic, version and header length.
pub const PREFIX_LEN: usize = 15;
/// Headers above this are refused, which bounds what the server reads before checking.
pub const MAX_HEADER_LEN: usize = 4096;
/// HMAC-SHA256 output.
pub const HEADER_MAC_LEN: usize = 32;
/// The longest valid preamble (prefix, header and MAC).
pub const MAX_PREAMBLE_LEN: usize = PREFIX_LEN + MAX_HEADER_LEN + HEADER_MAC_LEN;
/// Plaintext bytes per STREAM chunk.
pub const CHUNK_SIZE: usize = 65536;
/// Poly1305 tag after every chunk.
pub const TAG_LEN: usize = 16;
/// Random bytes of `payload.salt`.
pub const PAYLOAD_SALT_LEN: usize = 16;
/// AES-GCM nonce of a key wrap.
pub const WRAP_IV_LEN: usize = 12;
/// A wrapped 32-byte key with its 16-byte GCM tag.
pub const WRAP_CT_LEN: usize = 48;

/// Why a byte sequence is not a usable vault file. Each variant maps to its own API error
/// code, so the user learns what is wrong instead of a generic failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultFormatError {
    #[error("Not a redoor vault file, or the file is corrupted")]
    BadMagic,
    #[error("The vault file was created by a newer redoor (format version {0})")]
    UnsupportedVersion(u8),
    #[error("The vault file header is corrupted: {0}")]
    InvalidHeader(String),
    #[error("The vault file header was tampered with, or the file key is wrong")]
    HeaderMac,
    #[error("The vault file is truncated")]
    Truncated,
    #[error("The vault file is corrupted at byte {offset}")]
    CorruptChunk { offset: u64 },
    #[error("The vault file key must be 32 bytes of base64url")]
    InvalidKey,
}

impl VaultFormatError {
    /// Wraps the error for `AsyncRead` adapters, which can only fail with `io::Error`.
    pub fn into_io(self) -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, self)
    }

    /// Recovers the format error from an `io::Error` produced by [`Self::into_io`], so a
    /// caller can tell corruption apart from a failed transfer.
    pub fn from_io(error: &std::io::Error) -> Option<Self> {
        error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<Self>())
            .cloned()
    }
}

/// The 32-byte key of one file version. It is zeroed on drop and never printed, because it
/// is the only thing standing between a log line and the file's content.
#[derive(Clone)]
pub struct FileKey(Zeroizing<[u8; 32]>);

impl FileKey {
    /// Takes ownership of raw key bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Generates a fresh random key. Only tests and future server-held objects need it:
    /// the browser picks the key of every file it writes.
    pub fn generate() -> Self {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).expect("operating system random source");
        Self(bytes)
    }

    /// Parses the base64url form that requests carry.
    pub fn from_base64url(encoded: &str) -> Result<Self, VaultFormatError> {
        let decoded = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(encoded.trim())
                .map_err(|_| VaultFormatError::InvalidKey)?,
        );
        let bytes: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| VaultFormatError::InvalidKey)?;
        Ok(Self::from_bytes(bytes))
    }

    /// Encodes the key the way requests carry it; only tests send keys from Rust.
    pub fn to_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.as_ref())
    }

    /// HKDF-SHA256 of this key, the source of every subkey of a file.
    fn derive(&self, salt: Option<&[u8]>, info: &[u8]) -> Zeroizing<[u8; 32]> {
        let mut output = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(salt, self.0.as_ref())
            .expand(info, output.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        output
    }
}

impl std::fmt::Debug for FileKey {
    /// Never prints key material, even in debug logs or panic messages.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FileKey(<redacted>)")
    }
}

/// Decodes base64url without padding into exactly `N` bytes, for header and vault fields.
pub fn decode_fixed<const N: usize>(encoded: &str) -> Option<[u8; N]> {
    URL_SAFE_NO_PAD.decode(encoded).ok()?.try_into().ok()
}

/// Encodes bytes the way every vault field stores them.
pub fn encode_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Fresh random bytes, encoded for a header field.
pub fn random_base64url(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("operating system random source");
    encode_base64url(&bytes)
}

/// Bytes of the STREAM payload for `plaintext_len` bytes of content: every chunk adds a
/// tag, and an empty file is one empty final chunk.
pub fn payload_len(plaintext_len: u64) -> u64 {
    let chunks = plaintext_len.div_ceil(CHUNK_SIZE as u64).max(1);
    plaintext_len + chunks * TAG_LEN as u64
}

/// The content length behind a payload of `payload_len` bytes, or `None` when no
/// plaintext encrypts to that length, which proves the file is truncated or padded.
pub fn plaintext_len(payload_len: u64) -> Option<u64> {
    let full_chunk = (CHUNK_SIZE + TAG_LEN) as u64;
    let full_chunks = payload_len / full_chunk;
    let rest = payload_len % full_chunk;
    match rest {
        // Every chunk was full, the last one included.
        0 if full_chunks > 0 => Some(full_chunks * CHUNK_SIZE as u64),
        // Only an empty file has an empty final chunk.
        16 if full_chunks == 0 => Some(0),
        rest if rest > TAG_LEN as u64 => Some(full_chunks * CHUNK_SIZE as u64 + rest - 16),
        _ => None,
    }
}

/// Whether a path names a vault file, by its suffix.
pub fn is_vault_path(path: &str) -> bool {
    path.ends_with(redoor_protocol::api::vault::VAULT_FILE_SUFFIX)
        && path.len() > redoor_protocol::api::vault::VAULT_FILE_SUFFIX.len()
        && !path.ends_with(&format!(
            "/{}",
            redoor_protocol::api::vault::VAULT_FILE_SUFFIX
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Content-Length and progress depend on computing sizes in both directions.
    #[test]
    fn sizes_round_trip_at_chunk_boundaries() {
        for len in [
            0,
            1,
            65535,
            65536,
            65537,
            131072,
            131073,
            5 * 1024 * 1024 + 7,
        ] {
            let payload = payload_len(len);
            // Each length must map back to itself, or downloads would announce wrong sizes.
            assert_eq!(plaintext_len(payload), Some(len), "length {len}");
        }
        // The documented formula for an empty file: one empty final chunk.
        assert_eq!(payload_len(0), 16);
        // A full chunk is final on its own, with no empty chunk after it.
        assert_eq!(payload_len(65536), 65552);
    }

    /// Lengths no encryption produces mean truncation or appended data.
    #[test]
    fn impossible_payload_lengths_are_refused() {
        // Shorter than one tag cannot hold even an empty file.
        assert_eq!(plaintext_len(0), None);
        assert_eq!(plaintext_len(15), None);
        // A full chunk followed by an empty one is never written.
        assert_eq!(plaintext_len(65552 + 16), None);
        // A partial tag after a full chunk is truncation.
        assert_eq!(plaintext_len(65552 + 5), None);
    }

    /// Keys must never leak through `Debug`, which tracing and panics use.
    #[test]
    fn file_key_debug_is_redacted() {
        let key = FileKey::from_bytes([7; 32]);
        // The formatted value must not contain the key bytes in any form.
        assert_eq!(format!("{key:?}"), "FileKey(<redacted>)");
        // The base64url form is the one requests carry, so it must round trip.
        let parsed = FileKey::from_base64url(&key.to_base64url()).unwrap();
        assert_eq!(parsed.0.as_ref(), key.0.as_ref());
        // Wrong lengths are refused instead of padded or truncated.
        assert_eq!(
            FileKey::from_base64url("AAAA").unwrap_err(),
            VaultFormatError::InvalidKey
        );
    }

    /// The suffix check decides which paths the vault endpoints accept.
    #[test]
    fn vault_paths_need_a_name_before_the_suffix() {
        assert!(is_vault_path("/home/u/secrets.env.redoorvault"));
        // A bare suffix is a hidden file named after the suffix, not an encrypted file.
        assert!(!is_vault_path("/home/u/.redoorvault"));
        assert!(!is_vault_path("/home/u/secrets.env"));
    }
}
