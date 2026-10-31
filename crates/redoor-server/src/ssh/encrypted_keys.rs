//! Managed SSH private keys stored as vault objects (`kind: "ssh-key"`).
//!
//! The file is an ordinary `.redoorencrypted` file: the payload is the OpenSSH private key text,
//! and the header context binds it to one account and one device and carries the OpenSSH
//! public key. The header MAC (keyed by the file key) covers the context, so a key file
//! copied to another device's or account's directory, or a header whose public key was
//! swapped, is refused when it is opened.
//!
//! The public key in the header keeps the fingerprint, the status page and the
//! `authorized_keys` cleanup working while the key is locked, and keeps the layout at one
//! file per key, so a single rename still switches keys.
//!
//! Key files are a few hundred bytes, so they are encrypted and decrypted in memory; the
//! plaintext lives only in zeroizing buffers.

use std::collections::BTreeMap;

use redoor_protocol::api::vault::{
    VAULT_PAYLOAD_ALG, VaultFileHeader, VaultKeyWrap, VaultObjectKind, VaultPayloadParams,
};
use redoor_protocol::ids::AgentId;
use redoor_vault::{
    CHUNK_SIZE, DecryptingReader, EncryptingReader, FileKey, PAYLOAD_SALT_LEN, VaultFormatError,
    VaultPreamble, VaultReadError, random_base64url,
};
use ssh_key::{PrivateKey, PublicKey};
use tokio::io::AsyncReadExt;
use zeroize::Zeroizing;

use super::keys::SshPrivateKey;

/// Longest private key file accepted, far above an ed25519 key with any comment, so a
/// damaged or foreign file cannot make the server buffer much.
pub(crate) const MAX_SSH_KEY_FILE_LEN: u64 = 64 * 1024;

/// Header context field naming the account the key belongs to.
const CONTEXT_ACCOUNT: &str = "account";
/// Header context field naming the device the key belongs to.
const CONTEXT_DEVICE_ID: &str = "device_id";
/// Header context field with the OpenSSH public key.
const CONTEXT_PUBLIC_KEY: &str = "public_key";

/// What the browser supplies to encrypt a new key: a fresh file key, its wrap under the
/// current generation, and the vault fields the header records.
///
/// The browser never sees the private key and does not need the fingerprint first: the
/// header context is bound by the MAC, not by the wrap.
pub(crate) struct SshKeySeal {
    /// The vault the key is encrypted with.
    pub(crate) vault_id: String,
    /// Copied into the header so a foreign-vault error can name the vault.
    pub(crate) vault_label: String,
    /// The current generation, which wraps the file key.
    pub(crate) key_id: String,
    /// The new file key.
    pub(crate) file_key: FileKey,
    /// The file key wrapped by the browser with `key_id`.
    pub(crate) wrap: VaultKeyWrap,
}

/// Why an encrypted SSH key could not be opened.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SshKeyOpenError {
    /// The bytes are not a valid encrypted file, or the file key does not open it.
    #[error(transparent)]
    Format(#[from] VaultFormatError),
    /// The file is valid but belongs to another account, device or key, or is not an SSH
    /// key at all. Nothing in it is used.
    #[error("{0}")]
    Mismatch(String),
}

/// An encrypted key file as read from disk: its authenticated-later header and all its
/// bytes, so later steps (decrypting, rewrapping) work on exactly the version whose header
/// was checked, even if a rotation renames a new file into place meanwhile.
#[derive(Clone)]
pub(crate) struct EncryptedKeyFile {
    /// The parsed preamble. Its header is not authenticated until the MAC is verified.
    preamble: VaultPreamble,
    /// The whole file.
    bytes: Vec<u8>,
    /// The public key from the header context.
    public_key: PublicKey,
}

impl std::fmt::Debug for EncryptedKeyFile {
    /// Prints only the public parts; the payload is ciphertext but has no use in logs.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EncryptedKeyFile")
            .field("header", self.preamble.header())
            .finish()
    }
}

impl EncryptedKeyFile {
    /// Parses a key file's preamble, refusing anything that is not an SSH key header with a
    /// readable public key.
    pub(crate) async fn parse(bytes: Vec<u8>) -> Result<Self, SshKeyOpenError> {
        let mut reader = bytes.as_slice();
        let preamble = VaultPreamble::read(&mut reader)
            .await
            .map_err(|error| match error {
                VaultReadError::Format(error) => error,
                // Reading from a slice cannot fail with anything but a format error.
                VaultReadError::Io(error) => VaultFormatError::InvalidHeader(error.to_string()),
            })?;
        let header = preamble.header();
        if header.kind != VaultObjectKind::SshKey {
            return Err(SshKeyOpenError::Mismatch(format!(
                "The file holds a vault object of kind '{}', not an SSH key",
                header.kind.as_str()
            )));
        }
        let public_key = header
            .context
            .get(CONTEXT_PUBLIC_KEY)
            .and_then(|text| PublicKey::from_openssh(text).ok())
            .ok_or_else(|| {
                SshKeyOpenError::Mismatch(
                    "The SSH key file's header has no valid public key".to_string(),
                )
            })?;
        Ok(Self {
            preamble,
            bytes,
            public_key,
        })
    }

    /// The header, for the vault id and generation checks and the browser's unwrap.
    pub(crate) fn header(&self) -> &VaultFileHeader {
        self.preamble.header()
    }

    /// The public key recorded in the header.
    pub(crate) fn public_key(&self) -> &PublicKey {
        &self.public_key
    }

    /// Decrypts the private key after checking that the file key authenticates the header,
    /// that the header binds the key to `account` and `device`, and that the private key's
    /// public half is the header's public key. Any mismatch is an error, so nothing from a
    /// misplaced or tampered file is ever used.
    pub(crate) async fn open(
        &self,
        file_key: &FileKey,
        account: &str,
        device: &AgentId,
    ) -> Result<SshPrivateKey, SshKeyOpenError> {
        self.preamble.verify(file_key)?;
        let context = &self.header().context;
        if context.get(CONTEXT_ACCOUNT).map(String::as_str) != Some(account)
            || context.get(CONTEXT_DEVICE_ID).map(String::as_str) != Some(device.as_str())
        {
            return Err(SshKeyOpenError::Mismatch(format!(
                "The SSH key file belongs to another account or device, not to device '{device}' of account '{account}'"
            )));
        }
        let payload = &self.bytes[self.preamble.len()..];
        let mut reader = DecryptingReader::new(payload, &self.preamble, file_key)?;
        let mut text = Zeroizing::new(Vec::new());
        reader.read_to_end(&mut text).await.map_err(|error| {
            VaultFormatError::from_io(&error).unwrap_or(VaultFormatError::Truncated)
        })?;
        let private_key = PrivateKey::from_openssh(text.as_slice()).map_err(|_| {
            SshKeyOpenError::Mismatch(
                "The decrypted SSH key is not an OpenSSH private key".to_string(),
            )
        })?;
        if private_key.public_key().key_data() != self.public_key.key_data() {
            return Err(SshKeyOpenError::Mismatch(
                "The SSH key file's header names another public key than the private key it holds"
                    .to_string(),
            ));
        }
        Ok(SshPrivateKey::new(private_key))
    }

    /// The same file under a new wrap of the same file key: the header gets the new
    /// generation and wrap, and the payload bytes are copied unchanged. The old MAC is
    /// checked with the file key first, which proves the key belongs to this file.
    pub(crate) fn rewrapped(
        &self,
        file_key: &FileKey,
        key_id: String,
        wrap: VaultKeyWrap,
        vault_label: String,
    ) -> Result<Vec<u8>, VaultFormatError> {
        self.preamble.verify(file_key)?;
        let preamble = VaultPreamble::build(
            VaultFileHeader {
                vault_label,
                key_id,
                wrap,
                ..self.header().clone()
            },
            file_key,
        )?;
        let payload = &self.bytes[self.preamble.len()..];
        let mut bytes = preamble.to_bytes();
        bytes.extend_from_slice(payload);
        Ok(bytes)
    }
}

/// Encrypts `private_key` into the bytes of a new key file bound to `account` and `device`.
pub(crate) async fn seal(
    private_key: &SshPrivateKey,
    account: &str,
    device: &AgentId,
    seal: &SshKeySeal,
) -> std::io::Result<Vec<u8>> {
    let context = BTreeMap::from([
        (CONTEXT_ACCOUNT.to_string(), account.to_string()),
        (CONTEXT_DEVICE_ID.to_string(), device.to_string()),
        (
            CONTEXT_PUBLIC_KEY.to_string(),
            private_key.public_key_openssh(),
        ),
    ]);
    let preamble = VaultPreamble::build(
        VaultFileHeader {
            vault_id: seal.vault_id.clone(),
            vault_label: seal.vault_label.clone(),
            key_id: seal.key_id.clone(),
            kind: VaultObjectKind::SshKey,
            context,
            wrap: seal.wrap.clone(),
            payload: VaultPayloadParams {
                alg: VAULT_PAYLOAD_ALG.to_string(),
                chunk_size: CHUNK_SIZE as u32,
                salt: random_base64url(PAYLOAD_SALT_LEN),
            },
        },
        &seal.file_key,
    )
    .map_err(VaultFormatError::into_io)?;
    let text = private_key.to_openssh()?;
    let mut reader = EncryptingReader::new(text.as_bytes(), &preamble, &seal.file_key)
        .map_err(VaultFormatError::into_io)?;
    let mut bytes = preamble.to_bytes();
    reader.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::api::vault::VAULT_WRAP_ALG;
    use redoor_vault::{WRAP_CT_LEN, WRAP_IV_LEN};

    /// A seal with a random wrap; the server never opens wraps, so any valid shape works.
    fn test_seal() -> SshKeySeal {
        SshKeySeal {
            vault_id: "vlt_0123456789abcdef0123456789abcdef".to_string(),
            vault_label: "test vault".to_string(),
            key_id: "kid_0123456789abcdef0123456789abcdef".to_string(),
            file_key: FileKey::generate(),
            wrap: VaultKeyWrap {
                alg: VAULT_WRAP_ALG.to_string(),
                iv: random_base64url(WRAP_IV_LEN),
                ct: random_base64url(WRAP_CT_LEN),
            },
        }
    }

    /// A key file opens only for its own account and device, and only with its file key.
    #[tokio::test]
    async fn key_file_opens_only_for_its_account_and_device() {
        let device = AgentId::generate();
        let key = SshPrivateKey::generate().unwrap();
        let seal = test_seal();
        let file =
            EncryptedKeyFile::parse(super::seal(&key, "alice", &device, &seal).await.unwrap())
                .await
                .unwrap();
        // The header names the key's public half, readable without the file key.
        assert_eq!(file.public_key().key_data(), key.public_key().key_data());
        let opened = file.open(&seal.file_key, "alice", &device).await.unwrap();
        // The right account, device and file key give back the same private key.
        assert_eq!(opened.public_key().key_data(), key.public_key().key_data());
        // Another account cannot use the key.
        assert!(matches!(
            file.open(&seal.file_key, "bob", &device).await.unwrap_err(),
            SshKeyOpenError::Mismatch(_)
        ));
        // Another device cannot use the key.
        assert!(matches!(
            file.open(&seal.file_key, "alice", &AgentId::generate())
                .await
                .unwrap_err(),
            SshKeyOpenError::Mismatch(_)
        ));
        // Another file key fails the header MAC.
        assert!(matches!(
            file.open(&FileKey::generate(), "alice", &device)
                .await
                .unwrap_err(),
            SshKeyOpenError::Format(VaultFormatError::HeaderMac)
        ));
    }

    /// A header whose public key is not the private key's is refused, even though its MAC
    /// is valid, so the status and the `authorized_keys` marker can never describe another
    /// key than the one that logs in.
    #[tokio::test]
    async fn header_with_another_public_key_is_refused() {
        let device = AgentId::generate();
        let key = SshPrivateKey::generate().unwrap();
        let other = SshPrivateKey::generate().unwrap();
        let seal = test_seal();
        let file =
            EncryptedKeyFile::parse(super::seal(&key, "alice", &device, &seal).await.unwrap())
                .await
                .unwrap();
        // Rebuild the header with another public key and a valid MAC over it.
        let mut header = file.header().clone();
        header
            .context
            .insert(CONTEXT_PUBLIC_KEY.to_string(), other.public_key_openssh());
        let preamble = VaultPreamble::build(header, &seal.file_key).unwrap();
        let mut forged = preamble.to_bytes();
        forged.extend_from_slice(&file.bytes[file.preamble.len()..]);
        let forged = EncryptedKeyFile::parse(forged).await.unwrap();
        // The payload no longer matches the header's public key.
        assert!(matches!(
            forged
                .open(&seal.file_key, "alice", &device)
                .await
                .unwrap_err(),
            SshKeyOpenError::Mismatch(_)
        ));
    }

    /// A rewrap keeps the payload and the binding and changes only the generation and wrap.
    #[tokio::test]
    async fn rewrap_keeps_the_key_and_needs_its_file_key() {
        let device = AgentId::generate();
        let key = SshPrivateKey::generate().unwrap();
        let seal = test_seal();
        let file =
            EncryptedKeyFile::parse(super::seal(&key, "alice", &device, &seal).await.unwrap())
                .await
                .unwrap();
        let new_wrap = test_seal().wrap;
        let new_key_id = "kid_ffffffffffffffffffffffffffffffff".to_string();
        // Another file key cannot rewrap, because the old MAC proves which key the file has.
        assert_eq!(
            file.rewrapped(
                &FileKey::generate(),
                new_key_id.clone(),
                new_wrap.clone(),
                "test vault".to_string()
            )
            .unwrap_err(),
            VaultFormatError::HeaderMac
        );
        let rewrapped = EncryptedKeyFile::parse(
            file.rewrapped(
                &seal.file_key,
                new_key_id.clone(),
                new_wrap.clone(),
                "test vault".to_string(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        // The header names the new generation and wrap.
        assert_eq!(rewrapped.header().key_id, new_key_id);
        assert_eq!(rewrapped.header().wrap, new_wrap);
        // The same file key still opens the same private key.
        let opened = rewrapped
            .open(&seal.file_key, "alice", &device)
            .await
            .unwrap();
        assert_eq!(opened.public_key().key_data(), key.public_key().key_data());
    }

    /// A user file cannot pass for an SSH key.
    #[tokio::test]
    async fn file_kind_is_not_an_ssh_key() {
        let seal = test_seal();
        let preamble = VaultPreamble::build(
            VaultFileHeader {
                vault_id: seal.vault_id.clone(),
                vault_label: seal.vault_label.clone(),
                key_id: seal.key_id.clone(),
                kind: VaultObjectKind::File,
                context: BTreeMap::new(),
                wrap: seal.wrap.clone(),
                payload: VaultPayloadParams {
                    alg: VAULT_PAYLOAD_ALG.to_string(),
                    chunk_size: CHUNK_SIZE as u32,
                    salt: random_base64url(PAYLOAD_SALT_LEN),
                },
            },
            &seal.file_key,
        )
        .unwrap();
        // The kind is checked before anything else of the file is used.
        assert!(matches!(
            EncryptedKeyFile::parse(preamble.to_bytes())
                .await
                .unwrap_err(),
            SshKeyOpenError::Mismatch(_)
        ));
    }
}
