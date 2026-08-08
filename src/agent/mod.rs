mod actor;
mod logs;
mod messages;
mod protocol;
mod raw;
pub(crate) mod state;
mod terminal;
mod transfer;
mod transfers;
mod ws;

use std::path::PathBuf;

use redoor::{Level, log, types::AgentId};
use thiserror::Error;
use tokio::sync::mpsc;

pub(crate) use messages::AgentMsg;
pub(crate) use state::{
    ActiveDownloads, ActiveUploads, AgentArgs, AgentState, DownloadSessionHandle,
    LogStreamSessionHandle, TerminalSessionHandle, UploadSessionHandle,
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

    let server_url = resolved.ws_address;
    let agent_name = resolved.name;
    let log_file = resolved.log;
    let token = resolved.token;

    let agent_id = AgentId::from(agent_name.clone());

    redoor::logging::init(log_file).await;
    log!(Level::Info, "Starting agent '{}'", agent_name);

    let (sender, receiver) = mpsc::channel::<AgentMsg>(256);
    let handle = AgentHandle { sender };
    let runtime = AgentRuntime::new(agent_id, agent_name, server_url, default_directory, token);

    runtime.run(receiver, handle).await;

    Ok(())
}

/// Fully resolved agent launch settings after applying source precedence.
struct ResolvedAgentSettings {
    ws_address: String,
    name: String,
    token: String,
    dir: Option<String>,
    log: Option<String>,
}

/// Applies CLI > env > config file > default for every agent setting.
///
/// Clap already merged CLI and env into `args`. Required values (`ws_address`,
/// `name`, `token`) error when still missing after config fallback so a bare
/// `redoor agent` only works when the TOML is complete.
async fn resolve_agent_settings(
    args: AgentArgs,
) -> Result<ResolvedAgentSettings, Box<dyn std::error::Error>> {
    let explicit_config = args.config.is_some();
    let config_path = match args.config {
        Some(path) => Some(PathBuf::from(path)),
        // Conventional path is optional for agents so fully CLI/env-configured
        // runs still work when HOME is unset or the file is missing.
        None => crate::server::default_config_path().ok(),
    };

    let file_config = match config_path {
        Some(path) => {
            // Explicit --config must exist; the conventional path is optional so
            // fully CLI/env-configured agents do not require a file.
            let exists = tokio::fs::try_exists(&path).await.unwrap_or(false);
            if !exists {
                if explicit_config {
                    return Err(format!("Failed to read config file '{}'", path.display()).into());
                }
                None
            } else {
                Some(
                    crate::server::parse_config_file(&path.to_string_lossy())
                        .await
                        .map_err(|error| {
                            format!("Failed to parse config file '{}': {error}", path.display())
                        })?,
                )
            }
        }
        None => None,
    };

    let agent_section = file_config
        .as_ref()
        .and_then(|config| config.agent.clone())
        .unwrap_or_default();

    // args already holds CLI or env; config is the next tier.
    let ws_address = first_non_empty([args.ws_address, agent_section.ws_address]).ok_or(
        "agent ws_address is required; set it via CLI, REDOOR_AGENT_WS, or [agent].ws_address",
    )?;

    let name = first_non_empty([args.name, agent_section.name])
        .ok_or("agent name is required; set it via --name, REDOOR_AGENT_NAME, or [agent].name")?;

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
    let log = first_non_empty([args.log, agent_section.log]);

    Ok(ResolvedAgentSettings {
        ws_address,
        name,
        token,
        dir,
        log,
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
