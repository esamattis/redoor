use clap::Parser;
use ractor::ActorRef;
use redoor::actors;

#[derive(Clone)]
pub(crate) struct ServerState {
    pub(crate) router_ref: ActorRef<actors::router::RouterMsg>,
}

impl ServerState {
    pub(crate) fn new(router_ref: ActorRef<actors::router::RouterMsg>) -> Self {
        Self { router_ref }
    }
}

#[derive(Parser)]
#[command(author, version, about)]
pub(crate) struct CoordinatorArgs {
    #[arg(long, env = "REDOOR_PORT", default_value_t = 3000)]
    pub(crate) port: u16,
    #[arg(long)]
    pub(crate) log: Option<String>,
}
