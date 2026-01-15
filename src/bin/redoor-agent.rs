use futures_util::{SinkExt, StreamExt};
use std::env;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    let server_url = if args.len() > 1 {
        &args[1]
    } else {
        "ws://127.0.0.1:3000/ws"
    };

    println!("Connecting to {}", server_url);

    match connect_async(server_url).await {
        Ok((ws_stream, response)) => {
            println!("Connected! Response: {:?}", response);

            let (mut write, mut read) = ws_stream.split();

            let read_task = tokio::spawn(async move {
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            println!("Received: {}", text);
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
                        if write
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
        }
        Err(e) => {
            eprintln!("Failed to connect: {}", e);
        }
    }
}
