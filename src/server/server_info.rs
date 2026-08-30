use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor::commands::ServerInfoResponse;

use super::state::ServerState;

/// Route: `GET /api/v1/server` returns identity and bootstrap settings for the authenticated UI.
pub(crate) async fn server_info_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let binary = redoor::commands::current_binary_identity();
    // Home page shows which on-disk binary is serving so upgrades can be verified.
    let (exe_path, external_ip) = tokio::join!(
        redoor::commands::current_exe_path(),
        redoor::commands::external_ip()
    );
    (
        StatusCode::OK,
        Json(ServerInfoResponse {
            app_name: state.app_name.clone(),
            agent_token: state.auth.agent_token().to_string(),
            config_path: state.config_path.display().to_string(),
            exe_path,
            auth_mode: state.auth_mode.clone(),
            external_ip,
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            version: binary.version,
            git_rev: binary.git_rev,
            git_dirty: binary.git_dirty,
            version_dirty: binary.version_dirty,
            build_mode: binary.build_mode,
            build_date: binary.build_date,
        }),
    )
        .into_response()
}
