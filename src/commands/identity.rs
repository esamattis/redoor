use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Cargo profile the binary was compiled with (`debug` vs `release`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ServerBuildMode {
    /// Unoptimized developer build (`cargo build` / `cargo test`).
    Debug,
    /// Optimized production build (`cargo build --release`).
    Release,
    /// Profile string from Cargo was not `debug` or `release`.
    Unknown,
}

/// Non-secret compile-time identity shared by server and agent binaries.
///
/// Kept identical on both sides so the UI can compare a connected agent against
/// the server and flag mismatched or dirty builds without probing the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BinaryIdentity {
    /// `CARGO_PKG_VERSION` baked into this binary.
    pub version: String,
    /// Full git commit SHA (or `unknown` when git metadata was unavailable at build).
    pub git_rev: String,
    /// True when the working tree had uncommitted changes at build time.
    pub git_dirty: bool,
    /// True when HEAD was not tagged `v{version}` at build time.
    pub version_dirty: bool,
    /// Whether this binary was compiled as debug or release.
    pub build_mode: ServerBuildMode,
    /// UTC compile timestamp (`YYYY-MM-DDTHH:MM:SSZ`) or `unknown`.
    pub build_date: String,
}

/// Reads compile-time identity baked by `build.rs` for the running binary.
pub fn current_binary_identity() -> BinaryIdentity {
    BinaryIdentity {
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_rev: env!("REDOOR_GIT_REV").to_string(),
        git_dirty: env!("REDOOR_GIT_DIRTY") == "1",
        version_dirty: env!("REDOOR_VERSION_DIRTY") == "1",
        build_mode: match env!("REDOOR_BUILD_PROFILE") {
            "release" => ServerBuildMode::Release,
            "debug" => ServerBuildMode::Debug,
            _ => ServerBuildMode::Unknown,
        },
        build_date: env!("REDOOR_BUILD_DATE").to_string(),
    }
}

/// Absolute filesystem path of the running binary for operator diagnostics.
///
/// Prefer the canonical path so `/proc/self/exe`-style links resolve to a real file.
pub async fn current_exe_path() -> String {
    match std::env::current_exe() {
        Ok(path) => match tokio::fs::canonicalize(&path).await {
            Ok(canonical) => canonical.display().to_string(),
            Err(_) => path.display().to_string(),
        },
        Err(_) => "unknown".to_string(),
    }
}

/// Resolves and caches the primary non-loopback IP selected by the local routing table.
pub async fn external_ip() -> Option<String> {
    static EXTERNAL_IP: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();

    EXTERNAL_IP
        .get_or_init(|| async {
            let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.ok()?;
            // UDP connect only asks the kernel to choose a route; it sends no network traffic.
            socket.connect("1.1.1.1:80").await.ok()?;
            let address = socket.local_addr().ok()?.ip();
            (!address.is_loopback() && !address.is_unspecified()).then(|| address.to_string())
        })
        .await
        .clone()
}

/// Process-local agent config path recorded once at agent startup.
///
/// Empty when the agent was launched from CLI/env only without loading a TOML file.
static AGENT_LOADED_CONFIG_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Records the config file this agent process loaded, when any.
///
/// Called once during agent startup so `GetAgentDetails` can surface it without
/// threading config state through every command handler call site.
pub fn set_agent_loaded_config_path(path: Option<std::path::PathBuf>) {
    let value = path
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let _ = AGENT_LOADED_CONFIG_PATH.set(value);
}

/// Absolute path of the TOML file this agent loaded, or empty when none was used.
pub fn agent_loaded_config_path() -> String {
    AGENT_LOADED_CONFIG_PATH.get().cloned().unwrap_or_default()
}
