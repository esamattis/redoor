//! REST endpoint and upgrade signal that validate the config file and restart the server in place.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use redoor_core::log;
use redoor_protocol::api::{ErrorResponse, server::RestartResponse};
use redoor_protocol::wire::log::Level;

use super::state::ServerState;
use redoor_core::config::{parse_config_file, require_server_section};

/// Why a restart request was not accepted.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RestartRefused {
    /// The restarted process would fail to start with the current file.
    #[error("Invalid config, not restarting: {0}")]
    InvalidConfig(redoor_core::config::ConfigError),
    /// The configured TLS certificate files cannot be loaded, so the restarted process could
    /// not listen.
    #[error("Invalid TLS certificate, not restarting: {0:#}")]
    InvalidTls(anyhow::Error),
    /// Another request already took the shutdown sender.
    #[error("Restart already in progress")]
    InProgress,
}

impl ServerState {
    /// Validates config.toml then stops serving so startup re-execs and applies it.
    ///
    /// Shared by the REST route and the `redoor upgrade` signal so both refuse a bad edit
    /// before any shutdown, instead of taking the running process down.
    pub(crate) async fn request_restart(&self) -> Result<(), RestartRefused> {
        let config = self
            .validate_restart_config()
            .await
            .map_err(RestartRefused::InvalidConfig)?;
        Self::validate_restart_tls(&config)
            .await
            .map_err(RestartRefused::InvalidTls)?;

        let mut guard = self.shutdown_tx.lock().await;
        let tx = guard.take().ok_or(RestartRefused::InProgress)?;
        // Drop the lock before signaling so we do not hold it across restart.
        drop(guard);
        let _ = tx.send(());
        Ok(())
    }

    /// Checks that a restarted process would start with the current config.toml.
    pub(crate) async fn validate_restart_config(
        &self,
    ) -> Result<redoor_core::config::RedoorConfig, redoor_core::config::ConfigError> {
        let config = parse_config_file(&self.config_path).await?;
        require_server_section(&config)?;
        // Startup would refuse colliding managed names, so refuse them before shutting down.
        config.validate_managed_agent_names(&self.config_path)?;
        Ok(config)
    }

    /// Checks that operator-provided certificate files load, since a wrong path or a key that
    /// does not fit would leave the restarted server unable to listen at all.
    ///
    /// A self-signed certificate is not checked: startup creates it whenever it is unusable.
    async fn validate_restart_tls(
        config: &redoor_core::config::RedoorConfig,
    ) -> anyhow::Result<()> {
        let Some(redoor_core::config::ServerTls::Files { cert, key }) = config
            .server
            .as_ref()
            .and_then(|server| server.tls.as_ref())
        else {
            return Ok(());
        };
        crate::tls::ServerCertificate::files(cert, key)
            .acceptor()
            .await?;
        Ok(())
    }

    /// Restarts in place each time `redoor upgrade` sends the re-exec signal.
    ///
    /// A refused request keeps listening so a fixed config can be applied by the next upgrade
    /// without restarting the server by other means first.
    pub(crate) fn restart_on_reexec_signal(self, mut requests: tokio::signal::unix::Signal) {
        tokio::spawn(async move {
            while requests.recv().await.is_some() {
                log!(Level::Info, "Re-exec signal received; restarting server");
                match self.request_restart().await {
                    Ok(()) => return,
                    Err(error) => log!(Level::Warning, "Re-exec signal ignored: {error}"),
                }
            }
        });
    }
}

/// Validates config.toml then asks the process to restart so startup
/// applies the file from scratch (agents, auth, bind/port/log).
///
/// Parse errors are rejected with 400 before any shutdown so a bad edit
/// cannot take the running process down. Concurrent restarts get 409 once
/// the oneshot sender has already been taken.
pub(crate) async fn restart_server_handler(State(state): State<ServerState>) -> impl IntoResponse {
    log!(Level::Info, "Server restart requested");
    match state.request_restart().await {
        Ok(()) => Json(RestartResponse { restarting: true }).into_response(),
        Err(error) => {
            let status = match error {
                RestartRefused::InvalidConfig(_) | RestartRefused::InvalidTls(_) => {
                    StatusCode::BAD_REQUEST
                }
                RestartRefused::InProgress => StatusCode::CONFLICT,
            };
            (
                status,
                Json(ErrorResponse {
                    code: None,
                    error: error.to_string(),
                }),
            )
                .into_response()
        }
    }
}
