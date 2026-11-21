//! First-run configuration bootstrap and host-derived defaults.

use anyhow::{Context, Result};
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// Generates a high-entropy secret for per-user agent tokens from the OS CSPRNG.
pub fn generate_agent_token() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow::anyhow!("Failed to read OS randomness: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Renders the minimal starter config written only by `redoor server` on first run.
///
/// Server configs only carry `[server]` settings; per-user agent tokens and managed devices
/// live under `<data_dir>/users/<user>/` so multiple accounts stay isolated.
fn default_config_content() -> String {
    r#"# Redoor configuration
# Browser login uses username redoor and password changeme.

[server]
username = "redoor"
password = "changeme"

# port = 7666
# bind = "0.0.0.0" # default 127.0.0.1
# cookie_secure = false # set true behind an HTTPS reverse proxy
# mcp_allowed_origins = ["https://client.example"] # browser MCP clients only
# log_format = "line" # use "json" for newline-delimited JSON output

# Serve HTTPS with a self-signed certificate created on the first start
# (or set cert = "..." and key = "..." to use your own).
# [server.tls]
# self_signed = true
"#
    .to_string()
}

/// Bootstrap credentials printed once when a starter config is created.
pub struct CreatedDefaultConfig {
    /// The demo login username written to the new config.
    pub username: String,
    /// The demo login password written to the new config.
    pub password: String,
}

/// Creates the conventional server config without overwriting an existing file.
///
/// Only `redoor server` should call this so first-run credentials appear from a single,
/// intentional entry point. The starter user's per-user `account.json` and `agents.json` are
/// created by server startup next to the data directory.
pub async fn create_default_config_if_missing(path: &Path) -> Result<Option<CreatedDefaultConfig>> {
    if tokio::fs::try_exists(path).await? {
        return Ok(None);
    }

    let parent = path
        .parent()
        .with_context(|| format!("Default config path '{}' has no parent", path.display()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("Failed to create config directory '{}'", parent.display()))?;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = match options.open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to create default config '{}'", path.display()));
        }
    };
    let content = default_config_content();
    file.write_all(content.as_bytes())
        .await
        .with_context(|| format!("Failed to write default config '{}'", path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("Failed to sync default config '{}'", path.display()))?;
    Ok(Some(CreatedDefaultConfig {
        // Fixed and printed once so the first sign-in needs nothing but this output.
        username: "redoor".to_string(),
        password: "changeme".to_string(),
    }))
}

/// Returns the default agent name for a local entry: the system hostname.
/// Using the hostname (rather than e.g. `"local"`) means multiple servers on
/// different machines each spawn a local agent with a distinct, meaningful
/// name without the operator having to configure it. The server imports this
/// helper so the name it shows matches the one the spawned agent registers with.
pub fn default_local_agent_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "local".to_string())
}
