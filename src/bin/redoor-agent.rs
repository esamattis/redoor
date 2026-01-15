use futures_util::{SinkExt, StreamExt};
use redoor::{Level, log};
use std::env;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    let server_url = if args.len() > 1 {
        &args[1]
    } else {
        "ws://127.0.0.1:3000/ws"
    };

    let agent_name = if args.len() > 2 {
        &args[2]
    } else {
        "default-agent"
    };

    let agent_id = format!("{}-{}", agent_name, uuid::Uuid::new_v4());

    println!("Connecting to {} as agent '{}'", server_url, agent_name);

    match connect_async(server_url).await {
        Ok((ws_stream, _response)) => {
            println!("Connected!");
            log!(
                Level::Info,
                "Agent connected: agent_id={}, agent_name={}, server={}",
                agent_id,
                agent_name,
                server_url
            );

            let (write, mut read) = ws_stream.split();
            let write = Arc::new(Mutex::new(write));

            let register_msg = redoor::Message::AgentRegister {
                agent_id: agent_id.clone(),
                agent_name: agent_name.to_string(),
            };

            if let Ok(json) = serde_json::to_string(&register_msg) {
                let mut write_guard = write.lock().await;
                if write_guard.send(Message::text(json)).await.is_err() {
                    eprintln!("Failed to send register message");
                    return;
                }
            }

            let agent_id_clone = agent_id.clone();
            let write_clone = write.clone();

            let read_task = tokio::spawn(async move {
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            if let Ok(redoor_msg) = serde_json::from_str::<redoor::Message>(&text) {
                                match redoor_msg {
                                    redoor::Message::Command { command, args, .. } => {
                                        log!(
                                            Level::Info,
                                            "Command received: agent_id={}, command={}, args={:?}",
                                            agent_id_clone,
                                            command,
                                            args
                                        );
                                        let result = redoor::CommandHandler::new()
                                            .execute(&command, &args)
                                            .await;

                                        let result_clone = result.clone();
                                        let response = redoor::Message::CommandResponse {
                                            agent_id: agent_id_clone.clone(),
                                            result,
                                        };

                                        if let Ok(json) = serde_json::to_string(&response) {
                                            let mut write_guard = write_clone.lock().await;
                                            if write_guard.send(Message::text(json)).await.is_err()
                                            {
                                                break;
                                            }
                                        }
                                        log!(
                                            Level::Info,
                                            "Command response sent: agent_id={}, result={}",
                                            agent_id_clone,
                                            result_clone
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Ok(Message::Close(_)) => {
                            println!("Server closed connection");
                            break;
                        }
                        Err(e) => {
                            eprintln!("Error receiving message: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            let stdin_task = tokio::spawn(async move {
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
                        let mut write_guard = write.lock().await;
                        if write_guard
                            .send(Message::text(trimmed.to_string()))
                            .await
                            .is_err()
                        {
                            eprintln!("Failed to send message");
                            break;
                        }
                    }
                    line.clear();
                }
            });

            tokio::select! {
                _ = read_task => {},
                _ = stdin_task => {},
            }

            println!("Disconnected");
            log!(Level::Info, "Agent disconnected: agent_id={}", agent_id);
        }
        Err(e) => {
            eprintln!("Failed to connect: {}", e);
        }
    }
}
