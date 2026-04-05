use super::AgentActor;
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

#[derive(Clone)]
pub(crate) struct UploadSessionHandle {
    pub(crate) path: String,
    pub(crate) chunk_sender: mpsc::Sender<streaming::StreamChunk>,
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
        active_uploads
            .lock()
            .expect("active uploads mutex poisoned")
            .clear();
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
