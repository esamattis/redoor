use axum_embed::{FallbackBehavior, ServeEmbed};
use rust_embed::RustEmbed;

/// Embedded UI assets built from `ui/dist/` by the frontend build step.
///
/// The folder is populated by `pnpm run build` (which runs `vite build ./ui`).
/// The build script in `build.rs` triggers a Cargo rebuild whenever files in
/// this directory change, so the binary always ships the latest UI assets.
#[derive(RustEmbed, Clone)]
#[folder = "ui/dist/"]
pub(crate) struct UiAssets;

/// Returns a service that serves the embedded UI assets with SPA-style
/// fallback to `index.html`.
///
/// Any GET/HEAD request that does not match a real file inside the embedded
/// assets is answered with `index.html` and a 200 status code so that the
/// client-side router can take over (TanStack Router uses file-based routes
/// like `/agents/:id/browser/:path`). Static assets under `assets/` are
/// served directly by matching the file path in the embedded bundle.
pub(crate) fn ui_service() -> ServeEmbed<UiAssets> {
    ServeEmbed::<UiAssets>::with_parameters(
        Some("index.html".to_owned()),
        FallbackBehavior::Ok,
        Some("index.html".to_owned()),
    )
}
