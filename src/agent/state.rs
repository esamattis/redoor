use super::AgentActor;
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

pub(crate) type ActiveUploads = Arc<Mutex<HashMap<RequestId, UploadSessionHandle>>>;

#[derive(Clone)]
pub(crate) struct DownloadSessionHandle {
    pub(crate) cancel_sender: watch::Sender<bool>,
}

pub(crate) type ActiveDownloads = Arc<Mutex<HashMap<RequestId, DownloadSessionHandle>>>;

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
            active_uploads: Arc::new(Mutex::new(HashMap::new())),
            active_downloads: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AgentActor {
    pub(crate) async fn remove_active_upload(
        active_uploads: &ActiveUploads,
        request_id: RequestId,
    ) {
        active_uploads
            .lock()
            .expect("active uploads mutex poisoned")
            .remove(&request_id);
    }

    pub(crate) async fn clear_active_uploads(active_uploads: &ActiveUploads) {
        let mut active_uploads = active_uploads
            .lock()
            .expect("active uploads mutex poisoned");
        // Fan out cancellation before clearing the registry so workers exit and
        // clean up temp files/directories instead of waiting for dropped senders.
        for upload in active_uploads.values() {
            let _ = upload.cancel_sender.send(true);
        }
        active_uploads.clear();
    }

    pub(crate) async fn remove_active_download(
        active_downloads: &ActiveDownloads,
        request_id: RequestId,
    ) {
        active_downloads
            .lock()
            .expect("active downloads mutex poisoned")
            .remove(&request_id);
    }

    pub(crate) async fn clear_active_downloads(active_downloads: &ActiveDownloads) {
        let mut active_downloads = active_downloads
            .lock()
            .expect("active downloads mutex poisoned");
        for download in active_downloads.values() {
            let _ = download.cancel_sender.send(true);
        }
        active_downloads.clear();
    }
}
