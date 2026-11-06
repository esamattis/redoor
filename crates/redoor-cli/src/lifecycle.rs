//! Uses the server's managed supervisor so intentional stops disable automatic reconnects.

use anyhow::{Context, Result};
use clap::Args;
use redoor_protocol::api::agents::{
    AgentConnectionStatus, AgentInfoResponse, AgentListResponse, ShutdownAgentResponse,
    StartAgentResponse,
};
use reqwest::Method;

use super::{
    client::{RemoteApiError, RemoteClient},
    credentials::CredentialStore,
};

impl RemoteClient {
    /// Starts only managed inventory entries and keeps command payloads out of a pending startup.
    pub async fn ensure_agent_running(&self, agent: &str) -> Result<()> {
        let snapshot = self.agent_snapshot(agent).await?;
        if !snapshot.managed || snapshot.status == AgentConnectionStatus::Connected {
            return Ok(());
        }
        let label = agent.escape_debug().to_string();
        eprintln!("Agent {label} is not running; waiting for managed startup");
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            self.wait_for_agent(snapshot),
        )
        .await
        .map_err(|_| {
            anyhow::anyhow!("Timed out after 300 seconds waiting for agent {label} to connect")
        })
        .and_then(|result| result);
        // JSON commands retain their existing stdout error contract while startup failures stay visible.
        if let Err(error) = &result {
            eprintln!("Failed to start agent {label}: {error:#}");
        }
        result
    }

    /// Inventory is available even for dormant agents, unlike the live agent-details endpoint.
    ///
    /// Accepts a name or an id like the server: an exact id wins, otherwise the name. An
    /// unknown value lists the available devices, because a renamed device is the usual cause.
    pub(crate) async fn agent_snapshot(&self, agent: &str) -> Result<AgentInfoResponse> {
        let inventory: AgentListResponse = self.get_json("api/v1/agents").await?;
        let by_id = inventory
            .agents
            .iter()
            .position(|entry| entry.id.as_str() == agent);
        let index = by_id.or_else(|| {
            inventory
                .agents
                .iter()
                .position(|entry| entry.name == agent)
        });
        match index {
            Some(index) => Ok(inventory
                .agents
                .into_iter()
                .nth(index)
                .context("unreachable")?),
            None => anyhow::bail!("{}", device_not_found(agent, &inventory)),
        }
    }

    /// Polls bounded control requests so SSH provisioning progress can be reported before execution.
    async fn wait_for_agent(&self, mut snapshot: AgentInfoResponse) -> Result<()> {
        // Requests use the id so a rename during startup cannot switch devices; messages use
        // the name people typed.
        let agent = snapshot.id.to_string();
        let label = snapshot.name.escape_debug().to_string();
        if snapshot.status != AgentConnectionStatus::Starting {
            eprintln!("Starting agent {label}");
            let mut url = self.endpoint("api/v1/agents/")?;
            url.path_segments_mut()
                .map_err(|_| anyhow::anyhow!("Invalid server URL"))?
                .pop_if_empty()
                .push(&agent)
                .push("start");
            let response = self
                .send(
                    self.request(Method::POST, url.as_str())?
                        .timeout(std::time::Duration::from_secs(30)),
                )
                .await
                .map_err(|error| {
                    // Auto-start is a convenience; without the permission, say how to proceed.
                    if error
                        .downcast_ref::<RemoteApiError>()
                        .is_some_and(|error| error.status == reqwest::StatusCode::FORBIDDEN)
                    {
                        anyhow::anyhow!(
                            "Device {label} is not running and this token lacks agents:manage; start it from the UI or log in with agents:manage"
                        )
                    } else {
                        error
                    }
                })?;
            let response: StartAgentResponse = serde_json::from_slice(&response.bytes().await?)
                .context("Invalid remote start response")?;
            snapshot = response.agent;
        }
        let mut reported = std::collections::HashSet::new();
        let mut previous_status = None;
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(200));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if previous_status.as_ref() != Some(&snapshot.status) {
                let status = serde_json::to_value(&snapshot.status)?;
                eprintln!("Device {label}: {}", status.as_str().unwrap_or("unknown"));
                previous_status = Some(snapshot.status.clone());
            }
            for step in &snapshot.provisioning_status {
                if reported.insert((step.at, step.message.clone())) {
                    eprintln!("Agent {label}: {}", step.message.escape_debug());
                }
            }
            if snapshot.status == AgentConnectionStatus::Connected {
                return Ok(());
            }
            if let Some(issue) = snapshot.connection_issue {
                // A failed attempt's steps move to `last_failed_attempt`, so the ones it
                // reported since the last poll are only there.
                for step in snapshot
                    .last_failed_attempt
                    .iter()
                    .flat_map(|attempt| &attempt.messages)
                {
                    if reported.insert((step.at, step.message.clone())) {
                        eprintln!("Agent {label}: {}", step.message.escape_debug());
                    }
                }
                anyhow::bail!("{}", issue.escape_debug());
            }
            anyhow::ensure!(snapshot.managed, "Agent {label} is no longer managed");
            anyhow::ensure!(
                snapshot.status != AgentConnectionStatus::Stopped,
                "Agent {label} was stopped during startup"
            );
            interval.tick().await;
            snapshot = self.agent_snapshot(&agent).await?;
        }
    }
}

/// Explains an unknown device value with the names and ids the caller can use instead.
fn device_not_found(agent: &str, inventory: &AgentListResponse) -> String {
    // Escape control characters so remote names cannot manipulate the local terminal.
    let devices = inventory
        .agents
        .iter()
        .map(|entry| {
            format!(
                "  {} ({})",
                entry.name.escape_debug(),
                entry.id.as_str().escape_debug()
            )
        })
        .collect::<Vec<_>>();
    if devices.is_empty() {
        return format!(
            "Device not found: {}. No devices are available.",
            agent.escape_debug()
        );
    }
    format!(
        "Device not found: {}. Available devices:
{}",
        agent.escape_debug(),
        devices.join(
            "
"
        )
    )
}

/// Selects an inventory ID rather than requiring a live SSH or WebSocket connection.
#[derive(Args)]
pub(super) struct LifecycleArgs {
    /// Device ID from `redoor remote devices`; starts or stops its Redoor agent.
    #[arg(value_name = "DEVICE")]
    agent: String,
    /// Print the complete lifecycle API response for scripts.
    #[arg(long)]
    json: bool,
}

/// Reports the accepted snapshot without mistaking an asynchronous start for a connection.
pub(super) async fn run(store: CredentialStore, args: LifecycleArgs, start: bool) -> Result<()> {
    let client = RemoteClient::load(&store).await?;
    let mut url = client.endpoint("api/v1/agents/")?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid server URL"))?
        .pop_if_empty()
        .push(&args.agent)
        .push(if start { "start" } else { "shutdown" });
    let response = client
        .send(
            client
                .request(Method::POST, url.as_str())?
                .timeout(std::time::Duration::from_secs(30)),
        )
        .await?;
    let bytes = response.bytes().await?;
    let (agent, json) = if start {
        let response: StartAgentResponse =
            serde_json::from_slice(&bytes).context("Invalid remote start response")?;
        let json = serde_json::to_string_pretty(&response)?;
        (response.agent, json)
    } else {
        let response: ShutdownAgentResponse =
            serde_json::from_slice(&bytes).context("Invalid remote stop response")?;
        let json = serde_json::to_string_pretty(&response)?;
        (response.agent, json)
    };
    if args.json {
        println!("{json}");
    } else {
        let status = serde_json::to_value(agent.status)?;
        println!(
            "{}: {}",
            agent.id.to_string().escape_debug(),
            status.as_str().unwrap_or("unknown")
        );
    }
    Ok(())
}
