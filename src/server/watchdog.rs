//! Server-side glue between the generic [`crate::watchdog`] supervisor
//! and the configured [`AgentConfig`] entries.
//!
//! Each agent config gets one supervisor task. The supervisor uses a
//! closure that knows how to spawn that specific agent's subprocess
//! (local `redoor agent` or `ssh` wrapping a remote one). The closure
//! is re-invoked on every restart cycle, so it must be safe to call
//! repeatedly.

use anyhow::{Result, bail};
use redoor::actors::router::{
    ApplyManagedLifecycleRequest, RegisterManagedAgentRequest, RouterHandle, RouterMsg,
};
use redoor::types::AgentId;
use redoor::watchdog::{SnapshotCallback, SpawnFn, WatchdogRegistry, spawn_supervisor};
use redoor::{Level, log};
use tokio::process::Child;

use crate::config::{AgentConfig, LocalAgentConfig, default_local_agent_name, spawn_local_agent};

/// Registers configured inventory and dormant supervisors without starting subprocesses.
///
/// Effective names are validated as a complete set first so a duplicate cannot leave a
/// partially initialized fleet visible to clients.
pub(crate) async fn register_agents(
    configs: &[AgentConfig],
    redoor_port: u16,
    agent_token: &str,
    registry: &WatchdogRegistry,
    router: &RouterHandle,
) -> Result<()> {
    let mut keys = std::collections::HashSet::new();
    for config in configs {
        let key = supervisor_key(config);
        if !keys.insert(key.clone()) {
            bail!("Watchdog key already registered: key={key}");
        }
    }

    log!(
        Level::Info,
        "Registering {} managed agent(s) from config",
        configs.len()
    );
    for config in configs.iter().cloned() {
        register_agent(config, redoor_port, agent_token, registry, router).await?;
    }
    Ok(())
}

/// Registers one newly persisted agent without disturbing existing supervisors or connections.
pub(crate) async fn register_agent(
    config: AgentConfig,
    redoor_port: u16,
    agent_token: &str,
    registry: &WatchdogRegistry,
    router: &RouterHandle,
) -> Result<AgentId> {
    let key = supervisor_key(&config);
    let agent_id = AgentId::from(key.clone());
    let default_directory = configured_directory(&config);
    // Both local and SSH TOML entries are operator-owned, so the UI can edit either kind.
    let configuration_editable = true;
    let ssh_target = match &config {
        AgentConfig::SshBacked(config) => Some(config.target.clone()),
        AgentConfig::Local(_) => None,
    };
    let callback_router = router.clone();
    let callback_agent_id = agent_id.clone();
    let (snapshot_sender, mut snapshot_receiver) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(snapshot) = snapshot_receiver.recv().await {
            if callback_router
                .send_async(RouterMsg::ApplyManagedLifecycle(
                    ApplyManagedLifecycleRequest {
                        agent_id: callback_agent_id.clone(),
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
    let callback: SnapshotCallback = std::sync::Arc::new(move |snapshot| {
        let _ = snapshot_sender.send(snapshot);
    });
    let spawn = make_spawn_fn(config, redoor_port, agent_token.to_string());
    spawn_supervisor(key, spawn, registry, callback)?;
    router
        .request(5000, |reply| {
            RouterMsg::RegisterManagedAgent(RegisterManagedAgentRequest {
                agent_id: agent_id.clone(),
                default_directory,
                configuration_editable,
                ssh_target,
                reply,
            })
        })
        .await
        .map_err(|error| anyhow::anyhow!("Failed to register managed inventory: {error:?}"))?;
    Ok(agent_id)
}

/// Extracts only the configured browser directory, leaving unknown SSH defaults nullable.
fn configured_directory(config: &AgentConfig) -> Option<String> {
    match config {
        AgentConfig::Local(config) => config.home.clone(),
        AgentConfig::SshBacked(config) => config.home.clone(),
    }
}

/// Computes the key used to look up the supervisor from the session.
/// The key must match the name the agent registers with via its
/// `AgentRegister` message. Falls back to the system hostname for
/// local agents and the target hostname for SSH-backed agents when the
/// config omits an explicit name.
pub(crate) fn supervisor_key(config: &AgentConfig) -> String {
    match config {
        AgentConfig::Local(c) => c.name.clone().unwrap_or_else(default_local_agent_name),
        AgentConfig::SshBacked(c) => c
            .name
            .clone()
            .unwrap_or_else(|| crate::ssh::default_agent_name(&c.target)),
    }
}

/// Builds the spawn closure for one agent config. The closure is
/// re-invoked on every restart cycle, so it must be safe to call
/// repeatedly. SSH cycles re-sniff every time so the starting UI
/// always shows the current target instead of a cached spawn-only line.
fn make_spawn_fn(config: AgentConfig, redoor_port: u16, agent_token: String) -> SpawnFn {
    match config {
        AgentConfig::Local(c) => local_spawn_fn(c, redoor_port, agent_token),
        AgentConfig::SshBacked(c) => ssh_backed_spawn_fn(c, redoor_port, agent_token),
    }
}

/// Build a spawn closure for a local agent. Re-invoking just spawns
/// a fresh `redoor agent` child each time; the supervisor's restart
/// loop handles the rest.
fn local_spawn_fn(config: LocalAgentConfig, redoor_port: u16, agent_token: String) -> SpawnFn {
    let diagnostic_log = config.log.clone();
    let spawn = SpawnFn::new(move |_status| {
        let config = config.clone();
        let agent_token = agent_token.clone();
        async move {
            spawn_local_agent(&config, redoor_port, &agent_token)
                .await
                .map_err(|e| e.to_string())
        }
    });
    match diagnostic_log {
        Some(path) => spawn.with_diagnostic_log(path),
        None => spawn,
    }
}

/// Build a spawn closure for an SSH-backed agent. Every cycle re-runs sniff
/// and install so a restart cannot hide behind a previous prepare.
fn ssh_backed_spawn_fn(
    config: crate::ssh::SshBackedAgentConfig,
    redoor_port: u16,
    agent_token: String,
) -> SpawnFn {
    log!(
        Level::Debug,
        "Creating managed SSH spawn closure: target={}, ssh_server_port={}, name={:?}, remote_bin={:?}, home={:?}, log={:?}, username={:?}",
        config.target,
        config
            .ssh_port
            .map(|port| port.to_string())
            .unwrap_or_else(|| "ssh-config".to_string()),
        config.name,
        config.remote_bin,
        config.home,
        config.log,
        config.username
    );
    let diagnostic_log = config.log.clone();
    let config = std::sync::Arc::new(config);
    let spawn = SpawnFn::new(move |status| {
        ssh_backed_spawn_once(config.clone(), redoor_port, agent_token.clone(), status)
    });
    match diagnostic_log {
        Some(path) => spawn.with_diagnostic_log(path),
        None => spawn,
    }
}

/// Prepares then spawns one SSH-backed child. Prepare is not cached because
/// the starting UI must show sniff results on every attempt.
async fn ssh_backed_spawn_once(
    config: std::sync::Arc<crate::ssh::SshBackedAgentConfig>,
    redoor_port: u16,
    agent_token: String,
    status: redoor::watchdog::ProvisioningStatusSink,
) -> Result<Child, String> {
    let attempt_start = std::time::Instant::now();
    log!(
        Level::Debug,
        "Managed SSH spawn attempt started: target={}, ssh_server_port={}, name={:?}, remote_bin={:?}, home={:?}, redoor_port={}, has_password={}",
        config.target,
        config
            .ssh_port
            .map(|port| port.to_string())
            .unwrap_or_else(|| "ssh-config".to_string()),
        config.name,
        config.remote_bin,
        config.home,
        redoor_port,
        config.password.is_some()
    );
    let prepared =
        match crate::ssh::prepare_ssh_backed_agent(&config, redoor_port, &agent_token, &status)
            .await
        {
            Ok(prepared) => {
                log!(
                    Level::Debug,
                    "Managed SSH prepare succeeded: target={}, elapsed={:?}",
                    config.target,
                    attempt_start.elapsed()
                );
                prepared
            }
            Err(error) => {
                log!(
                    Level::Error,
                    "Managed SSH prepare failed: target={}, elapsed={:?}, error={:#}",
                    config.target,
                    attempt_start.elapsed(),
                    error
                );
                log!(
                    Level::Error,
                    "ssh prepare failed, will retry next cycle: {:#}",
                    error
                );
                return Err(error.to_string());
            }
        };
    // ExitOnForwardFailure makes an occupied random remote port terminate the
    // child; the supervisor's next cycle calls this again with a new port.
    let spawn_start = std::time::Instant::now();
    log!(
        Level::Debug,
        "Managed SSH spawning child: target={}, redoor_port={}, prepare_elapsed={:?}",
        config.target,
        redoor_port,
        attempt_start.elapsed()
    );
    let result = prepared
        .spawn_managed(&status)
        .await
        .map_err(|e| e.to_string());
    match &result {
        Ok(child) => log!(
            Level::Debug,
            "Managed SSH child spawned: target={}, elapsed={:?}, child_id={:?}",
            config.target,
            spawn_start.elapsed(),
            child.id()
        ),
        Err(error) => log!(
            Level::Error,
            "Managed SSH child spawn failed: target={}, elapsed={:?}, error={:#}",
            config.target,
            spawn_start.elapsed(),
            error
        ),
    }
    result
}
