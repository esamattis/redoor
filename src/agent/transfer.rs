use super::{ActiveUploads, AgentHandle, AgentMsg, AgentState, protocol::route_upload_chunk};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use redoor::{
    Level, log,
    transfer_protocol::{
        TRANSFER_OUTBOUND_QUEUE_CAPACITY, TRANSFER_RECONNECT_DELAY, TransferSocketHandshake,
    },
    types::AgentId,
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

/// Derives the payload endpoint while preserving the configured authority and WebSocket scheme.
pub(crate) fn transfer_url(server_url: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(server_url).context("invalid agent websocket URL")?;
    url.set_path("/api/v1/agent-transfer/ws");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Replaces transfer credentials and starts non-blocking setup for the current control generation.
pub(crate) fn begin_transfer_connection(
    state: &mut AgentState,
    handle: AgentHandle,
    token: String,
) {
    if let Some(shutdown) = state.transfer_shutdown.take() {
        let _ = shutdown.send(true);
    }
    state.ws_transfer_tx = None;
    state.transfer_token = Some(token.clone());
    let transfer_generation = state.advance_transfer_generation();
    spawn_transfer_connection(TransferConnectContext::from_state(
        state,
        handle,
        token,
        transfer_generation,
    ));
}

/// Captures immutable connection inputs so setup never blocks the agent actor.
pub(crate) struct TransferConnectContext {
    server_url: String,
    agent_id: AgentId,
    token: String,
    control_generation: u64,
    transfer_generation: u64,
    control_sender: mpsc::Sender<WsMessage>,
    active_uploads: ActiveUploads,
    handle: AgentHandle,
}

impl TransferConnectContext {
    /// Snapshots only thread-safe handles needed by the independently running transfer task.
    fn from_state(
        state: &AgentState,
        handle: AgentHandle,
        token: String,
        transfer_generation: u64,
    ) -> Self {
        Self {
            server_url: state.server_url.clone(),
            agent_id: state.agent_id.clone(),
            token,
            control_generation: state.connection_generation,
            transfer_generation,
            control_sender: state
                .ws_control_tx
                .as_ref()
                .expect("control sender exists while handling transfer-open")
                .clone(),
            active_uploads: state.active_uploads.clone(),
            handle,
        }
    }
}

/// Spawns transfer setup and read/write loops so control mailbox handling never waits on networking.
pub(crate) fn spawn_transfer_connection(context: TransferConnectContext) {
    tokio::spawn(async move {
        let reason = match run_transfer_connection(&context).await {
            Ok(()) => "Transfer connection ended".to_string(),
            Err(error) => error.to_string(),
        };
        let _ = context
            .handle
            .send(AgentMsg::TransferConnectionLost {
                control_generation: context.control_generation,
                transfer_generation: context.transfer_generation,
                reason,
            })
            .await;
    });
}

/// Authenticates one payload socket and runs bounded binary ingress and egress until either side ends.
async fn run_transfer_connection(context: &TransferConnectContext) -> Result<()> {
    let url = transfer_url(&context.server_url)?;
    let (mut socket, _) = connect_async(url.as_str())
        .await
        .context("failed to connect transfer socket")?;
    let handshake = serde_json::to_string(&TransferSocketHandshake::Authenticate {
        agent_id: context.agent_id.clone(),
        token: context.token.clone(),
    })
    .context("failed to encode transfer authentication")?;
    socket
        .send(WsMessage::text(handshake))
        .await
        .context("failed to send transfer authentication")?;

    let (mut writer, mut reader) = socket.split();
    let (sender, mut receiver) = mpsc::channel(TRANSFER_OUTBOUND_QUEUE_CAPACITY);
    let (shutdown, mut shutdown_receiver) = watch::channel(false);
    context
        .handle
        .send(AgentMsg::TransferConnected {
            control_generation: context.control_generation,
            transfer_generation: context.transfer_generation,
            token: context.token.clone(),
            sender,
            shutdown,
        })
        .await
        .context("agent actor stopped during transfer setup")?;

    log!(
        Level::Info,
        "Transfer socket connected: agent_id={}, generation={}",
        context.agent_id,
        context.transfer_generation
    );
    let read = read_transfer_frames(
        &mut reader,
        context.active_uploads.clone(),
        context.control_sender.clone(),
        context.agent_id.clone(),
        shutdown_receiver.clone(),
    );
    let write = write_transfer_frames(&mut writer, &mut receiver, &mut shutdown_receiver);
    tokio::select! {
        result = read => result,
        result = write => result,
    }
}

/// Routes binary ingress directly to upload workers so their backpressure cannot occupy control mailboxes.
async fn read_transfer_frames(
    reader: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    active_uploads: ActiveUploads,
    control_sender: mpsc::Sender<WsMessage>,
    agent_id: AgentId,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    loop {
        let frame = tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            frame = reader.next() => frame,
        };
        match frame {
            Some(Ok(WsMessage::Binary(bytes))) => {
                route_upload_chunk(
                    active_uploads.clone(),
                    control_sender.clone(),
                    agent_id.clone(),
                    bytes.to_vec(),
                )
                .await;
            }
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => {}
            Some(Ok(WsMessage::Close(_))) | None => return Ok(()),
            Some(Ok(WsMessage::Text(_))) => anyhow::bail!("text frame received on transfer socket"),
            Some(Err(error)) => return Err(error).context("failed to read transfer socket"),
            Some(Ok(_)) => {}
        }
    }
}

/// Writes only bounded binary payload frames and exits promptly when control invalidates the socket.
async fn write_transfer_frames(
    writer: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        WsMessage,
    >,
    receiver: &mut mpsc::Receiver<WsMessage>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<()> {
    loop {
        let message = tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            message = receiver.recv() => message,
        };
        let Some(message) = message else {
            return Ok(());
        };
        if !matches!(message, WsMessage::Binary(_)) {
            anyhow::bail!("non-binary frame queued for transfer socket");
        }
        writer
            .send(message)
            .await
            .context("failed to write transfer socket")?;
    }
}

/// Schedules a guarded reconnect without delaying control message handling.
pub(crate) fn schedule_transfer_reconnect(
    handle: AgentHandle,
    control_generation: u64,
    transfer_generation: u64,
    token: String,
) {
    tokio::spawn(async move {
        tokio::time::sleep(TRANSFER_RECONNECT_DELAY).await;
        let _ = handle
            .send(AgentMsg::ReconnectTransfer {
                control_generation,
                transfer_generation,
                token,
            })
            .await;
    });
}

#[cfg(test)]
mod tests {
    use super::transfer_url;

    /// Ensures transfer URL derivation cannot retain control-path query credentials or fragments.
    #[test]
    fn derives_transfer_url_for_websocket_schemes() {
        let ws = transfer_url("ws://localhost:3000/ws?old=1#fragment").expect("valid ws URL");
        // Preserving ws ensures local deployments use the expected cleartext WebSocket scheme.
        assert_eq!(ws.as_str(), "ws://localhost:3000/api/v1/agent-transfer/ws");
        let wss = transfer_url("wss://example.com/base?old=1#fragment").expect("valid wss URL");
        // Preserving wss ensures TLS deployments do not downgrade the payload connection.
        assert_eq!(wss.as_str(), "wss://example.com/api/v1/agent-transfer/ws");
    }
}
