//! Remote CLI commands share one durable authentication boundary for inventory, transfers and future execution.

mod archive;
pub mod client;
mod copy;
mod exec;
pub mod session;

use anyhow::Result;
use clap::{Args, Subcommand};
use redoor::commands::AgentListResponse;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use client::RemoteClient;
use session::SessionStore;

/// Keeps remote utilities separate from server/agent process management.
#[derive(Args)]
pub struct RemoteArgs {
    #[command(subcommand)]
    command: RemoteCommand,
}

/// Login-first operations reuse the server's existing cookie authentication APIs.
#[derive(Subcommand)]
enum RemoteCommand {
    /// Execute argv without a shell, streaming output until the remote process exits.
    Exec(exec::ExecArgs),
    /// Stream files or recursively copy directories between local and agent paths.
    Cp(copy::CopyArgs),
    /// Prompt for username/password and select a server for subsequent commands.
    Login { server_url: String },
    /// Invalidate the selected session remotely and remove local credentials.
    Logout,
    /// List agent IDs, names, and connection status.
    Agents {
        /// Print the complete agent-list API response for scripts.
        #[arg(long)]
        json: bool,
    },
}

/// Dispatches without mixing status messages into machine-readable stdout.
pub async fn run(args: RemoteArgs) -> Result<i32> {
    let store = SessionStore::for_current_namespace()?;
    match args.command {
        RemoteCommand::Exec(args) => return Ok(exec::run(store, args).await),
        RemoteCommand::Cp(args) => copy::run(store, args).await?,
        RemoteCommand::Login { server_url } => {
            RemoteClient::parse_server(&server_url)?;
            let mut stderr = tokio::io::stderr();
            stderr.write_all(b"Username: ").await?;
            stderr.flush().await?;
            let mut username = String::new();
            tokio::io::BufReader::new(tokio::io::stdin())
                .read_line(&mut username)
                .await?;
            // Terminal password input is necessarily blocking; keep it off async workers.
            let password =
                tokio::task::spawn_blocking(|| rpassword::prompt_password("Password: ")).await??;
            let login =
                RemoteClient::login(store, &server_url, username.trim().to_owned(), password)
                    .await?;
            eprintln!("Logged in as {}", login.username);
        }
        RemoteCommand::Logout => {
            RemoteClient::logout(store).await?;
            eprintln!("Logged out");
        }
        RemoteCommand::Agents { json } => {
            let agents: AgentListResponse = RemoteClient::load(store)
                .await?
                .get_json("api/v1/agents")
                .await?;
            println!("{}", format_agents(&agents, json)?);
        }
    }
    Ok(0)
}

/// Keeps IDs prominent and emits the complete API object in JSON, including a successful empty list.
fn format_agents(agents: &AgentListResponse, json: bool) -> Result<String> {
    if json {
        return Ok(serde_json::to_string_pretty(agents)?);
    }
    if agents.agents.is_empty() {
        return Ok("No agents available.".to_owned());
    }
    let mut rows = vec![("ID".to_owned(), "NAME".to_owned(), "STATUS".to_owned())];
    for agent in &agents.agents {
        let status = serde_json::to_value(&agent.status)?
            .as_str()
            .unwrap_or("unknown")
            .to_owned();
        // Escape control characters so remote names cannot manipulate the local terminal.
        rows.push((
            agent.id.to_string().escape_debug().to_string(),
            agent.name.escape_debug().to_string(),
            status,
        ));
    }
    let id_width = rows.iter().map(|row| row.0.len()).max().unwrap_or(2);
    let name_width = rows.iter().map(|row| row.1.len()).max().unwrap_or(4);
    Ok(rows
        .into_iter()
        .map(|(id, name, status)| format!("{id:<id_width$}  {name:<name_width$}  {status}"))
        .collect::<Vec<_>>()
        .join(
            "
",
        ))
}

#[cfg(test)]
mod tests;
