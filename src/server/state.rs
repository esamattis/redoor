use clap::Args;
use redoor::actors;

#[derive(Clone)]
pub(crate) struct ServerState {
    pub(crate) router_ref: actors::router::RouterHandle,
}

impl ServerState {
    pub(crate) fn new(router_ref: actors::router::RouterHandle) -> Self {
        Self { router_ref }
    }
}

#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct CoordinatorArgs {
    #[arg(long, env = "REDOOR_PORT", default_value_t = 3000)]
    pub(crate) port: u16,
    #[arg(long)]
    pub(crate) log: Option<String>,
    /// Path to a toml file listing agents to start automatically with the
    /// server. Each `[[agents]]` entry is either an ssh-backed agent (with
    /// a `target` host) that connects back to this server through a reverse
    /// tunnel, or a local agent (with `local = true`) that the server
    /// launches as a plain `redoor agent` child process. Mixing both in the
    /// same file is supported, so a single server process can bring up an
    /// entire fleet — remote hosts and a local agent — without separate
    /// `redoor ssh` / `redoor agent` invocations per host.
    #[arg(long)]
    pub(crate) agents: Option<String>,
}
