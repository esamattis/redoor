//! Shared handler state and server CLI arguments.

use std::path::PathBuf;
use std::sync::Arc;

use crate::actors;
use crate::one_time_token_registry::OneTimeTokenRegistry;
use crate::watchdog::WatchdogRegistry;
use clap::Args;
use redoor_core::logging::LogFormat;
use redoor_protocol::api::server::ServerAuthMode;
use redoor_protocol::wire::log::Level;

use super::auth::AuthState;
use super::mcp::McpState;
use super::tokens::TokenStore;

/// Everything handlers need, cloned cheaply per request because every member is a handle.
#[derive(Clone)]
pub(crate) struct ServerState {
    /// Namespace, data directories and websocket timings chosen at process start.
    pub(crate) runtime: redoor_core::runtime::RuntimeContext,
    /// Release cache shared by agent upgrades and SSH provisioning.
    pub(crate) binaries: crate::binaries::BinaryCache,
    /// Registers managed supervisors for startup inventory and configuration routes alike.
    pub(crate) launcher: super::watchdog::ManagedLauncher,
    pub(crate) router_ref: actors::router::RouterHandle,
    /// Typed one-shot agent commands with their deadlines and cancel-on-abandon behavior.
    pub(crate) agents: super::agent_client::AgentClient,
    /// Starts copies and moves for REST and MCP alike.
    pub(crate) transfers: super::services::transfer::TransferService,
    /// Shared registry of agent supervisors. The WebSocket session uses
    /// this to look up the supervisor for the agent it just registered
    /// and signal it when the connection goes stale.
    pub(crate) watchdog_registry: WatchdogRegistry,
    /// Keeps download credentials process-local and atomically single-use.
    pub(crate) one_time_token_registry: OneTimeTokenRegistry,
    /// Correlates client-owned upload requests while their destination workers are still active.
    pub(crate) upload_requests: super::upload_requests::UploadRequests,
    /// Recent agents refused for speaking another protocol version, shown in the UI.
    pub(crate) protocol_mismatches: crate::protocol_mismatches::ProtocolMismatches,
    /// Validates opaque cookies against durable, server-side session files.
    pub(crate) auth: AuthState,
    /// OpenID Connect sign-in, present only when `[server.oidc]` is configured.
    pub(crate) oidc: Option<Arc<super::oidc::OidcClient>>,
    /// The server-owned access token table used by REST and MCP authentication.
    pub(crate) tokens: TokenStore,
    /// Enforces MCP-specific origin, rate, and concurrency policy outside browser auth.
    pub(crate) mcp: McpState,
    /// Absolute path of the TOML config loaded at process start (for the server
    /// home UI and so restart can re-validate the same file).
    pub(crate) config_path: PathBuf,
    /// Serializes read-modify-write config edits so concurrent submissions cannot lose entries.
    pub(crate) config_edit_lock: Arc<tokio::sync::Mutex<()>>,
    /// Serializes editor buffer writes so a revision check and its write cannot interleave.
    pub(crate) editor_buffer_lock: Arc<tokio::sync::Mutex<()>>,
    /// The login account's vault (`vault.json`), which encrypts `.redoorencrypted` files.
    pub(crate) vault: crate::vault::VaultStore,
    /// Managed SSH keys and pinned host keys of SSH devices, per account.
    pub(crate) ssh_keys: crate::ssh::keys::SshKeyStore,
    /// Decrypted SSH keys of running devices, shared with the launcher's provisioning.
    pub(crate) held_ssh_keys: crate::ssh::held_keys::HeldSshKeys,
    /// Devices with a key operation or edit in progress, so they cannot race each other.
    pub(crate) ssh_key_operations: super::ssh_keys::SshKeyOperations,
    /// Login backend resolved from the TOML credentials (or their absence).
    pub(crate) auth_mode: ServerAuthMode,
    /// Signals axum graceful shutdown; restart fires this after a successful
    /// pre-validation so the listener is dropped before exec.
    pub(crate) shutdown_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Held while `redoor upgrade` installs, so two installs never race over the binary.
    pub(crate) upgrade_lock: Arc<tokio::sync::Mutex<()>>,
}

/// Arguments for `redoor server`.
///
/// All server-level fields are `Option` so `run_server` can apply
/// CLI > env > config file > default. Clap `env` fills each field when the
/// flag is omitted, so resolution is simply `args.or(config).or(default)`.
#[derive(Args)]
#[command(author, version, about)]
pub struct CoordinatorArgs {
    /// Detach the server from the terminal and continue running in the background.
    #[arg(long)]
    pub daemon: bool,
    /// Port to listen on. Overrides `REDOOR_PORT` and `[server].port`.
    /// Defaults to 7666 when not set anywhere.
    #[arg(long, env = "REDOOR_PORT")]
    pub(crate) port: Option<u16>,
    /// Address to bind the HTTP listener on (e.g. "0.0.0.0" to expose
    /// beyond localhost). Overrides `[server].bind`. Defaults to 127.0.0.1
    /// when not set anywhere.
    #[arg(long)]
    pub(crate) bind: Option<String>,
    /// Server log file path. Overrides `[server].log`. Defaults to
    /// `~/.local/share/<app-name>/server.log` for non-root users.
    #[arg(long, env = "REDOOR_SERVER_LOG")]
    pub(crate) log: Option<String>,
    /// Initial threshold. CLI overrides role environment, TOML, and the info default.
    #[arg(long = "log-level")]
    pub(crate) log_level: Option<Level>,
    /// Process output format. CLI overrides role environment, TOML, and line.
    #[arg(long = "log-format")]
    pub(crate) log_format: Option<LogFormat>,
    /// Path to the TOML config file. When omitted, Redoor loads or creates
    /// `/etc/<app-name>/config.toml` as root, otherwise `~/.config/<app-name>/config.toml`.
    /// Top-level `agent_token` is required; `[server]` holds listener/auth
    /// settings (browser `username`/`password` may be omitted together on Linux
    /// for PAM). Optional `[[agents]]` entries are either SSH-backed (`target`)
    /// or local (`local = true`) and start lazily from the UI or management API.
    #[arg(long)]
    pub(crate) config: Option<String>,
}
