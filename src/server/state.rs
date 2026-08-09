use std::path::PathBuf;
use std::sync::Arc;

use clap::Args;
use redoor::actors;
use redoor::commands::ServerAuthMode;
use redoor::log_registry::LogRegistry;
use redoor::one_time_token_registry::OneTimeTokenRegistry;
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
    /// Keeps download credentials process-local and atomically single-use.
    pub(crate) one_time_token_registry: OneTimeTokenRegistry,
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
        one_time_token_registry: OneTimeTokenRegistry,
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
            one_time_token_registry,
            auth,
            config_path,
            auth_mode,
            shutdown_tx,
        }
    }
}

/// Arguments for `redoor server`.
///
/// All server-level fields are `Option` so `run_server` can apply
/// CLI > env > config file > default. Clap `env` fills each field when the
/// flag is omitted, so resolution is simply `args.or(config).or(default)`.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct CoordinatorArgs {
    /// Port to listen on. Overrides `REDOOR_PORT` and `[server].port`.
    /// Defaults to 3000 when not set anywhere.
    #[arg(long, env = "REDOOR_PORT")]
    pub(crate) port: Option<u16>,
    /// Address to bind the HTTP listener on (e.g. "0.0.0.0" to expose
    /// beyond localhost). Overrides `[server].bind`. Defaults to 127.0.0.1
    /// when not set anywhere.
    #[arg(long)]
    pub(crate) bind: Option<String>,
    /// Server log file path. Overrides `[server].log`. When not set, logging
    /// goes to stderr.
    #[arg(long, env = "REDOOR_SERVER_LOG")]
    pub(crate) log: Option<String>,
    /// Path to the TOML config file. When omitted, Redoor loads or creates
    /// `/etc/redoor/config.toml` as root, otherwise `~/.config/redoor/config.toml`.
    /// Top-level `agent_token` is required; `[server]` holds listener/auth
    /// settings (browser `username`/`password` may be omitted together on Linux
    /// for PAM). Optional `[[agents]]` entries are either ssh-backed (`target`)
    /// or local (`local = true`) and start lazily from the UI or management API.
    #[arg(long)]
    pub(crate) config: Option<String>,
}
