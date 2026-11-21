//! REST endpoint that returns server identity and the signed-in user's agent token.

use axum::{Extension, Json, extract::State as AxumState, http::StatusCode};
use redoor_protocol::api::server::ServerInfoResponse;

use super::{access::Principal, error::ApiError, state::ServerState};

/// Route: `GET /api/v1/server` returns identity and bootstrap settings for the authenticated UI,
/// including the signed-in user's own `agent_token` (lazily creating `account.json` if needed).
pub(crate) async fn server_info_handler(
    AxumState(state): AxumState<ServerState>,
    Extension(principal): Extension<Principal>,
) -> Result<(StatusCode, Json<ServerInfoResponse>), ApiError> {
    let agent_token = state
        .accounts
        .ensure_agent_token(principal.owner())
        .await
        .map_err(|error| ApiError::internal(format!("Failed to load user agent token: {error}")))?;
    let binary = redoor_core::identity::current_binary_identity();
    // Home page shows which on-disk binary is serving so upgrades can be verified.
    let (exe_path, external_ip) = tokio::join!(
        redoor_core::identity::current_exe_path(),
        redoor_core::identity::external_ip()
    );
    let hostname = server_hostname();
    Ok((
        StatusCode::OK,
        Json(ServerInfoResponse {
            app_name: state.runtime.paths.app_name().to_string(),
            agent_token,
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
    ))
}

/// The machine's hostname, or `unknown`. The UI puts it in the document title and terminal
/// shells get it as `REDOOR_SERVER`, so a missing hostname must not fail either of them.
pub(crate) fn server_hostname() -> String {
    nix::unistd::gethostname()
        .ok()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_else(|| "unknown".to_owned())
}
