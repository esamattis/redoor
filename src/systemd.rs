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
use clap::Args;
#[cfg(target_os = "linux")]
use tokio::process::Command;

use crate::ServiceRole;
#[cfg(target_os = "linux")]
use crate::service_management::InstallArgs;
use crate::service_management::ServiceCommand;

/// Arguments for role-scoped `redoor agent|server systemd` service management.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct SystemdArgs {
    /// Selects the systemd operation while keeping service targeting consistent.
    #[command(subcommand)]
    command: ServiceCommand,
}

/// Derives the unit file name from the already validated installation identity.
#[cfg(any(target_os = "linux", test))]
fn unit_name(role: ServiceRole) -> Result<String> {
    Ok(format!(
        "{}-{}.service",
        crate::app_name::app_name()?,
        role.cli_name()
    ))
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
            ServiceCommand::Install(install_args) => install(install_args, role).await,
            ServiceCommand::Uninstall => uninstall(role).await,
            ServiceCommand::Start => manage_unit(role, UnitAction::Start).await,
            ServiceCommand::Stop => manage_unit(role, UnitAction::Stop).await,
            ServiceCommand::Restart => manage_unit(role, UnitAction::Restart).await,
            ServiceCommand::Status => manage_unit(role, UnitAction::Status).await,
            ServiceCommand::Enable => manage_unit(role, UnitAction::Enable).await,
            ServiceCommand::Disable(disable) => {
                manage_unit(role, UnitAction::Disable { now: disable.now }).await
            }
        }
    }
}

/// Installs and enables the requested service in the privilege-selected scope.
#[cfg(target_os = "linux")]
async fn install(args: InstallArgs, role: ServiceRole) -> Result<()> {
    let unit_name = unit_name(role)?;
    if nix::unistd::Uid::effective().is_root() {
        run_system(role, &unit_name, args.start).await
    } else {
        run_user(role, &unit_name, args.start).await
    }
}

/// Supported direct systemctl and journalctl shortcuts.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum UnitAction {
    Start,
    Stop,
    Restart,
    Status,
    Enable,
    Disable { now: bool },
}

/// Executes a shortcut with `--user` for non-root callers and system scope for root.
#[cfg(target_os = "linux")]
async fn manage_unit(role: ServiceRole, action: UnitAction) -> Result<()> {
    let service = unit_name(role)?;
    let user = !nix::unistd::Uid::effective().is_root();
    let flag: &[&str] = if user { &["--user"] } else { &[] };
    if matches!(action, UnitAction::Status) {
        return show_status(&service, user, flag).await;
    }
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
        UnitAction::Disable { .. } => ("systemctl", flag.to_vec()),
        UnitAction::Status => {
            unreachable!("status returns before installed-unit dispatch")
        }
    };
    let verb = match action {
        UnitAction::Start => "start",
        UnitAction::Stop => "stop",
        UnitAction::Restart => "restart",
        UnitAction::Enable => "enable",
        UnitAction::Disable { .. } => "disable",
        UnitAction::Status => unreachable!("status returns before systemctl dispatch"),
    };
    if matches!(action, UnitAction::Disable { now: true }) {
        arguments.push("--now");
    }
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
        "Systemd {scope} unit '{service}' is not installed. Install it with: redoor {} systemd install",
        mode.cli_name()
    )
}

/// Captures the concise state fields reported by `systemctl show`.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Eq, PartialEq)]
struct SystemdState {
    /// Reports whether systemd found a unit definition.
    loaded: bool,
    /// Reports the broad active state such as active, inactive, or failed.
    active: String,
    /// Adds the process-specific state such as running or exited.
    sub: String,
    /// Includes the main process ID only while systemd reports one.
    pid: Option<String>,
}

/// Parses key-value systemctl output independently of property order.
#[cfg(any(target_os = "linux", test))]
fn parse_systemd_state(output: &str) -> SystemdState {
    let property = |name: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .unwrap_or_default()
    };
    let pid = property("MainPID");
    SystemdState {
        loaded: !matches!(property("LoadState"), "" | "not-found"),
        active: property("ActiveState").to_string(),
        sub: property("SubState").to_string(),
        pid: (pid != "0" && !pid.is_empty()).then(|| pid.to_string()),
    }
}

/// Formats installation, enablement, and runtime state without systemctl verbosity.
#[cfg(any(target_os = "linux", test))]
fn format_status(
    service: &str,
    installed: bool,
    enabled: Option<bool>,
    state: &SystemdState,
) -> String {
    let runtime = match (state.pid.as_deref(), state.loaded) {
        (Some(pid), true) => format!("loaded, running, PID {pid}"),
        (_, true) => format!("loaded, stopped ({}/{})", state.active, state.sub),
        _ => "unloaded, stopped".to_string(),
    };
    if !installed {
        return if state.loaded {
            format!("Systemd unit '{service}': not installed, {runtime}")
        } else {
            format!("Systemd unit '{service}': not installed")
        };
    }
    let enabled = match enabled {
        Some(true) => "enabled",
        Some(false) => "disabled",
        None => "enablement unknown",
    };
    format!("Systemd unit '{service}': installed, {enabled}, {runtime}")
}

/// Reports service state successfully even when the unit has not been installed.
#[cfg(target_os = "linux")]
async fn show_status(service: &str, user: bool, flag: &[&str]) -> Result<()> {
    let path = unit_path(service, user)?;
    let installed = tokio::fs::try_exists(&path)
        .await
        .with_context(|| format!("Failed to inspect systemd unit '{}'", path.display()))?;
    let mut show_arguments = flag.to_vec();
    show_arguments.extend([
        "show",
        "--property=LoadState,ActiveState,SubState,MainPID",
        service,
    ]);
    let output = Command::new("systemctl")
        .args(&show_arguments)
        .output()
        .await
        .context("Failed to ask systemd for service state")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "Failed to ask systemd for '{service}' status: {}",
            stderr.trim()
        );
    }
    let state = parse_systemd_state(&String::from_utf8_lossy(&output.stdout));

    let enabled = if installed {
        let mut enabled_arguments = flag.to_vec();
        enabled_arguments.extend(["is-enabled", service]);
        let enabled_output = Command::new("systemctl")
            .args(&enabled_arguments)
            .output()
            .await
            .context("Failed to ask systemd whether the service is enabled")?;
        parse_enabled_state(&String::from_utf8_lossy(&enabled_output.stdout))
    } else {
        None
    };
    println!("{}", format_status(service, installed, enabled, &state));
    Ok(())
}

/// Interprets systemd enablement states without treating masking as unknown.
#[cfg(any(target_os = "linux", test))]
fn parse_enabled_state(output: &str) -> Option<bool> {
    match output.trim() {
        "enabled" | "enabled-runtime" | "linked" | "linked-runtime" | "alias" => Some(true),
        "disabled" | "masked" | "masked-runtime" | "static" | "indirect" | "generated"
        | "transient" | "not-found" => Some(false),
        _ => None,
    }
}

/// Returns the expected unit path for the selected user or system scope.
#[cfg(target_os = "linux")]
fn unit_path(service: &str, user: bool) -> Result<PathBuf> {
    if user {
        Ok(home_directory()?.join(".config/systemd/user").join(service))
    } else {
        Ok(PathBuf::from("/etc/systemd/system").join(service))
    }
}

/// Stops, disables, and removes a unit while making repeated calls harmless.
#[cfg(target_os = "linux")]
async fn uninstall(role: ServiceRole) -> Result<()> {
    let service = unit_name(role)?;
    let user = !nix::unistd::Uid::effective().is_root();
    let flag: &[&str] = if user { &["--user"] } else { &[] };
    let path = unit_path(&service, user)?;
    let installed = tokio::fs::try_exists(&path)
        .await
        .with_context(|| format!("Failed to inspect systemd unit '{}'", path.display()))?;
    let mut show = flag.to_vec();
    show.extend(["show", "--property=LoadState", "--value", service.as_str()]);
    let load_output = Command::new("systemctl")
        .args(&show)
        .output()
        .await
        .context("Failed to ask systemd whether the unit is loaded before uninstalling")?;
    if !load_output.status.success() {
        let stderr = String::from_utf8_lossy(&load_output.stderr);
        bail!(
            "Failed to inspect systemd unit '{service}' before uninstalling: {}",
            stderr.trim()
        );
    }
    let manager_knows_unit = !matches!(
        String::from_utf8_lossy(&load_output.stdout).trim(),
        "" | "not-found"
    );
    if manager_knows_unit {
        let mut stop = flag.to_vec();
        stop.extend(["stop", service.as_str()]);
        run_command("systemctl", &stop)
            .await
            .with_context(|| format!("Failed to stop {service} before uninstalling"))?;
    }
    if installed || manager_knows_unit {
        let mut disable = flag.to_vec();
        disable.extend(["disable", service.as_str()]);
        run_command("systemctl", &disable)
            .await
            .with_context(|| format!("Failed to disable {service} before uninstalling"))?;
    }
    if installed {
        tokio::fs::remove_file(&path)
            .await
            .with_context(|| format!("Failed to remove systemd unit '{}'", path.display()))?;
    }
    let mut reload = flag.to_vec();
    reload.push("daemon-reload");
    run_command("systemctl", &reload)
        .await
        .context("Failed to reload systemd after uninstalling the service")?;
    if installed {
        println!("Uninstalled systemd unit '{service}'; configuration was preserved.");
    } else {
        println!("Systemd unit '{service}' is already uninstalled; configuration was preserved.");
    }
    Ok(())
}

/// Installs a lingering systemd user unit owned by the invoking account.
#[cfg(target_os = "linux")]
async fn run_user(mode: ServiceRole, unit_name: &str, start: bool) -> Result<()> {
    let app_name = crate::app_name::app_name()?;
    let config_path = crate::config::default_config_path()?;
    let config_created = crate::service_management::prepare_config(mode, &config_path).await?;

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
    crate::service_management::atomic_write(&unit_path, unit_content.as_bytes(), "systemd unit")
        .await?;

    let username = current_username().await?;
    run_command("loginctl", &["enable-linger", &username])
        .await
        .context("Failed to enable user lingering; the service would stop when you log out")?;
    // Enable on boot and honor the explicit install-time startup choice.
    activate_unit(unit_name, true, start).await?;

    print_manage_help(
        unit_name,
        &unit_path,
        &config_path,
        config_created,
        mode,
        start,
    );
    Ok(())
}

/// Installs a system unit: server as the `redoor` user, agent as root.
#[cfg(target_os = "linux")]
async fn run_system(mode: ServiceRole, unit_name: &str, start: bool) -> Result<()> {
    let app_name = crate::app_name::app_name()?;
    let config_path = crate::config::default_config_path()?;
    let config_created = crate::service_management::prepare_config(mode, &config_path).await?;

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
    crate::service_management::atomic_write(&unit_path, unit_content.as_bytes(), "systemd unit")
        .await?;

    // Enable on boot and honor the explicit install-time startup choice.
    activate_unit(unit_name, false, start).await?;

    print_manage_help(
        unit_name,
        &unit_path,
        &config_path,
        config_created,
        mode,
        start,
    );
    Ok(())
}

/// Reloads systemd, drops a stale process, enables on boot, and optionally starts it.
///
/// `daemon-reload` is required after every unit rewrite so systemd does not keep
/// the old in-memory definition. Stopping first ensures a prior process cannot
/// stay active with a stale binary or unit after installation rewrites the file.
#[cfg(target_os = "linux")]
async fn activate_unit(service: &str, user: bool, start: bool) -> Result<()> {
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
    if start {
        let mut start_arguments = flag.to_vec();
        start_arguments.extend(["start", service]);
        run_command("systemctl", &start_arguments)
            .await
            .with_context(|| format!("Failed to start {service} after installing it"))?;
    }
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

/// Prints how to control the unit after successful installation.
#[cfg(target_os = "linux")]
fn print_manage_help(
    service: &str,
    unit_path: &Path,
    config_path: &Path,
    config_created: bool,
    mode: ServiceRole,
    started: bool,
) {
    println!(
        "Installed unit {service} at {} and enabled it on boot ({}).",
        unit_path.display(),
        if started { "started" } else { "not started" }
    );
    if config_created {
        println!(
            "Created config at {}.\nEdit it before starting the service.",
            config_path.display()
        );
        if mode == ServiceRole::Agent {
            println!("The [agent] section probably needs to be changed (token, server).");
        }
    } else {
        println!("Config: {}", config_path.display());
    }
    println!(
        "
Manage the service:
  redoor {} systemd start
  redoor {} systemd stop       # remains enabled for future boot
  redoor {} systemd restart
  redoor {} systemd status
  redoor {} systemd disable --now
  redoor {} logs --follow",
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
        // Pin --config so the unit always loads the file prepared during installation.
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
        ServiceRole, format_status, parse_enabled_state, parse_systemd_state, quote_unit_argument,
        render_unit, unit_name, validate_unit_load_state,
    };
    use std::path::Path;

    /// Verifies unit names derive solely from the validated application identity.
    #[test]
    fn unit_names_use_application_identity() {
        let app_name = crate::app_name::app_name().unwrap();
        assert_eq!(
            unit_name(ServiceRole::Agent).unwrap(),
            format!("{app_name}-agent.service"),
            "the agent unit should use the effective application namespace"
        );
        assert_eq!(
            unit_name(ServiceRole::Server).unwrap(),
            format!("{app_name}-server.service"),
            "the server unit should use the effective application namespace"
        );
    }

    /// Verifies absent units produce a clear error with the correct scope and install command.
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
            error.contains("Systemd user unit 'custom-agent.service' is not installed"),
            "the error must identify the missing unit and user scope: {error}"
        );
        assert!(
            error.contains("redoor agent systemd install"),
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

    /// Verifies systemctl properties become concise installed and runtime state.
    #[test]
    fn formats_systemd_process_status() {
        let running = parse_systemd_state(
            "LoadState=loaded
ActiveState=active
SubState=running
MainPID=4321",
        );
        assert_eq!(
            format_status("redoor-server.service", true, Some(true), &running),
            "Systemd unit 'redoor-server.service': installed, enabled, loaded, running, PID 4321",
            "an active service should report its main process ID"
        );
        let absent = parse_systemd_state(
            "LoadState=not-found
ActiveState=inactive
SubState=dead
MainPID=0",
        );
        assert_eq!(
            format_status("redoor-server.service", false, Some(false), &absent),
            "Systemd unit 'redoor-server.service': not installed",
            "an absent unit should omit meaningless enablement and runtime state"
        );
        assert_eq!(
            format_status("redoor-server.service", false, Some(false), &running),
            "Systemd unit 'redoor-server.service': not installed, loaded, running, PID 4321",
            "a manager-cached orphan should remain visible after its unit file disappears"
        );
    }

    /// Verifies masked units are reported as disabled rather than unknown.
    #[test]
    fn interprets_systemd_enablement_states() {
        assert_eq!(
            parse_enabled_state(
                "enabled-runtime
"
            ),
            Some(true),
            "runtime-enabled units should be reported as enabled"
        );
        assert_eq!(
            parse_enabled_state("masked"),
            Some(false),
            "masking prevents startup and should be reported as disabled"
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
            "the unit must preserve the application namespace selected during installation: {unit}"
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

    /// Verifies server units explicitly pin the config used during installation.
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
