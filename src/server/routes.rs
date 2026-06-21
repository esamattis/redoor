use axum::{
    Router,
    routing::{get, post},
};
use tower_http::cors::{Any, CorsLayer};

use super::{
    agents::{
        cat_agent_handler, echo_agent_handler, get_agent_details_handler, list_agents_handler,
        ls_agent_handler,
    },
    files::{create_directory_handler, raw_agent_delete_handler},
    raw::{raw_agent_handler, raw_agent_put_handler},
    state::ServerState,
    transfers::{copy_file_handler, list_transfer_progress_handler},
    ui::ui_service,
    ws::{ui_websocket_handler, websocket_handler},
};

pub(crate) fn build_app(server_state: ServerState) -> Router {
    Router::new()
        .route("/ws", get(websocket_handler))
        .route("/api/v1/ui/ws", get(ui_websocket_handler))
        .route("/api/v1/agents", get(list_agents_handler))
        .route(
            "/api/v1/transfers/progress",
            get(list_transfer_progress_handler),
        )
        .route("/api/v1/agents/{agent}", get(get_agent_details_handler))
        .route("/api/v1/agents/{agent}/ls/{*path}", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/cat/{*path}", get(cat_agent_handler))
        .route(
            "/api/v1/agents/{agent}/raw/{*path}",
            get(raw_agent_handler)
                .put(raw_agent_put_handler)
                .delete(raw_agent_delete_handler),
        )
        .route(
            "/api/v1/agents/{agent}/mkdir/{*path}",
            post(create_directory_handler),
        )
        .route("/api/v1/copy", post(copy_file_handler))
        .route("/api/v1/agents/{agent}/echo", post(echo_agent_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(server_state)
        .fallback_service(ui_service())
}
