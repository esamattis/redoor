use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use redoor::commands::{ErrorResponse, RestartResponse};

use super::{
    config::{parse_config_file, require_server_section},
    state::ServerState,
};

/// Validates config.toml then asks the process to restart so startup
/// applies the file from scratch (agents, auth, bind/port/log).
///
/// Parse errors are rejected with 400 before any shutdown so a bad edit
/// cannot take the running process down. Concurrent restarts get 409 once
/// the oneshot sender has already been taken.
pub(crate) async fn restart_server_handler(State(state): State<ServerState>) -> impl IntoResponse {
    let path = state.config_path.to_string_lossy().to_string();
    let validated = async {
        let config = parse_config_file(&path).await?;
        require_server_section(&config)?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = validated {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid config, not restarting: {error}"),
            }),
        )
            .into_response();
    }

    let mut guard = state.shutdown_tx.lock().await;
    let Some(tx) = guard.take() else {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Restart already in progress".to_string(),
            }),
        )
            .into_response();
    };

    // Drop the lock before signaling so we do not hold it across restart.
    drop(guard);
    let _ = tx.send(());

    Json(RestartResponse { restarting: true }).into_response()
}
