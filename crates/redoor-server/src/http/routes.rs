//! Axum router assembly. Which principal may call each route is decided by the access table
//! in `access::routes`, applied by the `access_control` layer.

use axum::{
    Router, middleware,
    routing::{get, patch, post, put},
};
use tower_http::cors::{Any, CorsLayer};

use super::{
    access::access_control,
    agent_configuration::{
        create_local_agent_handler, create_ssh_agent_handler, delete_local_agent_handler,
        delete_ssh_agent_handler, get_local_agent_configuration_handler,
        get_ssh_agent_configuration_handler, update_local_agent_handler, update_ssh_agent_handler,
    },
    agent_logs::browser_agent_logs_websocket_handler,
    agent_ws::agent_websocket_handler,
    agents::{
        accounts_handler, chmod_path_handler, chown_path_handler, content_grep_handler,
        directory_size_handler, echo_agent_handler, file_search_agent_handler,
        get_agent_details_handler, list_agents_handler, ls_agent_handler, metadata_agent_handler,
        open_path_agent_handler, restart_agent_handler, shutdown_agent_handler,
        start_agent_handler, upgrade_agent_handler,
    },
    auth::{login_handler, logout_handler},
    copy::copy_file_handler,
    diffs::diff_files_handler,
    editor_buffers::{
        delete_editor_buffer_handler, get_editor_buffer_handler, put_editor_buffer_handler,
    },
    file_edit::file_edit_handler,
    files::{create_directory_handler, raw_agent_delete_handler, rename_path_handler},
    git::{
        commit::git_commit_diff_handler,
        directory_entries::git_directory_entries_handler,
        download::git_download_handler,
        file_bases::git_file_bases_handler,
        history::{git_commit_neighbors_handler, git_log_handler},
        refs::{git_branches_handler, git_tags_handler},
        revision::{git_revision_content_handler, git_revision_tree_handler},
        worktree::{git_context_handler, git_diff_handler, git_status_handler},
        worktree_list::git_worktrees_handler,
        worktree_status::git_worktree_status_handler,
    },
    logging_levels::{
        get_agent_logging_level_handler, get_server_logging_level_handler,
        update_agent_logging_level_handler, update_server_logging_level_handler,
    },
    logs::server_logs_websocket_handler,
    moves::move_file_handler,
    protocol_mismatches::list_protocol_mismatches_handler,
    raw::{create_one_time_token_handler, raw_agent_handler, upload::raw_agent_put_handler},
    restart::restart_server_handler,
    retry_agent_start::retry_agent_start_handler,
    server_info::server_info_handler,
    state::ServerState,
    terminals::browser_terminal_websocket_handler,
    transfer_cancellation::cancel_transfer_handler,
    transfer_progress::list_transfer_progress_handler,
    trash::{empty_trash_handler, list_trash_handler, restore_trash_handler},
    ui::ui_service,
    user_state::{get_user_state_handler, update_user_state_handler},
    ws::ui_websocket_handler,
};

/// Builds the REST and websocket routes behind the access layer, plus the separately
/// authenticated MCP router.
pub(crate) fn build_app(server_state: ServerState) -> Router {
    let mcp_router = super::mcp::router(server_state.clone());

    let browser_router = Router::new()
        .route("/api/v1/agent/ws", get(agent_websocket_handler))
        .route(
            "/api/v1/protocol-mismatches",
            get(list_protocol_mismatches_handler),
        )
        .route("/api/v1/login", post(login_handler))
        .route("/api/v1/logout", post(logout_handler))
        .route(
            "/api/v1/auth/methods",
            get(super::oidc::login_methods_handler),
        )
        .route(
            "/api/v1/auth/oidc/login",
            get(super::oidc::oidc_login_handler),
        )
        .route(
            "/api/v1/auth/oidc/callback",
            get(super::oidc::oidc_callback_handler),
        )
        .route("/api/v1/ui/ws", get(ui_websocket_handler))
        .route("/api/v1/server/logs/ws", get(server_logs_websocket_handler))
        .route(
            "/api/v1/agents/{agent}/logs/ws",
            get(browser_agent_logs_websocket_handler),
        )
        .route(
            "/api/v1/agents/{agent}/terminal/ws",
            get(browser_terminal_websocket_handler),
        )
        .route(
            "/api/v1/agents",
            get(list_agents_handler).post(create_ssh_agent_handler),
        )
        .route("/api/v1/server", get(server_info_handler))
        .route(
            "/api/v1/agents/{agent}/exec",
            post(super::exec::exec_handler),
        )
        .route(
            "/api/v1/agents/{agent}/exec/{execution_id}",
            axum::routing::delete(super::exec::cancel_execution_handler),
        )
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
            get(get_user_state_handler).put(update_user_state_handler),
        )
        .route(
            "/api/v1/user/editor-buffers/{key}",
            get(get_editor_buffer_handler)
                .put(put_editor_buffer_handler)
                .delete(delete_editor_buffer_handler)
                // A buffer carries a whole document and its history, above axum's 2 MiB default.
                .layer(axum::extract::DefaultBodyLimit::max(
                    redoor_protocol::api::editor_buffers::MAX_EDITOR_BUFFER_BYTES,
                )),
        )
        .route(
            "/api/v1/vault",
            get(super::vault::get_vault_handler)
                .post(super::vault::create_vault_handler)
                .patch(super::vault::update_vault_handler),
        )
        .route(
            "/api/v1/vault/unlock-material",
            get(super::vault::unlock_material_handler),
        )
        .route("/api/v1/vault/slots", post(super::vault::add_slot_handler))
        .route(
            "/api/v1/vault/slots/{id}",
            patch(super::vault::rename_slot_handler).delete(super::vault::remove_slot_handler),
        )
        .route(
            "/api/v1/vault/slots/{id}/used",
            post(super::vault::slot_used_handler),
        )
        .route("/api/v1/vault/rotate", post(super::vault::rotate_handler))
        .route(
            "/api/v1/vault/keys/{key_id}/destroy",
            post(super::vault::destroy_key_handler),
        )
        .route(
            "/api/v1/vault/backup",
            get(super::vault::export_backup_handler).put(super::vault::restore_backup_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/header/{*path}",
            get(super::vault_files::header_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/read/{*path}",
            post(super::vault_files::read_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/edit/{*path}",
            put(super::vault_files::edit_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/raw/{*path}",
            put(super::vault_files::upload_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/download",
            post(super::vault_files::download_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/rewrap/{*path}",
            post(super::vault_files::rewrap_handler),
        )
        .route(
            "/api/v1/agents/{agent}/vault/reencrypt/{*path}",
            post(super::vault_files::reencrypt_handler),
        )
        .route(
            "/api/v1/transfers/progress",
            get(list_transfer_progress_handler),
        )
        .route(
            "/api/v1/transfers/{transfer_id}",
            axum::routing::delete(cancel_transfer_handler),
        )
        .route(
            "/api/v1/agents/{agent}",
            get(get_agent_details_handler)
                .put(update_ssh_agent_handler)
                .delete(delete_ssh_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/configuration",
            get(get_ssh_agent_configuration_handler),
        )
        .route(
            "/api/v1/agents/{agent}/ssh-host-key",
            get(super::ssh_keys::get_host_key_handler),
        )
        .route(
            "/api/v1/agents/{agent}/ssh-host-key/pin",
            post(super::ssh_keys::pin_host_key_handler),
        )
        .route(
            "/api/v1/agents/{agent}/ssh-key",
            post(super::ssh_keys::enroll_handler).delete(super::ssh_keys::remove_handler),
        )
        .route("/api/v1/local-agents", post(create_local_agent_handler))
        .route(
            "/api/v1/local-agents/{agent}",
            put(update_local_agent_handler).delete(delete_local_agent_handler),
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
        .route(
            "/api/v1/agents/{agent}/find",
            post(file_search_agent_handler),
        )
        .route(
            "/api/v1/agents/{agent}/find/{*path}",
            post(file_search_agent_handler),
        )
        .route("/api/v1/agents/{agent}/grep", post(content_grep_handler))
        .route(
            "/api/v1/agents/{agent}/grep/{*path}",
            post(content_grep_handler),
        )
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
        .route(
            "/api/v1/agents/{agent}/git/entries",
            get(git_directory_entries_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/entries/{*path}",
            get(git_directory_entries_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/file-bases/{*path}",
            get(git_file_bases_handler),
        )
        .route("/api/v1/agents/{agent}/git/diff", post(git_diff_handler))
        .route(
            "/api/v1/agents/{agent}/git/tree",
            get(git_revision_tree_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/tree/{*path}",
            get(git_revision_tree_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/blob",
            get(git_revision_content_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/blob/{*path}",
            get(git_revision_content_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/download",
            get(git_download_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/download/{*path}",
            get(git_download_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/commit-diff",
            get(git_commit_diff_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/commit-diff/{*path}",
            get(git_commit_diff_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/commit-neighbors",
            get(git_commit_neighbors_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/commit-neighbors/{*path}",
            get(git_commit_neighbors_handler),
        )
        .route("/api/v1/agents/{agent}/git/log", get(git_log_handler))
        .route(
            "/api/v1/agents/{agent}/git/log/{*path}",
            get(git_log_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/branches",
            get(git_branches_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/branches/{*path}",
            get(git_branches_handler),
        )
        .route("/api/v1/agents/{agent}/git/tags", get(git_tags_handler))
        .route(
            "/api/v1/agents/{agent}/git/tags/{*path}",
            get(git_tags_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/worktrees",
            get(git_worktrees_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/worktrees/{*path}",
            get(git_worktrees_handler),
        )
        .route(
            "/api/v1/agents/{agent}/git/worktree-status",
            post(git_worktree_status_handler),
        )
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
            "/api/v1/upload-requests/{token}",
            axum::routing::delete(super::upload_requests::cancel_handler),
        )
        .route(
            "/api/v1/agents/{agent}/archive/{*path}",
            put(super::archive_upload::upload_handler),
        )
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
        .route("/api/v1/partials", get(super::partials::list))
        .route("/api/v1/partials/resume", post(super::partials::resume))
        .route("/api/v1/partials/discard", post(super::partials::discard))
        .route("/api/v1/copy/preflight", post(super::partials::preflight))
        .route(
            "/api/v1/transfers/{transfer_id}/pause",
            post(super::transfer_pause::pause),
        )
        .route("/api/v1/copy", post(copy_file_handler))
        .route("/api/v1/move", post(move_file_handler))
        .route("/api/v1/diff", post(diff_files_handler))
        .route("/api/v1/agents/{agent}/echo", post(echo_agent_handler))
        .route("/api/v1/server/restart", post(restart_server_handler))
        .route(
            "/api/v1/server/upgrade",
            post(super::server_upgrade::upgrade_server_handler),
        )
        .route(
            "/api/v1/tokens",
            get(super::tokens::handlers::list).post(super::tokens::handlers::create),
        )
        // Registered as a static path so it is never captured by `{token_id}`.
        .route(
            "/api/v1/tokens/current",
            get(super::tokens::handlers::current).delete(super::tokens::handlers::delete_current),
        )
        .route(
            "/api/v1/tokens/{token_id}",
            put(super::tokens::handlers::update).delete(super::tokens::handlers::delete),
        )
        .route(
            "/api/v1/tokens/{token_id}/rotate",
            post(super::tokens::handlers::rotate),
        )
        // `Router::layer` runs after routing, so the access table sees the matched template.
        .layer(middleware::from_fn_with_state(
            server_state.clone(),
            access_control,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .fallback_service(ui_service());

    browser_router.merge(mcp_router).with_state(server_state)
}
