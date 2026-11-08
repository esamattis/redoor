//! Remote CLI commands authenticate with an access token for device inventory, transfers,
//! execution, and agent lifecycle control.

mod archive;
pub mod client;
mod copy;
pub mod credentials;
mod examples;
mod exec;
mod lifecycle;
mod login;
mod ls;
mod mkdir;
mod mv;
mod progress;
mod rm;
mod search;
mod status;

use anyhow::Result;
use clap::{Args, Subcommand};
use redoor_protocol::api::agents::AgentListResponse;

use client::RemoteClient;
use credentials::CredentialStore;

/// Keeps remote utilities separate from server/agent process management.
#[derive(Args)]
#[command(after_help = examples::REMOTE)]
pub struct RemoteArgs {
    #[command(subcommand)]
    command: RemoteCommand,
}

/// Every command except `login` and `create-token` uses the saved access token or the
/// `REDOOR_REMOTE_SERVER`/`REDOOR_REMOTE_TOKEN` environment override.
#[derive(Subcommand)]
enum RemoteCommand {
    /// Start a server-managed agent, including SSH agents, without waiting for connection.
    #[command(after_help = examples::START)]
    Start(lifecycle::LifecycleArgs),
    /// Stop a server-managed agent and wait for shutdown cleanup.
    #[command(after_help = examples::STOP)]
    Stop(lifecycle::LifecycleArgs),
    /// Execute argv without a shell, streaming output until the remote process exits.
    #[command(after_help = examples::EXEC)]
    Exec(exec::ExecArgs),
    /// Stream files or recursively copy directories between local and device paths.
    #[command(after_help = examples::CP)]
    Cp(copy::CopyArgs),
    /// List a remote directory (or describe a file).
    #[command(after_help = examples::LS)]
    Ls(ls::PathArgs),
    /// Show a remote path's metadata.
    #[command(after_help = examples::STAT)]
    Stat(ls::PathArgs),
    /// Create a remote directory.
    #[command(after_help = examples::MKDIR)]
    Mkdir(mkdir::MkdirArgs),
    /// Move a remote path to the trash, or delete it permanently.
    #[command(after_help = examples::RM)]
    Rm(rm::RmArgs),
    /// Move or rename a path on one device or between devices.
    #[command(after_help = examples::MV)]
    Mv(mv::MvArgs),
    /// Find files and directories by name below a remote directory.
    #[command(after_help = examples::FIND)]
    Find(search::FindArgs),
    /// Search file contents below a remote directory.
    #[command(after_help = examples::GREP)]
    Grep(search::GrepArgs),
    /// Log in through the browser and save an access token.
    ///
    /// Prints a URL and a code. Open the URL in a browser that is signed in to the server,
    /// enter the code, adjust the token and approve it after signing in again; the command
    /// continues by itself. Scripts cannot create tokens on their own: a person approves each
    /// one in the browser.
    #[command(after_help = examples::LOGIN)]
    Login(login::TokenRequestArgs),
    /// Revoke the saved token on the server and remove it locally.
    #[command(after_help = examples::LOGOUT)]
    Logout,
    /// Show the server, token and permissions in use.
    #[command(after_help = examples::STATUS)]
    Status {
        /// Print the token metadata as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Like login, but print the new token as JSON (for MCP clients) instead of saving it.
    ///
    /// The token is approved in the browser like with `login`, so a person approves each one.
    #[command(name = "create-token", after_help = examples::CREATE_TOKEN)]
    CreateToken(login::TokenRequestArgs),
    /// List device IDs, names, and connection status.
    #[command(name = "devices", after_help = examples::DEVICES)]
    Agents {
        /// Print the complete agent-list API response for scripts.
        #[arg(long)]
        json: bool,
    },
}

/// Dispatches without mixing status messages into machine-readable stdout.
pub async fn run(args: RemoteArgs, store: CredentialStore) -> Result<i32> {
    match args.command {
        RemoteCommand::Start(args) => lifecycle::run(store, args, true).await?,
        RemoteCommand::Stop(args) => lifecycle::run(store, args, false).await?,
        RemoteCommand::Exec(args) => return Ok(exec::run(store, args).await),
        RemoteCommand::Cp(args) => copy::run(store, args).await?,
        RemoteCommand::Ls(args) => ls::ls(store, args).await?,
        RemoteCommand::Stat(args) => ls::stat(store, args).await?,
        RemoteCommand::Mkdir(args) => mkdir::run(store, args).await?,
        RemoteCommand::Rm(args) => rm::run(store, args).await?,
        RemoteCommand::Mv(args) => mv::run(store, args).await?,
        RemoteCommand::Find(args) => search::find(store, args).await?,
        RemoteCommand::Grep(args) => search::grep(store, args).await?,
        RemoteCommand::Login(args) => login::login(store, args).await?,
        RemoteCommand::CreateToken(args) => login::create_token(args).await?,
        RemoteCommand::Logout => status::logout(store).await?,
        RemoteCommand::Status { json } => status::status(store, json).await?,
        RemoteCommand::Agents { json } => {
            let agents: AgentListResponse = RemoteClient::load(&store)
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
        return Ok("No devices available.".to_owned());
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
