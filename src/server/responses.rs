use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use redoor::{
    RouterError,
    commands::{CommandErrorKind, ErrorResponse},
};

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

/// Maps one typed command failure into the HTTP status exposed by REST handlers.
pub(crate) fn command_error_status(kind: &CommandErrorKind) -> StatusCode {
    match kind {
        CommandErrorKind::NotFound | CommandErrorKind::NotADirectory => StatusCode::NOT_FOUND,
        CommandErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        CommandErrorKind::IsDirectory | CommandErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
        CommandErrorKind::AlreadyExists => StatusCode::CONFLICT,
        CommandErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
