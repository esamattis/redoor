//! Starts redoor agents on remote hosts and connects them back to the local
//! server through SSH reverse forwarding.
//!
//! # How SSH-backed agent spawning works
//!
//! A server-managed agent at the default install path is started by a launch script
//! that probes the binary and `exec`s it only when it matches this server, so a device
//! with a current binary needs a single SSH session per start. When the binary is
//! missing or stale, the script exits without starting anything, the server installs the
//! matching binary ([`provision`]) and starts again. Relays ([`relay`]) prepare once
//! instead: they probe and install up front and then start the agent repeatedly.
//!
//! Every remote command reaches the user's login shell as one `sh -c '<script>' sh
//! '<arg>'...` line of single-quoted words ([`shell`]), so fish or tcsh users run the
//! same POSIX script and arguments with spaces or quotes stay intact.
//!
//! Each launch starts `ssh` with a reverse forward shaped like
//! `remote_port:destination_host:destination_port`. SSH listens on
//! `remote_port` on the remote host and asks the local SSH client to connect to
//! the destination. Managed agents use the local redoor server, while
//! a named standalone relay ([`relay`]) uses a server reachable from the
//! machine running the command. The remote agent is given
//! `ws://localhost:<remote_port>/ws`, so what looks like a local WebSocket
//! connection to the agent actually reaches the server through that tunnel.
//! Standalone WSS routes retain the real server authority for TLS and HTTP but
//! open their TCP connections through the same random localhost tunnel port.
//!
//! The agent token is not included in either process's command-line arguments.
//! The local process writes it as the first line of SSH stdin; a small remote
//! shell preamble reads it, exports it as `REDOOR_AGENT_TOKEN`, and `exec`s the
//! agent so it inherits the secret only through its environment. Remaining
//! stdin is then forwarded normally.
//!
//! Binary uploads stream the file into one script that creates the directory, writes a
//! temp file, checks that every byte arrived, marks it executable and renames it into
//! place in a single SSH session. Remote binaries are never hashed on the device: release
//! installs are versioned paths, and a debug server installs its local build under a
//! directory named after the build's content hash, so the path identifies the bytes.
//!
//! Optional `password` values are delivered through OpenSSH `SSH_ASKPASS` by
//! re-executing this binary. That keeps the secret off argv and off the SSH
//! stdin already used for tokens, sniff scripts, and uploads.
//!
//! A device with `managed_ssh_key = true` instead logs in only with its redoor-managed key
//! ([`keys`], [`managed_keys`]) and only trusts its pinned host key. Those
//! connections read no ssh config file; their routing comes from `ssh -G`. The key may be
//! encrypted with the account's vault ([`encrypted_keys`]); it is then usable only while
//! the server holds it decrypted ([`held_keys`]). Either way `ssh` never reads the private
//! key: it gets signatures from an in-process ssh-agent ([`ssh_agent`]).
//!
//! Both standalone and TOML-managed launches select a random dynamic remote
//! port for each SSH spawn attempt. `ExitOnForwardFailure=yes` makes SSH exit
//! when that port is already occupied. Managed agents let the watchdog retry;
//! standalone relays detect that specific bind failure and retry locally.

pub mod askpass;
pub(crate) mod encrypted_keys;
pub(crate) mod held_keys;
pub(crate) mod keys;
pub(crate) mod managed_keys;
mod prepare;
mod provision;
pub mod relay;
mod shell;
mod ssh_agent;
mod transport;

use redoor_core::config::SshBackedAgentConfig;

use crate::watchdog::ProvisioningStatusSink;
use prepare::{Preparation, RelayOptions, TunnelDestination};

/// Why preparing an SSH target failed; every variant's text is shown to operators as is.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProvisionError {
    /// Running `ssh` or reading a local file failed; SSH failures already carry
    /// sanitized, actionable guidance (authentication, host keys, timeouts).
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// The matching release binary could not be cached locally.
    #[error("{0}")]
    Release(#[from] crate::binaries::UpgradeBinaryError),
    /// The remote host answered unexpectedly (unsupported platform, failed command,
    /// a binary that does not verify after upload).
    #[error("{0}")]
    Remote(String),
    /// The entry cannot be launched as configured (for example it has no device id yet).
    #[error("{0}")]
    Configuration(String),
    /// The device's managed key is encrypted with the vault and the server does not hold
    /// it decrypted. Retrying cannot help: only a browser Start can hand the key over.
    #[error("{0}")]
    SshKeyLocked(String),
}

impl ProvisionError {
    /// Whether the watchdog should retry after this failure. A locked key stays locked
    /// until the user starts the device from the browser, so retrying only spins.
    pub(crate) fn is_retryable(&self) -> bool {
        !matches!(self, Self::SshKeyLocked(_))
    }
}

/// Local facts every SSH preparation needs besides the target's own settings.
#[derive(Clone)]
pub(crate) struct ProvisionContext {
    /// Local namespace: installs land under it remotely and spawned agents inherit it.
    pub(crate) app_name: String,
    /// Release cache used when the target lacks a matching binary.
    pub(crate) binaries: crate::binaries::BinaryCache,
    /// Managed keys and pinned host keys of SSH devices, per account.
    pub(crate) ssh_keys: keys::SshKeyStore,
    /// Decrypted keys of running devices and the account that started each device.
    pub(crate) held_ssh_keys: held_keys::HeldSshKeys,
    /// The account whose keys and pins a device uses when no Start recorded one: the
    /// server's single login account, or `None` for relays, which have no account.
    pub(crate) default_account: Option<String>,
    /// Size limit of the agent log files this process forwards SSH and child output into;
    /// `None` uses the default limit.
    pub(crate) log_max_size: Option<u64>,
    /// Identity of the local debug build, computed on the first SSH provision that needs it
    /// and shared by every clone so concurrent starts hash a rebuilt binary only once.
    pub(crate) local_build: provision::LocalBuildCache,
}

impl ProvisionContext {
    /// Pairs an agent's configured log path with this process's log size limit.
    pub(crate) fn log_file(&self, path: &str) -> redoor_core::rotating_log::LogFileSpec {
        redoor_core::rotating_log::LogFileSpec::new(path, self.log_max_size)
    }

    /// Starts a server-managed agent whose tunnel ends at this server's own listener,
    /// installing its binary first when needed.
    ///
    /// Called on every watchdog cycle so the starting UI always reflects a fresh probe.
    pub(crate) async fn start_managed(
        &self,
        config: &SshBackedAgentConfig,
        redoor_port: u16,
        agent_token: &str,
        status: &ProvisioningStatusSink,
    ) -> Result<tokio::process::Child, ProvisionError> {
        Preparation {
            config,
            destination: TunnelDestination {
                host: "localhost".to_string(),
                port: redoor_port,
            },
            agent_token,
            relay: RelayOptions::default(),
            provision: self,
            status,
        }
        .start_managed()
        .await
    }
}
