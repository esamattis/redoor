//! Server-side glue between the generic [`crate::watchdog`] supervisor
//! and the configured [`AgentConfig`] entries.
//!
//! Each agent config gets one supervisor task. The supervisor uses a
//! closure that knows how to spawn that specific agent's subprocess
//! (local `redoor agent` or `ssh` wrapping a remote one). The closure
//! is re-invoked on every restart cycle, so it must be safe to call
//! repeatedly.

use std::sync::Arc;

use redoor::watchdog::{SpawnFn, WatchdogRegistry, spawn_supervisor};
use redoor::{Level, log};

use super::config::{AgentConfig, LocalAgentConfig, default_local_agent_name, spawn_local_agent};

/// Spawns one watchdog supervisor per agent config and returns
/// immediately. The supervisor lives for the lifetime of the server
/// and keeps restarting its subprocess forever.
pub(crate) fn spawn_agents(configs: &[AgentConfig], redoor_port: u16, registry: &WatchdogRegistry) {
    log!(
        Level::Info,
        "Starting {} agent supervisor(s) from config",
        configs.len()
    );
    for config in configs.iter().cloned() {
        let key = supervisor_key(&config);
        let spawn = make_spawn_fn(config, redoor_port);
        spawn_supervisor(key, spawn, registry);
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
/// repeatedly. Ssh closures re-run the one-time prepare step on
/// each call; the prepare is cheap when the remote binary is
/// already in place, and a failure here puts the supervisor into
/// the backoff loop where the next cycle retries.
fn make_spawn_fn(config: AgentConfig, redoor_port: u16) -> SpawnFn {
    match config {
        AgentConfig::Local(c) => local_spawn_fn(c, redoor_port),
        AgentConfig::Ssh(c) => ssh_spawn_fn(c, redoor_port),
    }
}

/// Build a spawn closure for a local agent. Re-invoking just spawns
/// a fresh `redoor agent` child each time; the supervisor's restart
/// loop handles the rest.
fn local_spawn_fn(config: LocalAgentConfig, redoor_port: u16) -> SpawnFn {
    Arc::new(move || {
        let config = config.clone();
        let redoor_port = redoor_port;
        Box::pin(async move {
            spawn_local_agent(&config, redoor_port)
                .await
                .map_err(|e| e.to_string())
        })
    })
}

/// Build a spawn closure for an ssh agent. Re-invoking re-runs the
/// one-time prepare (sniff + download + upload) and then spawns a
/// fresh ssh child. The prepare is a single ssh round-trip when the
/// binary is already on the remote host, so re-running it on every
/// restart stays cheap. A failure puts the supervisor in backoff.
fn ssh_spawn_fn(config: crate::ssh::SshAgentConfig, redoor_port: u16) -> SpawnFn {
    Arc::new(move || {
        let config = config.clone();
        let redoor_port = redoor_port;
        Box::pin(async move {
            let prepared = crate::ssh::prepare_ssh_agent(&config, redoor_port)
                .await
                .map_err(|e| e.to_string())?;
            prepared.spawn().await.map_err(|e| e.to_string())
        })
    })
}
