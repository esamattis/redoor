mod actor;
mod connection;
mod logs;
mod messages;
mod notification;
mod protocol;
mod raw;
pub(crate) mod state;
mod terminal;
mod transfer;
mod transfers;
mod ws;

use std::path::PathBuf;

use redoor::{Level, log, types::AgentId};
use sysinfo::System;
use thiserror::Error;
use tokio::sync::mpsc;

pub(crate) use messages::AgentMsg;
pub(crate) use state::{
    ActiveDownloads, ActiveUploads, AgentArgs, AgentState, DownloadSessionHandle,
    LogStreamSessionHandle, NotificationDelay, TerminalSessionHandle, UploadSessionHandle,
};

/// Wraps subsystem-specific agent command failures behind one protocol boundary type.
#[derive(Debug, Error)]
pub(crate) enum AgentCommandError {
    #[error(transparent)]
    LocalCopy(#[from] transfers::copy::LocalCopyError),
    #[error(transparent)]
    TarUpload(#[from] transfers::upload::TarUploadError),
    #[error("{message}")]
    RawUpload {
        kind: redoor::commands::CommandErrorKind,
        message: String,
    },
}

impl AgentCommandError {
    /// Returns the protocol-stable kind that the server maps into an HTTP status.
    pub(crate) fn kind(&self) -> redoor::commands::CommandErrorKind {
        match self {
            Self::LocalCopy(error) => error.kind(),
            Self::TarUpload(error) => error.kind(),
            Self::RawUpload { kind, .. } => kind.clone(),
        }
    }

    /// Builds one raw-upload boundary error without forcing a dedicated inner enum yet.
    pub(crate) fn raw_upload(
        kind: redoor::commands::CommandErrorKind,
        message: impl Into<String>,
    ) -> Self {
        Self::RawUpload {
            kind,
            message: message.into(),
        }
    }
}

impl From<AgentCommandError> for redoor::commands::CommandResult {
    fn from(error: AgentCommandError) -> Self {
        redoor::commands::CommandResult::error(error.kind(), error.to_string())
    }
}

/// Runtime handle used to send control events into the agent task.
#[derive(Clone)]
pub(crate) struct AgentHandle {
    sender: mpsc::Sender<AgentMsg>,
}

impl AgentHandle {
    /// Awaits mailbox capacity so external producers can backpressure instead of
    /// dropping inbound websocket frames when upload handlers slow down.
    pub(crate) async fn send(
        &self,
        message: AgentMsg,
    ) -> Result<(), mpsc::error::SendError<AgentMsg>> {
        self.sender.send(message).await
    }

    /// Attempts to queue one control event without waiting.
    ///
    /// The agent runtime uses this only for self-scheduled messages so it does
    /// not deadlock on its own bounded mailbox.
    pub(crate) fn try_send(
        &self,
        message: AgentMsg,
    ) -> Result<(), mpsc::error::TrySendError<AgentMsg>> {
        self.sender.try_send(message)
    }
}

/// Stateless helper namespace for agent protocol and transfer operations.
pub(crate) struct AgentActor;

/// Long-lived agent runtime that owns connection lifecycle and transfer registries.
pub(crate) struct AgentRuntime {
    pub(crate) state: AgentState,
    /// Desktop detected at process startup, if this agent can plausibly reach a GUI session.
    desktop_environment: Option<notification::DesktopEnvironment>,
    /// User-selected wait after a successful connection, or `None` when notifications are disabled.
    startup_notification_delay: Option<tokio::time::Duration>,
    /// Identifies the connection whose delayed startup notification is currently authoritative.
    startup_notification_generation: Option<(u64, u64)>,
    /// Prevents reconnects from repeating the process-start notification.
    startup_notification_sent: bool,
    /// Counts consecutive reconnect attempts so prolonged outages use a slower retry window.
    reconnect_attempts: u32,
}

/// Runs an agent after resolving settings with CLI > env > config file > default.
pub(crate) async fn run(args: AgentArgs) -> Result<(), Box<dyn std::error::Error>> {
    let resolved = resolve_agent_settings(args).await?;
    let launch_directory = std::env::current_dir()?;
    let configured_directory = resolved
        .dir
        .map(std::path::PathBuf::from)
        .unwrap_or(launch_directory);
    let default_directory = tokio::fs::canonicalize(&configured_directory)
        .await
        .map_err(|error| {
            format!(
                "Failed to resolve agent default directory '{}': {error}",
                configured_directory.display()
            )
        })?;
    if !tokio::fs::metadata(&default_directory).await?.is_dir() {
        return Err(format!(
            "Agent default directory is not a directory: {}",
            configured_directory.display()
        )
        .into());
    }
    let default_directory = default_directory
        .into_os_string()
        .into_string()
        .map_err(|_| "Agent default directory is not valid UTF-8")?;

    let connection = connection::AgentConnection::new(
        resolved.ws_address,
        resolved.connect_address,
        resolved.insecure_tls,
    )?;
    let agent_name = resolved.name;
    let log_file = resolved.log;
    let token = resolved.token;
    let notification_delay = resolved
        .notification_delay_seconds
        .map(tokio::time::Duration::from_secs);
    let loaded_config_path = match resolved.loaded_config_path {
        Some(path) => match tokio::fs::canonicalize(&path).await {
            Ok(canonical) => Some(canonical),
            Err(_) => Some(path),
        },
        None => None,
    };
    // Details API reads this once-per-process value; set before any commands run.
    redoor::commands::set_agent_loaded_config_path(loaded_config_path.clone());

    let agent_id = AgentId::from(agent_name.clone());

    redoor::logging::init(log_file)
        .await
        .map_err(|error| format!("{error:#}"))?;
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
        "Starting agent '{}': ws={}, dir={}",
        agent_name,
        connection.server_url(),
        default_directory
    );

    let (sender, receiver) = mpsc::channel::<AgentMsg>(256);
    let handle = AgentHandle { sender };
    let runtime = AgentRuntime::new(
        agent_id,
        agent_name,
        connection,
        default_directory,
        token,
        notification_delay,
    );

    runtime.run(receiver, handle).await;

    Ok(())
}

/// Imports a missing daemon config before detaching closes the invoking terminal's stdin.
pub(crate) async fn prepare_daemon_config(args: &AgentArgs) -> anyhow::Result<()> {
    let required_settings_provided = args
        .ws_address
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        && args.token.as_deref().is_some_and(|value| !value.is_empty());
    if required_settings_provided {
        return Ok(());
    }

    let config_path = match args.config.as_ref() {
        Some(path) => PathBuf::from(path),
        None => match crate::config::default_config_path() {
            Ok(path) => path,
            Err(_) => return Ok(()),
        },
    };
    let exists = tokio::fs::try_exists(&config_path).await.map_err(|error| {
        anyhow::anyhow!(
            "Failed to inspect config file '{}': {error}",
            config_path.display()
        )
    })?;
    if !exists {
        crate::config::import_agent_config_from_stdin(&config_path).await?;
    }
    Ok(())
}

/// Fully resolved agent launch settings after applying source precedence.
struct ResolvedAgentSettings {
    ws_address: String,
    /// Optional physical TCP endpoint used when a tunnel differs from the logical server URL.
    connect_address: Option<String>,
    /// Disables certificate verification only for explicitly tunneled WSS connections.
    insecure_tls: bool,
    name: String,
    token: String,
    dir: Option<String>,
    log: Option<String>,
    /// Non-negative delay selected on the command line, or `None` when explicitly disabled.
    notification_delay_seconds: Option<u64>,
    /// Path of the TOML file that contributed settings, when one was loaded.
    loaded_config_path: Option<PathBuf>,
}

/// Applies CLI > env > config file > default for every agent setting.
///
/// Clap already merged CLI and env into `args`. The agent name defaults to the
/// machine hostname while `ws_address` and `token` remain required.
async fn resolve_agent_settings(
    args: AgentArgs,
) -> Result<ResolvedAgentSettings, Box<dyn std::error::Error>> {
    let explicit_config = args.config.is_some();
    let required_settings_provided = args
        .ws_address
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        && args.token.as_deref().is_some_and(|value| !value.is_empty());
    let config_path = match args.config.clone() {
        Some(path) => Some(PathBuf::from(path)),
        // Conventional path is optional for agents so fully CLI/env-configured
        // runs still work when HOME is unset or the file is missing.
        None => crate::config::default_config_path().ok(),
    };

    let (file_config, loaded_config_path) = match config_path {
        Some(mut path) => {
            // Explicit --config must exist; the conventional path is optional so
            // fully CLI/env-configured agents do not require a file.
            let exists = tokio::fs::try_exists(&path).await.map_err(|error| {
                format!(
                    "Failed to inspect config file '{}': {error}",
                    path.display()
                )
            })?;
            if !exists {
                if !required_settings_provided {
                    path = crate::config::import_agent_config_from_stdin(&path).await?;
                } else if explicit_config {
                    return Err(format!("Failed to read config file '{}'", path.display()).into());
                } else {
                    return resolve_agent_settings_from_sources(args, None, None);
                }
            }
            let parsed = crate::config::parse_config_file(&path.to_string_lossy())
                .await
                .map_err(|error| {
                    format!("Failed to parse config file '{}': {error}", path.display())
                })?;
            (Some(parsed), Some(path))
        }
        None => return resolve_agent_settings_from_sources(args, None, None),
    };

    resolve_agent_settings_from_sources(args, file_config, loaded_config_path)
}

/// Applies source precedence after optional config discovery or import has completed.
fn resolve_agent_settings_from_sources(
    args: AgentArgs,
    file_config: Option<crate::config::RedoorConfig>,
    loaded_config_path: Option<PathBuf>,
) -> Result<ResolvedAgentSettings, Box<dyn std::error::Error>> {
    let agent_section = file_config
        .as_ref()
        .and_then(|config| config.agent.clone())
        .unwrap_or_default();

    // args already holds CLI or env; config is the next tier.
    let ws_address = first_non_empty([args.ws_address, agent_section.ws_address]).ok_or(
        "agent ws_address is required; set it via CLI, REDOOR_AGENT_WS, or [agent].ws_address",
    )?;

    let name = first_non_empty([args.name, agent_section.name])
        .or_else(System::host_name)
        .ok_or("agent name is not configured and the computer hostname is unavailable")?;

    let token = first_non_empty([
        args.token,
        file_config
            .as_ref()
            .map(|config| config.agent_token.clone()),
    ])
    .ok_or(
        "agent token is required; set it via --token, REDOOR_AGENT_TOKEN, or top-level agent_token",
    )?;

    let dir = first_non_empty([args.dir, agent_section.dir]);
    let notification_delay_seconds =
        match args.notification.unwrap_or(NotificationDelay::Seconds(5)) {
            NotificationDelay::Off => None,
            NotificationDelay::Seconds(seconds) => Some(seconds),
        };
    let log = Some(match first_non_empty([args.log, agent_section.log]) {
        Some(path) => path,
        None => crate::config::default_agent_log_path()?,
    });

    Ok(ResolvedAgentSettings {
        ws_address,
        connect_address: args.connect_address,
        insecure_tls: args.insecure_tls,
        name,
        token,
        dir,
        log,
        notification_delay_seconds,
        loaded_config_path,
    })
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
    use super::{AgentHandle, AgentMsg};
    use tokio::sync::mpsc;

    /// Verifies awaited sends stay pending while the bounded mailbox is full so
    /// websocket ingress can propagate upload backpressure instead of dropping frames.
    #[tokio::test]
    async fn send_waits_for_channel_capacity() {
        let (sender, mut receiver) = mpsc::channel(1);
        let handle = AgentHandle { sender };

        handle
            .try_send(AgentMsg::Connect)
            .expect("initial enqueue should succeed");

        let pending_send = handle.send(AgentMsg::ExitWithError);
        tokio::pin!(pending_send);

        // A pending send here proves the bounded mailbox is applying backpressure instead of accepting and losing another frame.
        assert!(futures_util::poll!(&mut pending_send).is_pending());

        let received = receiver.recv().await;
        // Draining one slot verifies the send can complete only after the runtime makes room in the mailbox.
        assert!(matches!(received, Some(AgentMsg::Connect)));

        // Completing after capacity frees proves awaited ingress can resume without dropping the queued frame.
        assert!(pending_send.await.is_ok());

        let received = receiver.recv().await;
        // Receiving the queued message confirms the mailbox preserved it while the sender was backpressured.
        assert!(matches!(received, Some(AgentMsg::ExitWithError)));
    }

    /// Verifies non-blocking self-sends still fail fast when the mailbox is
    /// full so the runtime does not await capacity on its own queue.
    #[tokio::test]
    async fn try_send_fails_fast_when_channel_is_full() {
        let (sender, _receiver) = mpsc::channel(1);
        let handle = AgentHandle { sender };

        handle
            .try_send(AgentMsg::Connect)
            .expect("initial enqueue should succeed");

        let result = handle.try_send(AgentMsg::ExitWithError);

        // A full error here protects in-actor self-sends from deadlocking the runtime on its own bounded mailbox.
        assert!(matches!(
            result,
            Err(mpsc::error::TrySendError::Full(AgentMsg::ExitWithError))
        ));
    }
}
