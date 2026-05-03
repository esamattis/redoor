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

pub(crate) async fn run(args: AgentArgs) -> Result<(), Box<dyn std::error::Error>> {
    // Change directory as early as possible so logging, relative paths,
    // and all downstream operations use the requested working directory.
    if let Some(dir) = &args.dir {
        std::env::set_current_dir(dir)?;
    }

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
