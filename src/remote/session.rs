//! Durable cookie state shared by separate CLI invocations and concurrent control requests.

use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
};

use anyhow::{Context, Result, ensure};
use cookie_store::{Cookie, CookieStore};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

/// Stable guidance used for missing, expired, rejected, or replaced authentication.
pub const LOGIN_REQUIRED: &str =
    "Remote session is missing, expired, or rejected; run `redoor remote login <SERVER_URL>` again";

/// Includes session cookies and absolute expiry so restarting the CLI never extends Max-Age.
#[derive(Serialize, Deserialize)]
pub struct Session {
    pub version: u32,
    pub generation: Uuid,
    pub server_url: String,
    pub cookies: Vec<Cookie<'static>>,
}

impl Session {
    /// Restores metadata directly instead of reparsing Set-Cookie and resetting expiry.
    pub fn cookie_store(&self) -> Result<CookieStore> {
        CookieStore::from_cookies(
            self.cookies.iter().cloned().map(Ok::<_, anyhow::Error>),
            true,
        )
    }

    /// Only an applicable, unexpired authentication cookie makes this session usable.
    pub fn cookie_header(&self, url: &Url) -> Result<String> {
        let jar = self.cookie_store()?;
        // Be stricter than browsers' loopback exception: Secure always means HTTPS for the CLI.
        let mut cookies = jar
            .iter_unexpired()
            .filter(|cookie| {
                cookie.matches(url)
                    && (url.scheme() == "https" || !cookie.secure().unwrap_or(false))
            })
            .collect::<Vec<_>>();
        cookies.sort_by_key(|cookie| std::cmp::Reverse(String::from(&cookie.path).len()));
        let values = cookies
            .iter()
            .map(|cookie| (cookie.name(), cookie.value()))
            .collect::<Vec<_>>();
        ensure!(
            values.iter().any(|(name, _)| *name == "redoor_session"),
            LOGIN_REQUIRED
        );
        Ok(values
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; "))
    }
}

/// A namespace-local store; locking makes response cookie merges safe across processes.
#[derive(Clone)]
pub struct SessionStore {
    directory: PathBuf,
}

impl SessionStore {
    /// Allows tests to isolate HOME without changing process-global environment variables.
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// Uses the same application namespace as configuration, service names, and agent data.
    pub fn for_current_namespace() -> Result<Self> {
        Ok(Self::new(crate::app_name::user_data_directory()?))
    }

    /// Secures the directory before opening any credential file and rejects symlink substitution.
    async fn lock(&self) -> Result<std::fs::File> {
        let mut builder = tokio::fs::DirBuilder::new();
        builder
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)
            .await?;
        let metadata = tokio::fs::symlink_metadata(&self.directory).await?;
        ensure!(
            metadata.is_dir() && metadata.uid() == nix::unistd::Uid::effective().as_raw(),
            "Remote session directory must be owned by the current user and not be a symlink"
        );
        tokio::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700)).await?;
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join("remote-session.lock"))
            .await?;
        Self::check_private(&file.metadata().await?)?;
        let file = file.into_std().await;
        // flock may wait for another process; never hold up a Tokio worker while it does.
        tokio::task::spawn_blocking(move || {
            fs2::FileExt::lock_exclusive(&file)?;
            Ok::<_, anyhow::Error>(file)
        })
        .await
        .context("Failed to acquire remote session lock")?
    }

    /// Refuses unsafe preexisting files rather than reading credentials exposed to other users.
    fn check_private(metadata: &std::fs::Metadata) -> Result<()> {
        ensure!(
            metadata.is_file()
                && metadata.uid() == nix::unistd::Uid::effective().as_raw()
                && metadata.mode() & 0o077 == 0,
            "Remote session file must be a user-owned regular file with user-only permissions"
        );
        Ok(())
    }

    /// Loads under the caller's lock and bounds corrupt or hostile state before parsing it.
    async fn read_locked(&self) -> Result<Option<Session>> {
        let file = match tokio::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join("remote-session.json"))
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        Self::check_private(&file.metadata().await?)?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "Remote session file is too large"
        );
        let session: Session = serde_json::from_slice(&bytes)
            .context("Invalid remote session file; run `redoor remote login` again")?;
        ensure!(
            session.version == 1,
            "Unsupported remote session version; run `redoor remote login` again"
        );
        Ok(Some(session))
    }

    /// Atomic replacement ensures interrupted writes leave either the old or the complete new session.
    async fn write_locked(&self, session: &Session) -> Result<()> {
        let temp = self
            .directory
            .join(format!(".remote-session-{}.tmp", Uuid::new_v4()));
        let result = async {
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temp)
                .await?;
            file.write_all(&serde_json::to_vec(session)?).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temp, self.directory.join("remote-session.json")).await?;
            tokio::fs::File::open(&self.directory)
                .await?
                .sync_all()
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        result
    }

    /// Loads fresh state so concurrent control requests observe cookie rotation immediately.
    pub async fn load(&self) -> Result<Session> {
        let _lock = self.lock().await?;
        self.read_locked().await?.context(LOGIN_REQUIRED)
    }

    /// Called only after login and cookie validation have succeeded, preserving failed-login state.
    pub async fn replace(&self, session: &Session) -> Result<()> {
        let _lock = self.lock().await?;
        self.write_locked(session).await
    }

    /// Merges only response deltas, avoiding lost cookies and resurrection after logout/new login.
    pub async fn update_cookies(
        &self,
        generation: Uuid,
        url: &Url,
        headers: &[String],
    ) -> Result<()> {
        if headers.is_empty() {
            return Ok(());
        }
        let _lock = self.lock().await?;
        let Some(mut session) = self.read_locked().await? else {
            return Ok(());
        };
        if session.generation != generation {
            return Ok(());
        }
        let mut jar = session.cookie_store()?;
        for header in headers {
            let _ = jar.parse(header, url);
        }
        session.cookies = jar.iter_any().cloned().collect();
        self.write_locked(&session).await
    }

    /// Deletes only the selected generation so a simultaneous login is not accidentally logged out.
    pub async fn remove(&self, generation: Uuid) -> Result<()> {
        let _lock = self.lock().await?;
        if self
            .read_locked()
            .await?
            .is_some_and(|session| session.generation == generation)
        {
            tokio::fs::remove_file(self.directory.join("remote-session.json")).await?;
            tokio::fs::File::open(&self.directory)
                .await?
                .sync_all()
                .await?;
        }
        Ok(())
    }
}
