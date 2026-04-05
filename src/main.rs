mod server;

use clap::Parser;
use ractor::Actor;
use redoor::{actors, logging};

#[tokio::main]
async fn main() {
    let args = server::CoordinatorArgs::parse();
    logging::init(args.log.clone());

    let (router_ref, _) = actors::router::RouterActor::spawn(None, actors::router::RouterActor, ())
        .await
        .expect("Failed to spawn RouterActor");

    let app = server::build_app(server::ServerState::new(router_ref));

    let addr = format!("0.0.0.0:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to address {}", addr));
    println!("Server running on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}
