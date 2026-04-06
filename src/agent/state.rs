use clap::Args;
use redoor::{
    streaming,
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

pub(crate) struct AgentState {
    pub(crate) agent_id: AgentId,
    pub(crate) agent_name: String,
    pub(crate) server_url: String,
    pub(crate) ws_text_tx: Option<mpsc::Sender<WsMessage>>,
    pub(crate) ws_binary_tx: Option<mpsc::Sender<WsMessage>>,
    pub(crate) active_uploads: ActiveUploads,
    pub(crate) active_downloads: ActiveDownloads,
}

impl AgentState {
    pub(crate) fn new(agent_id: AgentId, agent_name: String, server_url: String) -> Self {
        Self {
            agent_id,
            agent_name,
            server_url,
            ws_text_tx: None,
            ws_binary_tx: None,
            active_uploads: ActiveUploads::new(),
            active_downloads: ActiveDownloads::new(),
        }
    }
}
