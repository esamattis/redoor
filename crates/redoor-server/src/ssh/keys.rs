//! On-disk layout of redoor-managed SSH keys and pinned host keys.
//!
//! ```text
//! <data_dir>/users/<account>/ssh/<device-id>/
//!     known_hosts                         0600, pinned host key (per account)
//!     id_ed25519                          0600, plaintext key (account without a vault)
//!     id_ed25519.redoorencrypted          0600, key encrypted with the account's vault
//!     id_ed25519.next                     0600, staged plaintext key during setup or rotation
//!     id_ed25519.next.redoorencrypted     0600, staged encrypted key during setup or rotation
//! ```
//!
//! Keys and pins belong to the account that set them up, next to its `vault.json`, because
//! each user owns their own authentication and security material. Within an account
//! everything is keyed by the permanent device id, so renames and reused names can never
//! orphan a key or hand it to another device. The pinned host key belongs to the device,
//! not to a key, so it survives rotation.
//!
//! The current key always has one of two fixed paths, so switching to a new key is a single
//! atomic rename of the staged file: a concurrent agent start reads either the old or the
//! new complete key, and rotation needs no config write (which would stop the agent). There
//! is no `.pub` file, because a second file could not be switched in the same rename; the
//! public key is derived from a plaintext key and read from an encrypted key's header.
//!
//! At most one of the two current forms should exist. Keys only ever change from plaintext
//! to encrypted (an account with a vault cannot set up plaintext keys), so a reader that
//! finds both after a crash between the commit's rename and its cleanup uses the encrypted
//! one, and the next commit or removal deletes the leftover.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use redoor_protocol::ids::AgentId;
use ssh_key::{HashAlg, LineEnding, PrivateKey, PublicKey, private::Ed25519Keypair};
use tokio::io::AsyncWriteExt;
use zeroize::Zeroizing;

use super::encrypted_keys::{EncryptedKeyFile, MAX_SSH_KEY_FILE_LEN, SshKeySeal, seal};

/// File name of the device's current plaintext private key.
const PLAINTEXT_KEY_FILE: &str = "id_ed25519";
/// File name of the device's current private key encrypted with the account's vault.
const ENCRYPTED_KEY_FILE: &str = "id_ed25519.redoorencrypted";
/// File name of a plaintext key that is installed and verified but not yet current.
const STAGED_PLAINTEXT_KEY_FILE: &str = "id_ed25519.next";
/// File name of an encrypted key that is installed and verified but not yet current.
const STAGED_ENCRYPTED_KEY_FILE: &str = "id_ed25519.next.redoorencrypted";
/// File name of the pinned host key inside a device directory.
const KNOWN_HOSTS_FILE: &str = "known_hosts";
/// Directory of every account's files inside the data directory.
const USERS_DIR: &str = "users";
/// Directory of an account's SSH keys and pins inside its account directory.
const ACCOUNT_SSH_DIR: &str = "ssh";

/// Owns `<data_dir>/users/*/ssh` and the file modes of everything under it.
#[derive(Clone, Debug)]
pub(crate) struct SshKeyStore {
    /// `<data_dir>/users`.
    users_root: PathBuf,
    /// Serializes `authorized_keys` rewrites across all devices and accounts of this
    /// server. Several devices can share one remote account, and the per-device busy set
    /// does not stop two of them from reading and replacing the same file at once and
    /// losing a line.
    authorized_keys_lock: Arc<tokio::sync::Mutex<()>>,
}

impl SshKeyStore {
    /// Stores keys under `<data_dir>/users/<account>/ssh`.
    pub(crate) fn for_data_dir(data_dir: &Path) -> Self {
        Self {
            users_root: data_dir.join(USERS_DIR),
            authorized_keys_lock: Arc::default(),
        }
    }

    /// The keys and pins of one account.
    ///
    /// The name is validated like a login name, because it becomes a path component and is
    /// part of the `authorized_keys` marker; the allowed characters exclude `/`, `:` and
    /// whitespace, so it can neither escape the data directory nor break the marker.
    pub(crate) fn account(&self, account: &str) -> std::io::Result<AccountSshKeys> {
        let account = redoor_core::config::parse_server_username(account).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("The account name cannot hold SSH keys: {error}"),
            )
        })?;
        Ok(AccountSshKeys {
            root: self.users_root.join(&account).join(ACCOUNT_SSH_DIR),
            account,
            store: self.clone(),
        })
    }

    /// Every account that has an account directory, for changes that concern all accounts'
    /// keys of a device. Entries that are not valid account names are skipped.
    async fn accounts(&self) -> std::io::Result<Vec<AccountSshKeys>> {
        let mut entries = match tokio::fs::read_dir(&self.users_root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut accounts = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            if let Some(account) = entry
                .file_name()
                .to_str()
                .and_then(|name| self.account(name).ok())
            {
                accounts.push(account);
            }
        }
        Ok(accounts)
    }

    /// Deletes everything every account stored for a device, for a deleted device or a
    /// target that may now be another machine. Each account set up its own key and pin, so
    /// none of them may survive.
    pub(crate) async fn delete_device_for_all_accounts(
        &self,
        device: &AgentId,
    ) -> std::io::Result<()> {
        for account in self.accounts().await? {
            account.delete_device(device).await?;
        }
        Ok(())
    }

    /// Deletes every account's keys of a device but keeps their pins, for a new SSH username
    /// on the same machine: no account's key is installed for the new login.
    pub(crate) async fn delete_keys_for_all_accounts(
        &self,
        device: &AgentId,
    ) -> std::io::Result<()> {
        for account in self.accounts().await? {
            account.delete_keys(device).await?;
        }
        Ok(())
    }

    /// Held while one `authorized_keys` rewrite runs on a device.
    pub(crate) async fn lock_authorized_keys(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.authorized_keys_lock.lock().await
    }
}

/// The SSH keys and pins of one account: `<data_dir>/users/<account>/ssh`.
#[derive(Clone, Debug)]
pub(crate) struct AccountSshKeys {
    /// The validated account name, used in the `authorized_keys` marker and in the
    /// encrypted key's header context.
    account: String,
    /// `<data_dir>/users/<account>/ssh`.
    root: PathBuf,
    /// The server-wide store, for the shared `authorized_keys` lock.
    store: SshKeyStore,
}

impl AccountSshKeys {
    /// The account these keys belong to.
    pub(crate) fn account(&self) -> &str {
        &self.account
    }

    /// Held while one `authorized_keys` rewrite runs on a device.
    pub(crate) async fn lock_authorized_keys(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.store.lock_authorized_keys().await
    }

    /// Directory holding everything this account stored for one device.
    fn device_dir(&self, device: &AgentId) -> PathBuf {
        self.root.join(device.as_str())
    }

    /// Path of one file in the device directory.
    fn device_file(&self, device: &AgentId, name: &str) -> PathBuf {
        self.device_dir(device).join(name)
    }

    /// The device's pinned known_hosts file.
    pub(crate) fn known_hosts_path(&self, device: &AgentId) -> PathBuf {
        self.device_file(device, KNOWN_HOSTS_FILE)
    }

    /// Creates the device directory (and its parents) as 0700, so key material is never
    /// reachable by other users even for a moment.
    async fn ensure_device_dir(&self, device: &AgentId) -> std::io::Result<PathBuf> {
        let dir = self.device_dir(device);
        create_private_dir_all(&dir).await?;
        Ok(dir)
    }

    /// Generates a new ed25519 key in redoor's memory and writes it as the staged key,
    /// encrypted with the vault when `vault` is given and as plaintext otherwise.
    ///
    /// Generating in-process instead of running `ssh-keygen` means the private key is
    /// written only by redoor, directly with 0600, and never passes through another process.
    /// A staged key left behind by a crashed setup or rotation is simply replaced (of either
    /// form): it was never current, so nothing refers to it.
    pub(crate) async fn stage(
        &self,
        device: &AgentId,
        vault: Option<&SshKeySeal>,
    ) -> std::io::Result<StagedKey> {
        let mut private_key = SshPrivateKey::generate()?;
        // The comment only helps someone inspecting a plaintext file; the fingerprint does
        // not depend on it.
        let fingerprint = private_key.fingerprint();
        private_key.set_comment(marker(device, &self.account, &fingerprint));

        self.ensure_device_dir(device).await?;
        self.delete_staged(device).await?;
        let encrypted = vault.is_some();
        let path = self.device_file(device, staged_file_name(encrypted));
        let content = match vault {
            Some(vault) => Zeroizing::new(seal(&private_key, &self.account, device, vault).await?),
            None => Zeroizing::new(private_key.to_openssh()?.as_bytes().to_vec()),
        };
        write_atomically(&path, &content, 0o600).await?;
        Ok(StagedKey {
            key: ManagedKey {
                device: device.clone(),
                account: self.account.clone(),
                private_key: Arc::new(private_key),
            },
            encrypted,
        })
    }

    /// Reads the device's current key, failing when it is missing or unreadable so a broken
    /// key is reported instead of handed to ssh. An encrypted key is preferred over a
    /// plaintext leftover (see the module documentation).
    pub(crate) async fn load(&self, device: &AgentId) -> std::io::Result<StoredKey> {
        match read_bounded(&self.device_file(device, ENCRYPTED_KEY_FILE)).await {
            Ok(bytes) => {
                let file = EncryptedKeyFile::parse(bytes.to_vec())
                    .await
                    .map_err(|error| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
                    })?;
                return Ok(StoredKey::Encrypted(Box::new(file)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // One read of the whole file: a rotation renaming a new key into place meanwhile
        // yields either the old or the new key, never a mix.
        let text = read_bounded(&self.device_file(device, PLAINTEXT_KEY_FILE)).await?;
        let private_key = PrivateKey::from_openssh(text.as_slice()).map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
        })?;
        Ok(StoredKey::Plaintext(ManagedKey {
            device: device.clone(),
            account: self.account.clone(),
            private_key: Arc::new(SshPrivateKey::new(private_key)),
        }))
    }

    /// Replaces the current encrypted key file with `bytes`, for a rewrap under a new vault
    /// generation. Written to a sibling and renamed, so a reader sees the old or new file.
    pub(crate) async fn replace_encrypted(
        &self,
        device: &AgentId,
        bytes: &[u8],
    ) -> std::io::Result<()> {
        write_atomically(&self.device_file(device, ENCRYPTED_KEY_FILE), bytes, 0o600).await
    }

    /// Makes the staged key the current one with a single atomic rename, so every reader
    /// sees either the old or the new complete key, then deletes the other current form.
    ///
    /// The directory is synced after the rename because the caller may persist a config
    /// that refers to the key next; after a power loss that config must not survive without
    /// it.
    pub(crate) async fn commit_staged(&self, staged: &StagedKey) -> std::io::Result<ManagedKey> {
        let device = &staged.key.device;
        let (current, other) = if staged.encrypted {
            (ENCRYPTED_KEY_FILE, PLAINTEXT_KEY_FILE)
        } else {
            (PLAINTEXT_KEY_FILE, ENCRYPTED_KEY_FILE)
        };
        tokio::fs::rename(
            self.device_file(device, staged_file_name(staged.encrypted)),
            self.device_file(device, current),
        )
        .await?;
        sync_dir(&self.device_dir(device)).await?;
        // A plaintext key replaced by an encrypted one must not stay readable on disk.
        remove_file_if_present(&self.device_file(device, other)).await?;
        Ok(staged.key.clone())
    }

    /// Deletes the staged key of either form after a failed setup or rotation, so no
    /// private key is left that is installed nowhere.
    pub(crate) async fn delete_staged(&self, device: &AgentId) -> std::io::Result<()> {
        remove_file_if_present(&self.device_file(device, STAGED_PLAINTEXT_KEY_FILE)).await?;
        remove_file_if_present(&self.device_file(device, STAGED_ENCRYPTED_KEY_FILE)).await
    }

    /// Deletes the current and staged keys of a device (and temp files a crash may have
    /// left while writing one) but keeps its pinned host key, because the machine has not
    /// changed and setting up a key again should not ask for confirmation.
    pub(crate) async fn delete_keys(&self, device: &AgentId) -> std::io::Result<()> {
        let mut entries = match tokio::fs::read_dir(self.device_dir(device)).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            // Only key files; the pinned known_hosts and probe files stay.
            if name.to_str().is_some_and(is_key_file_name) {
                remove_file_if_present(&entry.path()).await?;
            }
        }
        Ok(())
    }

    /// The account's encrypted keys with the device each belongs to, for vault rotation:
    /// the browser rewraps them and destroying a generation checks them. Unreadable files
    /// are skipped with a log line, because one damaged key must not hide the others.
    pub(crate) async fn encrypted_keys(&self) -> std::io::Result<Vec<(AgentId, EncryptedKeyFile)>> {
        let mut devices = match tokio::fs::read_dir(&self.root).await {
            Ok(devices) => devices,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut keys = Vec::new();
        while let Some(entry) = devices.next_entry().await? {
            let Some(device) = entry
                .file_name()
                .to_str()
                .and_then(|name| AgentId::parse(name).ok())
            else {
                continue;
            };
            match self.load(&device).await {
                Ok(StoredKey::Encrypted(file)) => keys.push((device, *file)),
                Ok(StoredKey::Plaintext(_)) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => redoor_core::log_failure!(
                    redoor_protocol::wire::log::Level::Warn,
                    "Skipping an unreadable SSH key while listing encrypted keys: account={}, device={}, error={}",
                    self.account,
                    device,
                    error
                ),
            }
        }
        Ok(keys)
    }

    /// Deletes everything this account stored for a device, including the pinned host key,
    /// for a target that may now be another machine.
    pub(crate) async fn delete_device(&self, device: &AgentId) -> std::io::Result<()> {
        remove_dir_if_present(&self.device_dir(device)).await
    }

    /// Reads the pinned host key, or `None` when the device has none yet.
    pub(crate) async fn pinned_host_key(
        &self,
        device: &AgentId,
    ) -> std::io::Result<Option<HostKey>> {
        match tokio::fs::read_to_string(self.known_hosts_path(device)).await {
            // An existing but damaged pin must fail closed, including after key removal;
            // treating it as absent would silently restore trust-on-first-use credentials.
            Ok(content) => HostKey::from_known_hosts(&content)
                .map(Some)
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("The pinned SSH host key for device '{device}' is invalid"),
                    )
                }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Replaces the device's pinned host key with `key`, recorded under the device id.
    pub(crate) async fn pin_host_key(
        &self,
        device: &AgentId,
        key: &HostKey,
    ) -> std::io::Result<()> {
        self.ensure_device_dir(device).await?;
        write_atomically(
            &self.known_hosts_path(device),
            format!("{}\n", key.known_hosts_line(device.as_str())?).as_bytes(),
            0o600,
        )
        .await
    }

    /// A fresh, not yet existing path in the device directory for one host key probe.
    /// Unique per call so concurrent probes of one device cannot read each other's result.
    pub(crate) async fn probe_known_hosts_path(
        &self,
        device: &AgentId,
    ) -> std::io::Result<PathBuf> {
        let dir = self.ensure_device_dir(device).await?;
        Ok(dir.join(format!(".probe-{}", uuid::Uuid::new_v4())))
    }
}

/// The staged file name of a key of either form.
fn staged_file_name(encrypted: bool) -> &'static str {
    if encrypted {
        STAGED_ENCRYPTED_KEY_FILE
    } else {
        STAGED_PLAINTEXT_KEY_FILE
    }
}

/// Reads a whole key file into a zeroizing buffer, refusing files larger than any key, so a
/// damaged or foreign file cannot make the server buffer much.
async fn read_bounded(path: &Path) -> std::io::Result<Zeroizing<Vec<u8>>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_SSH_KEY_FILE_LEN + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_SSH_KEY_FILE_LEN {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("'{}' is too large to be an SSH key", path.display()),
        ));
    }
    Ok(bytes)
}

/// The `authorized_keys` comment that ties a line to one key of one device of one account.
/// The key's `SHA256:` fingerprint names it, so the marker is readable and unique without a
/// stored key id; matching only [`device_marker`] finds every line the account ever
/// installed for the device, and never another account's.
pub(crate) fn marker(device: &AgentId, account: &str, fingerprint: &str) -> String {
    format!("{}{fingerprint}", device_marker(device, account))
}

/// The marker prefix shared by every `authorized_keys` line one account installed for one
/// device.
pub(crate) fn device_marker(device: &AgentId, account: &str) -> String {
    format!("redoor:{device}:{account}:")
}

/// A decrypted or plaintext SSH private key in memory.
///
/// `ssh-key` zeroizes the private half on drop, and `Debug` never prints it, so the key
/// cannot end up in a log line or a panic message.
pub(crate) struct SshPrivateKey(PrivateKey);

impl SshPrivateKey {
    /// Wraps a parsed private key.
    pub(crate) fn new(private_key: PrivateKey) -> Self {
        Self(private_key)
    }

    /// A fresh ed25519 key from the OS random source.
    pub(crate) fn generate() -> std::io::Result<Self> {
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut()).map_err(|error| {
            std::io::Error::other(format!("the OS random source is unavailable: {error}"))
        })?;
        Ok(Self(PrivateKey::from(Ed25519Keypair::from_seed(&seed))))
    }

    /// Sets the comment written into the OpenSSH private key file.
    fn set_comment(&mut self, comment: String) {
        self.0.set_comment(comment);
    }

    /// The public half.
    pub(crate) fn public_key(&self) -> &PublicKey {
        self.0.public_key()
    }

    /// The public key in OpenSSH form without a comment, as stored in an encrypted key's
    /// header and in `authorized_keys`.
    pub(crate) fn public_key_openssh(&self) -> String {
        public_key_openssh(self.public_key())
    }

    /// `SHA256:` fingerprint of the public key, as sshd logs it.
    pub(crate) fn fingerprint(&self) -> String {
        self.public_key().fingerprint(HashAlg::Sha256).to_string()
    }

    /// The OpenSSH private key text, in a zeroizing buffer.
    pub(crate) fn to_openssh(&self) -> std::io::Result<Zeroizing<String>> {
        self.0
            .to_openssh(LineEnding::LF)
            .map(|text| Zeroizing::new(text.to_string()))
            .map_err(std::io::Error::other)
    }

    /// Signs `data` for the in-process ssh-agent.
    pub(crate) fn sign(&self, data: &[u8]) -> Result<ssh_key::Signature, signature::Error> {
        signature::Signer::try_sign(&self.0, data)
    }
}

impl std::fmt::Debug for SshPrivateKey {
    /// Prints only the fingerprint.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "SshPrivateKey({}, <redacted>)",
            self.fingerprint()
        )
    }
}

/// OpenSSH text of a public key without its comment.
fn public_key_openssh(public_key: &PublicKey) -> String {
    let mut public_key = public_key.clone();
    public_key.set_comment("");
    public_key
        .to_openssh()
        .map(|key| key.trim().to_string())
        .unwrap_or_default()
}

/// A device's current key as stored on disk.
pub(crate) enum StoredKey {
    /// A plaintext key, readable on every agent start.
    Plaintext(ManagedKey),
    /// A key encrypted with the account's vault; usable only once decrypted with its file
    /// key, which the browser hands over on Start. Boxed because the parsed header is much
    /// larger than a plaintext key's handle.
    Encrypted(Box<EncryptedKeyFile>),
}

impl StoredKey {
    /// The public half, known for both forms without decrypting anything.
    pub(crate) fn public_key(&self) -> &PublicKey {
        match self {
            Self::Plaintext(key) => key.private_key.public_key(),
            Self::Encrypted(file) => file.public_key(),
        }
    }

    /// `SHA256:` fingerprint of the public key.
    pub(crate) fn fingerprint(&self) -> String {
        self.public_key().fingerprint(HashAlg::Sha256).to_string()
    }
}

/// A newly generated key at its staged path, waiting for the commit.
pub(crate) struct StagedKey {
    /// The key itself, in memory, used to verify it before the commit.
    pub(crate) key: ManagedKey,
    /// Whether it was written encrypted, which decides the file names of the commit.
    pub(crate) encrypted: bool,
}

/// A usable managed key: its private half in memory and what it belongs to.
#[derive(Clone, Debug)]
pub(crate) struct ManagedKey {
    /// Device the key belongs to.
    device: AgentId,
    /// Account that set the key up, part of the `authorized_keys` marker.
    account: String,
    /// The private key, shared with the in-process ssh-agent of each ssh process.
    private_key: Arc<SshPrivateKey>,
}

impl ManagedKey {
    /// A key decrypted from an encrypted key file.
    pub(crate) fn from_decrypted(
        device: AgentId,
        account: String,
        private_key: Arc<SshPrivateKey>,
    ) -> Self {
        Self {
            device,
            account,
            private_key,
        }
    }

    /// The private key, for the in-process ssh-agent and the held key map.
    pub(crate) fn private_key(&self) -> &Arc<SshPrivateKey> {
        &self.private_key
    }

    /// The line installed in the device's `authorized_keys`.
    ///
    /// `restrict` turns off PTY allocation, agent and X11 forwarding and `~/.ssh/rc`, none of
    /// which redoor uses; `port-forwarding` puts back the `-R` tunnel the agent needs.
    pub(crate) fn authorized_keys_line(&self) -> String {
        format!(
            "restrict,port-forwarding {} {}",
            self.private_key.public_key_openssh(),
            marker(&self.device, &self.account, &self.fingerprint())
        )
    }

    /// `SHA256:` fingerprint of the public key, as sshd logs it. Also the key's identity in
    /// the `authorized_keys` marker and keep list.
    pub(crate) fn fingerprint(&self) -> String {
        self.private_key.fingerprint()
    }
}

/// A host public key read from a known_hosts file.
#[derive(Clone, Debug)]
pub(crate) struct HostKey {
    /// The key itself; host names and markers are not kept.
    public_key: PublicKey,
}

impl HostKey {
    /// Reads the first plain host key entry. Comments, `@cert-authority` and `@revoked`
    /// lines are skipped, and the host field is ignored so hashed names work too.
    pub(crate) fn from_known_hosts(content: &str) -> Option<Self> {
        content.lines().find_map(Self::from_known_hosts_line)
    }

    /// Parses one `host keytype base64 [comment]` line.
    pub(crate) fn from_known_hosts_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            return None;
        }
        let mut fields = line.split_whitespace();
        let _host = fields.next()?;
        let key_type = fields.next()?;
        let key = fields.next()?;
        let public_key = PublicKey::from_openssh(&format!("{key_type} {key}")).ok()?;
        Some(Self { public_key })
    }

    /// `SHA256:` fingerprint, the format `ssh-keygen -l` and OpenSSH prompts show.
    pub(crate) fn fingerprint(&self) -> String {
        self.public_key.fingerprint(HashAlg::Sha256).to_string()
    }

    /// OpenSSH key type, for example `ssh-ed25519`.
    pub(crate) fn key_type(&self) -> String {
        self.public_key.algorithm().as_str().to_string()
    }

    /// Whether both are the same key, ignoring comments.
    pub(crate) fn same_key(&self, other: &HostKey) -> bool {
        self.public_key.key_data() == other.public_key.key_data()
    }

    /// Whether a fingerprint typed or confirmed by the user is this key's. Accepts the value
    /// with or without the `SHA256:` prefix, because that is how users copy it.
    pub(crate) fn matches_fingerprint(&self, fingerprint: &str) -> bool {
        let fingerprint = fingerprint.trim();
        let own = self.fingerprint();
        fingerprint == own || own.strip_prefix("SHA256:") == Some(fingerprint)
    }

    /// The known_hosts line pinning this key under `alias`.
    fn known_hosts_line(&self, alias: &str) -> std::io::Result<String> {
        let mut public_key = self.public_key.clone();
        public_key.set_comment("");
        let key = public_key.to_openssh().map_err(std::io::Error::other)?;
        Ok(format!("{alias} {}", key.trim()))
    }
}

/// Creates `dir` and missing parents with mode 0700.
async fn create_private_dir_all(dir: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(dir).await
}

/// Whether a device directory entry holds private key material: a current or staged key of
/// either form, or the temp file [`write_atomically`] uses while writing one.
fn is_key_file_name(name: &str) -> bool {
    [
        PLAINTEXT_KEY_FILE,
        ENCRYPTED_KEY_FILE,
        STAGED_PLAINTEXT_KEY_FILE,
        STAGED_ENCRYPTED_KEY_FILE,
    ]
    .contains(&name)
        || (name.starts_with(&format!(".{PLAINTEXT_KEY_FILE}.")) && name.ends_with(".tmp"))
}

/// Flushes a directory's entries, so a rename in it is durable before anything that
/// depends on it is written.
async fn sync_dir(dir: &Path) -> std::io::Result<()> {
    tokio::fs::File::open(dir).await?.sync_all().await
}

/// Writes `content` to a sibling temp file created with its final `mode`, then renames it
/// over `path`, so the file is never briefly readable with a wider mode or half-written.
async fn write_atomically(path: &Path, content: &[u8], mode: u32) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| std::io::Error::other(format!("'{}' has no file name", path.display())))?;
    let temp_path = path.with_file_name(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(mode);
    let result = async {
        let mut file = options.open(&temp_path).await?;
        file.write_all(content).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temp_path, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp_path).await;
    }
    result
}

/// Deletes one file; a missing file is already deleted.
async fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Recursively deletes `dir` with `safe_rm_all`; a missing directory is already deleted.
async fn remove_dir_if_present(dir: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(dir).await {
        Ok(_) => redoor_core::safe_fs::safe_rm_all(dir).await,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Mode bits of a path, for asserting the store never widens them.
    async fn mode(path: &Path) -> u32 {
        tokio::fs::metadata(path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    /// Names in a directory, sorted, for asserting exactly which files exist.
    async fn file_names(dir: &Path) -> Vec<String> {
        let mut entries = tokio::fs::read_dir(dir).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        names
    }

    /// The keys of account `alice` in a fresh data directory.
    fn alice(home: &redoor_core::test_support::TempDir) -> AccountSshKeys {
        SshKeyStore::for_data_dir(home.path())
            .account("alice")
            .unwrap()
    }

    /// The fingerprint of the current plaintext key, failing for an encrypted one.
    async fn loaded_fingerprint(keys: &AccountSshKeys, device: &AgentId) -> String {
        match keys.load(device).await.unwrap() {
            StoredKey::Plaintext(key) => key.fingerprint(),
            StoredKey::Encrypted(_) => panic!("expected a plaintext key"),
        }
    }

    /// A seal with a random wrap, as the browser would send it.
    fn test_seal() -> SshKeySeal {
        SshKeySeal {
            vault_id: "vlt_0123456789abcdef0123456789abcdef".to_string(),
            vault_label: "test vault".to_string(),
            key_id: "kid_0123456789abcdef0123456789abcdef".to_string(),
            file_key: redoor_vault::FileKey::generate(),
            wrap: redoor_protocol::api::vault::VaultKeyWrap {
                alg: redoor_protocol::api::vault::VAULT_WRAP_ALG.to_string(),
                iv: redoor_vault::random_base64url(redoor_vault::WRAP_IV_LEN),
                ct: redoor_vault::random_base64url(redoor_vault::WRAP_CT_LEN),
            },
        }
    }

    /// Keys live in the account's directory, get their final modes, so no other user can
    /// read the private key even while it is being written, and only the private key is
    /// stored.
    #[tokio::test]
    async fn committed_key_is_the_only_private_file() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        let staged = keys.stage(&device, None).await.unwrap();
        let dir = keys.device_dir(&device);

        // Keys belong to the account, next to its vault.json.
        assert_eq!(
            dir,
            home.path().join("users/alice/ssh").join(device.as_str())
        );
        // A staged key waits next to the current one under its own name.
        assert_eq!(file_names(&dir).await, vec![STAGED_PLAINTEXT_KEY_FILE]);
        // The staged key is as private as the current one, because it is a working key.
        assert_eq!(mode(&dir.join(STAGED_PLAINTEXT_KEY_FILE)).await, 0o600);

        keys.commit_staged(&staged).await.unwrap();
        // The commit moved the staged key into place; no `.pub`, temp or staged file is left.
        assert_eq!(file_names(&dir).await, vec![PLAINTEXT_KEY_FILE]);
        // The private key is readable only by the server's user.
        assert_eq!(mode(&dir.join(PLAINTEXT_KEY_FILE)).await, 0o600);
        // The device directory cannot be listed by others.
        assert_eq!(mode(&dir).await, 0o700);
    }

    /// A loaded key is the committed one, its public half is derived from the private key,
    /// and its authorized_keys line carries the marker used for rotation and removal.
    #[tokio::test]
    async fn loaded_key_matches_committed_key() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        let key = keys
            .commit_staged(&keys.stage(&device, None).await.unwrap())
            .await
            .unwrap();
        let StoredKey::Plaintext(loaded) = keys.load(&device).await.unwrap() else {
            panic!("expected a plaintext key");
        };

        // The same public key comes back from the private key file alone.
        assert_eq!(loaded.fingerprint(), key.fingerprint());
        let line = loaded.authorized_keys_line();
        // The key is restricted except for the reverse tunnel.
        assert!(
            line.starts_with("restrict,port-forwarding ssh-ed25519 "),
            "{line}"
        );
        // The marker names the device, the account and the key's fingerprint.
        assert!(
            line.ends_with(&format!(" redoor:{device}:alice:{}", key.fingerprint())),
            "{line}"
        );
        // The fingerprint is the `ssh-keygen -l` format the user sees in the UI.
        assert!(key.fingerprint().starts_with("SHA256:"));
    }

    /// An encrypted key is written only in its encrypted form, its public key is readable
    /// from the header while locked, and committing it removes the plaintext key it
    /// replaces.
    #[tokio::test]
    async fn encrypted_key_replaces_a_plaintext_key() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        keys.commit_staged(&keys.stage(&device, None).await.unwrap())
            .await
            .unwrap();
        let seal = test_seal();
        let staged = keys.stage(&device, Some(&seal)).await.unwrap();
        let dir = keys.device_dir(&device);
        // The staged encrypted key waits next to the current plaintext key.
        assert_eq!(
            file_names(&dir).await,
            vec![PLAINTEXT_KEY_FILE, STAGED_ENCRYPTED_KEY_FILE]
        );
        let raw = tokio::fs::read(dir.join(STAGED_ENCRYPTED_KEY_FILE))
            .await
            .unwrap();
        // The private key never reaches the disk in plaintext.
        assert!(!String::from_utf8_lossy(&raw).contains("OPENSSH PRIVATE KEY"));

        keys.commit_staged(&staged).await.unwrap();
        // Only the encrypted key is left.
        assert_eq!(file_names(&dir).await, vec![ENCRYPTED_KEY_FILE]);
        let StoredKey::Encrypted(file) = keys.load(&device).await.unwrap() else {
            panic!("expected an encrypted key");
        };
        // The fingerprint is known without the file key.
        assert_eq!(
            StoredKey::Encrypted(file.clone()).fingerprint(),
            staged.key.fingerprint()
        );
        // The file key opens the key for this account and device.
        let opened = file.open(&seal.file_key, "alice", &device).await.unwrap();
        assert_eq!(opened.fingerprint(), staged.key.fingerprint());
        // The encrypted key is listed for vault rotation.
        let listed = keys.encrypted_keys().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, device);
    }

    /// A plaintext leftover next to an encrypted key (a crash between the commit's rename
    /// and its cleanup) never wins, because keys only change from plaintext to encrypted.
    #[tokio::test]
    async fn encrypted_key_wins_over_a_plaintext_leftover() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        let staged = keys.stage(&device, Some(&test_seal())).await.unwrap();
        keys.commit_staged(&staged).await.unwrap();
        tokio::fs::write(keys.device_file(&device, PLAINTEXT_KEY_FILE), "leftover")
            .await
            .unwrap();
        // The encrypted key is the current one.
        assert!(matches!(
            keys.load(&device).await.unwrap(),
            StoredKey::Encrypted(_)
        ));
        keys.delete_keys(&device).await.unwrap();
        // Removal deletes both forms.
        assert!(file_names(&keys.device_dir(&device)).await.is_empty());
    }

    /// Rotation replaces the current key in one rename, and a stale staged key from an
    /// interrupted run is overwritten instead of blocking the next attempt.
    #[tokio::test]
    async fn rotation_replaces_the_current_key_and_stale_staged_keys() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        let old = keys
            .commit_staged(&keys.stage(&device, None).await.unwrap())
            .await
            .unwrap();
        let stale = keys.stage(&device, None).await.unwrap();
        let new = keys.stage(&device, None).await.unwrap();

        // Staging again replaced the stale staged key.
        assert_ne!(stale.key.fingerprint(), new.key.fingerprint());
        // Until the commit, every start still loads the old key.
        assert_eq!(loaded_fingerprint(&keys, &device).await, old.fingerprint());
        keys.commit_staged(&new).await.unwrap();
        // After the commit the new key is current ...
        assert_eq!(
            loaded_fingerprint(&keys, &device).await,
            new.key.fingerprint()
        );
        // ... and nothing else is left of the old or the stale key.
        assert_eq!(
            file_names(&keys.device_dir(&device)).await,
            vec![PLAINTEXT_KEY_FILE]
        );
        // A failed attempt's staged key can be deleted without touching the current one.
        keys.stage(&device, Some(&test_seal())).await.unwrap();
        keys.delete_staged(&device).await.unwrap();
        assert_eq!(
            file_names(&keys.device_dir(&device)).await,
            vec![PLAINTEXT_KEY_FILE]
        );
    }

    /// The pinned host key round-trips under the device id and deleting keys keeps it.
    #[tokio::test]
    async fn pin_survives_key_deletion() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        let host_key = HostKey::from_known_hosts(
            "# comment\n@revoked * ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n|1|hashed= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
        )
        .expect("the hashed entry is read, the revoked one skipped");
        keys.pin_host_key(&device, &host_key).await.unwrap();
        let staged = keys.stage(&device, None).await.unwrap();
        keys.commit_staged(&staged).await.unwrap();
        keys.stage(&device, None).await.unwrap();
        keys.delete_keys(&device).await.unwrap();

        // The current and the staged key are gone; only the pin is left.
        assert_eq!(
            file_names(&keys.device_dir(&device)).await,
            vec![KNOWN_HOSTS_FILE]
        );
        assert!(keys.load(&device).await.is_err());
        let pinned = keys.pinned_host_key(&device).await.unwrap().unwrap();
        // The pin is still there, so setting up a key again needs no confirmation.
        assert!(pinned.same_key(&host_key));
        // The pinned file is private and names the device id, which is the HostKeyAlias.
        assert_eq!(mode(&keys.known_hosts_path(&device)).await, 0o600);
        let content = tokio::fs::read_to_string(keys.known_hosts_path(&device))
            .await
            .unwrap();
        assert!(
            content.starts_with(&format!("{device} ssh-ed25519 ")),
            "{content}"
        );
        // Confirmations with or without the prefix match.
        let fingerprint = host_key.fingerprint();
        assert!(pinned.matches_fingerprint(&fingerprint));
        assert!(pinned.matches_fingerprint(fingerprint.trim_start_matches("SHA256:")));
        assert!(!pinned.matches_fingerprint("SHA256:something-else"));

        keys.delete_device(&device).await.unwrap();
        // Deleting the device removes the pin as well.
        assert!(keys.pinned_host_key(&device).await.unwrap().is_none());
    }

    /// Deleting a device removes what every account stored for it, and nothing of other
    /// devices; accounts are separate, so one account's key is never another's.
    #[tokio::test]
    async fn device_deletion_covers_every_account() {
        let home = redoor_core::test_support::TempDir::create();
        let store = SshKeyStore::for_data_dir(home.path());
        let alice = store.account("alice").unwrap();
        let bob = store.account("bob").unwrap();
        let device = AgentId::generate();
        let other = AgentId::generate();
        alice.stage(&device, None).await.unwrap();
        bob.stage(&device, None).await.unwrap();
        bob.stage(&other, None).await.unwrap();
        // Each account has its own directory for the same device.
        assert_ne!(alice.device_dir(&device), bob.device_dir(&device));

        store.delete_device_for_all_accounts(&device).await.unwrap();
        // Both accounts' directories of the device are gone.
        assert!(!alice.device_dir(&device).exists());
        assert!(!bob.device_dir(&device).exists());
        // The other device keeps its files.
        assert!(bob.device_dir(&other).exists());
    }

    /// Account names that could escape the data directory or break the marker are refused.
    #[test]
    fn account_names_are_validated() {
        let home = redoor_core::test_support::TempDir::create();
        let store = SshKeyStore::for_data_dir(home.path());
        for invalid in ["", "..", "a/b", "a:b", "a b"] {
            // Each would be a path or marker hazard.
            assert!(store.account(invalid).is_err(), "{invalid:?}");
        }
    }

    /// Losing the contents of a pin must not make password or default-key logins trust a
    /// new host automatically.
    #[tokio::test]
    async fn invalid_pin_is_an_error_instead_of_missing_trust() {
        let home = redoor_core::test_support::TempDir::create();
        let keys = alice(&home);
        let device = AgentId::generate();
        keys.ensure_device_dir(&device).await.unwrap();
        tokio::fs::write(keys.known_hosts_path(&device), "not a host key")
            .await
            .unwrap();
        let error = keys.pinned_host_key(&device).await.unwrap_err();
        // Only a nonexistent pin may select the initial trust-on-first-use policy.
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
