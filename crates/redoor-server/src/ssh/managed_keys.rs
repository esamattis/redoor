//! Enrollment, rotation and removal of per-device SSH keys, and host key pinning.
//!
//! Every step runs a new `ssh` process (multiplexing is off), so nothing authenticated is
//! reused between steps. The credential that got the enrollment in (the bootstrap
//! credential) is kept until the caller commits or rolls back, because rollback has to log
//! in again to remove the new key.
//!
//! Rotation, removal and device deletion authenticate with the current key. For an
//! encrypted key that is the *operation credential* the caller resolves before anything
//! stops the supervisor: decrypted from a file key sent with the request, or a clone of the
//! held key. It lives only for the request and is never put into the held keys, so rotating
//! a stopped device does not make it startable with an access token.

use redoor_core::config::SshBackedAgentConfig;
use redoor_core::log;
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::log::Level;
use tokio::process::Command;
use zeroize::Zeroizing;

use super::ProvisionError;
use super::encrypted_keys::SshKeySeal;
use super::held_keys::HeldSshKeys;
use super::keys::{AccountSshKeys, HostKey, ManagedKey, StagedKey, StoredKey, device_marker};
use super::shell::quote;
use super::transport::{
    AuthPolicy, HostKeyPolicy, PinnedHostKey, SshConfigDump, SshHost, SshOutput, SshRunOptions,
};

/// Why a key or host key operation failed; the text is shown to the user as is.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ManagedKeyError {
    /// The request is missing something the user has to provide, such as the host key
    /// confirmation or a password.
    #[error("{0}")]
    Input(String),
    /// The device presents a different host key than the one the user confirmed or pinned.
    #[error("{0}")]
    HostKeyMismatch(String),
    /// The device could not be reached, refused every credential or failed a remote step.
    #[error("{0}")]
    Remote(String),
    /// A local file operation or the local `ssh` process failed. The text names the step,
    /// because a bare OS error such as "Permission denied" does not tell the user which file
    /// or tool to look at.
    #[error("{0}")]
    Local(String),
}

impl ManagedKeyError {
    /// Wraps a local I/O failure with the step that failed, for use with `map_err`.
    fn local(context: &str) -> impl FnOnce(std::io::Error) -> Self + '_ {
        move |error| Self::Local(format!("{context}: {error}"))
    }
}

/// Context for a failure to read the device's pin, which several steps share.
const READ_PIN_FAILED: &str =
    "Failed to read the device's pinned host key from the server's data directory";

/// [`READ_PIN_FAILED`] for the connection path, which reports [`ProvisionError`]s.
fn read_pin_failed(error: std::io::Error) -> ProvisionError {
    ProvisionError::Io(std::io::Error::new(
        error.kind(),
        format!("{READ_PIN_FAILED}: {error}"),
    ))
}

/// The key a device presented to a probe, with what the server already knows about it.
pub(crate) struct ProbedHostKey {
    /// The presented key.
    pub(crate) key: HostKey,
    /// Whether the server user's known_hosts files already trust this key for the host.
    pub(crate) previously_trusted: bool,
    /// The key pinned for the device, if any.
    pub(crate) pinned: Option<HostKey>,
}

/// A new key that is staged locally, installed and verified on the device, but not yet the
/// device's current key.
///
/// Holding the bootstrap credential here keeps a typed password in its zeroizing type for
/// exactly as long as rollback may still need it.
pub(crate) struct PendingKey {
    /// The new key, still at its staged path.
    key: StagedKey,
    /// The credential that installed it, used again to remove it on rollback.
    bootstrap: AuthPolicy,
    /// Fingerprints of the keys that were kept on the device before the new line was added.
    previous_keep: Vec<String>,
}

impl PendingKey {
    /// The new key, for the commit and the response.
    pub(crate) fn key(&self) -> &ManagedKey {
        &self.key.key
    }

    /// Whether the new key is encrypted with the vault.
    pub(crate) fn is_encrypted(&self) -> bool {
        self.key.encrypted
    }
}

/// One SSH device's key and host key operations, for one account.
pub(crate) struct ManagedKeyDevice {
    /// The device's current config entry.
    config: SshBackedAgentConfig,
    /// The device id, which names the key's directory and is the `HostKeyAlias`.
    device: AgentId,
    /// Where the account's keys and pins are stored; `None` for relays, which belong to no
    /// account and so have neither.
    keys: Option<AccountSshKeys>,
    /// Decrypted keys of running devices.
    held: HeldSshKeys,
}

impl ManagedKeyDevice {
    /// Binds the operations to one config entry; entries without an id cannot have keys.
    pub(crate) fn new(
        config: SshBackedAgentConfig,
        keys: Option<AccountSshKeys>,
        held: HeldSshKeys,
    ) -> Result<Self, ProvisionError> {
        let device = config.id.clone().ok_or_else(|| {
            ProvisionError::Configuration(format!(
                "SSH agent '{}' has no device id in the config",
                config.target
            ))
        })?;
        Ok(Self {
            config,
            device,
            keys,
            held,
        })
    }

    /// The account's key store; key operations always run for an account.
    fn keys(&self) -> Result<&AccountSshKeys, ManagedKeyError> {
        self.keys.as_ref().ok_or_else(|| {
            ManagedKeyError::Local("SSH key operations need a login account".to_string())
        })
    }

    /// The account the key operations run for.
    fn account(&self) -> Option<&str> {
        self.keys.as_ref().map(AccountSshKeys::account)
    }

    /// The pinned host key policy, or `None` when nothing is pinned yet (or there is no
    /// account to hold a pin).
    async fn pinned_policy(&self) -> std::io::Result<Option<PinnedHostKey>> {
        let Some(keys) = &self.keys else {
            return Ok(None);
        };
        Ok(keys
            .pinned_host_key(&self.device)
            .await?
            .map(|key| PinnedHostKey {
                known_hosts: keys.known_hosts_path(&self.device),
                alias: self.device.to_string(),
                fingerprint: key.fingerprint(),
            }))
    }

    /// The device's current key as stored, encrypted or not.
    pub(crate) async fn stored_key(&self) -> std::io::Result<StoredKey> {
        self.keys()
            .map_err(|error| std::io::Error::other(error.to_string()))?
            .load(&self.device)
            .await
    }

    /// Decrypts the device's encrypted key with its file key, after the caller checked the
    /// header against the vault. Checks the MAC, the account and device binding and that
    /// the private key matches the header's public key.
    pub(crate) async fn unlock(
        &self,
        file: &super::encrypted_keys::EncryptedKeyFile,
        file_key: &redoor_vault::FileKey,
    ) -> Result<ManagedKey, super::encrypted_keys::SshKeyOpenError> {
        let account = self
            .account()
            .ok_or_else(|| {
                super::encrypted_keys::SshKeyOpenError::Mismatch(
                    "SSH keys belong to a login account".to_string(),
                )
            })?
            .to_string();
        let private_key = file.open(file_key, &account, &self.device).await?;
        Ok(ManagedKey::from_decrypted(
            self.device.clone(),
            account,
            std::sync::Arc::new(private_key),
        ))
    }

    /// The key the server holds for this account's device, if any.
    ///
    /// It is not compared with the key file: a rotation of a running device holds the new
    /// key just before renaming it into place, and both keys stay authorized on the device
    /// until the old line is removed afterwards, so either one logs in during the switch.
    pub(crate) fn held_key(&self) -> Option<ManagedKey> {
        let account = self.account()?;
        let key = self.held.get(account, &self.device)?;
        Some(ManagedKey::from_decrypted(
            self.device.clone(),
            account.to_string(),
            key,
        ))
    }

    /// The host every agent start uses for a device with a managed key: pinned host key and
    /// only the managed key offered. An encrypted key must be held by the server; reading it
    /// from disk is not enough.
    pub(super) async fn connection_host(&self) -> Result<SshHost, ProvisionError> {
        if !self.config.managed_ssh_key {
            let mut host = SshHost::for_config(&self.config).password(self.config.password.clone());
            // Removing a login key does not revoke the user's trust decision about the host.
            if let Some(pinned) = self.pinned_policy().await.map_err(read_pin_failed)? {
                host = host.host_key(HostKeyPolicy::Pinned(pinned));
            }
            return Ok(host);
        }
        // The cause is kept in the message: "missing" and "unreadable" (for example after
        // restoring the data directory with the wrong owner) need different fixes.
        let unusable = |what: &str, cause: &dyn std::fmt::Display| {
            ProvisionError::Configuration(format!(
                "The {what} of device '{}' cannot be used from the server's data directory ({cause}). Remove the SSH key and set it up again from the device page.",
                self.device
            ))
        };
        let key = match self
            .stored_key()
            .await
            .map_err(|error| unusable("managed SSH key", &error))?
        {
            StoredKey::Plaintext(key) => key,
            StoredKey::Encrypted(_) => self.held_key().ok_or_else(|| {
                ProvisionError::SshKeyLocked(
                    "The SSH key is locked. Start the device from the browser to unlock it."
                        .to_string(),
                )
            })?,
        };
        let pinned = self
            .pinned_policy()
            .await
            .map_err(read_pin_failed)?
            .ok_or_else(|| unusable("pinned host key", &"not found"))?;
        Ok(self.managed_key_host(&key, pinned))
    }

    /// A host that authenticates with `key` against the pinned host key.
    fn managed_key_host(&self, key: &ManagedKey, pinned: PinnedHostKey) -> SshHost {
        SshHost::for_config(&self.config)
            .host_key(HostKeyPolicy::Pinned(pinned))
            .auth(AuthPolicy::ManagedKey {
                key: key.private_key().clone(),
            })
    }

    /// Enrollment step 1: records the host key the device presents, without sending any
    /// credential.
    ///
    /// The probe goes through the user's ssh config (ProxyJump and so on) like a real
    /// connection, but with the global known_hosts, `KnownHostsCommand` and DNS switched off,
    /// so the key is always recorded, even when the system already trusts it.
    pub(crate) async fn probe_host_key(&self) -> Result<ProbedHostKey, ManagedKeyError> {
        let temp = self
            .keys()?
            .probe_known_hosts_path(&self.device)
            .await
            .map_err(ManagedKeyError::local(
                "Failed to prepare the host key probe in the server's data directory",
            ))?;
        let host = SshHost::for_config(&self.config)
            .host_key(HostKeyPolicy::Probe {
                known_hosts: temp.clone(),
                alias: self.device.to_string(),
            })
            .auth(AuthPolicy::NoAuth);
        let output = host.output("true", &[], &SshRunOptions::default()).await;
        let recorded = tokio::fs::read_to_string(&temp).await;
        let _ = tokio::fs::remove_file(&temp).await;
        let output = output.map_err(ManagedKeyError::local(
            "Failed to run ssh to read the host key",
        ))?;
        let key = recorded
            .ok()
            .and_then(|content| HostKey::from_known_hosts(&content))
            .ok_or_else(|| {
                ManagedKeyError::Remote(format!(
                    "Could not read the device's host key. {}",
                    host.failure_message("host key probe", &output)
                ))
            })?;
        Ok(ProbedHostKey {
            previously_trusted: self.previously_trusted(&key).await,
            pinned: self
                .keys()?
                .pinned_host_key(&self.device)
                .await
                .map_err(ManagedKeyError::local(READ_PIN_FAILED))?,
            key,
        })
    }

    /// Pins the key the device presents now, after checking it is the one the user confirmed.
    /// Used for the first pin and for re-pinning after a confirmed host key change.
    pub(crate) async fn pin_host_key(&self, confirmed: &str) -> Result<HostKey, ManagedKeyError> {
        let probed = self.probe_host_key().await?;
        if !probed.key.matches_fingerprint(confirmed) {
            return Err(ManagedKeyError::HostKeyMismatch(format!(
                "The device now presents host key {}, not the confirmed {}. Check the host key again.",
                probed.key.fingerprint(),
                confirmed.trim()
            )));
        }
        self.keys()?
            .pin_host_key(&self.device, &probed.key)
            .await
            .map_err(ManagedKeyError::local(
                "Failed to save the pinned host key in the server's data directory",
            ))?;
        log!(
            Level::Info,
            "Pinned SSH host key: device={}, fingerprint={}",
            self.device,
            probed.key.fingerprint()
        );
        Ok(probed.key)
    }

    /// Makes sure a host key is pinned before any credential is sent.
    ///
    /// An existing pin is used as is (a confirmation must then match it); without one, the
    /// user's confirmation is required and the presented key must match it.
    async fn ensure_pinned(
        &self,
        confirmed: Option<&str>,
    ) -> Result<PinnedHostKey, ManagedKeyError> {
        if let Some(pinned) = self
            .pinned_policy()
            .await
            .map_err(ManagedKeyError::local(READ_PIN_FAILED))?
        {
            if let Some(confirmed) = confirmed
                && !self
                    .keys()?
                    .pinned_host_key(&self.device)
                    .await
                    .map_err(ManagedKeyError::local(READ_PIN_FAILED))?
                    .is_some_and(|key| key.matches_fingerprint(confirmed))
            {
                return Err(ManagedKeyError::HostKeyMismatch(format!(
                    "The confirmed host key {} is not the one pinned for this device ({}). Re-pin the host key first.",
                    confirmed.trim(),
                    pinned.fingerprint
                )));
            }
            return Ok(pinned);
        }
        let confirmed = confirmed.ok_or_else(|| {
            ManagedKeyError::Input(
                "Confirm the device's host key fingerprint before setting up an SSH key"
                    .to_string(),
            )
        })?;
        self.pin_host_key(confirmed).await?;
        self.pinned_policy()
            .await
            .map_err(ManagedKeyError::local(READ_PIN_FAILED))?
            .ok_or_else(|| {
                ManagedKeyError::Local(
                    "The pinned host key was not found right after saving it".to_string(),
                )
            })
    }

    /// Enrollment steps 1 to 5: pins the host key, logs in once, stages a new key, installs
    /// it and verifies it the way the agent will use it. On failure after the install, the
    /// new line is removed again and the staged key deleted.
    ///
    /// Used for both the first key and rotation; with a current key, it keeps that key's
    /// line on the device until [`ManagedKeyDevice::finish_rotation`]. The current key file
    /// is not touched, so running agents and new starts keep using it until the commit.
    ///
    /// `current` is the operation credential of a rotation (required when the device has a
    /// managed key); `vault` encrypts the new key with the account's vault.
    pub(crate) async fn install_new_key(
        &self,
        confirmed_host_key: Option<&str>,
        typed_password: Option<Zeroizing<String>>,
        current: Option<&ManagedKey>,
        vault: Option<&SshKeySeal>,
    ) -> Result<PendingKey, ManagedKeyError> {
        if self.config.managed_ssh_key && current.is_none() {
            // Rotation logs in only with the current key, so without it the way out is
            // removing the key and setting it up again with another credential.
            return Err(ManagedKeyError::Input(
                "The current SSH key of this device is not available, so it cannot be rotated. Remove the key and set it up again."
                    .to_string(),
            ));
        }
        let current = current.filter(|_| self.config.managed_ssh_key);
        let pinned = self.ensure_pinned(confirmed_host_key).await?;
        let bootstrap = self
            .bootstrap_credential(&pinned, current, typed_password)
            .await?;
        let previous_keep: Vec<String> = current.iter().map(|key| key.fingerprint()).collect();

        let key = self
            .keys()?
            .stage(&self.device, vault)
            .await
            .map_err(ManagedKeyError::local(
                "Failed to create the new SSH key in the server's data directory",
            ))?;
        log!(
            Level::Info,
            "Staged managed SSH key: device={}, account={}, fingerprint={}, encrypted={}",
            self.device,
            self.account().unwrap_or_default(),
            key.key.fingerprint(),
            key.encrypted
        );
        let pending = PendingKey {
            key,
            bootstrap,
            previous_keep,
        };
        let mut keep = pending.previous_keep.clone();
        keep.push(pending.key().fingerprint());
        let installed = self
            .run_install_script(
                &self.bootstrap_host(&pinned, &pending.bootstrap),
                &keep,
                Some(pending.key()),
            )
            .await;
        if let Err(error) = installed {
            // SSH can lose its reply after the remote rename succeeded; undo an uncertain
            // install too, rather than leaving an authorized key that no config references.
            self.rollback(pending).await;
            return Err(error);
        }
        if let Err(error) = self.verify(pending.key(), pinned).await {
            self.rollback(pending).await;
            return Err(error);
        }
        Ok(pending)
    }

    /// Removes a pending key from the device and deletes the staged file, after a failed
    /// verification or commit. The current key, if any, is never touched.
    pub(crate) async fn rollback(&self, pending: PendingKey) {
        let removed = match self.pinned_policy().await {
            Ok(Some(pinned)) => {
                self.run_install_script(
                    &self.bootstrap_host(&pinned, &pending.bootstrap),
                    &pending.previous_keep,
                    None,
                )
                .await
            }
            Ok(None) => Err(ManagedKeyError::Local(
                "The pinned host key disappeared".to_string(),
            )),
            Err(error) => Err(ManagedKeyError::local(READ_PIN_FAILED)(error)),
        };
        if let Err(error) = removed {
            redoor_core::log_failure!(
                Level::Warn,
                "Failed to remove a rolled back SSH key from the device: device={}, fingerprint={}, error={}",
                self.device,
                pending.key().fingerprint(),
                error
            );
        }
        let deleted = match self.keys() {
            Ok(keys) => keys.delete_staged(&self.device).await,
            Err(error) => Err(std::io::Error::other(error.to_string())),
        };
        if let Err(error) = deleted {
            // Logged instead of failing: nothing refers to the staged key, and the next
            // setup or rotation overwrites it.
            redoor_core::log_failure!(
                Level::Warn,
                "Failed to delete a rolled back staged SSH key: device={}, error={}",
                self.device,
                error
            );
        }
    }

    /// Makes the pending key the device's current key with one atomic file rename. Every
    /// agent start loads the key again, so the next start uses it without a config write,
    /// and a running ssh session is not affected.
    pub(crate) async fn commit(&self, pending: &PendingKey) -> std::io::Result<ManagedKey> {
        let key = self
            .keys()
            .map_err(|error| std::io::Error::other(error.to_string()))?
            .commit_staged(&pending.key)
            .await?;
        log!(
            Level::Info,
            "Managed SSH key is now current: device={}, fingerprint={}",
            self.device,
            key.fingerprint()
        );
        Ok(key)
    }

    /// After `new` became the current key, removes every other line of this device (the
    /// rotated-out key) using the new key. The old private key was already replaced by the
    /// rename, so a failure only leaves an unusable line behind and is logged.
    pub(crate) async fn finish_rotation(&self, new: &ManagedKey) {
        if let Ok(Some(pinned)) = self.pinned_policy().await {
            let host = self.managed_key_host(new, pinned);
            if let Err(error) = self
                .run_install_script(&host, &[new.fingerprint()], None)
                .await
            {
                redoor_core::log_failure!(
                    Level::Warn,
                    "Failed to remove the rotated-out SSH key from the device: device={}, error={}",
                    self.device,
                    error
                );
            }
        }
    }

    /// Removes every line this account installed for this device from the device, logging
    /// in with `credential`, the operation credential of the current key. Returns why the
    /// device could not be cleaned up, if it could not; the caller deletes the local keys
    /// either way.
    pub(crate) async fn remove_from_device(
        &self,
        credential: Option<&ManagedKey>,
    ) -> Option<String> {
        let Some(key) = credential else {
            return Some(
                "The SSH key is encrypted and was not unlocked, so its line was left on the device"
                    .to_string(),
            );
        };
        let pinned = match self.pinned_policy().await {
            Ok(Some(pinned)) => pinned,
            Ok(None) => return Some("The device has no pinned host key".to_string()),
            Err(error) => return Some(read_pin_failed(error).to_string()),
        };
        self.run_install_script(&self.managed_key_host(key, pinned), &[], None)
            .await
            .err()
            .map(|error| error.to_string())
    }

    /// The host used with a bootstrap credential; always against the pinned host key.
    fn bootstrap_host(&self, pinned: &PinnedHostKey, auth: &AuthPolicy) -> SshHost {
        SshHost::for_config(&self.config)
            .host_key(HostKeyPolicy::Pinned(pinned.clone()))
            .auth(auth.clone())
    }

    /// Enrollment step 2: finds the first credential that logs in, in this order: the
    /// stored password, the server user's own keys or ssh-agent, the typed password.
    /// Rotation uses only the current managed key, so revoking it cannot silently fall back
    /// to another identity that happens to be authorized on the device.
    ///
    /// Every rejected credential is logged with OpenSSH's reason, because the error returned
    /// to the browser can only carry the last attempt's details, and an administrator needs
    /// all of them to tell a wrong password from, say, a server key the device does not know.
    async fn bootstrap_credential(
        &self,
        pinned: &PinnedHostKey,
        current: Option<&ManagedKey>,
        typed_password: Option<Zeroizing<String>>,
    ) -> Result<AuthPolicy, ManagedKeyError> {
        // Each candidate carries the name the log and the error message use for it.
        let mut candidates: Vec<(&'static str, AuthPolicy)> = Vec::new();
        if let Some(key) = current {
            candidates.push((
                "the current managed SSH key",
                AuthPolicy::ManagedKey {
                    key: key.private_key().clone(),
                },
            ));
        }
        let typed = typed_password.is_some();
        if current.is_none() {
            if let Some(password) = &self.config.password {
                candidates.push((
                    "the stored password",
                    AuthPolicy::Password(Zeroizing::new(password.clone())),
                ));
            }
            candidates.push(("this server's own SSH keys", AuthPolicy::Default));
            if let Some(password) = typed_password {
                candidates.push(("the typed password", AuthPolicy::Password(password)));
            }
        }

        let mut rejected = Vec::new();
        let mut last_failure = String::new();
        for (credential, auth) in candidates {
            let host = self.bootstrap_host(pinned, &auth);
            let output = host
                .output("true", &[], &SshRunOptions::default())
                .await
                .map_err(ManagedKeyError::local(
                    "Failed to run ssh to log in to the device",
                ))?;
            if output.status.success() {
                log!(
                    Level::Info,
                    "Logged in to install the managed SSH key: device={}, credential={}",
                    self.device,
                    credential
                );
                return Ok(auth);
            }
            let message = host.failure_message("log in to install the SSH key", &output);
            // Only a rejected credential is worth trying the next one; a host key problem or
            // an unreachable host fails the same way for every credential.
            if !is_authentication_failure(&output) {
                return Err(if is_host_key_failure(&output) {
                    ManagedKeyError::HostKeyMismatch(message)
                } else {
                    ManagedKeyError::Remote(message)
                });
            }
            log!(
                Level::Info,
                "The device rejected a credential for installing the managed SSH key: device={}, credential={}, error={}",
                self.device,
                credential,
                message
            );
            rejected.push(credential);
            last_failure = message;
        }
        let tried = rejected.join(", ");
        Err(if current.is_some() {
            ManagedKeyError::Remote(format!(
                "The device rejected its current managed SSH key, so the key cannot be rotated. Remove the SSH key and set it up again with the device's login password.
{last_failure}"
            ))
        } else if typed {
            ManagedKeyError::Remote(format!(
                "The device rejected every credential the server tried ({tried}). Check the password, and that the account allows password login over SSH.
{last_failure}"
            ))
        } else {
            ManagedKeyError::Input(format!(
                "The server cannot log in to the device with {tried}. Enter the device's login password; it is used once and not saved."
            ))
        })
    }

    /// Enrollment step 5: logs in with only the new key and requests a reverse forward of
    /// the same form the agent uses. Running only `true` would pass on hosts that refuse
    /// forwarding, and every later agent start would then fail.
    async fn verify(&self, key: &ManagedKey, pinned: PinnedHostKey) -> Result<(), ManagedKeyError> {
        let host = self.managed_key_host(key, pinned);
        // Remote port 0 lets the device pick a free port; the destination is never used.
        let options = SshRunOptions::default().with_reverse_forward(0, "localhost", 9);
        let output = host
            .output("true", &[], &options)
            .await
            .map_err(ManagedKeyError::local(
                "Failed to run ssh to verify the new SSH key",
            ))?;
        if output.status.success() {
            log!(
                Level::Info,
                "Verified managed SSH key: device={}, fingerprint={}",
                self.device,
                key.fingerprint()
            );
            return Ok(());
        }
        Err(ManagedKeyError::Remote(format!(
            "The new SSH key was installed but does not work for redoor (it needs public key login and remote port forwarding), so it was removed again. {}",
            host.failure_message("verify the SSH key", &output)
        )))
    }

    /// Runs the `authorized_keys` update script over `host`.
    async fn run_install_script(
        &self,
        host: &SshHost,
        keep: &[String],
        new_key: Option<&ManagedKey>,
    ) -> Result<(), ManagedKeyError> {
        let new_line = new_key.map(|key| (key.authorized_keys_line(), key.fingerprint()));
        let keys = self.keys()?;
        let script = install_script(
            &device_marker(&self.device, keys.account()),
            keep,
            new_line
                .as_ref()
                .map(|(line, fingerprint)| (line.as_str(), fingerprint.as_str())),
        );
        let _rewrite = keys.lock_authorized_keys().await;
        host.run_script_captured("update authorized_keys", &script, &SshRunOptions::default())
            .await
            .map_err(|error| ManagedKeyError::Remote(error.to_string()))?;
        Ok(())
    }

    /// Whether the server user's known_hosts files already trust `key` for this host.
    /// Informational only, so any failure just means "not known".
    async fn previously_trusted(&self, key: &HostKey) -> bool {
        let Ok(dump) = SshConfigDump::load(&SshHost::for_config(&self.config)).await else {
            return false;
        };
        let Some(host_name) = dump
            .get("hostkeyalias")
            .filter(|alias| *alias != "none")
            .or_else(|| dump.get("hostname"))
        else {
            return false;
        };
        let lookup = match dump.get("port") {
            Some(port) if port != "22" => format!("[{host_name}]:{port}"),
            _ => host_name.to_string(),
        };
        let files: Vec<String> = ["userknownhostsfile", "globalknownhostsfile"]
            .iter()
            .filter_map(|option| dump.get(option))
            .flat_map(|files| files.split_whitespace().map(str::to_string))
            .collect();
        for file in files {
            // `ssh-keygen` ships with the OpenSSH client redoor already requires, and it
            // understands hashed host names.
            let Ok(output) = Command::new("ssh-keygen")
                .arg("-F")
                .arg(&lookup)
                .arg("-f")
                .arg(&file)
                .kill_on_drop(true)
                .output()
                .await
            else {
                continue;
            };
            if String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(HostKey::from_known_hosts_line)
                .any(|known| known.same_key(key))
            {
                return true;
            }
        }
        false
    }
}

/// Whether ssh failed because the credential was rejected, as opposed to the host key or
/// the network.
fn is_authentication_failure(output: &SshOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("permission denied") || stderr.contains("authentication failed")
}

/// Whether ssh refused the host key.
fn is_host_key_failure(output: &SshOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("host key verification failed")
        || stderr.contains("remote host identification has changed")
}

/// Builds the script that rewrites `~/.ssh/authorized_keys` on the device.
///
/// It drops every line with `marker` (this device and account, see [`device_marker`]) whose
/// key fingerprint is not in `keep`,
/// appends the new line (dropping an older copy with the same fingerprint first, so running
/// it again gives the same file) and moves the result over the file atomically, so sshd
/// never sees a half-written file. Lines of other devices and other tools are copied
/// unchanged. A symlinked or otherwise non-regular `authorized_keys` is left alone with an
/// error, because replacing it would break whatever manages it.
///
/// `new` is the new line and its key's fingerprint. Fingerprints contain `+`, `/` and
/// possibly `=`, so the awk filter compares them only as literal strings (`index` and
/// `==`, never a regex), and receives them through `ENVIRON`, which unlike `awk -v` does
/// not interpret backslash escapes. That works the same in GNU awk, BSD awk and busybox.
fn install_script(marker: &str, keep: &[String], new: Option<(&str, &str)>) -> String {
    // Fingerprints and key lines never contain a single quote today, but the script runs
    // on the device, so quoting must not depend on that.
    let marker = quote(marker);
    // Spaces around every entry let awk find whole fingerprints with `index`.
    let keep = quote(&format!(" {} ", keep.join(" ")));
    let new_line = quote(new.map_or("", |(line, _)| line));
    let skip = quote(new.map_or("", |(_, fingerprint)| fingerprint));
    format!(
        r#"set -eu
umask 077
marker={marker}
keep={keep}
new_line={new_line}
skip={skip}
ssh_dir="$HOME/.ssh"
authorized_keys="$ssh_dir/authorized_keys"
if [ -L "$authorized_keys" ] || {{ [ -e "$authorized_keys" ] && [ ! -f "$authorized_keys" ]; }}; then
  echo "redoor: $authorized_keys is not a regular file (for example a symlink managed by another tool); refusing to replace it" >&2
  exit 3
fi
if [ ! -e "$authorized_keys" ] && [ -z "$new_line" ]; then
  exit 0
fi
mkdir -p "$ssh_dir"
chmod 700 "$ssh_dir"
temp=$(mktemp "$ssh_dir/.authorized_keys.redoor.XXXXXX")
trap 'rm -f "$temp"' EXIT
if [ -f "$authorized_keys" ]; then
  REDOOR_MARKER="$marker" REDOOR_KEEP="$keep" REDOOR_SKIP="$skip" awk '
    BEGIN {{
      marker = ENVIRON["REDOOR_MARKER"]
      keep = ENVIRON["REDOOR_KEEP"]
      skip = ENVIRON["REDOOR_SKIP"]
    }}
    {{
      position = index($0, marker)
      if (position > 0) {{
        fingerprint = substr($0, position + length(marker))
        sub(/[ \t\r].*$/, "", fingerprint)
        if (fingerprint == "" || fingerprint == skip || index(keep, " " fingerprint " ") == 0) next
      }}
      print
    }}' "$authorized_keys" > "$temp"
fi
if [ -n "$new_line" ]; then
  printf '%s\n' "$new_line" >> "$temp"
fi
chmod 600 "$temp"
mv -f "$temp" "$authorized_keys"
trap - EXIT
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the install script against a fake home and returns the resulting file.
    async fn run_script(home: &std::path::Path, script: &str) -> std::process::Output {
        let mut child = Command::new("sh")
            .arg("-s")
            .env("HOME", home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(script.as_bytes()).await.unwrap();
        drop(stdin);
        child.wait_with_output().await.unwrap()
    }

    /// The script keeps other lines byte for byte, removes stale lines of this device and
    /// account only, and running it twice does not duplicate the new line. The fingerprints
    /// contain `+`, `/` and `=`, which must be matched literally, and a fingerprint that is a
    /// prefix of a kept one must not count as kept. Another account's lines for the same
    /// device are never touched, so one account's setup, rotation and removal cannot revoke
    /// another's key.
    #[tokio::test]
    async fn install_script_rewrites_only_this_devices_lines() {
        let home = redoor_core::test_support::TempDir::create();
        let ssh_dir = home.path().join(".ssh");
        tokio::fs::create_dir(&ssh_dir).await.unwrap();
        let device = AgentId::generate();
        let other_device = AgentId::generate();
        let stale = "SHA256:st+ale/key=";
        let kept = "SHA256:ke+pt/a.b*c=";
        let kept_prefix = "SHA256:ke+pt";
        let new = "SHA256:n+e/w==";
        let unrelated = "ssh-ed25519 AAAAunrelated  user@laptop\t# odd   spacing";
        let marker = device_marker(&device, "alice");
        let original = format!(
            "{unrelated}
ssh-ed25519 AAAAstale redoor:{device}:alice:{stale}
ssh-ed25519 AAAAprefix redoor:{device}:alice:{kept_prefix}
ssh-ed25519 AAAAother redoor:{other_device}:alice:{stale}
ssh-ed25519 AAAAbob redoor:{device}:bob:{stale}
ssh-ed25519 AAAAkept redoor:{device}:alice:{kept}\r
ssh-ed25519 AAAAempty redoor:{device}:alice:
"
        );
        tokio::fs::write(ssh_dir.join("authorized_keys"), &original)
            .await
            .unwrap();
        let new_line =
            format!("restrict,port-forwarding ssh-ed25519 AAAAnew redoor:{device}:alice:{new}");
        let script = install_script(
            &marker,
            &[kept.to_string(), new.to_string()],
            Some((&new_line, new)),
        );

        for _ in 0..2 {
            let output = run_script(home.path(), &script).await;
            // The script succeeds on a regular file.
            assert!(output.status.success(), "{output:?}");
        }
        let written = tokio::fs::read_to_string(ssh_dir.join("authorized_keys"))
            .await
            .unwrap();
        let expected = format!(
            "{unrelated}
ssh-ed25519 AAAAother redoor:{other_device}:alice:{stale}
ssh-ed25519 AAAAbob redoor:{device}:bob:{stale}
ssh-ed25519 AAAAkept redoor:{device}:alice:{kept}\r
{new_line}
"
        );
        // Unrelated lines survive unchanged (even a CRLF line ending), the stale, prefix and
        // empty-fingerprint lines of this device and account are gone, the other device's
        // and the other account's lines with the same fingerprint stay, and the new line
        // appears exactly once.
        assert_eq!(written, expected);

        let rotated = install_script(&marker, &[new.to_string()], None);
        let output = run_script(home.path(), &rotated).await;
        // Finishing a rotation keeps only the new key.
        assert!(output.status.success(), "{output:?}");
        let written = tokio::fs::read_to_string(ssh_dir.join("authorized_keys"))
            .await
            .unwrap();
        // The rotated-out key is removed, the new one is kept and nothing else changes.
        assert_eq!(
            written,
            format!(
                "{unrelated}
ssh-ed25519 AAAAother redoor:{other_device}:alice:{stale}
ssh-ed25519 AAAAbob redoor:{device}:bob:{stale}
{new_line}
"
            )
        );

        let removal = install_script(&marker, &[], None);
        let output = run_script(home.path(), &removal).await;
        // Removal with an empty keep list also succeeds.
        assert!(output.status.success(), "{output:?}");
        let written = tokio::fs::read_to_string(ssh_dir.join("authorized_keys"))
            .await
            .unwrap();
        // Every line of this device and account is removed, nothing else.
        assert_eq!(
            written,
            format!(
                "{unrelated}
ssh-ed25519 AAAAother redoor:{other_device}:alice:{stale}
ssh-ed25519 AAAAbob redoor:{device}:bob:{stale}
"
            )
        );
    }

    /// Unlocking an encrypted key for an operation (rotation, removal, device deletion)
    /// never holds it: the credential lives only for the request, so rotating or removing
    /// the key of a stopped device does not make the device startable with a token.
    #[tokio::test]
    async fn operation_credential_is_never_held() {
        use crate::ssh::encrypted_keys::SshKeySeal;
        use crate::ssh::keys::{SshKeyStore, StoredKey};

        let home = redoor_core::test_support::TempDir::create();
        let keys = SshKeyStore::for_data_dir(home.path())
            .account("alice")
            .unwrap();
        let device = AgentId::generate();
        let seal = SshKeySeal {
            vault_id: "vlt_0123456789abcdef0123456789abcdef".to_string(),
            vault_label: "test vault".to_string(),
            key_id: "kid_0123456789abcdef0123456789abcdef".to_string(),
            file_key: redoor_vault::FileKey::generate(),
            wrap: redoor_protocol::api::vault::VaultKeyWrap {
                alg: redoor_protocol::api::vault::VAULT_WRAP_ALG.to_string(),
                iv: redoor_vault::random_base64url(redoor_vault::WRAP_IV_LEN),
                ct: redoor_vault::random_base64url(redoor_vault::WRAP_CT_LEN),
            },
        };
        let staged = keys.stage(&device, Some(&seal)).await.unwrap();
        keys.commit_staged(&staged).await.unwrap();
        let held = HeldSshKeys::default();
        let managed = ManagedKeyDevice::new(
            SshBackedAgentConfig {
                id: Some(device.clone()),
                username: None,
                ssh_port: None,
                name: None,
                remote_bin: None,
                home: None,
                target: "device.invalid".to_string(),
                log: None,
                password: None,
                managed_ssh_key: true,
            },
            Some(keys),
            held.clone(),
        )
        .unwrap();
        let StoredKey::Encrypted(file) = managed.stored_key().await.unwrap() else {
            panic!("expected an encrypted key");
        };
        // Nothing is held, so the key is locked for reconnects and token starts.
        assert!(managed.held_key().is_none());
        let credential = managed.unlock(&file, &seal.file_key).await.unwrap();
        // The file key opened the device's own key.
        assert_eq!(credential.fingerprint(), staged.key.fingerprint());
        // Without a pin the removal stops before any network step and reports why.
        assert!(
            managed
                .remove_from_device(Some(&credential))
                .await
                .is_some()
        );
        // Neither unlocking nor using the credential put the key into the held keys.
        assert!(held.is_empty());
        assert!(managed.held_key().is_none());
    }

    /// A value with a single quote cannot break out of the script's quoting.
    #[tokio::test]
    async fn install_script_quotes_values() {
        let home = redoor_core::test_support::TempDir::create();
        let device = AgentId::generate();
        let line = format!("restrict ssh-ed25519 AAAAnew redoor:{device}:alice:it's; touch pwned");
        let output = run_script(
            home.path(),
            &install_script(
                &device_marker(&device, "alice"),
                &[],
                Some((&line, "it's; touch pwned")),
            ),
        )
        .await;
        // The quote is data, so the script still runs to the end.
        assert!(output.status.success(), "{output:?}");
        // The line is written verbatim ...
        assert_eq!(
            tokio::fs::read_to_string(home.path().join(".ssh/authorized_keys"))
                .await
                .unwrap(),
            format!("{line}\n")
        );
        // ... and nothing in it was executed.
        assert!(!home.path().join("pwned").exists());
    }

    /// A symlinked authorized_keys belongs to some other setup and must not be replaced.
    #[tokio::test]
    async fn install_script_refuses_symlinked_authorized_keys() {
        let home = redoor_core::test_support::TempDir::create();
        let ssh_dir = home.path().join(".ssh");
        tokio::fs::create_dir(&ssh_dir).await.unwrap();
        let target = home.path().join("managed_keys");
        tokio::fs::write(&target, "ssh-ed25519 AAAAmanaged\n")
            .await
            .unwrap();
        tokio::fs::symlink(&target, ssh_dir.join("authorized_keys"))
            .await
            .unwrap();
        let device = AgentId::generate();
        let script = install_script(
            &device_marker(&device, "alice"),
            &[],
            Some(("restrict ssh-ed25519 AAAAnew redoor:x:alice:y", "y")),
        );
        let output = run_script(home.path(), &script).await;

        // The script fails with a message that says why.
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("not a regular file"));
        // The symlink and its target are untouched.
        assert!(
            tokio::fs::symlink_metadata(ssh_dir.join("authorized_keys"))
                .await
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            "ssh-ed25519 AAAAmanaged\n"
        );
    }

    /// A missing authorized_keys is created with private modes.
    #[tokio::test]
    async fn install_script_creates_missing_file_privately() {
        use std::os::unix::fs::PermissionsExt;
        let home = redoor_core::test_support::TempDir::create();
        let device = AgentId::generate();
        let key = "SHA256:new+key/a";
        let line = format!("restrict ssh-ed25519 AAAAnew redoor:{device}:alice:{key}");
        let output = run_script(
            home.path(),
            &install_script(
                &device_marker(&device, "alice"),
                &[key.to_string()],
                Some((&line, key)),
            ),
        )
        .await;
        // The script creates ~/.ssh when it is missing.
        assert!(output.status.success(), "{output:?}");
        let ssh_dir = home.path().join(".ssh");
        let file = ssh_dir.join("authorized_keys");
        // sshd StrictModes rejects group- or world-writable files; 0600 and 0700 are stricter.
        assert_eq!(
            tokio::fs::metadata(&file)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            tokio::fs::metadata(&ssh_dir)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            tokio::fs::read_to_string(&file).await.unwrap(),
            format!("{line}\n")
        );
    }
}
