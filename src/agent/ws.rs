use super::AgentMsg;
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, tungstenite::protocol::Message as WsMessage,
};

/// Spawns the websocket read loop so inbound frames keep flowing into the agent runtime channels.
pub(super) async fn spawn_read_task(
    mut read: futures_util::stream::SplitStream<
        WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    control_tx: mpsc::Sender<AgentMsg>,
    binary_tx: mpsc::Sender<Vec<u8>>,
) {
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    let _ = control_tx
                        .send(AgentMsg::WebSocketMessage {
                            text: text.to_string(),
                        })
                        .await;
                }
                Ok(WsMessage::Binary(bytes)) => {
                    if binary_tx.send(bytes.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(WsMessage::Close(_)) => {
                    let _ = control_tx
                        .send(AgentMsg::ConnectionLost {
                            reason: "Server closed connection".to_string(),
                        })
                        .await;
                    break;
                }
                Err(error) => {
                    let _ = control_tx
                        .send(AgentMsg::ConnectionLost {
                            reason: format!("Error receiving message: {}", error),
                        })
                        .await;
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Spawns stdin forwarding so manual input can still inject websocket text frames.
pub(super) async fn spawn_stdin_task(control_tx: mpsc::Sender<AgentMsg>) {
    tokio::spawn(async move {
        let mut line = String::new();
        while tokio::io::AsyncBufReadExt::read_line(
            &mut tokio::io::BufReader::new(tokio::io::stdin()),
            &mut line,
        )
        .await
        .unwrap()
            > 0
        {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let _ = control_tx
                    .send(AgentMsg::SendWebSocketMessage {
                        msg: WsMessage::text(trimmed.to_string()),
                    })
                    .await;
            }
            line.clear();
        }
    });
}
