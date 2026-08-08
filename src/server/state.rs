use std::path::PathBuf;
use std::sync::Arc;

use clap::Args;
use redoor::actors;
use redoor::commands::ServerAuthMode;
use redoor::log_registry::LogRegistry;
use redoor::terminal_registry::TerminalRegistry;
use redoor::watchdog::WatchdogRegistry;

use super::auth::AuthState;

#[derive(Clone)]
pub(crate) struct ServerState {
    pub(crate) router_ref: actors::router::RouterHandle,
    /// Shared registry of agent supervisors. The WebSocket session uses
    /// this to look up the supervisor for the agent it just registered
    /// and signal it when the connection goes stale.
    pub(crate) watchdog_registry: WatchdogRegistry,
    /// Pairs short-lived browser and dedicated agent terminal connections.
    pub(crate) terminal_registry: TerminalRegistry,
    /// Pairs short-lived browser and dedicated agent log connections.
    pub(crate) log_registry: LogRegistry,
    /// Validates opaque cookies against durable, server-side session files.
    pub(crate) auth: AuthState,
    /// Absolute path of the TOML config loaded at process start (for the server
    /// home UI and so reload can re-validate the same file).
    pub(crate) config_path: PathBuf,
    /// Login backend resolved from the TOML credentials (or their absence).
    pub(crate) auth_mode: ServerAuthMode,
    /// Signals axum graceful shutdown; reload fires this after a successful
    /// pre-validation so the listener is dropped before exec.
    pub(crate) shutdown_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}

impl ServerState {
    pub(crate) fn new(
        router_ref: actors::router::RouterHandle,
        watchdog_registry: WatchdogRegistry,
        terminal_registry: TerminalRegistry,
        log_registry: LogRegistry,
        auth: AuthState,
        config_path: PathBuf,
        auth_mode: ServerAuthMode,
        shutdown_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    ) -> Self {
        Self {
            router_ref,
            watchdog_registry,
            terminal_registry,
            log_registry,
            auth,
            config_path,
            auth_mode,
            shutdown_tx,
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
    /// Address to bind the HTTP listener on (e.g. "0.0.0.0" to expose
    /// beyond localhost). Overrides [server] bind in the config file. Defaults
    /// to 127.0.0.1 when not set anywhere.
    #[arg(long)]
    pub(crate) bind: Option<String>,
    /// Server log file path. Overrides [server] log in the config file.
    /// When not set, logging goes to stderr.
    #[arg(long)]
    pub(crate) log: Option<String>,
    /// Path to the TOML config file. When omitted, Redoor loads or creates
    /// `~/.config/redoor/config.toml`. Its `[server]` table requires
    /// `agent_token`; browser `username`/`password` may be omitted together on
    /// Linux to use PAM system-account login. Each optional `[[agents]]` entry
    /// is either an ssh-backed agent (with a `target` host) that connects back
    /// to this server through a reverse tunnel, or a local agent (with
    /// `local = true`) that the server can launch as a plain `redoor agent` child
    /// process. Entries are registered as stopped and start lazily from the UI
    /// or management API, so configuration does not eagerly launch a fleet.
    #[arg(long)]
    pub(crate) config: Option<String>,
}
