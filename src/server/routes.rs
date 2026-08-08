use axum::{
    Router, middleware,
    routing::{get, post},
};
use tower_http::cors::{Any, CorsLayer};

use super::{
    agents::{
        cat_agent_handler, echo_agent_handler, get_agent_details_handler, list_agents_handler,
        ls_agent_handler, metadata_agent_handler, server_info_handler,
    },
    auth::{login_handler, logout_handler, require_authentication},
    files::{create_directory_handler, raw_agent_delete_handler},
    raw::{raw_agent_handler, raw_agent_put_handler},
    state::ServerState,
    terminals::{agent_terminal_websocket_handler, browser_terminal_websocket_handler},
    transfers::{copy_file_handler, list_transfer_progress_handler},
    ui::ui_service,
    ws::{ui_websocket_handler, websocket_handler},
};

/// Builds public login/agent entry points and protects every browser-facing API route.
pub(crate) fn build_app(server_state: ServerState) -> Router {
    let auth = server_state.auth.clone();

    Router::new()
        .route("/ws", get(websocket_handler))
        .route("/api/v1/login", post(login_handler))
        .route("/api/v1/logout", post(logout_handler))
        .route("/api/v1/ui/ws", get(ui_websocket_handler))
        .route(
            "/api/v1/agents/{agent}/terminal/ws",
            get(browser_terminal_websocket_handler),
        )
        .route(
            "/api/v1/terminals/{terminal_id}/agent/ws",
            get(agent_terminal_websocket_handler),
        )
        .route("/api/v1/agents", get(list_agents_handler))
        .route("/api/v1/server", get(server_info_handler))
        .route(
            "/api/v1/transfers/progress",
            get(list_transfer_progress_handler),
        )
        .route("/api/v1/agents/{agent}", get(get_agent_details_handler))
        .route("/api/v1/agents/{agent}/ls", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/ls/{*path}", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/cat", get(cat_agent_handler))
        .route("/api/v1/agents/{agent}/cat/{*path}", get(cat_agent_handler))
        .route(
            "/api/v1/agents/{agent}/metadata",
            get(metadata_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/metadata/{*path}",
            get(metadata_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/raw",
            get(raw_agent_handler)
                .put(raw_agent_put_handler)
                .delete(raw_agent_delete_handler),
        )
        .route(
            "/api/v1/agents/{agent}/raw/{*path}",
            get(raw_agent_handler)
                .put(raw_agent_put_handler)
                .delete(raw_agent_delete_handler),
        )
        .route(
            "/api/v1/agents/{agent}/mkdir",
            post(create_directory_handler),
        )
        .route(
            "/api/v1/agents/{agent}/mkdir/{*path}",
            post(create_directory_handler),
        )
        .route("/api/v1/copy", post(copy_file_handler))
        .route("/api/v1/agents/{agent}/echo", post(echo_agent_handler))
        .layer(middleware::from_fn_with_state(auth, require_authentication))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(server_state)
        .fallback_service(ui_service())
}
