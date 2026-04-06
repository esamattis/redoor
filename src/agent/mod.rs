mod actor;
mod messages;
mod protocol;
mod raw;
pub(crate) mod state;
mod transfers;
mod ws;

use redoor::{Level, log, types::AgentId};
use thiserror::Error;
use tokio::sync::mpsc;

pub(crate) use messages::AgentMsg;
pub(crate) use state::{
    ActiveDownloads, ActiveUploads, AgentArgs, AgentState, DownloadSessionHandle,
    UploadSessionHandle,
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
    /// Queues one control event for the agent runtime.
    pub(crate) fn send(
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

pub(crate) async fn run(args: AgentArgs) -> Result<(), Box<dyn std::error::Error>> {
    let server_url = args.ws_address;
    let agent_name = args.name;
    let log_file = args.log;

    let agent_id = AgentId::from(agent_name.clone());

    redoor::logging::init(log_file);
    log!(Level::Info, "Starting agent '{}'", agent_name);

    let (sender, receiver) = mpsc::channel::<AgentMsg>(256);
    let handle = AgentHandle { sender };
    let runtime = AgentRuntime::new(agent_id, agent_name, server_url);

    runtime.run(receiver, handle).await;

    Ok(())
}
