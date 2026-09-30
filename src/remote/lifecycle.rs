//! Uses the server's managed supervisor so intentional stops disable automatic reconnects.

use anyhow::{Context, Result};
use clap::Args;
use redoor::commands::{ShutdownAgentResponse, StartAgentResponse};
use reqwest::Method;

use super::{client::RemoteClient, session::SessionStore};

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
