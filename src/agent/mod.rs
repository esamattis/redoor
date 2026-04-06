mod actor;
mod messages;
mod protocol;
mod raw;
pub(crate) mod state;
mod transfers;
mod ws;

use redoor::{Level, log, types::AgentId};
use thiserror::Error;

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

pub(crate) struct AgentActor;

pub(crate) async fn run(args: AgentArgs) -> Result<(), Box<dyn std::error::Error>> {
    let server_url = args.ws_address;
    let agent_name = args.name;
    let log_file = args.log;

    let agent_id = AgentId::from(agent_name.clone());

    redoor::logging::init(log_file);
    log!(Level::Info, "Starting agent '{}'", agent_name);

    AgentActor.run(agent_id, agent_name, server_url).await?;

    Ok(())
}
