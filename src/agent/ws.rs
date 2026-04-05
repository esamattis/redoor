use super::{AgentActor, AgentMsg};
use futures_util::StreamExt;
use ractor::ActorRef;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, tungstenite::protocol::Message as WsMessage,
};

impl AgentActor {
    pub(crate) async fn spawn_read_task(
        mut read: futures_util::stream::SplitStream<
            WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
        >,
        agent_ref: ActorRef<AgentMsg>,
    ) {
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        let _ = agent_ref.cast(AgentMsg::WebSocketMessage {
                            text: text.to_string(),
                        });
                    }
                    Ok(WsMessage::Binary(bytes)) => {
                        let _ = agent_ref.cast(AgentMsg::WebSocketBinaryMessage {
                            bytes: bytes.to_vec(),
                        });
                    }
                    Ok(WsMessage::Close(_)) => {
                        let _ = agent_ref.cast(AgentMsg::ConnectionLost {
                            reason: "Server closed connection".to_string(),
                        });
                        break;
                    }
                    Err(error) => {
                        let _ = agent_ref.cast(AgentMsg::ConnectionLost {
                            reason: format!("Error receiving message: {}", error),
                        });
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    pub(crate) async fn spawn_stdin_task(agent_ref: ActorRef<AgentMsg>) {
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
                    let _ = agent_ref_clone.cast(AgentMsg::SendWebSocketMessage {
                        msg: WsMessage::text(trimmed.to_string()),
                    });
                }
                line.clear();
            }
        });
    }
}
