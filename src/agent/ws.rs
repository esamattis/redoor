use super::{AgentHandle, AgentMsg};
use futures_util::StreamExt;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, tungstenite::protocol::Message as WsMessage,
};

/// Spawns the websocket read loop so inbound frames keep flowing into actor messages.
pub(super) async fn spawn_read_task(
    mut read: futures_util::stream::SplitStream<
        WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    agent_ref: AgentHandle,
) {
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    let _ = agent_ref.send(AgentMsg::WebSocketMessage {
                        text: text.to_string(),
                    });
                }
                Ok(WsMessage::Binary(bytes)) => {
                    let _ = agent_ref.send(AgentMsg::WebSocketBinaryMessage {
                        bytes: bytes.to_vec(),
                    });
                }
                Ok(WsMessage::Close(_)) => {
                    let _ = agent_ref.send(AgentMsg::ConnectionLost {
                        reason: "Server closed connection".to_string(),
                    });
                    break;
                }
                Err(error) => {
                    let _ = agent_ref.send(AgentMsg::ConnectionLost {
                        reason: format!("Error receiving message: {}", error),
                    });
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Spawns stdin forwarding so manual input can still inject websocket text frames.
pub(super) async fn spawn_stdin_task(agent_ref: AgentHandle) {
    let agent_ref_clone = agent_ref.clone();
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
                let _ = agent_ref_clone.send(AgentMsg::SendWebSocketMessage {
                    msg: WsMessage::text(trimmed.to_string()),
                });
            }
            line.clear();
        }
    });
}
