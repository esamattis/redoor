use std::path::Path;

fn main() {
    // Rerun when any embedded UI asset changes so the binary always
    // bundles the latest frontend build. `rust-embed` walks the folder
    // at compile time and bakes the contents into the binary.
    emit_ui_dist_reruns();
    link_bionic_tls_align();
}

/// Links `bionic_tls_align.S` into arm64 Android builds so Bionic accepts the binary's TLS segment.
///
/// libghostty-vt brings Zig thread-locals aligned to 8 bytes, and Bionic aborts at startup unless
/// the executable's TLS segment is aligned to at least 64 bytes on arm64. Other targets have no
/// such requirement, so they skip the object entirely.
///
/// The archive is linked with `+whole-archive` because nothing references its symbol: a plain
/// static library member is only pulled in to resolve an undefined symbol. Cargo only forwards
/// `rustc-link-arg` from a build script to the package's own binaries, which this library has
/// none of, so `-Wl,--undefined` cannot reach the final `redoor` link from here.
fn link_bionic_tls_align() {
    println!("cargo:rerun-if-changed=bionic_tls_align.S");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_os != "android" || target_arch != "aarch64" {
        return;
    }

    cc::Build::new()
        .file("bionic_tls_align.S")
        .link_lib_modifier("+whole-archive")
        .compile("redoor_bionic_tls_align");
}

/// Emits `cargo:rerun-if-changed` directives for every file in `ui/dist/`
/// so Cargo recompiles when the frontend bundle changes.
///
/// A missing `ui/dist/` directory is silently ignored: the build script
/// may run before the user has executed `pnpm run build`. The Rust
/// compiler will then fail with a clear error from `rust-embed` if the
/// `http::ui` module is reached during compilation.
fn emit_ui_dist_reruns() {
    let ui_dist = Path::new("../../ui/dist");
    if !ui_dist.exists() {
        return;
    }

    for entry in walkdir(ui_dist) {
        if entry.is_file() {
            println!("cargo:rerun-if-changed={}", entry.display());
        }
    }
}

/// Lists every file below `root` so each embedded asset gets its own rerun directive.
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
