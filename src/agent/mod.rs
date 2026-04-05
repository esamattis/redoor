mod actor;
mod copy;
mod download;
mod messages;
mod state;
mod upload;
mod ws;

use clap::Args;
use ractor::Actor;
use redoor::{Level, log, types::AgentId};

pub(crate) use messages::AgentMsg;
pub(crate) use state::{
    ActiveDownloads, ActiveUploads, AgentState, DownloadSessionHandle, UploadSessionHandle,
};

pub(crate) struct AgentActor;

#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct AgentArgs {
    pub(crate) ws_address: String,
    #[arg(long)]
    pub(crate) name: String,
    #[arg(long)]
    pub(crate) log: Option<String>,
}

pub(crate) async fn run(args: AgentArgs) -> Result<(), Box<dyn std::error::Error>> {
    let server_url = args.ws_address;
    let agent_name = args.name;
    let log_file = args.log;

    let agent_id = AgentId::from(agent_name.clone());

    redoor::logging::init(log_file);
    log!(Level::Info, "Starting agent '{}'", agent_name);

    let (_, agent_handle) =
        AgentActor::spawn(None, AgentActor, (agent_id, agent_name, server_url)).await?;

    agent_handle.await?;

    Ok(())
}
