mod actor;
mod messages;
mod protocol;
mod raw;
pub(crate) mod state;
mod transfers;
mod ws;

use ractor::Actor;
use redoor::{Level, log, types::AgentId};

pub(crate) use messages::AgentMsg;
pub(crate) use state::{
    ActiveDownloads, ActiveUploads, AgentArgs, AgentState, DownloadSessionHandle,
    UploadSessionHandle,
};

pub(crate) struct AgentActor;

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
