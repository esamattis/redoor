use redoor::actors;

use axum::{
    Router,
    extract::{
        State as AxumState,
        ws::{WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use ractor::ActorRef;
use uuid::Uuid;

#[derive(Clone)]
struct ServerState {
    router_ref: ActorRef<actors::router::RouterMsg>,
}

#[tokio::main]
async fn main() {
    use ractor::Actor;

    let (router_ref, _) = actors::router::RouterActor::spawn(None, actors::router::RouterActor, ())
        .await
        .expect("Failed to spawn RouterActor");

    let _ = actors::command_executor::CommandExecutorActor::spawn(
        None,
        actors::command_executor::CommandExecutorActor,
        (),
    )
    .await
    .expect("Failed to spawn CommandExecutorActor");

    let server_state = ServerState {
        router_ref: router_ref.clone(),
    };

    let app = Router::new()
        .route("/ws", get(websocket_handler))
        .route("/", get(index_handler))
        .with_state(server_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://0.0.0.0:3000");
    axum::serve(listener, app).await.unwrap();
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state.router_ref))
}

async fn handle_socket(socket: WebSocket, router_ref: ActorRef<actors::router::RouterMsg>) {
    let socket_id = Uuid::new_v4().to_string();
    actors::session::handle_websocket(socket, socket_id, router_ref).await;
}

async fn index_handler() -> impl IntoResponse {
    let html = include_str!("../index.html");
    axum::response::Html(html)
}
