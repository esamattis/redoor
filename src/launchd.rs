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
use crate::service_management::{DisableArgs, InstallArgs};

/// Arguments for role-scoped `redoor agent|server launchd` management.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct LaunchdArgs {
    /// Show output from internal launchctl commands.
    #[arg(long, global = true)]
    verbose: bool,
    /// Selects the launchd operation while keeping service targeting consistent.
    #[command(subcommand)]
    command: LaunchdCommand,
}

/// Operations supported by macOS LaunchAgent management.
#[derive(Subcommand)]
enum LaunchdCommand {
    /// Install and enable the service, remaining stopped unless requested.
    Install(InstallArgs),
    /// Stop, disable, and remove the service while preserving its config.
    Uninstall,
    /// Start the installed service.
    Start,
    /// Stop the installed service while leaving it enabled for future startup.
    Stop,
    /// Reload and restart the installed service.
    Restart,
    /// Show installation, enablement, and process state.
    Status,
    /// Enable the installed service without starting it.
    Enable,
    /// Disable automatic startup, optionally stopping the service now.
    Disable(DisableArgs),
    /// Replace a stale ad-hoc identity so macOS asks for Local Network access again.
    RefreshLocalNetworkPermission,
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
            LaunchdCommand::Install(install_args) => {
                install(install_args, role, args.verbose).await
            }
            LaunchdCommand::Uninstall => uninstall(role, args.verbose).await,
            LaunchdCommand::Start => manage_service(role, ServiceAction::Start, args.verbose).await,
            LaunchdCommand::Stop => manage_service(role, ServiceAction::Stop, args.verbose).await,
            LaunchdCommand::Restart => {
                manage_service(role, ServiceAction::Restart, args.verbose).await
            }
            LaunchdCommand::Status => {
                manage_service(role, ServiceAction::Status, args.verbose).await
            }
            LaunchdCommand::Enable => {
                manage_service(role, ServiceAction::Enable, args.verbose).await
            }
            LaunchdCommand::Disable(disable) => {
                manage_service(
                    role,
                    ServiceAction::Disable { now: disable.now },
                    args.verbose,
                )
                .await
            }
            LaunchdCommand::RefreshLocalNetworkPermission => {
                refresh_local_network_permission(role).await
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

/// Derives a safe launchd label from the already validated installation identity.
#[cfg(any(target_os = "macos", test))]
fn service_name(role: ServiceRole) -> Result<String> {
    Ok(format!(
        "{}-{}",
        crate::app_name::app_name()?,
        role.cli_name()
    ))
}

/// Atomically installs a current LaunchAgent definition and optionally starts it.
#[cfg(target_os = "macos")]
async fn install(args: InstallArgs, role: ServiceRole, verbose: bool) -> Result<()> {
    let service = service_name(role)?;
    let config_path = crate::config::default_config_path()?;
    let config_created = crate::service_management::prepare_config(role, &config_path).await?;
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
    let target = service_target(&service);
    if service_is_loaded(&target, verbose).await? {
        run_command("launchctl", &["bootout", &target], verbose)
            .await
            .context("Failed to unload the previous LaunchAgent definition")?;
    }
    crate::service_management::atomic_write(&plist_path, plist_content.as_bytes(), "LaunchAgent")
        .await?;

    // A disabled selection survives plist discovery, so explicitly mark this label
    // enabled while leaving it unloaded until the operator starts it or logs in.
    run_command("launchctl", &["enable", &target], verbose)
        .await
        .context("Failed to enable the LaunchAgent for user login")?;

    if args.start {
        run_command(
            "launchctl",
            &["bootstrap", &user_domain(), &plist_path.to_string_lossy()],
            verbose,
        )
        .await
        .context("Failed to start the newly installed LaunchAgent")?;
    }

    print_manage_help(
        &service,
        &plist_path,
        &config_path,
        config_created,
        role,
        args.start,
    );
    Ok(())
}

/// Stops and removes a LaunchAgent while retaining config and enabling future installs.
#[cfg(target_os = "macos")]
async fn uninstall(role: ServiceRole, verbose: bool) -> Result<()> {
    let service = service_name(role)?;
    let plist_path = launch_agent_path(&service)?;
    let target = service_target(&service);
    let loaded = service_is_loaded(&target, verbose).await?;
    if loaded {
        run_command("launchctl", &["bootout", &target], verbose)
            .await
            .context("Failed to stop and unload the LaunchAgent")?;
    }
    let installed = tokio::fs::try_exists(&plist_path)
        .await
        .with_context(|| format!("Failed to inspect LaunchAgent '{}'", plist_path.display()))?;
    if installed {
        tokio::fs::remove_file(&plist_path)
            .await
            .with_context(|| format!("Failed to remove LaunchAgent '{}'", plist_path.display()))?;
    }
    // launchctl has no override-deletion command. Marking the absent label enabled
    // ensures a later reinstall cannot inherit a previous disabled selection.
    run_command("launchctl", &["enable", &target], verbose)
        .await
        .context("Failed to enable the LaunchAgent label for a future installation")?;
    if installed || loaded {
        println!("Uninstalled LaunchAgent '{service}'; configuration was preserved.");
    } else {
        println!("LaunchAgent '{service}' is already uninstalled; configuration was preserved.");
    }
    Ok(())
}

/// Gives an ad-hoc-signed executable a fresh identity so macOS prompts again.
#[cfg(target_os = "macos")]
async fn refresh_local_network_permission(role: ServiceRole) -> Result<()> {
    let service = service_name(role)?;
    let plist_path = launch_agent_path(&service)?;
    ensure_plist_exists(&plist_path, &service, role).await?;

    let plist = plist_path.to_string_lossy().into_owned();
    let binary_output = run_logged_output(
        "plutil",
        &[
            "-extract".to_string(),
            "ProgramArguments.0".to_string(),
            "raw".to_string(),
            "-o".to_string(),
            "-".to_string(),
            plist,
        ],
    )
    .await?;
    let binary = PathBuf::from(String::from_utf8(binary_output.stdout)?.trim());
    if binary.as_os_str().is_empty() {
        bail!(
            "LaunchAgent '{}' does not contain an executable path",
            plist_path.display()
        );
    }

    let binary_argument = binary.to_string_lossy().into_owned();
    let signature =
        run_logged_output("codesign", &["-dvv".to_string(), binary_argument.clone()]).await?;
    let signature_details = String::from_utf8_lossy(&signature.stderr);
    if signature_has_team_identifier(&signature_details) {
        bail!(
            "Refusing to replace the Developer ID signature on '{}'",
            binary.display()
        );
    }

    let temporary = local_network_signature_temp_path(&binary)?;
    let prepare_result = prepare_local_network_signature(&binary, &temporary).await;
    if let Err(error) = prepare_result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }

    let target = service_target(&service);
    let print_arguments = ["print".to_string(), target.clone()];
    let loaded = match run_logged_status("launchctl", &print_arguments).await {
        Ok(status) => status.success(),
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
    };
    if loaded
        && let Err(error) =
            run_logged_command("launchctl", &["bootout".to_string(), target.clone()]).await
    {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }

    if let Err(error) = tokio::fs::rename(&temporary, &binary).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error).with_context(|| {
            format!(
                "Failed to atomically replace '{}' with the refreshed executable",
                binary.display()
            )
        });
    }
    run_logged_command(
        "launchctl",
        &[
            "bootstrap".to_string(),
            user_domain(),
            plist_path.to_string_lossy().into_owned(),
        ],
    )
    .await?;
    println!("Select Allow when macOS asks whether Redoor may find devices on local networks.");
    Ok(())
}

/// Creates and verifies the replacement before the running service is stopped.
#[cfg(target_os = "macos")]
async fn prepare_local_network_signature(binary: &Path, temporary: &Path) -> Result<()> {
    tokio::fs::copy(binary, temporary).await.with_context(|| {
        format!(
            "Failed to copy '{}' to temporary executable '{}'",
            binary.display(),
            temporary.display()
        )
    })?;
    let identifier = format!("local.redoor.network.{}", uuid::Uuid::new_v4().simple());
    let temporary_argument = temporary.to_string_lossy().into_owned();
    run_logged_command(
        "codesign",
        &[
            "--force".to_string(),
            "--sign".to_string(),
            "-".to_string(),
            "--identifier".to_string(),
            identifier,
            temporary_argument.clone(),
        ],
    )
    .await?;
    run_logged_command(
        "codesign",
        &[
            "--verify".to_string(),
            "--verbose=2".to_string(),
            temporary_argument,
        ],
    )
    .await?;
    tokio::fs::OpenOptions::new()
        .read(true)
        .open(temporary)
        .await
        .with_context(|| format!("Failed to open signed executable '{}'", temporary.display()))?
        .sync_all()
        .await
        .with_context(|| format!("Failed to sync signed executable '{}'", temporary.display()))
}

/// Places the replacement beside the destination so the final rename is atomic.
#[cfg(target_os = "macos")]
fn local_network_signature_temp_path(binary: &Path) -> Result<PathBuf> {
    let file_name = binary
        .file_name()
        .context("LaunchAgent executable path has no file name")?
        .to_string_lossy();
    Ok(binary.with_file_name(format!(
        ".{file_name}.local-network.{}.{}",
        std::process::id(),
        fastrand::u64(..)
    )))
}

/// Distinguishes publisher-signed releases from ad-hoc signatures safely replaceable here.
#[cfg(any(target_os = "macos", test))]
fn signature_has_team_identifier(details: &str) -> bool {
    details.lines().any(|line| {
        line.strip_prefix("TeamIdentifier=")
            .is_some_and(|team| !team.is_empty() && team != "not set")
    })
}

/// Supported launchctl lifecycle operations.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum ServiceAction {
    Start,
    Stop,
    Restart,
    Status,
    Enable,
    Disable { now: bool },
}

/// Executes one action against an installed LaunchAgent in the current GUI domain.
#[cfg(target_os = "macos")]
async fn manage_service(role: ServiceRole, action: ServiceAction, verbose: bool) -> Result<()> {
    let service = service_name(role)?;
    let plist_path = launch_agent_path(&service)?;
    if matches!(action, ServiceAction::Status) {
        return show_status(&service, &plist_path).await;
    }
    ensure_plist_exists(&plist_path, &service, role).await?;

    let domain = user_domain();
    let target = service_target(&service);
    match action {
        ServiceAction::Start => match loaded_service_state(&target).await? {
            Some(state) if state.running => Ok(()),
            Some(_) => run_command("launchctl", &["kickstart", &target], verbose).await,
            None => {
                run_command(
                    "launchctl",
                    &["bootstrap", &domain, &plist_path.to_string_lossy()],
                    verbose,
                )
                .await
            }
        },
        ServiceAction::Stop => {
            if service_is_loaded(&target, verbose).await? {
                run_command("launchctl", &["bootout", &target], verbose).await
            } else {
                Ok(())
            }
        }
        ServiceAction::Restart => {
            if service_is_loaded(&target, verbose).await? {
                run_command("launchctl", &["bootout", &target], verbose)
                    .await
                    .context("Failed to unload the running LaunchAgent before restart")?;
            }
            run_command(
                "launchctl",
                &["bootstrap", &domain, &plist_path.to_string_lossy()],
                verbose,
            )
            .await
        }
        ServiceAction::Status => {
            unreachable!("status returns before installed-service dispatch")
        }
        ServiceAction::Enable => run_command("launchctl", &["enable", &target], verbose).await,
        ServiceAction::Disable { now } => {
            run_command("launchctl", &["disable", &target], verbose)
                .await
                .context("Failed to disable the LaunchAgent at login")?;
            if now && service_is_loaded(&target, verbose).await? {
                run_command("launchctl", &["bootout", &target], verbose).await?;
            }
            Ok(())
        }
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
async fn service_is_loaded(target: &str, verbose: bool) -> Result<bool> {
    let status = run_status_command("launchctl", &["print", target], verbose)
        .await
        .context("Failed to ask launchd whether the service is loaded")?;
    Ok(status.success())
}

/// Captures the process details launchd reports for a loaded service.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Eq, PartialEq)]
struct LaunchdProcessState {
    /// Distinguishes an active process from a loaded job waiting to run.
    running: bool,
    /// Reports the active process ID when launchd includes one.
    pid: Option<String>,
    /// Retains launchd's state word for concise stopped-state diagnostics.
    state: Option<String>,
}

/// Queries a service and returns no state when it is not loaded.
#[cfg(target_os = "macos")]
async fn loaded_service_state(target: &str) -> Result<Option<LaunchdProcessState>> {
    let output = Command::new("launchctl")
        .args(["print", target])
        .output()
        .await
        .context("Failed to ask launchd for the service state")?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(parse_process_state(&String::from_utf8_lossy(
        &output.stdout,
    ))))
}

/// Parses stable launchctl state properties without depending on output layout.
#[cfg(any(target_os = "macos", test))]
fn parse_process_state(print_output: &str) -> LaunchdProcessState {
    let property = |name: &str| {
        print_output
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix(&format!("{name} = ")))
    };
    let state = property("state").map(str::to_owned);
    LaunchdProcessState {
        running: state.as_deref() == Some("running"),
        pid: property("pid").map(str::to_owned),
        state,
    }
}

/// Queries launchd's persistent disabled override when the domain supports it.
#[cfg(target_os = "macos")]
async fn service_is_enabled(service: &str) -> Result<Option<bool>> {
    let output = Command::new("launchctl")
        .args(["print-disabled", &user_domain()])
        .output()
        .await
        .context("Failed to ask launchd for disabled overrides")?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(parse_enabled_override(
        service,
        &String::from_utf8_lossy(&output.stdout),
    ))
}

/// Interprets current and older launchd enablement values for one exact label.
#[cfg(any(target_os = "macos", test))]
fn parse_enabled_override(service: &str, output: &str) -> Option<bool> {
    for line in output.lines() {
        let Some((label, value)) = line.split_once("=>") else {
            continue;
        };
        let label = label.trim();
        let Some(label) = label
            .strip_prefix('"')
            .and_then(|label| label.strip_suffix('"'))
        else {
            continue;
        };
        if label != service {
            continue;
        }
        return match value.trim() {
            "enabled" | "false" => Some(true),
            "disabled" | "true" => Some(false),
            _ => None,
        };
    }
    // Labels without a disabled selection are enabled by launchd's default policy.
    Some(true)
}

/// Reports installation and runtime state without failing merely because it is stopped.
#[cfg(target_os = "macos")]
async fn show_status(service: &str, plist_path: &Path) -> Result<()> {
    let installed = tokio::fs::try_exists(plist_path)
        .await
        .with_context(|| format!("Failed to inspect LaunchAgent '{}'", plist_path.display()))?;
    let state = loaded_service_state(&service_target(service)).await?;
    let enabled = if installed {
        service_is_enabled(service).await?
    } else {
        None
    };
    println!(
        "{}",
        format_status(service, installed, enabled, state.as_ref())
    );
    Ok(())
}

/// Formats all independently useful launchd state dimensions in one concise line.
#[cfg(any(target_os = "macos", test))]
fn format_status(
    service: &str,
    installed: bool,
    enabled: Option<bool>,
    process: Option<&LaunchdProcessState>,
) -> String {
    let runtime = match process {
        Some(process) if process.running => match &process.pid {
            Some(pid) => format!("loaded, running, PID {pid}"),
            None => "loaded, running".to_string(),
        },
        Some(process) => match &process.state {
            Some(state) => format!("loaded, stopped ({state})"),
            None => "loaded, stopped".to_string(),
        },
        None => "unloaded, stopped".to_string(),
    };
    if !installed {
        return match process {
            Some(_) => format!("LaunchAgent '{service}': not installed, {runtime}"),
            None => format!("LaunchAgent '{service}': not installed"),
        };
    }
    let enabled = match enabled {
        Some(true) => "enabled",
        Some(false) => "disabled",
        None => "enablement unknown",
    };
    format!("LaunchAgent '{service}': installed, {enabled}, {runtime}")
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
        "macOS LaunchAgent '{service}' is not installed. Install it with: redoor {} launchd install",
        mode.cli_name()
    )
}

/// Returns the home directory required for user config and LaunchAgents.
#[cfg(target_os = "macos")]
fn home_directory() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot locate the macOS LaunchAgents directory")
}

/// Prints user-scoped launchctl commands after successful installation.
#[cfg(target_os = "macos")]
fn print_manage_help(
    service: &str,
    plist_path: &Path,
    config_path: &Path,
    config_created: bool,
    mode: ServiceRole,
    started: bool,
) {
    println!(
        "Installed LaunchAgent {service} at {} and enabled it at login ({}).",
        plist_path.display(),
        if started { "started" } else { "not started" }
    );
    if config_created {
        println!(
            "Created config at {}.
Edit it before starting the service.",
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
  redoor {} launchd start
  redoor {} launchd stop       # remains enabled for future login
  redoor {} launchd restart
  redoor {} launchd status
  redoor {} launchd disable --now
  redoor {} logs --follow",
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
async fn run_command(program: &str, arguments: &[&str], verbose: bool) -> Result<()> {
    if verbose {
        let status = run_status_command(program, arguments, true).await?;
        if status.success() {
            return Ok(());
        }
        bail!("{} {} failed with {}", program, arguments.join(" "), status);
    }

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

/// Runs a visible command used by the operator-requested permission repair.
#[cfg(target_os = "macos")]
async fn run_logged_command(program: &str, arguments: &[String]) -> Result<()> {
    println!("Executing: {}", format_command(program, arguments));
    let status = Command::new(program)
        .args(arguments)
        .status()
        .await
        .with_context(|| format!("Failed to run {program}"))?;
    if status.success() {
        return Ok(());
    }
    bail!(
        "{} failed with {status}",
        format_command(program, arguments)
    )
}

/// Captures command output while still showing exactly what Redoor executes.
#[cfg(target_os = "macos")]
async fn run_logged_output(program: &str, arguments: &[String]) -> Result<std::process::Output> {
    println!("Executing: {}", format_command(program, arguments));
    let output = Command::new(program)
        .args(arguments)
        .output()
        .await
        .with_context(|| format!("Failed to run {program}"))?;
    if output.status.success() {
        return Ok(output);
    }
    bail!(
        "{} failed with {}: {}",
        format_command(program, arguments),
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

/// Returns status for a logged probe whose non-zero result can be expected state.
#[cfg(target_os = "macos")]
async fn run_logged_status(
    program: &str,
    arguments: &[String],
) -> Result<std::process::ExitStatus> {
    println!("Executing: {}", format_command(program, arguments));
    Command::new(program)
        .args(arguments)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .with_context(|| format!("Failed to run {program}"))
}

/// Formats logged commands unambiguously without relying on shell interpolation.
#[cfg(any(target_os = "macos", test))]
fn format_command(program: &str, arguments: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(arguments.iter().map(|argument| format!("{argument:?}")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Runs a command with visible streams only when launchd diagnostics were requested.
#[cfg(target_os = "macos")]
async fn run_status_command(
    program: &str,
    arguments: &[&str],
    verbose: bool,
) -> Result<std::process::ExitStatus> {
    let mut command = Command::new(program);
    command.args(arguments);
    if !verbose {
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
    }
    command
        .status()
        .await
        .with_context(|| format!("Failed to run {program}"))
}

#[cfg(test)]
mod tests {
    use super::{
        LaunchdProcessState, ServiceRole, escape_xml, format_command, format_status,
        parse_enabled_override, parse_process_state, render_plist, service_name,
        signature_has_team_identifier,
    };
    use std::path::Path;

    /// Verifies labels derive solely from the validated application identity.
    #[test]
    fn service_names_use_application_identity() {
        let app_name = crate::app_name::app_name().unwrap();
        assert_eq!(
            service_name(ServiceRole::Agent).unwrap(),
            format!("{app_name}-agent"),
            "the agent label should use the validated application namespace"
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

    /// Keeps concise status explicit about the difference between loaded and running.
    #[test]
    fn formats_launchd_process_status() {
        let running = parse_process_state(
            "state = running
pid = 1234",
        );
        assert_eq!(
            format_status("redoor-server", true, Some(true), Some(&running)),
            "LaunchAgent 'redoor-server': installed, enabled, loaded, running, PID 1234",
            "a running service should include its process ID"
        );
        let waiting = LaunchdProcessState {
            running: false,
            pid: None,
            state: Some("waiting".to_string()),
        };
        assert_eq!(
            format_status("redoor-server", true, Some(false), Some(&waiting)),
            "LaunchAgent 'redoor-server': installed, disabled, loaded, stopped (waiting)",
            "a registered service without a process must not be described as running"
        );
        assert_eq!(
            format_status("redoor-server", false, Some(true), None),
            "LaunchAgent 'redoor-server': not installed",
            "an absent definition should not show meaningless enablement or runtime state"
        );
        assert_eq!(
            format_status("redoor-server", false, Some(false), Some(&running)),
            "LaunchAgent 'redoor-server': not installed, loaded, running, PID 1234",
            "a loaded orphan should remain visible without implying an installed configuration"
        );
    }

    /// Verifies real and older launchd values are matched by exact label.
    #[test]
    fn interprets_launchd_enablement_override() {
        let output = r#"disabled services = {
        "com.apple.example" => disabled
        "redoor-server-preview" => disabled
        "redoor-server"    =>    enabled
        "redoor-agent" => disabled
}"#;
        assert_eq!(
            parse_enabled_override("redoor-server", output),
            Some(true),
            "the enabled value emitted by current launchctl should be recognized"
        );
        assert_eq!(
            parse_enabled_override("redoor-agent", output),
            Some(false),
            "the disabled value emitted by current launchctl should be recognized"
        );
        assert_eq!(
            parse_enabled_override("redoor", output),
            Some(true),
            "a partial label match must not inherit another service's state"
        );
        let older_output = r#"disabled services = {
    "redoor-server" => true
    "redoor-agent" => false
}"#;
        assert_eq!(
            parse_enabled_override("redoor-server", older_output),
            Some(false),
            "the older true representation means the disabled selection is set"
        );
        assert_eq!(
            parse_enabled_override("redoor-agent", older_output),
            Some(true),
            "the older false representation means the disabled selection is clear"
        );
    }

    /// Ensures only a real signing team prevents the ad-hoc repair operation.
    #[test]
    fn detects_publisher_signed_executables() {
        assert!(
            signature_has_team_identifier(
                "Identifier=fi.example.redoor
TeamIdentifier=ABCDE12345"
            ),
            "a Developer ID team must protect the publisher signature from replacement"
        );
        assert!(
            !signature_has_team_identifier(
                "Identifier=redoor-123
TeamIdentifier=not set"
            ),
            "an ad-hoc signature should remain eligible for the permission repair"
        );
    }

    /// Keeps command logs explicit about argument boundaries and paths containing spaces.
    #[test]
    fn formats_executed_commands() {
        assert_eq!(
            format_command(
                "codesign",
                &[
                    "--verify".to_string(),
                    "/Users/test user/bin/redoor".to_string()
                ]
            ),
            "codesign \"--verify\" \"/Users/test user/bin/redoor\"",
            "logged commands should preserve every argument as a distinct quoted value"
        );
    }
}
