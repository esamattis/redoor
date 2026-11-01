//! Execution context handed to every command and the reply it returns to the dispatcher.

use crate::errors::AgentCommandError;
use crate::runtime::cancel::Registration;
use crate::runtime::responder::{ControlSender, Responder, ResultLedger};
use crate::terminal::{TerminalInputs, registry::TerminalSessions};
use crate::transfers::{
    copy::CopyContext,
    stream::{OutputCredits, StreamWriter},
    upload::UploadRoutes,
};
use crate::trash::Trash;
use redoor_core::log;
use redoor_protocol::{
    ids::RequestId,
    wire::{
        command::CommandErrorKind,
        log::Level,
        request::{AgentRequest, CommandError, CommandOutcome},
        stream::StreamChunk,
    },
};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/// Upper bound on concurrent content greps so independent searches cannot saturate the CPU.
const CONTENT_GREP_SLOTS: usize = 4;

/// Long-lived agent facilities shared by every command of every connection.
#[derive(Clone)]
pub(crate) struct AgentServices {
    /// Manifests of resumable partials in the agent data dir; the only resume state.
    pub(crate) partial_store: redoor_core::partials::PartialStore,
    /// Destinations with a running transfer; process-local, so empty after a restart.
    pub(crate) destination_locks: crate::transfers::partials::DestinationLocks,
    /// Platform trash provider selected once at startup.
    pub(crate) trash: Trash,
    /// Bounds concurrent content greps without imposing latest-wins cancellation.
    pub(crate) grep_slots: Arc<Semaphore>,
    /// Routes inbound upload chunks and publication decisions to their workers.
    pub(crate) upload_routes: UploadRoutes,
    /// Routes inbound terminal input and resizes to their attachments.
    pub(crate) terminal_inputs: TerminalInputs,
    /// Every terminal session of the process; they outlive connections.
    pub(crate) terminal_sessions: TerminalSessions,
    /// Routes server credit grants to the output stream writers waiting for them.
    pub(crate) output_credits: OutputCredits,
    /// Requests of the current connection that still owe their one result.
    pub(crate) results: ResultLedger,
    /// TOML file this process loaded, reported by `GetAgentDetails`; empty for CLI/env-only runs.
    pub(crate) loaded_config_path: Arc<str>,
}

impl AgentServices {
    /// Bundles the startup-selected trash provider, partial store and config origin with fresh
    /// shared state.
    pub(crate) fn new(
        trash: Trash,
        partial_store: redoor_core::partials::PartialStore,
        loaded_config_path: Option<&std::path::Path>,
    ) -> Self {
        Self {
            partial_store,
            destination_locks: Default::default(),
            trash,
            grep_slots: Arc::new(Semaphore::new(CONTENT_GREP_SLOTS)),
            upload_routes: UploadRoutes::default(),
            terminal_inputs: TerminalInputs::default(),
            terminal_sessions: TerminalSessions::default(),
            output_credits: OutputCredits::default(),
            results: ResultLedger::default(),
            loaded_config_path: loaded_config_path
                .map(|path| path.display().to_string())
                .unwrap_or_default()
                .into(),
        }
    }

    /// Expires partials of abandoned transfers at startup and then daily.
    ///
    /// The startup sweep finishes before the agent connects, so an expired partial is never
    /// offered for resume. Failures are logged rather than fatal: a leftover partial must not
    /// keep the agent from starting.
    pub(crate) async fn start_partial_cleanup(&self, max_age_seconds: u64) {
        const PERIOD: tokio::time::Duration = tokio::time::Duration::from_secs(24 * 60 * 60);
        let store = self.partial_store.clone();
        let locks = self.destination_locks.clone();
        if let Err(error) = store.cleanup(max_age_seconds, |_| false).await {
            log!(Level::Warning, "Partial cleanup failed: {}", error);
        }
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + PERIOD, PERIOD);
            loop {
                interval.tick().await;
                // Active transfers keep their partial however long they run.
                if let Err(error) = store
                    .cleanup(max_age_seconds, |path| locks.contains(path))
                    .await
                {
                    log!(Level::Warning, "Partial cleanup failed: {}", error);
                }
            }
        });
    }
}

impl AgentServices {
    /// Hands one inbound binary frame to the worker that owns its stream.
    ///
    /// Called by the connection reader, so payload never passes through the runtime mailbox;
    /// frames of streams nobody owns anymore are dropped.
    pub(crate) async fn route_stream_frame(&self, bytes: &[u8], control: &ControlSender) {
        let chunk = match StreamChunk::from_bytes(bytes) {
            Ok(chunk) => chunk,
            Err(error) => {
                log!(Level::Warning, "Dropping malformed stream frame: {}", error);
                return;
            }
        };
        if let Some(chunk) = self.terminal_inputs.deliver(chunk) {
            self.upload_routes
                .route_chunk(chunk, control, &self.results)
                .await;
        }
    }
}

/// Everything one command may use while it runs.
///
/// Built once by the dispatcher from the command's policy so commands never reach into runtime
/// state or process globals for their connection resources.
pub(crate) struct CommandCtx {
    /// Control-lane responder for progress, readiness and publication requests.
    pub(crate) responder: Responder,
    /// Cooperative cancellation: the request registration for request-scoped commands,
    /// otherwise a child of the control connection.
    pub(crate) cancel: CancellationToken,
    /// Request-id registration; dropping it unregisters the request from `cancel`.
    pub(crate) registration: Option<Registration<RequestId>>,
    /// Bulk lane of the connection for commands that stream output; absent in unit tests of
    /// control-only commands.
    pub(crate) bulk: Option<ControlSender>,
    /// Initial credit the server granted the command's output stream.
    pub(crate) credit: u32,
    /// Shared long-lived facilities.
    pub(crate) services: AgentServices,
}

impl CommandCtx {
    /// Borrows the cancellation and progress plumbing used by copy, move and restore.
    pub(crate) fn copy_context(&self) -> CopyContext<'_> {
        CopyContext {
            responder: &self.responder,
            cancel: &self.cancel,
            services: Some(&self.services),
            registration: self.registration.as_ref(),
            partial: None,
        }
    }

    /// Splits the context into what an output stream needs.
    ///
    /// Admission guarantees both the bulk lane and the registration for output commands; a
    /// missing one is reported instead of panicking so a policy mistake cannot crash the agent.
    pub(crate) fn into_output(self) -> Result<OutputLane, AgentCommandError> {
        let request_id = self.responder.request_id();
        match (self.bulk, self.registration) {
            (Some(bulk), Some(registration)) => {
                let stream = StreamWriter::new(
                    bulk,
                    request_id,
                    self.services
                        .output_credits
                        .register_with_window(request_id, self.credit),
                );
                Ok(OutputLane {
                    stream,
                    registration,
                    responder: self.responder,
                })
            }
            _ => Err(AgentCommandError::new(
                CommandErrorKind::Internal,
                "Output command was dispatched without a connection",
            )),
        }
    }

    /// Builds a context without a connection for unit tests; frames land in the receiver.
    #[cfg(test)]
    pub(crate) fn detached(
        request_id: RequestId,
    ) -> (
        Self,
        tokio::sync::mpsc::Receiver<crate::runtime::responder::OutboundFrame>,
    ) {
        let (responder, frames) = Responder::recording(request_id, 16);
        (
            Self {
                responder,
                cancel: CancellationToken::new(),
                registration: None,
                bulk: None,
                credit: 0,
                // Never created: a test that writes partials must choose its own directory.
                services: AgentServices::new(
                    Trash::unsupported(),
                    redoor_core::partials::PartialStore::new("/nonexistent/redoor-agent".into()),
                    None,
                ),
            },
            frames,
        )
    }
}

/// Resources of a command that streams output on its request stream.
pub(crate) struct OutputLane {
    pub(crate) stream: StreamWriter,
    pub(crate) registration: Registration<RequestId>,
    pub(crate) responder: Responder,
}

/// How a finished command reports its outcome.
pub(crate) enum Reply {
    /// Send this outcome on the control lane.
    Result(CommandOutcome),
    /// Send this outcome on the control lane, then replace the process. Restart and upgrade
    /// must answer before the process goes away, or the server would see a dropped connection
    /// instead of a successful response.
    Reexec {
        outcome: CommandOutcome,
        path: Option<std::path::PathBuf>,
    },
    /// Send this outcome on the stream's own lane, after the data already queued there, so
    /// the server has seen the whole stream when the result arrives.
    Stream {
        stream: StreamWriter,
        outcome: CommandOutcome,
    },
}

impl Reply {
    /// Answers request `R` with its typed response or failure; the type parameter makes the
    /// compiler check that a command answers with its own response type.
    pub(crate) fn of<R: AgentRequest>(result: Result<R::Response, CommandError>) -> Self {
        Self::Result(R::encode(result))
    }

    /// Answers request `R` on its stream's lane, behind the stream's data.
    pub(crate) fn stream<R: AgentRequest>(
        stream: StreamWriter,
        result: Result<R::Response, CommandError>,
    ) -> Self {
        Self::Stream {
            stream,
            outcome: R::encode(result),
        }
    }

    /// Answers with a failure, which has the same shape for every request.
    pub(crate) fn failure(error: impl Into<CommandError>) -> Self {
        Self::Result(CommandOutcome::Error(error.into()))
    }
}
