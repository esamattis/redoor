use clap::Args;
use redoor::{
    log_protocol::LogStreamId,
    streaming,
    terminal_protocol::TerminalId,
    types::{AgentId, RequestId},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Arguments for `redoor agent`.
///
/// Every field is `Option` so `agent::run` can apply the same
/// CLI > env > config file > default precedence as the server. Clap `env`
/// fills each field when the flag is omitted.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct AgentArgs {
    /// WebSocket URL of the server (e.g. `ws://127.0.0.1:3000/ws`).
    /// Overrides `REDOOR_AGENT_WS` and `[agent].ws_address`.
    #[arg(env = "REDOOR_AGENT_WS")]
    pub(crate) ws_address: Option<String>,
    /// Registration name shown in the UI. Overrides `REDOOR_AGENT_NAME` and `[agent].name`.
    #[arg(long, env = "REDOOR_AGENT_NAME")]
    pub(crate) name: Option<String>,
    /// Shared secret from top-level `agent_token` so registration cannot be spoofed.
    /// Overrides `REDOOR_AGENT_TOKEN` and the config file.
    #[arg(long, env = "REDOOR_AGENT_TOKEN")]
    pub(crate) token: Option<String>,
    /// Path to the shared TOML config. Defaults to `~/.config/redoor/config.toml`.
    #[arg(long)]
    pub(crate) config: Option<String>,
    /// Agent log file path. Overrides `REDOOR_AGENT_LOG` and `[agent].log`.
    #[arg(long, env = "REDOOR_AGENT_LOG")]
    pub(crate) log: Option<String>,
    /// Default directory opened by the UI without limiting filesystem access.
    /// Overrides `REDOOR_AGENT_DIR` and `[agent].dir`.
    #[arg(short = 'd', long, env = "REDOOR_AGENT_DIR")]
    pub(crate) dir: Option<String>,
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
    pub(crate) server_url: String,
    /// Immutable absolute directory used when the UI opens this agent.
    pub(crate) default_directory: String,
    /// Shared secret presented during registration so the server can reject impostors.
    pub(crate) token: String,
    /// Current control writer used for commands, responses, cancellation, and lifecycle traffic.
    pub(crate) ws_control_tx: Option<mpsc::Sender<WsMessage>>,
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
    pub(crate) active_terminals: ActiveTerminals,
    pub(crate) active_log_streams: ActiveLogStreams,
}

impl AgentState {
    /// Creates agent state with startup metadata that remains stable across reconnects.
    pub(crate) fn new(
        agent_id: AgentId,
        agent_name: String,
        server_url: String,
        default_directory: String,
        token: String,
    ) -> Self {
        Self {
            agent_id,
            agent_name,
            server_url,
            default_directory,
            token,
            ws_control_tx: None,
            ws_transfer_tx: None,
            transfer_token: None,
            transfer_shutdown: None,
            transfer_generation: 0,
            connection_generation: 0,
            active_uploads: ActiveUploads::new(),
            active_downloads: ActiveDownloads::new(),
            active_terminals: ActiveTerminals::new(),
            active_log_streams: ActiveLogStreams::new(),
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
}
