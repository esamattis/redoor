use axum::{
    extract::{
        State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    Level, log,
    router::{RegisterTransferConnectionRequest, RouteStreamChunkRequest, RouterHandle, RouterMsg},
    streaming::StreamChunk,
    transfer_protocol::{
        MAX_TRANSFER_HANDSHAKE_TEXT_BYTES, MAX_TRANSFER_WEBSOCKET_MESSAGE_BYTES,
        TRANSFER_AUTHENTICATION_TIMEOUT, TRANSFER_OUTBOUND_QUEUE_CAPACITY, TransferSocketHandshake,
    },
    types::{AgentId, SocketId},
};
use tokio::sync::{mpsc, oneshot, watch};

use super::state::ServerState;

/// Upgrades the exact public agent payload route with transfer-sized frame limits.
pub(crate) async fn agent_transfer_websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.max_message_size(MAX_TRANSFER_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_TRANSFER_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| run_transfer_socket(socket, state.router_ref))
}

/// Authenticates and runs one persistent payload socket without exposing credential details.
async fn run_transfer_socket(mut socket: WebSocket, router: RouterHandle) {
    let socket_id = SocketId::new();
    let Some((agent_id, token)) = authenticate_transfer_socket(&mut socket, &socket_id).await
    else {
        return;
    };
    let (outgoing_binary, mut binary_receiver) =
        mpsc::channel::<WsMessage>(TRANSFER_OUTBOUND_QUEUE_CAPACITY);
    let (shutdown, shutdown_receiver) = watch::channel(false);
    let registration = router
        .request(5_000, |reply| {
            RouterMsg::RegisterTransferConnection(RegisterTransferConnectionRequest {
                agent_id: agent_id.clone(),
                token,
                socket_id: socket_id.clone(),
                outgoing_binary,
                shutdown,
                reply,
            })
        })
        .await;
    if !matches!(registration, Ok(Ok(()))) {
        log!(
            Level::Warning,
            "Transfer socket authentication rejected: socket_id={}",
            socket_id
        );
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }

    log!(
        Level::Info,
        "Transfer socket authentication accepted: agent_id={}, socket_id={}",
        agent_id,
        socket_id
    );
    let (mut writer, mut reader) = socket.split();
    let mut reader_shutdown = shutdown_receiver.clone();
    let mut writer_shutdown = shutdown_receiver;
    tokio::select! {
        _ = read_transfer_frames(&mut reader, &router, &agent_id, &socket_id, &mut reader_shutdown) => {}
        _ = write_transfer_frames(&mut writer, &mut binary_receiver, &mut writer_shutdown) => {}
    }

    let _ = router
        .send_async(RouterMsg::UnregisterTransferConnection {
            agent_id,
            socket_id,
        })
        .await;
}

/// Accepts exactly one small text authentication frame within the resource timeout.
async fn authenticate_transfer_socket(
    socket: &mut WebSocket,
    socket_id: &SocketId,
) -> Option<(AgentId, String)> {
    let frame = match tokio::time::timeout(TRANSFER_AUTHENTICATION_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(frame))) => frame,
        _ => {
            log!(
                Level::Warning,
                "Transfer socket authentication timed out or ended: socket_id={}",
                socket_id
            );
            return None;
        }
    };
    let WsMessage::Text(text) = frame else {
        log!(
            Level::Warning,
            "Transfer socket rejected non-text authentication: socket_id={}",
            socket_id
        );
        return None;
    };
    if text.len() > MAX_TRANSFER_HANDSHAKE_TEXT_BYTES {
        return None;
    }
    match serde_json::from_str::<TransferSocketHandshake>(&text) {
        Ok(TransferSocketHandshake::Authenticate { agent_id, token }) => Some((agent_id, token)),
        Err(_) => {
            log!(
                Level::Warning,
                "Transfer socket rejected malformed authentication: socket_id={}",
                socket_id
            );
            None
        }
    }
}

/// Routes binary frames one-at-a-time so downstream bounded queues backpressure only this socket.
async fn read_transfer_frames(
    reader: &mut futures_util::stream::SplitStream<WebSocket>,
    router: &RouterHandle,
    agent_id: &AgentId,
    socket_id: &SocketId,
    shutdown: &mut watch::Receiver<bool>,
) {
    loop {
        let frame = tokio::select! {
            _ = shutdown.changed() => break,
            frame = reader.next() => frame,
        };
        let Some(Ok(frame)) = frame else {
            break;
        };
        match frame {
            WsMessage::Binary(bytes) => {
                let Ok(chunk) = StreamChunk::from_bytes(&bytes) else {
                    break;
                };
                let (reply, received) = oneshot::channel();
                if router
                    .send_async(RouterMsg::RouteStreamChunk(RouteStreamChunkRequest {
                        agent_id: agent_id.clone(),
                        chunk,
                        reply,
                    }))
                    .await
                    .is_err()
                    || received.await.is_err()
                {
                    break;
                }
            }
            WsMessage::Ping(_) | WsMessage::Pong(_) => {}
            WsMessage::Close(_) => break,
            WsMessage::Text(_) => {
                log!(
                    Level::Warning,
                    "Text frame on transfer socket: agent_id={}, socket_id={}",
                    agent_id,
                    socket_id
                );
                break;
            }
        }
    }
}

/// Drains only binary payload frames and pings independently of the control writer.
async fn write_transfer_frames(
    writer: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    receiver: &mut mpsc::Receiver<WsMessage>,
    shutdown: &mut watch::Receiver<bool>,
) {
    let mut ping = tokio::time::interval(tokio::time::Duration::from_secs(10));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    loop {
        let message = tokio::select! {
            _ = shutdown.changed() => break,
            _ = ping.tick() => Some(WsMessage::Ping(bytes::Bytes::new())),
            message = receiver.recv() => message,
        };
        let Some(message) = message else {
            break;
        };
        if !matches!(message, WsMessage::Binary(_) | WsMessage::Ping(_))
            || writer.send(message).await.is_err()
        {
            break;
        }
    }
}
