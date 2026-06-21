//! Server-side glue between the generic [`crate::watchdog`] supervisor
//! and the configured [`AgentConfig`] entries.
//!
//! Each agent config gets one supervisor task. The supervisor uses a
//! closure that knows how to spawn that specific agent's subprocess
//! (local `redoor agent` or `ssh` wrapping a remote one). The closure
//! is re-invoked on every restart cycle, so it must be safe to call
//! repeatedly.

use std::sync::Arc;

use anyhow::Result;
use redoor::watchdog::{SpawnFn, WatchdogRegistry, spawn_supervisor};
use redoor::{Level, log};

use super::config::{AgentConfig, LocalAgentConfig, default_local_agent_name, spawn_local_agent};

/// Spawns one watchdog supervisor per agent config and returns
/// immediately. The supervisor lives for the lifetime of the server
/// and keeps restarting its subprocess forever.
///
/// Returns an error if any agent key is already registered (typically
/// two `[[agents]]` entries sharing the same effective name, e.g.
/// when a local default collides with an explicit `name` on another
/// entry). The first duplicate stops the spawn loop and the caller
/// should surface the error to the operator.
pub(crate) fn spawn_agents(
    configs: &[AgentConfig],
    redoor_port: u16,
    registry: &WatchdogRegistry,
) -> Result<()> {
    log!(
        Level::Info,
        "Starting {} agent supervisor(s) from config",
        configs.len()
    );
    for config in configs.iter().cloned() {
        let key = supervisor_key(&config);
        let spawn = make_spawn_fn(config, redoor_port);
        spawn_supervisor(key, spawn, registry)?;
    }
    Ok(())
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

/// Build a spawn closure for an ssh agent. The first invocation runs the
/// one-time prepare (sniff + download + upload) and caches the
/// `PreparedSshAgent` for subsequent calls. Re-invocations on later
/// restart cycles skip the prepare and just spawn a fresh ssh child.
/// If the prepare fails (e.g. transient network blip), the cache stays
/// empty and the next cycle retries the prepare; a successful prepare
/// then switches the closure to the cached fast path. A spawn failure
/// after a successful prepare goes through the supervisor's normal
/// backoff loop without re-running the prepare.
fn ssh_spawn_fn(config: crate::ssh::SshAgentConfig, redoor_port: u16) -> SpawnFn {
    use tokio::sync::Mutex;

    // Cached `PreparedSshAgent`. `None` means "not yet prepared or the
    // last prepare failed"; the closure retries `prepare_ssh_agent` and
    // stores the result on success. The supervisor calls the spawn
    // closure serially (one cycle at a time) so contention on this lock
    // is limited to the prepare call itself.
    let cached: Arc<Mutex<Option<crate::ssh::PreparedSshAgent>>> = Arc::new(Mutex::new(None));
    let config = Arc::new(config);

    Arc::new(move || {
        let cached = cached.clone();
        let config = config.clone();
        let redoor_port = redoor_port;
        Box::pin(async move {
            let prepared = {
                let mut guard = cached.lock().await;
                if let Some(p) = guard.as_ref() {
                    p.clone()
                } else {
                    match crate::ssh::prepare_ssh_agent(&config, redoor_port).await {
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
        })
    })
}
