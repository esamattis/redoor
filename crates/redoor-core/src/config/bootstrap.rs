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
/// Matches the README shape: top-level token, commented listener options, PAM or
/// demo credentials, and one managed local agent so a fresh install is demoable.
fn default_config_content(agent_token: &str) -> String {
    let agent_token = toml_edit::Value::from(agent_token).to_string();
    // Written up front so the first start does not have to rewrite the fresh file.
    let local_agent_id = redoor_protocol::ids::AgentId::generate();
    // `[server.pam]` is a sub-table, so it has to follow every plain `[server]` key.
    #[cfg(target_os = "linux")]
    let (credentials, pam) = (
        "# Web UI login: see [server.pam] and [[server.users]] below.\n",
        concat!(
            "\n",
            "# Sign in with the system password of the user running the server.\n",
            "[server.pam]\n",
            "enabled = true\n",
            "\n",
            "# Password logins, one entry per person:\n",
            "# [[server.users]]\n",
            "# name = \"admin\"\n",
            "# password = \"long-private-password\"\n",
        ),
    );
    #[cfg(not(target_os = "linux"))]
    let (credentials, pam) = (
        concat!("username = \"redoor\"\n", "password = \"changeme\"\n",),
        "",
    );
    #[cfg(target_os = "linux")]
    let header = "# A random agent_token was generated on first start.\n# Browser login uses PAM with your Linux account credentials.";
    #[cfg(not(target_os = "linux"))]
    let header = "# A random agent_token was generated on first start.\n# Browser login uses username redoor and password changeme.";
    format!(
        r#"# Redoor configuration
{header}
# agent_token is the shared secret between the server and agents.

agent_token = {agent_token}

[server]
{credentials}
# port = 7666
# bind = "0.0.0.0" # default 127.0.0.1
# cookie_secure = false # set true behind an HTTPS reverse proxy
# mcp_allowed_origins = ["https://client.example"] # browser MCP clients only
# log_format = "line" # use "json" for newline-delimited JSON output
{pam}
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
    /// Present only when the starter config embeds a dedicated login password.
    pub password: Option<String>,
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
    // Non-Linux embeds fixed demo credentials because PAM is unavailable there.
    let password: Option<String> = {
        #[cfg(target_os = "linux")]
        {
            None
        }
        #[cfg(not(target_os = "linux"))]
        {
            Some("changeme".to_string())
        }
    };
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
        password,
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
