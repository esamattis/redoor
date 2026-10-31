//! The Redoor agent: connects to a server over websockets and executes its commands.

pub mod args;
mod commands;
mod connection;
mod device_id;
mod errors;
mod exec;
mod logs;
mod notification;
mod ownership;
mod platform;
mod runtime;
mod terminal;
mod transfers;
mod trash;
mod ws;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use args::{AgentArgs, NotificationDelay};
use commands::ctx::AgentServices;
use redoor_core::config::RedoorConfig;
use redoor_core::log;
use redoor_core::paths::AppPaths;
use redoor_core::runtime::RuntimeContext;
use redoor_protocol::{ids::AgentId, wire::log::Level};
use runtime::{AgentExit, AgentHandle, AgentProfile, AgentRuntime};
use sysinfo::System;

/// Bounded runtime mailbox; awaited sends backpressure websocket ingress instead of dropping.
const AGENT_MAILBOX_CAPACITY: usize = 256;

/// Runs an agent after resolving settings with CLI > env > config file > default.
///
/// Returns a failure exit code when a supervised agent is refused or loses its server for
/// too long, so its watchdog or relay restarts it, without a `process::exit`. Standalone
/// agents never end on their own.
pub async fn run(args: AgentArgs, runtime: RuntimeContext) -> Result<ExitCode> {
    let exit_on_stdin_eof = args.exit_on_stdin_eof;
    let loaded_config_path = locate_config(&args, &runtime.paths).await?;
    let file_config = match &loaded_config_path {
        Some(path) => Some(redoor_core::config::parse_config_file(path).await?),
        None => None,
    };
    let settings = AgentSettings::resolve(args, file_config.as_ref(), &runtime.paths)?;
    let default_directory = settings.default_directory().await?;
    let (agent_id, id_source) = settings.device_id(&runtime.paths).await?;

    let connection = connection::AgentConnection::new(
        settings.ws_address,
        settings.connect_address,
        settings.insecure_tls,
    )?;
    let trash = trash::Trash::select(settings.trash_directory.map(PathBuf::from))
        .await
        .map_err(|error| anyhow::anyhow!("Failed to initialize trash: {error}"))?;
    let loaded_config_path = match loaded_config_path {
        Some(path) => Some(tokio::fs::canonicalize(&path).await.unwrap_or(path)),
        None => None,
    };

    redoor_core::logging::init_with_options(
        Some(settings.log),
        settings.log_level,
        settings.log_format,
    )
    .await?;
    match &loaded_config_path {
        Some(path) => {
            log!(Level::Info, "Loaded agent config: path={}", path.display());
        }
        None => {
            log!(
                Level::Info,
                "No agent config file loaded; using CLI/env settings"
            );
        }
    }
    log!(
        Level::Info,
        "Starting agent '{}': agent_id={}, ws={}, home={}",
        settings.name,
        agent_id,
        connection.server_url(),
        default_directory
    );

    // Server- and relay-launched agents are restarted by their owner, which also keeps
    // their binary in step with that owner's version.
    if std::env::var_os(redoor_core::process::MANAGED_AGENT_ENV).is_none() {
        let requests = redoor_core::process::listen_for_reexec()
            .context("Failed to listen for the upgrade re-exec signal")?;
        tokio::spawn(reexec_on_signal(requests));
    }

    let (handle, receiver, lifecycle_receiver) = AgentHandle::channel(AGENT_MAILBOX_CAPACITY);
    let services = AgentServices::new(
        trash,
        redoor_core::partials::PartialStore::new(runtime.paths.data_dir()?),
        loaded_config_path.as_deref(),
    );
    services
        .start_partial_cleanup(settings.partial_max_age_days.saturating_mul(24 * 60 * 60))
        .await;
    let agent = AgentRuntime::new(
        AgentProfile {
            agent_id,
            id_source,
            agent_name: settings.name,
            default_directory,
            token: settings.token,
            ws_timeouts: runtime.ws_timeouts,
        },
        connection,
        services,
        settings
            .notification_delay_seconds
            .map(tokio::time::Duration::from_secs),
    );

    let exit = agent
        .run(receiver, lifecycle_receiver, handle, exit_on_stdin_eof)
        .await;
    Ok(match exit {
        AgentExit::Shutdown => ExitCode::SUCCESS,
        AgentExit::Failure => ExitCode::FAILURE,
    })
}

/// Replaces a standalone agent with its launch binary when `redoor upgrade` asks for it.
///
/// Mirrors the agent restart command, which also re-execs at once without draining work, so
/// an upgrade interrupts running commands exactly like a restart from the UI does.
async fn reexec_on_signal(mut requests: tokio::signal::unix::Signal) {
    if requests.recv().await.is_some() {
        // Printed rather than logged: the log writer is asynchronous and exec would drop the
        // queued entry, while the restarted agent's startup log records the restart anyway.
        eprintln!("Re-exec signal received; restarting agent");
        redoor_core::process::reexec_current_process();
    }
}

/// Finds the TOML file this agent should read, importing it from stdin when required.
///
/// An explicit `--config` must exist unless it can be imported; the conventional path is
/// optional so fully CLI/env-configured agents need neither HOME nor a file. Shared by
/// daemon preparation (which must import before detaching closes the invoking terminal's
/// stdin) and normal startup.
pub async fn locate_config(args: &AgentArgs, paths: &AppPaths) -> Result<Option<PathBuf>> {
    let (path, explicit) = match &args.config {
        Some(path) => (PathBuf::from(path), true),
        None => match paths.default_config_path() {
            Ok(path) => (path, false),
            Err(_) => return Ok(None),
        },
    };
    let exists = tokio::fs::try_exists(&path)
        .await
        .with_context(|| format!("Failed to inspect config file '{}'", path.display()))?;
    if exists {
        return Ok(Some(path));
    }
    if !args.has_required_settings() {
        return Ok(Some(
            redoor_core::config::import_agent_config_from_stdin(&path).await?,
        ));
    }
    if explicit {
        bail!("Failed to read config file '{}'", path.display());
    }
    Ok(None)
}

/// Fully resolved agent launch settings after applying source precedence.
struct AgentSettings {
    /// Canonical agent endpoint URL after normalizing the operator-supplied server address.
    ws_address: String,
    /// Optional physical TCP endpoint used when a tunnel differs from the logical server URL.
    connect_address: Option<String>,
    /// Disables certificate verification only for explicitly tunneled WSS connections.
    insecure_tls: bool,
    /// Registration name; the hostname when nothing else is configured.
    name: String,
    /// Device id from `--agent-id`; `None` for standalone agents, which use their id file.
    agent_id: Option<AgentId>,
    /// Shared registration secret.
    token: String,
    /// Directory the UI opens first; the account home when unset.
    home: Option<String>,
    /// Optional exact root used instead of platform trash-location discovery.
    trash_directory: Option<String>,
    /// Size-bounded log file; always set because agents default to a persistent log.
    log: redoor_core::rotating_log::LogFileSpec,
    /// Effective startup threshold resolved before logger initialization.
    log_level: Level,
    /// Effective process output format resolved before logger initialization.
    log_format: redoor_core::logging::LogFormat,
    /// Non-negative delay selected on the command line, or `None` when explicitly disabled.
    notification_delay_seconds: Option<u64>,
    /// Controls durable interrupted-output retention independently of transfer activity.
    partial_max_age_days: u64,
}

impl AgentSettings {
    /// Applies CLI > env > config file > default for every agent setting.
    ///
    /// Clap already merged CLI and env into `args`. The agent name defaults to the
    /// machine hostname while `server` and `token` remain required.
    fn resolve(args: AgentArgs, file: Option<&RedoorConfig>, paths: &AppPaths) -> Result<Self> {
        let agent_section = file
            .and_then(|config| config.agent.clone())
            .unwrap_or_default();

        let server = first_non_empty([args.server, agent_section.server]).context(
            "agent server is required; set it via CLI, REDOOR_AGENT_WS, or [agent].server",
        )?;
        let ws_address = redoor_core::server_address::ServerAddress::parse_with_warning(&server)
            .map_err(|error| anyhow::anyhow!("invalid agent server address: {error}"))?
            .websocket_url();

        let name = first_non_empty([args.name, agent_section.name])
            .or_else(System::host_name)
            .context("agent name is not configured and the computer hostname is unavailable")?;
        // The server would reject the `hello` anyway; failing here explains it at the source.
        redoor_protocol::ids::validate_device_name(&name)?;
        let agent_id = args
            .agent_id
            .as_deref()
            .map(AgentId::parse)
            .transpose()
            .context("invalid --agent-id")?;

        let token = first_non_empty([args.token, file.map(|config| config.agent_token.clone())])
            .context(
                "agent token is required; set it via --token, REDOOR_AGENT_TOKEN, or top-level agent_token",
            )?;

        let home = first_non_empty([
            args.home,
            std::env::var("REDOOR_AGENT_DIR").ok(),
            agent_section.home,
        ]);
        let notification_delay_seconds =
            match args.notification.unwrap_or(NotificationDelay::Seconds(5)) {
                NotificationDelay::Off => None,
                NotificationDelay::Seconds(seconds) => Some(seconds),
            };
        let log = match first_non_empty([args.log, agent_section.log]) {
            Some(path) => path,
            None => paths.process_log_path(redoor_core::process::ProcessSlot::Agent)?,
        };
        let log_level = redoor_core::logging::resolve_initial_level(
            args.log_level,
            "REDOOR_AGENT_LOG_LEVEL",
            agent_section.log_level,
        )?;
        let log_format = redoor_core::logging::resolve_initial_format(
            args.log_format,
            "REDOOR_AGENT_LOG_FORMAT",
            agent_section.log_format,
        )?;

        Ok(Self {
            ws_address,
            connect_address: args.connect_address,
            insecure_tls: args.insecure_tls,
            name,
            agent_id,
            token,
            home,
            trash_directory: first_non_empty([args.trash_directory]),
            log: redoor_core::rotating_log::LogFileSpec::new(log, agent_section.log_max_size),
            log_level,
            log_format,
            notification_delay_seconds,
            partial_max_age_days: agent_section.partial_max_age_days.unwrap_or(7),
        })
    }

    /// Returns the managed id from `--agent-id`, or the standalone agent's remembered id,
    /// together with where it came from so the runtime knows how to react to an id conflict.
    async fn device_id(&self, paths: &AppPaths) -> Result<(AgentId, device_id::DeviceIdSource)> {
        match &self.agent_id {
            Some(agent_id) => Ok((agent_id.clone(), device_id::DeviceIdSource::Assigned)),
            None => {
                let file = device_id::DeviceIdFile::in_data_dir(&paths.data_dir()?);
                let agent_id = file.load_or_create().await?;
                Ok((
                    agent_id,
                    device_id::DeviceIdSource::File(file.path().to_path_buf()),
                ))
            }
        }
    }

    /// Canonicalizes the UI home directory and insists it is a UTF-8 directory.
    async fn default_directory(&self) -> Result<String> {
        let configured = match &self.home {
            Some(home) => PathBuf::from(home),
            None => {
                redoor_core::paths::home().context("pass --home with the agent home directory")?
            }
        };
        let canonical = tokio::fs::canonicalize(&configured)
            .await
            .with_context(|| {
                format!(
                    "Failed to resolve agent default directory '{}'",
                    configured.display()
                )
            })?;
        if !tokio::fs::metadata(&canonical).await?.is_dir() {
            bail!(
                "Agent default directory is not a directory: {}",
                configured.display()
            );
        }
        path_to_utf8(&canonical)
    }
}

/// Converts a path for the wire protocol, which carries directories as UTF-8 strings.
fn path_to_utf8(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .context("Agent default directory is not valid UTF-8")
}

/// Returns the first non-empty string across precedence tiers.
fn first_non_empty<I>(values: I) -> Option<String>
where
    I: IntoIterator<Item = Option<String>>,
{
    values.into_iter().flatten().find(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Wraps the flattened agent flags so tests can parse them like the real CLI.
    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        args: AgentArgs,
    }

    /// Parses agent flags exactly as `redoor agent` would.
    fn args(argv: &[&str]) -> AgentArgs {
        TestCli::try_parse_from(std::iter::once("agent").chain(argv.iter().copied()))
            .expect("test arguments should parse")
            .args
    }

    /// Parses a config fixture through the real file parser.
    fn config(content: &str) -> RedoorConfig {
        let directory = redoor_core::test_support::TempDir::create();
        let path = directory.path().join("config.toml");
        std::fs::write(&path, content).expect("fixture should be writable");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(redoor_core::config::parse_config_file(&path))
            .expect("fixture should parse")
    }

    /// CLI values win over the file, and the file fills whatever the CLI left out.
    #[test]
    fn cli_overrides_file_and_file_fills_gaps() {
        let file = config(
            r#"agent_token = "file-token"
[agent]
server = "http://file.example:4000"
name = "file-name"
log = "/tmp/file.log"
"#,
        );
        let paths = AppPaths::for_home("redoor", "/home/test");
        let settings = AgentSettings::resolve(
            args(&["http://cli.example:5000", "--name", "cli-name"]),
            Some(&file),
            &paths,
        )
        .expect("settings should resolve");
        // Explicit CLI values must override the shared TOML.
        assert_eq!(settings.ws_address, "ws://cli.example:5000/api/v1/agent/ws");
        assert_eq!(settings.name, "cli-name");
        // Values absent on the CLI come from the file rather than defaults.
        assert_eq!(settings.token, "file-token");
        assert_eq!(settings.log.path, std::path::Path::new("/tmp/file.log"));
    }

    /// Without any server source the error names every place it can be configured.
    #[test]
    fn missing_server_lists_all_sources() {
        let paths = AppPaths::for_home("redoor", "/home/test");
        let error = AgentSettings::resolve(args(&["--token", "t"]), None, &paths)
            .err()
            .expect("a server is required")
            .to_string();
        // Operators must learn the CLI, env and TOML spellings from one message.
        assert!(
            error.contains("REDOOR_AGENT_WS") && error.contains("[agent].server"),
            "{error}"
        );
    }

    /// Without a configured log the agent writes to the namespace's default agent log.
    #[test]
    fn log_defaults_to_the_application_log_directory() {
        let paths = AppPaths::for_home("redoor-dev", "/home/test");
        let settings =
            AgentSettings::resolve(args(&["http://localhost:1", "--token", "t"]), None, &paths)
                .expect("settings should resolve");
        // A persistent log keeps standalone agents diagnosable after detaching.
        assert_eq!(
            settings.log.path,
            std::path::Path::new("/home/test/.local/share/redoor-dev/agent.log")
        );
        // Without a configured limit the log is bounded by the shared default.
        assert_eq!(
            settings.log.max_bytes,
            redoor_core::rotating_log::DEFAULT_LOG_MAX_BYTES
        );
    }
}
