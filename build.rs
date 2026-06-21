use std::path::Path;

fn main() {
    // Rerun when any embedded UI asset changes so the binary always
    // bundles the latest frontend build. `rust-embed` walks the folder
    // at compile time and bakes the contents into the binary.
    emit_ui_dist_reruns();
}

/// Emits `cargo:rerun-if-changed` directives for every file in `ui/dist/`
/// so Cargo recompiles when the frontend bundle changes.
///
/// A missing `ui/dist/` directory is silently ignored: the build script
/// may run before the user has executed `pnpm run build`. The Rust
/// compiler will then fail with a clear error from `rust-embed` if the
/// `server::ui` module is reached during compilation.
fn emit_ui_dist_reruns() {
    let ui_dist = Path::new("ui/dist");
    if !ui_dist.exists() {
        return;
    }

    for entry in walkdir(ui_dist) {
        if entry.is_file() {
            println!("cargo:rerun-if-changed={}", entry.display());
        }
    }
}

fn walkdir(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}
