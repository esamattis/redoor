//! The agent's single event loop: connection lifecycle, frame handling and teardown.

pub(crate) mod cancel;
pub(crate) mod dispatch;
pub(crate) mod links;
pub(crate) mod responder;
pub(crate) mod sessions;

use crate::commands::ctx::AgentServices;
use crate::connection::AgentConnection;
use crate::device_id::DeviceIdSource;
use crate::platform::identity::HostIdentity;
use crate::terminal::TerminalLink;
use crate::transfers::stream::StreamWriter;
use crate::ws::{LaneReceivers, spawn_read_task, spawn_stdin_task, spawn_write_task};
use cancel::RegisterError;
use dispatch::{DispatchLink, Dispatcher};
use futures_util::StreamExt;
use links::{
    BULK_QUEUE_CAPACITY, CONTROL_QUEUE_CAPACITY, ConnectionLanes, ControlLink,
    INTERACTIVE_QUEUE_CAPACITY,
};
use redoor_core::backoff::Backoff;
use redoor_core::{log, log_error};
use redoor_protocol::wire::handshake::RejectReason;
use redoor_protocol::wire::registration::{AgentCapabilities, AgentIdentity};
use redoor_protocol::{
    ids::{AgentId, RequestId, TerminalSessionId},
    wire::{
        AgentToServer, ServerToAgent, command::CommandErrorKind, log::Level,
        request::CommandOutcome, stream::StreamChunk, terminal::TerminalSize,
    },
};
use responder::{OutboundFrame, Responder};
use sessions::Sessions;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

/// Internal events consumed by the single agent runtime actor.
pub(crate) enum AgentMsg {
    Connect,
    /// One text frame read from the connection of `connection_generation`.
    WebSocketMessage {
        connection_generation: u64,
        text: String,
    },
    /// Delays desktop UI work and carries the connection generation so stale timers are
    /// harmless.
    StartupNotificationDue {
        connection_generation: u64,
    },
    /// Operator text from stdin forwarded verbatim for manual protocol debugging.
    SendRawText {
        text: String,
    },
    /// Stops the runtime cleanly when its owning transport has ended.
    Shutdown,
    ExitWithError,
}

/// Lifecycle events bypass ordinary message backpressure so transport recovery cannot be starved.
pub(crate) enum AgentLifecycleMsg {
    /// Discards a failed control transport only while its generation remains authoritative.
    ConnectionLost {
        connection_generation: u64,
        reason: String,
    },
}

/// Runtime handle used to send control events into the agent task.
#[derive(Clone)]
pub(crate) struct AgentHandle {
    sender: mpsc::Sender<AgentMsg>,
    lifecycle_sender: mpsc::UnboundedSender<AgentLifecycleMsg>,
}

impl AgentHandle {
    /// Creates the handle and the receivers the runtime loop consumes.
    pub(crate) fn channel(
        capacity: usize,
    ) -> (
        Self,
        mpsc::Receiver<AgentMsg>,
        mpsc::UnboundedReceiver<AgentLifecycleMsg>,
    ) {
        let (sender, receiver) = mpsc::channel(capacity);
        let (lifecycle_sender, lifecycle_receiver) = mpsc::unbounded_channel();
        (
            Self {
                sender,
                lifecycle_sender,
            },
            receiver,
            lifecycle_receiver,
        )
    }

    /// Awaits mailbox capacity so external producers backpressure instead of dropping frames.
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

    /// Reports transport lifecycle without competing with bounded application traffic.
    pub(crate) fn report_connection_lost(&self, connection_generation: u64, reason: String) {
        let _ = self
            .lifecycle_sender
            .send(AgentLifecycleMsg::ConnectionLost {
                connection_generation,
                reason,
            });
    }
}

/// Startup identity that stays stable across reconnects.
pub(crate) struct AgentProfile {
    pub(crate) agent_id: AgentId,
    /// Where the id came from; decides whether losing the id to another connection ends
    /// the process (supervised agents) or is retried (standalone agents).
    pub(crate) id_source: DeviceIdSource,
    pub(crate) agent_name: String,
    /// Immutable absolute directory used when the UI opens this agent.
    pub(crate) default_directory: String,
    /// Shared secret presented during the websocket upgrade so the server can reject impostors.
    pub(crate) token: String,
    /// Keepalive and stale-detection timings chosen at process start.
    pub(crate) ws_timeouts: redoor_core::websocket::WebSocketTimeouts,
}

/// One-shot desktop notification shown after the first fully connected session.
struct StartupNotification {
    /// Desktop detected at process startup, if this agent can plausibly reach a GUI session.
    desktop_environment: Option<redoor_core::desktop::DesktopEnvironment>,
    /// User-selected wait after a successful connection, or `None` when disabled.
    delay: Option<tokio::time::Duration>,
    /// Identifies the connection whose delayed notification is currently authoritative.
    generation: Option<u64>,
    /// Prevents reconnects from repeating the process-start notification.
    sent: bool,
}

/// Why the agent event loop ended, so the binary can choose the process exit status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentExit {
    /// Requested shutdown (stdin EOF of an SSH-launched agent, closed mailboxes).
    Shutdown,
    /// A supervised agent was refused, replaced or could not reach the server for a while;
    /// the failure status lets its watchdog or relay notice and start a fresh one.
    Failure,
}

/// Long-lived agent runtime that owns connection lifecycle and running work.
pub(crate) struct AgentRuntime {
    profile: AgentProfile,
    /// Shared connection policy so every agent websocket uses the same tunnel and TLS identity.
    connection: AgentConnection,
    control: ControlLink,
    sessions: Sessions,
    dispatcher: Dispatcher,
    notification: StartupNotification,
    /// Retry schedule shared with the watchdog and relays, so no reconnect waits over 30s.
    backoff: Backoff,
    /// When the current connection was established; decides whether its loss restarts the
    /// fast retries or keeps backing off from a server that keeps dropping the agent.
    connected_at: Option<Instant>,
    /// Since when the agent has had no connection. A supervised agent gives up after its
    /// window so its owner rebuilds the tunnel, which the agent cannot repair from inside.
    disconnected_since: Instant,
}

impl AgentRuntime {
    /// Creates the runtime before any websocket connection exists.
    pub(crate) fn new(
        profile: AgentProfile,
        connection: AgentConnection,
        services: AgentServices,
        startup_notification_delay: Option<tokio::time::Duration>,
    ) -> Self {
        Self {
            profile,
            connection,
            control: ControlLink::new(),
            sessions: Sessions::new(services.upload_routes.clone()),
            dispatcher: Dispatcher::new(services),
            notification: StartupNotification {
                desktop_environment: redoor_core::desktop::detect_desktop_environment(),
                delay: startup_notification_delay,
                generation: None,
                sent: false,
            },
            backoff: Backoff::default(),
            connected_at: None,
            disconnected_since: Instant::now(),
        }
    }

    /// Runs the agent event loop until shutdown or fatal error.
    pub(crate) async fn run(
        mut self,
        mut receiver: mpsc::Receiver<AgentMsg>,
        mut lifecycle_receiver: mpsc::UnboundedReceiver<AgentLifecycleMsg>,
        handle: AgentHandle,
        exit_on_stdin_eof: bool,
    ) -> AgentExit {
        spawn_stdin_task(handle.clone(), exit_on_stdin_eof).await;
        let _ = handle.try_send(AgentMsg::Connect);

        log!(
            Level::Info,
            "Agent task started: agent_id={}, agent_name={}",
            self.profile.agent_id,
            self.profile.agent_name
        );

        let exit = loop {
            tokio::select! {
                biased;
                lifecycle = lifecycle_receiver.recv() => match lifecycle {
                    Some(message) => self.handle_lifecycle_message(handle.clone(), message).await,
                    None => break AgentExit::Shutdown,
                },
                message = receiver.recv() => match message {
                    Some(message) => {
                        if let Some(exit) = self.handle_message(handle.clone(), message).await {
                            break exit;
                        }
                    }
                    None => break AgentExit::Shutdown,
                },
            }
        };

        self.invalidate_connection().await;
        log!(
            Level::Info,
            "Agent stopped: agent_id={}",
            self.profile.agent_id
        );
        exit
    }

    /// Stops the socket, cancels all connection-owned work and joins command tasks.
    async fn invalidate_connection(&mut self) {
        self.control.invalidate();
        self.sessions.invalidate();
        self.dispatcher.stop().await;
        // Results of the old connection can never be delivered; a reconnect starts clean.
        self.dispatcher.services().results.clear();
    }

    /// Handles one agent control message and returns how the event loop ends, if it should.
    async fn handle_message(
        &mut self,
        handle: AgentHandle,
        message: AgentMsg,
    ) -> Option<AgentExit> {
        match message {
            AgentMsg::Connect => {
                if self.control.sender().is_none() {
                    return self.connect(handle).await;
                }
            }
            AgentMsg::WebSocketMessage {
                connection_generation,
                text,
            } => {
                if self.control.is_current(connection_generation) {
                    if self.control.sender().is_some() {
                        self.handle_server_text(handle, text).await;
                    } else {
                        self.handle_text_after_loss(handle, &text).await;
                    }
                }
            }
            AgentMsg::StartupNotificationDue {
                connection_generation,
            } => {
                self.show_startup_notification_if_current(connection_generation);
            }
            AgentMsg::SendRawText { text } => {
                if let Some(control) = self.control.sender()
                    && control.send(OutboundFrame::raw_text(text)).await.is_err()
                {
                    let error = anyhow::anyhow!("agent websocket channel is closed");
                    log_error!(error, "Failed to send message; connection may be lost");
                }
            }
            AgentMsg::Shutdown => return Some(AgentExit::Shutdown),
            AgentMsg::ExitWithError => {
                let error = anyhow::anyhow!("agent received fatal exit signal");
                log_error!(error, "Exiting agent due to error");
                return Some(AgentExit::Failure);
            }
        }
        None
    }

    /// Applies transport lifecycle ahead of bounded application traffic.
    async fn handle_lifecycle_message(&mut self, handle: AgentHandle, message: AgentLifecycleMsg) {
        match message {
            AgentLifecycleMsg::ConnectionLost {
                connection_generation,
                reason,
            } => {
                if !self.control.is_current(connection_generation) {
                    log!(
                        Level::Debug,
                        "Ignoring stale connection loss from generation {}: {}",
                        connection_generation,
                        reason
                    );
                    return;
                }
                if self.control.sender().is_none() {
                    log!(
                        Level::Debug,
                        "Ignoring duplicate connection loss: {}",
                        reason
                    );
                    return;
                }
                self.drop_connection().await;
                self.schedule_reconnect(handle, &format!("Connection lost: {reason}"));
            }
        }
    }

    /// Tears the current connection down and starts the disconnected clock.
    ///
    /// A connection that stayed up for a while restarts the fast retries; one the server
    /// dropped right away keeps backing off, so a flapping server is not hammered.
    async fn drop_connection(&mut self) {
        self.invalidate_connection().await;
        if let Some(connected_at) = self.connected_at.take() {
            self.backoff.reset_if_stable(connected_at.elapsed());
        }
        self.disconnected_since = Instant::now();
    }

    /// Whether the process was started by a watchdog or relay (`--agent-id`).
    ///
    /// Such an agent leaves recovery to its owner: it exits instead of retrying refusals,
    /// and gives up reconnecting after its window so the owner can rebuild the SSH tunnel.
    fn is_supervised(&self) -> bool {
        matches!(self.profile.id_source, DeviceIdSource::Assigned)
    }

    /// Handles a frame of the current connection that was read before its loss was
    /// processed.
    ///
    /// The server closes the socket right after `rejected` or `evicted`, and the loss travels
    /// on the lifecycle lane that the event loop prefers, so it can overtake the frame that
    /// explains it. Those two frames still decide whether the agent exits and carry the
    /// instructions for the operator, so they are not dropped; everything else belongs to
    /// work the loss already canceled.
    async fn handle_text_after_loss(&mut self, handle: AgentHandle, text: &str) {
        if let Ok(frame @ (ServerToAgent::Rejected { .. } | ServerToAgent::Evicted { .. })) =
            serde_json::from_str::<ServerToAgent>(text)
        {
            self.handle_server_frame(handle, frame).await;
        }
    }

    /// Parses one server frame; unparsable commands are answered so callers do not hang.
    async fn handle_server_text(&mut self, handle: AgentHandle, text: String) {
        match serde_json::from_str::<ServerToAgent>(&text) {
            Ok(frame) => self.handle_server_frame(handle, frame).await,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Ignoring unparsable server frame: error={}",
                    error
                );
                let (Some(request_id), Some(control)) = (
                    ServerToAgent::unparsed_command_request_id(&text),
                    self.control.sender(),
                ) else {
                    return;
                };
                let results = self.dispatcher.services().results.clone();
                if !results.open(request_id) {
                    return;
                }
                let _ = Responder::new(control.clone(), results, request_id)
                    .respond(CommandOutcome::error(
                        CommandErrorKind::InvalidInput,
                        format!("Agent could not parse command: {error}"),
                    ))
                    .await;
            }
        }
    }

    /// Queues the fatal exit without ever losing it: a dropped exit would make a rejected or
    /// evicted agent reconnect, and waiting here would deadlock on the runtime's own mailbox,
    /// so a task waits for capacity instead.
    fn request_exit(handle: AgentHandle) {
        tokio::spawn(async move {
            let _ = handle.send(AgentMsg::ExitWithError).await;
        });
    }

    /// Handles one typed server frame; the match is exhaustive so new frames cannot be dropped.
    async fn handle_server_frame(&mut self, handle: AgentHandle, frame: ServerToAgent) {
        match frame {
            ServerToAgent::Welcome { connection_id } => {
                log!(
                    Level::Info,
                    "Server accepted the agent: agent_id={}, connection_id={}",
                    self.profile.agent_id,
                    connection_id
                );
                self.schedule_startup_notification(handle);
            }
            ServerToAgent::Rejected {
                reason: RejectReason::DuplicateId,
                message,
            } => self.retry_after_duplicate_id(handle, &message).await,
            ServerToAgent::Rejected { reason, message } => {
                self.handle_rejection(handle, reason, message).await
            }
            ServerToAgent::Evicted { message } => self.handle_eviction(handle, message).await,
            ServerToAgent::Credit { stream, frames } => self
                .dispatcher
                .services()
                .output_credits
                .grant(stream, frames),
            ServerToAgent::Command {
                id,
                credit,
                command,
            } => {
                let Some(lanes) = self.control.lanes() else {
                    return;
                };
                let link = DispatchLink {
                    control: &lanes.control,
                    bulk: &lanes.bulk,
                    credit,
                    scope: self.control.scope(),
                };
                self.dispatcher
                    .dispatch(id, command, link, &mut self.sessions)
                    .await;
            }
            ServerToAgent::PublishDecision { id, allowed } => self
                .dispatcher
                .services()
                .upload_routes
                .resolve_publication(id, allowed),
            ServerToAgent::Cancel { id, reason } => {
                self.sessions.cancel_request_with_reason(id, reason);
            }
            ServerToAgent::TerminalAttach {
                stream,
                session,
                size,
            } => self.attach_terminal(stream, session, size),
            ServerToAgent::TerminalResize { stream, size } => self
                .dispatcher
                .services()
                .terminal_inputs
                .resize(stream, size),
            ServerToAgent::LogStreamOpen { stream } => self.start_log_stream(stream),
        }
    }

    /// Explains a `duplicate_id` refusal and keeps retrying.
    ///
    /// Another machine holds this id with a healthy connection. Retrying with the normal
    /// backoff lets this agent take over once that machine is gone or has been given its own
    /// id, without the operator having to restart anything here.
    async fn retry_after_duplicate_id(&mut self, handle: AgentHandle, message: &str) {
        let fix = match &self.profile.id_source {
            DeviceIdSource::File(path) => format!(
                "delete '{}' on one of the machines and restart that agent so it gets its own device id",
                path.display()
            ),
            DeviceIdSource::Assigned => {
                "make sure no two [[agents]] or [[relays]] entries share an id in the server config"
                    .to_string()
            }
        };
        log_error!(
            anyhow::anyhow!("{message} (duplicate_id)"),
            "Another machine is connected with this agent's device id {}. To fix it, {}. Retrying in the background",
            self.profile.agent_id,
            fix
        );
        self.reconnect_after_refusal(handle, "Server refused the duplicate device id")
            .await;
    }

    /// Reacts to the server ending this agent's accepted connection.
    ///
    /// A supervised agent (`--agent-id`) exits: the server or relay that started it has
    /// either stopped it or replaced it with a newer process, and a lingering copy would be a
    /// zombie holding an SSH tunnel open. A standalone agent holds the single-instance lock
    /// of its data directory, so a replacement comes from another machine with a copy of its
    /// id file. Exiting there would hide the conflict for good, since the server only notices
    /// clones that keep replacing each other; reconnecting lets it detect the loop, refuse
    /// the newcomers with `duplicate_id` and warn the operator.
    async fn handle_eviction(&mut self, handle: AgentHandle, message: String) {
        match &self.profile.id_source {
            DeviceIdSource::Assigned => {
                log_error!(
                    anyhow::Error::msg(message),
                    "Server ended this agent's connection"
                );
                Self::request_exit(handle);
            }
            DeviceIdSource::File(path) => {
                log!(
                    Level::Warning,
                    "Server ended this agent's connection: {}. Another machine is probably using a copy of '{}'.",
                    message,
                    path.display()
                );
                self.reconnect_after_refusal(handle, "Connection replaced by the server")
                    .await;
            }
        }
    }

    /// Reacts to a refused `hello` other than `duplicate_id`.
    ///
    /// A supervised agent exits: `stopped` means its owner was told to stop it, and for the
    /// other reasons the owner restarts it with its own backoff and shows the problem. A
    /// standalone agent has nobody to restart it, so it keeps retrying at the slowest pace
    /// and connects as soon as an operator fixes the name or the server.
    async fn handle_rejection(
        &mut self,
        handle: AgentHandle,
        reason: RejectReason,
        message: String,
    ) {
        if self.is_supervised() {
            log_error!(
                anyhow::anyhow!("{message} ({reason:?})"),
                "Server rejected the agent"
            );
            Self::request_exit(handle);
            return;
        }
        log_error!(
            anyhow::anyhow!("{message} ({reason:?})"),
            "Server rejected the agent. Retrying in the background until it is accepted"
        );
        self.backoff.saturate();
        self.reconnect_after_refusal(handle, "Server rejected the agent")
            .await;
    }

    /// Drops a connection the server refused or ended and retries with the normal backoff.
    ///
    /// When the socket's loss was already processed, that handler scheduled the retry, so
    /// scheduling another one here would make the agent connect twice.
    async fn reconnect_after_refusal(&mut self, handle: AgentHandle, reason: &str) {
        if self.control.sender().is_none() {
            return;
        }
        self.drop_connection().await;
        self.schedule_reconnect(handle, reason);
    }

    /// Attaches terminal session `session` to stream `stream`; the registration lives as long
    /// as the attachment, the shell as long as its session.
    fn attach_terminal(
        &mut self,
        stream: RequestId,
        session: TerminalSessionId,
        size: TerminalSize,
    ) {
        let Some(lanes) = self.control.lanes().cloned() else {
            return;
        };
        let registration = match self.sessions.terminals.register(stream) {
            Ok(registration) => registration,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Rejected terminal ({}): stream={}",
                    error.reason(),
                    stream
                );
                if error == RegisterError::Full {
                    // The browser would otherwise wait for a ready event that never comes.
                    tokio::spawn(crate::terminal::refuse(
                        lanes.interactive,
                        stream,
                        "Too many terminals are attached on this agent",
                    ));
                }
                return;
            }
        };
        let services = self.dispatcher.services();
        let Some(session) = services.terminal_sessions.get(session) else {
            // The agent restarted since the server last heard of the session.
            tokio::spawn(crate::terminal::refuse(
                lanes.interactive,
                stream,
                "Terminal session no longer exists",
            ));
            return;
        };
        // The input route exists before the attachment can send `ready`, which is what lets
        // the server start sending keystrokes.
        let link = TerminalLink {
            stream,
            interactive: lanes.interactive,
            control: lanes.control,
            credits: services.output_credits.clone(),
            input: services.terminal_inputs.open(stream),
        };
        tokio::spawn(async move {
            let cancel = registration.token().clone();
            crate::terminal::attach(link, session, size, cancel).await;
            drop(registration);
        });
    }

    /// Starts one log stream on stream `stream`; its registration lives as long as its task.
    fn start_log_stream(&mut self, stream: RequestId) {
        let Some(lanes) = self.control.lanes() else {
            return;
        };
        let registration = match self.sessions.log_streams.register(stream) {
            Ok(registration) => registration,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Rejected log stream ({}): stream={}",
                    error.reason(),
                    stream
                );
                if error == RegisterError::Full {
                    // FIN closes the server's viewer instead of leaving it waiting forever.
                    let bulk = lanes.bulk.clone();
                    tokio::spawn(async move {
                        let _ = bulk
                            .send(OutboundFrame::stream(StreamChunk::data(
                                stream,
                                Vec::new(),
                                true,
                            )))
                            .await;
                    });
                }
                return;
            }
        };
        let writer = StreamWriter::new(
            lanes.bulk.clone(),
            stream,
            self.dispatcher.services().output_credits.register(stream),
        );
        tokio::spawn(async move {
            let cancel = registration.token().clone();
            if let Err(error) = crate::logs::run(stream, writer, cancel).await {
                log!(
                    Level::Warning,
                    "Log stream ended with an error: stream={}, error={}",
                    stream,
                    error
                );
            }
            drop(registration);
        });
    }

    /// Schedules the next connection attempt on the shared backoff schedule.
    ///
    /// A supervised agent that has been without a connection for its window exits instead:
    /// its tunnel may be dead in a way only a new SSH session fixes, and its watchdog or
    /// relay notices the exit at once and builds that session with the same schedule. It
    /// also exits when the next wait would end past the window, rather than sleeping over it.
    fn schedule_reconnect(&mut self, handle: AgentHandle, reason: &str) {
        let delay = self
            .profile
            .ws_timeouts
            .reconnect_delay
            .unwrap_or_else(|| self.backoff.next_delay());
        let window = self.profile.ws_timeouts.stale_timeout;
        let disconnected_for = self.disconnected_since.elapsed();
        if self.is_supervised() && disconnected_for + delay >= window {
            log_error!(
                anyhow::anyhow!("{reason}"),
                "No server connection for {:?}; exiting so the supervisor can start a fresh agent",
                disconnected_for
            );
            Self::request_exit(handle);
            return;
        }
        log!(Level::Warning, "{}, reconnecting in {:?}", reason, delay);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            // Awaits bounded mailbox capacity so a due reconnect cannot be silently discarded.
            let _ = handle.send(AgentMsg::Connect).await;
        });
    }

    /// Starts a replaceable timer once the server accepted the agent.
    fn schedule_startup_notification(&mut self, handle: AgentHandle) {
        if self.notification.desktop_environment.is_none() || self.notification.sent {
            return;
        }
        let Some(delay) = self.notification.delay else {
            return;
        };
        let connection_generation = self.control.generation();
        self.notification.generation = Some(connection_generation);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = handle
                .send(AgentMsg::StartupNotificationDue {
                    connection_generation,
                })
                .await;
        });
    }

    /// Shows the delayed notification only when its connection is still current.
    fn show_startup_notification_if_current(&mut self, connection_generation: u64) {
        let is_current = self.notification.generation == Some(connection_generation)
            && self.control.is_current(connection_generation)
            && self.control.sender().is_some();
        if !is_current {
            return;
        }

        self.notification.generation = None;
        self.notification.sent = true;
        let Some(desktop_environment) = self.notification.desktop_environment else {
            return;
        };
        let agent_name = self.profile.agent_name.clone();
        tokio::spawn(async move {
            if crate::notification::show_agent_started(desktop_environment, &agent_name).await {
                log!(Level::Debug, "Displayed agent startup desktop notification");
            } else {
                log!(
                    Level::Debug,
                    "No working desktop notification tool was found"
                );
            }
        });
    }

    /// Opens a websocket connection and wires the connection tasks into the runtime channels.
    ///
    /// A refusal that only an operator can fix (wrong token, a server that cannot prove the
    /// token, incompatible protocol) ends a
    /// supervised agent, whose owner shows the error and keeps restarting it. A standalone
    /// agent logs the error and keeps retrying at the slowest pace instead, so it connects
    /// once the token or the server is fixed without anyone restarting it.
    async fn connect(&mut self, handle: AgentHandle) -> Option<AgentExit> {
        log!(
            Level::Info,
            "Attempting to connect to {} as agent '{}'",
            self.connection.server_url(),
            self.profile.agent_name
        );

        let stale_timeout = self.profile.ws_timeouts.stale_timeout;
        let connection_result = tokio::time::timeout(
            stale_timeout,
            self.connection
                .connect_authenticated(self.connection.server_url(), &self.profile.token),
        )
        .await;
        let connected = match connection_result {
            Ok(Ok(connected)) => connected,
            // The reason is in the message too: line logs omit error details, and an operator
            // must see whether the token is wrong or the server is not the agent's own.
            Ok(Err(error)) if error.needs_operator() && self.is_supervised() => {
                log_error!(
                    anyhow::Error::new(error),
                    "Server refused the agent connection: {error}; leaving the retry to the supervisor"
                );
                return Some(AgentExit::Failure);
            }
            Ok(Err(error)) if error.needs_operator() => {
                log_error!(
                    anyhow::Error::new(error),
                    "Server refused the agent connection: {error}. Retrying in the background until it is fixed"
                );
                self.backoff.saturate();
                self.schedule_reconnect(handle, "Server refused the agent connection");
                return None;
            }
            Ok(Err(error)) => {
                self.schedule_reconnect(handle, &format!("Connection failed: {error:#}"));
                return None;
            }
            Err(_) => {
                self.schedule_reconnect(
                    handle,
                    &format!(
                        "Connection failed: WebSocket connection attempt timed out after {stale_timeout:?}"
                    ),
                );
                return None;
            }
        };
        self.connected_at = Some(Instant::now());
        log!(Level::Info, "Connected to {}", self.connection.server_url());
        log!(
            Level::Info,
            "Agent connected: agent_id={}, agent_name={}, server={}",
            self.profile.agent_id,
            self.profile.agent_name,
            self.connection.server_url()
        );

        let (write, read) = connected.socket.split();
        let (control_tx, control_rx) = mpsc::channel::<OutboundFrame>(CONTROL_QUEUE_CAPACITY);
        let (interactive_tx, interactive_rx) = mpsc::channel(INTERACTIVE_QUEUE_CAPACITY);
        let (bulk_tx, bulk_rx) = mpsc::channel(BULK_QUEUE_CAPACITY);
        let (control_shutdown, control_shutdown_rx) = watch::channel(false);
        let connection_generation = self.control.attach(
            ConnectionLanes {
                control: control_tx.clone(),
                interactive: interactive_tx,
                bulk: bulk_tx,
            },
            control_shutdown.clone(),
        );
        self.sessions.rebind(self.control.scope());

        if let Err(error) = redoor_core::systemd_notify::ready().await {
            log!(
                Level::Warning,
                "Failed to notify systemd readiness: {error}"
            );
        }

        spawn_read_task(
            read,
            handle.clone(),
            connection_generation,
            control_tx.clone(),
            self.dispatcher.services().clone(),
            control_shutdown.clone(),
            control_shutdown_rx.clone(),
            self.profile.ws_timeouts,
        )
        .await;
        spawn_write_task(
            write,
            LaneReceivers {
                control: control_rx,
                interactive: interactive_rx,
                bulk: bulk_rx,
            },
            control_shutdown,
            control_shutdown_rx,
            handle.clone(),
            connection_generation,
        );

        let host = HostIdentity::current();
        let trash = &self.dispatcher.services().trash;
        let hello = AgentToServer::Hello {
            agent_id: self.profile.agent_id.clone(),
            agent_name: self.profile.agent_name.clone(),
            token_proof: connected.hello_proof.as_str().to_string(),
            identity: Box::new(AgentIdentity {
                os: host.os,
                arch: host.arch,
                hostname: host.hostname,
                username: host.username,
                default_directory: self.profile.default_directory.clone(),
                // Lets the server compare agent builds against itself without a round-trip command.
                binary: redoor_core::identity::current_binary_identity(),
                uid: host.uid,
                is_root: host.is_root,
            }),
            capabilities: AgentCapabilities {
                // Reuse startup GUI detection so headless agents never advertise the action.
                supports_native_open: self.notification.desktop_environment.is_some(),
                // Only platforms with a Redoor trash inventory implement listing and restore.
                supports_trash: trash.supports_inventory,
                // macOS supports the native move without Redoor inventory or restore support.
                supports_move_to_trash: trash.supports_move,
                // Vault writes depend on the publication check in `RawFileSink`.
                supports_upload_preconditions: true,
            },
        };
        log!(
            Level::Info,
            "Sending hello: agent_id={}, agent_name={}",
            self.profile.agent_id,
            self.profile.agent_name
        );
        if let Err(error) = control_tx.send(OutboundFrame::message(hello)).await {
            log_error!(
                anyhow::anyhow!("control lane closed: {error}"),
                "Failed to send hello"
            );
        }
        // Queued after the hello, so the server reads the list from a registered agent.
        tokio::spawn(report_terminal_sessions(
            control_tx,
            self.dispatcher.services().terminal_sessions.clone(),
            self.control.scope().clone(),
        ));
        None
    }
}

/// Sends the process's terminal sessions to the server now and after every change, until
/// the connection ends. Sessions outlive connections, so this is how a restarted server
/// learns which shells still run.
async fn report_terminal_sessions(
    control: responder::ControlSender,
    sessions: crate::terminal::registry::TerminalSessions,
    connection: tokio_util::sync::CancellationToken,
) {
    let mut changed = sessions.subscribe();
    loop {
        changed.mark_unchanged();
        let report = AgentToServer::TerminalSessions {
            sessions: sessions.records(),
        };
        if control.send(OutboundFrame::message(report)).await.is_err() {
            return;
        }
        tokio::select! {
            () = connection.cancelled() => return,
            changed = changed.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trash::Trash;
    use redoor_protocol::wire::request;
    use redoor_protocol::wire::request::CommandError;

    /// Builds a supervised runtime without network side effects for state-transition tests.
    fn runtime() -> AgentRuntime {
        runtime_with_source(DeviceIdSource::Assigned)
    }

    /// Builds a runtime whose id came from `id_source`, which decides how it reacts to
    /// id conflicts.
    fn runtime_with_source(id_source: DeviceIdSource) -> AgentRuntime {
        AgentRuntime::new(
            AgentProfile {
                agent_id: AgentId::generate(),
                id_source,
                agent_name: "agent".to_string(),
                default_directory: "/tmp".to_string(),
                token: "test-token".to_string(),
                ws_timeouts: redoor_core::websocket::WebSocketTimeouts::production(),
            },
            AgentConnection::new("ws://localhost".to_string(), None, false).unwrap(),
            AgentServices::new(
                Trash::unsupported(),
                // Never created: these tests do not write partials.
                redoor_core::partials::PartialStore::new("/nonexistent/redoor-agent".into()),
                None,
            ),
            None,
        )
    }

    /// Attaches fake lanes as if the connection were open; returns the control and bulk
    /// receivers.
    fn attach_links(
        runtime: &mut AgentRuntime,
    ) -> (mpsc::Receiver<OutboundFrame>, mpsc::Receiver<OutboundFrame>) {
        let (control_tx, control_rx) = mpsc::channel(8);
        let (interactive, _) = mpsc::channel(1);
        let (bulk, bulk_rx) = mpsc::channel(1);
        let (shutdown, _) = watch::channel(false);
        runtime.control.attach(
            ConnectionLanes {
                control: control_tx,
                interactive,
                bulk,
            },
            shutdown,
        );
        runtime.sessions.rebind(runtime.control.scope());
        (control_rx, bulk_rx)
    }

    /// Verifies a delayed writer failure cannot clear a newer live connection.
    #[tokio::test]
    async fn stale_connection_loss_does_not_clear_replacement_connection() {
        let mut runtime = runtime();
        let (_control_rx, _bulk_rx) = attach_links(&mut runtime);
        let stale_generation = runtime.control.generation();
        let (_control_rx, _bulk_rx) = attach_links(&mut runtime);
        let current_generation = runtime.control.generation();
        let (handle, _receiver, _lifecycle_receiver) = AgentHandle::channel(1);

        runtime
            .handle_lifecycle_message(
                handle,
                AgentLifecycleMsg::ConnectionLost {
                    connection_generation: stale_generation,
                    reason: "old writer failed".to_string(),
                },
            )
            .await;

        // A delayed lifecycle event must leave the replacement generation authoritative.
        assert_eq!(runtime.control.generation(), current_generation);
        // The current control sender must survive a delayed loss from the old generation.
        assert!(runtime.control.sender().is_some());
    }

    /// Verifies a reconnect timer waits for bounded capacity instead of dropping the only retry.
    #[tokio::test]
    async fn reconnect_survives_saturated_actor_mailbox() {
        let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(1);
        handle
            .try_send(AgentMsg::ExitWithError)
            .expect("mailbox saturation setup should fill its only slot");
        let reconnect = handle.send(AgentMsg::Connect);
        tokio::pin!(reconnect);

        // Pending while full proves a due reconnect waits instead of using a lossy try-send.
        assert!(futures_util::poll!(&mut reconnect).is_pending());

        // The existing item must remain first because reconnect scheduling may not evict traffic.
        assert!(matches!(
            receiver.recv().await,
            Some(AgentMsg::ExitWithError)
        ));
        reconnect.await.expect("mailbox stays open");
        // Freeing capacity must release the awaited timer send and preserve the reconnect attempt.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Connect)));
    }

    /// Verifies awaited sends stay pending while the bounded mailbox is full so websocket
    /// ingress can propagate upload backpressure instead of dropping frames.
    #[tokio::test]
    async fn send_waits_for_channel_capacity() {
        let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(1);
        handle
            .try_send(AgentMsg::Connect)
            .expect("initial enqueue should succeed");

        let pending_send = handle.send(AgentMsg::ExitWithError);
        tokio::pin!(pending_send);

        // A pending send here proves the bounded mailbox is applying backpressure.
        assert!(futures_util::poll!(&mut pending_send).is_pending());
        // Draining one slot lets the send complete.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Connect)));
        assert!(pending_send.await.is_ok());
        // The queued message survived backpressure.
        assert!(matches!(
            receiver.recv().await,
            Some(AgentMsg::ExitWithError)
        ));
    }

    /// Verifies non-blocking self-sends fail fast when the mailbox is full.
    #[tokio::test]
    async fn try_send_fails_fast_when_channel_is_full() {
        let (handle, _receiver, _lifecycle_receiver) = AgentHandle::channel(1);
        handle
            .try_send(AgentMsg::Connect)
            .expect("initial enqueue should succeed");

        let result = handle.try_send(AgentMsg::ExitWithError);

        // A full error protects in-actor self-sends from deadlocking on the bounded mailbox.
        assert!(matches!(
            result,
            Err(mpsc::error::TrySendError::Full(AgentMsg::ExitWithError))
        ));
    }

    /// Verifies an unknown command variant is answered instead of silently dropped.
    #[tokio::test]
    async fn unparsable_command_frames_are_answered() {
        let mut runtime = runtime();
        let (mut control_rx, _bulk_rx) = attach_links(&mut runtime);
        let (handle, _receiver, _lifecycle_receiver) = AgentHandle::channel(1);

        runtime
            .handle_server_text(
                handle,
                r#"{"type":"command","id":11,"command":{"type":"FromTheFuture"}}"#.to_string(),
            )
            .await;

        let frame = control_rx.recv().await.unwrap();
        // The waiting REST caller receives a typed invalid-input error for its request id.
        assert!(matches!(
            frame.as_message(),
            Some(AgentToServer::Result {
                id,
                outcome: CommandOutcome::Error(CommandError {
                    kind: CommandErrorKind::InvalidInput,
                    ..
                }),
            }) if id.0 == 11
        ));
    }

    /// Verifies control loss cancels and joins command workers before reconnecting.
    #[tokio::test]
    async fn connection_loss_cancels_and_joins_commands() {
        let mut runtime = runtime();
        let (_control_rx, bulk_rx) = attach_links(&mut runtime);
        let (handle, _receiver, _lifecycle_receiver) = AgentHandle::channel(1);
        runtime
            .handle_server_frame(
                handle.clone(),
                ServerToAgent::Command {
                    id: redoor_protocol::ids::RequestId::new(1),
                    credit: 4,
                    command: redoor_protocol::wire::command::Command::RawDownload(
                        request::RawDownload {
                            expected_identity: None,
                            path: "/dev/zero".to_string(),
                            range_start: None,
                            range_end: None,
                        },
                    ),
                },
            )
            .await;
        // The writer task exits with its socket, closing the bulk lane.
        drop(bulk_rx);

        runtime
            .handle_lifecycle_message(
                handle,
                AgentLifecycleMsg::ConnectionLost {
                    connection_generation: runtime.control.generation(),
                    reason: "test".to_string(),
                },
            )
            .await;

        // No worker may outlive the connection whose resources it used.
        assert!(runtime.dispatcher.is_idle());
        // The control link is detached so a reconnect attaches a fresh generation.
        assert!(runtime.control.sender().is_none());
    }

    /// A standalone agent's id file, as the runtime would report it to the operator.
    fn standalone() -> DeviceIdSource {
        DeviceIdSource::File("/home/user/.local/share/redoor/agent-id".into())
    }

    /// A `duplicate_id` refusal must not stop the agent: it retries with backoff so it gets
    /// through once the machine holding the id is gone or fixed.
    #[tokio::test(start_paused = true)]
    async fn duplicate_id_rejection_retries_instead_of_exiting() {
        let mut runtime = runtime_with_source(standalone());
        let (_control_rx, _bulk_rx) = attach_links(&mut runtime);
        let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(4);

        runtime
            .handle_server_frame(
                handle,
                ServerToAgent::Rejected {
                    reason: RejectReason::DuplicateId,
                    message: "taken".to_string(),
                },
            )
            .await;

        // The refused connection is dropped so the retry attaches a fresh one.
        assert!(runtime.control.sender().is_none());
        // The next event is the scheduled reconnect, not an exit.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Connect)));
    }

    /// Other refusals end a supervised agent, whose owner restarts it and shows the error,
    /// but never a standalone one, which has nobody to restart it.
    #[tokio::test(start_paused = true)]
    async fn invalid_identity_rejection_exits_only_supervised_agents() {
        for (id_source, exits) in [(standalone(), false), (DeviceIdSource::Assigned, true)] {
            let mut runtime = runtime_with_source(id_source);
            let (_control_rx, _bulk_rx) = attach_links(&mut runtime);
            let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(4);

            runtime
                .handle_server_frame(
                    handle,
                    ServerToAgent::Rejected {
                        reason: RejectReason::InvalidIdentity,
                        message: "bad id".to_string(),
                    },
                )
                .await;

            let next = receiver.recv().await;
            if exits {
                // The supervisor sees a failure status and keeps restarting with its backoff.
                assert!(matches!(next, Some(AgentMsg::ExitWithError)));
            } else {
                // A standalone agent keeps retrying so a fixed server lets it in.
                assert!(matches!(next, Some(AgentMsg::Connect)));
                // A refusal only an operator can fix is retried at the slowest pace.
                assert!(
                    runtime.backoff.clone().next_delay() >= redoor_core::backoff::MAX_BACKOFF / 2
                );
            }
        }
    }

    /// A supervised agent leaves a dead tunnel to its owner after its window; a standalone
    /// agent keeps retrying however long the outage lasts.
    #[tokio::test(start_paused = true)]
    async fn only_supervised_agents_give_up_reconnecting_after_their_window() {
        for (id_source, exits) in [(standalone(), false), (DeviceIdSource::Assigned, true)] {
            let mut runtime = runtime_with_source(id_source);
            let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(4);

            runtime.schedule_reconnect(handle.clone(), "first failure");
            // Inside the window every agent retries.
            assert!(matches!(receiver.recv().await, Some(AgentMsg::Connect)));

            tokio::time::advance(runtime.profile.ws_timeouts.stale_timeout).await;
            runtime.schedule_reconnect(handle, "still unreachable");
            let next = receiver.recv().await;
            if exits {
                // The exit ends the SSH session, so the watchdog or relay builds a new one.
                assert!(matches!(next, Some(AgentMsg::ExitWithError)));
            } else {
                // Standalone agents never give up.
                assert!(matches!(next, Some(AgentMsg::Connect)));
            }
        }
    }

    /// A replaced standalone agent reconnects, so clones keep competing until the server
    /// detects the shared id; a supervised one exits so it cannot linger as a zombie.
    #[tokio::test(start_paused = true)]
    async fn eviction_reconnects_standalone_agents_and_ends_supervised_ones() {
        for (id_source, exits) in [(standalone(), false), (DeviceIdSource::Assigned, true)] {
            let mut runtime = runtime_with_source(id_source);
            let (_control_rx, _bulk_rx) = attach_links(&mut runtime);
            let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(4);

            runtime
                .handle_server_frame(
                    handle,
                    ServerToAgent::Evicted {
                        message: "replaced".to_string(),
                    },
                )
                .await;

            let next = receiver.recv().await;
            if exits {
                // Supervised agents keep exiting on eviction.
                assert!(matches!(next, Some(AgentMsg::ExitWithError)));
            } else {
                // Standalone agents retry with backoff instead.
                assert!(matches!(next, Some(AgentMsg::Connect)));
            }
        }
    }

    /// The loss of a socket can overtake the `evicted` frame read just before it; the frame
    /// must still decide the agent's fate instead of being dropped with the connection.
    #[tokio::test(start_paused = true)]
    async fn eviction_read_before_the_loss_is_still_handled() {
        let mut runtime = runtime();
        let (_control_rx, _bulk_rx) = attach_links(&mut runtime);
        let generation = runtime.control.generation();
        let (handle, mut receiver, _lifecycle_receiver) = AgentHandle::channel(4);
        runtime
            .handle_lifecycle_message(
                handle.clone(),
                AgentLifecycleMsg::ConnectionLost {
                    connection_generation: generation,
                    reason: "server closed connection".to_string(),
                },
            )
            .await;

        runtime
            .handle_message(
                handle,
                AgentMsg::WebSocketMessage {
                    connection_generation: generation,
                    text: r#"{"type":"evicted","message":"replaced"}"#.to_string(),
                },
            )
            .await;

        // The supervised agent still exits although its connection was already gone.
        assert!(matches!(
            receiver.recv().await,
            Some(AgentMsg::ExitWithError)
        ));
    }
}
