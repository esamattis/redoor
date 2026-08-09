mod download;
mod upload;

use redoor::{
    streaming::{self, StreamChunkFrameRequest},
    types::ChunkIndex,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

pub(crate) use download::RawDownloadContext;

/// Reframes one logical stream chunk into websocket-sized binary frames while preserving chunk order.
pub(super) async fn send_framed_stream_bytes(
    write: &mpsc::Sender<WsMessage>,
    chunk_index: &mut ChunkIndex,
    request: StreamChunkFrameRequest<'_>,
) -> bool {
    let mut frames = streaming::StreamChunkFrames::new(request.starting_chunk_index(*chunk_index));

    while let Some(chunk) = frames.next() {
        let next_chunk_index = frames.next_chunk_index();
        if write
            .send(WsMessage::Binary(chunk.to_bytes().into()))
            .await
            .is_err()
        {
            *chunk_index = next_chunk_index;
            return false;
        }

        tokio::task::yield_now().await;
    }

    *chunk_index = frames.next_chunk_index();
    true
}
