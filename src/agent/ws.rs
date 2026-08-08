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
    connection_generation: u64,
) {
    tokio::spawn(async move {
        let mut connection_loss_reported = false;
        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    if agent_ref
                        .send(AgentMsg::WebSocketMessage {
                            connection_generation,
                            text: text.to_string(),
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(WsMessage::Binary(_)) => {
                    connection_loss_reported = true;
                    let _ = agent_ref
                        .send(AgentMsg::ConnectionLost {
                            connection_generation,
                            reason: "Binary frame received on control socket".to_string(),
                        })
                        .await;
                    break;
                }
                Ok(WsMessage::Close(_)) => {
                    connection_loss_reported = true;
                    let _ = agent_ref
                        .send(AgentMsg::ConnectionLost {
                            connection_generation,
                            reason: "Server closed connection".to_string(),
                        })
                        .await;
                    break;
                }
                Err(error) => {
                    connection_loss_reported = true;
                    let _ = agent_ref
                        .send(AgentMsg::ConnectionLost {
                            connection_generation,
                            reason: format!("Error receiving message: {}", error),
                        })
                        .await;
                    break;
                }
                _ => {}
            }
        }
        if !connection_loss_reported {
            let _ = agent_ref
                .send(AgentMsg::ConnectionLost {
                    connection_generation,
                    reason: "Server connection ended".to_string(),
                })
                .await;
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
                let _ = agent_ref_clone
                    .send(AgentMsg::SendWebSocketMessage {
                        msg: WsMessage::text(trimmed.to_string()),
                    })
                    .await;
            }
            line.clear();
        }
    });
}
