//! Uses the server's managed supervisor so intentional stops disable automatic reconnects.

use anyhow::{Context, Result};
use clap::Args;
use redoor::commands::{
    AgentConnectionStatus, AgentInfoResponse, AgentListResponse, ShutdownAgentResponse,
    StartAgentResponse,
};
use reqwest::Method;

use super::{client::RemoteClient, session::SessionStore};

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
    async fn agent_snapshot(&self, agent: &str) -> Result<AgentInfoResponse> {
        let inventory: AgentListResponse = self.get_json("api/v1/agents").await?;
        inventory
            .agents
            .into_iter()
            .find(|entry| entry.id.0 == agent)
            .with_context(|| format!("Agent not found: {}", agent.escape_debug()))
    }

    /// Polls bounded control requests so SSH provisioning progress can be reported before execution.
    async fn wait_for_agent(&self, mut snapshot: AgentInfoResponse) -> Result<()> {
        let agent = snapshot.id.to_string();
        let label = agent.escape_debug().to_string();
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
                .await?;
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
                eprintln!("Agent {label}: {}", status.as_str().unwrap_or("unknown"));
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

/// Selects an inventory ID rather than requiring a live SSH or WebSocket connection.
#[derive(Args)]
pub(super) struct LifecycleArgs {
    /// Agent ID from `redoor remote agents`.
    agent: String,
    /// Print the complete lifecycle API response for scripts.
    #[arg(long)]
    json: bool,
}

/// Reports the accepted snapshot without mistaking an asynchronous start for a connection.
pub(super) async fn run(store: SessionStore, args: LifecycleArgs, start: bool) -> Result<()> {
    let client = RemoteClient::load(store).await?;
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
