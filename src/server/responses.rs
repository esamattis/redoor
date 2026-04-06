use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{RouterError, commands::ErrorResponse};

/// Converts one typed router boundary error into the standard JSON HTTP error body.
pub(crate) fn router_error_response(error: RouterError) -> Response {
    (
        error.status_code(),
        Json(ErrorResponse {
            error: error.to_string(),
        }),
    )
        .into_response()
}

/// Maps one agent command failure string into the closest existing HTTP status.
pub(crate) fn command_error_status(message: &str) -> StatusCode {
    if message.contains("No such file") || message.contains("not found") {
        StatusCode::NOT_FOUND
    } else if message.contains("Permission denied") {
        StatusCode::FORBIDDEN
    } else if message.contains("not a directory") {
        StatusCode::NOT_FOUND
    } else if message.contains("Is a directory") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}
