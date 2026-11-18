//! Serves the embedded browser UI with single-page-app fallback.

use std::fmt::Write as _;

use axum::{
    body::Body,
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

/// Embedded UI assets built from `ui/dist/` by the frontend build step.
///
/// The folder is populated by `pnpm run build` (which runs `vite build ./ui`).
/// The build script in `build.rs` triggers a Cargo rebuild whenever files in
/// this directory change, so the binary always ships the latest UI assets.
#[derive(RustEmbed)]
#[folder = "../../ui/dist/"]
pub(crate) struct UiAssets;

/// The SPA entry point, served for `/` and every path that is not an embedded file.
const INDEX_FILE: &str = "index.html";

/// Serves the embedded UI for every request no API route matched.
///
/// Any path that is not a real embedded file (including `/` and directories) gets
/// `index.html` with 200 so TanStack Router can resolve deep links such as
/// `/agents/:id/browser/:path` on the client. Vite puts content-hashed files under
/// `assets/`, so those may be cached forever, while everything else must be revalidated
/// so a new UI build is picked up; the content hash ETag makes that revalidation a 304.
/// The embedded bytes are static, so they are served whole without streaming.
pub(crate) async fn serve_ui(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    // Only reads make sense for static files; a POST to a UI path is a client bug.
    if method != Method::GET && method != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "Method not allowed").into_response();
    }

    let requested = uri.path().trim_start_matches('/');
    let Some((path, file)) = UiAssets::get(requested)
        .map(|file| (requested, file))
        .or_else(|| UiAssets::get(INDEX_FILE).map(|file| (INDEX_FILE, file)))
    else {
        // Only reachable when the server was built without `ui/dist`.
        return (StatusCode::NOT_FOUND, "UI is not built").into_response();
    };

    let mut etag = String::with_capacity(66);
    etag.push('"');
    for byte in file.metadata.sha256_hash() {
        let _ = write!(etag, "{byte:02x}");
    }
    etag.push('"');

    let cache_control = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    let client_has_it = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            // `*` only counts as the whole header; inside a list it could be part of a quoted tag.
            value.trim() == "*"
                || value
                    .split(',')
                    .map(str::trim)
                    .any(|tag| tag.strip_prefix("W/").unwrap_or(tag) == etag)
        });
    if client_has_it {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, cache_control.to_owned()),
            ],
        )
            .into_response();
    }

    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::ETAG, etag),
            (header::CACHE_CONTROL, cache_control.to_owned()),
        ],
        Body::from(file.data),
    )
        .into_response()
}
