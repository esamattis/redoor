use std::path::Path;
use std::process::Command;

fn main() {
    // Bake git/build identity into the binary so the server home page can
    // show exactly which revision operators are running without probing the
    // host filesystem at runtime.
    emit_build_identity();
    // Rerun when any embedded UI asset changes so the binary always
    // bundles the latest frontend build. `rust-embed` walks the folder
    // at compile time and bakes the contents into the binary.
    emit_ui_dist_reruns();
}

/// Emits `REDOOR_GIT_REV`, `REDOOR_GIT_DIRTY`, and `REDOOR_BUILD_PROFILE` for `env!()`.
fn emit_build_identity() {
    // Rebuild when HEAD moves or the index changes so dirty/clean flips stay accurate.
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/index");
    if let Ok(head) = std::fs::read_to_string(".git/HEAD") {
        if let Some(reference) = head.strip_prefix("ref: ").map(str::trim) {
            println!("cargo:rerun-if-changed=.git/{reference}");
        }
    }

    let git_rev = git_stdout(["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    let git_dirty = git_stdout(["status", "--porcelain"])
        .map(|status| !status.is_empty())
        .unwrap_or(false);
    let build_profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".to_string());

    println!("cargo:rustc-env=REDOOR_GIT_REV={git_rev}");
    println!(
        "cargo:rustc-env=REDOOR_GIT_DIRTY={}",
        if git_dirty { "1" } else { "0" }
    );
    println!("cargo:rustc-env=REDOOR_BUILD_PROFILE={build_profile}");
}

/// Runs `git` and returns trimmed stdout when the command succeeds.
fn git_stdout(args: impl IntoIterator<Item = &'static str>) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Some(text)
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
