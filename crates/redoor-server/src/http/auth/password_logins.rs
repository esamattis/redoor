//! The `[[server.users]]` password logins, read from the config file whenever it changes.
//!
//! The file is the only source of truth for these logins, so a hand edit (a new user, a
//! removed one, a changed password) applies on the next request without a restart, and the
//! password change form only has to write the file. Every check stats the file and parses it
//! again only when its metadata changed, which keeps a check per request cheap.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use anyhow::Context;
use redoor_core::config::{ConfiguredPassword, ConfiguredUser};
use redoor_core::{log, log_error};
use redoor_protocol::wire::log::Level;

use super::{
    HASH_FINGERPRINT_DOMAIN, PLAINTEXT_FINGERPRINT_DOMAIN, credentials_fingerprint, hash_password,
};

/// The verifier of one `[[server.users]]` login, kept together because a session is bound
/// to the fingerprint of the hash that was checked.
#[derive(Clone)]
pub(super) struct PasswordUser {
    /// Argon2id PHC hash of the password.
    pub(super) hash: String,
    /// Stable digest of the password as written in the file, so changing it revokes this
    /// user's sessions.
    pub(super) fingerprint: String,
}

/// Password logins by name.
pub(super) type Logins = HashMap<String, PasswordUser>;

/// The logins of one config file, cached until the file changes.
pub(super) struct PasswordLogins {
    /// The server's config file, which owns the logins.
    config_path: PathBuf,
    /// An async mutex, so requests that notice the same change parse the file and hash its
    /// plaintext passwords once instead of all at the same time.
    cache: tokio::sync::Mutex<Cache>,
}

/// The logins last read and the file version they came from.
struct Cache {
    /// Metadata of the file when it was last read; `None` when it could not be inspected,
    /// so only the first of a run of failures is logged.
    stamp: Option<FileStamp>,
    /// The last logins that parsed. A broken or missing file keeps them, so a half-saved
    /// hand edit does not sign everyone out.
    logins: Arc<Logins>,
    /// Whether `logins` are the file's as it is now, false while it is missing or broken.
    loaded: bool,
}

/// The logins at one check and whether the file as it is now loaded.
pub(super) struct Snapshot {
    /// The current logins, or the last ones that parsed.
    pub(super) logins: Arc<Logins>,
    /// False while the file is missing or broken, so a password written into it now would
    /// not apply until it is fixed.
    pub(super) loaded: bool,
}

/// File metadata that changes whenever the file is rewritten in place or replaced, so a
/// matching stamp means the cached logins are still the file's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    /// Size, which tells apart two writes within one coarse timestamp tick.
    len: u64,
    /// Content modification time.
    modified: Option<SystemTime>,
    /// Inode, which changes when an editor or the password form replaces the file by rename.
    #[cfg(unix)]
    inode: u64,
    /// Status change time in seconds and nanoseconds; also moves on a rename that keeps the
    /// modification time.
    #[cfg(unix)]
    changed: (i64, i64),
}

impl FileStamp {
    /// Takes the stamp of a file's current metadata.
    fn of(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

impl PasswordLogins {
    /// Reads the logins at startup. Unlike later reads, a failure here is an error, because
    /// there are no earlier logins to fall back to.
    pub(super) async fn load(config_path: PathBuf) -> anyhow::Result<Self> {
        let metadata = tokio::fs::metadata(&config_path)
            .await
            .with_context(|| format!("Failed to inspect '{}'", config_path.display()))?;
        let users = read_users(&config_path).await?;
        let logins = build_off_thread(users, Arc::default()).await?;
        Ok(Self {
            cache: tokio::sync::Mutex::new(Cache {
                stamp: Some(FileStamp::of(&metadata)),
                logins: Arc::new(logins),
                loaded: true,
            }),
            config_path,
        })
    }

    /// The logins as the config file has them now, or the last ones that parsed when the file
    /// is broken or missing.
    pub(super) async fn current(&self) -> Arc<Logins> {
        self.snapshot().await.logins
    }

    /// The verifier of one login, if the config file currently has it.
    pub(super) async fn user(&self, name: &str) -> Option<PasswordUser> {
        self.current().await.get(name).cloned()
    }

    /// [`Self::current`] together with whether the file as it is now loaded.
    pub(super) async fn snapshot(&self) -> Snapshot {
        let mut cache = self.cache.lock().await;
        // Stat before reading: a write that lands in between then leaves a stamp older than
        // the content, which only causes one extra read on the next check.
        let stamp = match tokio::fs::metadata(&self.config_path).await {
            Ok(metadata) => FileStamp::of(&metadata),
            Err(error) => {
                if cache.stamp.take().is_some() {
                    log_error!(
                        anyhow::Error::new(error),
                        "Failed to inspect the config file; keeping the previous password logins"
                    );
                }
                cache.loaded = false;
                return cache.snapshot();
            }
        };
        if cache.stamp == Some(stamp) {
            return cache.snapshot();
        }
        // Recorded even when the read fails, so a broken file is reported once, not on every
        // request, and is read again as soon as it is saved again.
        cache.stamp = Some(stamp);
        let previous = cache.logins.clone();
        let read = async {
            let users = read_users(&self.config_path).await?;
            build_off_thread(users, previous).await
        };
        match read.await {
            Ok(logins) => {
                log!(
                    Level::Info,
                    "Read the password logins from the changed config file: users={}",
                    logins.len()
                );
                cache.logins = Arc::new(logins);
                cache.loaded = true;
            }
            Err(error) => {
                log_error!(
                    error,
                    "Failed to read the changed config file; keeping the previous password logins"
                );
                cache.loaded = false;
            }
        }
        cache.snapshot()
    }
}

impl Cache {
    /// What a check sees of this cache.
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            logins: self.logins.clone(),
            loaded: self.loaded,
        }
    }
}

/// Parses the config file and returns its password logins.
async fn read_users(config_path: &Path) -> anyhow::Result<Vec<ConfiguredUser>> {
    let config = redoor_core::config::parse_config_file(config_path).await?;
    Ok(redoor_core::config::require_server_section(&config)?
        .users
        .clone())
}

/// [`build`] on the blocking pool, because hashing a plaintext password with Argon2 is
/// deliberately slow.
async fn build_off_thread(
    users: Vec<ConfiguredUser>,
    previous: Arc<Logins>,
) -> anyhow::Result<Logins> {
    redoor_core::logging::spawn_blocking_in_user_scope(move || build(users, &previous))
        .await
        .map_err(|error| anyhow::anyhow!("password hashing task failed: {error}"))?
}

/// Builds the verifiers of `users`, reusing the ones in `previous` whose password did not
/// change, so an unrelated edit of the file does not hash every plaintext password again.
fn build(users: Vec<ConfiguredUser>, previous: &Logins) -> anyhow::Result<Logins> {
    users
        .into_iter()
        .map(|user| {
            let fingerprint = fingerprint(&user.password);
            let verifier = match previous.get(&user.name) {
                Some(existing) if existing.fingerprint == fingerprint => existing.clone(),
                _ => PasswordUser {
                    hash: match user.password {
                        ConfiguredPassword::Plaintext(password) => {
                            hash_password(&zeroize::Zeroizing::new(password))?
                        }
                        ConfiguredPassword::Argon2Hash(hash) => hash,
                    },
                    fingerprint,
                },
            };
            Ok((user.name, verifier))
        })
        .collect()
}

/// The session fingerprint of a password as written in the file.
fn fingerprint(password: &ConfiguredPassword) -> String {
    match password {
        // Independent of the per-process Argon2 salt, so sessions survive restarts until the
        // operator actually changes the password.
        ConfiguredPassword::Plaintext(password) => {
            credentials_fingerprint(PLAINTEXT_FINGERPRINT_DOMAIN, password)
        }
        // The stored hash has a fixed salt, so it fingerprints the password as stably as the
        // plaintext does, and matches what a password change computes from the hash it writes.
        ConfiguredPassword::Argon2Hash(hash) => {
            credentials_fingerprint(HASH_FINGERPRINT_DOMAIN, hash)
        }
    }
}
