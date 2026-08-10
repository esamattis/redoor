mod agent;
mod app_name;
mod binaries;
mod config;
mod launchd;
mod process_control;
mod process_logs;
mod server;
mod server_address;
mod ssh;
mod systemd;
mod systemd_notify;

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
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        allow(dead_code)
    )]
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
    Relay(RelayCommandArgs),
}

/// Preserves flat relay startup flags while exposing `agent relay stop|status|logs`.
#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
struct RelayCommandArgs {
    /// Selects a utility action instead of starting the relay.
    #[command(subcommand)]
    command: Option<RelayCommand>,
    /// Existing relay startup settings remain accepted directly after `relay`.
    #[command(flatten)]
    run: ssh::RelayArgs,
}

/// Relay-specific utility commands sharing `relay.pid` / `relay.log`.
#[derive(Subcommand)]
enum RelayCommand {
    /// Stop the relay recorded in the application PID file.
    Stop,
    /// Report whether the relay PID file lock is held.
    Status,
    /// Print the configured relay file log.
    Logs(RelayLogsArgs),
}

/// Options used to locate and limit relay file logs.
#[derive(Args)]
struct RelayLogsArgs {
    /// Number of trailing lines to print.
    #[arg(short = 'n', default_value_t = 500)]
    lines: usize,
    /// Override `REDOOR_RELAY_LOG` and the conventional relay log path.
    #[arg(long, env = "REDOOR_RELAY_LOG")]
    log: Option<String>,
}

/// Options used to locate and limit standalone-agent file logs.
#[derive(Args)]
struct AgentLogsArgs {
    /// Number of trailing lines to print.
    #[arg(short = 'n', default_value_t = 500)]
    lines: usize,
    /// Override the shared TOML config path.
    #[arg(long)]
    config: Option<String>,
    /// Override `REDOOR_AGENT_LOG` and `[agent].log`.
    #[arg(long, env = "REDOOR_AGENT_LOG")]
    log: Option<String>,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    app_name::initialize(cli.app_name);
    match cli.command {
        Commands::Server(args) => match args.command {
            Some(ServerCommand::Logs(logs)) => {
                run_utility(process_logs::run(
                    process_logs::LogRole::Server,
                    logs.config,
                    logs.log,
                    logs.lines,
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
                Some(RelayCommand::Stop) => {
                    run_utility(process_control::stop(process_control::ProcessSlot::Relay)).await;
                }
                Some(RelayCommand::Status) => {
                    run_utility(process_control::status(process_control::ProcessSlot::Relay)).await;
                }
                Some(RelayCommand::Logs(logs)) => {
                    run_utility(process_logs::run(
                        process_logs::LogRole::Relay,
                        None,
                        logs.log,
                        logs.lines,
                    ))
                    .await;
                }
                None => {
                    let daemon = relay.run.daemon;
                    run_role(process_control::ProcessSlot::Relay, daemon, || async move {
                        ssh::run_relay(relay.run)
                            .await
                            .map_err(|error| anyhow::anyhow!("{error}"))
                    })
                    .await;
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

/// Applies daemon and PID-file behavior consistently around a long-lived role.
async fn run_role<F, Fut>(slot: process_control::ProcessSlot, daemon: bool, run: F)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    if daemon {
        run_utility(process_control::spawn_daemon(slot)).await;
        return;
    }
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
    // Explicit paths remain strict, while the conventional path bootstraps a
    // documented starter config so first startup does not require manual setup.
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
                    if let Some(password) = created.password {
                        eprintln!(
                            "Created default config '{}'.\n  username password: {}\n  agent_token: {}\nStore these secrets securely; they will not be shown again.",
                            path.display(),
                            password,
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
    let port = args.port.or(server_section.port).unwrap_or(3000);

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

    if let Err(error) = logging::init(log.clone()).await {
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
        assert!(
            Cli::try_parse_from(["redoor", "agent", "systemd", "status"]).is_ok(),
            "agent systemd status should parse without a redundant mode flag"
        );
        assert!(
            Cli::try_parse_from(["redoor", "server", "launchd", "setup"]).is_ok(),
            "server launchd setup should parse under the server role"
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
    }

    /// Keeps process status nested under each long-lived role, including relay.
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
            Cli::try_parse_from(["redoor", "agent", "relay", "status"]).is_ok(),
            "relay status should parse without SSH startup flags"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "relay", "stop"]).is_ok(),
            "relay stop should parse without SSH startup flags"
        );
        assert!(
            Cli::try_parse_from(["redoor", "agent", "relay", "logs"]).is_ok(),
            "relay logs should parse without SSH startup flags"
        );
    }

    /// Ensures relay leaves the SSH port unset unless the operator explicitly
    /// overrides it, allowing host aliases to retain their configured ports.
    #[test]
    fn agent_relay_preserves_ssh_config_port_by_default() {
        let default_cli = Cli::try_parse_from([
            "redoor",
            "agent",
            "relay",
            "--server",
            "http://redoor.example:3000",
            "--token",
            "secret",
            "configured-alias",
        ])
        .unwrap();
        let Commands::Agent(default_agent) = default_cli.command else {
            panic!("agent relay should parse into the agent command");
        };
        let Some(AgentCommand::Relay(default_relay)) = default_agent.command else {
            panic!("agent relay should preserve its relay arguments");
        };
        // Utility subcommands stay absent when the operator is starting a relay.
        assert!(default_relay.command.is_none());
        // `None` prevents the transport from emitting `-p 22` over an SSH alias.
        assert_eq!(default_relay.run.ssh_port, None);

        let override_cli = Cli::try_parse_from([
            "redoor",
            "agent",
            "relay",
            "-p",
            "2200",
            "--server",
            "http://redoor.example:3000",
            "--token",
            "secret",
            "configured-alias",
        ])
        .unwrap();
        let Commands::Agent(override_agent) = override_cli.command else {
            panic!("agent relay should parse into the agent command");
        };
        let Some(AgentCommand::Relay(override_relay)) = override_agent.command else {
            panic!("agent relay should preserve its relay arguments");
        };
        // An explicit CLI port must still override the alias configuration.
        assert_eq!(override_relay.run.ssh_port, Some(2200));
        assert!(
            matches!(
                Cli::try_parse_from([
                    "redoor",
                    "agent",
                    "relay",
                    "status",
                    "--server",
                    "http://redoor.example:3000",
                ])
                .err(),
                Some(_)
            ),
            "utility subcommands must reject startup flags that would fight args_conflicts_with_subcommands"
        );
        let stop_cli = Cli::try_parse_from(["redoor", "agent", "relay", "stop"]).unwrap();
        let Commands::Agent(stop_agent) = stop_cli.command else {
            panic!("agent relay stop should parse into the agent command");
        };
        let Some(AgentCommand::Relay(stop_relay)) = stop_agent.command else {
            panic!("agent relay stop should preserve its relay command wrapper");
        };
        assert!(matches!(stop_relay.command, Some(RelayCommand::Stop)));
    }

    /// Keeps the SSH relay command focused on the topology where this machine
    /// bridges an otherwise disconnected target and redoor server.
    #[test]
    fn agent_relay_requires_server() {
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "--server",
                "http://redoor.example:3000",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_ok(),
            "a server URL and SSH target should be sufficient for the relay command"
        );
        // Missing --server still parses so utility subcommands can share RelayArgs;
        // run_relay rejects the incomplete start at runtime.
        let missing_server = Cli::try_parse_from([
            "redoor",
            "agent",
            "relay",
            "--token",
            "secret",
            "user@linux.example",
        ])
        .unwrap();
        let Commands::Agent(missing_server_agent) = missing_server.command else {
            panic!("agent relay should parse into the agent command");
        };
        let Some(AgentCommand::Relay(missing_server_relay)) = missing_server_agent.command else {
            panic!("agent relay should preserve its relay arguments");
        };
        assert!(
            missing_server_relay.run.server.is_none(),
            "omitting --server must leave the start payload incomplete for runtime validation"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "--route",
                "http://redoor.example:3000",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_err(),
            "the relay command must reject the former route flag"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "ssh",
                "--server",
                "http://redoor.example:3000",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_err(),
            "the former top-level ssh command must no longer be accepted"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "--server",
                "redoor.example:3000",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_err(),
            "the relay command must reject bare host:port servers"
        );
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "--server",
                "https://redoor.example.com",
                "--wss",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_err(),
            "the former --wss flag must no longer be accepted"
        );
    }

    /// Prevents certificate verification from being disabled accidentally on a plain route.
    #[test]
    fn ssh_insecure_parses_with_secure_server_url() {
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "--server",
                "https://redoor.example.com",
                "--insecure",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_ok(),
            "insecure mode must remain available for https/wss server URLs"
        );
        // Clap still accepts --insecure with plain URLs; run_relay rejects that combination.
        assert!(
            Cli::try_parse_from([
                "redoor",
                "agent",
                "relay",
                "--server",
                "http://redoor.example.com:443",
                "--insecure",
                "--token",
                "secret",
                "user@linux.example",
            ])
            .is_ok(),
            "clap parsing alone cannot enforce scheme requirements on --insecure"
        );
    }
}
