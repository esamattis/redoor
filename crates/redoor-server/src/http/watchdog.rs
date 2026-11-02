//! Server-side glue between the generic [`crate::watchdog`] supervisor
//! and the configured [`AgentConfig`] entries.
//!
//! Each agent config gets one supervisor task. The supervisor uses a closure that knows how
//! to run that agent's session: `redoor agent managed` as a local child, or over `ssh` with a
//! Unix socket forward. The closure is re-invoked on every cycle, so it must be safe to call
//! repeatedly. Every managed agent's daemon runs in its own namespace,
//! `<server app name>-<agent id>`, which gives it its own lock, log, config dir and partial
//! uploads, so several entries on one `user@host` stay apart.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::actors::router::{
    ApplyManagedLifecycleRequest, RegisterManagedAgentRequest, RouterHandle, RouterMsg,
};
use crate::ssh::{ManagedRemoteAction, ManagedSshDevice};
use crate::watchdog::{
    CycleRequest, ManagedSession, RemoteJob, SnapshotCallback, SpawnError, SpawnFn,
    SupersedeCallback, WatchdogRegistry, spawn_supervisor,
};
use anyhow::Result;
use redoor_core::config::{
    AgentConfig, LocalAgentConfig, SshBackedAgentConfig, default_local_agent_name,
};
use redoor_core::log;
use redoor_protocol::ids::AgentId;
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::managed::{ManagedConnect, ManagedLaunch};
use tokio::io::AsyncWriteExt;

/// How long a managed daemon may stay without an accepted connection before it exits.
pub(crate) const DEFAULT_ORPHAN_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a local stop or removal may take before it counts as failed and is retried.
const LOCAL_REMOTE_JOB_TIMEOUT: Duration = Duration::from_secs(60);

/// Process-wide inputs every managed agent session needs besides its own TOML row.
///
/// Built once by server startup and stored in the HTTP state, so create/update routes
/// register supervisors exactly like startup does.
#[derive(Clone)]
pub(crate) struct ManagedLauncher {
    /// This server's listener, which managed daemons connect to.
    server: redoor_core::config::LocalServerEndpoint,
    /// Registration secret handed to the daemons in their payload.
    agent_token: String,
    /// Namespace and release cache used by local and SSH sessions.
    provision: crate::ssh::ProvisionContext,
    /// Orphan limit passed to every daemon.
    orphan_timeout: Duration,
    /// What the server keeps about each SSH device across cycles, shared between its
    /// session closure and the stop and removal jobs.
    ssh_devices: Arc<Mutex<HashMap<AgentId, Arc<ManagedSshDevice>>>>,
}

impl ManagedLauncher {
    /// Captures the listener, secret, provisioning context and orphan limit shared by every
    /// managed agent.
    pub(crate) fn new(
        server: redoor_core::config::LocalServerEndpoint,
        agent_token: String,
        provision: crate::ssh::ProvisionContext,
        orphan_timeout: Duration,
    ) -> Self {
        Self {
            server,
            agent_token,
            provision,
            orphan_timeout,
            ssh_devices: Arc::default(),
        }
    }

    /// Registers configured inventory and supervisors, then starts the devices that were
    /// running when the last server process went away.
    ///
    /// Config validation already rejected duplicate ids and names, so a registry conflict
    /// here means an earlier registration of the same id is still alive.
    pub(crate) async fn register_all(
        &self,
        configs: &[AgentConfig],
        registry: &WatchdogRegistry,
        router: &RouterHandle,
    ) -> Result<()> {
        log!(
            Level::Info,
            "Registering {} managed agent(s) from config",
            configs.len()
        );
        for config in configs.iter().cloned() {
            self.register(config, registry, router).await?;
        }
        registry.start_desired_running().await;
        Ok(())
    }

    /// Registers one newly persisted agent without disturbing existing supervisors or connections.
    ///
    /// The supervisor is keyed by the entry's id, which is what the daemon sends in its
    /// `hello`, so the session finds its supervisor even after a rename.
    pub(crate) async fn register(
        &self,
        config: AgentConfig,
        registry: &WatchdogRegistry,
        router: &RouterHandle,
    ) -> Result<AgentId> {
        let agent_id = config.id().cloned().ok_or_else(|| {
            anyhow::anyhow!(
                "Managed agent '{}' has no device id; restart the server to assign one",
                config.effective_name()
            )
        })?;
        let name = config.effective_name();
        let default_directory = configured_directory(&config);
        // Both local and SSH TOML entries are operator-owned, so the UI can edit either kind.
        let configuration_editable = true;
        let ssh_target = match &config {
            AgentConfig::SshBacked(config) => Some(config.target.clone()),
            AgentConfig::Local(_) => None,
        };
        let callback = lifecycle_projection(router.clone(), agent_id.clone());
        spawn_supervisor(
            agent_id.to_string(),
            self.spawn_fn(&agent_id, config),
            registry,
            callback,
            supersede_projection(router.clone(), agent_id.clone()),
        )?;
        router
            .request(|reply| {
                RouterMsg::RegisterManagedAgent(RegisterManagedAgentRequest {
                    agent_id: agent_id.clone(),
                    name,
                    default_directory,
                    configuration_editable,
                    ssh_target,
                    reply,
                })
            })
            .await
            .map_err(|error| anyhow::anyhow!("Failed to register managed inventory: {error}"))?;
        Ok(agent_id)
    }

    /// The namespace a device's daemon runs in.
    fn namespace(&self, agent_id: &AgentId) -> String {
        format!("{}-{}", self.provision.app_name, agent_id)
    }

    /// The payload of one cycle, before the transport fills in the connect address.
    fn launch(
        &self,
        agent_id: &AgentId,
        name: String,
        home: Option<String>,
        request: &CycleRequest,
    ) -> ManagedLaunch {
        ManagedLaunch {
            token: self.agent_token.clone(),
            agent_id: agent_id.clone(),
            name,
            server_url: self.server.agent_ws_url(),
            insecure_tls: self.server.tls,
            home,
            connect: ManagedConnect::Tcp(self.server.authority()),
            orphan_timeout: self.orphan_timeout.as_secs().max(1),
            replace: request.replace,
            server_connected: request.server_connected,
        }
    }

    /// The SSH device state of `agent_id`, created on first use.
    fn ssh_device(&self, agent_id: &AgentId) -> Arc<ManagedSshDevice> {
        self.ssh_devices
            .lock()
            .expect("ssh device state poisoned")
            .entry(agent_id.clone())
            .or_insert_with(|| Arc::new(ManagedSshDevice::new(self.namespace(agent_id))))
            .clone()
    }

    /// Builds the session closure for one agent config.
    fn spawn_fn(&self, agent_id: &AgentId, config: AgentConfig) -> SpawnFn {
        match config {
            AgentConfig::Local(config) => self.local_spawn_fn(agent_id.clone(), config),
            AgentConfig::SshBacked(config) => self.ssh_backed_spawn_fn(agent_id, config),
        }
    }

    /// Runs `redoor agent managed` from the server's own binary, which after `redoor upgrade`
    /// is the upgraded file the restarted server will run too.
    fn local_spawn_fn(&self, agent_id: AgentId, config: LocalAgentConfig) -> SpawnFn {
        let launcher = self.clone();
        SpawnFn::new(move |request| {
            let launcher = launcher.clone();
            let config = config.clone();
            let agent_id = agent_id.clone();
            async move {
                launcher
                    .start_local_session(&agent_id, &config, request)
                    .await
            }
        })
    }

    /// Starts one local session and reads its report.
    async fn start_local_session(
        &self,
        agent_id: &AgentId,
        config: &LocalAgentConfig,
        request: CycleRequest,
    ) -> Result<ManagedSession, SpawnError> {
        let name = config.name.clone().unwrap_or_else(default_local_agent_name);
        let launch = self.launch(agent_id, name, config.home.clone(), &request);
        let mut command = self.local_command(agent_id, None)?;
        // Dropping the child kills the session, which never touches the daemon.
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        request
            .status
            .report("Ensuring the local agent daemon runs");
        let mut child = command.spawn().map_err(|error| {
            SpawnError::Spawn(std::io::Error::other(format!(
                "failed to start the local agent session: {error}"
            )))
        })?;
        let mut stdin = child.stdin.take().expect("session stdin is piped");
        request.daemon_may_run.mark();
        let written = stdin.write_all(launch.to_line().as_bytes()).await;
        // The pipe stays open: its end is how the session learns that the server dropped it.
        child.stdin = Some(stdin);
        match crate::managed_session::read_report(&mut child).await {
            Ok(daemon) => Ok(ManagedSession { child, daemon }),
            Err(error) => {
                let mut message = error.message("Agent session");
                if let Err(write) = written {
                    message.push_str(&format!("\nSending the launch payload failed: {write}"));
                }
                Err(SpawnError::Ensure(message))
            }
        }
    }

    /// `redoor --app-name <namespace> agent managed [flag]` from the server's binary, marked
    /// managed so `redoor upgrade` leaves it to the server.
    fn local_command(
        &self,
        agent_id: &AgentId,
        flag: Option<&str>,
    ) -> Result<tokio::process::Command, SpawnError> {
        let bin = redoor_core::executable::current().map_err(|error| {
            SpawnError::Spawn(std::io::Error::other(format!(
                "Failed to determine redoor binary path: {error}"
            )))
        })?;
        let mut command = tokio::process::Command::new(&bin);
        command
            .env_remove(redoor_core::process::DETACHED_ENV)
            .env_remove(redoor_core::process::AGENT_TOKEN_ENV)
            .env(redoor_core::process::MANAGED_AGENT_ENV, "1")
            .arg("--app-name")
            .arg(self.namespace(agent_id))
            .arg("agent")
            .arg("managed");
        if let Some(flag) = flag {
            command.arg(flag);
        }
        Ok(command)
    }

    /// Every SSH cycle re-runs sniff and install so a restart cannot hide behind a previous
    /// prepare.
    fn ssh_backed_spawn_fn(&self, agent_id: &AgentId, config: SshBackedAgentConfig) -> SpawnFn {
        log!(
            Level::Debug,
            "Creating managed SSH session closure: agent_id={}, target={}, ssh_server_port={}, name={:?}, remote_bin={:?}, home={:?}, username={:?}",
            agent_id,
            config.target,
            config
                .ssh_port
                .map(|port| port.to_string())
                .unwrap_or_else(|| "ssh-config".to_string()),
            config.name,
            config.remote_bin,
            config.home,
            config.username
        );
        let config = Arc::new(config);
        let device = self.ssh_device(agent_id);
        let agent_id = agent_id.clone();
        let launcher = self.clone();
        SpawnFn::new(move |request| {
            let launcher = launcher.clone();
            let config = config.clone();
            let device = device.clone();
            let agent_id = agent_id.clone();
            async move {
                let name = AgentConfig::SshBacked((*config).clone()).effective_name();
                let launch = launcher.launch(&agent_id, name, config.home.clone(), &request);
                launcher
                    .provision
                    .start_managed(
                        &config,
                        launcher.server,
                        launch,
                        &device,
                        &request.status,
                        &request.daemon_may_run,
                    )
                    .await
                    .map_err(SpawnError::Provision)
            }
        })
        .with_process_name("SSH process")
    }

    /// Prepares `action` on the daemon of `config`'s device.
    ///
    /// Called before the device's held SSH key is released, so an encrypted key is captured
    /// with the job. Returns `None` (logged) when the device cannot be reached with its
    /// current credentials; its daemon then ends at the orphan limit, or through its
    /// connection when it has one.
    pub(crate) async fn remote_job(
        &self,
        config: &AgentConfig,
        action: ManagedRemoteAction,
    ) -> Option<RemoteJob> {
        let agent_id = config.id()?.clone();
        match config {
            AgentConfig::Local(_) => {
                let launcher = self.clone();
                Some(Arc::new(move || {
                    let launcher = launcher.clone();
                    let agent_id = agent_id.clone();
                    Box::pin(async move { launcher.run_local_action(&agent_id, action).await })
                }))
            }
            AgentConfig::SshBacked(ssh) => {
                match self
                    .provision
                    .managed_remote_job(ssh, self.ssh_device(&agent_id), action)
                    .await
                {
                    Ok(job) => Some(job),
                    Err(error) => {
                        log!(
                            Level::Warning,
                            "Cannot reach the device to stop its daemon; it ends at the orphan limit: agent_id={}, error={}",
                            agent_id,
                            error
                        );
                        None
                    }
                }
            }
        }
    }

    /// Runs `redoor agent managed --stop` or `--remove` for a local device.
    async fn run_local_action(
        &self,
        agent_id: &AgentId,
        action: ManagedRemoteAction,
    ) -> Result<(), String> {
        let mut command = self
            .local_command(agent_id, Some(action.flag()))
            .map_err(|error| error.user_message())?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(LOCAL_REMOTE_JOB_TIMEOUT, command.output())
            .await
            .map_err(|_| "Stopping the local agent daemon timed out".to_string())?
            .map_err(|error| format!("Failed to stop the local agent daemon: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "Stopping the local agent daemon failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// Forwards supervisor snapshots to the router in order without blocking the supervisor.
fn lifecycle_projection(router: RouterHandle, agent_id: AgentId) -> SnapshotCallback {
    let (snapshot_sender, mut snapshot_receiver) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(snapshot) = snapshot_receiver.recv().await {
            if router
                .send_async(RouterMsg::ApplyManagedLifecycle(
                    ApplyManagedLifecycleRequest {
                        agent_id: agent_id.clone(),
                        snapshot,
                        evict_existing: false,
                        reply: None,
                    },
                ))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    Arc::new(move |snapshot| {
        let _ = snapshot_sender.send(snapshot);
    })
}

/// Ends a connection the supervisor found not to be the reported daemon.
fn supersede_projection(router: RouterHandle, agent_id: AgentId) -> SupersedeCallback {
    Arc::new(move |socket_id| {
        let router = router.clone();
        let agent_id = agent_id.clone();
        tokio::spawn(async move {
            let _ = router
                .send_async(RouterMsg::SupersedeManagedConnection {
                    agent_id,
                    socket_id,
                })
                .await;
        });
    })
}

/// Extracts only the configured browser directory, leaving unknown SSH defaults nullable.
fn configured_directory(config: &AgentConfig) -> Option<String> {
    match config {
        AgentConfig::Local(config) => config.home.clone(),
        AgentConfig::SshBacked(config) => config.home.clone(),
    }
}
