use axum::{
    Router, middleware,
    routing::{get, post, put},
};
use tower_http::cors::{Any, CorsLayer};

use super::{
    agent_configuration::{
        create_local_agent_handler, create_ssh_agent_handler, delete_managed_agent_handler,
        get_local_agent_configuration_handler, get_ssh_agent_configuration_handler,
        update_local_agent_handler, update_ssh_agent_handler,
    },
    agent_logs::{agent_logs_websocket_handler, browser_agent_logs_websocket_handler},
    agent_transfers::agent_transfer_websocket_handler,
    agents::{
        accounts_handler, chmod_path_handler, chown_path_handler, content_grep_handler,
        directory_size_handler, echo_agent_handler, file_search_agent_handler,
        get_agent_details_handler, list_agents_handler, ls_agent_handler, metadata_agent_handler,
        open_path_agent_handler, restart_agent_handler, server_info_handler,
        shutdown_agent_handler, start_agent_handler, upgrade_agent_handler,
    },
    auth::{login_handler, logout_handler, require_authentication},
    diffs::diff_files_handler,
    file_edit::file_edit_handler,
    files::{create_directory_handler, raw_agent_delete_handler, rename_path_handler},
    git::{git_context_handler, git_diff_handler, git_status_handler},
    logging_levels::{
        get_agent_logging_level_handler, get_server_logging_level_handler,
        update_agent_logging_level_handler, update_server_logging_level_handler,
    },
    logs::server_logs_websocket_handler,
    moves::move_file_handler,
    raw::{create_one_time_token_handler, raw_agent_handler, raw_agent_put_handler},
    restart::restart_server_handler,
    retry_agent_start::retry_agent_start_handler,
    state::ServerState,
    terminals::{agent_terminal_websocket_handler, browser_terminal_websocket_handler},
    transfer_cancellation::cancel_transfer_handler,
    transfers::{copy_file_handler, list_transfer_progress_handler},
    trash::{empty_trash_handler, list_trash_handler, restore_trash_handler},
    ui::ui_service,
    user_state::{get_user_state_handler, update_user_state_handler},
    ws::{ui_websocket_handler, websocket_handler},
};

/// Builds public login/agent entry points and protects every browser-facing API route.
pub(crate) fn build_app(server_state: ServerState) -> Router {
    let auth = server_state.auth.clone();

    Router::new()
        .route("/ws", get(websocket_handler))
        .route(
            "/api/v1/agent-transfer/ws",
            get(agent_transfer_websocket_handler),
        )
        .route("/api/v1/login", post(login_handler))
        .route("/api/v1/logout", post(logout_handler))
        .route("/api/v1/ui/ws", get(ui_websocket_handler))
        .route("/api/v1/server/logs/ws", get(server_logs_websocket_handler))
        .route(
            "/api/v1/agents/{agent}/logs/ws",
            get(browser_agent_logs_websocket_handler),
        )
        .route(
            "/api/v1/log-streams/{log_stream_id}/agent/ws",
            get(agent_logs_websocket_handler),
        )
        .route(
            "/api/v1/agents/{agent}/terminal/ws",
            get(browser_terminal_websocket_handler),
        )
        .route(
            "/api/v1/terminals/{terminal_id}/agent/ws",
            get(agent_terminal_websocket_handler),
        )
        .route(
            "/api/v1/agents",
            get(list_agents_handler).post(create_ssh_agent_handler),
        )
        .route("/api/v1/server", get(server_info_handler))
        .route(
            "/api/v1/server/logging-level",
            get(get_server_logging_level_handler).put(update_server_logging_level_handler),
        )
        .route(
            "/api/v1/agents/{agent}/logging-level",
            get(get_agent_logging_level_handler).put(update_agent_logging_level_handler),
        )
        .route(
            "/api/v1/user/state",
            get(get_user_state_handler).post(update_user_state_handler),
        )
        .route(
            "/api/v1/transfers/progress",
            get(list_transfer_progress_handler),
        )
        .route(
            "/api/v1/transfers/{transfer_id}/cancel",
            post(cancel_transfer_handler),
        )
        .route(
            "/api/v1/agents/{agent}",
            get(get_agent_details_handler)
                .put(update_ssh_agent_handler)
                .delete(delete_managed_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/configuration",
            get(get_ssh_agent_configuration_handler),
        )
        .route("/api/v1/local-agents", post(create_local_agent_handler))
        .route(
            "/api/v1/local-agents/{agent}",
            put(update_local_agent_handler),
        )
        .route(
            "/api/v1/local-agents/{agent}/configuration",
            get(get_local_agent_configuration_handler),
        )
        .route("/api/v1/agents/{agent}/start", post(start_agent_handler))
        .route(
            "/api/v1/agents/{agent}/retry-start",
            post(retry_agent_start_handler),
        )
        .route(
            "/api/v1/agents/{agent}/restart",
            post(restart_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/upgrade",
            post(upgrade_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/shutdown",
            post(shutdown_agent_handler),
        )
        .route("/api/v1/agents/{agent}/ls", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/ls/{*path}", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/open", post(open_path_agent_handler))
        .route(
            "/api/v1/agents/{agent}/open/{*path}",
            post(open_path_agent_handler),
        )
        .route("/api/v1/find", post(file_search_agent_handler))
        .route("/api/v1/grep", post(content_grep_handler))
        .route(
            "/api/v1/agents/{agent}/metadata",
            get(metadata_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/metadata/{*path}",
            get(metadata_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/directory-size",
            post(directory_size_handler),
        )
        .route(
            "/api/v1/agents/{agent}/directory-size/{*path}",
            post(directory_size_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/context",
            get(git_context_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/context/{*path}",
            get(git_context_handler),
        )
        .route("/api/v1/agents/{agent}/git/status", get(git_status_handler))
        .route(
            "/api/v1/agents/{agent}/git/status/{*path}",
            get(git_status_handler),
        )
        .route("/api/v1/agents/{agent}/git/diff", post(git_diff_handler))
        .route(
            "/api/v1/agents/{agent}/one-time-token",
            post(create_one_time_token_handler),
        )
        .route(
            "/api/v1/agents/{agent}/one-time-token/{*path}",
            post(create_one_time_token_handler),
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
        .route("/api/v1/agents/{agent}/edit", put(file_edit_handler))
        .route(
            "/api/v1/agents/{agent}/edit/{*path}",
            put(file_edit_handler),
        )
        .route(
            "/api/v1/agents/{agent}/mkdir",
            post(create_directory_handler),
        )
        .route(
            "/api/v1/agents/{agent}/mkdir/{*path}",
            post(create_directory_handler),
        )
        .route("/api/v1/agents/{agent}/rename", post(rename_path_handler))
        .route("/api/v1/agents/{agent}/accounts", get(accounts_handler))
        .route("/api/v1/agents/{agent}/chown", post(chown_path_handler))
        .route(
            "/api/v1/agents/{agent}/chown/{*path}",
            post(chown_path_handler),
        )
        .route("/api/v1/agents/{agent}/chmod", post(chmod_path_handler))
        .route(
            "/api/v1/agents/{agent}/chmod/{*path}",
            post(chmod_path_handler),
        )
        .route(
            "/api/v1/agents/{agent}/trash",
            get(list_trash_handler).delete(empty_trash_handler),
        )
        .route(
            "/api/v1/agents/{agent}/trash/restore",
            post(restore_trash_handler),
        )
        .route("/api/v1/copy", post(copy_file_handler))
        .route("/api/v1/move", post(move_file_handler))
        .route("/api/v1/diff", post(diff_files_handler))
        .route("/api/v1/agents/{agent}/echo", post(echo_agent_handler))
        .route("/api/v1/server/restart", post(restart_server_handler))
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
