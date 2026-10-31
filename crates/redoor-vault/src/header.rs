//! The prefix, the JSON header and the header MAC of a vault file.

use super::{
    FORMAT_VERSION, FileKey, HEADER_MAC_LEN, MAGIC, MAX_HEADER_LEN, PAYLOAD_SALT_LEN, PREFIX_LEN,
    VaultFormatError, WRAP_CT_LEN, WRAP_IV_LEN, decode_fixed,
};
use hmac::{Hmac, KeyInit, Mac};
use redoor_protocol::api::vault::{
    VAULT_PAYLOAD_ALG, VAULT_WRAP_ALG, VaultFileHeader, VaultObjectKind,
};
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncReadExt};

/// HKDF info of the header MAC key.
const HEADER_KEY_INFO: &[u8] = b"redoorvault v1 header";
/// HKDF info of the payload key; the payload salt is the HKDF salt.
const PAYLOAD_KEY_INFO: &[u8] = b"redoorvault v1 payload";

/// Why reading a preamble failed: the bytes are not a valid vault file, or the source
/// itself failed. Callers report the two differently (a corrupt file is the user's
/// problem, a failed transfer is the device's).
#[derive(Debug, thiserror::Error)]
pub enum VaultReadError {
    #[error(transparent)]
    Format(#[from] VaultFormatError),
    #[error(transparent)]
    Io(std::io::Error),
}

/// Everything in front of the payload: the parsed header, the exact bytes the MAC covers
/// and the MAC itself.
///
/// The MAC covers the raw header bytes, so the JSON needs no canonical form and a parsed
/// header is never serialized again to check it.
#[derive(Debug, Clone)]
pub struct VaultPreamble {
    header: VaultFileHeader,
    /// Magic, version, length and header JSON, exactly as read or written.
    authenticated: Vec<u8>,
    mac: [u8; HEADER_MAC_LEN],
}

impl VaultPreamble {
    /// Builds and authenticates the preamble of a new file version.
    pub fn build(header: VaultFileHeader, key: &FileKey) -> Result<Self, VaultFormatError> {
        validate_header(&header)?;
        let json = serde_json::to_vec(&header)
            .map_err(|error| VaultFormatError::InvalidHeader(error.to_string()))?;
        if json.len() > MAX_HEADER_LEN {
            return Err(VaultFormatError::InvalidHeader(format!(
                "the header is {} bytes, more than {MAX_HEADER_LEN}",
                json.len()
            )));
        }
        let mut authenticated = Vec::with_capacity(PREFIX_LEN + json.len());
        authenticated.extend_from_slice(&MAGIC);
        authenticated.push(FORMAT_VERSION);
        authenticated.extend_from_slice(&(json.len() as u16).to_be_bytes());
        authenticated.extend_from_slice(&json);
        let mac = header_mac(key, &authenticated)
            .finalize()
            .into_bytes()
            .into();
        Ok(Self {
            header,
            authenticated,
            mac,
        })
    }

    /// Reads exactly the preamble from `reader`, leaving it at the first payload byte.
    ///
    /// The fields are checked in the order of the error table (magic, version, length,
    /// JSON), so each failure is reported as precisely as the bytes allow. The MAC is not
    /// checked here, because reading headers must work without the file key.
    pub async fn read<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Self, VaultReadError> {
        let mut prefix = [0u8; PREFIX_LEN];
        // A file shorter than the magic is "not a vault file", not a truncated one.
        let mut magic_len = 0;
        while magic_len < MAGIC.len() {
            match reader.read(&mut prefix[magic_len..MAGIC.len()]).await {
                Ok(0) => break,
                Ok(count) => magic_len += count,
                Err(error) => return Err(VaultReadError::Io(error)),
            }
        }
        if prefix[..MAGIC.len()] != MAGIC {
            return Err(VaultFormatError::BadMagic.into());
        }
        read_exact(reader, &mut prefix[MAGIC.len()..]).await?;
        let version = prefix[MAGIC.len()];
        if version != FORMAT_VERSION {
            return Err(VaultFormatError::UnsupportedVersion(version).into());
        }
        let header_len = u16::from_be_bytes([prefix[13], prefix[14]]) as usize;
        if header_len > MAX_HEADER_LEN {
            return Err(VaultFormatError::InvalidHeader(format!(
                "the header is {header_len} bytes, more than {MAX_HEADER_LEN}"
            ))
            .into());
        }
        let mut authenticated = Vec::with_capacity(PREFIX_LEN + header_len);
        authenticated.extend_from_slice(&prefix);
        authenticated.resize(PREFIX_LEN + header_len, 0);
        read_exact(reader, &mut authenticated[PREFIX_LEN..]).await?;
        let header: VaultFileHeader = serde_json::from_slice(&authenticated[PREFIX_LEN..])
            .map_err(|error| VaultFormatError::InvalidHeader(error.to_string()))?;
        validate_header(&header)?;
        let mut mac = [0u8; HEADER_MAC_LEN];
        read_exact(reader, &mut mac).await?;
        Ok(Self {
            header,
            authenticated,
            mac,
        })
    }

    /// The parsed header. It is not authenticated until [`Self::verify`] succeeds.
    pub fn header(&self) -> &VaultFileHeader {
        &self.header
    }

    /// Bytes in front of the payload.
    pub fn len(&self) -> usize {
        self.authenticated.len() + HEADER_MAC_LEN
    }

    /// Never true: a preamble always holds at least the prefix and the MAC.
    pub fn is_empty(&self) -> bool {
        false
    }

    /// The preamble as written to the file.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.len());
        bytes.extend_from_slice(&self.authenticated);
        bytes.extend_from_slice(&self.mac);
        bytes
    }

    /// Checks the header MAC in constant time. Success proves the key belongs to this
    /// header: an agent can change header bytes but cannot forge the MAC without the key.
    pub fn verify(&self, key: &FileKey) -> Result<(), VaultFormatError> {
        header_mac(key, &self.authenticated)
            .verify_slice(&self.mac)
            .map_err(|_| VaultFormatError::HeaderMac)
    }

    /// The ChaCha20-Poly1305 key of the payload, bound to the header's payload salt.
    pub(super) fn payload_key(
        &self,
        key: &FileKey,
    ) -> Result<zeroize::Zeroizing<[u8; 32]>, VaultFormatError> {
        let salt =
            decode_fixed::<PAYLOAD_SALT_LEN>(&self.header.payload.salt).ok_or_else(|| {
                VaultFormatError::InvalidHeader("the payload salt is not 16 bytes".to_string())
            })?;
        Ok(key.derive(Some(&salt), PAYLOAD_KEY_INFO))
    }
}

/// An HMAC-SHA256 over `bytes` keyed with the file's header key.
fn header_mac(key: &FileKey, bytes: &[u8]) -> Hmac<Sha256> {
    let header_key = key.derive(None, HEADER_KEY_INFO);
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(header_key.as_ref())
        .expect("HMAC accepts any key length");
    mac.update(bytes);
    mac
}

/// Fills `buffer`, turning a premature end into [`VaultFormatError::Truncated`].
async fn read_exact<R: AsyncRead + Unpin>(
    reader: &mut R,
    buffer: &mut [u8],
) -> Result<(), VaultReadError> {
    match reader.read_exact(buffer).await {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(VaultFormatError::Truncated.into())
        }
        Err(error) => Err(VaultFormatError::from_io(&error)
            .map(VaultReadError::Format)
            .unwrap_or(VaultReadError::Io(error))),
    }
}

/// Checks the header fields this version understands, so a malformed header fails with a
/// precise message before any key is used.
fn validate_header(header: &VaultFileHeader) -> Result<(), VaultFormatError> {
    let invalid = |message: &str| Err(VaultFormatError::InvalidHeader(message.to_string()));
    if header.vault_id.is_empty() || header.key_id.is_empty() {
        return invalid("the vault or key id is missing");
    }
    // Files are bound to nothing; later kinds (SSH keys) define their own context.
    if header.kind == VaultObjectKind::File && !header.context.is_empty() {
        return invalid("a file header has no context");
    }
    if header.wrap.alg != VAULT_WRAP_ALG
        || decode_fixed::<WRAP_IV_LEN>(&header.wrap.iv).is_none()
        || decode_fixed::<WRAP_CT_LEN>(&header.wrap.ct).is_none()
    {
        return invalid("the file key wrap is not AES-256-GCM of a 32-byte key");
    }
    if header.payload.alg != VAULT_PAYLOAD_ALG
        || header.payload.chunk_size as usize != super::CHUNK_SIZE
        || decode_fixed::<PAYLOAD_SALT_LEN>(&header.payload.salt).is_none()
    {
        return invalid("unsupported payload parameters");
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::{encode_base64url, random_base64url};
    use redoor_protocol::api::vault::{VaultKeyWrap, VaultPayloadParams};

    /// A valid header with random wraps; the wrap is never opened by the server.
    pub(crate) fn test_header() -> VaultFileHeader {
        VaultFileHeader {
            vault_id: "vlt_0123456789abcdef0123456789abcdef".to_string(),
            vault_label: "test vault".to_string(),
            key_id: "kid_0123456789abcdef0123456789abcdef".to_string(),
            kind: VaultObjectKind::File,
            context: Default::default(),
            wrap: VaultKeyWrap {
                alg: VAULT_WRAP_ALG.to_string(),
                iv: random_base64url(WRAP_IV_LEN),
                ct: random_base64url(WRAP_CT_LEN),
            },
            payload: VaultPayloadParams {
                alg: VAULT_PAYLOAD_ALG.to_string(),
                chunk_size: crate::CHUNK_SIZE as u32,
                salt: random_base64url(PAYLOAD_SALT_LEN),
            },
        }
    }

    /// Reads a preamble from bytes, as the server does from an agent stream.
    async fn read(bytes: &[u8]) -> Result<VaultPreamble, VaultFormatError> {
        let mut reader = bytes;
        VaultPreamble::read(&mut reader)
            .await
            .map_err(|error| match error {
                VaultReadError::Format(error) => error,
                VaultReadError::Io(error) => panic!("slices do not fail: {error}"),
            })
    }

    /// A written preamble must read back to the same header and verify with its key.
    #[tokio::test]
    async fn preamble_round_trips_and_verifies() {
        let key = FileKey::generate();
        let preamble = VaultPreamble::build(test_header(), &key).unwrap();
        let bytes = preamble.to_bytes();
        let read_back = read(&bytes).await.unwrap();
        // The parsed header is the one that was written.
        assert_eq!(read_back.header(), preamble.header());
        // The length tells callers where the payload starts.
        assert_eq!(read_back.len(), bytes.len());
        // The right key authenticates the header.
        assert!(read_back.verify(&key).is_ok());
        // Another key fails, which is how a wrong or swapped file key is detected.
        assert_eq!(
            read_back.verify(&FileKey::generate()).unwrap_err(),
            VaultFormatError::HeaderMac
        );
    }

    /// A flipped bit anywhere in the authenticated bytes must fail, with the most precise
    /// error the position allows.
    #[tokio::test]
    async fn flipped_bits_are_detected_in_every_region() {
        let key = FileKey::generate();
        let bytes = VaultPreamble::build(test_header(), &key)
            .unwrap()
            .to_bytes();
        let mut magic = bytes.clone();
        magic[0] ^= 1;
        // A damaged magic is "not a vault file".
        assert_eq!(read(&magic).await.unwrap_err(), VaultFormatError::BadMagic);
        let mut version = bytes.clone();
        version[12] = 2;
        // A newer version is reported as such, not as corruption.
        assert_eq!(
            read(&version).await.unwrap_err(),
            VaultFormatError::UnsupportedVersion(2)
        );
        // Flip a byte inside a JSON string value, which still parses: only the MAC sees it.
        let label_offset = bytes
            .windows(b"test vault".len())
            .position(|window| window == b"test vault")
            .unwrap();
        let mut label = bytes.clone();
        label[label_offset] ^= 1;
        assert_eq!(
            read(&label).await.unwrap().verify(&key).unwrap_err(),
            VaultFormatError::HeaderMac
        );
        let mut mac = bytes.clone();
        let last = mac.len() - 1;
        mac[last] ^= 1;
        // A damaged MAC itself fails the same check.
        assert_eq!(
            read(&mac).await.unwrap().verify(&key).unwrap_err(),
            VaultFormatError::HeaderMac
        );
    }

    /// The header length is checked before anything is read, so an agent cannot make
    /// the server buffer a large header.
    #[tokio::test]
    async fn oversized_and_truncated_headers_are_refused() {
        let mut bytes = MAGIC.to_vec();
        bytes.push(FORMAT_VERSION);
        bytes.extend_from_slice(&4097u16.to_be_bytes());
        // A declared length above the limit is refused without reading further.
        assert!(matches!(
            read(&bytes).await.unwrap_err(),
            VaultFormatError::InvalidHeader(_)
        ));
        let key = FileKey::generate();
        let full = VaultPreamble::build(test_header(), &key)
            .unwrap()
            .to_bytes();
        // A file shorter than the magic is not a vault file at all.
        assert_eq!(read(b"just").await.unwrap_err(), VaultFormatError::BadMagic);
        // A file that ends inside the preamble is truncated.
        assert_eq!(
            read(&full[..full.len() - 1]).await.unwrap_err(),
            VaultFormatError::Truncated
        );
        // Invalid JSON is a corrupted header.
        let mut json = MAGIC.to_vec();
        json.push(FORMAT_VERSION);
        json.extend_from_slice(&2u16.to_be_bytes());
        json.extend_from_slice(b"{]");
        json.extend_from_slice(&[0; 32]);
        assert!(matches!(
            read(&json).await.unwrap_err(),
            VaultFormatError::InvalidHeader(_)
        ));
    }

    /// Parameters this version cannot decrypt must be refused when building and reading.
    #[test]
    fn unsupported_parameters_are_refused() {
        let mut header = test_header();
        header.payload.chunk_size = 1024;
        // Another chunk size would make the size arithmetic and the readers disagree.
        assert!(matches!(
            VaultPreamble::build(header, &FileKey::generate()).unwrap_err(),
            VaultFormatError::InvalidHeader(_)
        ));
        let mut header = test_header();
        header.wrap.ct = encode_base64url(&[0; 32]);
        // A wrap without its GCM tag cannot be a wrapped key.
        assert!(matches!(
            VaultPreamble::build(header, &FileKey::generate()).unwrap_err(),
            VaultFormatError::InvalidHeader(_)
        ));
    }
}
