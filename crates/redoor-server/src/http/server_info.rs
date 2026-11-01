//! REST endpoint that returns server identity and UI bootstrap settings.

use axum::{Json, extract::State as AxumState, http::StatusCode, response::IntoResponse};
use redoor_protocol::api::server::ServerInfoResponse;

use super::state::ServerState;

/// Route: `GET /api/v1/server` returns identity and bootstrap settings for the authenticated UI.
pub(crate) async fn server_info_handler(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let binary = redoor_core::identity::current_binary_identity();
    // Home page shows which on-disk binary is serving so upgrades can be verified.
    let (exe_path, external_ip) = tokio::join!(
        redoor_core::identity::current_exe_path(),
        redoor_core::identity::external_ip()
    );
    // The UI puts this in the document title, so a missing hostname must not fail the request.
    let hostname = nix::unistd::gethostname()
        .ok()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_else(|| "unknown".to_owned());
    (
        StatusCode::OK,
        Json(ServerInfoResponse {
            app_name: state.runtime.paths.app_name().to_string(),
            agent_token: state.auth.agent_token().to_string(),
            config_path: state.config_path.display().to_string(),
            self_signed_tls: state.self_signed_tls,
            exe_path,
            external_ip,
            hostname,
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            version: binary.version,
            git_rev: binary.git_rev,
            git_dirty: binary.git_dirty,
            version_dirty: binary.version_dirty,
            build_mode: binary.build_mode,
            build_date: binary.build_date,
            boot_id: state.boot_id.to_string(),
        }),
    )
        .into_response()
}
