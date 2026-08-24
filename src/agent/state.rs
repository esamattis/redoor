use clap::Args;
use redoor::{
    log_protocol::LogStreamId,
    logging::Level,
    streaming,
    terminal_protocol::TerminalId,
    types::{AgentId, RequestId},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Arguments for `redoor agent`.
///
/// Every field is `Option` so `agent::run` can apply the same
/// CLI > env > config file > default precedence as the server. Clap `env`
/// fills configurable fields when their flags are omitted.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct AgentArgs {
    /// Detach the agent from the terminal and continue running in the background.
    #[arg(long)]
    pub(crate) daemon: bool,
    /// Redoor server URL (`http(s)://` or `ws(s)://`) without pathnname
    #[arg(env = "REDOOR_AGENT_WS")]
    pub(crate) server: Option<String>,
    /// Physical TCP endpoint used by an SSH tunnel while the URL retains TLS and HTTP identity.
    #[arg(long, hide = true)]
    pub(crate) connect_address: Option<String>,
    /// Disables TLS certificate verification for an explicitly tunneled WSS connection.
    #[arg(long, hide = true, requires = "connect_address")]
    pub(crate) insecure_tls: bool,
    /// Ties an SSH-launched agent to its relay session so a lost channel cannot orphan it.
    #[arg(long, hide = true)]
    pub(crate) exit_on_stdin_eof: bool,
    /// Registration name shown in the UI. Defaults to the computer hostname.
    /// Overrides `REDOOR_AGENT_NAME` and `[agent].name`.
    #[arg(long, env = "REDOOR_AGENT_NAME")]
    pub(crate) name: Option<String>,
    /// Shared secret from top-level `agent_token` so registration cannot be spoofed.
    /// Overrides `REDOOR_AGENT_TOKEN` and the config file.
    #[arg(long, env = "REDOOR_AGENT_TOKEN")]
    pub(crate) token: Option<String>,
    /// Path to the shared TOML config. Defaults under `/etc/<app-name>` when
    /// root, otherwise `~/.config/<app-name>`.
    #[arg(long)]
    pub(crate) config: Option<String>,
    /// Agent log file path. Overrides `REDOOR_AGENT_LOG` and `[agent].log`.
    /// Defaults to `~/.local/share/<app-name>/agent.log` for non-root users.
    #[arg(long, env = "REDOOR_AGENT_LOG")]
    pub(crate) log: Option<String>,
    /// Initial threshold. CLI overrides role env, legacy env, TOML, and the info default.
    #[arg(long = "log-level")]
    pub(crate) log_level: Option<Level>,
    /// Home directory opened by the UI without limiting filesystem access.
    /// Overrides `REDOOR_AGENT_HOME` and `[agent].home`.
    #[arg(long, env = "REDOOR_AGENT_HOME", alias = "dir", short_alias = 'd')]
    pub(crate) home: Option<String>,
    /// Overrides platform mount discovery with one exact same-device trash root.
    #[arg(long, env = "REDOOR_AGENT_TRASH_DIRECTORY")]
    pub(crate) trash_directory: Option<String>,
    /// Seconds to wait after connecting before notifying the desktop, or `off` to disable it.
    #[arg(
        long,
        env = "REDOOR_AGENT_NOTIFICATION",
        default_value = "5",
        value_parser = parse_notification_delay
    )]
    pub(crate) notification: Option<NotificationDelay>,
}

/// Parsed startup-notification setting kept explicit so disabling cannot resemble a valid delay.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NotificationDelay {
    /// Suppresses startup desktop notifications entirely.
    Off,
    /// Waits this many whole seconds after a fully authenticated connection.
    Seconds(u64),
}

/// Accepts a non-negative whole-second delay or the explicit `off` switch.
fn parse_notification_delay(value: &str) -> Result<NotificationDelay, String> {
    if value.eq_ignore_ascii_case("off") {
        return Ok(NotificationDelay::Off);
    }

    value
        .parse::<u64>()
        .map(NotificationDelay::Seconds)
        .map_err(|_| "notification delay must be a whole number of seconds or 'off'".to_string())
}

#[derive(Clone)]
/// Agent-side state for one active upload worker.
pub(crate) struct UploadSessionHandle {
    pub(crate) path: String,
    pub(crate) chunk_sender: mpsc::Sender<streaming::StreamChunk>,
    /// Signals cooperative shutdown so upload workers can remove temp output
    /// immediately when the router cancels the transfer.
    pub(crate) cancel_sender: watch::Sender<bool>,
}

#[derive(Clone, Default)]
/// Tracks active upload workers so stream chunks and cancels can be routed by request id.
pub(crate) struct ActiveUploads {
    inner: Arc<Mutex<HashMap<RequestId, UploadSessionHandle>>>,
}

impl ActiveUploads {
    /// Creates the shared upload registry used across protocol handlers and workers.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Returns whether an upload session already exists so duplicate starts can be rejected.
    pub(crate) fn contains(&self, request_id: RequestId) -> bool {
        self.inner
            .lock()
            .expect("active uploads mutex poisoned")
            .contains_key(&request_id)
    }

    /// Stores an upload handle so later chunks and cancels reach the correct worker.
    pub(crate) fn insert(&self, request_id: RequestId, handle: UploadSessionHandle) {
        self.inner
            .lock()
            .expect("active uploads mutex poisoned")
            .insert(request_id, handle);
    }

    /// Clones the upload handle so callers can act on it without holding the mutex across await points.
    pub(crate) fn get(&self, request_id: RequestId) -> Option<UploadSessionHandle> {
        self.inner
            .lock()
            .expect("active uploads mutex poisoned")
            .get(&request_id)
            .cloned()
    }

    /// Removes a completed upload so stale sessions do not receive more chunks or cancels.
    pub(crate) fn remove(&self, request_id: RequestId) {
        self.inner
            .lock()
            .expect("active uploads mutex poisoned")
            .remove(&request_id);
    }

    /// Cancels every upload before clearing the registry so workers can clean up temp outputs.
    pub(crate) fn clear(&self) {
        let mut active_uploads = self.inner.lock().expect("active uploads mutex poisoned");
        for upload in active_uploads.values() {
            let _ = upload.cancel_sender.send(true);
        }
        active_uploads.clear();
    }
}

#[derive(Clone)]
/// Agent-side state for one active download worker.
pub(crate) struct DownloadSessionHandle {
    pub(crate) cancel_sender: watch::Sender<bool>,
}

#[derive(Clone, Default)]
/// Tracks active download workers so cancellation can target the right request id.
pub(crate) struct ActiveDownloads {
    inner: Arc<Mutex<HashMap<RequestId, DownloadSessionHandle>>>,
}

#[derive(Clone, Default)]
/// Owns request-scoped cancellation signals for local copy and move workers.
pub(crate) struct ActiveLocalTransfers {
    inner: Arc<Mutex<HashMap<RequestId, watch::Sender<bool>>>>,
}

impl ActiveLocalTransfers {
    /// Registers one worker without coupling it to control-generation cancellation.
    pub(crate) fn insert(&self, request_id: RequestId, sender: watch::Sender<bool>) {
        self.inner
            .lock()
            .expect("active local transfers mutex poisoned")
            .insert(request_id, sender);
    }

    /// Signals only the requested copy or move and leaves unrelated workers running.
    pub(crate) fn cancel(&self, request_id: RequestId) -> bool {
        self.inner
            .lock()
            .expect("active local transfers mutex poisoned")
            .get(&request_id)
            .is_some_and(|sender| sender.send(true).is_ok())
    }

    /// Releases a worker's signal only after its temp-owning future has returned.
    pub(crate) fn remove(&self, request_id: RequestId) {
        self.inner
            .lock()
            .expect("active local transfers mutex poisoned")
            .remove(&request_id);
    }

    /// Cancels all request-scoped workers when their authoritative connection ends.
    pub(crate) fn clear(&self) {
        let mut transfers = self
            .inner
            .lock()
            .expect("active local transfers mutex poisoned");
        for sender in transfers.values() {
            let _ = sender.send(true);
        }
        transfers.clear();
    }
}

impl ActiveDownloads {
    /// Creates the shared download registry used across protocol handlers and workers.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Stores a download handle so later cancel messages can stop the correct worker.
    pub(crate) fn insert(&self, request_id: RequestId, handle: DownloadSessionHandle) {
        self.inner
            .lock()
            .expect("active downloads mutex poisoned")
            .insert(request_id, handle);
    }

    /// Clones the download handle so callers can send cancellation without holding the mutex.
    pub(crate) fn get(&self, request_id: RequestId) -> Option<DownloadSessionHandle> {
        self.inner
            .lock()
            .expect("active downloads mutex poisoned")
            .get(&request_id)
            .cloned()
    }

    /// Removes a completed download so stale sessions do not receive more cancels.
    pub(crate) fn remove(&self, request_id: RequestId) {
        self.inner
            .lock()
            .expect("active downloads mutex poisoned")
            .remove(&request_id);
    }

    /// Cancels every download before clearing the registry so workers exit promptly on shutdown.
    pub(crate) fn clear(&self) {
        let mut active_downloads = self.inner.lock().expect("active downloads mutex poisoned");
        for download in active_downloads.values() {
            let _ = download.cancel_sender.send(true);
        }
        active_downloads.clear();
    }
}

#[derive(Clone)]
/// Holds only the cancellation signal needed to stop one ephemeral terminal.
pub(crate) struct TerminalSessionHandle {
    pub(crate) cancel_sender: watch::Sender<bool>,
}

#[derive(Clone, Default)]
/// Tracks terminal cancellation atomically without retaining PTYs or replay state.
pub(crate) struct ActiveTerminals {
    inner: Arc<Mutex<HashMap<TerminalId, TerminalSessionHandle>>>,
}

impl ActiveTerminals {
    const MAX_ACTIVE: usize = 8;

    /// Creates the shared terminal registry used by control and terminal tasks.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Inserts a terminal only when its identifier is not already active.
    pub(crate) fn insert_if_absent(
        &self,
        terminal_id: TerminalId,
        handle: TerminalSessionHandle,
    ) -> bool {
        let mut terminals = self.inner.lock().expect("active terminals mutex poisoned");
        if terminals.contains_key(&terminal_id) || terminals.len() >= Self::MAX_ACTIVE {
            return false;
        }
        terminals.insert(terminal_id, handle);
        true
    }

    /// Removes a completed terminal so a later fresh bootstrap can reuse its identifier.
    pub(crate) fn remove(&self, terminal_id: &TerminalId) {
        self.inner
            .lock()
            .expect("active terminals mutex poisoned")
            .remove(terminal_id);
    }

    /// Cancels all dedicated terminal tasks before forgetting their handles.
    pub(crate) fn clear(&self) {
        let mut terminals = self.inner.lock().expect("active terminals mutex poisoned");
        for terminal in terminals.values() {
            let _ = terminal.cancel_sender.send(true);
        }
        terminals.clear();
    }
}

/// Holds only the cancellation signal needed to stop one ephemeral log stream.
#[derive(Clone)]
pub(crate) struct LogStreamSessionHandle {
    pub(crate) cancel_sender: watch::Sender<bool>,
}

/// Tracks log stream cancellation without retaining logger receivers or sockets.
#[derive(Clone, Default)]
pub(crate) struct ActiveLogStreams {
    inner: Arc<Mutex<HashMap<LogStreamId, LogStreamSessionHandle>>>,
}

impl ActiveLogStreams {
    const MAX_ACTIVE: usize = 8;

    /// Creates the shared log stream registry used by control and dedicated tasks.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Inserts a stream only when its identifier is fresh and the task cap has room.
    pub(crate) fn insert_if_absent(
        &self,
        log_stream_id: LogStreamId,
        handle: LogStreamSessionHandle,
    ) -> bool {
        let mut streams = self
            .inner
            .lock()
            .expect("active log streams mutex poisoned");
        if streams.contains_key(&log_stream_id) || streams.len() >= Self::MAX_ACTIVE {
            return false;
        }
        streams.insert(log_stream_id, handle);
        true
    }

    /// Removes only the completed stream so concurrent viewers keep their cancellation handles.
    pub(crate) fn remove(&self, log_stream_id: &LogStreamId) {
        self.inner
            .lock()
            .expect("active log streams mutex poisoned")
            .remove(log_stream_id);
    }

    /// Signals every dedicated task before forgetting handles on authoritative disconnect.
    pub(crate) fn clear(&self) {
        let mut streams = self
            .inner
            .lock()
            .expect("active log streams mutex poisoned");
        for stream in streams.values() {
            let _ = stream.cancel_sender.send(true);
        }
        streams.clear();
    }

    /// Counts active handles only for deterministic cleanup tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("active log streams mutex poisoned")
            .len()
    }
}

/// Owns mutable control-plane state while dedicated data-plane tasks use cloned handles.
pub(crate) struct AgentState {
    pub(crate) agent_id: AgentId,
    pub(crate) agent_name: String,
    /// Shared connection policy ensures every agent websocket uses the same tunnel and TLS identity.
    pub(crate) connection: super::connection::AgentConnection,
    /// Immutable absolute directory used when the UI opens this agent.
    pub(crate) default_directory: String,
    /// Shared secret presented during registration so the server can reject impostors.
    pub(crate) token: String,
    /// Immutable provider configuration cloned into bounded command workers.
    pub(crate) trash: super::trash::TrashService,
    /// Current control writer used for commands, responses, cancellation, and lifecycle traffic.
    pub(crate) ws_control_tx: Option<mpsc::Sender<WsMessage>>,
    /// Stops both halves of the current control socket when liveness checks discard it.
    pub(crate) control_shutdown: Option<watch::Sender<bool>>,
    /// Current payload writer used exclusively for binary stream chunks.
    pub(crate) ws_transfer_tx: Option<mpsc::Sender<WsMessage>>,
    /// Session-scoped secret issued by the current authoritative server control connection.
    pub(crate) transfer_token: Option<String>,
    /// Stops both halves of the current transfer socket on replacement or control loss.
    pub(crate) transfer_shutdown: Option<watch::Sender<bool>>,
    /// Separates stale transfer task events from the current payload connection.
    pub(crate) transfer_generation: u64,
    pub(crate) connection_generation: u64,
    pub(crate) active_uploads: ActiveUploads,
    pub(crate) active_downloads: ActiveDownloads,
    pub(crate) active_local_transfers: ActiveLocalTransfers,
    /// Retains cancels that overtake commands on the independent priority lane.
    pub(crate) pending_transfer_cancellations: HashSet<RequestId>,
    pub(crate) active_terminals: ActiveTerminals,
    pub(crate) active_log_streams: ActiveLogStreams,
    /// Supersedes recursive traversal without serializing unrelated control commands.
    active_file_search_cancel: Option<watch::Sender<bool>>,
}

impl AgentState {
    /// Creates agent state with startup metadata that remains stable across reconnects.
    pub(crate) fn new(
        agent_id: AgentId,
        agent_name: String,
        connection: super::connection::AgentConnection,
        default_directory: String,
        token: String,
        trash: super::trash::TrashService,
    ) -> Self {
        Self {
            agent_id,
            agent_name,
            connection,
            default_directory,
            token,
            trash,
            ws_control_tx: None,
            control_shutdown: None,
            ws_transfer_tx: None,
            transfer_token: None,
            transfer_shutdown: None,
            transfer_generation: 0,
            connection_generation: 0,
            active_uploads: ActiveUploads::new(),
            active_downloads: ActiveDownloads::new(),
            active_local_transfers: ActiveLocalTransfers::default(),
            pending_transfer_cancellations: HashSet::new(),
            active_terminals: ActiveTerminals::new(),
            active_log_streams: ActiveLogStreams::new(),
            active_file_search_cancel: None,
        }
    }

    /// Cancels the previous traversal before returning a token for its replacement.
    pub(crate) fn begin_file_search(&mut self) -> watch::Receiver<bool> {
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        if let Some(previous) = self.active_file_search_cancel.replace(cancel_sender) {
            let _ = previous.send(true);
        }
        cancel_receiver
    }

    /// Stops recursive traversal when its owning agent connection is discarded.
    pub(crate) fn cancel_file_search(&mut self) {
        if let Some(cancel_sender) = self.active_file_search_cancel.take() {
            let _ = cancel_sender.send(true);
        }
    }

    /// Advances the socket identity so delayed events cannot affect a replacement connection.
    pub(crate) fn advance_connection_generation(&mut self) -> u64 {
        self.connection_generation = self.connection_generation.wrapping_add(1);
        self.connection_generation
    }

    /// Advances payload identity so delayed transfer loss cannot clear a replacement sender.
    pub(crate) fn advance_transfer_generation(&mut self) -> u64 {
        self.transfer_generation = self.transfer_generation.wrapping_add(1);
        self.transfer_generation
    }

    /// Stops the current control transport before reconnecting so blackholed tasks cannot linger.
    pub(crate) fn clear_control_connection(&mut self) {
        if let Some(shutdown) = self.control_shutdown.take() {
            let _ = shutdown.send(true);
        }
        self.ws_control_tx = None;
    }

    /// Invalidates and stops payload transport when the authoritative control session changes.
    pub(crate) fn clear_transfer_connection(&mut self) {
        if let Some(shutdown) = self.transfer_shutdown.take() {
            let _ = shutdown.send(true);
        }
        self.ws_transfer_tx = None;
        self.transfer_token = None;
        self.advance_transfer_generation();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// Keeps the human-readable disable value distinct from numeric delays.
    #[test]
    fn parses_notification_off_switch() {
        // Case-insensitive parsing avoids surprising environment configuration differences.
        assert_eq!(parse_notification_delay("OFF"), Ok(NotificationDelay::Off));
    }

    /// Prevents the removed numeric sentinel from remaining an undocumented compatibility path.
    #[test]
    fn rejects_negative_notification_delay() {
        // Only non-negative seconds or the explicit `off` value are valid.
        assert!(parse_notification_delay("-1").is_err());
    }

    /// Ensures a replacement search synchronously cancels only the previous traversal.
    #[test]
    fn beginning_file_search_cancels_previous_search() {
        let mut state = AgentState::new(
            AgentId::from("test-agent"),
            "test-agent".to_string(),
            super::super::connection::AgentConnection::new(
                "ws://localhost/ws".to_string(),
                None,
                false,
            )
            .unwrap(),
            "/tmp".to_string(),
            "token".to_string(),
            super::super::trash::TrashService::for_tests(),
        );
        let first = state.begin_file_search();

        let second = state.begin_file_search();

        // Replacement must publish cancellation before the new traversal can be spawned.
        assert!(*first.borrow());
        // The replacement remains active rather than inheriting the old cancellation state.
        assert!(!*second.borrow());
    }

    /// Protects authoritative disconnect cleanup across every active dedicated log task.
    #[test]
    fn clearing_log_streams_signals_all_tasks_and_empties_registry() {
        let streams = ActiveLogStreams::new();
        let first_id = LogStreamId(Uuid::from_u128(1));
        let second_id = LogStreamId(Uuid::from_u128(2));
        let (first_sender, first_receiver) = watch::channel(false);
        let (second_sender, second_receiver) = watch::channel(false);
        // Both unique sessions must fit under the bounded active-task cap.
        assert!(streams.insert_if_absent(
            first_id,
            LogStreamSessionHandle {
                cancel_sender: first_sender
            },
        ));
        // A second browser viewer must remain independently tracked.
        assert!(streams.insert_if_absent(
            second_id,
            LogStreamSessionHandle {
                cancel_sender: second_sender
            },
        ));

        streams.clear();

        // Clearing must synchronously publish cancellation before handles are forgotten.
        assert!(*first_receiver.borrow());
        // Every tracked task, not only the first, must receive the disconnect signal.
        assert!(*second_receiver.borrow());
        // No stale active-session capacity may remain after cleanup.
        assert_eq!(streams.len(), 0);
    }

    /// Protects completion cleanup from canceling or removing another browser's stream.
    #[test]
    fn removing_completed_log_stream_preserves_other_sessions() {
        let streams = ActiveLogStreams::new();
        let first_id = LogStreamId(Uuid::from_u128(1));
        let second_id = LogStreamId(Uuid::from_u128(2));
        let (first_sender, _first_receiver) = watch::channel(false);
        let (second_sender, second_receiver) = watch::channel(false);
        assert!(streams.insert_if_absent(
            first_id.clone(),
            LogStreamSessionHandle {
                cancel_sender: first_sender
            },
        ));
        assert!(streams.insert_if_absent(
            second_id,
            LogStreamSessionHandle {
                cancel_sender: second_sender
            },
        ));

        streams.remove(&first_id);

        // Task completion must remove exactly its own handle.
        assert_eq!(streams.len(), 1);
        // Removing a sibling must not spuriously cancel the still-active viewer.
        assert!(!*second_receiver.borrow());
    }

    /// Verifies explicit cancellation targets one local transfer rather than its whole generation.
    #[test]
    fn local_transfer_cancellation_is_request_scoped() {
        let transfers = ActiveLocalTransfers::default();
        let (first_sender, first_receiver) = watch::channel(false);
        let (second_sender, second_receiver) = watch::channel(false);
        transfers.insert(RequestId::new(1), first_sender);
        transfers.insert(RequestId::new(2), second_sender);

        // A known request must accept cancellation synchronously for prompt control-path handling.
        assert!(transfers.cancel(RequestId::new(1)));
        // The selected worker receives the cooperative stop signal.
        assert!(*first_receiver.borrow());
        // An unrelated copy remains active instead of inheriting broad generation cancellation.
        assert!(!*second_receiver.borrow());
        transfers.remove(RequestId::new(1));
        // Released request ownership makes repeated late protocol frames harmless.
        assert!(!transfers.cancel(RequestId::new(1)));
    }
}
