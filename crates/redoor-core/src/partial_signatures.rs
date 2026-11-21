//! A server-only secret binds resume to endpoints the user previously authorized.

use redoor_protocol::wire::partials::{PartialAuthorization, SignedPartial};
use std::{os::unix::fs::MetadataExt, path::PathBuf};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncReadExt, AsyncWriteExt},
    sync::OnceCell,
};

/// Lazy loading avoids filesystem work until the server first uses resumable transfers.
#[derive(Debug)]
pub struct PartialSigner {
    path: PathBuf,
    key: OnceCell<[u8; 32]>,
}
impl PartialSigner {
    /// The secret lives beside server sessions, never in shared agent configuration.
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            path: data_dir.join("partials-signing-key"),
            key: OnceCell::new(),
        }
    }

    /// Installs a complete key atomically without overwriting another server's key.
    async fn key(&self) -> std::io::Result<&[u8; 32]> {
        self.key
            .get_or_try_init(|| async {
                let parent = self
                    .path
                    .parent()
                    .ok_or_else(|| std::io::Error::other("Missing key directory"))?;
                tokio::fs::create_dir_all(parent).await?;
                if !tokio::fs::try_exists(&self.path).await? {
                    let temp = parent.join(format!(".partial-key-{}", uuid::Uuid::new_v4()));
                    let mut key = [0; 32];
                    getrandom::fill(&mut key).map_err(std::io::Error::other)?;
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&temp)
                        .await?;
                    file.write_all(&key).await?;
                    file.sync_all().await?;
                    let result = tokio::fs::hard_link(&temp, &self.path).await;
                    tokio::fs::remove_file(&temp).await?;
                    match result {
                        Ok(()) => File::open(parent).await?.sync_all().await?,
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error),
                    }
                }
                let mut file = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&self.path)
                    .await?;
                let metadata = file.metadata().await?;
                if !metadata.is_file()
                    || metadata.len() != 32
                    || metadata.mode() & 0o077 != 0
                    || metadata.uid() != nix::unistd::Uid::effective().as_raw()
                {
                    return Err(std::io::Error::other("Unsafe partial signing key"));
                }
                let mut key = [0; 32];
                file.read_exact(&mut key).await?;
                Ok(key)
            })
            .await
    }

    /// Signing covers a fixed canonical tuple bound to `owner` so a partial left on an agent
    /// whose token is reassigned to another user never verifies under the new owner.
    pub async fn sign_for_owner(
        &self,
        owner: &str,
        authorization: PartialAuthorization,
    ) -> std::io::Result<SignedPartial> {
        let mut payload = Vec::with_capacity(owner.len() + 1 + 128);
        payload.extend_from_slice(owner.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&crate::partials::canonical(&authorization));
        let signature = blake3::keyed_hash(self.key().await?, &payload)
            .to_hex()
            .to_string();
        Ok(SignedPartial {
            authorization,
            signature,
        })
    }

    /// Hash equality uses the digest's constant-time comparison after decoding untrusted text,
    /// scoped to `owner`.
    pub async fn verify_for_owner(
        &self,
        owner: &str,
        signed: &SignedPartial,
    ) -> std::io::Result<bool> {
        let Ok(signature) = blake3::Hash::from_hex(&signed.signature) else {
            return Ok(false);
        };
        let mut payload = Vec::with_capacity(owner.len() + 1 + 128);
        payload.extend_from_slice(owner.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&crate::partials::canonical(&signed.authorization));
        Ok(signed.authorization.version == 1
            && signature == blake3::keyed_hash(self.key().await?, &payload))
    }

    /// Signing covers a fixed canonical tuple, including operation and conflict policy.
    pub async fn sign(
        &self,
        authorization: PartialAuthorization,
    ) -> std::io::Result<SignedPartial> {
        let signature = blake3::keyed_hash(
            self.key().await?,
            &crate::partials::canonical(&authorization),
        )
        .to_hex()
        .to_string();
        Ok(SignedPartial {
            authorization,
            signature,
        })
    }

    /// Hash equality uses the digest's constant-time comparison after decoding untrusted text.
    pub async fn verify(&self, signed: &SignedPartial) -> std::io::Result<bool> {
        let Ok(signature) = blake3::Hash::from_hex(&signed.signature) else {
            return Ok(false);
        };
        Ok(signed.authorization.version == 1
            && signature
                == blake3::keyed_hash(
                    self.key().await?,
                    &crate::partials::canonical(&signed.authorization),
                ))
    }
}
