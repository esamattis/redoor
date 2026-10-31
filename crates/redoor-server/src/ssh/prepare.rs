//! Turns an SSH-backed agent configuration into a launchable [`PreparedSshBackedAgent`].
//!
//! Preparation probes the remote host, installs a compatible binary when needed and
//! computes the SSH options; launching then only spawns `ssh` with a fresh random
//! reverse-forward port. Managed agents re-prepare on every watchdog cycle so the UI
//! always shows current sniff results; relays prepare once and relaunch many times.

use redoor_protocol::wire::handshake::AGENT_WS_PATH;
use std::path::Path;
use std::time::Instant;

use redoor_core::config::{SshBackedAgentConfig, default_agent_name};
use redoor_core::{log, log_error};
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::log::Level;

use super::managed_keys::ManagedKeyDevice;
use super::provision::{
    BinaryCheck, BinaryCheckResult, BinaryExpectation, Installer, LAUNCH_NEEDS_INSTALL,
    LAUNCH_READY, PROBE_REPORT_LINES, ProbeCheck, RemoteSniff, default_remote_bin,
    force_upload_binary,
};
use super::shell::path_word;
use super::transport::{SshHost, SshRunOptions};
use super::{ProvisionContext, ProvisionError};
use crate::watchdog::ProvisioningStatusSink;

/// Remembers the last random remote port so every retry necessarily chooses a
/// different candidate while sharing the same policy across launcher types.
#[derive(Clone, Default)]
pub(super) struct RandomRemotePort {
    /// Atomic state keeps cloned prepared agents coordinated across spawn calls.
    previous: std::sync::Arc<std::sync::atomic::AtomicU16>,
}

impl RandomRemotePort {
    /// Chooses the next IANA dynamic/private port and records it for the retry.
    pub(super) fn next(&self) -> u16 {
        let previous = self.previous.load(std::sync::atomic::Ordering::Relaxed);
        let port = random_remote_port(previous);
        log!(
            Level::Debug,
            "Selected random remote port: previous={}, next={}, range=49152..=65535",
            previous,
            port
        );
        self.previous
            .store(port, std::sync::atomic::Ordering::Relaxed);
        port
    }
}

/// Chooses an IANA dynamic/private port and excludes the immediately previous
/// choice so every managed or standalone retry uses a new tunnel endpoint.
fn random_remote_port(previous: u16) -> u16 {
    loop {
        let port = fastrand::u16(49152..=65535);
        if port != previous {
            return port;
        }
    }
}

/// WSS-only launch settings that preserve server identity across the localhost tunnel.
#[derive(Clone)]
pub(super) struct SecureRelayServer {
    /// Logical authority retained in the URL for TLS SNI and HTTP Host handling.
    pub(super) authority: String,
    /// Whether the remote agent should deliberately skip certificate verification.
    pub(super) insecure: bool,
}

/// Where the reverse tunnel ends, as reached from the machine running `ssh`.
#[derive(Clone)]
pub(super) struct TunnelDestination {
    /// Host the local SSH client connects to for each forwarded connection.
    pub(super) host: String,
    /// Port the local SSH client connects to for each forwarded connection.
    pub(super) port: u16,
}

/// Settings in which a standalone relay differs from a server-managed agent.
#[derive(Default)]
pub(super) struct RelayOptions<'a> {
    /// Pipes stderr so the relay can detect OpenSSH forwarding failures and retry.
    pub(super) monitor_forward_failure: bool,
    /// Retains TLS server identity while transport connects through the tunnel.
    pub(super) secure_server: Option<SecureRelayServer>,
    /// Forces an operator-selected local binary onto the remote host.
    pub(super) binary_source: Option<&'a Path>,
    /// Isolates a standalone relay's remote PID and application data namespace.
    pub(super) agent_app_name: Option<String>,
}

/// Resolved values for one SSH-backed agent: the prepared host and the
/// ssh argv to run. Launchers use the shared random spawn method to start a
/// fresh child without re-sniffing the host or re-uploading the binary.
#[derive(Clone)]
pub(super) struct PreparedSshBackedAgent {
    pub(super) host: SshHost,
    /// Agent registration name passed with `--name`.
    pub(super) agent_name: String,
    /// Device id passed with `--agent-id`; owned by the server or relay config so wiped
    /// remote state and several entries on one `user@host` cannot change or share it.
    pub(super) agent_id: AgentId,
    /// Root CLI namespace passed explicitly so the remote process matches the server.
    pub(super) app_name: String,
    /// Remote executable path; a home or data directory prefix is expanded remotely by
    /// [`path_word`].
    pub(super) remote_bin: String,
    /// Directory the UI opens first, when configured; expanded like `remote_bin`.
    pub(super) home: Option<String>,
    /// Where the reverse tunnel ends.
    pub(super) destination: TunnelDestination,
    /// SSH options shared by every launch (secret env, log file, stderr routing).
    pub(super) options: SshRunOptions,
    /// Shares random-port selection between standalone and managed launches.
    pub(super) random_remote_port: RandomRemotePort,
    /// Relay WSS identity; absent for plain and server-managed SSH-backed agents.
    pub(super) secure_server: Option<SecureRelayServer>,
}

impl PreparedSshBackedAgent {
    /// Spawns the long-running ssh child on `remote_port` with `options`, starting
    /// `remote_bin` without checking it first.
    ///
    /// The returned `Child` is owned by the caller (the supervisor or relay) so it can
    /// wait for normal exit or kill it when the WebSocket goes stale.
    async fn spawn_on(
        &self,
        remote_port: u16,
        options: &SshRunOptions,
        remote_argv: &[String],
    ) -> std::io::Result<tokio::process::Child> {
        log!(
            Level::Info,
            "Spawning SSH-backed redoor agent: target={}, ssh_server_port={}, name={}, remote_bin={}, random_remote_port={}, destination={}:{}",
            self.host.target(),
            self.host.server_port_label(),
            self.agent_name,
            self.remote_bin,
            remote_port,
            self.destination.host,
            self.destination.port
        );
        let argv_refs: Vec<&str> = remote_argv.iter().map(String::as_str).collect();
        let script = format!(
            "{}exec {} \"$@\"",
            self.home_statement(),
            path_word(&self.remote_bin)
        );
        let result = self.host.spawn(&script, &argv_refs, options).await;
        match &result {
            Ok(child) => log!(
                Level::Debug,
                "SSH spawn succeeded: target={}, remote_port={}, child_id={:?}",
                self.host.target(),
                remote_port,
                child.id()
            ),
            Err(error) => log_error!(
                anyhow::Error::msg(error.to_string()),
                "SSH spawn failed: target={}, remote_port={}",
                self.host.target(),
                remote_port
            ),
        }
        result
    }

    /// Starts a relay attempt through a fresh random remote port and returns both the
    /// selected port and child so the relay can apply its retry policy.
    pub(super) async fn spawn_random(&self) -> std::io::Result<(u16, tokio::process::Child)> {
        let remote_port = self.random_remote_port.next();
        let (remote_argv, options) = self.launch_settings(remote_port);
        let child = self.spawn_on(remote_port, &options, &remote_argv).await?;
        Ok((remote_port, child))
    }

    /// Starts a TOML-managed agent from a binary that is used without checking, with the
    /// shared random-port policy, leaving retries and stale-session handling to the
    /// server watchdog.
    async fn spawn_managed(
        &self,
        status: &ProvisioningStatusSink,
    ) -> std::io::Result<tokio::process::Child> {
        let remote_port = self.random_remote_port.next();
        status.report(format!("Spawning the remote binary at {}", self.remote_bin));
        let (remote_argv, options) = self.managed_launch_settings(remote_port);
        self.spawn_on(remote_port, &options, &remote_argv).await
    }

    /// Launch settings of a managed agent: the shared ones plus the managed-agent marker
    /// and, without a log file, piped stderr for the watchdog.
    fn managed_launch_settings(&self, remote_port: u16) -> (Vec<String>, SshRunOptions) {
        let (remote_argv, options) = self.launch_settings(remote_port);
        let mut options = options.with_managed_agent();
        if options.log_file().is_none() {
            // The watchdog drains this bounded stream into connection_issue so
            // OpenSSH failures do not collapse into an unexplained status 255.
            options = options.with_piped_stderr();
        }
        (remote_argv, options)
    }

    /// Appends `--home` to the agent's arguments inside the launch script, so a
    /// home-relative directory is expanded on the device like the binary path.
    fn home_statement(&self) -> String {
        match &self.home {
            Some(home) => format!("set -- \"$@\" --home {}; ", path_word(home)),
            None => String::new(),
        }
    }

    /// Builds the matching remote agent argv and reverse-forward options so the
    /// agent always connects to the random port SSH actually requested.
    pub(super) fn launch_settings(&self, remote_port: u16) -> (Vec<String>, SshRunOptions) {
        let server_url = match &self.secure_server {
            Some(server) => format!("wss://{}{AGENT_WS_PATH}", server.authority),
            None => format!("ws://localhost:{remote_port}{AGENT_WS_PATH}"),
        };
        let mut remote_argv = vec![
            "--app-name".to_string(),
            self.app_name.clone(),
            "agent".to_string(),
            server_url,
            "--exit-on-stdin-eof".to_string(),
            "--log-format".to_string(),
            "line".to_string(),
            "--name".to_string(),
            self.agent_name.clone(),
            "--agent-id".to_string(),
            self.agent_id.to_string(),
        ];
        if let Some(server) = &self.secure_server {
            remote_argv.push("--connect-address".to_string());
            remote_argv.push(format!("localhost:{remote_port}"));
            if server.insecure {
                remote_argv.push("--insecure-tls".to_string());
            }
        }
        log!(
            Level::Debug,
            "Built SSH launch settings: target={}, remote_port={}, remote_argv={:?}",
            self.host.target(),
            remote_port,
            remote_argv
        );
        let options = self.options.clone().with_reverse_forward(
            remote_port,
            self.destination.host.clone(),
            self.destination.port,
        );
        (remote_argv, options)
    }
}

/// One preparation run: the target's settings plus the local context, consumed by
/// [`Preparation::run`] step by step.
pub(super) struct Preparation<'a> {
    /// Target settings from TOML or the relay definition.
    pub(super) config: &'a SshBackedAgentConfig,
    /// Where the reverse tunnel ends.
    pub(super) destination: TunnelDestination,
    /// Secret handed to the remote agent through SSH stdin.
    pub(super) agent_token: &'a str,
    /// Relay-only behavior; defaults describe a managed agent.
    pub(super) relay: RelayOptions<'a>,
    /// Local namespace and release cache.
    pub(super) provision: &'a ProvisionContext,
    /// Progress lines for the lifecycle UI.
    pub(super) status: &'a ProvisioningStatusSink,
}

impl Preparation<'_> {
    /// Probes and installs as needed, then assembles the launchable agent. Used by relays,
    /// which start the agent later and repeatedly from the prepared state.
    pub(super) async fn run(self) -> Result<PreparedSshBackedAgent, ProvisionError> {
        let started = Instant::now();
        let mut prepared = self.assemble().await?;
        match self.install_binary(&prepared.host).await {
            Ok(remote_bin) => prepared.remote_bin = remote_bin,
            Err(error) => {
                log_error!(
                    anyhow::Error::msg(error.to_string()),
                    "SSH prepare failed: target={}, elapsed={:?}",
                    self.config.target,
                    started.elapsed()
                );
                return Err(error);
            }
        }
        log!(
            Level::Info,
            "Prepared redoor agent on remote host: name={}, agent_id={}, remote_bin={}, home={:?}, log={:?}, elapsed={:?}",
            prepared.agent_name,
            prepared.agent_id,
            prepared.remote_bin,
            self.config.home,
            self.config.log,
            started.elapsed()
        );
        Ok(prepared)
    }

    /// Starts a server-managed agent. A binary at the default install path is probed in
    /// the same SSH session that starts it, so a device with a current binary needs one
    /// session; only a missing or stale binary costs an upload and a second start.
    pub(super) async fn start_managed(self) -> Result<tokio::process::Child, ProvisionError> {
        let started = Instant::now();
        let prepared = self.assemble().await?;
        let result = if self.config.remote_bin.is_some() {
            self.trust_operator_binary(&prepared.remote_bin);
            prepared
                .spawn_managed(self.status)
                .await
                .map_err(ProvisionError::from)
        } else {
            Installer {
                host: &prepared.host,
                provision: self.provision,
                status: self.status,
            }
            .ensure(&mut LaunchCheck {
                prepared: &prepared,
                status: self.status,
            })
            .await
        };
        match &result {
            Ok(child) => log!(
                Level::Info,
                "Started managed SSH agent: target={}, name={}, agent_id={}, child_id={:?}, elapsed={:?}",
                self.config.target,
                prepared.agent_name,
                prepared.agent_id,
                child.id(),
                started.elapsed()
            ),
            Err(error) => log_error!(
                anyhow::Error::msg(error.to_string()),
                "Managed SSH agent start failed: target={}, name={}, agent_id={}, elapsed={:?}",
                self.config.target,
                prepared.agent_name,
                prepared.agent_id,
                started.elapsed()
            ),
        }
        result
    }

    /// Builds the launchable agent for the requested binary path without touching the host.
    async fn assemble(&self) -> Result<PreparedSshBackedAgent, ProvisionError> {
        // Checked before touching the host: an entry without an id cannot register anyway.
        let agent_id = self.config.id.clone().ok_or_else(|| {
            ProvisionError::Configuration(format!(
                "SSH agent '{}' has no device id in the config",
                self.config.target
            ))
        })?;
        let host = self.ssh_host().await?;
        let agent_name = self
            .config
            .name
            .clone()
            .unwrap_or_else(|| default_agent_name(&self.config.target));
        Ok(PreparedSshBackedAgent {
            options: self.run_options(),
            host,
            agent_name,
            agent_id,
            app_name: self
                .relay
                .agent_app_name
                .clone()
                .unwrap_or_else(|| self.provision.app_name.clone()),
            remote_bin: self.requested_remote_bin(),
            home: self.config.home.clone(),
            destination: self.destination.clone(),
            random_remote_port: RandomRemotePort::default(),
            secure_server: self.relay.secure_server.clone(),
        })
    }

    /// Builds the SSH connection parameters from the target settings. A device with a
    /// managed key uses only that key and its pinned host key, for the probe, the binary
    /// upload and the agent session alike.
    ///
    /// The keys and pin come from the account that started the device, so reconnects use
    /// the key that account handed over.
    async fn ssh_host(&self) -> Result<SshHost, ProvisionError> {
        let account = self
            .config
            .id
            .as_ref()
            .and_then(|device| self.provision.held_ssh_keys.started_by(device))
            .or_else(|| self.provision.default_account.clone());
        let keys = account
            .map(|account| self.provision.ssh_keys.account(&account))
            .transpose()?;
        ManagedKeyDevice::new(
            self.config.clone(),
            keys,
            self.provision.held_ssh_keys.clone(),
        )?
        .connection_host()
        .await
    }

    /// Operator-chosen path, or the versioned default under the local namespace.
    fn requested_remote_bin(&self) -> String {
        self.config
            .remote_bin
            .clone()
            .unwrap_or_else(|| default_remote_bin(&self.provision.app_name))
    }

    /// Makes sure a usable binary exists remotely and returns the path to run.
    ///
    /// A relay `binary_source` always uploads. Otherwise an operator-supplied
    /// `remote_bin` is trusted as-is (probing and reinstalling would clobber a binary
    /// placed there on purpose), and only the default path is sniffed and provisioned,
    /// so a fresh host works without a manual install.
    async fn install_binary(&self, host: &SshHost) -> Result<String, ProvisionError> {
        let remote_bin = self.requested_remote_bin();
        if let Some(binary_source) = self.relay.binary_source {
            return self.force_upload(host, binary_source, &remote_bin).await;
        }
        if self.config.remote_bin.is_some() {
            self.trust_operator_binary(&remote_bin);
            return Ok(remote_bin);
        }
        log!(
            Level::Info,
            "Sniffing SSH target before relay: target={}, ssh_server_port={}",
            self.config.target,
            host.server_port_label()
        );
        Installer {
            host,
            provision: self.provision,
            status: self.status,
        }
        .ensure(&mut ProbeCheck { host })
        .await
    }

    /// Replaces the remote binary with an operator-selected local file.
    async fn force_upload(
        &self,
        host: &SshHost,
        binary_source: &Path,
        remote_bin: &str,
    ) -> Result<String, ProvisionError> {
        log!(
            Level::Info,
            "Force-uploading operator-provided binary before relay: target={}, binary_source={}, remote_bin={}",
            self.config.target,
            binary_source.display(),
            remote_bin
        );
        force_upload_binary(host, binary_source, remote_bin, self.status).await
    }

    /// Reports that an operator-provided path is used without touching it.
    fn trust_operator_binary(&self, remote_bin: &str) {
        self.status.report(format!(
            "Using operator-provided remote binary at {remote_bin}"
        ));
        log!(
            Level::Info,
            "Using operator-provided remote binary without sniffing or provisioning: target={}, remote_bin={}",
            self.config.target,
            remote_bin
        );
    }

    /// SSH options shared by every launch: the token as stdin secret, the log file and,
    /// for relays, piped stderr for forward-failure detection.
    fn run_options(&self) -> SshRunOptions {
        let mut options =
            SshRunOptions::default().with_secret_env("REDOOR_AGENT_TOKEN", self.agent_token);
        if let Some(log) = &self.config.log {
            options = options.with_log_file(self.provision.log_file(log));
        }
        if self.relay.monitor_forward_failure {
            options = options.with_piped_stderr();
        }
        options
    }
}

/// Checks a managed agent's binary by starting it with the launch script, which probes
/// first and only `exec`s a matching binary; the ready value is the running ssh child.
struct LaunchCheck<'a> {
    /// The agent to start.
    prepared: &'a PreparedSshBackedAgent,
    /// Progress lines for the lifecycle UI.
    status: &'a ProvisioningStatusSink,
}

impl BinaryCheck for LaunchCheck<'_> {
    type Ready = tokio::process::Child;

    async fn check(
        &mut self,
        remote_bin: &str,
        expect: &BinaryExpectation,
    ) -> Result<BinaryCheckResult<tokio::process::Child>, ProvisionError> {
        let prepared = self.prepared;
        let target = prepared.host.target();
        let remote_port = prepared.random_remote_port.next();
        let (remote_argv, options) = prepared.managed_launch_settings(remote_port);
        let argv_refs: Vec<&str> = remote_argv.iter().map(String::as_str).collect();
        let script = format!(
            "{}{}",
            prepared.home_statement(),
            expect.launch_script(remote_bin)
        );
        log!(
            Level::Info,
            "Starting SSH-backed redoor agent if its binary matches: target={}, ssh_server_port={}, name={}, remote_bin={}, random_remote_port={}, destination={}:{}",
            target,
            prepared.host.server_port_label(),
            prepared.agent_name,
            remote_bin,
            remote_port,
            prepared.destination.host,
            prepared.destination.port
        );
        // A dropped child kills the ssh client, which stops a started agent through
        // `--exit-on-stdin-eof`, so every early return below leaves nothing running.
        let reported = prepared
            .host
            .spawn_with_report(
                &script,
                &argv_refs,
                &options,
                PROBE_REPORT_LINES + 1,
                "agent start",
            )
            .await?;
        let mut child = reported.child;
        let (probe, decision) = reported.report.split_at(PROBE_REPORT_LINES);
        let sniff = RemoteSniff::parse(target, probe)?;
        match decision.first().map(String::as_str) {
            Some(LAUNCH_READY) => {
                self.status.report(format!(
                    "Spawning the remote binary at {}",
                    sniff.remote_bin
                ));
                Ok(BinaryCheckResult {
                    sniff,
                    ready: Some(child),
                })
            }
            Some(LAUNCH_NEEDS_INSTALL) => {
                // The script exits right after the report; waiting reaps the ssh client.
                match child.wait().await {
                    Ok(status) => log!(
                        Level::Debug,
                        "Launch script found no matching binary: target={}, remote_bin={}, exit_status={}",
                        target,
                        sniff.remote_bin,
                        status.code().unwrap_or(-1)
                    ),
                    Err(error) => redoor_core::log_failure!(
                        Level::Error,
                        "Waiting for the finished launch script failed: target={}, error={:#}",
                        target,
                        error
                    ),
                }
                Ok(BinaryCheckResult { sniff, ready: None })
            }
            other => {
                redoor_core::log_failure!(
                    Level::Error,
                    "Launch script printed an unexpected decision: target={}, decision={:?}, report={:?}",
                    target,
                    other,
                    reported.report
                );
                Err(ProvisionError::Remote(format!(
                    "unexpected launch output from {target}: {other:?}; expected '{LAUNCH_READY}' or '{LAUNCH_NEEDS_INSTALL}'"
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies cloned prepared-agent state cannot immediately reuse the port
    /// selected by another launcher attempt.
    #[test]
    fn random_port_state_is_shared_across_clones() {
        let ports = RandomRemotePort::default();
        let cloned = ports.clone();
        let first = ports.next();
        let second = cloned.next();

        // Shared retry state must force the next attempt onto a different endpoint.
        assert_ne!(first, second);
        // Both launcher types must stay inside the IANA dynamic/private range.
        assert!((49152..=65535).contains(&second));
    }

    /// Verifies managed tunnel ports stay in the dynamic/private range and a
    /// retry cannot repeat the port that just failed to bind.
    #[test]
    fn random_remote_port_uses_new_dynamic_port() {
        let first = random_remote_port(0);
        let second = random_remote_port(first);

        // Dynamic ports avoid commonly configured services on the remote host.
        assert!((49152..=65535).contains(&first));
        // A failed forward must retry with a genuinely new remote endpoint.
        assert_ne!(second, first);
        // Every retry must remain inside the dynamic/private range.
        assert!((49152..=65535).contains(&second));
    }

    /// Builds prepared state without touching an SSH host so launch argv can be checked directly.
    fn prepared_agent(secure_server: Option<SecureRelayServer>) -> PreparedSshBackedAgent {
        PreparedSshBackedAgent {
            host: SshHost::new("user@target".to_string()),
            agent_name: "target".to_string(),
            agent_id: AgentId::generate(),
            app_name: "redoor".to_string(),
            remote_bin: "/tmp/redoor".to_string(),
            home: None,
            destination: TunnelDestination {
                host: "redoor.example".to_string(),
                port: 443,
            },
            options: SshRunOptions::default(),
            random_remote_port: RandomRemotePort::default(),
            secure_server,
        }
    }

    /// Keeps existing plain routes pointed directly at the random tunnel listener.
    #[test]
    fn plain_launch_uses_random_tunnel_url() {
        let prepared = prepared_agent(None);
        let (argv, _options) = prepared.launch_settings(52123);

        // Plain routing must retain its existing URL and avoid hidden TLS routing flags.
        assert!(
            argv.iter()
                .any(|value| value == "ws://localhost:52123/api/v1/agent/ws")
        );
        // SSH channel EOF must stop the remote process instead of leaving its PID lock held.
        assert!(argv.iter().any(|value| value == "--exit-on-stdin-eof"));
        assert!(!argv.iter().any(|value| value == "--connect-address"));
        assert!(!argv.iter().any(|value| value == "--insecure-tls"));
    }

    /// Keeps WSS server identity stable while retries change only the physical tunnel endpoint.
    #[test]
    fn secure_launch_separates_authority_from_tunnel() {
        let prepared = prepared_agent(Some(SecureRelayServer {
            authority: "redoor.example:443".to_string(),
            insecure: true,
        }));
        let (first_argv, _options) = prepared.launch_settings(52123);
        let (second_argv, _options) = prepared.launch_settings(52124);

        // The logical URL supplies both SNI and WebSocket authority across tunnel retries.
        assert!(
            first_argv
                .iter()
                .any(|value| value == "wss://redoor.example:443/api/v1/agent/ws")
        );
        assert!(
            second_argv
                .iter()
                .any(|value| value == "wss://redoor.example:443/api/v1/agent/ws")
        );
        // Each retry must direct TCP to the newly selected remote SSH listener.
        assert!(first_argv.iter().any(|value| value == "localhost:52123"));
        assert!(second_argv.iter().any(|value| value == "localhost:52124"));
        // The explicit insecure choice must be propagated without exposing the agent token.
        assert!(first_argv.iter().any(|value| value == "--insecure-tls"));
        assert!(!first_argv.iter().any(|value| value == "secret"));
    }
}
