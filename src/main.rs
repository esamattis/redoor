mod agent;
mod server;
mod ssh;

use std::path::PathBuf;

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
        Commands::Ssh(args) => {
            logging::init(None);
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
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    eprintln!("HOME is not set; pass --config with a config.toml path");
                    std::process::exit(1);
                });
            let path = home.join(".config/redoor/config.toml");
            match server::create_default_config_if_missing(&path).await {
                Ok(Some(created)) => {
                    eprintln!(
                        "Created default config '{}'.\n  username password: {}\n  agent_token: {}\nStore these secrets securely; they will not be shown again.",
                        path.display(),
                        created.password,
                        created.agent_token
                    );
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
    let config_path_string = config_path.to_string_lossy();
    let config = match server::parse_config_file(&config_path_string).await {
        Ok(config) => config,
        Err(error) => {
            eprintln!(
                "Failed to parse config file '{}': {error}",
                config_path.display()
            );
            std::process::exit(1);
        }
    };

    // Precedence: CLI > config file > env > default.
    // Each tier is only consulted if the higher tier did not provide a value,
    // so an explicit CLI flag always wins and env is the fallback before the
    // built-in default.
    let port = args
        .port
        .or(config.server.port)
        .or_else(|| {
            std::env::var("REDOOR_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(3000);

    let bind = args
        .bind
        .clone()
        .or_else(|| config.server.bind.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());

    let log = args.log.clone().or_else(|| config.server.log.clone());

    logging::init(log.clone());
    log!(
        Level::Info,
        "Loaded server config: path={}",
        config_path.display()
    );

    let auth = server::AuthState::new(
        config.server.username.clone(),
        config.server.password.clone(),
        config.server.agent_token.clone(),
        config.server.cookie_secure,
    )
    .await
    .unwrap_or_else(|error| {
        eprintln!("Failed to initialize authentication: {error}");
        std::process::exit(1);
    });

    let terminal_registry = redoor::terminal_registry::TerminalRegistry::new();
    let (router_ref, _router_task) = actors::router::spawn_router(terminal_registry.clone());

    // Build the watchdog registry up front so the axum state and the
    // supervisor spawn loop share the same map of agent name →
    // supervisor signal. Built before binding the listener so the
    // registry exists by the time the first WebSocket connects.
    let watchdog_registry = server::WatchdogRegistry::new();

    let app = server::build_app(server::ServerState::new(
        router_ref.clone(),
        watchdog_registry.clone(),
        terminal_registry,
        auth,
    ));

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
    println!("Server running on http://{addr}");

    // Start configured agents after the listener is bound (so reverse-ssh
    // tunnels and local agents both have a server to connect to) but before
    // axum::serve blocks the current task. spawn_agents returns immediately
    // after handing each entry off to its supervisor task; the
    // supervisors themselves run in the background for the server's
    // lifetime. A duplicate agent name (e.g. two [[agents]] entries
    // resolving to the same default key) is fatal at startup so the
    // operator notices the misconfiguration immediately.
    if let Err(error) = server::spawn_agents(
        &config.agents,
        port,
        &config.server.agent_token,
        &watchdog_registry,
    ) {
        eprintln!("Failed to start agent supervisors: {error}");
        std::process::exit(1);
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .unwrap();
}
