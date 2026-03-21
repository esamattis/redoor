use futures_util::{SinkExt, StreamExt};
use ractor::{Actor, ActorProcessingErr, ActorRef};
use redoor::{
    Level,
    commands::{Command, CommandHandler, CommandResult},
    log, streaming,
    types::{ChunkIndex, Message, RequestId},
};
use std::path::{Path, PathBuf};
use std::{collections::HashMap, env};
use sysinfo::System;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::mpsc,
};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};

pub struct AgentActor;

struct UploadSession {
    path: String,
    temp_path: PathBuf,
    file: File,
    bytes_written: u64,
}

pub struct AgentState {
    agent_id: String,
    agent_name: String,
    server_url: String,
    ws_tx: Option<mpsc::Sender<WsMessage>>,
    active_uploads: HashMap<RequestId, UploadSession>,
}

#[derive(Clone)]
pub enum AgentMsg {
    Connect,
    ConnectionEstablished,
    ConnectionFailed { error: String },
    WebSocketMessage { text: String },
    WebSocketBinaryMessage { bytes: Vec<u8> },
    ConnectionLost { reason: String },
    Reconnect,
    SendWebSocketMessage { msg: WsMessage },
    SendWebSocketBinary { bytes: Vec<u8> },
    Shutdown,
    ExitWithError,
}

impl AgentActor {
    async fn cleanup_upload_session(session: UploadSession) {
        let temp_path = session.temp_path;
        drop(session.file);
        if let Err(error) = tokio::fs::remove_file(&temp_path).await {
            log!(
                Level::Warning,
                "Failed to remove upload temp file: path={}, error={}",
                temp_path.display(),
                error
            );
        }
    }

    fn temp_upload_path(path: &str) -> PathBuf {
        let destination = Path::new(path);
        let file_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload");
        let temp_name = format!(".{}.redoor-upload-{}", file_name, fastrand::u64(..));

        match destination.parent() {
            Some(parent) => parent.join(temp_name),
            None => PathBuf::from(format!("./{}", temp_name)),
        }
    }

    async fn handle_incoming_message(
        &self,
        text: String,
        state: &mut AgentState,
        write: &mpsc::Sender<WsMessage>,
        agent_ref: ActorRef<AgentMsg>,
    ) {
        if let Ok(redoor_msg) = serde_json::from_str::<Message>(&text) {
            match redoor_msg {
                Message::Command {
                    request_id,
                    command,
                    ..
                } => {
                    log!(
                        Level::Info,
                        "Command received: agent_id={}, request_id={}, command={:?}",
                        state.agent_id,
                        request_id,
                        command
                    );

                    match command {
                        Command::RawDownload {
                            path,
                            range_start,
                            range_end,
                        } => {
                            self.raw_download(path, range_start, range_end, request_id, write)
                                .await;
                        }
                        Command::RawUpload { path } => {
                            if state.active_uploads.contains_key(&request_id) {
                                self.send_command_response(
                                    write,
                                    &state.agent_id,
                                    request_id,
                                    CommandResult::Error {
                                        message: format!(
                                            "Upload session already exists for request_id={}",
                                            request_id
                                        ),
                                    },
                                )
                                .await;
                            } else {
                                let temp_path = Self::temp_upload_path(&path);
                                match File::create(&temp_path).await {
                                    Ok(file) => {
                                        log!(
                                            Level::Info,
                                            "Started raw upload: request_id={}, path={}, temp_path={}",
                                            request_id,
                                            path,
                                            temp_path.display()
                                        );
                                        state.active_uploads.insert(
                                            request_id,
                                            UploadSession {
                                                path,
                                                temp_path,
                                                file,
                                                bytes_written: 0,
                                            },
                                        );
                                    }
                                    Err(error) => {
                                        self.send_command_response(
                                            write,
                                            &state.agent_id,
                                            request_id,
                                            CommandResult::Error {
                                                message: format!(
                                                    "Failed to create file: {}",
                                                    error
                                                ),
                                            },
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                        Command::RawDelete { path } => {
                            let result = CommandHandler::new()
                                .execute(Command::RawDelete { path })
                                .await;
                            self.send_command_response(write, &state.agent_id, request_id, result)
                                .await;
                        }
                        other => {
                            let result = CommandHandler::new().execute(other).await;
                            let result_clone = result.clone();
                            let response = Message::CommandResponse {
                                agent_id: state.agent_id.clone(),
                                request_id,
                                result,
                            };

                            if let Ok(json) = serde_json::to_string(&response) {
                                let _ = write.send(WsMessage::text(json)).await;
                            }
                            log!(
                                Level::Info,
                                "Command response sent: agent_id={}, request_id={}, result={:?}",
                                state.agent_id,
                                request_id,
                                result_clone
                            );
                        }
                    }
                }
                Message::Error { message } => {
                    log!(Level::Error, "Server error: {}", message);
                    let _ = agent_ref.cast(AgentMsg::ExitWithError);
                }
                _ => {}
            }
        }
    }

    async fn send_command_response(
        &self,
        write: &mpsc::Sender<WsMessage>,
        agent_id: &str,
        request_id: RequestId,
        result: CommandResult,
    ) {
        let response = Message::CommandResponse {
            agent_id: agent_id.to_string(),
            request_id,
            result,
        };

        if let Ok(json) = serde_json::to_string(&response) {
            let _ = write.send(WsMessage::text(json)).await;
        }
    }

    async fn raw_download(
        &self,
        path: String,
        range_start: Option<u64>,
        range_end: Option<u64>,
        request_id: RequestId,
        write: &mpsc::Sender<WsMessage>,
    ) {
        match File::open(&path).await {
            Ok(mut file) => {
                let mut chunk_index = ChunkIndex(0);
                let chunk_size = streaming::CHUNK_SIZE;
                let mut buffer = vec![0u8; chunk_size];
                let mut bytes_remaining: Option<u64> = None;
                let mut pending_chunk: Option<Vec<u8>> = None;

                if let Some(start) = range_start {
                    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
                        log!(Level::Error, "Failed to seek file: {}", e);
                        let error_msg = format!("Failed to seek file: {}", e);
                        let error_chunk = streaming::StreamChunk {
                            request_id,
                            chunk_index,
                            is_last: true,
                            is_error: true,
                            data: error_msg.into_bytes(),
                        };
                        let _ = write
                            .send(WsMessage::Binary(error_chunk.to_bytes().into()))
                            .await;
                        return;
                    }

                    if let Some(end) = range_end {
                        bytes_remaining = Some(end.saturating_sub(start));
                    }
                }

                loop {
                    let read_size = match bytes_remaining {
                        Some(remaining) => {
                            if remaining == 0 {
                                break;
                            }
                            std::cmp::min(chunk_size, remaining as usize)
                        }
                        None => chunk_size,
                    };

                    if read_size < buffer.len() {
                        buffer.resize(read_size, 0);
                    } else if read_size > buffer.len() {
                        buffer.resize(read_size, 0);
                    }

                    match file.read(&mut buffer).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Some(ref mut remaining) = bytes_remaining {
                                *remaining = remaining.saturating_sub(n as u64);
                            }

                            if let Some(data) = pending_chunk.replace(buffer[..n].to_vec()) {
                                let chunk = streaming::StreamChunk {
                                    request_id,
                                    chunk_index,
                                    is_last: false,
                                    is_error: false,
                                    data,
                                };

                                if write
                                    .send(WsMessage::Binary(chunk.to_bytes().into()))
                                    .await
                                    .is_err()
                                {
                                    log!(
                                        Level::Warning,
                                        "WebSocket channel full or closed, aborting download"
                                    );
                                    return;
                                }
                                chunk_index = chunk_index.next_index();
                            }
                        }
                        Err(e) => {
                            log!(Level::Error, "Failed to read file: {}", e);
                            let error_msg = format!("Failed to read file: {}", e);
                            let error_chunk = streaming::StreamChunk {
                                request_id,
                                chunk_index,
                                is_last: true,
                                is_error: true,
                                data: error_msg.into_bytes(),
                            };
                            let _ = write
                                .send(WsMessage::Binary(error_chunk.to_bytes().into()))
                                .await;
                            return;
                        }
                    }
                }

                let final_chunk = streaming::StreamChunk {
                    request_id,
                    chunk_index,
                    is_last: true,
                    is_error: false,
                    data: pending_chunk.unwrap_or_default(),
                };
                let _ = write
                    .send(WsMessage::Binary(final_chunk.to_bytes().into()))
                    .await;

                log!(
                    Level::Info,
                    "Raw download complete: path={}, chunks={}",
                    path,
                    chunk_index.display_number()
                );
            }
            Err(e) => {
                log!(Level::Error, "Failed to open file: {}", e);
                let error_msg = format!("Failed to open file: {}", e);
                let error_chunk = streaming::StreamChunk {
                    request_id,
                    chunk_index: ChunkIndex(0),
                    is_last: true,
                    is_error: true,
                    data: error_msg.into_bytes(),
                };
                let _ = write
                    .send(WsMessage::Binary(error_chunk.to_bytes().into()))
                    .await;
            }
        }
    }

    async fn handle_upload_chunk(
        &self,
        state: &mut AgentState,
        bytes: Vec<u8>,
    ) -> Result<(), ActorProcessingErr> {
        let chunk = match streaming::StreamChunk::from_bytes(&bytes) {
            Ok(chunk) => chunk,
            Err(error) => {
                log!(
                    Level::Warning,
                    "Failed to parse binary stream chunk: {}",
                    error
                );
                return Ok(());
            }
        };

        let request_id = chunk.request_id;
        let is_known_upload = state.active_uploads.contains_key(&request_id);

        if !is_known_upload {
            return Ok(());
        }

        let Some(tx) = state.ws_tx.as_ref().cloned() else {
            log!(
                Level::Warning,
                "Upload chunk received without active websocket sender: request_id={}",
                request_id
            );
            state.active_uploads.remove(&request_id);
            return Ok(());
        };

        if chunk.is_error {
            let error_message = if chunk.data.is_empty() {
                "Upload aborted by server".to_string()
            } else {
                String::from_utf8_lossy(&chunk.data).to_string()
            };

            let path = state
                .active_uploads
                .remove(&request_id)
                .map(|session| {
                    let path = session.path.clone();
                    tokio::spawn(Self::cleanup_upload_session(session));
                    path
                })
                .unwrap_or_else(|| "<unknown>".to_string());

            log!(
                Level::Warning,
                "Upload aborted: request_id={}, path={}, error={}",
                request_id,
                path,
                error_message
            );

            self.send_command_response(
                &tx,
                &state.agent_id,
                request_id,
                CommandResult::Error {
                    message: error_message,
                },
            )
            .await;

            return Ok(());
        }

        let mut session = match state.active_uploads.remove(&request_id) {
            Some(session) => session,
            None => return Ok(()),
        };

        if let Err(error) = session.file.write_all(&chunk.data).await {
            let error_message = format!("Failed to write upload chunk: {}", error);
            log!(
                Level::Error,
                "Upload write failed: request_id={}, path={}, error={}",
                request_id,
                session.path,
                error_message
            );

            self.send_command_response(
                &tx,
                &state.agent_id,
                request_id,
                CommandResult::Error {
                    message: error_message,
                },
            )
            .await;

            tokio::spawn(Self::cleanup_upload_session(session));

            return Ok(());
        }

        session.bytes_written += chunk.data.len() as u64;

        if chunk.is_last {
            if let Err(error) = session.file.flush().await {
                let error_message = format!("Failed to flush uploaded file: {}", error);
                log!(
                    Level::Error,
                    "Upload flush failed: request_id={}, path={}, error={}",
                    request_id,
                    session.path,
                    error_message
                );

                self.send_command_response(
                    &tx,
                    &state.agent_id,
                    request_id,
                    CommandResult::Error {
                        message: error_message,
                    },
                )
                .await;

                tokio::spawn(Self::cleanup_upload_session(session));

                return Ok(());
            }

            let final_path = session.path.clone();
            let temp_path = session.temp_path.clone();
            let bytes_written = session.bytes_written;
            drop(session.file);

            if let Err(error) = tokio::fs::rename(&temp_path, &final_path).await {
                let error_message = format!("Failed to finalize uploaded file: {}", error);
                log!(
                    Level::Error,
                    "Upload rename failed: request_id={}, path={}, temp_path={}, error={}",
                    request_id,
                    final_path,
                    temp_path.display(),
                    error_message
                );

                let _ = tokio::fs::remove_file(&temp_path).await;

                self.send_command_response(
                    &tx,
                    &state.agent_id,
                    request_id,
                    CommandResult::Error {
                        message: error_message,
                    },
                )
                .await;

                return Ok(());
            }

            log!(
                Level::Info,
                "Raw upload complete: request_id={}, path={}, bytes_written={}",
                request_id,
                final_path,
                bytes_written
            );

            self.send_command_response(&tx, &state.agent_id, request_id, CommandResult::RawUpload)
                .await;
        } else {
            state.active_uploads.insert(request_id, session);
        }

        Ok(())
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
            active_uploads: HashMap::new(),
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
                        let (tx, mut rx) = mpsc::channel::<WsMessage>(32);

                        state.ws_tx = Some(tx.clone());

                        Self::spawn_read_task(read, myself.clone()).await;

                        let mut write = write;
                        tokio::spawn(async move {
                            while let Some(msg) = rx.recv().await {
                                if write.send(msg).await.is_err() {
                                    log!(Level::Warning, "Failed to send WebSocket message");
                                    break;
                                }
                            }
                        });

                        let _ = myself.cast(AgentMsg::ConnectionEstablished);

                        let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
                        let os = std::env::consts::OS.to_string();
                        let arch = std::env::consts::ARCH.to_string();
                        let username =
                            std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());

                        let register_msg = Message::AgentRegister {
                            agent_id: state.agent_id.clone(),
                            agent_name: state.agent_name.clone(),
                            os,
                            arch,
                            hostname,
                            username,
                        };

                        if let Ok(json) = serde_json::to_string(&register_msg) {
                            log!(Level::Info, "Sending agent registration message: {}", json);
                            if let Err(e) = tx.send(WsMessage::text(json)).await {
                                log!(Level::Error, "Failed to send agent registration: {}", e);
                            }
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
                if let Some(tx) = state.ws_tx.as_ref().cloned() {
                    self.handle_incoming_message(text, state, &tx, myself.clone())
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
                let abandoned_uploads = std::mem::take(&mut state.active_uploads);
                for (_, session) in abandoned_uploads {
                    tokio::spawn(Self::cleanup_upload_session(session));
                }
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
                    if tx.send(msg).await.is_err() {
                        log!(
                            Level::Error,
                            "Failed to send message, connection may be lost"
                        );
                    }
                }
            }

            AgentMsg::SendWebSocketBinary { bytes } => {
                if let Some(tx) = &state.ws_tx {
                    if tx.send(WsMessage::Binary(bytes.into())).await.is_err() {
                        log!(
                            Level::Error,
                            "Failed to send binary message, connection may be lost"
                        );
                    }
                }
            }

            AgentMsg::WebSocketBinaryMessage { bytes } => {
                self.handle_upload_chunk(state, bytes).await?;
            }

            AgentMsg::Shutdown => {
                log!(
                    Level::Info,
                    "Shutting down agent: agent_id={}",
                    state.agent_id
                );
                state.ws_tx = None;
                let abandoned_uploads = std::mem::take(&mut state.active_uploads);
                for (_, session) in abandoned_uploads {
                    tokio::spawn(Self::cleanup_upload_session(session));
                }
                myself.stop(None);
            }

            AgentMsg::ExitWithError => {
                log!(Level::Error, "Exiting agent due to error");
                std::process::exit(1);
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

    let port = env::var("REDOOR_PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse::<u16>()
        .unwrap_or(3000);

    let server_url = if args.len() > 1 {
        args[1].clone()
    } else {
        format!("ws://127.0.0.1:{}/ws", port)
    };

    let agent_name = if args.len() > 2 {
        args[2].clone()
    } else {
        "default-agent".to_string()
    };

    let agent_id = agent_name.clone();

    println!("Starting agent '{}'", agent_name);

    let (_, agent_handle) =
        AgentActor::spawn(None, AgentActor, (agent_id, agent_name, server_url)).await?;

    agent_handle.await?;

    Ok(())
}
