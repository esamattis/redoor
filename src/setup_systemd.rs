//! Installs Redoor as a systemd user service and enables it for login-independent startup.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

/// Arguments for `redoor setup-systemd`.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct SetupSystemdArgs {
    /// Install into the current non-root user's systemd manager.
    #[arg(long)]
    user: bool,
    /// Select whether the installed service runs the server or an agent.
    #[arg(long, value_enum)]
    mode: SystemdMode,
}

/// Redoor process role represented by the generated service.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum SystemdMode {
    /// Run the Redoor agent connected to the local default server address.
    Agent,
    /// Run the Redoor HTTP and WebSocket server.
    Server,
}

impl SystemdMode {
    /// Returns the loadable systemd service name for this process role.
    fn service_name(self) -> &'static str {
        match self {
            Self::Agent => "redoor-agent.service",
            Self::Server => "redoor-server.service",
        }
    }
}

/// Configures and starts the requested systemd user service.
pub(crate) async fn run(args: SetupSystemdArgs) -> Result<()> {
    if !args.user {
        bail!("system-wide setup is not implemented yet; pass --user");
    }
    #[cfg(not(target_os = "linux"))]
    bail!("systemd setup is only supported on Linux");

    #[cfg(target_os = "linux")]
    {
        if nix::unistd::Uid::effective().is_root() {
            bail!("--user must be run as the non-root user who will own the service");
        }

        let home = home_directory()?;
        let config_path = home.join(".config/redoor/config.toml");
        prepare_config(args.mode, &config_path).await?;

        let binary = tokio::fs::canonicalize(std::env::current_exe()?)
            .await
            .context("Failed to resolve the current redoor executable")?;
        let unit_content = render_unit(args.mode, &binary, &config_path);
        let unit_directory = home.join(".config/systemd/user");
        tokio::fs::create_dir_all(&unit_directory)
            .await
            .with_context(|| {
                format!(
                    "Failed to create systemd user directory '{}'",
                    unit_directory.display()
                )
            })?;
        let unit_path = unit_directory.join(args.mode.service_name());
        tokio::fs::write(&unit_path, unit_content)
            .await
            .with_context(|| format!("Failed to write unit '{}'", unit_path.display()))?;

        let username = current_username().await?;
        run_command("loginctl", &["enable-linger", &username])
            .await
            .context("Failed to enable user lingering; the service would stop when you log out")?;
        run_command("systemctl", &["--user", "daemon-reload"])
            .await
            .context("Failed to reload the systemd user manager after writing the service")?;
        run_command(
            "systemctl",
            &["--user", "enable", "--now", args.mode.service_name()],
        )
        .await
        .with_context(|| {
            format!(
                "Failed to enable and start {} in the systemd user manager",
                args.mode.service_name()
            )
        })?;

        let service = args.mode.service_name();
        println!(
            "Configured and started {service} at {}",
            unit_path.display()
        );
        println!(
            "
Manage the service:
  systemctl --user start {service}
  systemctl --user stop {service}
  systemctl --user enable {service}   # start at login/boot (linger already enabled)
  systemctl --user disable {service}
  journalctl --user -u {service} -f   # follow logs"
        );
        Ok(())
    }
}

/// Returns the conventional home directory required by user services and config.
fn home_directory() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot locate the systemd user or Redoor config directories")
}

/// Ensures setup has a shared config, prompting only when a new agent config needs a token.
async fn prepare_config(mode: SystemdMode, config_path: &Path) -> Result<()> {
    if tokio::fs::try_exists(config_path)
        .await
        .with_context(|| format!("Failed to inspect config '{}'", config_path.display()))?
    {
        validate_existing_config(mode, config_path).await?;
        return Ok(());
    }

    let supplied_token = match mode {
        SystemdMode::Agent => Some(prompt_agent_token().await?),
        SystemdMode::Server => None,
    };
    let created = crate::server::create_default_config_if_missing_with_options(
        config_path,
        supplied_token.as_deref(),
        mode == SystemdMode::Agent,
    )
    .await?;

    if let Some(created) = created {
        match mode {
            SystemdMode::Agent => {
                println!(
                    "Created agent config at {}\n[agent] defaults to ws://localhost:3000/ws and this host's name.\nEdit the file if the server is elsewhere, then restart the service.",
                    config_path.display()
                );
            }
            SystemdMode::Server => {
                if let Some(password) = created.password {
                    println!(
                        "Created server config at {}\nusername password: {}\nagent_token: {}\nStore these secrets securely; they will not be shown again.",
                        config_path.display(),
                        password,
                        created.agent_token
                    );
                } else {
                    println!(
                        "Created server config at {}\nagent_token: {}\nStore this secret securely; it will not be shown again.",
                        config_path.display(),
                        created.agent_token
                    );
                }
            }
        }
    } else {
        // Another setup may have won the create-new race after our existence check.
        validate_existing_config(mode, config_path).await?;
    }
    Ok(())
}

/// Rejects incomplete configs before writing a unit that assumes the TOML is enough.
async fn validate_existing_config(mode: SystemdMode, config_path: &Path) -> Result<()> {
    let config = crate::server::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config '{}'", config_path.display()))?;
    match mode {
        SystemdMode::Agent => {
            if !crate::server::standalone_agent_is_fully_configured(&config) {
                bail!(
                    "config '{}' is missing required standalone agent settings; set top-level agent_token plus [agent] ws_address and name so the service can start without CLI flags",
                    config_path.display()
                );
            }
        }
        SystemdMode::Server => {
            crate::server::require_server_section(&config)?;
        }
    }
    Ok(())
}

/// Reads the server's shared token interactively without accepting an empty value.
async fn prompt_agent_token() -> Result<String> {
    let mut stdout = tokio::io::stdout();
    stdout.write_all(b"Agent token: ").await?;
    stdout.flush().await?;

    let mut token = String::new();
    BufReader::new(tokio::io::stdin())
        .read_line(&mut token)
        .await
        .context("Failed to read the agent token")?;
    let token = token.trim().to_owned();
    if token.is_empty() {
        bail!("agent token must not be empty");
    }
    Ok(token)
}

/// Looks up the effective account name off the async runtime because NSS may block.
async fn current_username() -> Result<String> {
    let uid = nix::unistd::Uid::effective();
    tokio::task::spawn_blocking(move || nix::unistd::User::from_uid(uid))
        .await
        .context("Failed to join current-user lookup task")??
        .with_context(|| format!("No system user exists for effective UID {uid}"))
        .map(|user| user.name)
}

/// Runs one systemd administration command and preserves its diagnostic output on failure.
async fn run_command(program: &str, arguments: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(arguments)
        .output()
        .await
        .with_context(|| format!("Failed to run {program}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    bail!(
        "{} {} failed with {}: {}",
        program,
        arguments.join(" "),
        output.status,
        stderr.trim()
    )
}

/// Renders a user service. The agent unit has no CLI flags or env — the TOML is authoritative.
fn render_unit(mode: SystemdMode, binary: &Path, config_path: &Path) -> String {
    let binary = quote_unit_argument(binary.to_string_lossy().as_ref());
    let config_path = quote_unit_argument(config_path.to_string_lossy().as_ref());
    let (description, command) = match mode {
        // Bare `agent` assumes ~/.config/redoor/config.toml is fully configured.
        SystemdMode::Agent => ("Redoor agent", format!("{binary} agent")),
        SystemdMode::Server => (
            "Redoor server",
            format!("{binary} server --config {config_path}"),
        ),
    };

    format!(
        "[Unit]
Description={description}
Wants=network-online.target
After=network-online.target

[Service]
ExecStart={command}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
"
    )
}

/// Quotes one systemd command argument and escapes `%` specifier expansion.
fn quote_unit_argument(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

#[cfg(test)]
mod tests {
    use super::{SystemdMode, quote_unit_argument, render_unit};
    use std::path::Path;

    /// Verifies agent units rely entirely on the TOML file with no CLI overrides.
    #[test]
    fn agent_unit_has_no_cli_flags_or_env() {
        let unit = render_unit(
            SystemdMode::Agent,
            Path::new("/home/test user/bin/redoor"),
            Path::new("/home/test user/.config/redoor/config.toml"),
        );

        assert!(
            unit.contains("ExecStart=\"/home/test user/bin/redoor\" agent\n"),
            "the agent service must start with a bare `agent` subcommand: {unit}"
        );
        assert!(
            !unit.contains("--token")
                && !unit.contains("--name")
                && !unit.contains("--config")
                && !unit.contains("Environment="),
            "agent settings must come from the TOML file, not the unit: {unit}"
        );
    }

    /// Verifies server units explicitly pin the config used during setup.
    #[test]
    fn server_unit_uses_default_config_path() {
        let unit = render_unit(
            SystemdMode::Server,
            Path::new("/home/test/bin/redoor"),
            Path::new("/home/test/.config/redoor/config.toml"),
        );

        assert!(
            unit.contains(
                "ExecStart=\"/home/test/bin/redoor\" server --config \"/home/test/.config/redoor/config.toml\""
            ),
            "the service should run the selected binary with the prepared config"
        );
    }

    /// Verifies systemd specifiers cannot be injected through generated path arguments.
    #[test]
    fn unit_arguments_escape_specifiers() {
        assert_eq!(
            quote_unit_argument("/home/100%/redoor"),
            "\"/home/100%%/redoor\"",
            "percent signs should remain literal after systemd parses the unit"
        );
    }
}
