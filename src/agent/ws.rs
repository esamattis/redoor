use super::{AgentHandle, AgentMsg};
use futures_util::StreamExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
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

/// Spawns stdin forwarding and optionally treats EOF as loss of the owning SSH relay.
pub(super) async fn spawn_stdin_task(agent_ref: AgentHandle, exit_on_eof: bool) {
    tokio::spawn(forward_stdin(
        BufReader::new(tokio::io::stdin()),
        agent_ref,
        exit_on_eof,
    ));
}

/// Forwards complete input lines while keeping relay-only EOF shutdown independently testable.
async fn forward_stdin<R>(mut input: R, agent_ref: AgentHandle, exit_on_eof: bool)
where
    R: AsyncBufRead + Unpin,
{
    let mut line = String::new();
    loop {
        match input.read_line(&mut line).await {
            Ok(0) => {
                if exit_on_eof {
                    let _ = agent_ref.send(AgentMsg::Shutdown).await;
                }
                break;
            }
            Ok(_) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let _ = agent_ref
                        .send(AgentMsg::SendWebSocketMessage {
                            msg: WsMessage::text(trimmed.to_string()),
                        })
                        .await;
                }
                line.clear();
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;

    use super::*;

    /// Verifies only SSH-owned agents stop when their input channel disappears.
    #[tokio::test]
    async fn relay_stdin_eof_requests_clean_shutdown() {
        let (sender, mut receiver) = mpsc::channel(1);
        let handle = AgentHandle { sender };

        forward_stdin(BufReader::new(&b""[..]), handle, true).await;

        // EOF from a disconnected SSH channel must release the remote agent PID lock.
        assert!(matches!(receiver.recv().await, Some(AgentMsg::Shutdown)));
    }

    /// Verifies ordinary agents retain the existing behavior when terminal stdin closes.
    #[tokio::test]
    async fn regular_stdin_eof_does_not_stop_agent() {
        let (sender, mut receiver) = mpsc::channel(1);
        let handle = AgentHandle { sender };

        forward_stdin(BufReader::new(&b""[..]), handle, false).await;

        // A service or detached regular agent commonly has closed stdin and must keep running.
        assert!(receiver.try_recv().is_err());
    }
}
