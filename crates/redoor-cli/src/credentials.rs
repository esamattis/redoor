//! The access token saved by `redoor remote login`, and the environment override.
//!
//! A token never changes on the wire, unlike the session cookie this replaces, so there is
//! no read-modify-write: the file is written once at login and read by every command.

use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

/// Shown whenever there is no usable token, so users always learn how to get one.
pub const LOGIN_REQUIRED: &str =
    "Access token is missing, expired or revoked; run `redoor remote login <SERVER_URL>`";

/// Only file layout this build understands; anything else asks the user to log in again.
const CREDENTIALS_VERSION: u32 = 1;
/// Environment variable that turns off server certificate verification, for servers with a
/// self-signed certificate. Read by clap for `login`/`create-token` and by
/// [`insecure_tls_from_environment`] for every other command.
pub const INSECURE_TLS_ENV: &str = "REDOOR_REMOTE_INSECURE_TLS";
/// Name of the file in the application data directory.
const CREDENTIALS_FILE: &str = "remote-credentials.json";
/// A credentials file is tiny; refusing large files bounds memory for corrupt or hostile state.
const MAX_CREDENTIALS_SIZE: u64 = 64 * 1024;

/// What `login` saves. The token is the only secret; the id lets logout and re-login revoke
/// exactly this token.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Credentials {
    pub version: u32,
    pub server_url: String,
    pub token: String,
    pub token_id: Uuid,
    /// Saved from `login --insecure-tls`, so later commands reach the same self-signed server
    /// without repeating the flag. Defaults to off for files written before it existed.
    #[serde(default)]
    pub insecure_tls: bool,
}

/// Reads [`INSECURE_TLS_ENV`] like clap's `FalseyValueParser` reads it for the login flags, so
/// one value means the same thing for every command: unset, empty, `0`, `false`, `no`, `off`,
/// `n` and `f` are off, anything else is on.
pub fn insecure_tls_from_environment(value: Option<String>) -> bool {
    value.is_some_and(|value| {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off" | "n" | "f"
        )
    })
}

impl Credentials {
    /// Builds credentials from `REDOOR_REMOTE_SERVER` and `REDOOR_REMOTE_TOKEN`, so CI jobs and AI
    /// agents can run without a saved login. Both or neither must be set: one alone is almost
    /// certainly a mistake that would otherwise silently fall back to another server's token.
    pub fn from_environment(server: Option<String>, token: Option<String>) -> Result<Option<Self>> {
        let server = server.filter(|value| !value.is_empty());
        let token = token.filter(|value| !value.is_empty());
        match (server, token) {
            (Some(server_url), Some(token)) => Ok(Some(Self {
                version: CREDENTIALS_VERSION,
                server_url,
                token,
                token_id: Uuid::nil(),
                // `RemoteClient::from_credentials` applies `REDOOR_REMOTE_INSECURE_TLS`.
                insecure_tls: false,
            })),
            (None, None) => Ok(None),
            _ => bail!("Set both REDOOR_REMOTE_SERVER and REDOOR_REMOTE_TOKEN, or neither"),
        }
    }
}

/// The namespace-local credentials file, with the same safety rules for every access.
#[derive(Clone)]
pub struct CredentialStore {
    directory: PathBuf,
}

impl CredentialStore {
    /// Stores credentials in the given application data directory; `main` passes the
    /// namespace's data directory and tests pass a temporary one.
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// Reads the saved credentials, or `None` when nobody has logged in.
    pub async fn load(&self) -> Result<Option<Credentials>> {
        match tokio::fs::symlink_metadata(&self.directory).await {
            Ok(metadata) => Self::check_directory(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let file = match tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join(CREDENTIALS_FILE))
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        Self::check_private(&file.metadata().await?)?;
        let mut bytes = Vec::new();
        file.take(MAX_CREDENTIALS_SIZE + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(
            bytes.len() as u64 <= MAX_CREDENTIALS_SIZE,
            "Remote credentials file is too large"
        );
        let credentials: Credentials = serde_json::from_slice(&bytes)
            .context("Invalid remote credentials file; run `redoor remote login` again")?;
        ensure!(
            credentials.version == CREDENTIALS_VERSION,
            "Unsupported remote credentials version; run `redoor remote login` again"
        );
        Ok(Some(credentials))
    }

    /// Replaces the file atomically, so an interrupted login leaves the old or the new token.
    pub async fn save(&self, credentials: &Credentials) -> Result<()> {
        self.secure_directory().await?;
        let temporary = self
            .directory
            .join(format!(".remote-credentials-{}.tmp", Uuid::new_v4()));
        let result = async {
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)
                .await?;
            file.write_all(&serde_json::to_vec_pretty(credentials)?)
                .await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, self.directory.join(CREDENTIALS_FILE)).await?;
            tokio::fs::File::open(&self.directory)
                .await?
                .sync_all()
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result
    }

    /// Deletes the saved token; returns whether there was one.
    pub async fn remove(&self) -> Result<bool> {
        match tokio::fs::remove_file(self.directory.join(CREDENTIALS_FILE)).await {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Creates the directory as 0700 and refuses one that another user could swap or read.
    async fn secure_directory(&self) -> Result<()> {
        tokio::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)
            .await?;
        Self::check_directory(&tokio::fs::symlink_metadata(&self.directory).await?)?;
        tokio::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700)).await?;
        Ok(())
    }

    /// The directory must be a real directory owned by the current user, not a symlink.
    fn check_directory(metadata: &std::fs::Metadata) -> Result<()> {
        ensure!(
            metadata.is_dir() && metadata.uid() == nix::unistd::Uid::effective().as_raw(),
            "Remote credentials directory must be owned by the current user and not be a symlink"
        );
        Ok(())
    }

    /// Refuses files other users could read or replace, rather than trusting their token.
    fn check_private(metadata: &std::fs::Metadata) -> Result<()> {
        ensure!(
            metadata.is_file()
                && metadata.uid() == nix::unistd::Uid::effective().as_raw()
                && metadata.mode() & 0o077 == 0,
            "Remote credentials file must be a user-owned regular file with user-only permissions"
        );
        Ok(())
    }
}
