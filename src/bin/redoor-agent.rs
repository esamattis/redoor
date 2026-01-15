use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef};
use redoor::{Level, commands::CommandHandler, log, types::Message};
use std::env;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

pub struct AgentActor;

#[derive(Clone)]
pub struct AgentState {
    agent_id: String,
    agent_name: String,
    server_url: String,
    ws_tx: Option<mpsc::UnboundedSender<WsMessage>>,
}

#[derive(Clone)]
pub enum AgentMsg {
    Connect,
    ConnectionEstablished,
    ConnectionFailed { error: String },
    WebSocketMessage { text: String },
    ConnectionLost { reason: String },
    Reconnect,
    SendWebSocketMessage { msg: WsMessage },
    Shutdown,
}

impl AgentActor {
    async fn handle_incoming_message(
        &self,
        text: String,
        agent_id: &str,
        write: &mpsc::UnboundedSender<WsMessage>,
    ) {
        if let Ok(redoor_msg) = serde_json::from_str::<Message>(&text) {
            match redoor_msg {
                Message::Command { command, .. } => {
                    log!(
                        Level::Info,
                        "Command received: agent_id={}, command={:?}",
                        agent_id,
                        command
                    );
                    let result = CommandHandler::new().execute(command).await;
                    let result_clone = result.clone();
                    let response = Message::CommandResponse {
                        agent_id: agent_id.to_string(),
                        result,
                    };

                    if let Ok(json) = serde_json::to_string(&response) {
                        let _ = write.send(WsMessage::text(json));
                    }
                    log!(
                        Level::Info,
                        "Command response sent: agent_id={}, result={:?}",
                        agent_id,
                        result_clone
                    );
                }
                _ => {}
            }
        }
    }

    async fn spawn_read_task(
        mut read: futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
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
                    Ok(WsMessage::Close(_)) => {
                        let _ = agent_ref.cast(AgentMsg::ConnectionLost {
                            reason: "Server closed connection".to_string(),
                        });
                        break;
                    }
                    Err(e) => {
                        let _ = agent_ref.cast(AgentMsg::ConnectionLost {
                            reason: format!("Error receiving message: {}", e),
                        });
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    async fn spawn_stdin_task(agent_ref: ActorRef<AgentMsg>) {
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

impl Actor for AgentActor {
    type Msg = AgentMsg;
    type State = AgentState;
    type Arguments = (String, String, String);

    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (agent_id, agent_name, server_url) = args;

        log!(
            Level::Info,
            "AgentActor started: agent_id={}, agent_name={}",
            agent_id,
            agent_name
        );

        Self::spawn_stdin_task(myself.clone()).await;

        let _ = myself.cast(AgentMsg::Connect);

        Ok(AgentState {
            agent_id,
            agent_name,
            server_url,
            ws_tx: None,
        })
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            AgentMsg::Connect => {
                log!(
                    Level::Info,
                    "Attempting to connect to {} as agent '{}'",
                    state.server_url,
                    state.agent_name
                );

                match connect_async(&state.server_url).await {
                    Ok((ws_stream, _response)) => {
                        log!(Level::Info, "Connected!");
                        log!(
                            Level::Info,
                            "Agent connected: agent_id={}, agent_name={}, server={}",
                            state.agent_id,
                            state.agent_name,
                            state.server_url
                        );

                        let (write, read) = ws_stream.split();
                        let (tx, mut rx) = mpsc::unbounded_channel();

                        state.ws_tx = Some(tx.clone());

                        Self::spawn_read_task(read, myself.clone()).await;

                        let mut write = write;
                        tokio::spawn(async move {
                            while let Some(msg) = rx.recv().await {
                                if SinkExt::send(&mut write, msg).await.is_err() {
                                    break;
                                }
                            }
                        });

                        let _ = myself.cast(AgentMsg::ConnectionEstablished);

                        let register_msg = Message::AgentRegister {
                            agent_id: state.agent_id.clone(),
                            agent_name: state.agent_name.clone(),
                        };

                        if let Ok(json) = serde_json::to_string(&register_msg) {
                            let _ = tx.send(WsMessage::text(json));
                        }
                    }
                    Err(e) => {
                        log!(Level::Error, "Connection failed: {}", e);
                        let _ = myself.cast(AgentMsg::ConnectionFailed {
                            error: e.to_string(),
                        });
                    }
                }
            }

            AgentMsg::ConnectionEstablished => {
                log!(Level::Info, "Connection established");
            }

            AgentMsg::ConnectionFailed { error } => {
                log!(
                    Level::Error,
                    "Connection failed: {}, scheduling reconnect in 5s",
                    error
                );
                let agent_ref_clone = myself.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = agent_ref_clone.cast(AgentMsg::Reconnect);
                });
            }

            AgentMsg::WebSocketMessage { text } => {
                if let Some(tx) = &state.ws_tx {
                    self.handle_incoming_message(text, &state.agent_id, tx)
                        .await;
                }
            }

            AgentMsg::ConnectionLost { reason } => {
                log!(
                    Level::Warning,
                    "Connection lost: {}, scheduling reconnect in 5s",
                    reason
                );
                state.ws_tx = None;
                let agent_ref_clone = myself.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    let _ = agent_ref_clone.cast(AgentMsg::Reconnect);
                });
            }

            AgentMsg::Reconnect => {
                log!(Level::Info, "Attempting to reconnect...");
                let _ = myself.cast(AgentMsg::Connect);
            }

            AgentMsg::SendWebSocketMessage { msg } => {
                if let Some(tx) = &state.ws_tx {
                    if tx.send(msg).is_err() {
                        log!(
                            Level::Error,
                            "Failed to send message, connection may be lost"
                        );
                    }
                }
            }

            AgentMsg::Shutdown => {
                log!(
                    Level::Info,
                    "Shutting down agent: agent_id={}",
                    state.agent_id
                );
                state.ws_tx = None;
                myself.stop(None);
            }
        }

        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        log!(Level::Info, "Agent stopped: agent_id={}", state.agent_id);
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();

    let server_url = if args.len() > 1 {
        args[1].clone()
    } else {
        "ws://127.0.0.1:3000/ws".to_string()
    };

    let agent_name = if args.len() > 2 {
        args[2].clone()
    } else {
        "default-agent".to_string()
    };

    let agent_id = format!("{}-{}", agent_name, uuid::Uuid::new_v4());

    println!("Starting agent '{}'", agent_name);

    let (_, agent_handle) =
        AgentActor::spawn(None, AgentActor, (agent_id, agent_name, server_url)).await?;

    agent_handle.await?;

    Ok(())
}
