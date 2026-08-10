//! Installs Redoor as a systemd service.
//!
//! Non-root installs a lingering user unit under `~/.config/systemd/user`.
//! Root installs a system unit under `/etc/systemd/system`: the server runs as
//! a dedicated `redoor` system user, while the agent stays root so it can manage
//! the host.

#[cfg(any(target_os = "linux", test))]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::{Result, bail};
use clap::{Args, Subcommand};
#[cfg(target_os = "linux")]
use tokio::process::Command;

use crate::ServiceRole;

/// Arguments for role-scoped `redoor agent|server systemd` service management.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct SystemdArgs {
    /// Selects the systemd operation while keeping service targeting consistent.
    #[command(subcommand)]
    command: SystemdCommand,
}

/// Operations supported for an installed Redoor systemd service.
#[derive(Subcommand)]
enum SystemdCommand {
    /// Install the unit and its starter configuration without starting it.
    Setup(ServiceArgs),
    /// Start the installed unit.
    Start(ServiceArgs),
    /// Stop the installed unit.
    Stop(ServiceArgs),
    /// Reload unit definitions and restart the installed unit.
    Restart(ServiceArgs),
    /// Print the unit journal without invoking a pager.
    Logs(LogsArgs),
    /// Show the current unit status without invoking a pager.
    Status(ServiceArgs),
    /// Enable the installed unit without starting it.
    Enable(ServiceArgs),
}

/// Identifies which Redoor unit an operation should manage.
#[derive(Args)]
struct ServiceArgs {
    /// Override the systemd unit file name (default: <app-name>-agent/server.service).
    ///
    /// Lets multiple agent or server installs coexist on one host. A missing
    /// `.service` suffix is appended automatically.
    #[arg(long)]
    unit_name: Option<String>,
}

/// Options for printing or following a systemd unit journal.
#[derive(Args)]
struct LogsArgs {
    /// Common service selection options.
    #[command(flatten)]
    service: ServiceArgs,
    /// Continue printing new journal entries until interrupted.
    #[arg(short = 'f', long)]
    follow: bool,
}

/// Resolves the unit file name, appending `.service` when the operator omitted it.
#[cfg(any(target_os = "linux", test))]
fn resolve_unit_name(role: ServiceRole, unit_name: Option<String>) -> Result<String> {
    let name = match unit_name {
        Some(name) => name,
        None => format!(
            "{}-{}.service",
            crate::app_name::app_name()?,
            role.cli_name()
        ),
    };
    let name = name.trim();
    if name.is_empty() {
        bail!("--unit-name must not be empty");
    }
    // Reject path separators so the name cannot escape the unit directory.
    if name.contains('/') || name.contains('\\') {
        bail!("--unit-name must be a bare unit name, not a path");
    }
    if name.ends_with(".service") {
        Ok(name.to_owned())
    } else {
        Ok(format!("{name}.service"))
    }
}

/// Runs one systemd operation against the unit scope implied by current privileges.
pub(crate) async fn run(args: SystemdArgs, role: ServiceRole) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (args, role);
        bail!("systemd commands are only supported on Linux");
    }

    #[cfg(target_os = "linux")]
    {
        match args.command {
            SystemdCommand::Setup(service) => setup(service, role).await,
            SystemdCommand::Start(service) => manage_unit(service, role, UnitAction::Start).await,
            SystemdCommand::Stop(service) => manage_unit(service, role, UnitAction::Stop).await,
            SystemdCommand::Restart(service) => {
                manage_unit(service, role, UnitAction::Restart).await
            }
            SystemdCommand::Logs(logs) => {
                manage_unit(
                    logs.service,
                    role,
                    UnitAction::Logs {
                        follow: logs.follow,
                    },
                )
                .await
            }
            SystemdCommand::Status(service) => manage_unit(service, role, UnitAction::Status).await,
            SystemdCommand::Enable(service) => manage_unit(service, role, UnitAction::Enable).await,
        }
    }
}

/// Installs and enables the requested service using the original setup behavior.
#[cfg(target_os = "linux")]
async fn setup(args: ServiceArgs, role: ServiceRole) -> Result<()> {
    let unit_name = resolve_unit_name(role, args.unit_name)?;
    if nix::unistd::Uid::effective().is_root() {
        run_system(role, &unit_name).await
    } else {
        run_user(role, &unit_name).await
    }
}

/// Supported direct systemctl and journalctl shortcuts.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum UnitAction {
    Start,
    Stop,
    Restart,
    Logs { follow: bool },
    Status,
    Enable,
}

/// Executes a shortcut with `--user` for non-root callers and system scope for root.
#[cfg(target_os = "linux")]
async fn manage_unit(args: ServiceArgs, role: ServiceRole, action: UnitAction) -> Result<()> {
    let service = resolve_unit_name(role, args.unit_name)?;
    let user = !nix::unistd::Uid::effective().is_root();
    let flag: &[&str] = if user { &["--user"] } else { &[] };
    ensure_unit_exists(&service, role, user, flag).await?;

    if matches!(action, UnitAction::Restart) {
        let mut reload = flag.to_vec();
        reload.push("daemon-reload");
        run_command("systemctl", &reload)
            .await
            .context("Failed to reload systemd before restarting the service")?;
    }

    let (program, mut arguments) = match action {
        UnitAction::Start => ("systemctl", flag.to_vec()),
        UnitAction::Stop => ("systemctl", flag.to_vec()),
        UnitAction::Restart => ("systemctl", flag.to_vec()),
        UnitAction::Enable => ("systemctl", flag.to_vec()),
        UnitAction::Logs { follow } => {
            let mut arguments = flag.to_vec();
            arguments.extend(["--no-pager", "-n", "500"]);
            if follow {
                arguments.push("-f");
            }
            arguments.extend(["-u", service.as_str()]);
            return run_command_inherited("journalctl", &arguments).await;
        }
        UnitAction::Status => {
            let mut arguments = flag.to_vec();
            arguments.extend(["status", "--no-pager", service.as_str()]);
            return run_command_inherited("systemctl", &arguments).await;
        }
    };
    let verb = match action {
        UnitAction::Start => "start",
        UnitAction::Stop => "stop",
        UnitAction::Restart => "restart",
        UnitAction::Enable => "enable",
        UnitAction::Logs { .. } | UnitAction::Status => {
            unreachable!("logs and status return before systemctl dispatch")
        }
    };
    arguments.extend([verb, service.as_str()]);
    run_command(program, &arguments).await
}

/// Checks systemd's load state so journal and control shortcuts fail clearly for absent units.
#[cfg(target_os = "linux")]
async fn ensure_unit_exists(
    service: &str,
    mode: ServiceRole,
    user: bool,
    flag: &[&str],
) -> Result<()> {
    let mut arguments = flag.to_vec();
    arguments.extend(["show", "--property=LoadState", "--value", service]);
    let output = Command::new("systemctl")
        .args(&arguments)
        .output()
        .await
        .context("Failed to ask systemd whether the requested unit exists")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "Failed to check whether systemd unit '{service}' exists: {}",
            stderr.trim()
        );
    }

    let load_state = String::from_utf8_lossy(&output.stdout);
    validate_unit_load_state(service, mode, user, load_state.trim())
}

/// Turns systemd's `not-found` load state into an actionable Redoor error.
#[cfg(any(target_os = "linux", test))]
fn validate_unit_load_state(
    service: &str,
    mode: ServiceRole,
    user: bool,
    load_state: &str,
) -> Result<()> {
    if load_state != "not-found" && !load_state.is_empty() {
        return Ok(());
    }

    let scope = if user { "user" } else { "system" };
    bail!(
        "Systemd {scope} unit '{service}' does not exist. Install it first with: redoor {} systemd setup --unit-name {service}",
        mode.cli_name()
    )
}

/// Installs a lingering systemd user unit owned by the invoking account.
#[cfg(target_os = "linux")]
async fn run_user(mode: ServiceRole, unit_name: &str) -> Result<()> {
    let app_name = crate::app_name::app_name()?;
    let config_path = crate::config::default_config_path()?;
    let config_created = prepare_config(mode, &config_path).await?;

    let binary = tokio::fs::canonicalize(std::env::current_exe()?)
        .await
        .context("Failed to resolve the current redoor executable")?;
    let unit_content = render_unit(mode, &binary, &config_path, false, &app_name);
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
    let unit_path = unit_directory.join(unit_name);
    tokio::fs::write(&unit_path, unit_content)
        .await
        .with_context(|| format!("Failed to write unit '{}'", unit_path.display()))?;

    let username = current_username().await?;
    run_command("loginctl", &["enable-linger", &username])
        .await
        .context("Failed to enable user lingering; the service would stop when you log out")?;
    // Enable on boot only — never start here so the operator can review config first.
    activate_unit(unit_name, true).await?;

    print_manage_help(unit_name, &unit_path, &config_path, config_created, mode);
    Ok(())
}

/// Installs a system unit: server as the `redoor` user, agent as root.
#[cfg(target_os = "linux")]
async fn run_system(mode: ServiceRole, unit_name: &str) -> Result<()> {
    let app_name = crate::app_name::app_name()?;
    let config_path = crate::config::default_config_path()?;
    let config_created = prepare_config(mode, &config_path).await?;

    if mode == ServiceRole::Server {
        // Dedicated account so the listening server is not a long-lived root process.
        ensure_redoor_system_user().await?;
        // Config is 0600 from bootstrap; the service user must own it to read secrets.
        chown_path_to_redoor(config_path.parent().unwrap()).await?;
        chown_path_to_redoor(&config_path).await?;
    }

    // Pre-create the conventional system log directory so the `redoor` service
    // user can open log files even when the agent unit (root) created the tree.
    ensure_system_log_directory().await?;

    let binary = tokio::fs::canonicalize(std::env::current_exe()?)
        .await
        .context("Failed to resolve the current redoor executable")?;
    let unit_content = render_unit(mode, &binary, &config_path, true, &app_name);
    let unit_directory = PathBuf::from("/etc/systemd/system");
    let unit_path = unit_directory.join(unit_name);
    tokio::fs::write(&unit_path, unit_content)
        .await
        .with_context(|| format!("Failed to write unit '{}'", unit_path.display()))?;

    // Enable on boot only — never start here so the operator can review config first.
    activate_unit(unit_name, false).await?;

    print_manage_help(unit_name, &unit_path, &config_path, config_created, mode);
    Ok(())
}

/// Reloads systemd, drops any previously running instance, then enables on boot without starting.
///
/// `daemon-reload` is required after every unit rewrite so systemd does not keep
/// the old in-memory definition. Stopping first ensures a prior process cannot
/// stay active with a stale binary or unit after setup rewrites the file.
#[cfg(target_os = "linux")]
async fn activate_unit(service: &str, user: bool) -> Result<()> {
    let flag: &[&str] = if user { &["--user"] } else { &[] };

    let mut reload = flag.to_vec();
    reload.push("daemon-reload");
    run_command("systemctl", &reload).await.with_context(|| {
        if user {
            "Failed to reload the systemd user manager after writing the service".to_string()
        } else {
            "Failed to reload systemd after writing the service".to_string()
        }
    })?;

    // Harmless when the unit is already inactive; required so an older install
    // cannot keep running after the unit file on disk has changed.
    let mut stop = flag.to_vec();
    stop.extend(["stop", service]);
    run_command("systemctl", &stop)
        .await
        .with_context(|| format!("Failed to stop previous {service} after writing the unit"))?;

    let mut enable = flag.to_vec();
    enable.extend(["enable", service]);
    run_command("systemctl", &enable)
        .await
        .with_context(|| format!("Failed to enable {service} on boot"))?;
    Ok(())
}

/// Creates the selected `/var/log/<app-name>` and hands ownership to `redoor` when available.
#[cfg(target_os = "linux")]
async fn ensure_system_log_directory() -> Result<()> {
    let log_directory = crate::config::default_log_directory()?;
    tokio::fs::create_dir_all(&log_directory)
        .await
        .with_context(|| {
            format!(
                "Failed to create system log directory '{}'",
                log_directory.display()
            )
        })?;

    let redoor_exists = tokio::task::spawn_blocking(|| nix::unistd::User::from_name("redoor"))
        .await
        .context("Failed to join redoor user lookup task")?
        .context("Failed to look up the redoor system user")?
        .is_some();
    if redoor_exists {
        // Server units drop to `redoor` and must be able to create/append logs here.
        chown_path_to_redoor(&log_directory).await?;
    }
    Ok(())
}

/// Prints how to control the installed unit after a successful setup.
#[cfg(target_os = "linux")]
fn print_manage_help(
    service: &str,
    unit_path: &Path,
    config_path: &Path,
    config_created: bool,
    mode: ServiceRole,
) {
    println!(
        "Wrote unit {service} at {} and enabled it on boot (not started).",
        unit_path.display()
    );
    if config_created {
        println!(
            "Created config at {}.\nEdit it before starting the service.",
            config_path.display()
        );
        if mode == ServiceRole::Agent {
            println!("The [agent] section probably needs to be changed (token, ws_address).");
        }
    } else {
        println!("Config: {}", config_path.display());
    }
    println!(
        "
Start when ready:
  redoor {} systemd start --unit-name {service}

Manage the service:
  redoor {} systemd start --unit-name {service}
  redoor {} systemd stop --unit-name {service}
  redoor {} systemd restart --unit-name {service}
  redoor {} systemd status --unit-name {service}
  redoor {} systemd logs --unit-name {service}   # file logs are configured in config.toml",
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name()
    );
}

/// Returns the conventional home directory required by user services and config.
#[cfg(target_os = "linux")]
fn home_directory() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot locate the systemd user or Redoor config directories")
}

/// Ensures setup has the shared config. Returns whether a new starter file was written.
///
/// Server setup generates a starter file, while agent setup imports the server's config.
#[cfg(target_os = "linux")]
async fn prepare_config(mode: ServiceRole, config_path: &Path) -> Result<bool> {
    if tokio::fs::try_exists(config_path)
        .await
        .with_context(|| format!("Failed to inspect config '{}'", config_path.display()))?
    {
        validate_existing_config(mode, config_path).await?;
        return Ok(false);
    }

    if mode == ServiceRole::Agent {
        let imported_path = crate::config::import_agent_config_from_stdin(config_path).await?;
        validate_existing_config(mode, &imported_path).await?;
        return Ok(false);
    }

    let created = crate::config::create_default_config_if_missing(config_path).await?;

    if let Some(created) = created {
        if let Some(password) = created.password {
            println!(
                "Created config at {}\nusername password: {}\nagent_token: {}\nStore these secrets securely; they will not be shown again.",
                config_path.display(),
                password,
                created.agent_token
            );
        } else {
            println!(
                "Created config at {}\nagent_token: {}\nStore this secret securely; it will not be shown again.",
                config_path.display(),
                created.agent_token
            );
        }
        Ok(true)
    } else {
        // Another setup may have won the create-new race after our existence check.
        validate_existing_config(mode, config_path).await?;
        Ok(false)
    }
}

/// Rejects incomplete configs before writing a unit that assumes the TOML is enough.
#[cfg(target_os = "linux")]
async fn validate_existing_config(mode: ServiceRole, config_path: &Path) -> Result<()> {
    let config = crate::config::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config '{}'", config_path.display()))?;
    match mode {
        ServiceRole::Agent => {
            if !crate::config::standalone_agent_is_fully_configured(&config) {
                bail!(
                    "config '{}' is missing required standalone agent settings; set top-level agent_token plus [agent] ws_address so the service can start without CLI flags",
                    config_path.display()
                );
            }
        }
        ServiceRole::Server => {
            crate::config::require_server_section(&config)?;
        }
    }
    Ok(())
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
#[cfg(target_os = "linux")]
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

/// Runs an interactive command with inherited streams for continuous journal output.
#[cfg(target_os = "linux")]
async fn run_command_inherited(program: &str, arguments: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(arguments)
        .status()
        .await
        .with_context(|| format!("Failed to run {program}"))?;
    if status.success() {
        Ok(())
    } else {
        bail!("{} {} failed with {}", program, arguments.join(" "), status)
    }
}

/// Renders a user or system unit. The agent has no CLI flags — the TOML is authoritative.
#[cfg(any(target_os = "linux", test))]
fn render_unit(
    mode: ServiceRole,
    binary: &Path,
    config_path: &Path,
    system: bool,
    app_name: &str,
) -> String {
    let binary = quote_unit_argument(binary.to_string_lossy().as_ref());
    let config_path = quote_unit_argument(config_path.to_string_lossy().as_ref());
    let app_environment = quote_unit_argument(&format!("REDOOR_APP_NAME={app_name}"));
    let (description, command) = match mode {
        // Pin --config so the unit always loads the file prepared during setup.
        ServiceRole::Agent => (
            "Redoor agent",
            format!("{binary} agent --config {config_path}"),
        ),
        ServiceRole::Server => (
            "Redoor server",
            format!("{binary} server --config {config_path}"),
        ),
    };
    // System server drops privileges; system agent stays root for host management.
    let service_identity = match (system, mode) {
        (true, ServiceRole::Server) => "User=redoor\nGroup=redoor\n",
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
Type=notify
{service_identity}Environment={app_environment}
ExecStart={command}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy={wanted_by}
"
    )
}

/// Quotes one systemd command argument and escapes `%` specifier expansion.
#[cfg(any(target_os = "linux", test))]
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
    use super::{
        ServiceRole, quote_unit_argument, render_unit, resolve_unit_name, validate_unit_load_state,
    };
    use std::path::Path;

    /// Verifies default and overridden unit names, including automatic .service suffix.
    #[test]
    fn resolve_unit_name_defaults_and_normalizes() {
        let app_name = crate::app_name::app_name().unwrap();
        assert_eq!(
            resolve_unit_name(ServiceRole::Agent, None).unwrap(),
            format!("{app_name}-agent.service"),
            "the default agent unit should use the effective application namespace"
        );
        assert_eq!(
            resolve_unit_name(ServiceRole::Server, None).unwrap(),
            format!("{app_name}-server.service"),
            "the default server unit should use the effective application namespace"
        );
        assert_eq!(
            resolve_unit_name(ServiceRole::Agent, Some("edge-agent".into())).unwrap(),
            "edge-agent.service",
            "missing .service should be appended"
        );
        assert_eq!(
            resolve_unit_name(ServiceRole::Server, Some("redoor-api.service".into())).unwrap(),
            "redoor-api.service",
            "explicit .service should be kept"
        );
        assert!(
            resolve_unit_name(ServiceRole::Agent, Some("../escape".into())).is_err(),
            "path components must be rejected"
        );
        assert!(
            resolve_unit_name(ServiceRole::Agent, Some("  ".into())).is_err(),
            "blank names must be rejected"
        );
    }

    /// Verifies absent units produce a clear error with the correct scope and setup command.
    #[test]
    fn missing_unit_load_state_has_actionable_error() {
        let error = validate_unit_load_state(
            "custom-agent.service",
            ServiceRole::Agent,
            true,
            "not-found",
        )
        .unwrap_err()
        .to_string();

        assert!(
            error.contains("Systemd user unit 'custom-agent.service' does not exist"),
            "the error must identify the missing unit and user scope: {error}"
        );
        assert!(
            error.contains("redoor agent systemd setup"),
            "the error must explain how to install the expected unit: {error}"
        );
        assert!(
            validate_unit_load_state(
                "redoor-server.service",
                ServiceRole::Server,
                false,
                "loaded"
            )
            .is_ok(),
            "a loaded unit must allow the requested management action"
        );
    }

    /// Verifies agent units pin the prepared config and take no other CLI overrides.
    #[test]
    fn agent_unit_pins_config_without_other_cli_flags() {
        let unit = render_unit(
            ServiceRole::Agent,
            Path::new("/home/test user/bin/redoor"),
            Path::new("/home/test user/.config/redoor/config.toml"),
            false,
            "redoor",
        );

        assert!(
            unit.contains(
                "ExecStart=\"/home/test user/bin/redoor\" agent --config \"/home/test user/.config/redoor/config.toml\""
            ),
            "the agent service must pin the prepared config path: {unit}"
        );
        assert!(
            !unit.contains("--token") && !unit.contains("--name"),
            "agent connection settings must come from the TOML file, not the unit: {unit}"
        );
        assert!(
            unit.contains("Environment=\"REDOOR_APP_NAME=redoor\""),
            "the unit must preserve the application namespace selected during setup: {unit}"
        );
        assert!(
            unit.contains("WantedBy=default.target"),
            "user units should install under default.target: {unit}"
        );
        assert!(
            !unit.contains("User="),
            "user agent units must not set User=: {unit}"
        );
        assert!(
            unit.contains("Type=notify"),
            "agent services must wait for the websocket readiness notification: {unit}"
        );
    }

    /// Verifies server units explicitly pin the config used during setup.
    #[test]
    fn server_unit_uses_default_config_path() {
        let unit = render_unit(
            ServiceRole::Server,
            Path::new("/home/test/bin/redoor"),
            Path::new("/home/test/.config/redoor/config.toml"),
            false,
            "redoor-dev",
        );

        assert!(
            unit.contains(
                "ExecStart=\"/home/test/bin/redoor\" server --config \"/home/test/.config/redoor/config.toml\""
            ),
            "the service should run the selected binary with the prepared config"
        );
        assert!(
            unit.contains("Type=notify"),
            "server services must wait for the listener readiness notification: {unit}"
        );
        assert!(
            unit.contains("Environment=\"REDOOR_APP_NAME=redoor-dev\""),
            "custom application namespaces must survive service-manager startup: {unit}"
        );
    }

    /// Verifies system server units drop privileges to the dedicated redoor account.
    #[test]
    fn system_server_unit_runs_as_redoor() {
        let unit = render_unit(
            ServiceRole::Server,
            Path::new("/usr/local/bin/redoor"),
            Path::new("/etc/redoor/config.toml"),
            true,
            "redoor",
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

    /// Verifies system agent units stay root and pin /etc/redoor config.
    #[test]
    fn system_agent_unit_runs_as_root_with_config_path() {
        let unit = render_unit(
            ServiceRole::Agent,
            Path::new("/usr/local/bin/redoor"),
            Path::new("/etc/redoor/config.toml"),
            true,
            "redoor",
        );

        assert!(
            !unit.contains("User="),
            "system agent should inherit root from the system manager: {unit}"
        );
        assert!(
            unit.contains(
                "ExecStart=\"/usr/local/bin/redoor\" agent --config \"/etc/redoor/config.toml\""
            ),
            "system agent should pin /etc/redoor/config.toml: {unit}"
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
