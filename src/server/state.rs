use clap::Args;
use redoor::actors;
use redoor::watchdog::WatchdogRegistry;

#[derive(Clone)]
pub(crate) struct ServerState {
    pub(crate) router_ref: actors::router::RouterHandle,
    /// Shared registry of agent supervisors. The WebSocket session uses
    /// this to look up the supervisor for the agent it just registered
    /// and signal it when the connection goes stale.
    pub(crate) watchdog_registry: WatchdogRegistry,
}

impl ServerState {
    pub(crate) fn new(
        router_ref: actors::router::RouterHandle,
        watchdog_registry: WatchdogRegistry,
    ) -> Self {
        Self {
            router_ref,
            watchdog_registry,
        }
    }
}

/// Arguments for `redoor server`.
///
/// All server-level fields are `Option` so `run_server` can tell whether the
/// operator passed them explicitly on the command line and apply the
/// CLI > config file > env > default precedence. The `env` attribute is
/// intentionally NOT used on `port`: clap would populate the field from
/// `REDOOR_PORT` before we see it, which would make env beat the config file
/// — the opposite of the desired precedence. Env is read manually in
/// `run_server` as the third-tier fallback.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct CoordinatorArgs {
    /// Port to listen on. Overrides [server] port in the config file and the
    /// REDOOR_PORT env var. Defaults to 3000 when not set anywhere.
    #[arg(long)]
    pub(crate) port: Option<u16>,
    /// Address to bind the HTTP listener on (e.g. "127.0.0.1" for
    /// localhost-only). Overrides [server] bind in the config file. Defaults
    /// to 0.0.0.0 when not set anywhere.
    #[arg(long)]
    pub(crate) bind: Option<String>,
    /// Server log file path. Overrides [server] log in the config file.
    /// When not set, logging goes to stderr.
    #[arg(long)]
    pub(crate) log: Option<String>,
    /// Path to a TOML config file with an optional `[server]` table and a
    /// required `[[agents]]` array. Each `[[agents]]` entry is either an
    /// ssh-backed agent (with a `target` host) that connects back to this
    /// server through a reverse tunnel, or a local agent (with `local = true`)
    /// that the server launches as a plain `redoor agent` child process.
    /// Mixing both in the same file is supported, so a single server process
    /// can bring up an entire fleet — remote hosts and a local agent —
    /// without separate `redoor ssh` / `redoor agent` invocations per host.
    #[arg(long)]
    pub(crate) config: Option<String>,
}
