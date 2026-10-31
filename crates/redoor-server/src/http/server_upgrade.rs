//! REST endpoint that installs a release over the server binary and restarts onto it.
//!
//! Uses the same installer and restarter as `redoor upgrade`, in-process: the install
//! finishes before anything restarts, so a failed download is reported while this server
//! keeps serving. The other local processes are signalled without waiting, because this
//! server restarts itself right after and could not see them come back.

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor_core::log;
use redoor_core::upgrade::SelfInstall;
use redoor_core::upgrade::install::ReleaseInstall;
use redoor_core::upgrade::restart::Restarter;
use redoor_protocol::api::ErrorResponse;
use redoor_protocol::api::server::{ServerUpgradeRequest, ServerUpgradeResponse};
use redoor_protocol::wire::log::Level;

use super::state::ServerState;

/// Installs the requested release, then restarts the local processes and this server.
pub(crate) async fn upgrade_server_handler(
    State(state): State<ServerState>,
    Json(request): Json<ServerUpgradeRequest>,
) -> Response {
    if let Some(tag) = &request.target_version
        && !ReleaseInstall::is_valid_tag(tag)
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            format!("Invalid release tag: {tag}"),
        );
    }
    // The new binary only runs after a restart, which would refuse this config.
    if let Err(error) = state.validate_restart_config().await {
        return error_response(
            StatusCode::BAD_REQUEST,
            format!("Invalid config, not upgrading: {error}"),
        );
    }
    let Ok(_guard) = state.upgrade_lock.try_lock() else {
        return error_response(StatusCode::CONFLICT, "Upgrade already in progress".into());
    };
    match state.upgrade(request.target_version).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")),
    }
}

/// Builds the JSON error body shared by every refusal.
fn error_response(status: StatusCode, error: String) -> Response {
    (status, Json(ErrorResponse { code: None, error })).into_response()
}

impl ServerState {
    /// Installs `tag` (or the latest release) over this binary and starts the restarts.
    ///
    /// This server stops accepting before the other processes are signalled, so restarted
    /// agents reconnect to the new server rather than reach the old one, which would reject
    /// a newer protocol. Graceful shutdown still delivers this response first.
    async fn upgrade(&self, tag: Option<String>) -> anyhow::Result<ServerUpgradeResponse> {
        let target = SelfInstall::resolve().await?;
        let restarter = Restarter::discover(&target.installed).await?;
        log!(
            Level::Info,
            "Upgrading the server: target_version={}, install_dir={}",
            tag.as_deref().unwrap_or("latest"),
            target.install_dir.display()
        );
        let install = ReleaseInstall {
            tag,
            install_dir: target.install_dir,
            target: None,
            temp_dir: None,
            base_url: None,
        };
        let output = match install.run().await {
            Ok(output) => output,
            Err(error) => {
                log!(Level::Warning, "Server upgrade failed: {error}");
                return Err(error.into());
            }
        };
        log!(Level::Info, "Server release installed; restarting");
        if let Err(error) = self.request_restart().await {
            log!(Level::Warning, "Upgraded server did not restart: {error}");
        }
        let processes = restarter.restart(false, |_| {}).await;
        Ok(ServerUpgradeResponse { output, processes })
    }
}
