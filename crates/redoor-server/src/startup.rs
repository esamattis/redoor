//! Server process startup: resolves configuration, builds shared state, and serves HTTP.
//!
//! Split into three steps so each can be reasoned about (and tested) on its own:
//! [`ServerConfig::resolve`] is a pure precedence function (CLI > env > file > default),
//! [`ServerRuntime::build`] performs the fallible side effects (logging, credential
//! storage, actors, listener, managed inventory), and [`ServerRuntime::serve_until_restart`]
//! runs until the restart route or the `redoor upgrade` signal asks for a re-exec.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::actors::router::spawn_router;
use crate::http::auth::AuthState;
use crate::http::routes::build_app;
use crate::http::state::{CoordinatorArgs, ServerState};
use crate::http::watchdog::ManagedLauncher;
use crate::one_time_token_registry::OneTimeTokenRegistry;
use crate::watchdog::WatchdogRegistry;
use redoor_core::config::{AgentConfig, AuthMode, RedoorConfig};
use redoor_core::log;
use redoor_core::logging::LogFormat;
use redoor_core::paths::AppPaths;
use redoor_core::process::ProcessSlot;
use redoor_core::runtime::RuntimeContext;
use redoor_protocol::{api::server::ServerAuthMode, wire::log::Level};

/// Listener port used when neither CLI, env nor `[server].port` choose one.
const DEFAULT_PORT: u16 = 7666;
/// Listener address used when neither CLI nor `[server].bind` choose one.
const DEFAULT_BIND: &str = "127.0.0.1";
/// Role-specific environment variable for the initial log threshold.
const LOG_LEVEL_ENV: &str = "REDOOR_SERVER_LOG_LEVEL";
/// Role-specific environment variable for the process output format.
const LOG_FORMAT_ENV: &str = "REDOOR_SERVER_LOG_FORMAT";

/// Keeps processes of the same OS user from reading this process's memory.
///
/// The server holds vault file keys while a request decrypts, and local managed agents run
/// as the server's user, so without this an agent (or anything else running as that user)
/// could read keys from `/proc/<pid>/mem` or attach a debugger. Non-dumpable processes are
/// only accessible to root. Linux and Termux only: macOS's equivalent (`PT_DENY_ATTACH`)
/// also blocks crash reporting and is not used.
fn deny_same_user_memory_access() {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // SAFETY: PR_SET_DUMPABLE takes plain integer arguments and touches no memory.
        let result = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if result != 0 {
            redoor_core::log_failure!(
                redoor_protocol::wire::log::Level::Warning,
                "Failed to make the server non-dumpable: {}",
                std::io::Error::last_os_error()
            );
        }
    }
}

/// Starts the long-lived server using the established flat startup arguments.
///
/// Only returns on startup failure; a successful run ends in a re-exec of this binary so
/// a restart re-reads `config.toml` from scratch.
pub async fn run_server(args: CoordinatorArgs, runtime: RuntimeContext) -> Result<ExitCode> {
    deny_same_user_memory_access();
    let location = ConfigLocation::find_or_bootstrap(args.config.clone(), &runtime.paths).await?;
    // The server owns managed ids, so hand-written entries get theirs before anything uses them.
    let assigned = redoor_core::config::assign_missing_device_ids(
        &location.path,
        redoor_core::config::DeviceIdScope::ManagedAgents,
    )
    .await?;
    let file = redoor_core::config::parse_config_file(&location.path).await?;
    // Only the server registers managed agents, so only it rejects invalid or colliding names.
    file.validate_managed_agent_names(&location.path)?;
    let config = ServerConfig::resolve(
        &args,
        &ServerEnvironment::from_process(),
        file,
        location.path,
        &runtime.paths,
    )?;
    let server = ServerRuntime::build(config, runtime).await?;
    // Logged only now because the logger starts inside `build`.
    if assigned > 0 {
        log!(
            Level::Info,
            "Assigned device ids to {} [[agents]] entries and wrote them to the config file",
            assigned
        );
    }
    if location.created {
        server.open_first_run_login();
    }
    server.serve_until_restart().await?;
    // Only reached after restart. Replace this process with the same binary and
    // arguments so startup re-reads config.toml.
    redoor_core::process::reexec_current_process();
}

/// Where the server's TOML lives and whether this start created it.
struct ConfigLocation {
    /// Canonical path, also shown in the UI and re-validated before restarts.
    path: PathBuf,
    /// True on the first run that wrote the starter config (enables the browser demo).
    created: bool,
}

impl ConfigLocation {
    /// Uses `--config` as given, or bootstraps the conventional path on first run.
    ///
    /// Only this command bootstraps the conventional path so first-run secrets and the
    /// local agent entry appear from a single intentional entry point.
    async fn find_or_bootstrap(explicit: Option<String>, paths: &AppPaths) -> Result<Self> {
        let (path, created) = match explicit {
            Some(path) => (PathBuf::from(path), false),
            None => {
                let path = paths.default_config_path()?;
                let created = redoor_core::config::create_default_config_if_missing(&path)
                    .await
                    .with_context(|| {
                        format!("Failed to create default config '{}'", path.display())
                    })?;
                if let Some(created) = &created {
                    print_bootstrap_secrets(&path, created);
                }
                (path, created.is_some())
            }
        };
        let path = tokio::fs::canonicalize(&path)
            .await
            .with_context(|| format!("Failed to resolve config file '{}'", path.display()))?;
        Ok(Self { path, created })
    }
}

/// Shows the generated secrets exactly once; they are not logged or retrievable later.
fn print_bootstrap_secrets(
    path: &std::path::Path,
    created: &redoor_core::config::CreatedDefaultConfig,
) {
    match &created.password {
        Some(password) => eprintln!(
            "Created default config '{}'.
  username: redoor
  password: {password}
  agent_token: {}
Store these secrets securely; they will not be shown again.",
            path.display(),
            created.agent_token
        ),
        None => eprintln!(
            "Created default config '{}'.
  browser login: process owner's system username/password (PAM)
  agent_token: {}
Store the agent_token securely; it will not be shown again.",
            path.display(),
            created.agent_token
        ),
    }
}

/// Environment values the server reads itself (clap already merges `REDOOR_PORT` etc.).
///
/// Captured once so [`ServerConfig::resolve`] stays a pure function of its inputs.
#[derive(Default)]
struct ServerEnvironment {
    /// Raw `REDOOR_SERVER_LOG_LEVEL`.
    log_level: Option<String>,
    /// Raw `REDOOR_SERVER_LOG_FORMAT`.
    log_format: Option<String>,
}

impl ServerEnvironment {
    /// Reads the role-specific logging variables from the process environment.
    fn from_process() -> Self {
        Self {
            log_level: std::env::var(LOG_LEVEL_ENV).ok(),
            log_format: std::env::var(LOG_FORMAT_ENV).ok(),
        }
    }
}

/// Server settings after applying CLI > env > config file > default precedence.
struct ServerConfig {
    /// Canonical config path, shown in the UI and re-validated by the restart route.
    config_path: PathBuf,
    /// Listener port.
    port: u16,
    /// Listener address.
    bind: String,
    /// Persistent server log file.
    log: String,
    /// Size limit of the server log and of managed agents' forwarded logs; `None` uses
    /// the default limit.
    log_max_size: Option<u64>,
    /// Initial log threshold.
    log_level: Level,
    /// Process output format.
    log_format: LogFormat,
    /// Browser login backend.
    auth: AuthMode,
    /// Whether session cookies require HTTPS.
    cookie_secure: bool,
    /// Optional OpenID Connect sign-in.
    oidc: Option<redoor_core::config::OidcConfig>,
    /// Browser origins allowed to call MCP.
    mcp_allowed_origins: Vec<String>,
    /// Shared agent registration secret.
    agent_token: String,
    /// Managed agents registered dormant at startup.
    agents: Vec<AgentConfig>,
}

impl ServerConfig {
    /// Applies CLI > env > config file > default without touching the process environment.
    ///
    /// Clap already merged CLI and env for the flags that have an env variable, so for
    /// those the file is simply the next fallback.
    fn resolve(
        args: &CoordinatorArgs,
        env: &ServerEnvironment,
        file: RedoorConfig,
        config_path: PathBuf,
        paths: &AppPaths,
    ) -> Result<Self> {
        let server = redoor_core::config::require_server_section(&file)?.clone();
        let log = match args.log.clone().or(server.log) {
            Some(log) => log,
            None => paths.process_log_path(ProcessSlot::Server)?,
        };
        let log_level = redoor_core::logging::resolve_level_sources(
            args.log_level,
            LOG_LEVEL_ENV,
            env.log_level.as_deref(),
            server.log_level,
        )?;
        let log_format = redoor_core::logging::resolve_format_sources(
            args.log_format,
            LOG_FORMAT_ENV,
            env.log_format.as_deref(),
            server.log_format,
        )?;
        Ok(Self {
            config_path,
            port: args.port.or(server.port).unwrap_or(DEFAULT_PORT),
            bind: args
                .bind
                .clone()
                .or(server.bind)
                .unwrap_or_else(|| DEFAULT_BIND.to_string()),
            log,
            log_max_size: server.log_max_size,
            log_level,
            log_format,
            auth: server.auth,
            cookie_secure: server.cookie_secure,
            oidc: server.oidc,
            mcp_allowed_origins: server.mcp_allowed_origins,
            agent_token: file.agent_token,
            agents: file.agents,
        })
    }

    /// `bind:port` as passed to the listener and printed for operators.
    fn listen_address(&self) -> String {
        format!("{}:{}", self.bind, self.port)
    }
}

/// A fully initialized server whose listener is bound and inventory registered.
struct ServerRuntime {
    /// Router of the HTTP application.
    app: axum::Router,
    /// Bound listener; held so the port is ours before managed agents are told about it.
    listener: tokio::net::TcpListener,
    /// Fired by the restart route to stop serving before re-exec.
    shutdown: tokio::sync::oneshot::Receiver<()>,
    /// Supervisors that must stop their children before the process image is replaced.
    watchdogs: WatchdogRegistry,
    /// Printed address, also used for the first-run login URL.
    bind: String,
    /// Listener port, also used for the first-run login URL.
    port: u16,
}

impl ServerRuntime {
    /// Initializes logging, credential stores, actors and the listener, then registers inventory.
    async fn build(config: ServerConfig, runtime: RuntimeContext) -> Result<Self> {
        redoor_core::logging::init_with_options(
            Some(redoor_core::rotating_log::LogFileSpec::new(
                &config.log,
                config.log_max_size,
            )),
            config.log_level,
            config.log_format,
        )
        .await?;
        log!(
            Level::Info,
            "Loaded server config: path={}",
            config.config_path.display()
        );

        let address = config.listen_address();
        let data_dir = runtime.paths.data_dir()?;
        let auth_mode = ServerAuthMode::from(&config.auth);
        let auth = AuthState::new(
            config.auth,
            config.oidc.as_ref(),
            config.agent_token.clone(),
            config.cookie_secure,
            &data_dir,
        )
        .await
        .context("Failed to initialize authentication")?;
        let oidc = config
            .oidc
            .map(|oidc| {
                log!(
                    Level::Info,
                    "OIDC sign-in enabled: issuer={}, client_id={}",
                    oidc.issuer,
                    oidc.client_id
                );
                crate::http::oidc::OidcClient::new(oidc).map(Arc::new)
            })
            .transpose()
            .context("Failed to initialize OIDC sign-in")?;
        let tokens = crate::http::tokens::TokenStore::load(&data_dir)
            .await
            .context("Failed to load access tokens")?;
        let mcp =
            crate::http::mcp::McpState::new(tokens.clone(), config.mcp_allowed_origins, &data_dir)
                .await
                .context("Failed to initialize MCP operation storage")?;

        let (router, _router_task) = spawn_router();
        // Built before the listener so the registry exists when the first WebSocket connects.
        let watchdogs = WatchdogRegistry::new();
        let binaries = crate::binaries::BinaryCache::new(runtime.paths.clone());
        let ssh_keys = crate::ssh::keys::SshKeyStore::for_data_dir(&data_dir);
        let held_ssh_keys = crate::ssh::held_keys::HeldSshKeys::default();
        let launcher = ManagedLauncher::new(
            config.port,
            config.agent_token,
            crate::ssh::ProvisionContext {
                app_name: runtime.paths.app_name().to_string(),
                binaries: binaries.clone(),
                ssh_keys: ssh_keys.clone(),
                held_ssh_keys: held_ssh_keys.clone(),
                default_account: Some(auth.username().to_string()),
                log_max_size: config.log_max_size,
                // Empty until the first SSH provision, so servers that never provision a
                // device never hash the debug build.
                local_build: Default::default(),
            },
        );

        // Oneshot so restart can drop the axum listener before self-exec; keeping
        // the listen FD open would race the restarted process on the same port.
        let (shutdown_tx, shutdown) = tokio::sync::oneshot::channel::<()>();
        // Caught from now on, so `redoor upgrade` restarts the server instead of killing it.
        let reexec_requests = redoor_core::process::listen_for_reexec()
            .context("Failed to listen for the upgrade re-exec signal")?;
        let transfer_service = crate::http::services::transfer::TransferService::new(
            router.clone(),
            runtime.paths.data_dir()?,
        );
        let vault =
            crate::vault::VaultStore::new(runtime.paths.clone(), auth.username().to_string());
        let state = ServerState {
            vault,
            runtime,
            binaries,
            launcher: launcher.clone(),
            router_ref: router.clone(),
            agents: crate::http::agent_client::AgentClient::new(router.clone()),
            transfers: transfer_service,
            watchdog_registry: watchdogs.clone(),
            one_time_token_registry: OneTimeTokenRegistry::new(),
            upload_requests: crate::http::upload_requests::UploadRequests::default(),
            protocol_mismatches: crate::protocol_mismatches::ProtocolMismatches::default(),
            auth,
            oidc,
            tokens,
            mcp,
            config_path: config.config_path,
            config_edit_lock: Arc::new(tokio::sync::Mutex::new(())),
            editor_buffer_lock: Arc::default(),
            ssh_keys,
            held_ssh_keys,
            ssh_key_operations: crate::http::ssh_keys::SshKeyOperations::default(),
            auth_mode,
            shutdown_tx: Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx))),
            upgrade_lock: Arc::default(),
        };
        state.clone().restart_on_reexec_signal(reexec_requests);
        let app = build_app(state);

        let listener = tokio::net::TcpListener::bind(&address)
            .await
            .with_context(|| format!("Failed to bind to address {address}"))?;
        if let Err(error) = redoor_core::systemd_notify::ready().await {
            log!(
                Level::Warning,
                "Failed to notify systemd readiness: {error}"
            );
        }
        println!("Server running on http://{address}");

        // Registered after binding so later lazy starts connect to a resolved port.
        // Registration creates dormant supervisors only; nothing starts until a tab,
        // direct status route, or management action requests it.
        launcher
            .register_all(&config.agents, &watchdogs, &router)
            .await
            .context("Failed to register managed agents")?;

        Ok(Self {
            app,
            listener,
            shutdown,
            watchdogs,
            bind: config.bind,
            port: config.port,
        })
    }

    /// First-run demo: opens the login page when a desktop is available so `redoor server`
    /// alone is enough to try the UI.
    fn open_first_run_login(&self) {
        if !redoor_core::desktop::first_run_should_open_browser() {
            return;
        }
        let login_url = redoor_core::desktop::first_run_login_url(&self.bind, self.port);
        println!("Opening {login_url}");
        tokio::spawn(async move {
            if let Err(error) = redoor_core::desktop::open_with_desktop(&login_url).await {
                log!(
                    Level::Warning,
                    "Failed to open first-run login URL: {error}"
                );
            }
        });
    }

    /// Serves HTTP until the restart route fires, then stops every managed child.
    ///
    /// Exec preserves process memory rather than dropping Rust values, so children are
    /// stopped and reaped here; the new process recreates the inventory dormant. A failed
    /// serve stops them too, so an erroring server never leaves SSH agents orphaned.
    async fn serve_until_restart(self) -> Result<()> {
        let shutdown = self.shutdown;
        let served = axum::serve(
            self.listener,
            self.app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            shutdown.await.ok();
        })
        .await;
        self.watchdogs.shutdown_all().await;
        served.context("HTTP server failed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Wraps the flattened server flags so tests parse them like the real CLI.
    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        args: CoordinatorArgs,
    }

    /// Parses server flags exactly as `redoor server` would.
    fn args(argv: &[&str]) -> CoordinatorArgs {
        TestCli::try_parse_from(std::iter::once("server").chain(argv.iter().copied()))
            .expect("test arguments should parse")
            .args
    }

    /// Parses a config fixture through the real file parser.
    async fn file(content: &str) -> RedoorConfig {
        let directory = redoor_core::test_support::TempDir::create();
        let path = directory.path().join("config.toml");
        tokio::fs::write(&path, content)
            .await
            .expect("fixture should be writable");
        redoor_core::config::parse_config_file(&path)
            .await
            .expect("fixture should parse")
    }

    /// A config whose `[server]` sets every value precedence applies to.
    const FULL_FILE: &str = r#"agent_token = "token"
[server]
username = "user"
password = "secret"
port = 4000
bind = "0.0.0.0"
log = "/file/server.log"
log_level = "debug"
log_format = "json"
"#;

    /// Resolves with an explicit environment and a throwaway home.
    fn resolve(
        args: &CoordinatorArgs,
        env: &ServerEnvironment,
        file: RedoorConfig,
    ) -> Result<ServerConfig> {
        ServerConfig::resolve(
            args,
            env,
            file,
            PathBuf::from("/etc/redoor/config.toml"),
            &AppPaths::for_home("redoor", "/home/test"),
        )
    }

    /// CLI flags beat both the environment and the file.
    #[tokio::test]
    async fn cli_beats_env_and_file() {
        let config = resolve(
            &args(&[
                "--port",
                "5000",
                "--bind",
                "127.0.0.2",
                "--log",
                "/cli.log",
                "--log-level",
                "error",
                "--log-format",
                "line",
            ]),
            &ServerEnvironment {
                log_level: Some("warn".into()),
                log_format: Some("json".into()),
            },
            file(FULL_FILE).await,
        )
        .expect("config should resolve");
        // Every CLI value must win over the lower tiers.
        assert_eq!(config.listen_address(), "127.0.0.2:5000");
        assert_eq!(config.log, "/cli.log");
        assert_eq!(config.log_level, Level::Error);
        assert_eq!(config.log_format, LogFormat::Line);
    }

    /// The environment beats the file when the CLI is silent.
    #[tokio::test]
    async fn env_beats_file() {
        let config = resolve(
            &args(&[]),
            &ServerEnvironment {
                log_level: Some("warn".into()),
                log_format: Some("line".into()),
            },
            file(FULL_FILE).await,
        )
        .expect("config should resolve");
        // Role env variables sit between CLI and TOML.
        assert_eq!(config.log_level, Level::Warning);
        assert_eq!(config.log_format, LogFormat::Line);
        // Values without an env override still come from the file.
        assert_eq!(config.listen_address(), "0.0.0.0:4000");
        assert_eq!(config.log, "/file/server.log");
        // Explicit TOML credentials select password login.
        assert!(matches!(config.auth, AuthMode::Configured { .. }));
    }

    /// Built-in defaults apply only when no tier sets a value.
    #[tokio::test]
    async fn defaults_fill_unset_values() {
        let config = resolve(
            &args(&[]),
            &ServerEnvironment::default(),
            file(
                r#"agent_token = "token"
[server]
username = "user"
password = "secret"
"#,
            )
            .await,
        )
        .expect("config should resolve");
        // Loopback on the documented port keeps a fresh install private.
        assert_eq!(config.listen_address(), "127.0.0.1:7666");
        // The log defaults into the namespace's data directory.
        assert_eq!(config.log, "/home/test/.local/share/redoor/server.log");
        assert_eq!(config.log_level, Level::Info);
        assert_eq!(config.log_format, LogFormat::Line);
    }

    /// An invalid environment value fails instead of silently falling back to the file.
    #[tokio::test]
    async fn invalid_env_value_is_an_error() {
        let error = resolve(
            &args(&[]),
            &ServerEnvironment {
                log_level: Some("loud".into()),
                log_format: None,
            },
            file(FULL_FILE).await,
        )
        .err()
        .expect("an unknown level must be rejected");
        // The variable name tells operators which setting to fix.
        assert!(error.to_string().contains(LOG_LEVEL_ENV), "{error}");
    }

    /// Agent-only config files cannot start a server.
    #[tokio::test]
    async fn missing_server_section_is_rejected() {
        let error = resolve(
            &args(&[]),
            &ServerEnvironment::default(),
            file(
                r#"agent_token = "token"
[agent]
server = "http://localhost:1"
"#,
            )
            .await,
        )
        .err()
        .expect("a server needs [server]");
        // The message names the missing table.
        assert!(error.to_string().contains("[server]"), "{error}");
    }
}
