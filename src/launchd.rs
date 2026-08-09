//! Installs Redoor as a per-user macOS LaunchAgent.
//!
//! This module intentionally has no root or LaunchDaemon support. Services run
//! only in the invoking user's GUI launchd domain and keep all state under home.

#[cfg(any(target_os = "macos", test))]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(target_os = "macos")]
use anyhow::Context;
use anyhow::{Result, bail};
use clap::{Args, Subcommand};
#[cfg(target_os = "macos")]
use tokio::process::Command;

use crate::ServiceRole;

/// Arguments for role-scoped `redoor agent|server launchd` management.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct LaunchdArgs {
    /// Selects the launchd operation while keeping service targeting consistent.
    #[command(subcommand)]
    command: LaunchdCommand,
}

/// Operations supported for an installed Redoor LaunchAgent.
#[derive(Subcommand)]
enum LaunchdCommand {
    /// Install and enable the LaunchAgent without starting it.
    Setup(ServiceArgs),
    /// Load and start the installed LaunchAgent.
    Start(ServiceArgs),
    /// Stop and unload the installed LaunchAgent.
    Stop(ServiceArgs),
    /// Reload and restart the installed LaunchAgent.
    Restart(ServiceArgs),
    /// Print the configured process log.
    Logs(LogsArgs),
    /// Show whether the LaunchAgent is loaded and print its launchd state.
    Status(ServiceArgs),
    /// Enable the installed LaunchAgent without starting it.
    Enable(ServiceArgs),
}

/// Identifies which Redoor LaunchAgent an operation should manage.
#[derive(Args)]
struct ServiceArgs {
    /// Override the launchd service label (default: <app-name>-agent/server).
    ///
    /// Lets multiple agent or server installs coexist for the current user.
    #[arg(long)]
    service_name: Option<String>,
}

/// Options for printing or following a LaunchAgent process log.
#[derive(Args)]
struct LogsArgs {
    /// Common service selection options.
    #[command(flatten)]
    service: ServiceArgs,
    /// Continue printing new log entries until interrupted.
    #[arg(short = 'f', long)]
    follow: bool,
}

/// Runs one macOS LaunchAgent operation for the invoking non-root user.
pub(crate) async fn run(args: LaunchdArgs, role: ServiceRole) -> Result<()> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (args, role);
        bail!("launchd commands are only supported on macOS");
    }

    #[cfg(target_os = "macos")]
    {
        ensure_non_root()?;
        match args.command {
            LaunchdCommand::Setup(service) => setup(service, role).await,
            LaunchdCommand::Start(service) => {
                manage_service(service, role, ServiceAction::Start).await
            }
            LaunchdCommand::Stop(service) => {
                manage_service(service, role, ServiceAction::Stop).await
            }
            LaunchdCommand::Restart(service) => {
                manage_service(service, role, ServiceAction::Restart).await
            }
            LaunchdCommand::Logs(logs) => {
                manage_service(
                    logs.service,
                    role,
                    ServiceAction::Logs {
                        follow: logs.follow,
                    },
                )
                .await
            }
            LaunchdCommand::Status(service) => {
                manage_service(service, role, ServiceAction::Status).await
            }
            LaunchdCommand::Enable(service) => {
                manage_service(service, role, ServiceAction::Enable).await
            }
        }
    }
}

/// Rejects root because macOS support is deliberately limited to user LaunchAgents.
#[cfg(target_os = "macos")]
fn ensure_non_root() -> Result<()> {
    if nix::unistd::Uid::effective().is_root() {
        bail!(
            "redoor launchd does not support root; run it as the user who will own the LaunchAgent"
        );
    }
    Ok(())
}

/// Resolves a safe launchd service label without permitting path traversal.
#[cfg(any(target_os = "macos", test))]
fn resolve_service_name(mode: ServiceRole, service_name: Option<String>) -> Result<String> {
    let name = match service_name {
        Some(name) => name,
        None => format!("{}-{}", crate::app_name::app_name()?, mode.cli_name()),
    };
    let name = name.trim();
    if name.is_empty() {
        bail!("--service-name must not be empty");
    }
    if name.contains('/') || name.contains('\\') {
        bail!("--service-name must be a bare launchd label, not a path");
    }
    Ok(name.to_owned())
}

/// Installs a user LaunchAgent and enables it for future logins without starting it now.
#[cfg(target_os = "macos")]
async fn setup(args: ServiceArgs, role: ServiceRole) -> Result<()> {
    let service = resolve_service_name(role, args.service_name)?;
    let config_path = crate::server::default_config_path()?;
    let config_created = prepare_config(role, &config_path).await?;
    let binary = tokio::fs::canonicalize(std::env::current_exe()?)
        .await
        .context("Failed to resolve the current redoor executable")?;
    let app_name = crate::app_name::app_name()?;
    let plist_content = render_plist(role, &service, &binary, &config_path, &app_name);
    let launch_agents = home_directory()?.join("Library/LaunchAgents");
    tokio::fs::create_dir_all(&launch_agents)
        .await
        .with_context(|| {
            format!(
                "Failed to create LaunchAgents directory '{}'",
                launch_agents.display()
            )
        })?;
    let plist_path = launch_agents.join(format!("{service}.plist"));
    tokio::fs::write(&plist_path, plist_content)
        .await
        .with_context(|| format!("Failed to write LaunchAgent '{}'", plist_path.display()))?;

    // A disabled override survives plist discovery, so explicitly clear it while
    // leaving the agent unloaded until the operator starts it or logs in again.
    let target = service_target(&service);
    run_command("launchctl", &["enable", &target])
        .await
        .context("Failed to enable the LaunchAgent for user login")?;

    print_manage_help(&service, &plist_path, &config_path, config_created, role);
    Ok(())
}

/// Supported launchctl and log-tail shortcuts.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum ServiceAction {
    Start,
    Stop,
    Restart,
    Logs { follow: bool },
    Status,
    Enable,
}

/// Executes one action against an installed LaunchAgent in the current GUI domain.
#[cfg(target_os = "macos")]
async fn manage_service(args: ServiceArgs, role: ServiceRole, action: ServiceAction) -> Result<()> {
    let service = resolve_service_name(role, args.service_name)?;
    let plist_path = launch_agent_path(&service)?;
    ensure_plist_exists(&plist_path, &service, role).await?;

    if let ServiceAction::Logs { follow } = action {
        return show_log(role, follow).await;
    }

    let domain = user_domain();
    let target = service_target(&service);
    match action {
        ServiceAction::Start => {
            if service_is_loaded(&target).await? {
                run_command("launchctl", &["kickstart", "-k", &target]).await
            } else {
                run_command(
                    "launchctl",
                    &["bootstrap", &domain, &plist_path.to_string_lossy()],
                )
                .await
            }
        }
        ServiceAction::Stop => {
            if service_is_loaded(&target).await? {
                run_command("launchctl", &["bootout", &target]).await
            } else {
                Ok(())
            }
        }
        ServiceAction::Restart => {
            if service_is_loaded(&target).await? {
                run_command("launchctl", &["bootout", &target])
                    .await
                    .context("Failed to unload the running LaunchAgent before restart")?;
            }
            run_command(
                "launchctl",
                &["bootstrap", &domain, &plist_path.to_string_lossy()],
            )
            .await
        }
        ServiceAction::Status => run_command_inherited("launchctl", &["print", &target]).await,
        ServiceAction::Enable => run_command("launchctl", &["enable", &target]).await,
        ServiceAction::Logs { .. } => unreachable!("logs return before launchctl dispatch"),
    }
}

/// Returns the current user's launchd GUI domain.
#[cfg(target_os = "macos")]
fn user_domain() -> String {
    format!("gui/{}", nix::unistd::Uid::effective().as_raw())
}

/// Returns the fully qualified launchctl target for a service label.
#[cfg(target_os = "macos")]
fn service_target(service: &str) -> String {
    format!("{}/{}", user_domain(), service)
}

/// Checks whether launchd currently has the service loaded.
#[cfg(target_os = "macos")]
async fn service_is_loaded(target: &str) -> Result<bool> {
    let status = Command::new("launchctl")
        .args(["print", target])
        .status()
        .await
        .context("Failed to ask launchd whether the service is loaded")?;
    Ok(status.success())
}

/// Returns the conventional plist path for a user LaunchAgent label.
#[cfg(target_os = "macos")]
fn launch_agent_path(service: &str) -> Result<PathBuf> {
    Ok(home_directory()?
        .join("Library/LaunchAgents")
        .join(format!("{service}.plist")))
}

/// Rejects management requests for LaunchAgents that have not been installed.
#[cfg(target_os = "macos")]
async fn ensure_plist_exists(path: &Path, service: &str, mode: ServiceRole) -> Result<()> {
    if tokio::fs::try_exists(path)
        .await
        .with_context(|| format!("Failed to inspect LaunchAgent '{}'", path.display()))?
    {
        return Ok(());
    }
    bail!(
        "macOS LaunchAgent '{service}' does not exist. Install it first with: redoor {} launchd setup --service-name {service}",
        mode.cli_name()
    )
}

/// Follows the role's configured or conventional file log without buffering it.
#[cfg(target_os = "macos")]
async fn show_log(mode: ServiceRole, follow: bool) -> Result<()> {
    let config_path = crate::server::default_config_path()?;
    let config = crate::server::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config '{}'", config_path.display()))?;
    let configured = match mode {
        ServiceRole::Agent => config.agent.and_then(|section| section.log),
        ServiceRole::Server => config.server.and_then(|section| section.log),
    };
    let log_path = match configured.filter(|path| !path.trim().is_empty()) {
        Some(path) => path,
        None => match mode {
            ServiceRole::Agent => crate::server::default_agent_log_path()?,
            ServiceRole::Server => crate::server::default_server_log_path()?,
        },
    };
    if follow {
        run_command_inherited("tail", &["-n", "500", "-f", &log_path]).await
    } else {
        run_command_inherited("tail", &["-n", "500", &log_path]).await
    }
}

/// Returns the home directory required for user config and LaunchAgents.
#[cfg(target_os = "macos")]
fn home_directory() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot locate the macOS LaunchAgents directory")
}

/// Ensures setup has a complete shared config and reports whether it was created.
#[cfg(target_os = "macos")]
async fn prepare_config(mode: ServiceRole, config_path: &Path) -> Result<bool> {
    if tokio::fs::try_exists(config_path)
        .await
        .with_context(|| format!("Failed to inspect config '{}'", config_path.display()))?
    {
        validate_existing_config(mode, config_path).await?;
        return Ok(false);
    }

    match crate::server::create_default_config_if_missing(config_path).await? {
        Some(created) => {
            if let Some(password) = created.password {
                println!(
                    "Created config at {}
username password: {}
agent_token: {}
Store these secrets securely; they will not be shown again.",
                    config_path.display(),
                    password,
                    created.agent_token
                );
            } else {
                println!(
                    "Created config at {}
agent_token: {}
Store this secret securely; it will not be shown again.",
                    config_path.display(),
                    created.agent_token
                );
            }
            Ok(true)
        }
        None => {
            // Another setup may have won the create-new race after our existence check.
            validate_existing_config(mode, config_path).await?;
            Ok(false)
        }
    }
}

/// Rejects configs that cannot run the selected role without extra CLI flags.
#[cfg(target_os = "macos")]
async fn validate_existing_config(mode: ServiceRole, config_path: &Path) -> Result<()> {
    let config = crate::server::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config '{}'", config_path.display()))?;
    match mode {
        ServiceRole::Agent => {
            if !crate::server::standalone_agent_is_fully_configured(&config) {
                bail!(
                    "config '{}' is missing required standalone agent settings; set top-level agent_token plus [agent] ws_address so the service can start without CLI flags",
                    config_path.display()
                );
            }
        }
        ServiceRole::Server => {
            crate::server::require_server_section(&config)?;
        }
    }
    Ok(())
}

/// Prints user-scoped launchctl commands after successful setup.
#[cfg(target_os = "macos")]
fn print_manage_help(
    service: &str,
    plist_path: &Path,
    config_path: &Path,
    config_created: bool,
    mode: ServiceRole,
) {
    println!(
        "Wrote LaunchAgent {service} at {} and enabled it at login (not started).",
        plist_path.display()
    );
    if config_created {
        println!(
            "Created config at {}.
Edit it before starting the service.",
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
  redoor {} launchd start --service-name {service}

Manage the service:
  redoor {} launchd start --service-name {service}
  redoor {} launchd stop --service-name {service}
  redoor {} launchd restart --service-name {service}
  redoor {} launchd status --service-name {service}
  redoor {} launchd logs --service-name {service}",
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name(),
        mode.cli_name()
    );
}

/// Renders a LaunchAgent plist with separately escaped program arguments.
#[cfg(any(target_os = "macos", test))]
fn render_plist(
    mode: ServiceRole,
    service: &str,
    binary: &Path,
    config_path: &Path,
    app_name: &str,
) -> String {
    let subcommand = mode.cli_name();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
        <string>{subcommand}</string>
        <string>--config</string>
        <string>{}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>REDOOR_APP_NAME</key>
        <string>{}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
"#,
        escape_xml(service),
        escape_xml(binary.to_string_lossy().as_ref()),
        escape_xml(config_path.to_string_lossy().as_ref()),
        escape_xml(app_name)
    )
}

/// Escapes dynamic text embedded in XML element content.
#[cfg(any(target_os = "macos", test))]
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Runs one finite administration command and preserves stderr on failure.
#[cfg(target_os = "macos")]
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

/// Runs a continuous command with inherited streams for interactive log following.
#[cfg(target_os = "macos")]
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

#[cfg(test)]
mod tests {
    use super::{ServiceRole, escape_xml, render_plist, resolve_service_name};
    use std::path::Path;

    /// Verifies default labels and safe custom labels remain stable.
    #[test]
    fn service_names_default_and_reject_paths() {
        let app_name = crate::app_name::app_name().unwrap();
        assert_eq!(
            resolve_service_name(ServiceRole::Agent, None).unwrap(),
            format!("{app_name}-agent"),
            "the default agent label should use the application namespace"
        );
        assert_eq!(
            resolve_service_name(ServiceRole::Server, Some("redoor.preview".into())).unwrap(),
            "redoor.preview",
            "an explicit bare launchd label should remain unchanged"
        );
        assert!(
            resolve_service_name(ServiceRole::Agent, Some("../escape".into())).is_err(),
            "service labels must not escape the LaunchAgents directory"
        );
        assert!(
            resolve_service_name(ServiceRole::Agent, Some("  ".into())).is_err(),
            "blank service labels must be rejected"
        );
    }

    /// Verifies generated plists preserve arguments, namespaces, and restart behavior.
    #[test]
    fn agent_plist_pins_config_and_environment() {
        let plist = render_plist(
            ServiceRole::Agent,
            "redoor-agent",
            Path::new("/Users/test & user/bin/redoor"),
            Path::new("/Users/test & user/.config/redoor/config.toml"),
            "redoor-dev",
        );
        assert!(
            plist.contains("<string>/Users/test &amp; user/bin/redoor</string>"),
            "the executable must be XML escaped as a distinct argument: {plist}"
        );
        assert!(
            plist.contains("<string>agent</string>"),
            "the LaunchAgent must run the selected process role: {plist}"
        );
        assert!(
            plist.contains("<string>/Users/test &amp; user/.config/redoor/config.toml</string>"),
            "the LaunchAgent must pin the prepared config path: {plist}"
        );
        assert!(
            plist.contains("<key>REDOOR_APP_NAME</key>")
                && plist.contains("<string>redoor-dev</string>"),
            "the LaunchAgent must preserve the selected application namespace: {plist}"
        );
        assert!(
            plist.contains("<key>SuccessfulExit</key>") && plist.contains("<false/>"),
            "launchd should restart only processes that exit unsuccessfully: {plist}"
        );
        assert!(
            !plist.contains("--token") && !plist.contains("--name"),
            "standalone-agent settings must come from the shared TOML: {plist}"
        );
    }

    /// Verifies every XML-sensitive character is escaped in generated values.
    #[test]
    fn xml_values_are_escaped() {
        assert_eq!(
            escape_xml("<&>\"'"),
            "&lt;&amp;&gt;&quot;&apos;",
            "dynamic plist values must not be able to alter the XML structure"
        );
    }
}
