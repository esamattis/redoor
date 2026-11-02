//! Installs Redoor as a systemd service.
//!
//! Non-root installs a lingering user unit under `~/.config/systemd/user`.
//! Root installs a system unit under `/etc/systemd/system`: the server runs as
//! a dedicated `redoor` system user, while the agent and relays stay root so they
//! keep the privileges (and SSH identity) of the account that installed them.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use redoor_core::paths::AppPaths;
use redoor_core::subprocess::run_checked;
use tokio::process::Command;

use super::{ServiceBackend, ServiceRole, ServiceRuntime, ServiceState, not_installed};

/// systemd control for one role in the scope implied by the current privileges.
pub(super) struct SystemdBackend {
    /// Role the unit runs; selects the subcommand and service identity.
    role: ServiceRole,
    /// `<app-name>-<role>.service`, or `<app-name>-relay-<id>.service` for relays.
    unit: String,
    /// User manager (`--user`) for non-root callers, system manager for root.
    user: bool,
    /// Namespace, home and config/log locations.
    paths: AppPaths,
}

impl SystemdBackend {
    /// Resolves the unit name and scope for `role`.
    pub(super) fn new(role: ServiceRole, paths: &AppPaths) -> Self {
        Self {
            unit: unit_name(&role, paths.app_name()),
            role,
            user: !nix::unistd::Uid::effective().is_root(),
            paths: paths.clone(),
        }
    }

    /// Runs `systemctl` in this backend's scope.
    async fn systemctl(&self, arguments: &[&str]) -> Result<()> {
        let mut full = Vec::with_capacity(arguments.len() + 1);
        if self.user {
            full.push("--user");
        }
        full.extend_from_slice(arguments);
        Ok(run_checked("systemctl", &full, false).await?)
    }

    /// Runs `systemctl` in this backend's scope and returns its stdout, without a status check.
    async fn systemctl_output(&self, arguments: &[&str]) -> Result<std::process::Output> {
        let mut command = Command::new("systemctl");
        if self.user {
            command.arg("--user");
        }
        command
            .args(arguments)
            .output()
            .await
            .context("Failed to run systemctl")
    }

    /// Directory holding unit files for this scope.
    fn unit_directory(&self) -> Result<PathBuf> {
        if self.user {
            Ok(self
                .paths
                .home("the systemd user unit directory")?
                .join(".config/systemd/user"))
        } else {
            Ok(PathBuf::from("/etc/systemd/system"))
        }
    }

    /// Expected unit file path for this scope.
    fn unit_path(&self) -> Result<PathBuf> {
        Ok(self.unit_directory()?.join(&self.unit))
    }

    /// Whether the unit file exists on disk.
    async fn unit_file_exists(&self) -> Result<bool> {
        let path = self.unit_path()?;
        tokio::fs::try_exists(&path)
            .await
            .with_context(|| format!("Failed to inspect systemd unit '{}'", path.display()))
    }

    /// Reads systemd's load state; `not-found` or empty means the manager does not know the unit.
    async fn load_state(&self) -> Result<String> {
        let output = self
            .systemctl_output(&["show", "--property=LoadState", "--value", &self.unit])
            .await?;
        if !output.status.success() {
            bail!(
                "Failed to check whether systemd unit '{}' exists: {}",
                self.unit,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// Scope word used in diagnostics.
    fn scope(&self) -> &'static str {
        if self.user { "user" } else { "system" }
    }

    /// Reloads, drops a stale process, enables on boot, and optionally starts the unit.
    ///
    /// `daemon-reload` is required after every unit rewrite so systemd does not keep
    /// the old in-memory definition. Stopping first ensures a prior process cannot
    /// stay active with a stale binary or unit after installation rewrites the file.
    async fn activate(&self, start: bool) -> Result<()> {
        self.systemctl(&["daemon-reload"]).await.with_context(|| {
            format!(
                "Failed to reload the systemd {} manager after writing the service",
                self.scope()
            )
        })?;
        // Harmless when the unit is already inactive.
        self.systemctl(&["stop", &self.unit])
            .await
            .with_context(|| {
                format!(
                    "Failed to stop previous {} after writing the unit",
                    self.unit
                )
            })?;
        self.systemctl(&["enable", &self.unit])
            .await
            .with_context(|| format!("Failed to enable {} on boot", self.unit))?;
        if start {
            self.systemctl(&["start", &self.unit])
                .await
                .with_context(|| format!("Failed to start {} after installing it", self.unit))?;
        }
        Ok(())
    }

    /// Prepares the system-wide pieces root installs need before the unit is written.
    async fn prepare_system_install(&self, config_path: &Path) -> Result<()> {
        if self.role == ServiceRole::Server {
            // Dedicated account so the listening server is not a long-lived root process.
            ensure_redoor_system_user().await?;
            // Config is 0600 from bootstrap; the service user must own it to read secrets.
            let config_directory = config_path
                .parent()
                .context("Config path has no parent directory")?;
            chown_path_to_redoor(config_directory).await?;
            chown_path_to_redoor(config_path).await?;
        }
        // Pre-create the conventional log directory so the `redoor` service user can
        // open log files even when the agent unit (root) created the tree.
        ensure_system_log_directory(&self.paths).await
    }
}

impl ServiceBackend for SystemdBackend {
    /// Used in `redoor <role> systemd ...` guidance.
    fn manager(&self) -> &'static str {
        "systemd"
    }

    /// Matches the established `Systemd unit ...` status prefix.
    fn describe(&self) -> String {
        format!("Systemd unit '{}'", self.unit)
    }

    /// Enabled units start with the machine (user units via lingering).
    fn autostart_trigger(&self) -> &'static str {
        "boot"
    }

    /// System units differ from user units in identity and install target.
    fn render_definition(&self, binary: &Path, config_path: &Path) -> String {
        render_unit(
            &self.role,
            binary,
            config_path,
            !self.user,
            self.paths.app_name(),
        )
    }

    /// Root installs also prepare the service account, config ownership and log directory;
    /// user installs enable lingering so the service survives logout.
    async fn install(&self, config_path: &Path, start: bool) -> Result<PathBuf> {
        if !self.user {
            self.prepare_system_install(config_path).await?;
        }
        let binary = super::current_binary().await?;
        let unit_directory = self.unit_directory()?;
        tokio::fs::create_dir_all(&unit_directory)
            .await
            .with_context(|| {
                format!(
                    "Failed to create systemd unit directory '{}'",
                    unit_directory.display()
                )
            })?;
        let unit_path = unit_directory.join(&self.unit);
        let content = self.render_definition(&binary, config_path);
        super::atomic_write(&unit_path, content.as_bytes(), "systemd unit").await?;
        if self.user {
            let username = current_username().await?;
            run_checked("loginctl", &["enable-linger", &username], false)
                .await
                .context(
                    "Failed to enable user lingering; the service would stop when you log out",
                )?;
        }
        self.activate(start).await?;
        Ok(unit_path)
    }

    /// Stops and disables units the manager still knows even when the file is gone, so
    /// orphans are cleaned up too.
    async fn uninstall(&self) -> Result<bool> {
        let installed = self.unit_file_exists().await?;
        let manager_knows_unit = !matches!(self.load_state().await?.as_str(), "" | "not-found");
        if manager_knows_unit {
            self.systemctl(&["stop", &self.unit])
                .await
                .with_context(|| format!("Failed to stop {} before uninstalling", self.unit))?;
        }
        if installed || manager_knows_unit {
            self.systemctl(&["disable", &self.unit])
                .await
                .with_context(|| format!("Failed to disable {} before uninstalling", self.unit))?;
        }
        if installed {
            let path = self.unit_path()?;
            tokio::fs::remove_file(&path)
                .await
                .with_context(|| format!("Failed to remove systemd unit '{}'", path.display()))?;
        }
        self.systemctl(&["daemon-reload"])
            .await
            .context("Failed to reload systemd after uninstalling the service")?;
        Ok(installed)
    }

    /// Uses the manager's load state so a unit installed elsewhere still counts.
    async fn ensure_installed(&self) -> Result<()> {
        validate_unit_load_state(&self.unit, &self.role, self.user, &self.load_state().await?)
    }

    /// Starts the unit in this scope.
    async fn start(&self) -> Result<()> {
        self.systemctl(&["start", &self.unit]).await
    }

    /// Stops the unit but leaves it enabled for the next boot.
    async fn stop(&self) -> Result<()> {
        self.systemctl(&["stop", &self.unit]).await
    }

    /// Reloads first so an edited unit file takes effect.
    async fn restart(&self) -> Result<()> {
        self.systemctl(&["daemon-reload"])
            .await
            .context("Failed to reload systemd before restarting the service")?;
        self.systemctl(&["restart", &self.unit]).await
    }

    /// Enables the unit for future boots.
    async fn enable(&self) -> Result<()> {
        self.systemctl(&["enable", &self.unit]).await
    }

    /// `--now` lets systemd stop and disable in one transaction.
    async fn disable(&self, now: bool) -> Result<()> {
        if now {
            self.systemctl(&["disable", "--now", &self.unit]).await
        } else {
            self.systemctl(&["disable", &self.unit]).await
        }
    }

    /// Combines the unit file, `systemctl show` and `is-enabled` into the shared state.
    async fn status(&self) -> Result<ServiceState> {
        let installed = self.unit_file_exists().await?;
        let output = self
            .systemctl_output(&[
                "show",
                "--property=LoadState,ActiveState,SubState,MainPID",
                &self.unit,
            ])
            .await?;
        if !output.status.success() {
            bail!(
                "Failed to ask systemd for '{}' status: {}",
                self.unit,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let runtime = parse_runtime(&String::from_utf8_lossy(&output.stdout));
        let enabled = if installed {
            let output = self.systemctl_output(&["is-enabled", &self.unit]).await?;
            parse_enabled_state(&String::from_utf8_lossy(&output.stdout))
        } else {
            None
        };
        Ok(ServiceState {
            installed,
            enabled,
            runtime,
        })
    }
}

/// Derives the unit file name from the already validated installation identity.
fn unit_name(role: &ServiceRole, app_name: &str) -> String {
    format!("{app_name}-{}.service", role.service_suffix())
}

/// Turns systemd's `not-found` load state into an actionable Redoor error.
fn validate_unit_load_state(
    service: &str,
    role: &ServiceRole,
    user: bool,
    load_state: &str,
) -> Result<()> {
    if load_state != "not-found" && !load_state.is_empty() {
        return Ok(());
    }
    let scope = if user { "user" } else { "system" };
    Err(not_installed(
        &format!("Systemd {scope} unit '{service}'"),
        role,
        "systemd",
    ))
}

/// Parses key-value `systemctl show` output independently of property order.
fn parse_runtime(output: &str) -> ServiceRuntime {
    let property = |name: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .unwrap_or_default()
    };
    if matches!(property("LoadState"), "" | "not-found") {
        return ServiceRuntime::Unloaded;
    }
    match property("MainPID") {
        "" | "0" => ServiceRuntime::Stopped {
            detail: Some(format!(
                "{}/{}",
                property("ActiveState"),
                property("SubState")
            )),
        },
        pid => ServiceRuntime::Running {
            pid: Some(pid.to_string()),
        },
    }
}

/// Interprets systemd enablement states without treating masking as unknown.
fn parse_enabled_state(output: &str) -> Option<bool> {
    match output.trim() {
        "enabled" | "enabled-runtime" | "linked" | "linked-runtime" | "alias" => Some(true),
        "disabled" | "masked" | "masked-runtime" | "static" | "indirect" | "generated"
        | "transient" | "not-found" => Some(false),
        _ => None,
    }
}

/// Creates the selected `/var/log/<app-name>` and hands ownership to `redoor` when available.
async fn ensure_system_log_directory(paths: &AppPaths) -> Result<()> {
    let log_directory = paths.log_dir()?;
    tokio::fs::create_dir_all(&log_directory)
        .await
        .with_context(|| {
            format!(
                "Failed to create system log directory '{}'",
                log_directory.display()
            )
        })?;
    if lookup_redoor_user().await?.is_some() {
        // Server units drop to `redoor` and must be able to create/append logs here.
        chown_path_to_redoor(&log_directory).await?;
    }
    Ok(())
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

/// Looks up the `redoor` service account off the async runtime because NSS may block.
async fn lookup_redoor_user() -> Result<Option<nix::unistd::User>> {
    tokio::task::spawn_blocking(|| nix::unistd::User::from_name("redoor"))
        .await
        .context("Failed to join redoor user lookup task")?
        .context("Failed to look up the redoor system user")
}

/// Creates the unprivileged `redoor` system account used by the server unit.
async fn ensure_redoor_system_user() -> Result<()> {
    if lookup_redoor_user().await?.is_some() {
        return Ok(());
    }
    // System account with a private home for session files; nologin keeps it non-interactive.
    run_checked(
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
        false,
    )
    .await
    .context("Failed to create the redoor system user")
}

/// Gives the `redoor` service account ownership so it can read 0600 config secrets.
async fn chown_path_to_redoor(path: &Path) -> Result<()> {
    let user = lookup_redoor_user()
        .await?
        .context("redoor system user is missing after ensure_redoor_system_user")?;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
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

/// Renders a user or system unit. No connection flags are passed — the TOML is authoritative.
fn render_unit(
    role: &ServiceRole,
    binary: &Path,
    config_path: &Path,
    system: bool,
    app_name: &str,
) -> String {
    let binary = quote_unit_argument(binary.to_string_lossy().as_ref());
    let config_path = quote_unit_argument(config_path.to_string_lossy().as_ref());
    let app_environment = quote_unit_argument(&format!("REDOOR_APP_NAME={app_name}"));
    let description = role.description();
    // Role arguments are fixed words and validated relay IDs, so they need no quoting.
    // Pin --config so the unit always loads the file prepared during installation.
    let command = format!(
        "{binary} {} --config {config_path}",
        role.program_arguments().join(" ")
    );
    // `exec` still fails the start when the binary cannot be executed, without waiting for
    // a readiness notification the process never sends.
    let service_type = if role.notifies_readiness() {
        "notify"
    } else {
        "exec"
    };
    // System server drops privileges; system agent stays root for host management.
    let service_identity = match (system, role) {
        (true, ServiceRole::Server) => "User=redoor\nGroup=redoor\n",
        _ => "",
    };
    // Managed agent daemons must survive a restart of the server. They leave its cgroup
    // through a transient scope when the manager allows it, which a system service running
    // as `redoor` is not allowed to create; stopping only the main process keeps them either
    // way. The server's own session processes end with it, because their stdin closes.
    let kill_mode = match role {
        ServiceRole::Server => "KillMode=process\n",
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
Type={service_type}
{service_identity}{kill_mode}Environment={app_environment}
ExecStart={command}
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
    use super::*;

    /// Verifies unit names derive solely from the validated application identity.
    #[test]
    fn unit_names_use_application_identity() {
        assert_eq!(
            unit_name(&ServiceRole::Agent, "redoor-dev"),
            "redoor-dev-agent.service",
            "the agent unit should use the effective application namespace"
        );
        assert_eq!(
            unit_name(&ServiceRole::Server, "redoor-dev"),
            "redoor-dev-server.service",
            "the server unit should use the effective application namespace"
        );
        assert_eq!(
            unit_name(&ServiceRole::Relay("production".into()), "redoor-dev"),
            "redoor-dev-relay-production.service",
            "each relay needs its own unit so several can be installed side by side"
        );
    }

    /// Verifies absent units produce a clear error with the correct scope and install command.
    #[test]
    fn missing_unit_load_state_has_actionable_error() {
        let error = validate_unit_load_state(
            "custom-agent.service",
            &ServiceRole::Agent,
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
                &ServiceRole::Server,
                false,
                "loaded"
            )
            .is_ok(),
            "a loaded unit must allow the requested management action"
        );
    }

    /// Verifies systemctl properties become the shared runtime state.
    #[test]
    fn parses_systemd_runtime_state() {
        assert_eq!(
            parse_runtime(
                "LoadState=loaded
ActiveState=active
SubState=running
MainPID=4321"
            ),
            ServiceRuntime::Running {
                pid: Some("4321".to_string())
            },
            "an active service should report its main process ID"
        );
        assert_eq!(
            parse_runtime(
                "LoadState=loaded
ActiveState=inactive
SubState=dead
MainPID=0"
            ),
            ServiceRuntime::Stopped {
                detail: Some("inactive/dead".to_string())
            },
            "a loaded stopped unit keeps systemd's state words"
        );
        assert_eq!(
            parse_runtime(
                "LoadState=not-found
ActiveState=inactive
SubState=dead
MainPID=0"
            ),
            ServiceRuntime::Unloaded,
            "an unknown unit is unloaded"
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

    /// Verifies agent units pin the prepared config and take no other CLI flags.
    #[test]
    fn agent_unit_pins_config_without_other_cli_flags() {
        let unit = render_unit(
            &ServiceRole::Agent,
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
            &ServiceRole::Server,
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
            &ServiceRole::Server,
            Path::new("/usr/local/bin/redoor"),
            Path::new("/etc/redoor/config.toml"),
            true,
            "redoor",
        );

        assert!(
            unit.contains("User=redoor\nGroup=redoor\n"),
            "system server must not stay root: {unit}"
        );
        // Without a scope of their own, managed daemons share the server's cgroup, and a
        // restart must not kill them with the server.
        assert!(unit.contains("KillMode=process\n"), "{unit}");
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
            &ServiceRole::Agent,
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

    /// Verifies relay units run the named relay in the foreground without readiness waits.
    #[test]
    fn relay_unit_starts_named_relay() {
        let unit = render_unit(
            &ServiceRole::Relay("production".into()),
            Path::new("/home/test/bin/redoor"),
            Path::new("/home/test/.config/redoor/config.toml"),
            false,
            "redoor",
        );

        assert!(
            unit.contains(
                "ExecStart=\"/home/test/bin/redoor\" agent relay start production --config \"/home/test/.config/redoor/config.toml\""
            ),
            "the relay service must start the selected relay with the pinned config: {unit}"
        );
        assert!(
            !unit.contains("--daemon"),
            "systemd must supervise the relay process itself: {unit}"
        );
        assert!(
            unit.contains("Type=exec"),
            "relays never send READY=1, so a notify unit would time out: {unit}"
        );
        assert!(
            unit.contains("Description=Redoor relay production"),
            "the description should identify which relay the unit runs: {unit}"
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
