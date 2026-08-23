use super::{
    AgentActor, AgentHandle, AgentLifecycleMsg, AgentMsg, AgentRuntime, AgentState,
    connection::AgentConnection,
    notification,
    transfer::{begin_transfer_connection, schedule_transfer_reconnect},
    ws::{spawn_read_task, spawn_stdin_task, spawn_write_task},
};
use futures_util::StreamExt;
use redoor::{
    Level, log,
    types::{AgentId, Message},
};
use sysinfo::System;
use tokio::sync::mpsc::{self, Receiver};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Number of quick reconnect attempts allowed before switching to the slower window.
const QUICK_RECONNECT_ATTEMPTS: u32 = 10;
/// Inclusive jitter window for quick reconnect attempts.
const QUICK_RECONNECT_DELAY_SECONDS: std::ops::RangeInclusive<u64> = 2..=5;
/// Inclusive jitter window used after quick reconnect attempts are exhausted.
const SLOW_RECONNECT_DELAY_SECONDS: std::ops::RangeInclusive<u64> = 30..=60;

/// Returns the retry window for an attempt so outages back off without synchronizing agents.
fn reconnect_delay_range(attempt: u32) -> std::ops::RangeInclusive<u64> {
    if attempt <= QUICK_RECONNECT_ATTEMPTS {
        QUICK_RECONNECT_DELAY_SECONDS
    } else {
        SLOW_RECONNECT_DELAY_SECONDS
    }
}

/// Selects one jittered reconnect delay from the window assigned to an attempt.
fn reconnect_delay(attempt: u32) -> tokio::time::Duration {
    tokio::time::Duration::from_secs(fastrand::u64(reconnect_delay_range(attempt)))
}

impl AgentRuntime {
    /// Creates the initial agent runtime state before any websocket connection exists.
    pub(crate) fn new(
        agent_id: AgentId,
        agent_name: String,
        connection: AgentConnection,
        default_directory: String,
        token: String,
        trash: super::trash::TrashService,
        startup_notification_delay: Option<tokio::time::Duration>,
    ) -> Self {
        let (command_cancel, _) = tokio::sync::watch::channel(false);
        Self {
            state: AgentState::new(
                agent_id,
                agent_name,
                connection,
                default_directory,
                token,
                trash,
            ),
            command_tasks: tokio::task::JoinSet::new(),
            command_cancel,
            desktop_environment: crate::desktop::detect_desktop_environment(),
            startup_notification_delay,
            startup_notification_generation: None,
            startup_notification_sent: false,
            reconnect_attempts: 0,
        }
    }

    /// Runs the agent event loop until shutdown or fatal error.
    pub(crate) async fn run(
        mut self,
        mut receiver: Receiver<AgentMsg>,
        mut lifecycle_receiver: mpsc::UnboundedReceiver<AgentLifecycleMsg>,
        handle: AgentHandle,
        exit_on_stdin_eof: bool,
    ) {
        spawn_stdin_task(handle.clone(), exit_on_stdin_eof).await;
        let _ = handle.try_send(AgentMsg::Connect);

        log!(
            Level::Info,
            "Agent task started: agent_id={}, agent_name={}",
            self.state.agent_id,
            self.state.agent_name
        );

        loop {
            tokio::select! {
                biased;
                lifecycle = lifecycle_receiver.recv() => match lifecycle {
                    Some(message) => self.handle_lifecycle_message(handle.clone(), message).await,
                    None => break,
                },
                message = receiver.recv() => {
                    let Some(message) = message else {
                        break;
                    };
                    if !self.handle_message(handle.clone(), message).await {
                        break;
                    }
                },
            }
        }

        self.state.clear_control_connection();
        self.state.clear_transfer_connection();
        self.state.active_uploads.clear();
        self.state.active_downloads.clear();
        self.state.active_terminals.clear();
        self.state.active_log_streams.clear();
        self.state.cancel_file_search();
        self.stop_command_tasks().await;

        log!(
            Level::Info,
            "Agent stopped: agent_id={}",
            self.state.agent_id
        );
    }

    /// Handles one agent control message and returns whether the event loop should continue.
    async fn handle_message(&mut self, handle: AgentHandle, message: AgentMsg) -> bool {
        let agent = AgentActor;

        match message {
            AgentMsg::Connect => {
                if self.state.ws_control_tx.is_none() {
                    self.connect(handle).await;
                }
            }
            AgentMsg::WebSocketMessage {
                connection_generation,
                text,
            } => {
                if connection_generation != self.state.connection_generation {
                    return true;
                }
                if let Some(tx_control) = self.state.ws_control_tx.as_ref().cloned() {
                    let command_cancel = self.command_cancel.subscribe();
                    agent
                        .handle_incoming_message(
                            text,
                            &mut self.state,
                            &tx_control,
                            handle,
                            &mut self.command_tasks,
                            command_cancel,
                        )
                        .await;
                }
            }
            AgentMsg::TransferConnected {
                control_generation,
                transfer_generation,
                token,
                sender,
                shutdown,
                installed,
            } => {
                let is_current = control_generation == self.state.connection_generation
                    && transfer_generation == self.state.transfer_generation
                    && self.state.transfer_token.as_ref() == Some(&token);
                if is_current {
                    // Install before acknowledging so transfer auth cannot expose the server first.
                    self.state.ws_transfer_tx = Some(sender);
                    self.state.transfer_shutdown = Some(shutdown);
                    let _ = installed.send(true);
                    self.schedule_startup_notification(handle);
                } else {
                    let _ = shutdown.send(true);
                    let _ = installed.send(false);
                }
            }
            AgentMsg::TransferConnectionLost {
                control_generation,
                transfer_generation,
                reason,
            } => {
                if control_generation != self.state.connection_generation
                    || transfer_generation != self.state.transfer_generation
                {
                    log!(
                        Level::Debug,
                        "Ignoring stale transfer loss: generation={}",
                        transfer_generation
                    );
                    return true;
                }
                log!(
                    Level::Warning,
                    "Transfer connection lost: agent_id={}, reason={}",
                    self.state.agent_id,
                    reason
                );
                self.state.ws_transfer_tx = None;
                self.state.transfer_shutdown = None;
                self.state.active_uploads.clear();
                self.state.active_downloads.clear();
                let next_generation = self.state.advance_transfer_generation();
                if let Some(token) = self.state.transfer_token.clone() {
                    log!(
                        Level::Info,
                        "Transfer reconnect scheduled: agent_id={}, generation={}",
                        self.state.agent_id,
                        next_generation
                    );
                    schedule_transfer_reconnect(handle, control_generation, next_generation, token);
                }
            }
            AgentMsg::ReconnectTransfer {
                control_generation,
                transfer_generation,
                token,
            } => {
                if control_generation == self.state.connection_generation
                    && transfer_generation == self.state.transfer_generation
                    && self.state.transfer_token.as_ref() == Some(&token)
                    && self.state.ws_control_tx.is_some()
                    && self.state.ws_transfer_tx.is_none()
                {
                    begin_transfer_connection(&mut self.state, handle, token);
                }
            }
            AgentMsg::StartupNotificationDue {
                connection_generation,
                transfer_generation,
            } => {
                self.show_startup_notification_if_current(
                    connection_generation,
                    transfer_generation,
                );
            }
            AgentMsg::SendWebSocketMessage { msg } => {
                if let Some(tx) = &self.state.ws_control_tx
                    && tx.send(msg).await.is_err()
                {
                    log!(
                        Level::Error,
                        "Failed to send message, connection may be lost"
                    );
                }
            }
            AgentMsg::TerminalFinished { terminal_id } => {
                self.state.active_terminals.remove(&terminal_id);
            }
            AgentMsg::LogStreamFinished { log_stream_id } => {
                self.state.active_log_streams.remove(&log_stream_id);
            }
            AgentMsg::Shutdown => return false,
            AgentMsg::ExitWithError => {
                log!(Level::Error, "Exiting agent due to error");
                std::process::exit(1);
            }
        }

        true
    }

    /// Applies transport lifecycle ahead of bounded application traffic.
    async fn handle_lifecycle_message(&mut self, handle: AgentHandle, message: AgentLifecycleMsg) {
        match message {
            AgentLifecycleMsg::ConnectionLost {
                connection_generation,
                reason,
            } => {
                if connection_generation != self.state.connection_generation {
                    log!(
                        Level::Debug,
                        "Ignoring stale connection loss from generation {}: {}",
                        connection_generation,
                        reason
                    );
                    return;
                }
                if self.state.ws_control_tx.is_none() {
                    log!(
                        Level::Debug,
                        "Ignoring duplicate connection loss: {}",
                        reason
                    );
                    return;
                }
                self.state.clear_control_connection();
                self.state.clear_transfer_connection();
                self.state.active_uploads.clear();
                self.state.active_downloads.clear();
                self.state.active_terminals.clear();
                self.state.active_log_streams.clear();
                self.state.cancel_file_search();
                self.stop_command_tasks().await;
                self.schedule_reconnect(handle, &format!("Connection lost: {reason}"));
            }
        }
    }

    /// Cancels and joins every command from the discarded control generation.
    async fn stop_command_tasks(&mut self) {
        let _ = self.command_cancel.send(true);
        while let Some(result) = self.command_tasks.join_next().await {
            if let Err(error) = result {
                log!(
                    Level::Warning,
                    "Agent command task failed while stopping: {error}"
                );
            }
        }
        let (command_cancel, _) = tokio::sync::watch::channel(false);
        self.command_cancel = command_cancel;
    }

    /// Schedules the next connection attempt with jitter and escalates after repeated failures.
    fn schedule_reconnect(&mut self, handle: AgentHandle, reason: &str) {
        self.reconnect_attempts = self.reconnect_attempts.saturating_add(1);
        let attempt = self.reconnect_attempts;
        let delay = reconnect_delay(attempt);
        log!(
            Level::Warning,
            "{}, scheduling reconnect attempt {} in {}s",
            reason,
            attempt,
            delay.as_secs()
        );
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            enqueue_reconnect(handle).await;
        });
    }

    /// Starts a replaceable timer only after both authenticated websocket lanes are ready.
    fn schedule_startup_notification(&mut self, handle: AgentHandle) {
        let Some(_desktop_environment) = self.desktop_environment else {
            return;
        };
        let Some(delay) = self.startup_notification_delay else {
            return;
        };
        if self.startup_notification_sent {
            return;
        }

        let connection_generation = self.state.connection_generation;
        let transfer_generation = self.state.transfer_generation;
        self.startup_notification_generation = Some((connection_generation, transfer_generation));
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = handle
                .send(AgentMsg::StartupNotificationDue {
                    connection_generation,
                    transfer_generation,
                })
                .await;
        });
    }

    /// Shows the delayed notification only when its fully connected socket pair is still current.
    fn show_startup_notification_if_current(
        &mut self,
        connection_generation: u64,
        transfer_generation: u64,
    ) {
        let generation = (connection_generation, transfer_generation);
        let is_current = self.startup_notification_generation == Some(generation)
            && self.state.connection_generation == connection_generation
            && self.state.transfer_generation == transfer_generation
            && self.state.ws_control_tx.is_some()
            && self.state.ws_transfer_tx.is_some();
        if !is_current {
            return;
        }

        self.startup_notification_generation = None;
        self.startup_notification_sent = true;
        let Some(desktop_environment) = self.desktop_environment else {
            return;
        };
        let agent_name = self.state.agent_name.clone();
        tokio::spawn(async move {
            if notification::show_agent_started(desktop_environment, &agent_name).await {
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
    async fn connect(&mut self, handle: AgentHandle) {
        log!(
            Level::Info,
            "Attempting to connect to {} as agent '{}'",
            self.state.connection.server_url(),
            self.state.agent_name
        );

        let connection_result = tokio::time::timeout(
            redoor::websocket::timeouts().stale_timeout,
            self.state
                .connection
                .connect(self.state.connection.server_url()),
        )
        .await;
        match connection_result {
            Ok(Ok((ws_stream, _response))) => {
                self.reconnect_attempts = 0;
                log!(
                    Level::Info,
                    "Connected to {}",
                    self.state.connection.server_url()
                );
                log!(
                    Level::Info,
                    "Agent connected: agent_id={}, agent_name={}, server={}",
                    self.state.agent_id,
                    self.state.agent_name,
                    self.state.connection.server_url()
                );

                let (write, read) = ws_stream.split();
                let (control_tx, control_rx) = mpsc::channel::<WsMessage>(32);
                let (control_shutdown, control_shutdown_rx) = tokio::sync::watch::channel(false);
                let connection_generation = self.state.advance_connection_generation();

                self.state.ws_control_tx = Some(control_tx.clone());
                self.state.control_shutdown = Some(control_shutdown.clone());

                if let Err(error) = crate::systemd_notify::ready().await {
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
                    control_shutdown.clone(),
                    control_shutdown_rx.clone(),
                )
                .await;
                spawn_write_task(
                    write,
                    control_rx,
                    control_shutdown,
                    control_shutdown_rx,
                    handle.clone(),
                    connection_generation,
                );

                let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
                let os = std::env::consts::OS.to_string();
                let arch = std::env::consts::ARCH.to_string();
                let username = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());

                let register_msg = Message::AgentRegister {
                    agent_id: self.state.agent_id.clone(),
                    agent_name: self.state.agent_name.clone(),
                    os,
                    arch,
                    hostname,
                    username,
                    cwd: self.state.default_directory.clone(),
                    token: self.state.token.clone(),
                    // Lets the server compare agent builds against itself without a round-trip command.
                    binary: redoor::commands::current_binary_identity(),
                    // Upgrade safety depends on the server knowing this command is implemented.
                    supports_self_exec: true,
                    // Reuse startup GUI detection so headless agents never advertise the action.
                    supports_native_open: self.desktop_environment.is_some(),
                    // Prevents newer servers from dispatching unknown commands to unsupported agents.
                    supports_trash: self.state.trash.supported(),
                };

                if let Ok(json) = serde_json::to_string(&register_msg) {
                    // Do not log the JSON body: it includes the agent token secret.
                    log!(
                        Level::Info,
                        "Sending agent registration message: agent_id={}, agent_name={}",
                        self.state.agent_id,
                        self.state.agent_name
                    );
                    if let Err(error) = control_tx.send(WsMessage::text(json)).await {
                        log!(Level::Error, "Failed to send agent registration: {}", error);
                    }
                }
            }
            Ok(Err(error)) => {
                self.schedule_reconnect(handle, &format!("Connection failed: {error:#}"));
            }
            Err(_) => {
                let timeout = redoor::websocket::timeouts().stale_timeout;
                self.schedule_reconnect(
                    handle,
                    &format!("Connection failed: WebSocket connection attempt timed out after {timeout:?}"),
                );
            }
        }
    }
}

/// Awaits bounded mailbox capacity so a due reconnect cannot be silently discarded.
async fn enqueue_reconnect(handle: AgentHandle) {
    let _ = handle.send(AgentMsg::Connect).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor::types::AgentId;

    /// Creates a handle and lifecycle receiver for direct runtime tests.
    fn test_handle(
        sender: mpsc::Sender<AgentMsg>,
    ) -> (AgentHandle, mpsc::UnboundedReceiver<AgentLifecycleMsg>) {
        let (lifecycle_sender, lifecycle_receiver) = mpsc::unbounded_channel();
        (
            AgentHandle {
                sender,
                lifecycle_sender,
            },
            lifecycle_receiver,
        )
    }

    /// Verifies the first ten reconnect attempts retain the quick jitter window.
    #[test]
    fn first_ten_reconnect_attempts_use_quick_window() {
        // The first retry must not be delayed by the prolonged-outage policy.
        assert_eq!(reconnect_delay_range(1), 2..=5);
        // The tenth retry is the final attempt in the quick window.
        assert_eq!(reconnect_delay_range(10), 2..=5);
    }

    /// Verifies reconnect attempts after the first ten use the slower jitter window.
    #[test]
    fn later_reconnect_attempts_use_slow_window() {
        // The eleventh retry must back off to avoid aggressive reconnect traffic.
        assert_eq!(reconnect_delay_range(11), 30..=60);
        // Saturated counters must remain in the prolonged-outage retry window.
        assert_eq!(reconnect_delay_range(u32::MAX), 30..=60);
    }

    /// Verifies generated delays always remain inside their assigned inclusive windows.
    #[test]
    fn reconnect_delay_is_jittered_within_policy_windows() {
        for attempt in [1, 10, 11, u32::MAX] {
            let expected_range = reconnect_delay_range(attempt);
            for _ in 0..100 {
                let delay = reconnect_delay(attempt).as_secs();
                // Jitter must never reconnect earlier or later than the policy permits.
                assert!(expected_range.contains(&delay));
            }
        }
    }

    /// Verifies a delayed writer failure cannot clear a newer live connection.
    #[tokio::test]
    async fn stale_connection_loss_does_not_clear_replacement_connection() {
        redoor::logging::init(None).await.unwrap();
        let mut runtime = AgentRuntime::new(
            AgentId::from("agent"),
            "agent".to_string(),
            AgentConnection::new("ws://localhost".to_string(), None, false).unwrap(),
            "/tmp".to_string(),
            "test-token".to_string(),
            crate::agent::trash::TrashService::for_tests(),
            None,
        );
        let stale_generation = runtime.state.advance_connection_generation();
        let current_generation = runtime.state.advance_connection_generation();
        let (control_tx, _control_rx) = mpsc::channel(1);
        let (transfer_tx, _transfer_rx) = mpsc::channel(1);
        runtime.state.ws_control_tx = Some(control_tx);
        runtime.state.ws_transfer_tx = Some(transfer_tx);
        let (sender, _receiver) = mpsc::channel(1);
        let (handle, _lifecycle_receiver) = test_handle(sender);

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
        assert_eq!(runtime.state.connection_generation, current_generation);
        // The current control sender must survive a delayed loss from the old generation.
        assert!(runtime.state.ws_control_tx.is_some());
        // The independently attached transfer sender must also remain available.
        assert!(runtime.state.ws_transfer_tx.is_some());
    }

    /// Verifies delayed transfer teardown cannot detach a newer payload socket.
    #[tokio::test]
    async fn stale_transfer_loss_does_not_clear_replacement_sender() {
        redoor::logging::init(None).await.unwrap();
        let mut runtime = AgentRuntime::new(
            AgentId::from("agent"),
            "agent".to_string(),
            AgentConnection::new("ws://localhost".to_string(), None, false).unwrap(),
            "/tmp".to_string(),
            "test-token".to_string(),
            crate::agent::trash::TrashService::for_tests(),
            None,
        );
        runtime.state.advance_connection_generation();
        let stale_generation = runtime.state.advance_transfer_generation();
        let current_generation = runtime.state.advance_transfer_generation();
        runtime.state.transfer_token = Some("session-token".to_string());
        let (control_tx, _control_rx) = mpsc::channel(1);
        let (transfer_tx, _transfer_rx) = mpsc::channel(1);
        runtime.state.ws_control_tx = Some(control_tx);
        runtime.state.ws_transfer_tx = Some(transfer_tx);
        let (sender, _receiver) = mpsc::channel(1);
        let (handle, _lifecycle_receiver) = test_handle(sender);

        let keep_running = runtime
            .handle_message(
                handle,
                AgentMsg::TransferConnectionLost {
                    control_generation: runtime.state.connection_generation,
                    transfer_generation: stale_generation,
                    reason: "old transfer reader ended".to_string(),
                },
            )
            .await;

        // A stale transfer event must not stop the authoritative control actor.
        assert!(keep_running);
        // The current transfer generation must remain unchanged by delayed teardown.
        assert_eq!(runtime.state.transfer_generation, current_generation);
        // The replacement payload sender must remain installed and usable.
        assert!(runtime.state.ws_transfer_tx.is_some());
    }

    /// Verifies a reconnect timer waits for bounded capacity instead of dropping the only retry.
    #[tokio::test]
    async fn reconnect_survives_saturated_actor_mailbox() {
        let (sender, mut receiver) = mpsc::channel(1);
        let (handle, _lifecycle_receiver) = test_handle(sender);
        handle
            .try_send(AgentMsg::ExitWithError)
            .expect("mailbox saturation setup should fill its only slot");
        let reconnect = enqueue_reconnect(handle);
        tokio::pin!(reconnect);

        // Pending while full proves a due reconnect waits instead of using a lossy try-send.
        assert!(futures_util::poll!(&mut reconnect).is_pending());

        // The existing item must remain first because reconnect scheduling may not evict traffic.
        assert!(matches!(
            receiver.recv().await,
            Some(AgentMsg::ExitWithError)
        ));
        reconnect.await;
        // Freeing capacity must release the awaited timer send and preserve the reconnect attempt.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Connect)));
    }

    /// Verifies graceful teardown publishes cancellation and waits for command workers to exit.
    #[tokio::test]
    async fn stopping_command_tasks_cancels_and_joins_the_generation() {
        let mut runtime = AgentRuntime::new(
            AgentId::from("agent"),
            "agent".to_string(),
            AgentConnection::new("ws://localhost".to_string(), None, false).unwrap(),
            "/tmp".to_string(),
            "test-token".to_string(),
            crate::agent::trash::TrashService::for_tests(),
            None,
        );
        let mut cancel = runtime.command_cancel.subscribe();
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (finished_sender, finished_receiver) = tokio::sync::oneshot::channel();
        runtime.command_tasks.spawn(async move {
            let _ = started_sender.send(());
            let _ = cancel.changed().await;
            let _ = finished_sender.send(());
        });
        started_receiver
            .await
            .expect("command task should report that it is waiting for cancellation");

        runtime.stop_command_tasks().await;

        // Receiving completion proves shutdown joined the worker after it observed cancellation.
        finished_receiver
            .await
            .expect("joined command task should report completion");
        // A new control generation must not inherit the previous generation's canceled state.
        assert!(!*runtime.command_cancel.borrow());
        // No detached command handle may remain after graceful teardown returns.
        assert!(runtime.command_tasks.is_empty());
    }
}
