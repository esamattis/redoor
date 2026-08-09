mod agent;
mod server;
mod setup_systemd;
mod ssh;

use std::{path::PathBuf, sync::Arc};

use clap::{Parser, Subcommand};
use redoor::{Level, actors, log, logging};

#[derive(Parser)]
#[command(author, version, about)]
#[command(subcommand_required = true, arg_required_else_help = true)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Server(server::CoordinatorArgs),
    Agent(agent::AgentArgs),
    SetupSystemd(setup_systemd::SetupSystemdArgs),
    Ssh(ssh::SshArgs),
}

#[tokio::main]
async fn main() {
    match Cli::parse().command {
        Commands::Server(args) => run_server(args).await,
        Commands::Agent(args) => {
            if let Err(error) = agent::run(args).await {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Commands::SetupSystemd(args) => {
            if let Err(error) = setup_systemd::run(args).await {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
        }
        Commands::Ssh(args) => {
            if let Err(error) = logging::init(None).await {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
            if let Err(error) = ssh::run(args).await {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
}

async fn run_server(args: server::CoordinatorArgs) {
    // Explicit paths remain strict, while the conventional path bootstraps a
    // documented starter config so first startup does not require manual setup.
    let config_path = match args.config.clone() {
        Some(path) => PathBuf::from(path),
        None => {
            let path = match server::default_config_path() {
                Ok(path) => path,
                Err(error) => {
                    eprintln!("{error:#}");
                    std::process::exit(1);
                }
            };
            match server::create_default_config_if_missing(&path).await {
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
    let config = match server::parse_config_file(&config_path.to_string_lossy()).await {
        Ok(config) => config,
        Err(error) => {
            eprintln!(
                "Failed to parse config file '{}': {error}",
                config_path.display()
            );
            std::process::exit(1);
        }
    };
    let server_section = match server::require_server_section(&config) {
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

    let log = args.log.clone().or_else(|| server_section.log.clone());

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

    // Oneshot so reload can drop the axum listener before self-exec; keeping
    // the listen FD open would race the restarted process on the same port.
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let app = server::build_app(server::ServerState::new(
        router_ref.clone(),
        watchdog_registry.clone(),
        terminal_registry,
        log_registry,
        one_time_token_registry,
        auth,
        config_path,
        auth_mode,
        Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx))),
    ));

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
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

    // Only reached after reload (or future shutdown paths). Replace this process
    // with the same binary and arguments so startup re-reads config.toml.
    server::reexec_current_process();
}
