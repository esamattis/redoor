//! Starts redoor agents on remote hosts and connects them back to the local
//! server through SSH reverse forwarding.
//!
//! # How SSH-backed agent spawning works
//!
//! A server-managed agent at its managed install path is started by a launch script
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
use redoor_protocol::wire::managed::ManagedLaunch;

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
    /// Managed keys and pinned host keys of SSH devices; `None` for relays, which have
    /// neither.
    pub(crate) ssh_keys: Option<keys::SshKeyStore>,
    /// Decrypted keys of running devices.
    pub(crate) held_ssh_keys: held_keys::HeldSshKeys,
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

    /// Starts a server-managed agent's session, whose Unix socket forward ends at this
    /// server's own listener, installing its binary first when needed.
    ///
    /// With built-in TLS the daemon speaks `wss://` through the tunnel and skips certificate
    /// verification, see [`redoor_core::config::LocalServerEndpoint`]. `launch` is complete
    /// except for the socket path, which this fills in.
    ///
    /// Called on every watchdog cycle so the starting UI always reflects a fresh probe.
    pub(crate) async fn start_managed(
        &self,
        config: &SshBackedAgentConfig,
        server: redoor_core::config::LocalServerEndpoint,
        launch: ManagedLaunch,
        device: &ManagedSshDevice,
        status: &ProvisioningStatusSink,
        daemon_may_run: &crate::watchdog::DaemonMayRun,
    ) -> Result<crate::watchdog::ManagedSession, ProvisionError> {
        Preparation {
            config,
            destination: TunnelDestination {
                host: "localhost".to_string(),
                port: server.port,
            },
            agent_token: &launch.token,
            secure_server: None,
            relay: RelayOptions {
                agent_app_name: Some(device.namespace.clone()),
                ..RelayOptions::default()
            },
            provision: self,
            status,
        }
        .start_managed(launch.clone(), device, daemon_may_run)
        .await
    }

    /// Prepares an operation on the device's daemon, resolving the SSH host (and with it a
    /// held SSH key) now, so the operation still works after the key is released.
    pub(crate) async fn managed_remote_job(
        &self,
        config: &SshBackedAgentConfig,
        device: std::sync::Arc<ManagedSshDevice>,
        action: ManagedRemoteAction,
    ) -> Result<crate::watchdog::RemoteJob, ProvisionError> {
        let host = managed_keys::ManagedKeyDevice::new(
            config.clone(),
            self.ssh_keys.clone(),
            self.held_ssh_keys.clone(),
        )?
        .connection_host()
        .await?;
        let candidates = device.stop_binaries(&provision::InstallLayout::new(
            &self.app_name,
            config.install_dir.as_deref(),
        ));
        Ok(std::sync::Arc::new(move || {
            let host = host.clone();
            let candidates = candidates.clone();
            let namespace = device.namespace.clone();
            Box::pin(async move { run_remote_action(&host, &candidates, &namespace, action).await })
        }))
    }
}

/// What to do with a managed agent's daemon on its device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedRemoteAction {
    /// Stop the daemon.
    Stop,
    /// Stop the daemon and delete the namespace's directories.
    Remove,
}

impl ManagedRemoteAction {
    /// The `redoor agent managed` flag for this action.
    pub(crate) fn flag(self) -> &'static str {
        match self {
            Self::Stop => "--stop",
            Self::Remove => "--remove",
        }
    }
}

/// Runs `action` for `namespace` with the first redoor binary among `candidates` that exists
/// on the device. Without any, no daemon of this server can run there either.
async fn run_remote_action(
    host: &transport::SshHost,
    candidates: &[String],
    namespace: &str,
    action: ManagedRemoteAction,
) -> Result<(), String> {
    let binaries = candidates
        .iter()
        .map(|path| shell::path_word(path))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "for bin in {binaries}; do if [ -x \"$bin\" ]; then exec \"$bin\" --app-name {} agent managed {}; fi; done; echo 'No redoor binary found to stop the agent daemon with' >&2",
        shell::quote(namespace),
        action.flag()
    );
    let output = host
        .output(&script, &[], &transport::SshRunOptions::default())
        .await
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    Err(host.failure_message("agent daemon stop", &output))
}

/// What the server keeps about one managed SSH device across its watchdog cycles.
pub(crate) struct ManagedSshDevice {
    /// The device's namespace (`<server app name>-<agent id>`).
    namespace: String,
    /// Directory holding the forward's Unix socket on the device. OpenSSH sends the `-R`
    /// path to sshd literally, before the remote command runs, so remote variables cannot be
    /// used in it; the directory is resolved once with a short session and kept until a
    /// forward fails.
    socket_dir: std::sync::Mutex<Option<String>>,
    /// Path of the binary the last session ran, used to stop the daemon.
    remote_bin: std::sync::Mutex<Option<String>>,
}

/// Where a device's forwards listen.
///
/// sshd keeps a forward's socket file after the session ends (unless its own
/// `StreamLocalBindUnlink` is on), so the next session could not bind the same path. Every
/// session therefore listens on a path of its own (`<ns>-<random>.sock`), and its
/// `redoor agent managed` points the stable `<ns>.sock` symlink at it and removes the
/// sockets of earlier sessions. The daemon only knows the stable path, so its settings, and
/// with them its spec hash, never change between sessions.
pub(super) struct SessionSockets {
    /// `<directory>/<namespace>`, without a suffix.
    base: String,
}

impl SessionSockets {
    /// The stable path the daemon connects to.
    pub(super) fn stable(&self) -> String {
        format!("{}.sock", self.base)
    }

    /// A fresh path for the next session's forward.
    pub(super) fn next_session(&self) -> String {
        format!("{}-{:08x}.sock", self.base, fastrand::u32(..))
    }
}

/// Longest Unix socket path accepted everywhere (`sun_path` is 104 bytes on macOS), with
/// room for the terminating NUL.
const MAX_SOCKET_PATH_BYTES: usize = 100;

impl ManagedSshDevice {
    /// State of the device whose daemon runs in `namespace`.
    pub(crate) fn new(namespace: String) -> Self {
        Self {
            namespace,
            socket_dir: std::sync::Mutex::new(None),
            remote_bin: std::sync::Mutex::new(None),
        }
    }

    /// The socket paths of this device's sessions, resolving the directory when needed.
    async fn sockets(
        &self,
        host: &transport::SshHost,
        namespace: &str,
        status: &ProvisioningStatusSink,
    ) -> Result<SessionSockets, ProvisionError> {
        let cached = self.socket_dir.lock().expect("socket dir poisoned").clone();
        let directory = match cached {
            Some(directory) => directory,
            None => {
                // The first SSH round trip of a device; a target that never answers shows
                // this line while ssh waits.
                status.report("Finding the agent socket directory on the SSH target");
                let output = host
                    .run_script_captured(
                        "agent socket directory",
                        "printf '%s\n' \"${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}\"\n",
                        &transport::SshRunOptions::default(),
                    )
                    .await?;
                let directory =
                    socket_directory(output.lines().last().unwrap_or_default(), namespace);
                *self.socket_dir.lock().expect("socket dir poisoned") = Some(directory.clone());
                directory
            }
        };
        Ok(SessionSockets {
            base: format!("{directory}/{namespace}"),
        })
    }

    /// Forgets the socket directory after a forward failed, so a changed directory (a new
    /// login session, another `TMPDIR`) is resolved again.
    pub(super) fn forget_socket_dir(&self) {
        *self.socket_dir.lock().expect("socket dir poisoned") = None;
    }

    /// Records the binary the last session ran.
    fn set_remote_bin(&self, remote_bin: String) {
        *self.remote_bin.lock().expect("remote bin poisoned") = Some(remote_bin);
    }

    /// Binaries to stop the daemon with, best first: the one the last session ran and this
    /// server's release install in the device's `layout`.
    fn stop_binaries(&self, layout: &provision::InstallLayout) -> Vec<String> {
        let mut candidates = Vec::new();
        candidates.extend(self.remote_bin.lock().expect("remote bin poisoned").clone());
        candidates.push(layout.release_bin());
        candidates.dedup();
        candidates
    }
}

/// Picks the socket directory from the device's answer: without a trailing slash, and
/// `/tmp` when the answer is empty, relative, or would make the path too long for a Unix
/// socket or unusable in an `ssh -R` argument.
fn socket_directory(answer: &str, namespace: &str) -> String {
    let directory = answer.trim().trim_end_matches('/');
    // The longest path is a session's own socket, `<namespace>-<8 hex>.sock`.
    let path_length = directory.len() + 1 + namespace.len() + "-00000000.sock".len();
    if !directory.starts_with('/') || directory.contains(':') || path_length > MAX_SOCKET_PATH_BYTES
    {
        return "/tmp".to_string();
    }
    directory.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The device's runtime directory is used when it fits, and `/tmp` otherwise.
    #[test]
    fn socket_directory_falls_back_to_tmp() {
        let namespace = "redoor-dev_abcdefghijklmnopqrst";
        // A runtime directory keeps the socket private to the user.
        assert_eq!(
            socket_directory("/run/user/1000\n", namespace),
            "/run/user/1000"
        );
        // macOS TMPDIR ends with a slash, which must not double up.
        assert_eq!(
            socket_directory("/var/folders/ab/cdefgh/T/", namespace),
            "/var/folders/ab/cdefgh/T"
        );
        // A path longer than sun_path allows would make the forward fail.
        assert_eq!(
            socket_directory(&format!("/{}", "x".repeat(90)), namespace),
            "/tmp"
        );
        // A colon would split the `-R` argument.
        assert_eq!(socket_directory("/odd:dir", namespace), "/tmp");
        // Nothing usable falls back as well.
        assert_eq!(socket_directory("", namespace), "/tmp");
    }

    /// The stop prefers the binary the last session ran and always falls back to the release
    /// install.
    #[test]
    fn stop_binaries_prefer_the_last_session() {
        let device = ManagedSshDevice::new("redoor-dev_x".to_string());
        let layout = provision::InstallLayout::new("redoor", Some("/mnt/tank/apps"));
        // Before any session only the release path is known, in the device's install directory.
        assert_eq!(device.stop_binaries(&layout), [layout.release_bin()]);
        device.set_remote_bin("/home/u/.local/share/redoor/binaries/debug-1/redoor".to_string());
        // The binary of the last session comes first.
        assert_eq!(
            device.stop_binaries(&layout)[0],
            "/home/u/.local/share/redoor/binaries/debug-1/redoor"
        );
    }
}
