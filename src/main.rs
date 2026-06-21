mod agent;
mod server;
mod ssh;

use clap::{Parser, Subcommand};
use redoor::{actors, logging};

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
    // Parse the config file once, up front, so both the precedence
    // resolution and the agent spawn loop share the same parsed data.
    // A missing --config is fine: the server runs with CLI/env/default
    // settings and no auto-started agents, matching the old behavior when
    // --agents was not passed.
    let config = match &args.config {
        Some(path) => match server::parse_config_file(path).await {
            Ok(config) => Some(config),
            Err(error) => {
                eprintln!("Failed to parse config file '{path}': {error}");
                std::process::exit(1);
            }
        },
        None => None,
    };

    // Precedence: CLI > config file > env > default.
    // Each tier is only consulted if the higher tier did not provide a value,
    // so an explicit CLI flag always wins and env is the fallback before the
    // built-in default.
    let port = args
        .port
        .or_else(|| config.as_ref().and_then(|c| c.server.port))
        .or_else(|| {
            std::env::var("REDOOR_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(3000);

    let bind = args
        .bind
        .clone()
        .or_else(|| config.as_ref().and_then(|c| c.server.bind.clone()))
        .unwrap_or_else(|| "0.0.0.0".to_string());

    let log = args
        .log
        .clone()
        .or_else(|| config.as_ref().and_then(|c| c.server.log.clone()));

    logging::init(log.clone());

    let (router_ref, _router_task) = actors::router::spawn_router();

    // Build the watchdog registry up front so the axum state and the
    // supervisor spawn loop share the same map of agent name →
    // supervisor signal. Built before binding the listener so the
    // registry exists by the time the first WebSocket connects.
    let watchdog_registry = server::WatchdogRegistry::new();

    let app = server::build_app(server::ServerState::new(
        router_ref.clone(),
        watchdog_registry.clone(),
    ));

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
    println!("Server running on http://{addr}");

    // Start configured agents after the listener is bound (so reverse-ssh
    // tunnels and local agents both have a server to connect to) but before
    // axum::serve blocks the current task. spawn_agents returns immediately;
    // each agent runs in its own watchdog supervisor task.
    if let Some(config) = &config {
        server::spawn_agents(&config.agents, port, &watchdog_registry);
    }

    axum::serve(listener, app).await.unwrap();
}
