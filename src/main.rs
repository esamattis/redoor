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
    logging::init(args.log.clone());

    let (router_ref, _router_task) = actors::router::spawn_router();

    let app = server::build_app(server::ServerState::new(router_ref));

    let addr = format!("0.0.0.0:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
    println!("Server running on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}
