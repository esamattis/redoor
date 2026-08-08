use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use redoor::commands::{ErrorResponse, ReloadConfigResponse};

use super::{
    config::{parse_config_file, require_server_section},
    state::ServerState,
};

/// Validates config.toml then asks the process to restart so startup
/// applies the file from scratch (agents, auth, bind/port/log).
///
/// Parse errors are rejected with 400 before any shutdown so a bad edit
/// cannot take the running process down. Concurrent reloads get 409 once
/// the oneshot sender has already been taken.
pub(crate) async fn reload_config_handler(State(state): State<ServerState>) -> impl IntoResponse {
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
                error: format!("Invalid config, not reloading: {error}"),
            }),
        )
            .into_response();
    }

    let mut guard = state.shutdown_tx.lock().await;
    let Some(tx) = guard.take() else {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Reload already in progress".to_string(),
            }),
        )
            .into_response();
    };

    // Drop the lock before signaling so we do not hold it across restart.
    drop(guard);
    let _ = tx.send(());

    Json(ReloadConfigResponse { reloaded: true }).into_response()
}

/// Replaces the current process image with the same binary and argv.
///
/// Used after a config reload request has validated the file and axum has
/// released the listen socket. Same PID keeps systemd and test harnesses
/// tracking the server correctly; a sibling spawn+exit would race on the
/// port and break kill-by-pid teardown.
pub(crate) fn reexec_current_process() -> ! {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("reload: failed to resolve current executable: {error}");
        std::process::exit(1);
    });
    // Skip argv[0]; Command sets the program path separately from args.
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();

    let error = std::process::Command::new(&exe).args(&args).exec();
    // exec only returns on failure
    eprintln!("reload: exec failed for {}: {error}", exe.display());
    std::process::exit(1);
}
