//! Installs and controls Redoor as an operating-system service.
//!
//! The CLI surface (`redoor agent|server systemd|launchd ...` and
//! `redoor agent relay systemd|launchd ... ID`), the install/config checks, the help text and
//! the status line are shared; each service manager only implements [`ServiceBackend`].
//! systemd is used on Linux and launchd (per-user LaunchAgents) on macOS.

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod launchd;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod systemd;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::Context;
use anyhow::{Result, bail};
use clap::{Args, Subcommand};
use redoor_core::paths::AppPaths;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::io::AsyncWriteExt;

/// Process role selected by the parent CLI command for service management.
#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub(crate) enum ServiceRole {
    /// Manage a standalone Redoor agent process.
    Agent,
    /// Manage the Redoor HTTP and WebSocket server process.
    Server,
    /// Manage one configured `[[relays]]` entry, identified by its stable relay ID.
    Relay(String),
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl ServiceRole {
    /// Suffix after `<app-name>-` in generated unit names and labels.
    ///
    /// Relays include their ID so every configured relay can be installed side by side.
    pub(crate) fn service_suffix(&self) -> String {
        match self {
            Self::Agent => "agent".to_string(),
            Self::Server => "server".to_string(),
            Self::Relay(id) => format!("relay-{id}"),
        }
    }

    /// Human-readable service description written into the service definition.
    pub(crate) fn description(&self) -> String {
        match self {
            Self::Agent => "Redoor agent".to_string(),
            Self::Server => "Redoor server".to_string(),
            Self::Relay(id) => format!("Redoor relay {id}"),
        }
    }

    /// Arguments after the executable that run this role in the foreground.
    ///
    /// The service manager supervises the process itself, so no `--daemon` is passed; the
    /// caller appends the pinned `--config`.
    pub(crate) fn program_arguments(&self) -> Vec<&str> {
        match self {
            Self::Agent => vec!["agent"],
            Self::Server => vec!["server"],
            Self::Relay(id) => vec!["agent", "relay", "start", id],
        }
    }

    /// Whether the process reports readiness through `NOTIFY_SOCKET`.
    ///
    /// Relays retry their SSH session forever and have no single "ready" moment, so systemd
    /// must not wait for a notification that never comes.
    pub(crate) fn notifies_readiness(&self) -> bool {
        !matches!(self, Self::Relay(_))
    }

    /// Full CLI invocation of one service action, used in operator guidance.
    ///
    /// `action` may carry flags (`disable --now`); a relay ID goes right after the verb so
    /// the printed command matches the help examples.
    pub(crate) fn service_command(&self, manager: &str, action: &str) -> String {
        match self {
            Self::Agent | Self::Server => {
                format!("redoor {} {manager} {action}", self.service_suffix())
            }
            Self::Relay(id) => {
                let (verb, flags) = match action.split_once(' ') {
                    Some((verb, flags)) => (verb, format!(" {flags}")),
                    None => (action, String::new()),
                };
                format!("redoor agent relay {manager} {verb} {id}{flags}")
            }
        }
    }

    /// CLI invocation that shows this role's file log.
    fn logs_command(&self) -> String {
        match self {
            Self::Agent => "redoor agent logs --follow".to_string(),
            Self::Server => "redoor server logs --follow".to_string(),
            Self::Relay(id) => format!("redoor agent relay logs {id}"),
        }
    }
}

/// Target of a service action for roles with exactly one service per namespace.
///
/// The agent and server need no extra argument, so their actions stay `install`, `start`, ...
#[derive(Args, Clone, Debug)]
pub(crate) struct NoTarget {}

/// Target of a service action for relays, which can have one service per configured entry.
#[derive(Args, Clone, Debug)]
pub(crate) struct RelayTarget {
    /// Stable relay ID from a `[[relays]]` entry.
    #[arg(value_parser = redoor_core::config::parse_relay_id)]
    pub(crate) id: String,
}

/// Operations shared by Redoor's supported operating-system service managers.
///
/// `T` is the per-action target: nothing for the agent and server, a relay ID for relays.
/// Keeping it generic gives every role the same set of actions, so one cannot miss e.g.
/// `restart`.
#[derive(Subcommand)]
pub(crate) enum ServiceCommand<T: Args> {
    /// Install and enable the service, remaining stopped unless requested.
    #[command(after_help = crate::examples::SERVICE_INSTALL)]
    Install(InstallArgs<T>),
    /// Stop, disable, and remove the service while preserving its config.
    #[command(after_help = crate::examples::SERVICE_UNINSTALL)]
    Uninstall(T),
    /// Start the installed service.
    #[command(after_help = crate::examples::SERVICE_START)]
    Start(T),
    /// Stop the installed service while leaving it enabled for future startup.
    #[command(after_help = crate::examples::SERVICE_STOP)]
    Stop(T),
    /// Reload and restart the installed service.
    #[command(after_help = crate::examples::SERVICE_RESTART)]
    Restart(T),
    /// Show installation, enablement, and process state.
    #[command(after_help = crate::examples::SERVICE_STATUS)]
    Status(T),
    /// Enable the installed service without starting it.
    #[command(after_help = crate::examples::SERVICE_ENABLE)]
    Enable(T),
    /// Disable automatic startup, optionally stopping the service now.
    #[command(after_help = crate::examples::SERVICE_DISABLE)]
    Disable(DisableArgs<T>),
}

impl<T: Args> ServiceCommand<T> {
    /// Returns which service the action targets, so the caller can resolve the role first.
    pub(crate) fn target(&self) -> &T {
        match self {
            Self::Install(install) => &install.target,
            Self::Disable(disable) => &disable.target,
            Self::Uninstall(target)
            | Self::Start(target)
            | Self::Stop(target)
            | Self::Restart(target)
            | Self::Status(target)
            | Self::Enable(target) => target,
        }
    }
}

/// Controls whether installation also starts the service.
#[derive(Args)]
pub(crate) struct InstallArgs<T: Args> {
    /// Service the action targets.
    #[command(flatten)]
    target: T,
    /// Start the service after installing and enabling it.
    #[arg(long)]
    pub(crate) start: bool,
}

/// Controls whether disabling also stops the current service process.
#[derive(Args)]
pub(crate) struct DisableArgs<T: Args> {
    /// Service the action targets.
    #[command(flatten)]
    target: T,
    /// Stop the service in addition to disabling automatic startup.
    #[arg(long)]
    pub(crate) now: bool,
}

/// Arguments for role-scoped `redoor agent|server|agent relay systemd` service management.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct SystemdArgs<T: Args> {
    /// Selects the systemd operation while keeping service targeting consistent.
    #[command(subcommand)]
    command: ServiceCommand<T>,
}

impl<T: Args> SystemdArgs<T> {
    /// Returns which service the selected action targets.
    pub(crate) fn target(&self) -> &T {
        self.command.target()
    }
}

/// Arguments for role-scoped `redoor agent|server|agent relay launchd` management.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct LaunchdArgs<T: Args> {
    /// Show output from internal launchctl commands.
    #[arg(long, global = true)]
    verbose: bool,
    /// Selects the launchd operation while keeping service targeting consistent.
    #[command(subcommand)]
    command: LaunchdCommand<T>,
}

impl<T: Args> LaunchdArgs<T> {
    /// Returns which service the selected action targets.
    pub(crate) fn target(&self) -> &T {
        match &self.command {
            LaunchdCommand::Service(command) => command.target(),
            LaunchdCommand::RefreshLocalNetworkPermission(target) => target,
        }
    }
}

/// launchd supports the shared operations plus a macOS-only permission repair.
#[derive(Subcommand)]
enum LaunchdCommand<T: Args> {
    /// Operations shared with systemd.
    #[command(flatten)]
    Service(ServiceCommand<T>),
    /// Replace a stale ad-hoc identity so macOS asks for Local Network access again.
    #[command(after_help = crate::examples::REFRESH_LOCAL_NETWORK_PERMISSION)]
    RefreshLocalNetworkPermission(T),
}

/// Runs one systemd operation against the unit scope implied by current privileges.
pub(crate) async fn run_systemd<T: Args>(
    args: SystemdArgs<T>,
    role: ServiceRole,
    paths: &AppPaths,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        let backend = systemd::SystemdBackend::new(role.clone(), paths);
        run_command(&backend, &role, paths, args.command).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (args, role, paths);
        bail!("systemd commands are only supported on Linux")
    }
}

/// Runs one macOS LaunchAgent operation for the invoking non-root user.
pub(crate) async fn run_launchd<T: Args>(
    args: LaunchdArgs<T>,
    role: ServiceRole,
    paths: &AppPaths,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let backend = launchd::LaunchdBackend::new(role.clone(), paths, args.verbose)?;
        match args.command {
            LaunchdCommand::Service(command) => run_command(&backend, &role, paths, command).await,
            LaunchdCommand::RefreshLocalNetworkPermission(_) => {
                backend.refresh_local_network_permission().await
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (args, role, paths);
        bail!("launchd commands are only supported on macOS")
    }
}

/// One operating-system service manager controlling one Redoor role.
///
/// Implementations hold the resolved service name and scope, so the shared dispatcher
/// only expresses the lifecycle order (check, act, report).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) trait ServiceBackend {
    /// CLI name of the manager (`systemd`, `launchd`), used in operator guidance.
    fn manager(&self) -> &'static str;
    /// Human name of the installed artifact, e.g. `Systemd unit 'redoor-agent.service'`.
    fn describe(&self) -> String;
    /// When an enabled service starts automatically: `boot` or `login`.
    fn autostart_trigger(&self) -> &'static str;
    /// Renders the service definition file for the given executable and config.
    fn render_definition(&self, binary: &Path, config_path: &Path) -> String;
    /// Writes the definition, enables it and optionally starts it; returns where it was written.
    async fn install(&self, config_path: &Path, start: bool) -> Result<PathBuf>;
    /// Stops, disables and removes the definition; returns whether anything was installed.
    async fn uninstall(&self) -> Result<bool>;
    /// Fails with install guidance unless the manager knows the service.
    async fn ensure_installed(&self) -> Result<()>;
    /// Starts the installed service.
    async fn start(&self) -> Result<()>;
    /// Stops the service while keeping it enabled.
    async fn stop(&self) -> Result<()>;
    /// Reloads the definition and restarts the service.
    async fn restart(&self) -> Result<()>;
    /// Enables automatic startup.
    async fn enable(&self) -> Result<()>;
    /// Disables automatic startup, optionally stopping it now.
    async fn disable(&self, now: bool) -> Result<()>;
    /// Reads installation, enablement and runtime state without failing on a stopped service.
    async fn status(&self) -> Result<ServiceState>;
}

/// Executes one shared service operation through `backend`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn run_command<B: ServiceBackend, T: Args>(
    backend: &B,
    role: &ServiceRole,
    paths: &AppPaths,
    command: ServiceCommand<T>,
) -> Result<()> {
    match command {
        ServiceCommand::Install(install) => {
            let config_path = paths.default_config_path()?;
            let config_created = prepare_config(role, &config_path).await?;
            let definition = backend.install(&config_path, install.start).await?;
            print_install_help(
                backend,
                role,
                &InstallReport {
                    definition,
                    config_path,
                    config_created,
                    started: install.start,
                },
            );
        }
        ServiceCommand::Uninstall(_) => {
            let description = backend.describe();
            if backend.uninstall().await? {
                println!("Uninstalled {description}; configuration was preserved.");
            } else {
                println!("{description} is already uninstalled; configuration was preserved.");
            }
        }
        ServiceCommand::Status(_) => {
            println!("{}", backend.status().await?.format(&backend.describe()))
        }
        ServiceCommand::Start(_) => {
            backend.ensure_installed().await?;
            backend.start().await?;
        }
        ServiceCommand::Stop(_) => {
            backend.ensure_installed().await?;
            backend.stop().await?;
        }
        ServiceCommand::Restart(_) => {
            backend.ensure_installed().await?;
            backend.restart().await?;
        }
        ServiceCommand::Enable(_) => {
            backend.ensure_installed().await?;
            backend.enable().await?;
        }
        ServiceCommand::Disable(disable) => {
            backend.ensure_installed().await?;
            backend.disable(disable.now).await?;
        }
    }
    Ok(())
}

/// Builds the actionable error shared by every "not installed" check.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn not_installed(description: &str, role: &ServiceRole, manager: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "{description} is not installed. Install it with: {}",
        role.service_command(manager, "install")
    )
}

/// What a successful install produced, for the follow-up help text.
#[cfg(any(target_os = "linux", target_os = "macos"))]
struct InstallReport {
    /// Path of the written unit or plist.
    definition: PathBuf,
    /// Config the service was pinned to.
    config_path: PathBuf,
    /// Whether the install created that config (agents import it from stdin).
    config_created: bool,
    /// Whether the service was started right away.
    started: bool,
}

/// Prints how to control the service after a successful installation.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn print_install_help<B: ServiceBackend>(backend: &B, role: &ServiceRole, report: &InstallReport) {
    let trigger = backend.autostart_trigger();
    println!(
        "Installed {} at {} and enabled it {} {trigger} ({}).",
        backend.describe(),
        report.definition.display(),
        if trigger == "boot" { "on" } else { "at" },
        if report.started {
            "started"
        } else {
            "not started"
        }
    );
    if report.config_created {
        println!(
            "Created config at {}.
Edit it before starting the service.",
            report.config_path.display()
        );
        if *role == ServiceRole::Agent {
            println!("The [agent] section probably needs to be changed (token, server).");
        }
    } else {
        println!("Config: {}", report.config_path.display());
    }
    let manager = backend.manager();
    let command = |action| role.service_command(manager, action);
    println!(
        "
Manage the service:
  {}
  {}       # remains enabled for future {trigger}
  {}
  {}
  {}
  {}",
        command("start"),
        command("stop"),
        command("restart"),
        command("status"),
        command("disable --now"),
        role.logs_command()
    );
}

/// What the service manager reports about the running process.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ServiceRuntime {
    /// The manager has no loaded job for this service.
    Unloaded,
    /// A process is running, with its PID when the manager reports one.
    Running {
        /// Main process ID.
        pid: Option<String>,
    },
    /// The job is loaded but no process runs; `detail` is the manager's state words.
    Stopped {
        /// e.g. `inactive/dead` (systemd) or `waiting` (launchd).
        detail: Option<String>,
    },
}

/// Installation, enablement and runtime state of one service, formatted the same way
/// for every manager.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ServiceState {
    /// Whether the definition file exists.
    pub(crate) installed: bool,
    /// Automatic startup; `None` when the manager cannot tell.
    pub(crate) enabled: Option<bool>,
    /// Process state reported by the manager.
    pub(crate) runtime: ServiceRuntime,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl ServiceState {
    /// One concise status line, e.g. `... installed, enabled, loaded, running, PID 42`.
    ///
    /// An absent definition omits meaningless enablement, but a job the manager still has
    /// loaded stays visible so orphans can be found.
    pub(crate) fn format(&self, description: &str) -> String {
        let runtime = match &self.runtime {
            ServiceRuntime::Running { pid: Some(pid) } => format!("loaded, running, PID {pid}"),
            ServiceRuntime::Running { pid: None } => "loaded, running".to_string(),
            ServiceRuntime::Stopped {
                detail: Some(detail),
            } => format!("loaded, stopped ({detail})"),
            ServiceRuntime::Stopped { detail: None } => "loaded, stopped".to_string(),
            ServiceRuntime::Unloaded => "unloaded, stopped".to_string(),
        };
        if !self.installed {
            return match self.runtime {
                ServiceRuntime::Unloaded => format!("{description}: not installed"),
                _ => format!("{description}: not installed, {runtime}"),
            };
        }
        let enabled = match self.enabled {
            Some(true) => "enabled",
            Some(false) => "disabled",
            None => "enablement unknown",
        };
        format!("{description}: installed, {enabled}, {runtime}")
    }
}

/// Ensures service installation has a complete config usable without CLI overrides.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn prepare_config(role: &ServiceRole, config_path: &Path) -> Result<bool> {
    if tokio::fs::try_exists(config_path)
        .await
        .with_context(|| format!("Failed to inspect config '{}'", config_path.display()))?
    {
        validate_existing_config(role, config_path).await?;
        return Ok(false);
    }

    match role {
        ServiceRole::Agent => {
            let imported_path =
                redoor_core::config::import_agent_config_from_stdin(config_path).await?;
            validate_existing_config(role, &imported_path).await?;
            Ok(false)
        }
        ServiceRole::Server => bail!(
            "config '{}' is missing; run `redoor server` once to create a starter config, then re-run install",
            config_path.display()
        ),
        ServiceRole::Relay(id) => bail!(
            "config '{}' is missing; add agent_token and a [[relays]] entry with id = \"{id}\", then re-run install",
            config_path.display()
        ),
    }
}

/// Rejects configs that cannot run the selected role without extra CLI flags.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn validate_existing_config(role: &ServiceRole, config_path: &Path) -> Result<()> {
    let config = redoor_core::config::parse_config_file(config_path).await?;
    match role {
        ServiceRole::Agent => {
            if !redoor_core::config::standalone_agent_is_fully_configured(&config) {
                bail!(
                    "config '{}' is missing required standalone agent settings; set top-level agent_token plus [agent] server so the service can start without CLI flags",
                    config_path.display()
                );
            }
        }
        ServiceRole::Server => {
            redoor_core::config::require_server_section(&config)?;
        }
        ServiceRole::Relay(id) => {
            if config.agent_token.is_none() {
                bail!(
                    "config '{}' is missing top-level agent_token required by relay '{id}'",
                    config_path.display()
                );
            }
            // The service would otherwise install fine and then fail on every restart.
            redoor_core::config::require_relay(&config, id).with_context(|| {
                format!(
                    "config '{}' has no [[relays]] entry for the service",
                    config_path.display()
                )
            })?;
        }
    }
    Ok(())
}

/// Replaces a service definition in one rename so managers never read a partial file.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn atomic_write(path: &Path, content: &[u8], artifact: &str) -> Result<()> {
    let file_name = path
        .file_name()
        .with_context(|| format!("{artifact} path has no file name"))?
        .to_string_lossy();
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        fastrand::u64(..)
    ));
    let write_result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .await
            .with_context(|| {
                format!(
                    "Failed to create temporary {artifact} '{}'",
                    temporary_path.display()
                )
            })?;
        file.write_all(content).await.with_context(|| {
            format!(
                "Failed to write temporary {artifact} '{}'",
                temporary_path.display()
            )
        })?;
        file.sync_all().await.with_context(|| {
            format!(
                "Failed to sync temporary {artifact} '{}'",
                temporary_path.display()
            )
        })?;
        drop(file);
        tokio::fs::rename(&temporary_path, path)
            .await
            .with_context(|| format!("Failed to install {artifact} '{}'", path.display()))
    }
    .await;
    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
    }
    write_result
}

/// Resolves the running executable so the service runs exactly this binary.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn current_binary() -> Result<PathBuf> {
    tokio::fs::canonicalize(std::env::current_exe()?)
        .await
        .context("Failed to resolve the current redoor executable")
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    /// Printed guidance is copied verbatim, so relay commands must put the ID where clap
    /// expects it and keep flags after it.
    #[test]
    fn formats_role_service_commands() {
        // Agent and server have one service per namespace and need no ID.
        assert_eq!(
            ServiceRole::Server.service_command("systemd", "disable --now"),
            "redoor server systemd disable --now"
        );
        // A relay service is selected by the ID following the action verb.
        assert_eq!(
            ServiceRole::Relay("production".into()).service_command("launchd", "disable --now"),
            "redoor agent relay launchd disable production --now"
        );
        // Relay units must not collide with the standalone agent's unit name.
        assert_eq!(
            ServiceRole::Relay("production".into()).service_suffix(),
            "relay-production"
        );
        // The service runs the relay in the foreground so the manager can supervise it.
        assert_eq!(
            ServiceRole::Relay("production".into()).program_arguments(),
            ["agent", "relay", "start", "production"]
        );
    }

    /// Every manager shares one status vocabulary, including orphaned loaded jobs.
    #[test]
    fn formats_service_state() {
        let running = ServiceState {
            installed: true,
            enabled: Some(true),
            runtime: ServiceRuntime::Running {
                pid: Some("4321".into()),
            },
        };
        // An active service reports its main process ID.
        assert_eq!(
            running.format("Systemd unit 'redoor-server.service'"),
            "Systemd unit 'redoor-server.service': installed, enabled, loaded, running, PID 4321"
        );
        let waiting = ServiceState {
            installed: true,
            enabled: Some(false),
            runtime: ServiceRuntime::Stopped {
                detail: Some("waiting".into()),
            },
        };
        // A loaded job without a process must not be described as running.
        assert_eq!(
            waiting.format("LaunchAgent 'redoor-server'"),
            "LaunchAgent 'redoor-server': installed, disabled, loaded, stopped (waiting)"
        );
        let absent = ServiceState {
            installed: false,
            enabled: None,
            runtime: ServiceRuntime::Unloaded,
        };
        // An absent definition omits meaningless enablement and runtime state.
        assert_eq!(
            absent.format("LaunchAgent 'redoor-server'"),
            "LaunchAgent 'redoor-server': not installed"
        );
        let orphan = ServiceState {
            installed: false,
            ..running
        };
        // A manager-cached orphan stays visible after its definition disappears.
        assert_eq!(
            orphan.format("Systemd unit 'redoor-server.service'"),
            "Systemd unit 'redoor-server.service': not installed, loaded, running, PID 4321"
        );
    }
}
