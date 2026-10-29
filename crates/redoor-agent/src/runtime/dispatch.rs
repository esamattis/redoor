//! Admission, cancellation, task ownership and responses for every command.
//!
//! The dispatcher reads [`Command::policy`] once and applies it uniformly, so a new command only
//! needs a policy entry and a [`RunCommand`] arm; it cannot forget to register for cancel,
//! respond, or be joined on teardown.

use super::cancel::{RegisterError, Registration};
use super::responder::{ControlSender, PostSend, Responder};
use super::sessions::Sessions;
use crate::commands::RunCommand;
use crate::commands::ctx::{AgentServices, CommandCtx, Reply};
use futures_util::FutureExt;
use redoor_core::{log, log_error};
use redoor_protocol::{
    ids::RequestId,
    wire::{
        command::{Command, CommandErrorKind},
        log::Level,
        policy::{CancelScope, CommandPolicy},
        request::{CommandError, CommandOutcome},
    },
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

/// Caps independently executing non-upload commands for one control generation.
const MAX_CONCURRENT_COMMANDS: usize = 32;

/// Connection resources a command may use, captured when it is dispatched.
pub(crate) struct DispatchLink<'a> {
    pub(crate) control: &'a ControlSender,
    /// Lane for stream data of output commands.
    pub(crate) bulk: &'a ControlSender,
    /// Initial credit of the command's output stream, from the command frame.
    pub(crate) credit: u32,
    /// Cancelled when the control connection ends.
    pub(crate) scope: &'a CancellationToken,
}

/// Owns every running command of the current control connection.
pub(crate) struct Dispatcher {
    /// Ordinary commands, bounded by [`MAX_CONCURRENT_COMMANDS`].
    commands: JoinSet<()>,
    /// Upload workers, bounded by the server's transfer admission rather than this cap.
    uploads: JoinSet<()>,
    /// Serializes commands whose policy is `exclusive`.
    exclusive: Arc<Mutex<()>>,
    services: AgentServices,
}

impl Dispatcher {
    /// Creates a dispatcher with no running work.
    pub(crate) fn new(services: AgentServices) -> Self {
        Self {
            commands: JoinSet::new(),
            uploads: JoinSet::new(),
            exclusive: Arc::new(Mutex::new(())),
            services,
        }
    }

    /// Shared facilities, also used by the connection reader.
    pub(crate) fn services(&self) -> &AgentServices {
        &self.services
    }

    /// Admits, registers and spawns one command, answering immediately when it cannot run.
    pub(crate) async fn dispatch(
        &mut self,
        request_id: RequestId,
        command: Command,
        link: DispatchLink<'_>,
        sessions: &mut Sessions,
    ) {
        log!(
            Level::Info,
            "Command received: request_id={}, command={}",
            request_id,
            command.summary()
        );
        if !self.services.results.open(request_id) {
            // The server allocates unique ids, so this can only be a misbehaving server; a
            // second answer would break the one-result rule for the running request.
            log!(
                Level::Warning,
                "Ignoring a command whose request id is already running: request_id={}",
                request_id
            );
            return;
        }
        let policy = command.policy();
        let responder = Responder::new(
            link.control.clone(),
            self.services.results.clone(),
            request_id,
        );
        let is_upload = policy.upload_kind().is_some();
        if !is_upload && !self.command_capacity_available() {
            let _ = responder
                .respond(CommandOutcome::error(
                    CommandErrorKind::ServiceUnavailable,
                    "Agent command execution limit reached",
                ))
                .await;
            return;
        }
        let (cancel, registration) = match Self::cancellation(&policy, request_id, &link, sessions)
        {
            Ok(cancellation) => cancellation,
            Err(RegisterError::Duplicate | RegisterError::Full) => {
                let _ = responder
                    .respond(CommandOutcome::error(
                        CommandErrorKind::AlreadyExists,
                        format!("Request is already running for request_id={request_id}"),
                    ))
                    .await;
                return;
            }
        };

        let ctx = CommandCtx {
            responder,
            cancel,
            registration,
            bulk: Some(link.bulk.clone()),
            credit: link.credit,
            services: self.services.clone(),
        };
        let task = Self::execute(command, policy, ctx, self.exclusive.clone());
        if is_upload {
            self.uploads.spawn(task);
        } else {
            self.commands.spawn(task);
        }
    }

    /// Chooses the command's cancellation token, registering request-scoped commands.
    fn cancellation(
        policy: &CommandPolicy,
        request_id: RequestId,
        link: &DispatchLink<'_>,
        sessions: &mut Sessions,
    ) -> Result<(CancellationToken, Option<Registration<RequestId>>), RegisterError> {
        match policy.cancel_scope {
            CancelScope::Request => {
                let registration = sessions.requests.register(request_id)?;
                Ok((registration.token().clone(), Some(registration)))
            }
            CancelScope::Connection | CancelScope::Uninterruptible => {
                Ok((link.scope.child_token(), None))
            }
        }
    }

    /// Runs one command inside its task and delivers its reply.
    async fn execute(
        command: Command,
        policy: CommandPolicy,
        ctx: CommandCtx,
        exclusive: Arc<Mutex<()>>,
    ) {
        let responder = ctx.responder.clone();
        let abort_on = (policy.cancel_scope == CancelScope::Connection).then(|| ctx.cancel.clone());
        let _exclusive_slot = if policy.exclusive {
            Some(exclusive.lock_owned().await)
        } else {
            None
        };
        let run = Self::answer_panics(command.run(ctx));
        let reply = match abort_on {
            // Abortable commands are dropped mid-flight when their connection ends.
            Some(token) => match token.run_until_cancelled(run).await {
                Some(reply) => reply,
                None => return,
            },
            None => run.await,
        };
        Self::deliver(&responder, reply).await;
    }

    /// Turns a panicking command into an internal-error reply.
    ///
    /// Every request owes exactly one result; a panic would otherwise end the task without
    /// one and leave the server's caller waiting until its deadline. The failure goes on the
    /// control lane, so for a streaming command it may overtake data still queued for the
    /// stream; the server then fails the stream, which is the outcome a panic deserves.
    async fn answer_panics(run: impl Future<Output = Reply>) -> Reply {
        match std::panic::AssertUnwindSafe(run).catch_unwind().await {
            Ok(reply) => reply,
            Err(payload) => {
                let detail = payload
                    .downcast_ref::<&str>()
                    .map(|message| message.to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "non-string panic payload".to_string());
                log_error!(
                    anyhow::Error::msg(detail.clone()),
                    "Agent command panicked: {detail}"
                );
                Reply::failure(CommandError::new(
                    CommandErrorKind::Internal,
                    "Agent command failed unexpectedly",
                ))
            }
        }
    }

    /// Sends the request's one result on the lane its delivery mode requires.
    ///
    /// A streaming result goes on the stream's lane behind its data; when the connection is
    /// gone that lane is closed and the send returns at once, so teardown can always join.
    async fn deliver(responder: &Responder, reply: Reply) {
        match reply {
            Reply::Result(outcome) => {
                let _ = responder.respond(outcome).await;
            }
            Reply::Reexec { outcome, path } => {
                let _ = responder
                    .respond_on(
                        responder.control(),
                        outcome,
                        Some(PostSend::Reexec { path }),
                    )
                    .await;
            }
            Reply::Stream { stream, outcome } => {
                let _ = responder.respond_on(stream.lane(), outcome, None).await;
            }
        }
    }

    /// Reaps finished commands and reports whether another bounded command can start.
    fn command_capacity_available(&mut self) -> bool {
        Self::reap(&mut self.commands);
        Self::reap(&mut self.uploads);
        self.commands.len() < MAX_CONCURRENT_COMMANDS
    }

    /// Collects finished tasks so panics are logged and the sets do not grow.
    fn reap(tasks: &mut JoinSet<()>) {
        while let Some(result) = tasks.try_join_next() {
            if let Err(error) = result {
                log_error!(anyhow::Error::new(error), "Agent command task failed");
            }
        }
    }

    /// Joins every command after the connection scope was cancelled.
    pub(crate) async fn stop(&mut self) {
        for tasks in [&mut self.commands, &mut self.uploads] {
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    log!(
                        Level::Warning,
                        "Agent command task failed while stopping: {error}"
                    );
                }
            }
        }
    }

    /// Reports whether any command task is still owned, for teardown tests.
    #[cfg(test)]
    pub(crate) fn is_idle(&self) -> bool {
        self.commands.is_empty() && self.uploads.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::responder::OutboundFrame;
    use crate::transfers::upload::UploadRoutes;
    use crate::trash::Trash;
    use redoor_protocol::{
        api::{agents::EchoRequest, transfers::CopyExistingMode},
        wire::{
            AgentToServer,
            request::{self, AgentRequest},
        },
    };
    use tokio::sync::mpsc;

    /// Owns a dispatcher with recording control and bulk lanes.
    struct Fixture {
        dispatcher: Dispatcher,
        sessions: Sessions,
        control: ControlSender,
        frames: mpsc::Receiver<OutboundFrame>,
        bulk: ControlSender,
        scope: CancellationToken,
    }

    impl Fixture {
        /// Builds a dispatcher bound to a live scope plus the receiver of its bulk lane.
        async fn new() -> (Self, mpsc::Receiver<OutboundFrame>) {
            let routes = UploadRoutes::default();
            // Never created: these tests do not write partials.
            let services = AgentServices::new(
                Trash::unsupported(),
                redoor_core::partials::PartialStore::new("/nonexistent/redoor-agent".into()),
                None,
            );
            let (control, frames) = mpsc::channel(8);
            let (bulk, payload) = mpsc::channel(8);
            let scope = CancellationToken::new();
            let mut sessions = Sessions::new(routes);
            sessions.rebind(&scope);
            (
                Self {
                    dispatcher: Dispatcher::new(services),
                    sessions,
                    control,
                    frames,
                    bulk,
                    scope,
                },
                payload,
            )
        }

        /// Dispatches one command over the fixture's lanes.
        async fn dispatch(&mut self, request_id: u64, command: Command) {
            let link = DispatchLink {
                control: &self.control,
                bulk: &self.bulk,
                credit: redoor_protocol::wire::stream::STREAM_CREDIT_WINDOW_FRAMES,
                scope: &self.scope,
            };
            self.dispatcher
                .dispatch(
                    RequestId::new(request_id),
                    command,
                    link,
                    &mut self.sessions,
                )
                .await;
        }

        /// Receives the next command response from the recorded control lane.
        async fn next_response(&mut self) -> (CommandOutcome, Option<PostSend>) {
            loop {
                let frame = self.frames.recv().await.expect("control lane open");
                if let Some(AgentToServer::Result { outcome, .. }) = frame.as_message() {
                    return (outcome.clone(), frame.after_send.clone());
                }
            }
        }
    }

    /// A download that cannot finish until cancelled, used to occupy a request id.
    fn blocking_download() -> Command {
        Command::RawDownload(request::RawDownload {
            expected_identity: None,
            path: "/dev/zero".to_string(),
            range_start: None,
            range_end: None,
        })
    }

    /// Verifies the dispatcher, not the command, sends the typed response.
    #[tokio::test]
    async fn control_commands_respond_through_the_dispatcher() {
        let (mut fixture, _payload) = Fixture::new().await;

        fixture
            .dispatch(
                1,
                Command::Echo(request::Echo {
                    request: EchoRequest {
                        message: "hello".to_string(),
                        random_sleep: false,
                    },
                }),
            )
            .await;
        let (outcome, after_send) = fixture.next_response().await;

        // The dispatcher, not the command, sends the echo's typed response.
        assert_eq!(request::Echo::decode(outcome).unwrap().message, "hello");
        // Ordinary results never replace the process.
        assert_eq!(after_send, None);
    }

    /// Verifies restart responses carry their post-send re-exec.
    #[tokio::test]
    async fn restart_response_carries_the_reexec_action() {
        let (mut fixture, _payload) = Fixture::new().await;

        fixture
            .dispatch(2, Command::Restart(request::Restart {}))
            .await;
        let (outcome, after_send) = fixture.next_response().await;

        // Restart answers first so the router sees success before the socket drops.
        assert!(request::Restart::decode(outcome).is_ok());
        // The writer, not a JSON sniffer, performs the re-exec after this frame is written.
        assert_eq!(after_send, Some(PostSend::Reexec { path: None }));
    }

    /// Verifies a cancel racing a download's completion still yields exactly one result, and
    /// that the result follows the stream's frames on the stream's own lane.
    #[tokio::test]
    async fn cancel_racing_completion_yields_exactly_one_result_after_the_data() {
        let (mut fixture, mut payload) = Fixture::new().await;
        let file = redoor_core::test_support::TempDir::create();
        let path = file.path().join("small.txt");
        tokio::fs::write(&path, b"small").await.unwrap();

        fixture
            .dispatch(
                4,
                Command::RawDownload(request::RawDownload {
                    expected_identity: None,
                    path: path.to_string_lossy().to_string(),
                    range_start: None,
                    range_end: None,
                }),
            )
            .await;
        fixture.sessions.cancel_request_with_reason(
            RequestId::new(4),
            redoor_protocol::wire::partials::CancelReason::Canceled,
        );
        fixture.scope.cancel();
        fixture.dispatcher.stop().await;

        let mut frames = Vec::new();
        while let Ok(frame) = payload.try_recv() {
            frames.push(frame);
        }
        let results: Vec<_> = frames
            .iter()
            .enumerate()
            .filter(|(_, frame)| matches!(frame.as_message(), Some(AgentToServer::Result { .. })))
            .collect();
        // Whichever of completion and cancel wins, the request gets exactly one result.
        assert_eq!(results.len(), 1);
        // Nothing of the stream follows its result.
        assert_eq!(results[0].0, frames.len() - 1);
        // The control lane carried no second answer.
        assert!(fixture.frames.try_recv().is_err());
    }

    /// A panicking command still answers its request instead of leaving the server waiting.
    #[tokio::test]
    async fn panicking_command_answers_with_an_internal_error() {
        let reply = Dispatcher::answer_panics(async { panic!("command bug") }).await;
        let Reply::Result(outcome) = reply else {
            panic!("a panic is answered on the control lane");
        };
        // The caller gets a typed internal failure, which REST maps to a 500.
        assert_eq!(
            outcome.failure().map(|error| &error.kind),
            Some(&CommandErrorKind::Internal)
        );
    }

    /// Verifies one request id cannot own two cancellation registrations.
    #[tokio::test]
    async fn duplicate_request_ids_are_rejected() {
        let (mut fixture, payload) = Fixture::new().await;

        fixture.dispatch(5, blocking_download()).await;
        fixture
            .dispatch(
                5,
                Command::LocalCopyFile(request::LocalCopyFile {
                    partial: None,
                    source_path: "/nonexistent".to_string(),
                    dest_path: "/nonexistent-copy".to_string(),
                    on_existing: CopyExistingMode::Error,
                }),
            )
            .await;

        // A second command with a running id is ignored: answering it would give the
        // running request a second result.
        assert!(fixture.frames.try_recv().is_err());
        // Teardown closes the bulk lane, which releases the blocked download.
        drop(payload);
        fixture.scope.cancel();
        fixture.sessions.invalidate();
        fixture.dispatcher.stop().await;
    }

    /// Verifies stalled commands cannot grow the task set without bound.
    #[tokio::test]
    async fn capacity_limit_rejects_excess_commands() {
        let (mut fixture, _payload) = Fixture::new().await;
        for _ in 0..MAX_CONCURRENT_COMMANDS {
            fixture
                .dispatcher
                .commands
                .spawn(std::future::pending::<()>());
        }

        fixture
            .dispatch(6, Command::GetLoggingLevel(request::GetLoggingLevel {}))
            .await;
        let (outcome, _) = fixture.next_response().await;

        // A full set rejects ordinary commands without blocking control handling.
        assert_eq!(
            outcome.failure().map(|error| &error.kind),
            Some(&CommandErrorKind::ServiceUnavailable)
        );
        fixture.dispatcher.commands.abort_all();
    }

    /// Verifies teardown cancels and joins every running command.
    #[tokio::test]
    async fn teardown_cancels_and_joins_running_commands() {
        let (mut fixture, payload) = Fixture::new().await;
        fixture.dispatch(7, blocking_download()).await;
        fixture
            .dispatch(
                8,
                Command::FileSearch(request::FileSearch {
                    path: "/".to_string(),
                    query: "unlikely-redoor-query".to_string(),
                    timeout_seconds: 3600,
                    include_hidden: true,
                    respect_gitignore: false,
                    case_sensitivity: Default::default(),
                    directories_only: false,
                }),
            )
            .await;

        // Teardown closes the bulk lane before joining, as the runtime does.
        drop(payload);
        fixture.scope.cancel();
        fixture.sessions.invalidate();
        fixture.dispatcher.stop().await;

        // No command task may outlive the connection that admitted it.
        assert!(fixture.dispatcher.is_idle());
    }
}
