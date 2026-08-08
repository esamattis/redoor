use clap::Args;
use redoor::{
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

#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct AgentArgs {
    pub(crate) ws_address: String,
    #[arg(long)]
    pub(crate) name: String,
    #[arg(long)]
    pub(crate) log: Option<String>,
    /// Working directory to switch to immediately on startup so the agent
    /// operates from the requested path even when launched elsewhere.
    #[arg(short = 'd', long)]
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

pub(crate) struct AgentState {
    pub(crate) agent_id: AgentId,
    pub(crate) agent_name: String,
    pub(crate) server_url: String,
    pub(crate) ws_text_tx: Option<mpsc::Sender<WsMessage>>,
    pub(crate) ws_binary_tx: Option<mpsc::Sender<WsMessage>>,
    pub(crate) connection_generation: u64,
    pub(crate) active_uploads: ActiveUploads,
    pub(crate) active_downloads: ActiveDownloads,
    pub(crate) active_terminals: ActiveTerminals,
}

impl AgentState {
    pub(crate) fn new(agent_id: AgentId, agent_name: String, server_url: String) -> Self {
        Self {
            agent_id,
            agent_name,
            server_url,
            ws_text_tx: None,
            ws_binary_tx: None,
            connection_generation: 0,
            active_uploads: ActiveUploads::new(),
            active_downloads: ActiveDownloads::new(),
            active_terminals: ActiveTerminals::new(),
        }
    }

    /// Advances the socket identity so delayed events cannot affect a replacement connection.
    pub(crate) fn advance_connection_generation(&mut self) -> u64 {
        self.connection_generation = self.connection_generation.wrapping_add(1);
        self.connection_generation
    }
}
