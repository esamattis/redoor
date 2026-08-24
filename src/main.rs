mod agent;
mod app_name;
mod binaries;
mod config;
mod desktop;
mod launchd;
mod process_control;
mod process_logs;
mod server;
mod server_address;
mod service_management;
mod ssh;
mod systemd;
mod systemd_notify;
#[cfg(test)]
mod test_support;

use std::{path::PathBuf, sync::Arc};

use clap::{Args, Parser, Subcommand};
use redoor::{Level, actors, log, logging};

#[derive(Parser)]
#[command(author, version, about)]
#[command(subcommand_required = true, arg_required_else_help = true)]
struct Cli {
    /// Namespace for config, data, logs, SSH caches, and generated service names.
    #[arg(
        long,
        env = app_name::APP_NAME_ENV,
        default_value = "redoor",
        value_parser = app_name::parse_app_name,
        global = true
    )]
    app_name: String,
    /// How often idle sockets write a ping so proxies stay alive and half-open links fail fast.
    #[arg(
        long,
        env = "REDOOR_WEBSOCKET_KEEPALIVE",
        default_value = "10s",
        value_parser = redoor::websocket::parse_duration_millis,
        global = true
    )]
    websocket_keepalive: std::time::Duration,
    /// Silence before an agent WebSocket is treated as stale and closed.
    #[arg(
        long,
        env = "REDOOR_WEBSOCKET_STALE_TIMEOUT",
        default_value = "30s",
        value_parser = redoor::websocket::parse_duration_millis,
        global = true
    )]
    websocket_stale_timeout: std::time::Duration,
    /// How often to compare last inbound traffic against the stale timeout.
    #[arg(
        long,
        env = "REDOOR_WEBSOCKET_STALE_CHECK_INTERVAL",
        default_value = "5s",
        value_parser = redoor::websocket::parse_duration_millis,
        global = true
    )]
    websocket_stale_check_interval: std::time::Duration,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the server or use its role-specific utilities.
    Server(ServerArgs),
    /// Run the agent or use its role-specific utilities.
    Agent(Box<AgentCommandArgs>),
}

/// Process role selected by the parent CLI command for service management.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ServiceRole {
    /// Manage a standalone Redoor agent process.
    Agent,
    /// Manage the Redoor HTTP and WebSocket server process.
    Server,
}

impl ServiceRole {
    /// Returns the stable CLI and generated-service suffix for this role.
    /// systemd/launchd helpers are OS-gated, so Android agent builds keep the
    /// shared role enum without calling this helper.
    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
    pub(crate) fn cli_name(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Server => "server",
        }
    }
}

/// Preserves flat server startup flags while exposing `server logs`.
#[derive(Args)]
struct ServerArgs {
    /// Selects a utility action instead of starting the server.
    #[command(subcommand)]
    command: Option<ServerCommand>,
    /// Existing server startup settings remain accepted directly after `server`.
    #[command(flatten)]
    run: server::CoordinatorArgs,
}

/// Server-specific utility commands.
#[derive(Subcommand)]
enum ServerCommand {
    /// Stop the server recorded in the application PID file.
    Stop,
    /// Report whether the server PID file lock is held.
    Status,
    /// Print the configured server file log.
    Logs(ServerLogsArgs),
    /// Install or manage the server as a systemd service.
    Systemd(systemd::SystemdArgs),
    /// Install or manage the server as a macOS LaunchAgent.
    Launchd(launchd::LaunchdArgs),
}

/// Options used to locate and limit server file logs.
#[derive(Args)]
struct ServerLogsArgs {
    /// Number of trailing lines to print.
    #[arg(short = 'n', default_value_t = 500)]
    lines: usize,
    /// Continue printing new log entries until interrupted.
    #[arg(short = 'f', long)]
    follow: bool,
    /// Override the shared TOML config path.
    #[arg(long)]
    config: Option<String>,
    /// Override `REDOOR_SERVER_LOG` and `[server].log`.
    #[arg(long, env = "REDOOR_SERVER_LOG")]
    log: Option<String>,
}

/// Preserves flat agent startup flags while exposing `agent logs`.
#[derive(Args)]
struct AgentCommandArgs {
    /// Selects a utility action instead of starting the agent.
    #[command(subcommand)]
    command: Option<AgentCommand>,
    /// Existing agent startup settings remain accepted directly after `agent`.
    #[command(flatten)]
    run: agent::AgentArgs,
}

/// Agent-specific utility commands.
#[derive(Subcommand)]
enum AgentCommand {
    /// Stop the standalone agent recorded in the application PID file.
    Stop,
    /// Report whether the standalone agent PID file lock is held.
    Status,
    /// Print the configured standalone-agent file log.
    Logs(AgentLogsArgs),
    /// Install or manage the agent as a systemd service.
    Systemd(systemd::SystemdArgs),
    /// Install or manage the agent as a macOS LaunchAgent.
    Launchd(launchd::LaunchdArgs),
    /// Start an agent on an SSH host and relay it through this machine to a redoor server.
    Relay(Box<RelayCommandArgs>),
}

/// Requires an explicit lifecycle action for one configured relay.
#[derive(Args)]
struct RelayCommandArgs {
    #[command(subcommand)]
    command: RelayCommand,
}

/// Relay-specific lifecycle commands keyed by configured relay ID.
#[derive(Subcommand)]
enum RelayCommand {
    /// Start one configured relay in the foreground or background.
    Start(RelayStartArgs),
    /// Stop one named relay using its locked runtime file.
    Stop(RelayIdArgs),
    /// Report whether one named relay runtime-file lock is held.
    Status(RelayIdArgs),
    /// Print one named relay's file log.
    Logs(RelayLogsArgs),
}

/// Options required to start one configured relay.
#[derive(Args)]
struct RelayStartArgs {
    /// Stable relay ID from a `[[relays]]` entry.
    #[arg(value_parser = config::parse_relay_id)]
    id: String,
    /// Override the shared TOML config path.
    #[arg(long)]
    config: Option<String>,
    /// Detach the relay from the terminal and continue in the background.
    #[arg(long)]
    daemon: bool,
}

/// Selects a named relay for a lifecycle operation that does not need TOML.
#[derive(Args)]
struct RelayIdArgs {
    /// Stable relay ID used by its runtime file.
    #[arg(value_parser = config::parse_relay_id)]
    id: String,
}

/// Options used to locate and limit relay file logs.
#[derive(Args)]
struct RelayLogsArgs {
    /// Stable relay ID from configuration or an existing runtime file.
    #[arg(value_parser = config::parse_relay_id)]
    id: String,
    /// Number of trailing lines to print.
    #[arg(short = 'n', default_value_t = 500)]
    lines: usize,
    /// Override the shared TOML config path when the relay is stopped.
    #[arg(long)]
    config: Option<String>,
}

/// Options used to locate and limit standalone-agent file logs.
#[derive(Args)]
struct AgentLogsArgs {
    /// Number of trailing lines to print.
    #[arg(short = 'n', default_value_t = 500)]
    lines: usize,
    /// Continue printing new log entries until interrupted.
    #[arg(short = 'f', long)]
    follow: bool,
    /// Override the shared TOML config path.
    #[arg(long)]
    config: Option<String>,
    /// Override `REDOOR_AGENT_LOG` and `[agent].log`.
    #[arg(long, env = "REDOOR_AGENT_LOG")]
    log: Option<String>,
}

#[tokio::main]
async fn main() {
    // OpenSSH execs SSH_ASKPASS as this binary with the prompt as argv[1].
    // Detect that role before clap treats the prompt as a subcommand.
    if std::env::var_os(ssh::askpass::ENV).is_some() {
        ssh::askpass::run();
        return;
    }
    process_control::record_launch_parent();
    let cli = Cli::parse();
    app_name::initialize(cli.app_name);
    // Apply before any listener starts so tests can shrink idle waits via env.
    redoor::websocket::configure(redoor::websocket::WebSocketTimeouts {
        keepalive: cli.websocket_keepalive,
        stale_timeout: cli.websocket_stale_timeout,
        stale_check_interval: cli.websocket_stale_check_interval,
    });
    match cli.command {
        Commands::Server(args) => match args.command {
            Some(ServerCommand::Logs(logs)) => {
                run_utility(process_logs::run(
                    process_logs::LogRole::Server,
                    logs.config,
                    logs.log,
                    logs.lines,
                    logs.follow,
                ))
                .await;
            }
            Some(ServerCommand::Stop) => {
                run_utility(process_control::stop(process_control::ProcessSlot::Server)).await;
            }
            Some(ServerCommand::Status) => {
                run_utility(process_control::status(
                    process_control::ProcessSlot::Server,
                ))
                .await;
            }
            Some(ServerCommand::Systemd(systemd)) => {
                run_utility(systemd::run(systemd, ServiceRole::Server)).await;
            }
            Some(ServerCommand::Launchd(launchd)) => {
                run_utility(launchd::run(launchd, ServiceRole::Server)).await;
            }
            None => {
                run_role(
                    process_control::ProcessSlot::Server,
                    args.run.daemon,
                    || run_server(args.run),
                )
                .await
            }
        },
        Commands::Agent(args) => match args.command {
            Some(AgentCommand::Logs(logs)) => {
                run_utility(process_logs::run(
                    process_logs::LogRole::Agent,
                    logs.config,
                    logs.log,
                    logs.lines,
                    logs.follow,
                ))
                .await;
            }
            Some(AgentCommand::Stop) => {
                run_utility(process_control::stop(process_control::ProcessSlot::Agent)).await;
            }
            Some(AgentCommand::Status) => {
                run_utility(process_control::status(process_control::ProcessSlot::Agent)).await;
            }
            Some(AgentCommand::Systemd(systemd)) => {
                run_utility(systemd::run(systemd, ServiceRole::Agent)).await;
            }
            Some(AgentCommand::Launchd(launchd)) => {
                run_utility(launchd::run(launchd, ServiceRole::Agent)).await;
            }
            Some(AgentCommand::Relay(relay)) => match relay.command {
                RelayCommand::Start(start) => {
                    run_named_relay(start).await;
                }
                RelayCommand::Stop(relay) => {
                    run_utility(process_control::stop_relay(&relay.id)).await;
                }
                RelayCommand::Status(relay) => {
                    run_utility(process_control::status_relay(&relay.id)).await;
                }
                RelayCommand::Logs(logs) => {
                    run_utility(process_logs::run_relay(&logs.id, logs.config, logs.lines)).await;
                }
            },
            None => {
                let daemon = args.run.daemon;
                if daemon {
                    run_utility(agent::prepare_daemon_config(&args.run)).await;
                }
                run_role(process_control::ProcessSlot::Agent, daemon, || async move {
                    agent::run(args.run)
                        .await
                        .map_err(|error| anyhow::anyhow!(error.to_string()))
                })
                .await;
            }
        },
    }
}

/// Loads one named relay, establishes its isolated runtime identity, and starts it.
async fn run_named_relay(args: RelayStartArgs) {
    process_control::record_launch_parent();
    let config_path = match args.config.map(PathBuf::from) {
        Some(path) => path,
        None => match config::default_config_path() {
            Ok(path) => path,
            Err(error) => return run_utility(async { Err(error) }).await,
        },
    };
    let parsed = match config::parse_config_file(&config_path.to_string_lossy()).await {
        Ok(config) => config,
        Err(error) => return run_utility(async { Err(error) }).await,
    };
    let mut relay = match config::require_relay(&parsed, &args.id) {
        Ok(relay) => relay.clone(),
        Err(error) => return run_utility(async { Err(error) }).await,
    };
    let log = match relay.agent.log.clone() {
        Some(log) => log,
        None => match config::default_relay_log_path(&relay.id) {
            Ok(log) => log,
            Err(error) => return run_utility(async { Err(error) }).await,
        },
    };
    relay.agent.log = Some(log.clone());
    if args.daemon {
        run_utility(process_control::spawn_relay_daemon(&relay.id)).await;
        return;
    }
    process_control::bind_to_parent_lifetime();
    let agent_name = relay
        .agent
        .name
        .clone()
        .unwrap_or_else(|| ssh::default_agent_name(&relay.agent.target));
    let agent_app_name = relay
        .agent_app_name
        .clone()
        .unwrap_or_else(|| format!("{}-relay-{}", app_name::app_name().unwrap(), relay.id));
    let metadata = process_control::RelayPidMetadata {
        pid: 0,
        id: relay.id.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        target: relay.agent.target.clone(),
        server: relay.server.clone(),
        agent_name,
        agent_app_name: agent_app_name.clone(),
        log,
    };
    let pid_file = match process_control::acquire_relay(metadata).await {
        Ok(pid_file) => pid_file,
        Err(error) => return run_utility(async { Err(error) }).await,
    };
    let token = std::env::var("REDOOR_AGENT_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
        .unwrap_or(parsed.agent_token);
    if let Err(error) = ssh::run_relay(relay, token, agent_app_name).await {
        eprintln!("{error}");
        pid_file.remove().await;
        std::process::exit(1);
    }
    pid_file.remove().await;
}

/// Applies daemon and PID-file behavior consistently around a long-lived role.
async fn run_role<F, Fut>(slot: process_control::ProcessSlot, daemon: bool, run: F)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    process_control::record_launch_parent();
    if daemon {
        run_utility(process_control::spawn_daemon(slot)).await;
        return;
    }
    process_control::bind_to_parent_lifetime();
    let pid_file = match process_control::acquire(slot).await {
        Ok(pid_file) => pid_file,
        Err(error) => {
            eprintln!("{error:#}");
            std::process::exit(1);
        }
    };
    if let Err(error) = run().await {
        eprintln!("{error}");
        if let Some(pid_file) = pid_file {
            pid_file.remove().await;
        }
        std::process::exit(1);
    }
    if let Some(pid_file) = pid_file {
        pid_file.remove().await;
    }
}

/// Reports a finite utility command failure consistently with other CLI branches.
async fn run_utility(future: impl std::future::Future<Output = anyhow::Result<()>>) {
    if let Err(error) = future.await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

/// Starts the long-lived server using the established flat startup arguments.
async fn run_server(args: server::CoordinatorArgs) -> anyhow::Result<()> {
    let app_name = app_name::app_name().expect("Clap validated the application name");
    // Only this command bootstraps the conventional path so first-run secrets and
    // the local agent entry appear from a single intentional entry point.
    let mut created_default_config = false;
    let config_path = match args.config.clone() {
        Some(path) => PathBuf::from(path),
        None => {
            let path = match config::default_config_path() {
                Ok(path) => path,
                Err(error) => {
                    eprintln!("{error:#}");
                    std::process::exit(1);
                }
            };
            match config::create_default_config_if_missing(&path).await {
                Ok(Some(created)) => {
                    created_default_config = true;
                    if let Some(password) = created.password {
                        eprintln!(
                            "Created default config '{}'.\n  username: redoor\n  password: {password}\n  agent_token: {}\nStore these secrets securely; they will not be shown again.",
                            path.display(),
                            created.agent_token
                        );
                    } else {
                        eprintln!(
                            "Created default config '{}'.\n  browser login: process owner's system username/password (PAM)\n  agent_token: {}\nStore the agent_token securely; it will not be shown again.",
                            path.display(),
                            created.agent_token
                        );
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!(
                        "Failed to create default config '{}': {error}",
                        path.display()
                    );
                    std::process::exit(1);
                }
            }
            path
        }
    };
    let config_path = tokio::fs::canonicalize(&config_path)
        .await
        .unwrap_or_else(|error| {
            eprintln!(
                "Failed to resolve config file '{}': {error}",
                config_path.display()
            );
            std::process::exit(1);
        });
    let config = match config::parse_config_file(&config_path.to_string_lossy()).await {
        Ok(config) => config,
        Err(error) => {
            eprintln!(
                "Failed to parse config file '{}': {error}",
                config_path.display()
            );
            std::process::exit(1);
        }
    };
    let server_section = match config::require_server_section(&config) {
        Ok(section) => section.clone(),
        Err(error) => {
            eprintln!(
                "Failed to parse config file '{}': {error}",
                config_path.display()
            );
            std::process::exit(1);
        }
    };

    // Precedence: CLI > env > config file > default.
    // Clap already merged CLI and env into `args`; config is the next fallback.
    let port = args.port.or(server_section.port).unwrap_or(7666);

    let bind = args
        .bind
        .clone()
        .or_else(|| server_section.bind.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());

    let log = match args.log.clone().or_else(|| server_section.log.clone()) {
        Some(path) => Some(path),
        None => match config::default_server_log_path() {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
        },
    };

    let log_level = logging::resolve_initial_level(
        args.log_level,
        "REDOOR_SERVER_LOG_LEVEL",
        server_section.log_level,
    )
    .unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(1);
    });

    if let Err(error) = logging::init_with_level(log.clone(), log_level).await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
    log!(
        Level::Info,
        "Loaded server config: path={}",
        config_path.display()
    );

    let (credentials, auth_mode) = match (
        server_section.username.clone(),
        server_section.password.clone(),
    ) {
        (Some(username), Some(password)) => (
            server::LoginCredentials::Configured { username, password },
            redoor::commands::ServerAuthMode::Toml,
        ),
        (None, None) => {
            // Config parser already rejects this pair on non-Linux platforms.
            #[cfg(target_os = "linux")]
            {
                (
                    server::LoginCredentials::SystemUser,
                    redoor::commands::ServerAuthMode::Pam,
                )
            }
            #[cfg(not(target_os = "linux"))]
            {
                unreachable!("config parser requires username/password on non-Linux");
            }
        }
        _ => unreachable!("config parser rejects partial username/password pairs"),
    };
    let auth = server::AuthState::new(
        credentials,
        config.agent_token.clone(),
        server_section.cookie_secure,
    )
    .await
    .unwrap_or_else(|error| {
        eprintln!("Failed to initialize authentication: {error}");
        std::process::exit(1);
    });

    let terminal_registry = redoor::terminal_registry::TerminalRegistry::new();
    let log_registry = redoor::log_registry::LogRegistry::new();
    let one_time_token_registry = redoor::one_time_token_registry::OneTimeTokenRegistry::new();
    let (router_ref, _router_task) =
        actors::router::spawn_router(terminal_registry.clone(), log_registry.clone());

    // Build the watchdog registry up front so the axum state and the
    // supervisor spawn loop share the same map of agent name →
    // supervisor signal. Built before binding the listener so the
    // registry exists by the time the first WebSocket connects.
    let watchdog_registry = server::WatchdogRegistry::new();

    // Oneshot so restart can drop the axum listener before self-exec; keeping
    // the listen FD open would race the restarted process on the same port.
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let app = server::build_app(server::ServerState {
        app_name,
        router_ref: router_ref.clone(),
        watchdog_registry: watchdog_registry.clone(),
        terminal_registry,
        log_registry,
        one_time_token_registry,
        auth,
        config_path,
        config_edit_lock: Arc::new(tokio::sync::Mutex::new(())),
        port,
        auth_mode,
        shutdown_tx: Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx))),
    });

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
    if let Err(error) = systemd_notify::ready().await {
        log!(
            Level::Warning,
            "Failed to notify systemd readiness: {error}"
        );
    }
    println!("Server running on http://{addr}");

    // Register configured agents after binding so later lazy starts can connect to
    // a resolved port. Registration creates dormant supervisors only; no local or
    // SSH subprocess starts until a tab, direct status route, or management action
    // requests it. Duplicate effective names remain fatal before HTTP serving.
    if let Err(error) = server::register_agents(
        &config.agents,
        port,
        &config.agent_token,
        &watchdog_registry,
        &router_ref,
    )
    .await
    {
        eprintln!("Failed to register managed agents: {error}");
        std::process::exit(1);
    }

    // First-run demo: open the login page with a platform-specific credential hint
    // when a graphical desktop is available so `redoor server` is enough to try the UI.
    if created_default_config && desktop::first_run_should_open_browser() {
        let login_url = desktop::first_run_login_url(&bind, port);
        println!("Opening {login_url}");
        tokio::spawn(async move {
            if let Err(error) = desktop::open_with_desktop(&login_url).await {
                log!(
                    Level::Warning,
                    "Failed to open first-run login URL: {error}"
                );
            }
        });
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        shutdown_rx.await.ok();
    })
    .await
    .unwrap();

    // Exec preserves process memory rather than dropping Rust values, so explicitly
    // stop and reap managed children before replacing the server image. Configured
    // inventory will be recreated dormant by the new process.
    watchdog_registry.shutdown_all().await;

    // Only reached after restart (or future shutdown paths). Replace this process
    // with the same binary and arguments so startup re-reads config.toml.
    redoor::process::reexec_current_process();
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{AgentCommand, Cli, Commands, RelayCommand};

    /// Keeps service-manager commands nested under their selected process role.
    #[test]
    fn parses_role_scoped_service_commands() {
        let timeouts = Cli::try_parse_from([
            "redoor",
            "--websocket-keepalive",
            "200ms",
            "--websocket-stale-timeout",
            "1s",
            "--websocket-stale-check-interval",
            "100ms",
            "server",
            "status",
        ])
        .expect("global websocket timeout flags should parse on any subcommand");
        // Flags exist so integration tests can shrink idle waits without rebuilding.
        assert_eq!(
            timeouts.websocket_keepalive,
            std::time::Duration::from_millis(200)
        );
        assert_eq!(
            timeouts.websocket_stale_timeout,
            std::time::Duration::from_secs(1)
        );
        assert_eq!(
            timeouts.websocket_stale_check_interval,
            std::time::Duration::from_millis(100)
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "systemd", "status"]).is_ok(),
            "agent systemd status should parse without a redundant mode flag"
        );
        assert!(
            Cli::try_parse_from(["redoor", "server", "launchd", "install", "--start"]).is_ok(),
            "server launchd install should accept explicit startup"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "launchd",
                "refresh-local-network-permission"
            ])
            .is_ok(),
            "launchd should expose the macOS Local Network permission repair"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "systemd",
                "refresh-local-network-permission"
            ])
            .is_err(),
            "the macOS-specific repair must not appear under systemd"
        );
        assert!(
            Cli::try_parse_from(["redoor", "server", "launchd", "--verbose", "start"]).is_ok()
                && Cli::try_parse_from(["redoor", "server", "launchd", "start", "--verbose",])
                    .is_ok(),
            "launchd verbosity should parse on either side of its selected action"
        );
        assert!(
            Cli::try_parse_from(["redoor", "systemd", "status", "--mode", "agent"]).is_err(),
            "the former top-level systemd command must no longer be accepted"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "launchd", "status", "--mode", "agent",])
                .is_err(),
            "role-scoped service commands must reject the removed mode flag"
        );
        for manager in ["systemd", "launchd"] {
            assert!(
                Cli::try_parse_from(["redoor", "agent", manager, "disable", "--now"]).is_ok(),
                "disable --now should parse for {manager}"
            );
            assert!(
                Cli::try_parse_from(["redoor", "agent", manager, "uninstall"]).is_ok(),
                "uninstall should parse for {manager}"
            );
            assert!(
                Cli::try_parse_from(["redoor", "agent", manager, "setup"]).is_err(),
                "the removed setup command should not parse for {manager}"
            );
            assert!(
                Cli::try_parse_from(["redoor", "agent", manager, "logs"]).is_err(),
                "service-manager logs should not parse for {manager}"
            );
        }
        assert!(
            Cli::try_parse_from([
                "redoor",
                "--app-name",
                "preview",
                "agent",
                "systemd",
                "status",
            ])
            .is_ok(),
            "the global app name should be the service installation identity"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "systemd",
                "status",
                "--unit-name",
                "custom",
            ])
            .is_err()
                && Cli::try_parse_from([
                    "redoor",
                    "agent",
                    "launchd",
                    "status",
                    "--service-name",
                    "custom",
                ])
                .is_err(),
            "manager-specific identity flags should be rejected"
        );
    }

    /// Keeps following on the role log commands rather than service-manager commands.
    #[test]
    fn parses_role_log_follow_options() {
        assert!(
            Cli::try_parse_from(["redoor", "server", "logs", "-f", "-n", "25"]).is_ok(),
            "server logs should support short follow and line-count options"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "logs", "--follow", "--log", "agent.log"])
                .is_ok(),
            "agent logs should preserve explicit log overrides while following"
        );
    }

    /// Keeps process status nested under each long-lived role, including named relays.
    #[test]
    fn parses_process_status_commands() {
        assert!(
            Cli::try_parse_from(["redoor", "agent", "status"]).is_ok(),
            "standalone agent status should parse without startup flags"
        );
        assert!(
            Cli::try_parse_from(["redoor", "server", "status"]).is_ok(),
            "server status should parse without startup flags"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "relay", "status", "production"]).is_ok(),
            "relay status should require only its stable ID"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "relay", "stop", "production"]).is_ok(),
            "relay stop should require only its stable ID"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "relay", "logs", "production"]).is_ok(),
            "relay logs should require only its stable ID"
        );
    }

    /// Keeps relay startup aligned with other daemon-capable process commands.
    #[test]
    fn agent_relay_start_accepts_id_config_and_daemon_only() {
        let start_cli = Cli::try_parse_from([
            "redoor",
            "agent",
            "relay",
            "start",
            "production",
            "--config",
            "relay.toml",
            "--daemon",
        ])
        .unwrap();
        let Commands::Agent(start_agent) = start_cli.command else {
            panic!("agent relay start should parse into the agent command");
        };
        let Some(AgentCommand::Relay(start_relay)) = start_agent.command else {
            panic!("agent relay start should preserve its relay command wrapper");
        };
        let RelayCommand::Start(start) = start_relay.command else {
            panic!("relay start should select the configured relay");
        };
        // Daemon mode remains a start option rather than a separate lifecycle verb.
        assert!(start.daemon);
        assert_eq!(start.id, "production");
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "start",
                "production",
                "--server",
                "http://redoor.example:3000",
            ])
            .is_err(),
            "removed ad hoc relay flags must be rejected"
        );
        let stop_cli =
            Cli::try_parse_from(["redoor", "agent", "relay", "stop", "production"]).unwrap();
        let Commands::Agent(stop_agent) = stop_cli.command else {
            panic!("agent relay stop should parse into the agent command");
        };
        let Some(AgentCommand::Relay(stop_relay)) = stop_agent.command else {
            panic!("agent relay stop should preserve its relay command wrapper");
        };
        assert!(matches!(stop_relay.command, RelayCommand::Stop(_)));
    }
}
