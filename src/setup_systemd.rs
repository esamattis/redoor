//! Installs Redoor as a systemd service.
//!
//! Non-root installs a lingering user unit under `~/.config/systemd/user`.
//! Root installs a system unit under `/etc/systemd/system`: the server runs as
//! a dedicated `redoor` system user, while the agent stays root so it can manage
//! the host.

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

/// Configures and starts the requested systemd service for the current privileges.
pub(crate) async fn run(args: SetupSystemdArgs) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
        bail!("systemd setup is only supported on Linux");
    }

    #[cfg(target_os = "linux")]
    {
        if nix::unistd::Uid::effective().is_root() {
            run_system(args.mode).await
        } else {
            run_user(args.mode).await
        }
    }
}

/// Installs a lingering systemd user unit owned by the invoking account.
#[cfg(target_os = "linux")]
async fn run_user(mode: SystemdMode) -> Result<()> {
    let config_path = crate::server::default_config_path()?;
    prepare_config(mode, &config_path).await?;

    let binary = tokio::fs::canonicalize(std::env::current_exe()?)
        .await
        .context("Failed to resolve the current redoor executable")?;
    let unit_content = render_unit(mode, &binary, &config_path, false);
    let home = home_directory()?;
    let unit_directory = home.join(".config/systemd/user");
    tokio::fs::create_dir_all(&unit_directory)
        .await
        .with_context(|| {
            format!(
                "Failed to create systemd user directory '{}'",
                unit_directory.display()
            )
        })?;
    let unit_path = unit_directory.join(mode.service_name());
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
        &["--user", "enable", "--now", mode.service_name()],
    )
    .await
    .with_context(|| {
        format!(
            "Failed to enable and start {} in the systemd user manager",
            mode.service_name()
        )
    })?;

    print_manage_help(mode.service_name(), &unit_path, true);
    Ok(())
}

/// Installs a system unit: server as the `redoor` user, agent as root.
#[cfg(target_os = "linux")]
async fn run_system(mode: SystemdMode) -> Result<()> {
    let config_path = crate::server::default_config_path()?;
    prepare_config(mode, &config_path).await?;

    if mode == SystemdMode::Server {
        // Dedicated account so the listening server is not a long-lived root process.
        ensure_redoor_system_user().await?;
        // Config is 0600 from bootstrap; the service user must own it to read secrets.
        chown_path_to_redoor(config_path.parent().unwrap()).await?;
        chown_path_to_redoor(&config_path).await?;
    }

    let binary = tokio::fs::canonicalize(std::env::current_exe()?)
        .await
        .context("Failed to resolve the current redoor executable")?;
    let unit_content = render_unit(mode, &binary, &config_path, true);
    let unit_directory = PathBuf::from("/etc/systemd/system");
    let unit_path = unit_directory.join(mode.service_name());
    tokio::fs::write(&unit_path, unit_content)
        .await
        .with_context(|| format!("Failed to write unit '{}'", unit_path.display()))?;

    run_command("systemctl", &["daemon-reload"])
        .await
        .context("Failed to reload systemd after writing the service")?;
    run_command("systemctl", &["enable", "--now", mode.service_name()])
        .await
        .with_context(|| {
            format!(
                "Failed to enable and start {} in the system manager",
                mode.service_name()
            )
        })?;

    print_manage_help(mode.service_name(), &unit_path, false);
    Ok(())
}

/// Prints how to control the installed unit after a successful setup.
fn print_manage_help(service: &str, unit_path: &Path, user: bool) {
    let flag = if user { " --user" } else { "" };
    println!(
        "Configured and started {service} at {}",
        unit_path.display()
    );
    println!(
        "
Manage the service:
  systemctl{flag} start {service}
  systemctl{flag} stop {service}
  systemctl{flag} enable {service}
  systemctl{flag} disable {service}
  journalctl{flag} -u {service} -f   # follow logs"
    );
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
#[cfg(target_os = "linux")]
async fn current_username() -> Result<String> {
    let uid = nix::unistd::Uid::effective();
    tokio::task::spawn_blocking(move || nix::unistd::User::from_uid(uid))
        .await
        .context("Failed to join current-user lookup task")??
        .with_context(|| format!("No system user exists for effective UID {uid}"))
        .map(|user| user.name)
}

/// Creates the unprivileged `redoor` system account used by the server unit.
#[cfg(target_os = "linux")]
async fn ensure_redoor_system_user() -> Result<()> {
    let existing = tokio::task::spawn_blocking(|| nix::unistd::User::from_name("redoor"))
        .await
        .context("Failed to join redoor user lookup task")?
        .context("Failed to look up the redoor system user")?;
    if existing.is_some() {
        return Ok(());
    }

    // System account with a private home for session files; nologin keeps it non-interactive.
    run_command(
        "useradd",
        &[
            "--system",
            "--home-dir",
            "/var/lib/redoor",
            "--create-home",
            "--shell",
            "/usr/sbin/nologin",
            "--user-group",
            "redoor",
        ],
    )
    .await
    .context("Failed to create the redoor system user")?;
    Ok(())
}

/// Gives the `redoor` service account ownership so it can read 0600 config secrets.
#[cfg(target_os = "linux")]
async fn chown_path_to_redoor(path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let user = nix::unistd::User::from_name("redoor")
            .context("Failed to look up the redoor system user")?
            .context("redoor system user is missing after ensure_redoor_system_user")?;
        // std chown avoids enabling nix's fs feature solely for ownership transfer.
        std::os::unix::fs::chown(&path, Some(user.uid.as_raw()), Some(user.gid.as_raw()))
            .with_context(|| {
                format!(
                    "Failed to chown '{}' to redoor (uid={}, gid={})",
                    path.display(),
                    user.uid,
                    user.gid
                )
            })
    })
    .await
    .context("Failed to join chown task")?
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

/// Renders a user or system unit. The agent has no CLI flags — the TOML is authoritative.
fn render_unit(mode: SystemdMode, binary: &Path, config_path: &Path, system: bool) -> String {
    let binary = quote_unit_argument(binary.to_string_lossy().as_ref());
    let config_path = quote_unit_argument(config_path.to_string_lossy().as_ref());
    let (description, command) = match mode {
        // Bare `agent` assumes the conventional config path is fully configured.
        SystemdMode::Agent => ("Redoor agent", format!("{binary} agent")),
        SystemdMode::Server => (
            "Redoor server",
            format!("{binary} server --config {config_path}"),
        ),
    };
    // System server drops privileges; system agent stays root for host management.
    let service_identity = match (system, mode) {
        (true, SystemdMode::Server) => "User=redoor\nGroup=redoor\n",
        _ => "",
    };
    let wanted_by = if system {
        "multi-user.target"
    } else {
        "default.target"
    };

    format!(
        "[Unit]
Description={description}
Wants=network-online.target
After=network-online.target

[Service]
{service_identity}ExecStart={command}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy={wanted_by}
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
            false,
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
        assert!(
            unit.contains("WantedBy=default.target"),
            "user units should install under default.target: {unit}"
        );
        assert!(
            !unit.contains("User="),
            "user agent units must not set User=: {unit}"
        );
    }

    /// Verifies server units explicitly pin the config used during setup.
    #[test]
    fn server_unit_uses_default_config_path() {
        let unit = render_unit(
            SystemdMode::Server,
            Path::new("/home/test/bin/redoor"),
            Path::new("/home/test/.config/redoor/config.toml"),
            false,
        );

        assert!(
            unit.contains(
                "ExecStart=\"/home/test/bin/redoor\" server --config \"/home/test/.config/redoor/config.toml\""
            ),
            "the service should run the selected binary with the prepared config"
        );
    }

    /// Verifies system server units drop privileges to the dedicated redoor account.
    #[test]
    fn system_server_unit_runs_as_redoor() {
        let unit = render_unit(
            SystemdMode::Server,
            Path::new("/usr/local/bin/redoor"),
            Path::new("/etc/redoor/config.toml"),
            true,
        );

        assert!(
            unit.contains("User=redoor\nGroup=redoor\n"),
            "system server must not stay root: {unit}"
        );
        assert!(
            unit.contains(
                "ExecStart=\"/usr/local/bin/redoor\" server --config \"/etc/redoor/config.toml\""
            ),
            "system server should pin /etc/redoor/config.toml: {unit}"
        );
        assert!(
            unit.contains("WantedBy=multi-user.target"),
            "system units should install under multi-user.target: {unit}"
        );
    }

    /// Verifies system agent units stay root and still take settings from TOML only.
    #[test]
    fn system_agent_unit_runs_as_root_without_cli_flags() {
        let unit = render_unit(
            SystemdMode::Agent,
            Path::new("/usr/local/bin/redoor"),
            Path::new("/etc/redoor/config.toml"),
            true,
        );

        assert!(
            !unit.contains("User="),
            "system agent should inherit root from the system manager: {unit}"
        );
        assert!(
            unit.contains("ExecStart=\"/usr/local/bin/redoor\" agent\n"),
            "system agent must start bare so /etc/redoor config is authoritative: {unit}"
        );
        assert!(
            unit.contains("WantedBy=multi-user.target"),
            "system units should install under multi-user.target: {unit}"
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
