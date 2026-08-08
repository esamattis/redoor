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

use super::config::{AgentConfig, LocalAgentConfig, default_local_agent_name, spawn_local_agent};

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
        let key = supervisor_key(&config);
        let agent_id = AgentId::from(key.clone());
        let default_directory = configured_directory(&config);
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
                    agent_id,
                    default_directory,
                    reply,
                })
            })
            .await
            .map_err(|error| anyhow::anyhow!("Failed to register managed inventory: {error:?}"))?;
    }
    Ok(())
}

/// Extracts only the configured browser directory, leaving unknown SSH defaults nullable.
fn configured_directory(config: &AgentConfig) -> Option<String> {
    match config {
        AgentConfig::Local(config) => config.dir.clone(),
        AgentConfig::Ssh(config) => config.dir.clone(),
    }
}

/// Computes the key used to look up the supervisor from the session.
/// The key must match the name the agent registers with via its
/// `AgentRegister` message. Falls back to the system hostname for
/// local agents and the target hostname for ssh agents when the
/// config omits an explicit name.
fn supervisor_key(config: &AgentConfig) -> String {
    match config {
        AgentConfig::Local(c) => c.name.clone().unwrap_or_else(default_local_agent_name),
        AgentConfig::Ssh(c) => c
            .name
            .clone()
            .unwrap_or_else(|| crate::ssh::default_agent_name(&c.target)),
    }
}

/// Builds the spawn closure for one agent config. The closure is
/// re-invoked on every restart cycle, so it must be safe to call
/// repeatedly. Ssh closures cache the one-time prepare step in
/// shared state so re-invocations just spawn a fresh ssh child
/// without re-sniffing the host; a failed prepare is retried on
/// the next cycle.
fn make_spawn_fn(config: AgentConfig, redoor_port: u16, agent_token: String) -> SpawnFn {
    match config {
        AgentConfig::Local(c) => local_spawn_fn(c, redoor_port, agent_token),
        AgentConfig::Ssh(c) => ssh_spawn_fn(c, redoor_port, agent_token),
    }
}

/// Build a spawn closure for a local agent. Re-invoking just spawns
/// a fresh `redoor agent` child each time; the supervisor's restart
/// loop handles the rest.
fn local_spawn_fn(config: LocalAgentConfig, redoor_port: u16, agent_token: String) -> SpawnFn {
    SpawnFn::new(move || {
        let config = config.clone();
        let agent_token = agent_token.clone();
        async move {
            spawn_local_agent(&config, redoor_port, &agent_token)
                .await
                .map_err(|e| e.to_string())
        }
    })
}

/// Build a spawn closure for an ssh agent. The first invocation runs the
/// one-time prepare (sniff + download + upload) and caches the
/// `PreparedSshAgent` for subsequent calls. Re-invocations on later
/// restart cycles skip the prepare and just spawn a fresh ssh child.
/// If the prepare fails (e.g. transient network blip), the cache stays
/// empty and the next cycle retries the prepare; a successful prepare
/// then switches the closure to the cached fast path. A spawn failure
/// after a successful prepare goes through the supervisor's normal
/// backoff loop without re-running the prepare.
fn ssh_spawn_fn(
    config: crate::ssh::SshAgentConfig,
    redoor_port: u16,
    agent_token: String,
) -> SpawnFn {
    use tokio::sync::Mutex;

    // Cached `PreparedSshAgent`. `None` means "not yet prepared or the
    // last prepare failed"; the closure retries `prepare_ssh_agent` and
    // stores the result on success. The supervisor calls the spawn
    // closure serially (one cycle at a time) so contention on this lock
    // is limited to the prepare call itself.
    let cached: std::sync::Arc<Mutex<Option<crate::ssh::PreparedSshAgent>>> =
        std::sync::Arc::new(Mutex::new(None));
    let config = std::sync::Arc::new(config);
    SpawnFn::new(move || {
        ssh_spawn_once(
            cached.clone(),
            config.clone(),
            redoor_port,
            agent_token.clone(),
        )
    })
}

/// One spawn cycle for an ssh agent. Reuses a cached
/// `PreparedSshAgent` when the one-time prepare already succeeded;
/// otherwise runs `prepare_ssh_agent` and caches the result so later
/// cycles skip the prepare. A failed prepare leaves the cache empty so
/// the next cycle retries it.
async fn ssh_spawn_once(
    cached: std::sync::Arc<tokio::sync::Mutex<Option<crate::ssh::PreparedSshAgent>>>,
    config: std::sync::Arc<crate::ssh::SshAgentConfig>,
    redoor_port: u16,
    agent_token: String,
) -> Result<Child, String> {
    let prepared = {
        let mut guard = cached.lock().await;
        if let Some(p) = guard.as_ref() {
            p.clone()
        } else {
            match crate::ssh::prepare_ssh_agent(&config, redoor_port, &agent_token).await {
                Ok(p) => {
                    *guard = Some(p.clone());
                    p
                }
                Err(error) => {
                    log!(
                        Level::Warning,
                        "ssh prepare failed, will retry next cycle: {}",
                        error
                    );
                    return Err(error.to_string());
                }
            }
        }
    };
    prepared.spawn().await.map_err(|e| e.to_string())
}
