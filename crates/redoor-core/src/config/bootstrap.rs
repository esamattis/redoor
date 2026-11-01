//! First-run configuration bootstrap and host-derived defaults.

use anyhow::{Context, Result};
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// Generates a high-entropy secret for bootstrap agent tokens from the OS CSPRNG.
fn generate_secret() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow::anyhow!("Failed to read OS randomness: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Renders the minimal starter config written only by `redoor server` on first run.
///
/// Matches the README shape: top-level token, commented listener options, demo
/// credentials, and one managed local agent so a fresh install is demoable.
fn default_config_content(agent_token: &str) -> String {
    let agent_token = toml_edit::Value::from(agent_token).to_string();
    // Written up front so the first start does not have to rewrite the fresh file.
    let local_agent_id = redoor_protocol::ids::AgentId::generate();
    format!(
        r#"# Redoor configuration
# A random agent_token was generated on first start.
# Browser login uses username redoor and password changeme.
# agent_token is the shared secret between the server and agents.

agent_token = {agent_token}

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

[[agents]]
# local agent that runs on the same computer as the server
id = "{local_agent_id}"
local = true
name = "local"
"#
    )
}

/// Bootstrap secrets printed once when a starter config is created.
pub struct CreatedDefaultConfig {
    /// The demo login password written to the new config.
    pub password: String,
    /// Generated shared registration secret written to the new config.
    pub agent_token: String,
}

/// Creates the conventional server config with a random token without overwriting an existing file.
///
/// Only `redoor server` should call this so first-run secrets and the local agent
/// entry appear from a single, intentional entry point.
pub async fn create_default_config_if_missing(path: &Path) -> Result<Option<CreatedDefaultConfig>> {
    if tokio::fs::try_exists(path).await? {
        return Ok(None);
    }

    let agent_token = generate_secret()?;
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
    let content = default_config_content(&agent_token);
    file.write_all(content.as_bytes())
        .await
        .with_context(|| format!("Failed to write default config '{}'", path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("Failed to sync default config '{}'", path.display()))?;
    Ok(Some(CreatedDefaultConfig {
        // Fixed and printed once so the first sign-in needs nothing but this output.
        password: "changeme".to_string(),
        agent_token,
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
